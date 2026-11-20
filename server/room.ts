import type { Server } from 'socket.io';
import {
  DEFAULT_DURATION_MIN,
  DURATION_OPTIONS_MIN,
  MAX_PLAYER_NAME_LENGTH,
  type ClientState,
  type ClientToServerEvents,
  type Phase,
  type ServerToClientEvents,
  type Settings,
  type Side,
} from '../shared/types.js';
import { CONFIG } from './config.js';
import { Engine, type Result } from './engine.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
const err = (error: string): { ok: false; error: string } => ({ ok: false, error });
const SCALE = Number(process.env.TIMING_SCALE ?? 1);

interface Player {
  id: string;
  token: string;
  name: string;
  socketId: string | null;
  side: Side | null;
}

export class Room {
  readonly code: string;
  readonly hostToken: string;
  hostSocketId: string | null = null;
  players = new Map<string, Player>();
  phase: Phase = 'lobby';
  settings: Settings = { durationMin: DEFAULT_DURATION_MIN, fallbackRefresh: CONFIG.fallbackDefaultOn && CONFIG.fallbackUpdateMs > 0 };

  private engine: Engine | null = null;
  private countdownEndsAt: number | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  onDestroy: (() => void) | null = null;

  constructor(
    private io: IO,
    code: string,
    hostToken: string,
  ) {
    this.code = code;
    this.hostToken = hostToken;
  }

  get roomName() {
    return `room:${this.code}`;
  }

  // ------------------------------------------------------------------ lifecycle

  attachHost(socketId: string) {
    this.hostSocketId = socketId;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.broadcast();
  }

  detachHost(socketId: string) {
    if (this.hostSocketId !== socketId) return;
    this.hostSocketId = null;
    this.idleTimer = setTimeout(() => this.destroy('The host left and the room timed out.'), CONFIG.roomIdleMs);
    this.broadcast();
  }

  destroy(reason: string) {
    this.clearTimers();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.io.to(this.roomName).emit('closed', reason);
    this.onDestroy?.();
  }

  private clearTimers() {
    for (const t of [this.wakeTimer, this.tickTimer, this.countdownTimer]) if (t) clearTimeout(t);
    this.wakeTimer = this.tickTimer = this.countdownTimer = null;
  }

  // ------------------------------------------------------------------ players

  join(name: string, token: string | undefined, socketId: string): { ok: true; player: Player } | { ok: false; error: string } {
    if (token) {
      const existing = [...this.players.values()].find((p) => p.token === token);
      if (existing) {
        existing.socketId = socketId;
        this.engine?.setConnected(existing.id, true, Date.now());
        this.afterChange();
        return { ok: true, player: existing };
      }
    }
    if (this.phase !== 'lobby') return { ok: false, error: 'That game has already started.' };
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_PLAYER_NAME_LENGTH);
    if (!clean) return { ok: false, error: 'Please enter a name.' };
    if ([...this.players.values()].some((p) => p.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: 'That name is already taken.' };
    const player: Player = {
      id: Math.random().toString(36).slice(2, 10),
      token: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      name: clean,
      socketId,
      side: null,
    };
    this.players.set(player.id, player);
    this.broadcast();
    return { ok: true, player };
  }

  disconnectPlayer(socketId: string) {
    const p = [...this.players.values()].find((x) => x.socketId === socketId);
    if (!p) return;
    p.socketId = null;
    this.engine?.setConnected(p.id, false, Date.now());
    this.afterChange();
  }

  kick(playerId: string) {
    if (this.phase !== 'lobby') return;
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.socketId) this.io.to(p.socketId).emit('closed', 'You were removed from the game by the host.');
    this.players.delete(playerId);
    this.broadcast();
  }

  /** Players can swap sides any time in the lobby, but not once the countdown has begun. */
  setSide(playerId: string, side: Side): Result {
    if (this.phase !== 'lobby') return err("Teams are locked once the game starts.");
    const p = this.players.get(playerId);
    if (!p) return err('You are not in this game.');
    if (side !== 'left' && side !== 'right') return err('Pick left or right.');
    p.side = side;
    this.broadcast();
    return { ok: true };
  }

  updateSettings(patch: Partial<Settings>) {
    if (this.phase !== 'lobby') return;
    if (typeof patch.durationMin === 'number' && DURATION_OPTIONS_MIN.includes(patch.durationMin)) this.settings.durationMin = patch.durationMin;
    if (typeof patch.fallbackRefresh === 'boolean') this.settings.fallbackRefresh = patch.fallbackRefresh;
    this.broadcast();
  }

  // ------------------------------------------------------------------ flow

  start(): Result {
    if (this.phase !== 'lobby') return err('Already started.');
    const live = [...this.players.values()].filter((p) => p.socketId);
    // anyone who never picked is dropped onto the smaller team
    for (const p of live) {
      if (p.side) continue;
      const count = (s: Side) => live.filter((q) => q.side === s).length;
      p.side = count('left') <= count('right') ? 'left' : 'right';
    }
    if (!live.some((p) => p.side === 'left') || !live.some((p) => p.side === 'right')) return err('Both teams need at least one player.');
    for (const p of [...this.players.values()]) if (!p.socketId) this.players.delete(p.id);
    this.phase = 'countdown';
    this.countdownEndsAt = Date.now() + CONFIG.countdownMs;
    this.countdownTimer = setTimeout(() => this.beginPlay(), CONFIG.countdownMs);
    this.broadcast();
    return { ok: true };
  }

  private beginPlay() {
    this.countdownTimer = null;
    const now = Date.now();
    this.engine = new Engine(
      [...this.players.values()].map((p) => ({ id: p.id, name: p.name, side: p.side!, connected: !!p.socketId })),
      now,
      { durationMs: this.settings.durationMin * 60000 * SCALE },
    );
    this.phase = 'play';
    this.countdownEndsAt = null;
    this.broadcast();
  }

  backToLobby() {
    this.clearTimers();
    this.engine = null;
    this.countdownEndsAt = null;
    this.phase = 'lobby';
    this.broadcast();
  }

  // ------------------------------------------------------------------ play

  clicks(playerId: string, n: unknown) {
    if (this.phase !== 'play' || !this.engine) return;
    this.engine.clicks(playerId, Number(n), Date.now());
    // No broadcast on purpose: the totals reach the screens when something computes them.
  }

  buy(playerId: string, itemId: unknown): Result {
    if (this.phase !== 'play' || !this.engine) return err('The game is not running.');
    const res = this.engine.buy(playerId, String(itemId), Date.now());
    this.afterChange();
    return res;
  }

  closeShop(playerId: string): Result {
    if (this.phase !== 'play' || !this.engine) return err('The game is not running.');
    const res = this.engine.closeShop(playerId, Date.now());
    this.afterChange();
    return res;
  }

  /** Something may have moved: re-arm the wake-up timer and tell everybody. */
  private afterChange() {
    this.broadcast();
  }

  /** Works out the numbers up to now, notices a finished game, and arms the next timers. */
  private sync() {
    if (this.phase !== 'play' || !this.engine) return;
    this.engine.update(Date.now());
    if (this.engine.finished) {
      this.phase = 'gameOver';
      this.clearTimers();
      return;
    }
    this.armWake();
    this.armTick();
  }

  private armWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const w = this.engine?.nextWake();
    if (w == null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.broadcast(); // a shop opening (or the end) is a reason to refresh the screens
    }, Math.max(0, w - Date.now()) + 5);
  }

  /** The scoreboard beat: every few seconds early on, then only the optional fallback. */
  private armTick() {
    if (this.tickTimer || !this.engine) return;
    const elapsed = Date.now() - this.engine.startedAt;
    const every = elapsed < CONFIG.earlyWindowMs ? CONFIG.earlyUpdateMs : this.settings.fallbackRefresh ? CONFIG.fallbackUpdateMs : 0;
    if (every <= 0) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.broadcast();
    }, every);
  }

  // ------------------------------------------------------------------ state out

  /**
   * Every broadcast works the numbers out first, so whatever reaches the screens is fresh.
   * That is also what keeps the main screen "in sync whenever it can".
   */
  broadcast() {
    this.sync();
    const now = Date.now();
    const state = (youId: string | null): ClientState => ({
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, side: p.side, connected: !!p.socketId })),
      settings: this.settings,
      serverNow: now,
      countdownEndsAt: this.countdownEndsAt,
      startedAt: this.engine?.startedAt ?? null,
      endsAt: this.engine?.endsAt ?? null,
      board: this.engine ? this.engine.board(now) : null,
      feed: this.engine?.feed ?? [],
      result: this.engine?.finished
        ? { winner: this.engine.winner!, left: Math.floor(this.engine.teams.left.clicks), right: Math.floor(this.engine.teams.right.clicks) }
        : null,
      clickFlushMs: CONFIG.clickFlushMs,
      you: youId && this.engine ? this.engine.you(youId, now) : youId ? { id: youId, side: this.players.get(youId)?.side ?? null, clickValue: 1, shop: null, perks: [], queuePos: null } : null,
    });
    if (this.hostSocketId) this.io.to(this.hostSocketId).emit('state', state(null));
    for (const p of this.players.values()) if (p.socketId) this.io.to(p.socketId).emit('state', state(p.id));
  }
}

import type { Server } from 'socket.io';
import {
  DEFAULT_DURATION_MIN,
  DEFAULT_TARGET,
  TARGET_OPTIONS,
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
  /** The running click total this phone last reported, so a lost or repeated report can't double-count. */
  reported: number;
}

export class Room {
  readonly code: string;
  readonly hostToken: string;
  hostSocketId: string | null = null;
  players = new Map<string, Player>();
  phase: Phase = 'lobby';
  settings: Settings = { mode: 'time', targetClicks: DEFAULT_TARGET, durationMin: DEFAULT_DURATION_MIN, fallbackRefresh: CONFIG.fallbackDefaultOn && CONFIG.fallbackUpdateMs > 0 };

  private engine: Engine | null = null;
  private countdownEndsAt: number | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastCollectAt = 0;
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
    this.refresh();
  }

  detachHost(socketId: string) {
    if (this.hostSocketId !== socketId) return;
    this.hostSocketId = null;
    this.idleTimer = setTimeout(() => this.destroy('The host left and the room timed out.'), CONFIG.roomIdleMs);
    this.refresh();
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
        if (this.engine) void this.op(() => this.engine?.setConnected(existing.id, true, Date.now()));
        else this.broadcast();
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
      reported: 0,
    };
    this.players.set(player.id, player);
    this.broadcast();
    return { ok: true, player };
  }

  disconnectPlayer(socketId: string) {
    const p = [...this.players.values()].find((x) => x.socketId === socketId);
    if (!p) return;
    p.socketId = null;
    if (this.engine) void this.op(() => this.engine?.setConnected(p.id, false, Date.now()));
    else this.broadcast();
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
    if (patch.mode === 'time' || patch.mode === 'target') this.settings.mode = patch.mode;
    if (typeof patch.targetClicks === 'number' && TARGET_OPTIONS.includes(patch.targetClicks)) this.settings.targetClicks = patch.targetClicks;
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
      this.settings.mode === 'target' ? { target: this.settings.targetClicks } : { durationMs: this.settings.durationMin * 60000 * SCALE },
    );
    for (const p of this.players.values()) p.reported = 0; // phones restart their counters with the game
    this.lastCollectAt = 0;
    this.phase = 'play';
    this.countdownEndsAt = null;
    this.broadcast();
  }

  backToLobby() {
    this.clearTimers();
    this.engine = null;
    this.chain = Promise.resolve();
    this.countdownEndsAt = null;
    this.phase = 'lobby';
    this.broadcast();
  }

  // ------------------------------------------------------------------ play

  /**
   * Everything that touches the numbers goes through here, one at a time: first the phones are asked for their
   * clicks (see collect), then `fn` runs against fresh totals, then everybody gets the new state.
   */
  private op<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.phase === 'play' && this.engine) await this.collect();
      const r = fn();
      this.broadcast();
      return r;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A refresh with nothing else to do: collect, work out the totals, tell everyone. */
  private refresh() {
    if (this.phase === 'play' && this.engine) void this.op(() => undefined);
    else this.broadcast();
  }

  /**
   * Asks every connected phone for its running click total, once, and credits the difference since last time.
   * Nothing is sent by the phones unless asked, so click traffic only happens when the totals are needed.
   */
  private async collect() {
    if (!this.engine || Date.now() - this.lastCollectAt < CONFIG.collectMinGapMs) return;
    this.lastCollectAt = Date.now();
    await Promise.all(
      [...this.players.values()].map(async (p) => {
        const sock = p.socketId ? this.io.sockets.sockets.get(p.socketId) : undefined;
        if (!sock) return;
        try {
          const total: unknown = await (sock as any).timeout(CONFIG.collectTimeoutMs).emitWithAck('collect');
          if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return;
          // A phone that reloaded restarts from zero: count its new total as new clicks.
          const diff = total >= p.reported ? total - p.reported : total;
          p.reported = total;
          if (diff > 0) this.engine?.clicks(p.id, diff, Date.now());
        } catch {
          /* no answer in time: its clicks are picked up by the next collection (the total is cumulative) */
        }
      }),
    );
  }

  buy(playerId: string, itemId: unknown): Promise<Result> {
    if (this.phase !== 'play' || !this.engine) return Promise.resolve(err('The game is not running.'));
    return this.op(() => this.engine!.buy(playerId, String(itemId), Date.now()));
  }

  closeShop(playerId: string): Promise<Result> {
    if (this.phase !== 'play' || !this.engine) return Promise.resolve(err('The game is not running.'));
    return this.op(() => this.engine!.closeShop(playerId, Date.now()));
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
      this.refresh(); // a shop opening (or the end) is a reason to collect and refresh the screens
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
      this.refresh();
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
      target: this.engine?.target ?? null,
      board: this.engine ? this.engine.board(now) : null,
      feed: this.engine?.feed ?? [],
      result: this.engine?.finished
        ? { winner: this.engine.winner!, left: Math.floor(this.engine.teams.left.clicks), right: Math.floor(this.engine.teams.right.clicks) }
        : null,
      you: youId && this.engine ? this.engine.you(youId, now) : youId ? { id: youId, side: this.players.get(youId)?.side ?? null, clickValue: 1, shop: null, perks: [], queuePos: null } : null,
    });
    if (this.hostSocketId) this.io.to(this.hostSocketId).emit('state', state(null));
    for (const p of this.players.values()) if (p.socketId) this.io.to(p.socketId).emit('state', state(p.id));
  }
}

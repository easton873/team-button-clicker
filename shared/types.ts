// Types and constants shared by the server and both clients (host screen + phones).

export type Side = 'left' | 'right';
export const SIDES: Side[] = ['left', 'right'];
export const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

export type Phase = 'lobby' | 'countdown' | 'play' | 'gameOver';
export type Rarity = 'common' | 'uncommon' | 'rare';

export const MAX_PLAYER_NAME_LENGTH = 14;
export const DURATION_OPTIONS_MIN = [3, 5, 10, 15, 20];
export const DEFAULT_DURATION_MIN = 10;

export interface PlayerInfo {
  id: string;
  name: string;
  side: Side | null;
  connected: boolean;
}

export interface EffectBadge {
  label: string;
  /** Epoch ms (server clock) when it wears off. */
  until: number;
}

export interface TeamBoard {
  clicks: number;
  shield: number;
  /** Highest the shield has ever been: regen never goes above this. */
  shieldPeak: number;
  /** Effective rates right now, per second. */
  auto: number;
  regen: number;
  drain: number;
  /** What one click is worth right now (permanent bonuses and boosts included). */
  perClick: number;
  effects: EffectBadge[];
  /** Who is in the shop right now, and when their minimum 10 seconds are up. */
  holderId: string | null;
  holderEndsAt: number | null;
  nextOfferAt: number | null;
}

export interface Board {
  left: TeamBoard;
  right: TeamBoard;
  /** Server clock when these numbers were worked out. */
  at: number;
}

export interface FeedEntry {
  id: number;
  at: number;
  side: Side | null;
  text: string;
}

export interface ShopItemView {
  id: string;
  name: string;
  desc: string;
  tier: 1 | 2 | 3;
  rarity: Rarity;
  /** Sticker price. */
  cost: number;
  /** What it costs this team right now (discount applied, sales tax added). */
  price: number;
  /** The sales-tax part of `price`. */
  tax: number;
}

export interface ShopView {
  items: ShopItemView[];
  /** Clicks you had when the shop opened. This is all you can spend, whatever has been earned since. */
  budget: number;
  /** Closing before this moment makes your team wait until it passes before the shop moves on. */
  minUntil: number;
}

export interface YouInfo {
  id: string;
  side: Side | null;
  clickValue: number;
  shop: ShopView | null;
  /** Private team effects only your team can see (decoys, insurance, discounts, taxes, investments). */
  perks: string[];
  /** How many teammates are ahead of you for the shop (0 = you're next). null if you're not in the rotation. */
  queuePos: number | null;
}

export interface Settings {
  durationMin: number;
  fallbackRefresh: boolean;
}

export interface ClientState {
  code: string;
  phase: Phase;
  players: PlayerInfo[];
  settings: Settings;
  /** Server clock, so the clients can line their timers up. */
  serverNow: number;
  countdownEndsAt: number | null;
  startedAt: number | null;
  endsAt: number | null;
  board: Board | null;
  feed: FeedEntry[];
  result: { winner: Side | 'tie'; left: number; right: number } | null;
  /** How often phones should report their clicks. */
  clickFlushMs: number;
  you: YouInfo | null;
}

export type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  'host:create': (cb: Ack<{ code: string; hostToken: string }>) => void;
  'host:resume': (p: { code: string; hostToken: string }, cb: Ack) => void;
  'host:settings': (p: Partial<Settings>) => void;
  'host:start': () => void;
  'host:backToLobby': () => void;
  'host:kick': (p: { playerId: string }) => void;
  'player:join': (p: { code: string; name: string; token?: string }, cb: Ack<{ token: string; playerId: string }>) => void;
  'player:setSide': (p: { side: Side }, cb?: Ack) => void;
  /** A batch of button presses. */
  'player:clicks': (p: { n: number }) => void;
  'player:buy': (p: { itemId: string }, cb?: Ack) => void;
  'player:closeShop': (cb?: Ack) => void;
}

export interface ServerToClientEvents {
  state: (s: ClientState) => void;
  closed: (reason: string) => void;
}

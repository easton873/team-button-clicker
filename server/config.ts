// Every tunable timing in one place. TIMING_SCALE shrinks all of the *waits* (not the per-second rates)
// so the test simulation can run quickly.
const SCALE = Number(process.env.TIMING_SCALE ?? 1);

export const CONFIG = {
  /** Lobby -> play. Nobody can change teams once it starts. */
  countdownMs: 5000 * SCALE,
  /** Minimum time a player holds the shop (see Engine.closeShop). */
  shopHoldMs: 10000 * SCALE,
  /** Nobody has any clicks at the very start, so the first shop waits a little. */
  firstShopDelayMs: 10000 * SCALE,

  /** The main screen refreshes on this beat for the first `earlyWindowMs` of a game... */
  earlyUpdateMs: 5000 * SCALE,
  earlyWindowMs: 30000 * SCALE,
  /**
   * ...and after that it only refreshes when something computes the numbers (a shop opening, a purchase,
   * an attack) -- plus this optional fallback beat so it never sits stale for long.
   * Set FALLBACK_UPDATE_MS=0 (or turn it off in the lobby) to rely purely on shop/purchase refreshes.
   */
  fallbackUpdateMs: Number(process.env.FALLBACK_UPDATE_MS ?? 5000) * SCALE,
  fallbackDefaultOn: process.env.FALLBACK_UPDATE !== 'off',

  /** How often phones report their button presses. Larger = fewer messages. */
  clickFlushMs: 1000,
  /** Anti-cheat: more presses per second than this in a batch are ignored. */
  maxClicksPerSecond: 25,

  roomIdleMs: 15 * 60 * 1000,
};

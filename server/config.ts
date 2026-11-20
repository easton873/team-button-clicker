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

  /**
   * Clicks are harvested from the phones once a second for the first `earlyWindowMs` of a game. After that they are
   * only harvested when the totals are needed anyway (a shop opening, a purchase, an attack, the end).
   */
  earlyUpdateMs: 1000 * SCALE,
  earlyWindowMs: 10000 * SCALE,
  /**
   * Between harvests the screens project the totals forward from the most recent clicking rate. The manual click
   * rate is multiplied by this so a slowdown doesn't make the number visibly drop at the next real update.
   */
  projectionFactor: 0.8,

  /**
   * Phones never send clicks on their own. The server *asks* every phone for its running click count only
   * when it is about to work out the totals (a shop opening, a purchase, a scoreboard beat), and each phone
   * answers once. This is how long it waits for a phone to answer before carrying on without it.
   */
  collectTimeoutMs: 1500,
  /** Back-to-back requests (a purchase right after a shop opens) reuse a collection this recent. */
  collectMinGapMs: 400 * SCALE,
  /** Anti-cheat: more presses per second than this in a batch are ignored. */
  maxClicksPerSecond: Number(process.env.MAX_CLICKS_PER_SECOND ?? 25),

  roomIdleMs: 15 * 60 * 1000,
};

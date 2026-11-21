# Team Button Clicker

A two-team, roguelike button-clicking war: one laptop/TV shows the main screen, everyone else plays on their phone. Built on the same lobby / room-code / QR-join setup as [the-name-game](https://github.com/easton873/the-name-game).

## How it plays

1. **Lobby** – the host opens `/host.html`; players join with the room code and pick the **left (red)** or **right (blue)** team. You can swap teams at any time in the lobby. Pick the game length and hit start.
2. **Countdown** – 5 seconds. Teams are locked.
3. **Play** – everyone gets one big button (red for left, blue for right). Clicks go into a **shared team pool**. The host picks the win condition in the lobby: **timed** (3-20 minutes, most clicks when the clock runs out) or **target** (first team to 1,000 / 10k / 100k / 1M / 10M clicks). Target mode adds **no traffic or timers of its own**: a win is noticed only when the totals are being worked out anyway (a shop opening, a purchase or attack), so a team can overshoot the target slightly before the game ends.
4. **The shop** – one random-ish shop is offered to **one player per team at a time**, round-robin:
   - When it opens, the team's clicks are **snapshotted**: that is your budget. Clicks earned afterwards can't be spent.
   - Opening it starts a **10 s** timer. Closing early (or buying something, which closes it) makes the next player wait for the timer; if it already expired the shop goes straight to the next player.
   - The shelf has 4 slots, always in this order: **auto clicker**, **economic**, **aggressive**, **defensive**. The auto clicker is picked at random from the three best (most clicks/s) auto clickers, of any tier, that the snapshot can afford; it ignores the odds upgrades below. The other slots draw from the tiers the snapshot unlocks (`<500` T1 · `<4,000` T1-2 · `<10,000` T1-2 · `<25,000` T1-3 · `<100,000` T2-3 · `<500,000` T2-3 · above that T3), weighted by rarity (common 100 / uncommon 45 / rare 15), preferring items you can afford.
   - **Economic** items: auto clickers (the economic slot can roll one too, on top of the dedicated auto clicker slot), click boosts, overdrive (auto clicker multiplier), rare Mega Multipliers (clicks and auto clickers together), +N per click, discount, invest, extra shop slot. **Aggressive**: remove, drain, delete auto clicker, siege, siphon, sabotage, rust, tax. **Defensive**: shield, regen, decoy, insurance.
   - **Extra Shop Slot** (economic, up to 4 times) permanently adds a wildcard slot (any category) after the defensive one.
   - **Odds Up** (one per category per tier): each slot starts out always rolling its own category. Buying Odds Up for a category lets the *other two* slots roll it too, and takes one step of other-category chance off its *own* slot (so it can return to always rolling its own). See `bumpOdds` in `server/catalog.ts`.
5. **Combat rules** – a team's clicks never go below 0. A **shield** soaks every attack before clicks are touched. Regen can't heal above the **highest the shield has ever been**, so regen with no shield does nothing.

## Items (`server/catalog.ts`)

Every tier has: **temporary click boosts** and **auto-clicker Overdrive** (common at every tier), a rare **Mega Multiplier** (both at once), and all multipliers **stack by multiplying** (2x then 3x = 6x), **auto clickers**, **permanent +N per click** (whole team), **delete an auto clicker**, **remove clicks**, **drain clicks/s**, **shield HP**, **shield regen**, plus the extras: **Bulk Discount** (next team purchase 10 / 20 / 50% off), **Invest** (pay now, 2x–3x back in 30 s), **Siphon** (each of *your* clicks steals 1 / 5 / 10 from the other team; stacks; shields block it), **Decoy** (secretly absorbs the next delete-auto-clicker of its tier or lower), **Insurance** (30 / 40 / 50% of clicks lost to attacks refunded for 60 s, secret), **Sabotage** (other team's next shop +5 / 10 / 20 s), **Rust** (other team's autos produce 25 / 35 / 50% less for 30 s), **Siege** (shield-only damage, cheap) and **Sales Tax** (other team's next purchase +20 / 35 / 50%, and you collect it).

Prices are the brief's, with a few fixes where a typo looked likely: tier 3 shield adds were tier 2 prices pasted in (now 25k/100k/500k HP for 20k/70k/300k) and a tier 3 regen 250/s was added to fill the gap.

## The "lazy" server (why the free tier survives)

Nothing ticks. Each player just owns a few **rates** (their auto clickers, shield regen, drain, siphon). `Engine.advance()` (`server/engine.ts`) integrates all of them since the last time it ran, splitting the span wherever a timed effect wears off, so the numbers are exact however rarely it runs. It runs when:

- a shop opens (that's the snapshot), a purchase or attack happens, the game ends, or
- during the first 10 seconds only, once a second (this seeds the click rate).

Each of those first collects clicks from the phones (see below), then works out the numbers, then broadcasts.

Every broadcast works the numbers out first, so whatever reaches the screens is fresh. **Phones never push clicks.** Presses are counted locally, and the server *asks* every phone for its running total (a socket ack, once) only when it is about to work out the totals; the phone answers with a cumulative count, so a lost answer is just picked up next time. After the first 10 seconds nothing is asked unless a shop opens or something is bought, so with nobody shopping there is no click traffic at all.

### How the screens stay lively without polling

Each harvest tells the server how many clicks the team made by hand since the previous harvest, which gives the *most recent* clicking rate (no history, no smoothing, no decay). The board sends that rate times a **0.8 margin** (so a slowdown doesn't make the number visibly drop) plus the exact auto-clicker, drain and regen rates. Between harvests the big screen and phones just add `rate x seconds` to the last real numbers, clamped at zero, the shield peak and the target. When the next real update arrives the numbers simply jump to the truth. This costs no traffic. One consequence: if a player sits in the shop and never closes it, nothing new is harvested for that team until the shop moves on, so the screen keeps projecting the old rate.

### Main-screen refresh (`server/config.ts`)

| setting | default | meaning |
| --- | --- | --- |
| `earlyUpdateMs` / `earlyWindowMs` | 1 s / 10 s | harvest beat for the first 10 s of a game |
| `projectionFactor` | 0.8 | margin applied to the manual click rate when projecting |
| `collectTimeoutMs` / `collectMinGapMs` | 1.5 s / 0.4 s | how long to wait for a phone's click total, and how recent a collection can be reused |
| `shopHoldMs` / `firstShopDelayMs` | 10 s / 10 s | shop minimum hold, and wait before the very first shop |

## Run it

```bash
npm install
npm run dev          # server :3000 + vite :5173 (open http://localhost:5173/host.html)
npm run build && npm start   # production, http://localhost:3000
npm test             # engine unit tests + a full bot game over real sockets
```

`render.yaml` deploys it as a single Render free web service.

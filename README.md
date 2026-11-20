# Gears & Ties

A two-team, roguelike button-clicking war: one laptop/TV shows the main screen, everyone else plays on their phone. Built on the same lobby / room-code / QR-join setup as [the-name-game](https://github.com/easton873/the-name-game). Theme: factory floor meets corner office (gears, ties, brass and pinstripes).

## How it plays

1. **Lobby** – the host opens `/host.html`; players join with the room code and pick the **left (red)** or **right (blue)** team. You can swap teams at any time in the lobby. Pick the shift length and hit start.
2. **Countdown** – 5 seconds. Teams are locked.
3. **Play** – everyone gets one big button (red for left, blue for right). Clicks go into a **shared team pool**. The host picks the win condition in the lobby: **timed** (3-20 minutes, most clicks when the clock runs out) or **target** (first team to 1,000 / 10k / 100k / 1M / 10M clicks). Target mode is checked lazily too: the server wakes itself near the moment auto clickers are projected to cross the line, and button presses are checked as they arrive.
4. **The shop** – one random-ish shop is offered to **one player per team at a time**, round-robin:
   - When it opens, the team's clicks are **snapshotted**: that is your budget. Clicks earned afterwards can't be spent.
   - Opening it starts a **10 s** timer. Closing early (or buying something, which closes it) makes the next player wait for the timer; if it already expired the shop goes straight to the next player.
   - What's on the shelf depends on the snapshot (3 slots, tiers 1–3): `<500` 1/1/1 · `<4,000` 1/1/2 · `<10,000` 1/2/2 · `<25,000` 1/2/3 · `<100,000` 2/2/3 · `<500,000` 2/3/3 · above that 3/3/3. Slots prefer items you can afford, weighted by rarity (common 100 / uncommon 45 / rare 15).
5. **Combat rules** – a team's clicks never go below 0. A **shield** soaks every attack before clicks are touched. Regen can't heal above the **highest the shield has ever been**, so regen with no shield does nothing.

## Items (`server/catalog.ts`)

Every tier has: **temporary click boosts** and **auto-clicker Overdrive**, **auto clickers**, **permanent +N per click** (whole team), **delete an auto clicker**, **remove clicks**, **drain clicks/s**, **shield HP**, **shield regen**, plus the extras: **Bulk Discount** (next team purchase 10 / 20 / 50% off), **Invest** (pay now, 2x–3x back in 30 s), **Siphon** (each of *your* clicks steals 1 / 5 / 10 from the other team; stacks; shields block it), **Decoy** (secretly absorbs the next delete-auto-clicker of its tier or lower), **Insurance** (30 / 40 / 50% of clicks lost to attacks refunded for 60 s, secret), **Sabotage** (other team's next shop +5 / 10 / 20 s), **Rust** (other team's autos produce 25 / 35 / 50% less for 30 s), **Siege** (shield-only damage, cheap) and **Sales Tax** (other team's next purchase +20 / 35 / 50%, and you collect it).

Prices are the brief's, with a few fixes where a typo looked likely: tier 3 shield adds were tier 2 prices pasted in (now 25k/100k/500k HP for 20k/70k/300k) and a tier 3 regen 250/s was added to fill the gap.

## The "lazy" server (why the free tier survives)

Nothing ticks. Each player just owns a few **rates** (their auto clickers, shield regen, drain, siphon). `Engine.advance()` (`server/engine.ts`) integrates all of them since the last time it ran, splitting the span wherever a timed effect wears off, so the numbers are exact however rarely it runs. It runs when:

- a shop opens (that's the snapshot), a purchase or attack happens, the game ends, or
- the main-screen refresh beat fires.

Every broadcast works the numbers out first, so whatever reaches the screens is fresh. Button presses are batched on the phone (`clickFlushMs`, 1 s) and added server-side **without a broadcast**.

### Main-screen refresh (`server/config.ts`)

| setting | default | meaning |
| --- | --- | --- |
| `earlyUpdateMs` / `earlyWindowMs` | 5 s / 30 s | scoreboard refresh beat for the first 30 s of a game |
| `fallbackUpdateMs` | 5 s | after that, a slow beat so the screen never goes stale. `FALLBACK_UPDATE_MS=0` env var turns it off; the host can also tick/untick it in the lobby |
| `clickFlushMs` | 1 s | how often phones report presses |
| `shopHoldMs` / `firstShopDelayMs` | 10 s / 10 s | shop minimum hold, and wait before the very first shop |

## Run it

```bash
npm install
npm run dev          # server :3000 + vite :5173 (open http://localhost:5173/host.html)
npm run build && npm start   # production, http://localhost:3000
npm test             # engine unit tests + a full bot game over real sockets
```

`render.yaml` deploys it as a single Render free web service.

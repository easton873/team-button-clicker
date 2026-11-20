// The game itself, with no sockets and no timers: every method takes `now` (epoch ms), so it can be
// driven by a real clock or stepped through in a test.
//
// The big idea is that nothing ticks. Each player just owns a few *rates* (auto clickers, shield regen,
// drain), and the team numbers are only worked out ("advanced") when somebody needs them: a shop opening,
// a purchase, an attack, a scoreboard refresh. advance() integrates every rate since the last time,
// splitting the span wherever a timed effect wears off, so the answer is the same however rarely it runs.
import { other, SIDES, type Board, type EffectBadge, type FeedEntry, type Side, type ShopItemView, type TeamBoard, type YouInfo } from '../shared/types.js';
import { CONFIG } from './config.js';
import { baseWeights, bumpOdds, ITEMS, rollShop, MAX_EXTRA_SLOTS, type ItemDef, type MixCategory, type SlotWeights } from './catalog.js';

export interface Timed {
  v: number;
  from: number;
  until: number;
}

interface EPlayer {
  id: string;
  name: string;
  side: Side;
  connected: boolean;
  /** Each auto clicker is tracked separately so "delete one" has something to delete. */
  autos: { tier: number; rate: number }[];
  regen: number;
  drain: number;
  siphon: number;
  lastClickAt: number;
  clicksMade: number;
}

interface ETeam {
  side: Side;
  clicks: number;
  shield: number;
  peak: number;
  bonus: number;
  boosts: Timed[];
  autoBoosts: Timed[];
  rust: Timed[];
  insurance: Timed[];
  invest: { ret: number; dueAt: number }[];
  decoys: number[];
  discount: number;
  taxes: number[];
  /** Slots added to the shop for good, and how many Odds Up upgrades the team has bought per category. */
  extraSlots: number;
  odds: Record<MixCategory, number>;
  slotWeights: SlotWeights;
  // shop
  order: string[];
  cursor: number;
  holder: string | null;
  holderTimerEnd: number;
  nextOfferAt: number | null;
  pendingDelay: number;
  /** Clicks made by hand since the last rate was worked out, and the rate that gave (the most recent one only). */
  manualAcc: number;
  manualRate: number;
  offer: { ids: string[]; budget: number } | null;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const active = (list: Timed[], t: number) => list.filter((x) => x.from <= t && x.until > t);
/** Boosts add up: two 2x boosts make 3x, not 4x. */
const mult = (list: Timed[], t: number) => 1 + active(list, t).reduce((s, x) => s + (x.v - 1), 0);

export interface EngineOpts {
  /** Time mode: how long the game lasts. */
  durationMs?: number | null;
  /** Target mode: the first team to this many clicks wins. */
  target?: number | null;
  rng?: () => number;
}

export class Engine {
  readonly players = new Map<string, EPlayer>();
  readonly teams: Record<Side, ETeam>;
  readonly startedAt: number;
  readonly endsAt: number | null;
  readonly target: number | null;
  finished = false;
  winner: Side | 'tie' | null = null;
  private last: number;
  private lastRateAt: number;
  private rng: () => number;
  feed: FeedEntry[] = [];
  private feedSeq = 0;

  constructor(roster: { id: string; name: string; side: Side; connected: boolean }[], now: number, opts: EngineOpts) {
    this.rng = opts.rng ?? Math.random;
    this.startedAt = this.last = this.lastRateAt = now;
    this.endsAt = opts.durationMs != null ? now + opts.durationMs : null;
    this.target = opts.target ?? null;
    const mk = (side: Side): ETeam => ({
      side,
      clicks: 0,
      shield: 0,
      peak: 0,
      bonus: 0,
      boosts: [],
      autoBoosts: [],
      rust: [],
      insurance: [],
      invest: [],
      decoys: [],
      discount: 0,
      taxes: [],
      extraSlots: 0,
      odds: { economic: 0, aggressive: 0, defensive: 0 },
      slotWeights: baseWeights(),
      order: [],
      cursor: 0,
      holder: null,
      holderTimerEnd: 0,
      nextOfferAt: now + CONFIG.firstShopDelayMs,
      pendingDelay: 0,
      manualAcc: 0,
      manualRate: 0,
      offer: null,
    });
    this.teams = { left: mk('left'), right: mk('right') };
    for (const r of roster) {
      this.players.set(r.id, { ...r, autos: [], regen: 0, drain: 0, siphon: 0, lastClickAt: now, clicksMade: 0 });
      this.teams[r.side].order.push(r.id);
    }
  }

  // ------------------------------------------------------------------ rates

  private rate(side: Side, f: (p: EPlayer) => number): number {
    let s = 0;
    for (const p of this.players.values()) if (p.side === side) s += f(p);
    return s;
  }
  private autoRaw = (side: Side) => this.rate(side, (p) => p.autos.reduce((s, a) => s + a.rate, 0));
  private rustFactor(t: ETeam, at: number) {
    return Math.max(0.05, 1 - active(t.rust, at).reduce((s, x) => s + x.v, 0));
  }
  private autoEffective(side: Side, at: number) {
    const t = this.teams[side];
    return this.autoRaw(side) * mult(t.autoBoosts, at) * this.rustFactor(t, at);
  }
  clickValue(side: Side, at: number) {
    const t = this.teams[side];
    return (1 + t.bonus) * mult(t.boosts, at);
  }

  // ------------------------------------------------------------------ the lazy clock

  /** Works out everything that happened between the last call and `now`. */
  advance(now: number) {
    if (now <= this.last) return;
    let t = this.last;
    while (t < now) {
      let next = now;
      for (const team of Object.values(this.teams)) {
        for (const list of [team.boosts, team.autoBoosts, team.rust, team.insurance]) for (const x of list) if (x.until > t && x.until < next) next = x.until;
        for (const inv of team.invest) if (inv.dueAt > t && inv.dueAt < next) next = inv.dueAt;
      }
      this.integrate(t, next);
      for (const team of Object.values(this.teams)) {
        for (const key of ['boosts', 'autoBoosts', 'rust', 'insurance'] as const) team[key] = team[key].filter((x) => x.until > next);
        team.invest = team.invest.filter((inv) => {
          if (inv.dueAt > next) return true;
          team.clicks += inv.ret;
          return false;
        });
      }
      t = next;
    }
    this.last = now;
  }

  /** Rates are constant across [t0, t1), so this is exact. */
  private integrate(t0: number, t1: number) {
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) return;
    for (const side of SIDES) {
      const team = this.teams[side];
      const foe = other(side);
      team.clicks += this.autoEffective(side, t0) * dt;
      // Gains first, then damage: a team earning 10/s under a 10/s drain just holds steady instead of bouncing off zero.
      const regen = this.rate(side, (p) => p.regen);
      if (regen > 0) team.shield = Math.max(team.shield, Math.min(team.peak, team.shield + regen * dt));
      this.damage(side, this.rate(foe, (p) => p.drain) * dt, t0);
    }
  }

  /** Hits a team: the shield soaks it first, then clicks (never below zero). Returns the clicks actually lost. */
  private damage(side: Side, amount: number, at: number): number {
    if (amount <= 0) return 0;
    const team = this.teams[side];
    const soaked = Math.min(team.shield, amount);
    team.shield -= soaked;
    const lost = Math.min(team.clicks, amount - soaked);
    team.clicks -= lost;
    const refund = Math.min(0.9, active(team.insurance, at).reduce((s, x) => s + x.v, 0));
    team.clicks += lost * refund;
    return lost;
  }

  // ------------------------------------------------------------------ driving it

  /** Call at (or after) `nextWake()`. Opens due shops in time order, and ends the game. */
  update(now: number) {
    if (this.finished) return;
    const end = Math.min(now, this.endsAt ?? Infinity);
    for (;;) {
      let due: ETeam | null = null;
      for (const side of SIDES) {
        const t = this.teams[side];
        if (!t.holder && t.nextOfferAt !== null && t.nextOfferAt <= end && (!due || t.nextOfferAt < due.nextOfferAt!)) due = t;
      }
      if (!due) break;
      this.advance(due.nextOfferAt!);
      this.offerNext(due, due.nextOfferAt!);
    }
    this.advance(end);
    if ((this.endsAt !== null && now >= this.endsAt) || this.hitTarget()) this.finish();
  }

  /** When something time-based next needs to happen (a shop opening, or the end of the game). */
  nextWake(): number | null {
    if (this.finished) return null;
    let w = this.endsAt ?? Infinity;
    for (const side of SIDES) {
      const t = this.teams[side];
      if (!t.holder && t.nextOfferAt !== null) w = Math.min(w, t.nextOfferAt);
    }
    return Number.isFinite(w) ? w : null;
  }

  /** Only ever asked inside update(), i.e. when the totals are being worked out anyway. */
  private hitTarget() {
    return this.target !== null && SIDES.some((s) => this.teams[s].clicks >= this.target!);
  }

  private finish() {
    this.finished = true;
    const l = Math.floor(this.teams.left.clicks);
    const r = Math.floor(this.teams.right.clicks);
    this.winner = l === r ? 'tie' : l > r ? 'left' : 'right';
    for (const side of SIDES) {
      const t = this.teams[side];
      t.holder = null;
      t.offer = null;
      t.nextOfferAt = null;
    }
    const why = this.target !== null ? 'Target reached' : "Time's up";
    this.log(null, this.winner === 'tie' ? `${why}: it's a tie!` : `${why}: the ${this.winner} team wins!`);
  }

  setConnected(id: string, connected: boolean, now: number) {
    const p = this.players.get(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    if (!connected && this.teams[p.side].holder === id) this.closeShop(id, now);
  }

  // ------------------------------------------------------------------ clicking

  /** A batch of button presses from a phone. Cheap by design: no advance, no broadcast. */
  clicks(id: string, n: number, now: number) {
    const p = this.players.get(id);
    if (!p || this.finished || !Number.isFinite(n) || n < 1) return;
    const elapsed = Math.max(0, now - p.lastClickAt);
    const window = Math.max(elapsed, 1000);
    n = Math.min(Math.floor(n), Math.ceil((window / 1000) * CONFIG.maxClicksPerSecond) + 5);
    const team = this.teams[p.side];
    // A boost that ended partway through this batch only counts for the part of it that was boosted.
    const from = Math.max(p.lastClickAt, now - window);
    let m = 1;
    for (const b of team.boosts) {
      const overlap = Math.min(b.until, now) - Math.max(b.from, from);
      if (overlap > 0) m += (b.v - 1) * (overlap / Math.max(1, now - from));
    }
    p.lastClickAt = now;
    p.clicksMade += n;
    team.clicks += n * (1 + team.bonus) * m;
    team.manualAcc += n * (1 + team.bonus) * m;
    if (p.siphon > 0) {
      this.advance(now); // shields must be current before we steal through them
      const stolen = this.damage(other(p.side), n * p.siphon, now);
      team.clicks += stolen;
    }
  }

  /**
   * Called right after clicks were collected from the phones: the manual clicking rate is simply what was gained
   * since the previous collection, divided by the time between them. No history is kept.
   */
  rollRate(now: number) {
    const dt = (now - this.lastRateAt) / 1000;
    if (dt < 0.25) return; // too close together to mean anything: keep the last rate
    for (const side of SIDES) {
      const t = this.teams[side];
      t.manualRate = t.manualAcc / dt;
      t.manualAcc = 0;
    }
    this.lastRateAt = now;
  }

  // ------------------------------------------------------------------ the shop

  private offerNext(team: ETeam, now: number) {
    const n = team.order.length;
    for (let i = 0; i < n; i++) {
      const idx = (team.cursor + i) % n;
      const p = this.players.get(team.order[idx])!;
      if (!p.connected) continue;
      team.cursor = (idx + 1) % n;
      team.holder = p.id;
      team.holderTimerEnd = now + CONFIG.shopHoldMs;
      team.nextOfferAt = null;
      const budget = Math.floor(team.clicks); // the snapshot: later earnings don't count
      team.offer = { ids: rollShop(budget, this.rng, { extraSlots: team.extraSlots, weights: team.slotWeights }).map((i) => i.id), budget };
      return;
    }
    team.nextOfferAt = now + 2000; // nobody connected: look again shortly
  }

  /**
   * The shop is released. If the holder's minimum time hasn't run out, the next player has to wait for it;
   * if it already has, the next player gets the shop straight away.
   */
  closeShop(id: string, now: number): Result {
    const p = this.players.get(id);
    if (!p) return err('You are not in this game.');
    const team = this.teams[p.side];
    if (team.holder !== id) return err('The shop is not open for you.');
    this.update(now);
    team.holder = null;
    team.offer = null;
    team.nextOfferAt = Math.max(now, team.holderTimerEnd) + team.pendingDelay;
    team.pendingDelay = 0;
    if (!this.finished && team.nextOfferAt <= now) this.update(now);
    return { ok: true };
  }

  private priceOf(team: ETeam, item: ItemDef) {
    const base = Math.ceil(item.cost * (1 - team.discount));
    const tax = Math.ceil(base * team.taxes.reduce((s, x) => s + x, 0));
    return { price: base + tax, tax };
  }

  buy(id: string, itemId: string, now: number): Result {
    this.update(now);
    const p = this.players.get(id);
    if (!p || this.finished) return err('The game is over.');
    const team = this.teams[p.side];
    const foe = this.teams[other(p.side)];
    if (team.holder !== id || !team.offer) return err('The shop is not open for you.');
    if (!team.offer.ids.includes(itemId)) return err("That isn't on the shelf.");
    const item = ITEMS.get(itemId)!;
    const { price, tax } = this.priceOf(team, item);
    if (price > team.offer.budget) return err('Not enough clicks in your budget.');
    if (price > Math.floor(team.clicks)) return err('Your team was hit and no longer has that many clicks!');

    // Attacks that need a target are checked before anything is charged.
    let target: EPlayer | null = null;
    let absorbedBy = -1;
    if (item.eff.k === 'deleteAuto') {
      absorbedBy = this.pickDecoy(foe, item.tier);
      if (absorbedBy < 0) {
        const holders = [...this.players.values()].filter((x) => x.side === foe.side && x.autos.some((a) => a.tier === item.tier));
        if (!holders.length) return err(`The other team has no tier ${item.tier} auto clickers to delete.`);
        target = holders[Math.floor(this.rng() * holders.length)];
      }
    }

    team.clicks -= price;
    team.discount = 0;
    team.taxes = [];
    foe.clicks += tax; // the sales tax goes to whoever levied it
    const who = `${p.name}`;
    const say = (text: string) => this.log(team.side, text);
    const sneaky = () => this.log(team.side, `${who} bought something sneaky...`);

    const e = item.eff;
    switch (e.k) {
      case 'boost':
        team.boosts.push({ v: e.mult, from: now, until: now + e.sec * 1000 });
        say(`${who}: ${e.mult}x clicking for ${e.sec}s!`);
        break;
      case 'autoBoost':
        team.autoBoosts.push({ v: e.mult, from: now, until: now + e.sec * 1000 });
        say(`${who}: auto clickers x${e.mult} for ${e.sec}s!`);
        break;
      case 'auto':
        p.autos.push({ tier: item.tier, rate: e.rate });
        say(`${who} bought an auto clicker (${e.rate}/s).`);
        break;
      case 'perClick':
        team.bonus += e.n;
        say(`${who} made every click worth +${fmt(e.n)}.`);
        break;
      case 'shield':
        team.shield += e.hp;
        team.peak = Math.max(team.peak, team.shield);
        say(`${who} added ${fmt(e.hp)} shield.`);
        break;
      case 'regen':
        p.regen += e.rate;
        say(`${who} bought shield regen (${fmt(e.rate)}/s).`);
        break;
      case 'remove': {
        this.advance(now);
        const lost = this.damage(foe.side, e.n, now);
        say(`${who} hit the ${foe.side} team for ${fmt(e.n)}: ${fmt(lost)} clicks lost${lost < e.n ? ' (shield soaked the rest)' : ''}.`);
        break;
      }
      case 'drain':
        p.drain += e.rate;
        say(`${who} started draining ${fmt(e.rate)} clicks/s from the ${foe.side} team.`);
        break;
      case 'deleteAuto':
        if (absorbedBy >= 0) {
          foe.decoys.splice(absorbedBy, 1);
          say(`${who} tried to delete an auto clicker, but a DECOY took the hit!`);
        } else if (target) {
          const i = target.autos.findIndex((a) => a.tier === item.tier);
          const [gone] = target.autos.splice(i, 1);
          say(`${who} destroyed one of ${target.name}'s auto clickers (${gone.rate}/s)!`);
        }
        break;
      case 'siege': {
        const hit = Math.min(foe.shield, e.hp);
        foe.shield -= hit;
        say(`${who} besieged the ${foe.side} shield: -${fmt(hit)} HP.`);
        break;
      }
      case 'discount':
        team.discount = Math.min(0.9, team.discount + e.pct / 100);
        sneaky();
        break;
      case 'invest':
        team.invest.push({ ret: e.ret, dueAt: now + e.sec * 1000 });
        sneaky();
        break;
      case 'siphon':
        p.siphon += e.n;
        say(`${who} is now siphoning ${fmt(p.siphon)} per click!`);
        break;
      case 'decoy':
        team.decoys.push(item.tier);
        sneaky();
        break;
      case 'insurance':
        team.insurance.push({ v: e.pct / 100, from: now, until: now + e.sec * 1000 });
        sneaky();
        break;
      case 'sabotage':
        if (foe.holder) foe.pendingDelay += e.sec * 1000;
        else if (foe.nextOfferAt !== null) foe.nextOfferAt += e.sec * 1000;
        say(`${who} sabotaged the ${foe.side} team's next shop: +${e.sec}s.`);
        break;
      case 'rust':
        foe.rust.push({ v: e.pct / 100, from: now, until: now + e.sec * 1000 });
        say(`${who} rusted the ${foe.side} team's auto clickers (-${e.pct}% for ${e.sec}s).`);
        break;
      case 'slot':
        team.extraSlots = Math.min(MAX_EXTRA_SLOTS, team.extraSlots + 1);
        say(`${who} added a slot to the shop for good (${4 + team.extraSlots} slots).`);
        break;
      case 'odds':
        team.odds[e.cat]++;
        bumpOdds(team.slotWeights, e.cat);
        say(`${who} improved the shop's odds of ${e.cat} items.`);
        break;
      case 'tax':
        foe.taxes.push(e.pct / 100);
        say(`${who} levied a sales tax on the ${foe.side} team's next purchase.`);
        break;
    }
    if (tax > 0) this.log(foe.side, `The ${foe.side} team collected ${fmt(tax)} in sales tax.`);
    return this.closeShop(id, now);
  }

  /** Index of the weakest decoy that can absorb a tier-`tier` attack, or -1. */
  private pickDecoy(team: ETeam, tier: number): number {
    let best = -1;
    team.decoys.forEach((t, i) => t >= tier && (best < 0 || t < team.decoys[best]) && (best = i));
    return best;
  }

  // ------------------------------------------------------------------ views

  private log(side: Side | null, text: string): true {
    this.feed.push({ id: ++this.feedSeq, at: this.last, side, text });
    if (this.feed.length > 14) this.feed.shift();
    return true;
  }

  private teamBoard(side: Side, at: number): TeamBoard {
    const t = this.teams[side];
    const effects: EffectBadge[] = [];
    for (const b of active(t.boosts, at)) effects.push({ label: `${b.v}x clicks`, until: b.until });
    for (const b of active(t.autoBoosts, at)) effects.push({ label: `Overdrive x${b.v}`, until: b.until });
    for (const b of active(t.rust, at)) effects.push({ label: `Rusted -${Math.round(b.v * 100)}%`, until: b.until });
    return {
      clicks: Math.floor(t.clicks),
      shield: Math.floor(t.shield),
      shieldPeak: Math.floor(t.peak),
      auto: this.autoEffective(side, at),
      regen: this.rate(side, (p) => p.regen),
      drain: this.rate(side, (p) => p.drain),
      ...this.trend(side, at),
      perClick: this.clickValue(side, at),
      effects,
      holderId: t.holder,
      holderEndsAt: t.holder ? t.holderTimerEnd : null,
      nextOfferAt: t.nextOfferAt,
    };
  }

  /** Where the screens should drift between real updates (see TeamBoard.clicksPerSec). */
  private trend(side: Side, at: number): { clicksPerSec: number; shieldPerSec: number } {
    const t = this.teams[side];
    const regen = this.rate(side, (p) => p.regen);
    const drainIn = this.rate(other(side), (p) => p.drain);
    const income = this.autoEffective(side, at) + t.manualRate * CONFIG.projectionFactor;
    // A shield soaks the drain first; with none left, whatever regen doesn't cover bites into the clicks.
    if (t.shield > 0) return { clicksPerSec: income, shieldPerSec: regen - drainIn };
    return { clicksPerSec: income - Math.max(0, drainIn - regen), shieldPerSec: 0 };
  }

  board(now: number): Board {
    return { left: this.teamBoard('left', now), right: this.teamBoard('right', now), at: now };
  }

  you(id: string, now: number): YouInfo | null {
    const p = this.players.get(id);
    if (!p) return null;
    const t = this.teams[p.side];
    const perks: string[] = [];
    for (const tier of t.decoys) perks.push(`Decoy (tier ${tier}) is standing by`);
    for (const x of active(t.insurance, now)) perks.push(`Insured: ${Math.round(x.v * 100)}% of losses refunded`);
    if (t.discount) perks.push(`Next purchase ${Math.round(t.discount * 100)}% off`);
    const tax = t.taxes.reduce((s, x) => s + x, 0);
    if (tax) perks.push(`Next purchase has +${Math.round(tax * 100)}% sales tax!`);
    for (const inv of t.invest) perks.push(`Investment pays ${fmt(inv.ret)} in ${Math.max(0, Math.ceil((inv.dueAt - now) / 1000))}s`);
    if (t.extraSlots) perks.push(`Shop has ${4 + t.extraSlots} slots`);
    for (const c of ['economic', 'aggressive', 'defensive'] as const) if (t.odds[c]) perks.push(`Shop odds: ${c} x${t.odds[c]}`);
    if (p.siphon) perks.push(`You siphon ${fmt(p.siphon)} per click`);

    let shop: YouInfo['shop'] = null;
    if (t.holder === id && t.offer) {
      const items: ShopItemView[] = t.offer.ids.map((iid) => {
        const it = ITEMS.get(iid)!;
        const { price, tax: tx } = this.priceOf(t, it);
        return { id: it.id, name: it.name, desc: it.desc, tier: it.tier, rarity: it.rarity, category: it.category, cost: it.cost, price, tax: tx };
      });
      shop = { items, budget: t.offer.budget, minUntil: t.holderTimerEnd };
    }
    let queuePos: number | null = null;
    if (!shop) {
      let pos = 0;
      for (let i = 0; i < t.order.length; i++) {
        const q = this.players.get(t.order[(t.cursor + i) % t.order.length])!;
        if (q.id === id) {
          queuePos = pos;
          break;
        }
        if (q.connected) pos++;
      }
    }
    return { id, side: p.side, clickValue: this.clickValue(p.side, now), shop, perks, queuePos };
  }
}

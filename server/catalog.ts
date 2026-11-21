import type { Rarity, ShopCategory } from '../shared/types.js';

/** The three categories that the non-auto-clicker shop slots roll from. */
export type MixCategory = Exclude<ShopCategory, 'auto'>;
export const MIX_CATEGORIES: MixCategory[] = ['economic', 'aggressive', 'defensive'];

/** What buying an item does. Costs live on the item, not the effect. */
export type Effect =
  | { k: 'boost'; mult: number; sec: number } // team clicks worth x for a while
  | { k: 'autoBoost'; mult: number; sec: number } // team auto clickers x for a while
  | { k: 'bothBoost'; mult: number; sec: number } // team clicks AND auto clickers x for a while
  | { k: 'auto'; rate: number } // an auto clicker (clicks/second)
  | { k: 'perClick'; n: number } // permanent +n per click for the whole team
  | { k: 'shield'; hp: number }
  | { k: 'regen'; rate: number } // shield hp/second
  | { k: 'remove'; n: number } // remove clicks from the other team
  | { k: 'drain'; rate: number } // remove clicks/second from the other team
  | { k: 'deleteAuto' } // destroy one auto clicker of the item's tier on the other team
  | { k: 'siege'; hp: number } // knock hp off the other team's shield (shield only)
  | { k: 'discount'; pct: number } // next purchase by your team is cheaper
  | { k: 'invest'; ret: number; sec: number } // pay the cost now, get `ret` back later
  | { k: 'siphon'; n: number } // each of your clicks steals n from the other team
  | { k: 'decoy' } // absorbs the next delete-auto-clicker attack of this tier or lower
  | { k: 'insurance'; pct: number; sec: number } // refund part of clicks lost to attacks
  | { k: 'sabotage'; sec: number } // delay the other team's next shop
  | { k: 'rust'; pct: number; sec: number } // other team's auto clickers produce less
  | { k: 'tax'; pct: number } // other team's next purchase costs more, you collect
  | { k: 'slot' } // permanently adds one slot to your team's shop
  | { k: 'odds'; cat: MixCategory }; // shifts your shop slots' rolls towards this category

export interface ItemDef {
  id: string;
  tier: 1 | 2 | 3;
  rarity: Rarity;
  cost: number;
  eff: Effect;
  category: ShopCategory;
  name: string;
  desc: string;
}

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 100, uncommon: 45, rare: 15 };

const fmt = (n: number) => n.toLocaleString('en-US');

const CAT_LABEL: Record<MixCategory, string> = { economic: 'Economic', aggressive: 'Aggressive', defensive: 'Defensive' };

export function categoryOf(e: Effect): ShopCategory {
  switch (e.k) {
    case 'auto':
      return 'auto';
    case 'odds':
      return e.cat;
    case 'remove':
    case 'drain':
    case 'deleteAuto':
    case 'siege':
    case 'siphon':
    case 'sabotage':
    case 'rust':
    case 'tax':
      return 'aggressive';
    case 'shield':
    case 'regen':
    case 'decoy':
    case 'insurance':
      return 'defensive';
    default:
      return 'economic'; // boost, autoBoost, perClick, discount, invest, slot
  }
}

function text(e: Effect, tier: number, cost: number): { name: string; desc: string } {
  switch (e.k) {
    case 'boost':
      return { name: `${e.mult}x Clicking (${e.sec}s)`, desc: `Every click your team makes is worth ${e.mult}x for ${e.sec} seconds.` };
    case 'autoBoost':
      return { name: `Overdrive x${e.mult} (${e.sec}s)`, desc: `Your team's auto clickers run ${e.mult}x faster for ${e.sec} seconds.` };
    case 'bothBoost':
      return { name: `Mega Multiplier x${e.mult} (${e.sec}s)`, desc: `Both your team's clicks and auto clickers are worth ${e.mult}x for ${e.sec} seconds. Stacks with other multipliers.` };
    case 'auto':
      return { name: `Auto Clicker ${fmt(e.rate)}/s`, desc: `Your team earns +${fmt(e.rate)} clicks every second until someone destroys it.` };
    case 'perClick':
      return { name: `+${fmt(e.n)} Per Click`, desc: `Permanently, every click your team makes is worth +${fmt(e.n)}.` };
    case 'shield':
      return { name: `+${fmt(e.hp)} Shield`, desc: `Add ${fmt(e.hp)} HP to your shield. Attacks have to chew through it first.` };
    case 'regen':
      return { name: `Shield Regen ${fmt(e.rate)}/s`, desc: `Your shield heals ${fmt(e.rate)} HP a second, but never above the highest it has ever been.` };
    case 'remove':
      return { name: `Remove ${fmt(e.n)}`, desc: `Remove ${fmt(e.n)} clicks from the other team. Their shield soaks it up first.` };
    case 'drain':
      return { name: `Drain ${fmt(e.rate)}/s`, desc: `Remove ${fmt(e.rate)} clicks a second from the other team, for good. Shields soak it up first.` };
    case 'deleteAuto':
      return { name: `Delete Tier ${tier} Auto Clicker`, desc: `Destroy one random tier ${tier} auto clicker on the other team (a decoy can absorb it).` };
    case 'siege':
      return { name: `Siege ${fmt(e.hp)}`, desc: `Blast ${fmt(e.hp)} HP off the other team's shield. Only hits the shield.` };
    case 'discount':
      return { name: `Bulk Discount ${e.pct}%`, desc: `The next purchase anyone on your team makes costs ${e.pct}% less.` };
    case 'invest':
      return { name: `Invest ${fmt(cost)}`, desc: `Pay ${fmt(cost)} now. In ${e.sec} seconds ${fmt(e.ret)} clicks land back in your team's pool.` };
    case 'siphon':
      return { name: `Siphon ${fmt(e.n)}/click`, desc: `Each time YOU click, ${fmt(e.n)} click${e.n === 1 ? ' is' : 's are'} stolen from the other team and given to yours. Shields block it. Stacks.` };
    case 'decoy':
      return { name: `Decoy (Tier ${tier})`, desc: `Secretly absorbs the next "delete auto clicker" attack of tier ${tier}${tier > 1 ? ' or lower' : ''} against your team.` };
    case 'insurance':
      return { name: `Insurance ${e.pct}% (${e.sec}s)`, desc: `For ${e.sec} seconds, ${e.pct}% of every click your team loses to attacks is paid back. Secret.` };
    case 'sabotage':
      return { name: `Sabotage ${e.sec}s`, desc: `The other team's next shop opening is delayed by ${e.sec} seconds.` };
    case 'rust':
      return { name: `Rust ${e.pct}% (${e.sec}s)`, desc: `For ${e.sec} seconds the other team's auto clickers produce ${e.pct}% less.` };
    case 'slot':
      return { name: 'Extra Shop Slot', desc: `Permanently adds one slot to your team's shop (a random item from any category).` };
    case 'odds':
      return { name: `${CAT_LABEL[e.cat]} Odds Up`, desc: `Your shop's other slots get a better chance of rolling ${e.cat} items, and your ${e.cat} slot is less likely to roll anything else. Stacks.` };
    case 'tax':
      return { name: `Sales Tax ${e.pct}%`, desc: `The other team's next purchase costs ${e.pct}% more, and your team collects the extra.` };
  }
}

type Row = [r: 'c' | 'u' | 'r', cost: number, eff: Effect];
const R: Record<string, Rarity> = { c: 'common', u: 'uncommon', r: 'rare' };

const T1: Row[] = [
  ['c', 10, { k: 'boost', mult: 2, sec: 10 }],
  ['u', 25, { k: 'boost', mult: 2, sec: 30 }],
  ['u', 40, { k: 'boost', mult: 3, sec: 10 }],
  ['c', 60, { k: 'autoBoost', mult: 2, sec: 20 }],
  ['r', 300, { k: 'bothBoost', mult: 2, sec: 15 }],
  ['c', 10, { k: 'auto', rate: 1 }],
  ['u', 80, { k: 'auto', rate: 5 }],
  ['u', 200, { k: 'auto', rate: 10 }],
  ['r', 1500, { k: 'auto', rate: 50 }],
  ['c', 100, { k: 'perClick', n: 1 }],
  ['c', 100, { k: 'deleteAuto' }],
  ['c', 75, { k: 'remove', n: 100 }],
  ['u', 500, { k: 'remove', n: 1000 }],
  ['c', 10, { k: 'shield', hp: 10 }],
  ['u', 200, { k: 'shield', hp: 100 }],
  ['u', 100, { k: 'regen', rate: 1 }],
  ['u', 180, { k: 'regen', rate: 2 }],
  ['r', 750, { k: 'regen', rate: 5 }],
  ['c', 30, { k: 'discount', pct: 10 }],
  ['u', 100, { k: 'invest', ret: 250, sec: 30 }],
  ['r', 400, { k: 'invest', ret: 1200, sec: 30 }],
  ['r', 600, { k: 'siphon', n: 1 }],
  ['c', 60, { k: 'decoy' }],
  ['u', 50, { k: 'insurance', pct: 30, sec: 60 }],
  ['c', 50, { k: 'sabotage', sec: 5 }],
  ['c', 40, { k: 'rust', pct: 25, sec: 30 }],
  ['c', 30, { k: 'siege', hp: 100 }],
  ['u', 90, { k: 'siege', hp: 300 }],
  ['c', 30, { k: 'tax', pct: 20 }],
  ['r', 400, { k: 'slot' }],
  ['u', 150, { k: 'odds', cat: 'economic' }],
  ['u', 150, { k: 'odds', cat: 'aggressive' }],
  ['u', 150, { k: 'odds', cat: 'defensive' }],
];

const T2: Row[] = [
  ['c', 300, { k: 'boost', mult: 3, sec: 20 }],
  ['u', 400, { k: 'boost', mult: 2, sec: 60 }],
  ['u', 800, { k: 'boost', mult: 5, sec: 20 }],
  ['c', 1200, { k: 'autoBoost', mult: 3, sec: 20 }],
  ['u', 1500, { k: 'autoBoost', mult: 2, sec: 30 }],
  ['r', 6000, { k: 'bothBoost', mult: 3, sec: 15 }],
  ['c', 2000, { k: 'auto', rate: 80 }],
  ['c', 2200, { k: 'auto', rate: 100 }],
  ['c', 4000, { k: 'auto', rate: 200 }],
  ['u', 10000, { k: 'auto', rate: 500 }],
  ['r', 25000, { k: 'auto', rate: 1000 }],
  ['c', 100, { k: 'perClick', n: 1 }],
  ['u', 2000, { k: 'perClick', n: 3 }],
  ['r', 25000, { k: 'perClick', n: 10 }],
  ['c', 8000, { k: 'deleteAuto' }],
  ['c', 1500, { k: 'remove', n: 5000 }],
  ['u', 2500, { k: 'remove', n: 10000 }],
  ['c', 1000, { k: 'shield', hp: 250 }],
  ['c', 2500, { k: 'shield', hp: 500 }],
  ['u', 7500, { k: 'shield', hp: 1000 }],
  ['u', 2000, { k: 'regen', rate: 10 }],
  ['u', 5000, { k: 'regen', rate: 20 }],
  ['u', 10000, { k: 'regen', rate: 25 }],
  ['r', 50000, { k: 'regen', rate: 100 }],
  ['u', 1500, { k: 'drain', rate: 10 }],
  ['r', 35000, { k: 'drain', rate: 500 }],
  ['u', 400, { k: 'discount', pct: 20 }],
  ['c', 1000, { k: 'invest', ret: 2000, sec: 30 }],
  ['u', 4000, { k: 'invest', ret: 10000, sec: 30 }],
  ['r', 15000, { k: 'invest', ret: 45000, sec: 30 }],
  ['r', 9000, { k: 'siphon', n: 5 }],
  ['u', 5000, { k: 'decoy' }],
  ['u', 2500, { k: 'insurance', pct: 40, sec: 60 }],
  ['u', 1000, { k: 'sabotage', sec: 10 }],
  ['c', 1500, { k: 'rust', pct: 35, sec: 30 }],
  ['c', 600, { k: 'siege', hp: 2000 }],
  ['u', 2500, { k: 'siege', hp: 10000 }],
  ['c', 800, { k: 'tax', pct: 35 }],
  ['r', 8000, { k: 'slot' }],
  ['u', 3000, { k: 'odds', cat: 'economic' }],
  ['u', 3000, { k: 'odds', cat: 'aggressive' }],
  ['u', 3000, { k: 'odds', cat: 'defensive' }],
];

const T3: Row[] = [
  ['c', 3000, { k: 'boost', mult: 5, sec: 30 }],
  ['u', 8000, { k: 'boost', mult: 10, sec: 20 }],
  ['u', 12000, { k: 'boost', mult: 3, sec: 120 }],
  ['r', 20000, { k: 'boost', mult: 25, sec: 15 }],
  ['c', 25000, { k: 'autoBoost', mult: 3, sec: 20 }],
  ['u', 40000, { k: 'autoBoost', mult: 3, sec: 30 }],
  ['r', 100000, { k: 'bothBoost', mult: 5, sec: 15 }],
  ['r', 150000, { k: 'autoBoost', mult: 5, sec: 20 }],
  ['c', 100000, { k: 'auto', rate: 2500 }],
  ['c', 150000, { k: 'auto', rate: 5000 }],
  ['c', 200000, { k: 'auto', rate: 7500 }],
  ['u', 500000, { k: 'auto', rate: 10000 }],
  ['r', 3500000, { k: 'auto', rate: 100000 }],
  ['c', 50000, { k: 'perClick', n: 25 }],
  ['c', 55000, { k: 'perClick', n: 30 }],
  ['c', 60000, { k: 'perClick', n: 35 }],
  ['u', 75000, { k: 'perClick', n: 50 }],
  ['u', 100000, { k: 'perClick', n: 100 }],
  ['r', 250000, { k: 'perClick', n: 250 }],
  ['r', 1000000, { k: 'perClick', n: 1000 }],
  ['c', 450000, { k: 'deleteAuto' }],
  ['c', 20000, { k: 'remove', n: 100000 }],
  ['u', 75000, { k: 'remove', n: 500000 }],
  ['r', 100000, { k: 'remove', n: 1000000 }],
  // The brief's tier 3 shield prices (1000 for 2000 HP, ...) looked like tier 2 prices pasted in; rescaled.
  ['c', 20000, { k: 'shield', hp: 25000 }],
  ['c', 70000, { k: 'shield', hp: 100000 }],
  ['r', 300000, { k: 'shield', hp: 500000 }],
  ['c', 250000, { k: 'regen', rate: 250 }],
  ['u', 600000, { k: 'regen', rate: 500 }],
  ['r', 1000000, { k: 'regen', rate: 1000 }],
  ['u', 500000, { k: 'drain', rate: 3500 }],
  ['u', 1000000, { k: 'drain', rate: 5000 }],
  ['r', 30000, { k: 'discount', pct: 50 }],
  ['c', 20000, { k: 'invest', ret: 40000, sec: 30 }],
  ['u', 100000, { k: 'invest', ret: 250000, sec: 30 }],
  ['r', 400000, { k: 'invest', ret: 1200000, sec: 30 }],
  ['r', 25000, { k: 'siphon', n: 10 }],
  ['u', 300000, { k: 'decoy' }],
  ['u', 80000, { k: 'insurance', pct: 50, sec: 60 }],
  ['u', 50000, { k: 'sabotage', sec: 20 }],
  ['c', 60000, { k: 'rust', pct: 50, sec: 30 }],
  ['c', 30000, { k: 'siege', hp: 100000 }],
  ['u', 120000, { k: 'siege', hp: 500000 }],
  ['c', 25000, { k: 'tax', pct: 50 }],
  ['r', 150000, { k: 'slot' }],
  ['u', 60000, { k: 'odds', cat: 'economic' }],
  ['u', 60000, { k: 'odds', cat: 'aggressive' }],
  ['u', 60000, { k: 'odds', cat: 'defensive' }],
];

export const CATALOG: ItemDef[] = [T1, T2, T3].flatMap((rows, ti) =>
  rows.map(([r, cost, eff], i): ItemDef => {
    const tier = (ti + 1) as 1 | 2 | 3;
    return { id: `t${tier}-${i}`, tier, rarity: R[r], cost, eff, category: categoryOf(eff), ...text(eff, tier, cost) };
  }),
);
export const ITEMS = new Map(CATALOG.map((i) => [i.id, i]));

/** Which tiers the three shop slots are, by how many clicks the team had when the shop opened. */
export function slotTiers(clicks: number): (1 | 2 | 3)[] {
  if (clicks < 500) return [1, 1, 1];
  if (clicks < 4000) return [1, 1, 2];
  if (clicks < 10000) return [1, 2, 2];
  if (clicks < 25000) return [1, 2, 3];
  if (clicks < 100000) return [2, 2, 3];
  if (clicks < 500000) return [2, 3, 3];
  return [3, 3, 3];
}

/** The most extra slots a team can buy (so a shop is at most 4 + this long). */
export const MAX_EXTRA_SLOTS = 4;
/** How heavily a slot favours its own category. Every odds upgrade moves the other weights by 1 (see `bumpOdds`). */
export const HOME_WEIGHT = 2;

/** For each of the three slots (named by its home category), the weight of rolling each category. */
export type SlotWeights = Record<MixCategory, Record<MixCategory, number>>;

/** A fresh shop: every slot always rolls its own category. */
export const baseWeights = (): SlotWeights => {
  const w = {} as SlotWeights;
  for (const h of MIX_CATEGORIES) {
    w[h] = {} as Record<MixCategory, number>;
    for (const c of MIX_CATEGORIES) w[h][c] = c === h ? HOME_WEIGHT : 0;
  }
  return w;
};

/**
 * Buying "Odds Up" for `cat`: the other two slots gain a chance to roll `cat`, and the `cat` slot loses one step of
 * chance to roll anything else (down to always rolling `cat`). With HOME_WEIGHT 2, one upgrade makes another slot
 * roll `cat` 1 time in 3.
 */
export function bumpOdds(w: SlotWeights, cat: MixCategory): void {
  for (const h of MIX_CATEGORIES) {
    for (const c of MIX_CATEGORIES) {
      if (c === h) continue;
      if (h === cat) w[h][c] = Math.max(0, w[h][c] - 1);
      else if (c === cat) w[h][c] += 1;
    }
  }
}

export interface ShopOpts {
  /** Slots bought with "Extra Shop Slot". */
  extraSlots: number;
  /** What each slot rolls its category from. */
  weights: SlotWeights;
}
export const NO_OPTS: ShopOpts = { extraSlots: 0, weights: baseWeights() };

function weighted<T>(list: T[], weight: (t: T) => number, rng: () => number): T {
  const total = list.reduce((s, x) => s + weight(x), 0);
  let roll = rng() * total;
  return list.find((x) => (roll -= weight(x)) < 0) ?? list[list.length - 1];
}

/**
 * Rolls a shop, in this order:
 *  1. An auto clicker: any tier, picked at random from the three best (by clicks/second) the team can afford.
 *     If it can't afford any, the cheapest auto clicker is shown anyway. Never affected by the odds upgrades.
 *  2. Economic (auto clickers count as economic here too), 3. aggressive, 4. defensive: each rolls its category using the team's `weights`.
 *  5. One wildcard (any of the three categories, evenly) for each extra slot bought.
 * Items come from the tiers the team's click total unlocks (`slotTiers`), weighted by rarity, preferring ones
 * the team can afford, with no repeats.
 */
export function rollShop(clicks: number, rng: () => number, opts: ShopOpts = NO_OPTS): ItemDef[] {
  const out: ItemDef[] = [];

  const autos = CATALOG.filter((i) => i.category === 'auto');
  const ownable = autos.filter((i) => i.cost <= clicks).sort((a, b) => rateOf(b) - rateOf(a)).slice(0, 3);
  const cheapest = [...autos].sort((a, b) => a.cost - b.cost)[0];
  out.push(ownable.length ? ownable[Math.floor(rng() * ownable.length)] : cheapest);

  const tiers = new Set(slotTiers(clicks));
  const pick = (cat: MixCategory): ItemDef | null => {
    const all = CATALOG.filter(
      (i) => (i.category === cat || (cat === 'economic' && i.category === 'auto')) && tiers.has(i.tier) && !out.includes(i) && !(i.eff.k === 'slot' && opts.extraSlots >= MAX_EXTRA_SLOTS),
    );
    const affordable = all.filter((i) => i.cost <= clicks);
    const pool = affordable.length ? affordable : all;
    return pool.length ? weighted(pool, (i) => RARITY_WEIGHT[i.rarity], rng) : null;
  };
  /** Rolls the category, falling back to the others if that one has nothing left to show. */
  const slot = (first: MixCategory) => {
    const order = [first, ...MIX_CATEGORIES.filter((c) => c !== first)];
    for (const c of order) {
      const it = pick(c);
      if (it) return out.push(it);
    }
  };

  for (const home of MIX_CATEGORIES) {
    slot(weighted(MIX_CATEGORIES, (c) => opts.weights[home][c], rng));
  }
  for (let i = 0; i < Math.min(opts.extraSlots, MAX_EXTRA_SLOTS); i++) slot(MIX_CATEGORIES[Math.floor(rng() * 3)]);
  return out;
}

const rateOf = (i: ItemDef) => (i.eff.k === 'auto' ? i.eff.rate : 0);

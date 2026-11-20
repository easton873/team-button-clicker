// Deterministic engine tests: a fake clock, no sockets.
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { CONFIG } from '../server/config.js';
import { CATALOG, ITEMS, slotTiers, rollShop } from '../server/catalog.js';

const S = 1000;
const roster = [
  { id: 'a1', name: 'Ann', side: 'left' as const, connected: true },
  { id: 'a2', name: 'Al', side: 'left' as const, connected: true },
  { id: 'b1', name: 'Bo', side: 'right' as const, connected: true },
];
const mk = (rng = () => 0.5) => new Engine(roster, 0, { durationMs: 600 * S, rng });
const find = (pred: (i: (typeof CATALOG)[number]) => boolean) => CATALOG.find(pred)!;
/** Puts an item on the holder's shelf and buys it. */
function give(e: Engine, id: string, itemId: string, now: number) {
  const side = e.players.get(id)!.side;
  const t = e.teams[side];
  if (t.holder !== id) {
    // make sure it's this player's turn
    t.holder = id;
    t.holderTimerEnd = now;
    t.nextOfferAt = null;
  }
  t.offer = { ids: [itemId], budget: Math.floor(t.clicks) };
  return e.buy(id, itemId, now);
}
const id = (pred: (i: (typeof CATALOG)[number]) => boolean) => find(pred).id;

let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log('  ok', name);
};

test('shop brackets match the brief', () => {
  assert.deepEqual(slotTiers(0), [1, 1, 1]);
  assert.deepEqual(slotTiers(499), [1, 1, 1]);
  assert.deepEqual(slotTiers(500), [1, 1, 2]);
  assert.deepEqual(slotTiers(4000), [1, 2, 2]);
  assert.deepEqual(slotTiers(10000), [1, 2, 3]);
  assert.deepEqual(slotTiers(25000), [2, 2, 3]);
  assert.deepEqual(slotTiers(100000), [2, 3, 3]);
  assert.deepEqual(slotTiers(500000), [3, 3, 3]);
  assert.deepEqual(slotTiers(5e7), [3, 3, 3]);
  for (let i = 0; i < 200; i++) {
    const shop = rollShop(Math.floor(Math.random() * 2e6), Math.random);
    assert.equal(new Set(shop.map((s) => s.id)).size, 3, 'no duplicates on a shelf');
  }
});

test('catalog ids are unique and rarities set', () => {
  assert.equal(new Set(CATALOG.map((c) => c.id)).size, CATALOG.length);
  assert.ok(CATALOG.every((c) => c.cost > 0 && ['common', 'uncommon', 'rare'].includes(c.rarity)));
});

test('clicks are worth 1 plus permanent bonuses; boosts add together', () => {
  const e = mk();
  e.clicks('a1', 10, 1 * S);
  assert.equal(Math.floor(e.teams.left.clicks), 10);
  e.teams.left.bonus = 2;
  e.teams.left.boosts.push({ v: 2, from: 0, until: 100 * S });
  assert.equal(e.clickValue('left', 2 * S), 6);
  e.teams.left.boosts.push({ v: 2, from: 0, until: 100 * S });
  assert.equal(e.clickValue('left', 2 * S), 9, '1+2 bonus = 3, times (1+1+1)');
});

test('auto clickers accrue lazily and exactly, however rarely we look', () => {
  const a = mk();
  const b = mk();
  for (const e of [a, b]) {
    e.players.get('a1')!.autos.push({ tier: 1, rate: 5 });
  }
  a.advance(60 * S);
  for (let t = 1; t <= 60; t++) b.advance(t * S);
  assert.equal(Math.round(a.teams.left.clicks), 300);
  assert.equal(Math.round(b.teams.left.clicks), 300);
});

test('timed boosts expire mid-span without being averaged away', () => {
  const e = mk();
  e.players.get('a1')!.autos.push({ tier: 1, rate: 10 });
  e.teams.left.autoBoosts.push({ v: 3, from: 0, until: 10 * S });
  e.advance(30 * S); // 10s at 30/s + 20s at 10/s
  assert.equal(Math.round(e.teams.left.clicks), 500);
});

test('shield absorbs first, clicks never go negative, regen cannot exceed the peak', () => {
  const e = mk();
  e.teams.left.clicks = 100;
  e.teams.left.shield = e.teams.left.peak = 50;
  e.players.get('b1')!.drain = 10; // 10 per second from the right team
  e.advance(3 * S); // 30 damage: all soaked
  assert.equal(Math.round(e.teams.left.shield), 20);
  assert.equal(Math.round(e.teams.left.clicks), 100);
  e.advance(10 * S); // 70 more: 20 shield + 50 clicks
  assert.equal(Math.round(e.teams.left.shield), 0);
  assert.equal(Math.round(e.teams.left.clicks), 50);
  e.advance(100 * S);
  assert.equal(e.teams.left.clicks, 0, 'floored at zero');
  // regen before any shield has ever existed does nothing
  const f = mk();
  f.players.get('a1')!.regen = 100;
  f.advance(60 * S);
  assert.equal(f.teams.left.shield, 0);
  // and it stops at the all-time peak
  f.teams.left.shield = f.teams.left.peak = 100;
  f.teams.left.shield = 10;
  f.advance(120 * S);
  assert.equal(f.teams.left.shield, 100);
});

test('the shop rotates round-robin and the 10 second hold is enforced', () => {
  const e = mk();
  const T = CONFIG.shopHoldMs;
  assert.equal(e.teams.left.holder, null);
  e.update(CONFIG.firstShopDelayMs);
  assert.equal(e.teams.left.holder, 'a1');
  assert.equal(e.teams.right.holder, 'b1');
  const t0 = CONFIG.firstShopDelayMs;
  // closes early: next player must wait for the hold to run out
  e.closeShop('a1', t0 + 2 * S);
  assert.equal(e.teams.left.holder, null);
  e.update(t0 + T - 1);
  assert.equal(e.teams.left.holder, null, 'still waiting');
  e.update(t0 + T);
  assert.equal(e.teams.left.holder, 'a2', 'round robin moved on');
  // holds past the timer: the next player is offered the shop the instant it closes
  e.update(t0 + T + 30 * S);
  assert.equal(e.teams.left.holder, 'a2');
  e.closeShop('a2', t0 + T + 30 * S);
  assert.equal(e.teams.left.holder, 'a1', 'immediate hand-off');
  // the single-player team gets itself again
  e.closeShop('b1', t0 + 30 * S);
  assert.equal(e.teams.right.holder, 'b1');
});

test('the shop budget is a snapshot: later earnings are not spendable', () => {
  const e = mk();
  e.teams.left.clicks = 100;
  e.update(CONFIG.firstShopDelayMs);
  const t = e.teams.left;
  assert.equal(t.offer!.budget, 100);
  t.clicks += 100000; // earned while shopping
  const pricey = find((i) => i.tier === 1 && i.cost > 100 && i.cost < 400);
  t.offer = { ids: [pricey.id], budget: t.offer!.budget };
  const r = e.buy('a1', pricey.id, CONFIG.firstShopDelayMs + S);
  assert.ok(!r.ok, 'cannot spend what you did not have at open');
});

test('buying spends clicks and closes the shop', () => {
  const e = mk();
  e.teams.left.clicks = 1000;
  e.update(CONFIG.firstShopDelayMs);
  const auto = find((i) => i.eff.k === 'auto' && i.cost === 200);
  const r = give(e, 'a1', auto.id, CONFIG.firstShopDelayMs + S);
  assert.ok(r.ok);
  assert.equal(Math.floor(e.teams.left.clicks), 800);
  assert.equal(e.players.get('a1')!.autos.length, 1);
  assert.equal(e.teams.left.holder, null);
});

test('remove clicks / siege / delete auto / decoy', () => {
  const e = mk();
  e.teams.left.clicks = 100000;
  e.teams.right.clicks = 5000;
  e.teams.right.shield = e.teams.right.peak = 300;
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'remove' && (i.eff as any).n === 1000), 1 * S).ok);
  assert.equal(Math.floor(e.teams.right.shield), 0);
  assert.equal(Math.floor(e.teams.right.clicks), 4300);
  // siege only touches shields
  e.teams.right.shield = e.teams.right.peak = 500;
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'siege' && (i.eff as any).hp === 100), 2 * S).ok);
  assert.equal(e.teams.right.shield, 400);
  assert.equal(Math.floor(e.teams.right.clicks), 4300);
  // delete auto: refused with no target, works with one, decoy absorbs
  const del = id((i) => i.eff.k === 'deleteAuto' && i.tier === 1);
  assert.ok(!give(e, 'a1', del, 3 * S).ok);
  e.players.get('b1')!.autos.push({ tier: 1, rate: 1 });
  e.teams.right.decoys.push(1);
  assert.ok(give(e, 'a1', del, 4 * S).ok);
  assert.equal(e.players.get('b1')!.autos.length, 1, 'decoy took it');
  assert.equal(e.teams.right.decoys.length, 0);
  assert.ok(give(e, 'a1', del, 5 * S).ok);
  assert.equal(e.players.get('b1')!.autos.length, 0);
  // a tier 1 decoy does not stop a tier 2 delete
  e.players.get('b1')!.autos.push({ tier: 2, rate: 8 });
  e.teams.right.decoys.push(1);
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'deleteAuto' && i.tier === 2), 6 * S).ok);
  assert.equal(e.players.get('b1')!.autos.length, 0);
});

test('bulk discount applies once, to anybody on the team', () => {
  const e = mk();
  e.teams.left.clicks = 100000;
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'discount' && (i.eff as any).pct === 20), 1 * S).ok);
  const before = e.teams.left.clicks;
  const item = find((i) => i.eff.k === 'shield' && i.cost === 1000 && i.tier === 2);
  assert.ok(give(e, 'a2', item.id, 2 * S).ok);
  assert.equal(Math.round(before - e.teams.left.clicks), 800);
  const b2 = e.teams.left.clicks;
  assert.ok(give(e, 'a2', item.id, 3 * S).ok);
  assert.equal(Math.round(b2 - e.teams.left.clicks), 1000, 'discount was used up');
});

test('sales tax costs the victim and pays the taxer', () => {
  const e = mk();
  e.teams.left.clicks = 1000;
  e.teams.right.clicks = 1000;
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'tax' && i.tier === 1), 1 * S).ok); // 20%
  const lBefore = e.teams.left.clicks;
  const shield = find((i) => i.eff.k === 'shield' && i.cost === 10);
  assert.ok(give(e, 'b1', shield.id, 2 * S).ok);
  assert.equal(Math.round(e.teams.right.clicks), 1000 - 12);
  assert.equal(Math.round(e.teams.left.clicks - lBefore), 2, 'tax collected');
  assert.ok(give(e, 'b1', shield.id, 3 * S).ok);
  assert.equal(Math.round(e.teams.right.clicks), 1000 - 12 - 10, 'only the next purchase is taxed');
});

test('invest pays out after 30 seconds, lazily', () => {
  const e = mk();
  e.teams.left.clicks = 100;
  assert.ok(give(e, 'a1', id((i) => i.eff.k === 'invest' && i.cost === 100), 1 * S).ok);
  assert.equal(Math.floor(e.teams.left.clicks), 0);
  e.advance(30 * S);
  assert.equal(Math.floor(e.teams.left.clicks), 0, 'not yet');
  e.advance(31 * S);
  assert.equal(Math.floor(e.teams.left.clicks), 250);
});

test('siphon steals through clicks, not shields, and stacks', () => {
  const e = mk();
  e.teams.right.clicks = 100;
  e.players.get('a1')!.siphon = 2;
  e.clicks('a1', 10, 1 * S);
  assert.equal(Math.round(e.teams.left.clicks), 10 + 20);
  assert.equal(Math.round(e.teams.right.clicks), 80);
  e.teams.right.shield = e.teams.right.peak = 1000;
  e.clicks('a1', 10, 2 * S);
  assert.equal(Math.round(e.teams.left.clicks), 10 + 20 + 10, 'shield blocked the siphon');
  const e2 = mk();
  e2.teams.left.clicks = 1e6;
  assert.ok(give(e2, 'a1', id((i) => i.eff.k === 'siphon' && (i.eff as any).n === 1), 1 * S).ok);
  e2.teams.left.clicks = 1e6;
  assert.ok(give(e2, 'a1', id((i) => i.eff.k === 'siphon' && (i.eff as any).n === 1), 2 * S).ok);
  assert.equal(e2.players.get('a1')!.siphon, 2);
});

test('insurance refunds a share of losses; rust cuts auto income; sabotage delays the shop', () => {
  const e = mk();
  e.teams.left.clicks = 1000;
  e.teams.left.insurance.push({ v: 0.5, from: 0, until: 60 * S });
  e.advance(1 * S);
  e.teams.right.clicks = 1e6;
  assert.ok(give(e, 'b1', id((i) => i.eff.k === 'remove' && (i.eff as any).n === 100), 2 * S).ok);
  assert.equal(Math.round(e.teams.left.clicks), 1000 - 100 + 50);
  const r = mk();
  r.players.get('a1')!.autos.push({ tier: 1, rate: 10 });
  r.teams.left.rust.push({ v: 0.5, from: 0, until: 10 * S });
  r.advance(20 * S); // 10s at half, 10s at full
  assert.equal(Math.round(r.teams.left.clicks), 150);
  const s = mk();
  s.update(CONFIG.firstShopDelayMs); // both teams have the shop open
  s.teams.right.clicks = 1e6;
  s.teams.left.clicks = 1e6;
  const sab = id((i) => i.eff.k === 'sabotage' && (i.eff as any).sec === 5);
  const t0 = CONFIG.firstShopDelayMs;
  assert.ok(give(s, 'a1', sab, t0 + S).ok); // right is mid-shop: delay is queued
  s.closeShop('b1', t0 + 20 * S);
  assert.equal(s.teams.right.nextOfferAt, Math.max(t0 + 20 * S, s.teams.right.holderTimerEnd) + 5 * S);
});

test('the game ends and picks a winner by clicks', () => {
  const e = mk();
  e.teams.left.clicks = 10;
  e.teams.right.clicks = 20;
  e.update(600 * S);
  assert.ok(e.finished);
  assert.equal(e.winner, 'right');
  assert.equal(e.nextWake(), null);
});

console.log(`${n} engine tests passed`);

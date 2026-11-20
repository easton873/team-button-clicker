// Plays a short game with bots over real sockets against a real server (timings scaled down).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import type { ClientState, ClientToServerEvents, ServerToClientEvents } from '../shared/types.js';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const PORT = 3218;
const server = spawn('npx', ['tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), TIMING_SCALE: '0.05' }, stdio: 'ignore', detached: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = (): S => io(`http://localhost:${PORT}`, { transports: ['websocket'] });
const emit = <T = any>(s: S, ev: string, ...args: any[]): Promise<T> => new Promise((res) => (s as any).emit(ev, ...args, res));

async function main() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) break;
    } catch {
      await sleep(200);
    }
  }
  const host = connect();
  const created = await emit(host, 'host:create');
  let hostState!: ClientState;
  let hostUpdates = 0;
  host.on('state', (s) => {
    hostState = s;
    hostUpdates++;
  });

  const bots: Record<string, { s: S; id: string; st?: ClientState }> = {};
  for (const name of ['Ann', 'Bo', 'Cy']) {
    const s = connect();
    const r = await emit(s, 'player:join', { code: created.code, name });
    assert.ok(r.ok);
    bots[name] = { s, id: r.playerId };
    s.on('state', (st) => (bots[name].st = st));
  }
  await sleep(100);
  assert.ok((await emit(bots.Ann.s, 'player:join', { code: created.code, name: 'ann' })).ok === false, 'duplicate name refused');

  // can't start with everyone on one side
  assert.ok((await emit(bots.Ann.s, 'player:setSide', { side: 'left' })).ok);
  assert.ok((await emit(bots.Bo.s, 'player:setSide', { side: 'left' })).ok);
  assert.ok((await emit(bots.Cy.s, 'player:setSide', { side: 'left' })).ok);
  host.emit('host:settings', { durationMin: 3 });
  host.emit('host:start');
  await sleep(100);
  assert.equal(hostState.phase, 'lobby', 'refused: right team is empty');
  // swap freely in the lobby
  assert.ok((await emit(bots.Cy.s, 'player:setSide', { side: 'right' })).ok);
  assert.ok((await emit(bots.Cy.s, 'player:setSide', { side: 'left' })).ok);
  assert.ok((await emit(bots.Cy.s, 'player:setSide', { side: 'right' })).ok);
  await sleep(50);
  assert.equal(hostState.players.find((p) => p.name === 'Cy')!.side, 'right');

  host.emit('host:start');
  await sleep(40);
  assert.equal(hostState.phase, 'countdown');
  assert.ok(hostState.countdownEndsAt);
  const locked = await emit(bots.Ann.s, 'player:setSide', { side: 'right' });
  assert.ok(!locked.ok, 'teams are locked during the countdown');
  const late = connect();
  assert.ok(!(await emit(late, 'player:join', { code: created.code, name: 'Late' })).ok, 'no joining mid-game');
  await sleep(250);
  assert.equal(hostState.phase, 'play');
  assert.ok(bots.Ann.st!.you!.side === 'left' && bots.Cy.st!.you!.side === 'right');

  // clicking does not broadcast every time
  const before = hostUpdates;
  for (let i = 0; i < 20; i++) {
    bots.Ann.s.emit('player:clicks', { n: 5 });
    bots.Cy.s.emit('player:clicks', { n: 3 });
    await sleep(5);
  }
  assert.ok(hostUpdates - before < 10, `clicks must not each trigger a broadcast (saw ${hostUpdates - before})`);
  // the early scoreboard beat gets the totals out
  await sleep(250);
  assert.ok(hostState.board!.left.clicks >= 90, `left total reaches the screen (${hostState.board!.left.clicks})`);
  assert.ok(hostState.board!.right.clicks >= 50);

  // the first shop opens for each team, one player at a time, and only the holder sees it
  for (let i = 0; i < 60 && !bots.Ann.st!.you!.shop; i++) await sleep(50);
  const ann = bots.Ann.st!.you!;
  assert.ok(ann.shop, 'Ann is offered the shop first');
  assert.ok(!bots.Bo.st!.you!.shop, 'Bo is not');
  assert.equal(ann.shop!.items.length, 3);
  assert.ok(ann.shop!.budget > 0);
  const item = ann.shop!.items.find((i) => i.price <= ann.shop!.budget);
  if (item) {
    const r = await emit(bots.Ann.s, 'player:buy', { itemId: item.id });
    assert.ok(r.ok, JSON.stringify(r));
  } else {
    assert.ok((await emit(bots.Ann.s, 'player:closeShop')).ok);
  }
  await sleep(100);
  assert.ok(!bots.Ann.st!.you!.shop, 'shop closed after buying/closing');
  assert.ok(!(await emit(bots.Bo.s, 'player:buy', { itemId: 'x' })).ok);

  // wait for the end (3 minutes * 0.05 = 9s, started a moment ago)
  for (let i = 0; i < 200 && hostState.phase !== 'gameOver'; i++) await sleep(100);
  assert.equal(hostState.phase, 'gameOver');
  assert.ok(hostState.result);
  console.log('result:', hostState.result, `(${hostUpdates} host updates)`);
  host.emit('host:backToLobby');
  await sleep(100);
  assert.equal(hostState.phase, 'lobby');
  console.log('simulation passed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    try {
      process.kill(-server.pid!);
    } catch {
      /* gone */
    }
  });

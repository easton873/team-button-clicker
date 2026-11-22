import './theme.css';
import './play.css';
import { MAX_PLAYER_NAME_LENGTH, type ClientState, type ShopItemView, type Side } from '../../shared/types';
import { $, briefcaseHTML, esc, gearHTML, mmss, num, project, rate, serverTime, SIDE_LABEL, SIDE_COLOR, socket, syncClock, teamIconHTML } from './common';

const app = $('#app')!;
const STORE = 'teambuttonclicker.player';

let state: ClientState | null = null;
let me: { code: string; token: string; name: string; id: string } | null = null;
let joinError = '';
let viewKey = '';
let closedMsg = '';
let draftName = '';
let shopSig = '';
let shopBusy = false;

// click bookkeeping
let myTotal = 0; // cumulative presses this game; only ever sent when the server asks for it

const params = new URLSearchParams(location.search);

function loadStored(): { code: string; token: string; name: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}
const saveStored = (v: unknown) => {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: rejoin just won't survive a refresh */
  }
};

// ------------------------------------------------------------------ never zoom, never select, never long-press

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
let lastTouchEnd = 0;
document.addEventListener(
  'touchend',
  (e) => {
    const now = Date.now();
    if (now - lastTouchEnd < 400 && (e.target as HTMLElement).closest('.clickzone')) e.preventDefault(); // the double-tap-to-zoom gesture (everything else is covered by touch-action: manipulation)
    lastTouchEnd = now;
  },
  { passive: false },
);
document.addEventListener('dblclick', (e) => !(e.target as HTMLElement).closest('input') && e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ joining

function join(code: string, name: string, token?: string) {
  socket.emit('player:join', { code, name, token }, (res) => {
    if (res.ok) {
      me = { code: code.toUpperCase(), name, token: res.token, id: res.playerId };
      saveStored({ code: me.code, token: me.token, name });
      joinError = '';
      closedMsg = '';
    } else {
      joinError = res.error;
      if (token) saveStored(null);
      me = null;
    }
    viewKey = '';
    render();
  });
}

socket.on('connect', () => {
  document.querySelector('.conn')?.remove();
  const stored = loadStored();
  const want = (params.get('room') || '').toUpperCase();
  if (me) join(me.code, me.name, me.token);
  else if (stored && (!want || want === stored.code)) join(stored.code, stored.name, stored.token);
  else render();
});
socket.on('disconnect', () => {
  if (!document.querySelector('.conn')) document.body.insertAdjacentHTML('beforeend', '<div class="conn">Reconnecting…</div>');
});
socket.on('closed', (reason) => {
  closedMsg = reason;
  me = null;
  state = null;
  saveStored(null);
  viewKey = '';
  render();
});
// The server asks for our click count only when it's about to work out the totals. We never push it.
socket.on('collect', (cb) => cb(myTotal));
socket.on('state', (s) => {
  state = s;
  syncClock(s.serverNow);
  render();
});

// ------------------------------------------------------------------ views

const sideBanner = (side: Side | null) =>
  side ? `<div class="banner ${side}">${teamIconHTML(side)}<div><small>You're on the</small><b>${SIDE_LABEL[side]}</b></div></div>` : '';

function joinView(): string {
  const want = (params.get('room') || '').toUpperCase();
  return `<main class="pad center">
    <div class="titleblock">${gearHTML('', 12)}<h1 class="display">Team Button Clicker</h1></div>
    ${closedMsg ? `<div class="error">${esc(closedMsg)}</div>` : ''}
    <form id="joinForm" class="form">
      <label>Room code<input id="code" maxlength="4" value="${esc(want)}" autocapitalize="characters" autocomplete="off" /></label>
      <label>Your name<input id="pname" maxlength="${MAX_PLAYER_NAME_LENGTH}" value="${esc(draftName)}" autocomplete="off" /></label>
      <div class="error" id="joinErr">${esc(joinError)}</div>
      <button class="btn big" type="submit">Join Game</button>
    </form>
  </main>`;
}

function lobbyView(): string {
  return `<main class="pad lobbyv">
    <h2>Pick your team</h2>
    <p class="note">You can swap until the host starts the game.</p>
    <div class="teampick">
      ${(['left', 'right'] as Side[])
        .map(
          (side) => `<button class="pick ${side}" data-side="${side}">${teamIconHTML(side)}<b>${SIDE_LABEL[side]}</b><span class="roster" data-roster="${side}"></span><i class="here">✓ You're here</i></button>`,
        )
        .join('')}
    </div>
    <p class="note" data-waitmsg></p>
  </main>`;
}

function lobbyLive(s: ClientState) {
  const mine = s.players.find((p) => p.id === me?.id)?.side ?? null;
  for (const side of ['left', 'right'] as Side[]) {
    const btn = $(`.pick.${side}`)!;
    btn.classList.toggle('chosen', mine === side);
    $(`[data-roster="${side}"]`)!.textContent = s.players.filter((p) => p.side === side).map((p) => p.name).join(' · ') || 'Nobody yet';
  }
  $('[data-waitmsg]')!.textContent = mine ? "Waiting for the host to start…" : 'Tap a team to join it.';
}

const countdownView = () => `<main class="pad center"><div data-banner></div><div class="eyebrow">Game starts in</div><div class="bignum" data-count>5</div><p class="note">Get your clicking finger ready.</p></main>`;

function playView(side: Side): string {
  return `<header class="hdr ${side}">${teamIconHTML(side)}<div class="who"><small>${SIDE_LABEL[side]}</small><b>${esc(me?.name ?? '')}</b></div><div class="clock" data-clock>0:00</div></header>
  <div class="scores">
    <div class="sc us ${side}"><small>Your team</small><b data-mine>0</b></div>
    <div class="sc them"><small>Other team</small><b data-foe>0</b></div>
  </div>
  <div class="perks" data-perks></div>
  <div class="clickzone">
    <button id="clicker" class="clicker ${side}" aria-label="Click"></button>
    <div class="cv"><b data-cv>+1</b> per click · <span data-my>0</span> by you</div>
  </div>
  <section class="shop" data-shop hidden></section>
  <footer class="status" data-status></footer>`;
}

function shopSignature(s: ClientState): string {
  const sh = s.you?.shop;
  return sh ? `${sh.budget}|${sh.items.map((i) => `${i.id}:${i.price}`).join(',')}` : '';
}

const CAT_TAG: Record<ShopItemView['category'], string> = { auto: 'AUTO', economic: 'ECON', aggressive: 'ATTACK', defensive: 'DEFENSE' };

const itemHTML = (it: ShopItemView, budget: number) => {
  const broke = it.price > budget;
  const hasMod = it.price !== it.cost;
  return `<div class="item ${it.rarity}">
    <div class="info"><div class="ih"><span class="tier">${CAT_TAG[it.category]}</span><b>${esc(it.name)}</b><em>${it.rarity}</em></div><p>${esc(it.desc)}</p></div>
    <button class="btn buy" data-buy="${it.id}" ${broke ? 'disabled' : ''}><span>BUY</span>${hasMod ? `<s>${num(it.cost)}</s>` : ''}${num(it.price)}${it.tax ? `<small>incl. ${num(it.tax)} tax</small>` : ''}</button>
  </div>`;
};

function renderShop(s: ClientState) {
  const el = $('[data-shop]')!;
  const sh = s.you?.shop;
  const sig = shopSignature(s);
  if (!sh) {
    el.hidden = true;
    $('#clicker')?.classList.remove('locked');
    shopSig = '';
    return;
  }
  el.hidden = false;
  $('#clicker')?.classList.add('locked');
  if (sig === shopSig) return;
  shopSig = sig;
  shopBusy = false;
  el.innerHTML = `<div class="sheet plate"><div class="sh-h">${briefcaseHTML()}<div><h3>Shop</h3><small>Budget locked at <b>${num(sh.budget)}</b> clicks</small></div><button class="btn steel close" data-close>Close</button></div>
    <div class="hold" data-hold></div><div class="error" data-shoperr></div>
    <div class="items">${sh.items.map((it) => itemHTML(it, sh.budget)).join('')}</div></div>`;
  $('.items', el)!.scrollTop = 0;
}

function playLive(s: ClientState) {
  const you = s.you;
  const side = you?.side;
  if (!you || !side || !s.board) return;
  const b = s.board;
  $('[data-cv]')!.textContent = `+${rate(you.clickValue)}`;
  $('[data-perks]')!.innerHTML = you.perks.map((p) => `<span class="perk">${esc(p)}</span>`).join('');
  renderShop(s);
  const t = b[side];
  const holder = s.players.find((p) => p.id === t.holderId);
  let status = '';
  if (!you.shop) {
    if (holder) status = `${briefcaseHTML()} <b>${esc(holder.name)}</b> is at the shop`;
    else if (t.nextOfferAt) status = `Shop opens in <b data-opens="${t.nextOfferAt}">…</b>`;
    if (you.queuePos !== null && (holder || t.nextOfferAt)) status += ` · ${you.queuePos === 0 ? "<b>you're up next!</b>" : `${you.queuePos} ahead of you`}`;
  } else status = 'Keep clicking while you shop!';
  $('[data-status]')!.innerHTML = status;
  localTick();
}

function overView(s: ClientState): string {
  const r = s.result;
  const mine = s.players.find((p) => p.id === me?.id)?.side;
  const won = r && r.winner !== 'tie' && r.winner === mine;
  const title = !r ? '' : r.winner === 'tie' ? 'A tie!' : won ? 'You won!' : 'You lost.';
  return `<main class="pad center"><div class="titleblock">${gearHTML('', 12)}</div><h2 class="big">${title}</h2>
    <div class="finalrow"><div class="sc left"><small>Left</small><b>${num(r?.left ?? 0)}</b></div><div class="sc right"><small>Right</small><b>${num(r?.right ?? 0)}</b></div></div>
    <p class="note">You clicked ${num(myTotal)} times. Waiting for the host…</p></main>`;
}

// ------------------------------------------------------------------ the button

function wireClicker() {
  const btn = $<HTMLButtonElement>('#clicker')!;
  let lastPop = 0;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state?.you?.shop) return; // no clicking while the shop is open
    myTotal++;
    btn.classList.add('down');
    const now = performance.now();
    if (now - lastPop > 70) {
      lastPop = now;
      const pop = document.createElement('span');
      pop.className = 'pop';
      pop.textContent = `+${rate(state?.you?.clickValue ?? 1)}`;
      const r = btn.getBoundingClientRect();
      pop.style.left = `${e.clientX - r.left + (Math.random() * 30 - 15)}px`;
      pop.style.top = `${e.clientY - r.top - 20}px`;
      btn.appendChild(pop);
      setTimeout(() => pop.remove(), 600);
    }
    $('[data-my]')!.textContent = num(myTotal);
  });
  const up = () => btn.classList.remove('down');
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('pointerleave', up);
  // belt and braces against the browser's own tap handling (zoom, text selection, callouts)
  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  btn.addEventListener('click', (e) => e.preventDefault());
}

// ------------------------------------------------------------------ render

function render() {
  const s = state;
  let key: string;
  let html = '';
  if (!me || !s) {
    key = 'join';
    html = joinView();
  } else if (s.phase === 'lobby') {
    key = 'lobby';
    html = lobbyView();
  } else if (s.phase === 'countdown') {
    key = 'countdown';
    html = countdownView();
  } else if (s.phase === 'play') {
    const side = s.you?.side;
    key = `play-${side}`;
    if (side) html = playView(side);
  } else {
    key = 'over';
    html = overView(s);
  }
  if (key !== viewKey) {
    viewKey = key;
    app.innerHTML = html;
    shopSig = '';
    if (key === 'join') {
      $('#joinForm')!.addEventListener('submit', (e) => {
        e.preventDefault();
        const code = ($('#code') as HTMLInputElement).value.trim().toUpperCase();
        const name = ($('#pname') as HTMLInputElement).value.trim();
        draftName = name;
        if (!code || !name) {
          $('#joinErr')!.textContent = 'Enter the room code and your name.';
          return;
        }
        join(code, name);
      });
    }
    if (key.startsWith('play-')) {
      wireClicker();
      myTotal = 0;
    }
    if (key === 'countdown') {
      const side = s?.players.find((p) => p.id === me?.id)?.side ?? null;
      $('[data-banner]')!.innerHTML = sideBanner(side);
    }
  }
  if (!s || !me) return;
  if (s.phase === 'lobby') lobbyLive(s);
  if (s.phase === 'play') playLive(s);
  localTick();
}

/** Countdowns that run on the phone's own clock between server updates. */
function localTick() {
  const s = state;
  if (!s) return;
  const side = s.you?.side;
  if (s.board && side && s.phase === 'play' && $('[data-mine]')) {
    $('[data-mine]')!.textContent = num(project(s.board[side], s.board.at, s.target).clicks);
    $('[data-foe]')!.textContent = num(project(s.board[side === 'left' ? 'right' : 'left'], s.board.at, s.target).clicks);
  }
  const count = $('[data-count]');
  if (count && s.countdownEndsAt) count.textContent = String(Math.max(0, Math.ceil((s.countdownEndsAt - serverTime()) / 1000)));
  const clock = $('[data-clock]');
  if (clock && s.endsAt) clock.textContent = mmss(s.endsAt - serverTime());
  else if (clock && s.target) {
    clock.textContent = `Goal ${num(s.target)}`;
    clock.classList.add('goalmode');
  }
  const hold = $('[data-hold]');
  const sh = s.you?.shop;
  if (hold && sh) {
    const left = Math.ceil((sh.minUntil - serverTime()) / 1000);
    hold.innerHTML = left > 0 ? `Closing now keeps your team waiting <b>${left}s</b> for the next shop.` : 'Timer is up: closing hands the shop straight to your next teammate.';
  }
  document.querySelectorAll<HTMLElement>('[data-opens]').forEach((el) => {
    el.textContent = `${Math.max(0, Math.ceil((Number(el.dataset.opens) - serverTime()) / 1000))}s`;
  });
}
setInterval(localTick, 250);

// ------------------------------------------------------------------ events

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>('[data-side]');
  if (pick && state?.phase === 'lobby') socket.emit('player:setSide', { side: pick.dataset.side as Side });
  if (t.closest('[data-close]')) socket.emit('player:closeShop');
  const buy = t.closest<HTMLButtonElement>('[data-buy]');
  if (buy && !shopBusy) {
    shopBusy = true;
    socket.emit('player:buy', { itemId: buy.dataset.buy! }, (res) => {
      shopBusy = false;
      if (!res.ok) $('[data-shoperr]')!.textContent = res.error;
    });
  }
});

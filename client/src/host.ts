import QRCode from 'qrcode';
import './theme.css';
import './host.css';
import { DURATION_OPTIONS_MIN, SIDES, TARGET_OPTIONS, type ClientState, type Side, type TeamBoard } from '../../shared/types';
import { $, briefcaseHTML, esc, gearHTML, mmss, num, rate, SIDE_COLOR, SIDE_LABEL, serverTime, socket, syncClock, tieHTML, tweenNumber } from './common';

const STORE = 'gearsandties.host';
const stage = $('#stage')!;

let state: ClientState | null = null;
let viewKey = '';
let roomCode = '';
let joinBase = location.origin;
let qrDataUrl = '';

// ------------------------------------------------------------------ connection

function load(): { code: string; hostToken: string } | null {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}
function createRoom() {
  socket.emit('host:create', (res) => {
    if (!res.ok) return;
    roomCode = res.code;
    try {
      localStorage.setItem(STORE, JSON.stringify({ code: res.code, hostToken: res.hostToken }));
    } catch {
      /* ignore */
    }
    prepareJoinInfo();
  });
}
socket.on('connect', () => {
  $('#conn')!.hidden = true;
  const saved = load();
  if (saved) {
    socket.emit('host:resume', saved, (res) => {
      if (res.ok) {
        roomCode = saved.code;
        prepareJoinInfo();
      } else createRoom();
    });
  } else createRoom();
});
socket.on('disconnect', () => ($('#conn')!.hidden = false));
socket.on('state', (s) => {
  state = s;
  syncClock(s.serverNow);
  render();
});
socket.on('closed', () => {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
  location.reload();
});

async function prepareJoinInfo() {
  const { hostname, port, protocol, origin } = location;
  joinBase = origin;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    try {
      const { ips } = (await (await fetch('/api/info')).json()) as { ips: string[] };
      if (ips[0]) joinBase = `${protocol}//${ips[0]}${port ? ':' + port : ''}`;
    } catch {
      /* fall back to origin */
    }
  }
  qrDataUrl = await QRCode.toDataURL(`${joinBase}/play.html?room=${roomCode}`, { margin: 1, width: 520, color: { dark: '#14171c', light: '#ffffff' } });
  viewKey = '';
  render();
}

// ------------------------------------------------------------------ views

const sideName = (s: Side) => SIDE_LABEL[s].toUpperCase();

function lobbyView(s: ClientState): string {
  const col = (side: Side) => `<div class="team plate ${side}"><div class="team-h">${tieHTML(SIDE_COLOR[side])}<h2>${sideName(side)}</h2></div><div class="members" data-members="${side}"></div></div>`;
  return `<section class="lobby">
    <div class="lobby-left">
      <div class="logo"><div class="gears">${gearHTML('', 12, 'currentColor')}${gearHTML('rev', 8, 'currentColor')}</div><h1 class="display">Gears<br />&amp; Ties</h1></div>
      <div class="join-card plate">
        ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR code to join" />` : '<div class="qr"></div>'}
        <div class="t">Scan the code or go to<br /><b>${esc(joinBase.replace(/^https?:\/\//, ''))}</b><br />and enter room code<div class="roomcode">${esc(s.code)}</div></div>
      </div>
    </div>
    <div class="lobby-right">
      <div class="teams">${col('left')}${col('right')}</div>
      <div class="pending" data-pending></div>
      <div class="opts plate">
        <label>How to win <select id="mode"><option value="time">Most clicks when time runs out</option><option value="target">First team to a target</option></select></label>
        <label data-for="time">Shift length <select id="dur">${DURATION_OPTIONS_MIN.map((m) => `<option value="${m}">${m} minutes</option>`).join('')}</select></label>
        <label data-for="target">Target <select id="target">${TARGET_OPTIONS.map((n) => `<option value="${n}">${num(n)} clicks</option>`).join('')}</select></label>
        <label class="chk"><input type="checkbox" id="fallback" /> Refresh the scoreboard every 5s <small>(otherwise only when the shop opens or something is bought)</small></label>
      </div>
      <button class="btn startbtn" id="start" disabled>Start game</button>
    </div>
  </section>`;
}

function lobbyLive(s: ClientState) {
  const live = (side: Side) => s.players.filter((p) => p.side === side);
  for (const side of SIDES) {
    const box = $(`[data-members="${side}"]`)!;
    const list = live(side);
    const html = list.length
      ? list.map((p) => `<div class="member ${p.connected ? '' : 'off'}">${esc(p.name)}<button class="x" data-kick="${p.id}" title="Remove">✕</button></div>`).join('')
      : '<div class="empty">Nobody yet</div>';
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  const none = s.players.filter((p) => !p.side);
  $('[data-pending]')!.innerHTML = none.length ? `Still picking a team: ${none.map((p) => esc(p.name)).join(', ')}` : '';
  ($('#mode') as HTMLSelectElement).value = s.settings.mode;
  ($('#dur') as HTMLSelectElement).value = String(s.settings.durationMin);
  ($('#target') as HTMLSelectElement).value = String(s.settings.targetClicks);
  $('[data-for="time"]')!.hidden = s.settings.mode !== 'time';
  $('[data-for="target"]')!.hidden = s.settings.mode !== 'target';
  ($('#fallback') as HTMLInputElement).checked = s.settings.fallbackRefresh;
  const l = s.players.filter((p) => p.connected && p.side !== 'right').length;
  const r = s.players.filter((p) => p.connected && p.side !== 'left').length;
  const ok = s.players.filter((p) => p.connected).length >= 2 && l > 0 && r > 0;
  const start = $<HTMLButtonElement>('#start')!;
  start.disabled = !ok;
  start.textContent = ok ? 'Start the shift' : 'Need players on both teams';
}

const countdownView = () => `<section class="center"><div class="eyebrow">Shift starts in</div><div class="bignum" data-count>5</div><div class="sub">Teams are locked. Find your button.</div></section>`;

function teamPanel(side: Side): string {
  return `<div class="panel plate ${side}" data-side="${side}">
    <div class="ph">${tieHTML(SIDE_COLOR[side])}<h2>${sideName(side)}</h2></div>
    <div class="clicks"><span data-clicks>0</span></div><div class="lbl">CLICKS</div>
    <div class="prog" data-prog hidden><i></i></div>
    <div class="shield"><div class="bar"><i data-sfill></i><b data-speak></b></div><div class="sh-txt">SHIELD <span data-shield>0</span> <small>/ <span data-peak>0</span> peak</small></div></div>
    <div class="stats">
      <div><b data-auto>0</b><small>auto /s</small></div><div><b data-regen>0</b><small>regen /s</small></div>
      <div><b data-drain>0</b><small>drain /s</small></div><div><b data-pc>1</b><small>per click</small></div>
    </div>
    <div class="fx" data-fx></div>
    <div class="roster" data-roster></div>
    <div class="shopline" data-shopline></div>
  </div>`;
}

const playView = () => `<section class="arena">
  ${teamPanel('left')}
  <div class="mid"><div class="gears">${gearHTML('', 16)}${gearHTML('rev', 10)}</div><div class="clock" data-clock>0:00</div><div class="goal" data-goal hidden>First to<b></b></div><div class="vs display">vs</div></div>
  ${teamPanel('right')}
  <div class="feed plate" data-feed></div>
</section>`;

function playLive(s: ClientState) {
  const b = s.board;
  if (!b) return;
  for (const side of SIDES) {
    const t: TeamBoard = b[side];
    const el = $(`.panel[data-side="${side}"]`)!;
    tweenNumber($('[data-clicks]', el)!, t.clicks, 1200);
    const prog = $('[data-prog]', el)!;
    prog.hidden = !s.target;
    if (s.target) ($('i', prog) as HTMLElement).style.width = `${Math.min(100, (t.clicks / s.target) * 100)}%`;
    tweenNumber($('[data-shield]', el)!, t.shield, 900);
    $('[data-peak]', el)!.textContent = num(t.shieldPeak);
    ($('[data-sfill]', el) as HTMLElement).style.width = t.shieldPeak ? `${Math.min(100, (t.shield / t.shieldPeak) * 100)}%` : '0%';
    $('[data-auto]', el)!.textContent = rate(t.auto);
    $('[data-regen]', el)!.textContent = rate(t.regen);
    $('[data-drain]', el)!.textContent = rate(t.drain);
    $('[data-pc]', el)!.textContent = rate(t.perClick);
    $('[data-fx]', el)!.innerHTML = t.effects.map((f) => `<span class="badge" data-until="${f.until}">${esc(f.label)} <i></i></span>`).join('');
    const members = s.players.filter((p) => p.side === side);
    $('[data-roster]', el)!.innerHTML = members
      .map((p) => `<span class="chip ${p.connected ? '' : 'off'} ${p.id === t.holderId ? 'shopping' : ''}">${p.id === t.holderId ? briefcaseHTML() : ''}${esc(p.name)}</span>`)
      .join('');
    const holder = members.find((p) => p.id === t.holderId);
    $('[data-shopline]', el)!.innerHTML = holder
      ? `${briefcaseHTML()} <b>${esc(holder.name)}</b> is at the procurement desk`
      : t.nextOfferAt
        ? `Next shop opens in <b data-opens="${t.nextOfferAt}">…</b>`
        : '';
  }
  const feed = $('[data-feed]')!;
  const html = s.feed
    .slice(-6)
    .map((f) => `<div class="fe ${f.side ?? ''}">${f.side ? '<i></i>' : ''}${esc(f.text)}</div>`)
    .join('');
  if (feed.innerHTML !== html) {
    feed.innerHTML = html;
    feed.scrollTop = feed.scrollHeight;
  }
}

function overView(s: ClientState): string {
  const r = s.result;
  const w = r?.winner ?? 'tie';
  const title = w === 'tie' ? "It's a tie!" : `${sideName(w)} wins!`;
  const color = w === 'tie' ? 'var(--brass)' : SIDE_COLOR[w];
  return `<section class="center over">
    <div class="eyebrow">${s.target ? 'Target reached' : 'Shift over'}</div>
    <h1 class="display" style="color:${color}">${title}</h1>
    <div class="final">
      <div class="plate left ${w === 'left' ? 'win' : ''}"><small>LEFT TEAM</small><b>${num(r?.left ?? 0)}</b></div>
      <div class="plate right ${w === 'right' ? 'win' : ''}"><small>RIGHT TEAM</small><b>${num(r?.right ?? 0)}</b></div>
    </div>
    <button class="btn" id="again">Back to the lobby</button>
  </section>`;
}

// ------------------------------------------------------------------ render

function render() {
  const s = state;
  $('#hudCode')!.innerHTML = s ? `ROOM <b>${esc(s.code)}</b>` : '';
  if (!s) return;
  const key = `${s.phase}${s.phase === 'lobby' ? qrDataUrl.length : ''}`;
  if (key !== viewKey) {
    viewKey = key;
    stage.innerHTML = s.phase === 'lobby' ? lobbyView(s) : s.phase === 'countdown' ? countdownView() : s.phase === 'play' ? playView() : overView(s);
  }
  if (s.phase === 'lobby') lobbyLive(s);
  else if (s.phase === 'play') playLive(s);
  else if (s.phase === 'gameOver') {
    // final numbers on the plates
  }
  localTick();
}

/** Things that count down on their own between server updates (no network involved). */
function localTick() {
  const s = state;
  if (!s) return;
  const count = $('[data-count]');
  if (count && s.countdownEndsAt) count.textContent = String(Math.max(0, Math.ceil((s.countdownEndsAt - serverTime()) / 1000)));
  const goal = $('[data-goal]');
  if (goal && s.target) {
    goal.hidden = false;
    $('b', goal)!.textContent = num(s.target);
    $('[data-clock]')!.hidden = true;
  }
  const clock = $('[data-clock]');
  if (clock && s.endsAt) {
    const left = s.endsAt - serverTime();
    clock.textContent = mmss(left);
    clock.classList.toggle('urgent', left < 30000);
  }
  document.querySelectorAll<HTMLElement>('[data-until]').forEach((el) => {
    const left = Math.ceil((Number(el.dataset.until) - serverTime()) / 1000);
    $('i', el)!.textContent = left > 0 ? `${left}s` : '';
  });
  document.querySelectorAll<HTMLElement>('[data-opens]').forEach((el) => {
    el.textContent = `${Math.max(0, Math.ceil((Number(el.dataset.opens) - serverTime()) / 1000))}s`;
  });
}
setInterval(localTick, 250);

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const kick = t.closest<HTMLElement>('[data-kick]');
  if (kick) socket.emit('host:kick', { playerId: kick.dataset.kick! });
  if (t.closest('#start')) socket.emit('host:start');
  if (t.closest('#again')) socket.emit('host:backToLobby');
});
document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'mode') socket.emit('host:settings', { mode: t.value as 'time' | 'target' });
  if (t.id === 'target') socket.emit('host:settings', { targetClicks: Number(t.value) });
  if (t.id === 'dur') socket.emit('host:settings', { durationMin: Number(t.value) });
  if (t.id === 'fallback') socket.emit('host:settings', { fallbackRefresh: t.checked });
});

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Side, TeamBoard } from '../../shared/types';

export const GAME_NAME = 'Team Button Clicker';
export const SIDE_LABEL: Record<Side, string> = { left: 'Left Team', right: 'Right Team' };
export const SIDE_COLOR: Record<Side, string> = { left: '#d7352f', right: '#2f6fd6' };

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ transports: ['websocket', 'polling'] });

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export const num = (n: number) => Math.round(n).toLocaleString('en-US');
/** Per-second rates: keep a decimal for small ones (0.1/s), none for big ones. */
export const rate = (n: number) => (n >= 100 ? num(n) : String(Math.round(n * 10) / 10));
export const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---- server clock: the server sends its own time with every state so timers line up ------------

let skew = 0;
export const syncClock = (serverNow: number) => (skew = serverNow - Date.now());
export const serverTime = () => Date.now() + skew;

// ---- art ---------------------------------------------------------------------------------------

/** A gear as an SVG path (evenodd, with a hole in the middle). */
function gearPath(teeth: number, ro = 48, ri = 38, hole = 13): string {
  const step = (Math.PI * 2) / teeth;
  const pt = (a: number, r: number) => `${(50 + Math.cos(a) * r).toFixed(1)} ${(50 + Math.sin(a) * r).toFixed(1)}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [pt(a - step * 0.31, ri), pt(a - step * 0.17, ro), pt(a + step * 0.17, ro), pt(a + step * 0.31, ri)];
    d += (i ? 'L' : 'M') + pts.join('L');
  }
  return `${d}Z M${50 + hole} 50a${hole} ${hole} 0 1 0 ${-hole * 2} 0a${hole} ${hole} 0 1 0 ${hole * 2} 0Z`;
}

export function gearHTML(cls = '', teeth = 12, fill = 'currentColor'): string {
  return `<svg class="gear ${cls}" viewBox="0 0 100 100" aria-hidden="true"><path fill="${fill}" fill-rule="evenodd" d="${gearPath(teeth)}"/></svg>`;
}

/** A necktie in the team colour. */
export function tieHTML(color: string, cls = ''): string {
  return `<svg class="tie ${cls}" viewBox="0 0 40 100" aria-hidden="true">
    <path d="M13 2h14l-3 15h-8z" fill="${color}" stroke="#0e1014" stroke-width="2" stroke-linejoin="round"/>
    <path d="M16 17h8l9 66-13 15-13-15z" fill="${color}" stroke="#0e1014" stroke-width="2" stroke-linejoin="round"/>
    <path d="M17 38l9 -3M15 52l14 -4M13 66l17 -4M13 80l14 -3" stroke="#fff" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

/** A team's icon: a gear for the left (red) team, a necktie for the right (blue) team. */
export const teamIconHTML = (side: Side): string =>
  side === 'left' ? gearHTML('teamicon', 12, SIDE_COLOR.left) : tieHTML(SIDE_COLOR[side]);

export const briefcaseHTML = (cls = '') =>
  `<svg class="case ${cls}" viewBox="0 0 40 32" aria-hidden="true"><path d="M14 8V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" fill="none" stroke="currentColor" stroke-width="3"/><rect x="2" y="8" width="36" height="21" rx="3" fill="currentColor"/><path d="M2 17h36" stroke="#14171c" stroke-width="2"/><rect x="17" y="15" width="6" height="5" rx="1" fill="#14171c"/></svg>`;

/**
 * What to show for a team right now: the last real numbers drifted forward by the server's trend. Nothing is
 * remembered or smoothed: the next real update just replaces it.
 */
export function project(t: TeamBoard, boardAt: number, target: number | null) {
  const dt = Math.max(0, serverTime() - boardAt) / 1000;
  let clicks = Math.max(0, t.clicks + t.clicksPerSec * dt);
  if (target) clicks = Math.min(clicks, target);
  const shield = Math.min(t.shieldPeak, Math.max(0, t.shield + t.shieldPerSec * dt));
  return { clicks: Math.floor(clicks), shield: Math.floor(shield) };
}

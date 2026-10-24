/**
 * fix208: which basketball / American-football game pages are open, and "this game's box score changed".
 *  - views: the web process notes a game when its page is requested or a socket sits in its room (index.ts sweeps the
 *    rooms every 60 s); the worker, which fetches the box scores, gets each game at most every 30 s over IPC. Kept in
 *    memory only (game id → last time), never who looked.
 *  - box updates: the worker sends one "box" message per game it stored; the web process pushes it to the game's room
 *    (index.ts: `bbBox` / `nflBox`), and open pages reload the box score. In one process (WORKER=0) both happen in place.
 */
import { isWeb, isWorker } from './role';
import { onIpc, sendIpc } from './ipc';
import { VIEW_WINDOW_MS } from '../utils/liveBox';

export type BoxSport = 'bb' | 'nfl';
const views: Record<BoxSport, Map<number, number>> = { bb: new Map(), nfl: new Map() };
const sentAt = new Map<string, number>();
const SEND_EVERY_MS = 30 * 1000;

function remember(sport: BoxSport, id: number, at: number) {
  const m = views[sport];
  m.delete(id);
  m.set(id, at);
  // oldest first: drop the ones outside the window (and never hold more than 2,000)
  for (const [k, v] of m) { if (at - v <= VIEW_WINDOW_MS && m.size <= 2000) break; m.delete(k); }
}

/** a page of this game is open (web process or one process) */
export function noteGameView(sport: BoxSport, id: number, now = Date.now()) {
  if (!Number.isInteger(id) || id <= 0) return;
  remember(sport, id, now);
  if (!isWeb) return;
  const key = `${sport}|${id}`;
  if (now - (sentAt.get(key) || 0) < SEND_EVERY_MS) return;
  if (sendIpc({ t: 'gameView', sport, id, at: now })) sentAt.set(key, now);
  if (sentAt.size > 4000) sentAt.clear();
}

/** game id → when a page of it was last open (only the last 5 minutes) */
export function gameViews(sport: BoxSport, now = Date.now()): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, at] of views[sport]) if (now - at <= VIEW_WINDOW_MS) out.set(id, at);
  return out;
}

if (isWorker) onIpc('gameView', m => {
  const sport = m.sport === 'nfl' ? 'nfl' : m.sport === 'bb' ? 'bb' : null;
  if (sport) remember(sport, Number(m.id), Number(m.at) || Date.now());
});

/* ---------- box-score updates ---------- */

type BoxListener = (sport: BoxSport, id: number, at: number) => void;
const listeners: BoxListener[] = [];
/** web (or one process): a game's live box score was stored */
export function onBox(fn: BoxListener) { listeners.push(fn); }
const emit = (sport: BoxSport, id: number, at: number) => { for (const fn of listeners) { try { fn(sport, id, at); } catch { /* a listener never stops the job */ } } };

/** worker (or one process): one message per stored game */
export function boxUpdated(sport: BoxSport, id: number, at = Date.now()) {
  if (isWorker) { sendIpc({ t: 'box', sport, id, at }); return; }
  emit(sport, id, at);
}

if (isWeb) onIpc('box', m => {
  const sport = m.sport === 'nfl' ? 'nfl' : m.sport === 'bb' ? 'bb' : null;
  if (sport) emit(sport, Number(m.id), Number(m.at) || Date.now());
});

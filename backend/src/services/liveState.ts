/**
 * fix202: live games reach visitors from the worker. After each live tick the worker writes the games it would push
 * (one row per game in live_state, updated_at) and sends the web process a short message with the ids that changed
 * and the ones that ended; the web process re-reads only those rows and pushes them on the existing socket. A game no
 * longer live is deleted. In one process (WORKER=0) the tick hands its list straight to the listeners.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { isWeb, isWorker } from './role';
import { onIpc, sendIpc } from './ipc';

db.exec(`CREATE TABLE IF NOT EXISTS live_state (sport TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (sport, id))`);

export type LiveListener = (sport: string, all: any[], changed: any[], gone: number[]) => void;
const listeners: LiveListener[] = [];
/** web (or one process): called after each change with the sport's whole live list, the changed games and the ended ids */
export function onLive(fn: LiveListener) { listeners.push(fn); }

// this process's copy of each sport's live list (id → game), in push order
const lists = new Map<string, Map<number, any>>();
const lastJson = new Map<string, Map<number, string>>();
const listAt = new Map<string, number>();
const emit = (sport: string, changed: any[], gone: number[]) => {
  const all = [...(lists.get(sport) || new Map()).values()];
  for (const fn of listeners) { try { fn(sport, all, changed, gone); } catch (e: any) { logger.warn(`live listener: ${e?.message || e}`); } }
};

/** the last live list of a sport (web: as the worker wrote it) */
export const liveList = (sport: string): any[] => [...(lists.get(sport) || new Map()).values()];
/** when the live list of a sport was last written (worker) / received (web); 0 = never */
export const liveAt = (sport: string) => listAt.get(sport) || 0;

/** worker / one process: the tick's full list of live games of a sport (each with a numeric id) */
export function writeLive(sport: string, games: any[]) {
  const prev = lastJson.get(sport) || new Map<number, string>();
  const next = new Map<number, string>();
  const changed: any[] = [];
  for (const g of games) {
    const id = Number(g?.id);
    if (!Number.isFinite(id)) continue;
    const json = JSON.stringify(g);
    next.set(id, json);
    if (prev.get(id) !== json) changed.push(g);
  }
  const gone = [...prev.keys()].filter(id => !next.has(id));
  lastJson.set(sport, next);
  listAt.set(sport, Date.now());
  lists.set(sport, new Map(games.filter(g => Number.isFinite(Number(g?.id))).map(g => [Number(g.id), g])));
  if (isWorker) {
    if (changed.length || gone.length) {
      const now = Date.now();
      const up = db.prepare(`INSERT INTO live_state (sport, id, json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sport, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`);
      const del = db.prepare(`DELETE FROM live_state WHERE sport = ? AND id = ?`);
      db.exec('BEGIN');
      try {
        for (const g of changed) up.run(sport, Number(g.id), next.get(Number(g.id))!, now);
        for (const id of gone) del.run(sport, id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    // the order of the list can change without a game changing: the id list goes with every message
    sendIpc({ t: 'live', sport, ids: games.map(g => Number(g.id)).filter(Number.isFinite), changed: changed.map(g => Number(g.id)), gone });
    return;
  }
  if (changed.length || gone.length || !isWeb) emit(sport, changed, gone);
}

/** worker start: rows of an earlier run are stale (the first tick writes the real list) */
export function clearLive() {
  if (isWorker) db.prepare(`DELETE FROM live_state`).run();
}

function readRows(sport: string, ids: number[]): Map<number, any> {
  const out = new Map<number, any>();
  const get = db.prepare(`SELECT json FROM live_state WHERE sport = ? AND id = ?`);
  for (const id of ids) {
    const r: any = get.get(sport, id);
    if (r) try { out.set(id, JSON.parse(r.json)); } catch { /* skipped */ }
  }
  return out;
}

if (isWeb) {
  onIpc('live', m => {
    const sport = String(m.sport);
    const ids = (m.ids as number[]) || [], changedIds = (m.changed as number[]) || [], gone = (m.gone as number[]) || [];
    const cur = lists.get(sport) || new Map<number, any>();
    const fresh = readRows(sport, changedIds);
    // keep the worker's order; a game we have no row for (missed message) is read now
    const missing = ids.filter(id => !fresh.has(id) && !cur.has(id));
    for (const [id, g] of readRows(sport, missing)) fresh.set(id, g);
    const list = new Map<number, any>();
    for (const id of ids) { const g = fresh.get(id) ?? cur.get(id); if (g) list.set(id, g); }
    lists.set(sport, list);
    listAt.set(sport, Date.now());
    const changed = [...fresh.values()];
    if (changed.length || gone.length) emit(sport, changed, gone);
  });
}

/** web start: the rows the worker left (a restart of the web process keeps showing the live games) */
export function loadLiveRows() {
  if (!isWeb) return;
  const rows = db.prepare(`SELECT sport, id, json FROM live_state ORDER BY sport, updated_at`).all() as any[];
  for (const r of rows) {
    let l = lists.get(r.sport);
    if (!l) lists.set(r.sport, (l = new Map()));
    try { l.set(r.id, JSON.parse(r.json)); } catch { /* skipped */ }
  }
}

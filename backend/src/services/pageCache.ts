/**
 * fix202: stored pages (stale-while-revalidate). The endpoints every visitor opens first (match list, home record,
 * draw alerts, basketball games and tables, NFL / tennis home and record …) are never built on a visitor's request:
 * the worker builds them on start and keeps them fresh, and stores each in page_cache (key, json, built_at). A request
 * gets the stored copy at once; a copy older than its `freshMs` asks the worker for a new one and is still served.
 * After a restart the last stored copy is served straight away.
 *
 * A page is defined once (definePage: a name, how fresh it should be, the builder, optional ready-made variants such
 * as the signed-out copy) and addressed by name + query (pageKey). The web process reads; the worker builds. In one
 * process (WORKER=0) the same process does both, still without making a visitor wait when a copy exists.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { isWeb, isWorker, runsJobs } from './role';
import { onIpc, sendIpc } from './ipc';
import { timed, yieldLoop } from './perf';

db.exec(`CREATE TABLE IF NOT EXISTS page_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, built_at INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0)`);

export type Query = Record<string, string | number | boolean | null | undefined>;
export interface PageDef {
  name: string;
  /** a copy older than this is rebuilt (the old one is served meanwhile) */
  freshMs: number;
  build: (q: Record<string, string>) => Promise<unknown> | unknown;
  /** ready-made strings stored beside the page (e.g. the signed-out copy), so a request only sends them */
  variants?: Record<string, (body: any) => string>;
  /** queries built on start and kept fresh by the worker */
  warm?: Query[];
}
export interface Stored { body: any; builtAt: number; variant: (v: string) => string | undefined }

const defs = new Map<string, PageDef>();
export function definePage(def: PageDef) { defs.set(def.name, def); }

/** name + query → stored key ("upcoming?days=14"); empty values left out, keys sorted */
export function pageKey(name: string, q: Query = {}): string {
  const parts = Object.keys(q).filter(k => q[k] !== undefined && q[k] !== null && q[k] !== '' && q[k] !== false).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(q[k] === true ? 1 : q[k]))}`);
  return parts.length ? `${name}?${parts.join('&')}` : name;
}
const parseKey = (key: string) => {
  const i = key.indexOf('?');
  return { name: i < 0 ? key : key.slice(0, i), q: Object.fromEntries(new URLSearchParams(i < 0 ? '' : key.slice(i + 1))) as Record<string, string> };
};

// this process's copy of each page (parsed once per build)
type Mem = { builtAt: number; checkedAt: number; body: any; variants: Map<string, string | null> };
const mem = new Map<string, Mem>();
const stats = new Map<string, { builtAt: number; ms: number; kb: number; builds: number; requested: number }>();

function readRow(key: string): Mem | null {
  const row: any = db.prepare(`SELECT json, built_at FROM page_cache WHERE key = ?`).get(key);
  if (!row) return null;
  try { return { builtAt: row.built_at, checkedAt: Date.now(), body: JSON.parse(row.json), variants: new Map() }; } catch { return null; }
}
const builtAtOf = (key: string): number => (db.prepare(`SELECT built_at FROM page_cache WHERE key = ?`).get(key) as any)?.built_at || 0;

function stored(key: string, m: Mem): Stored {
  return {
    body: m.body,
    builtAt: m.builtAt,
    variant: v => {
      if (!m.variants.has(v)) m.variants.set(v, (db.prepare(`SELECT json FROM page_cache WHERE key = ? AND built_at = ?`).get(`${key}#${v}`, m.builtAt) as any)?.json ?? null);
      return m.variants.get(v) ?? undefined;
    }
  };
}

/* ---------- building (worker, or one process) ---------- */

const building = new Map<string, Promise<void>>();
// keys a visitor asked for lately: the worker keeps them fresh for an hour after the last request
const requestedAt = new Map<string, number>();

function buildNow(key: string): Promise<void> {
  const run = building.get(key);
  if (run) return run;
  const { name, q } = parseKey(key);
  const def = defs.get(name);
  if (!def) return Promise.resolve();
  const p = timed(`page ${name}`, async () => {
    const t0 = Date.now();
    const body = await def.build(q);
    await yieldLoop();
    const json = JSON.stringify(body);
    const at = Date.now();
    const variants: [string, string][] = [];
    for (const [v, fn] of Object.entries(def.variants || {})) { variants.push([`${key}#${v}`, fn(body)]); await yieldLoop(); }
    const ins = db.prepare(`INSERT INTO page_cache (key, json, built_at, ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at, ms = excluded.ms`);
    db.exec('BEGIN');
    try {
      ins.run(key, json, at, at - t0);
      for (const [k, s] of variants) ins.run(k, s, at, 0);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    mem.set(key, { builtAt: at, checkedAt: at, body, variants: new Map(variants.map(([k, s]) => [k.slice(key.length + 1), s])) });
    const st = stats.get(key) || { builtAt: 0, ms: 0, kb: 0, builds: 0, requested: 0 };
    st.builtAt = at; st.ms = at - t0; st.kb = Math.round(json.length / 1024); st.builds++;
    stats.set(key, st);
    sendIpc({ t: 'page', key, builtAt: at });
  }).catch(e => {
    logger.warn(`page ${key}: ${e?.message || e}`);
    sendIpc({ t: 'page', key, builtAt: 0 }); // a request waiting for a first copy answers now (503) instead of after 10 s
  }).finally(() => building.delete(key));
  building.set(key, p);
  return p;
}

/* ---------- reading (every process) ---------- */

// web: requests waiting for the worker's first build of a key
const waiters = new Map<string, (() => void)[]>();
const askedAt = new Map<string, number>();
function askWorker(key: string) {
  if (Date.now() - (askedAt.get(key) || 0) < 10_000) return;
  askedAt.set(key, Date.now());
  sendIpc({ t: 'page:build', key });
}
if (isWeb) onIpc('page', m => {
  const key = String(m.key);
  const cur = mem.get(key);
  if (cur && cur.builtAt < Number(m.builtAt)) mem.delete(key);
  for (const w of waiters.get(key) || []) w();
  waiters.delete(key);
});
if (isWorker) onIpc('page:build', m => {
  const key = String(m.key);
  requestedAt.set(key, Date.now());
  void buildNow(key);
});

const WAIT_FIRST_MS = Number(process.env.PAGE_WAIT_MS) || 10_000;

/**
 * The stored copy of a page (null only when none was ever built and the build did not finish in 10 s). A copy older
 * than the page's freshMs is still returned; a new one is built in the background.
 */
export async function getPage(name: string, q: Query = {}): Promise<Stored | null> {
  const def = defs.get(name);
  if (!def) throw new Error(`page ${name} is not defined`);
  const key = pageKey(name, q);
  const st = stats.get(key) || { builtAt: 0, ms: 0, kb: 0, builds: 0, requested: 0 };
  st.requested++; stats.set(key, st);
  let m = mem.get(key);
  // web: the worker may have rebuilt it without the message reaching us (restart): look at the row now and then
  if (m && isWeb && Date.now() - m.checkedAt > Math.min(def.freshMs, 60_000)) {
    m.checkedAt = Date.now();
    if (builtAtOf(key) > m.builtAt) { mem.delete(key); m = undefined; }
  }
  if (!m) {
    const row = readRow(key);
    if (row) mem.set(key, (m = row));
  }
  if (m) {
    if (Date.now() - m.builtAt > def.freshMs) {
      if (runsJobs) { requestedAt.set(key, Date.now()); void buildNow(key); } else askWorker(key);
    }
    return stored(key, m);
  }
  // never built: one process builds it now; the web process asks the worker and waits (at most 10 s)
  if (runsJobs) {
    requestedAt.set(key, Date.now());
    await buildNow(key);
  } else {
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, WAIT_FIRST_MS);
      let l = waiters.get(key);
      if (!l) waiters.set(key, (l = []));
      l.push(() => { clearTimeout(t); resolve(); });
      askedAt.delete(key);
      askWorker(key);
    });
    const row = readRow(key);
    if (row) mem.set(key, row);
  }
  const done = mem.get(key);
  return done ? stored(key, done) : null;
}

/**
 * worker / one process: build every page's `warm` queries now (one at a time) and keep them, and every key a visitor
 * asked for within the last hour, fresh. Returns when the first round is done.
 */
export async function startPageWarmer(): Promise<void> {
  const due = (key: string, def: PageDef) => Date.now() - (mem.get(key)?.builtAt || builtAtOf(key)) > def.freshMs;
  const round = async (first: boolean) => {
    const keys = new Set<string>();
    for (const def of defs.values()) for (const q of def.warm || []) keys.add(pageKey(def.name, q));
    for (const [k, at] of requestedAt) if (Date.now() - at < 3600 * 1000) keys.add(k); else requestedAt.delete(k);
    for (const key of keys) {
      const def = defs.get(parseKey(key).name);
      if (!def || (!first && !due(key, def))) continue;
      await buildNow(key);
      await yieldLoop();
    }
  };
  await round(true);
  // copies nobody asked for in a week (an old query, a league gone) are dropped
  setInterval(() => { try { db.prepare(`DELETE FROM page_cache WHERE built_at < ?`).run(Date.now() - 7 * 86400000); } catch { /* next hour */ } }, 3600 * 1000).unref();
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    round(false).catch(e => logger.warn(`page warmer: ${e?.message || e}`)).finally(() => { running = false; });
  }, 15 * 1000).unref();
}

/** worker / one process: rebuild the pages of these names now (e.g. after the fixture window changed) */
export function refreshPages(...names: string[]) {
  if (!runsJobs) return;
  const keys = new Set<string>();
  for (const d of defs.values()) if (names.includes(d.name)) for (const q of d.warm || []) keys.add(pageKey(d.name, q));
  for (const k of requestedAt.keys()) if (names.includes(parseKey(k).name)) keys.add(k);
  for (const k of keys) void buildNow(k);
}

/** /api/perf: each stored page (when built, how long the build took, size, requests in this process) */
export function pageCacheStatus() {
  const rows = db.prepare(`SELECT key, built_at, ms, length(json) AS len FROM page_cache WHERE key NOT LIKE '%#%' ORDER BY key`).all() as any[];
  return rows.map(r => ({ key: r.key, builtAt: new Date(r.built_at).toISOString(), ageS: Math.round((Date.now() - r.built_at) / 1000), buildMs: r.ms, kb: Math.round(r.len / 1024), requests: stats.get(r.key)?.requested || 0 }));
}

/** tests: forget this process's copies (the next read comes from the table) */
export const _forgetPageMemory = () => mem.clear();

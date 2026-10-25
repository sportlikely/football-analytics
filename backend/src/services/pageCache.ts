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
import { timed, yieldLoop, heavyQueued } from './perf';
import { stringifyAsync } from '../utils/jsonAsync';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

db.exec(`CREATE TABLE IF NOT EXISTS page_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, built_at INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0)`);
// fix221: each stored view carries its ETag and a gzip copy made by the worker (the web process only sends them)
for (const col of ['etag TEXT', 'gz BLOB']) { try { db.exec(`ALTER TABLE page_cache ADD COLUMN ${col}`); } catch { /* there already */ } }
const gzip = promisify(zlib.gzip);

export type Query = Record<string, string | number | boolean | null | undefined>;
export interface PageDef {
  name: string;
  /** a copy older than this is rebuilt (the old one is served meanwhile) */
  freshMs: number;
  build: (q: Record<string, string>) => Promise<unknown> | unknown;
  /** ready-made strings stored beside the page (e.g. the signed-out copy), so a request only sends them */
  variants?: Record<string, (body: any, q: Record<string, string>) => string | Promise<string>>;
  /**
   * fix221: a list page as one string per row (full / teased / locked), made by the worker. The web process puts a
   * member's own copy together from them (their unlocked games in full) without parsing or serialising anything; the
   * 'anon' (every row teased) and 'full' views are made from the same rows.
   */
  rows?: (body: any, q: Record<string, string>) => Rows | Promise<Rows>;
  /** queries built on start and kept fresh by the worker */
  warm?: Query[];
  /** fix210: how fresh this copy should be, from the copy itself (a finished game keeps longer than a live one); default freshMs */
  freshOf?: (body: any) => number;
  /** fix210: a stored copy older than this is dropped (default 7 days; on-demand pages sooner) */
  keepMs?: number;
  /** fix210: false = built only when a visitor asks for it (player / match / news pages …), never kept fresh by the warmer */
  refresh?: boolean;
}
/** fix221: a list as text: `head` + rows joined by ',' + `tail`; a row's tease / locked text (missing = same as the one before) */
export interface Rows { head: string; tail: string; rows: { id: number; full: string; tease?: string; locked?: string }[] }
/** one stored view as sent: the text, its ETag and (over 2 KB) the gzip copy */
export interface View { text: string; etag: string; gz: Buffer | null }
export interface Stored {
  /** the page itself — read and parsed on first use (fix221: the web process sends views and never needs it) */
  readonly body: any;
  builtAt: number;
  variant: (v: string) => string | undefined;
  view: (v: string) => View | undefined;
  /** fix221: the page's rows (null = a page without rows) */
  rows: () => Rows | null;
}

const SEP_ROW = '\x01', SEP_COL = '\x02'; // never inside JSON text (JSON.stringify escapes control characters)
export function rowsText(r: Rows): string {
  return [r.head, r.tail, ...r.rows.map(x => `${x.id}${SEP_COL}${x.full}${SEP_COL}${x.tease ?? ''}${SEP_COL}${x.locked ?? ''}`)].join(SEP_ROW);
}
export function parseRows(text: string): Rows {
  const parts = text.split(SEP_ROW);
  return {
    head: parts[0], tail: parts[1],
    rows: parts.slice(2).map(p => { const [id, full, tease, locked] = p.split(SEP_COL); return { id: Number(id), full, tease: tease || undefined, locked: locked || undefined }; })
  };
}
export type RowAs = 'full' | 'tease' | 'locked';
const rowAs = (x: Rows['rows'][number], as: RowAs) => (as === 'full' ? x.full : as === 'tease' ? x.tease || x.full : x.locked || x.tease || x.full);
/** fix221: the list for one reader from the stored rows — string joins only */
export function joinRows(r: Rows, as: (id: number) => RowAs): string {
  const parts = new Array<string>(r.rows.length);
  for (let i = 0; i < r.rows.length; i++) parts[i] = rowAs(r.rows[i], as(r.rows[i].id));
  return r.head + parts.join(',') + r.tail;
}
export const etagOf = (text: string | Buffer) => `"${crypto.createHash('sha1').update(text).digest('base64url').slice(0, 22)}"`;

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
// fix210: capped, least recently used out first: at most MEM_MAX copies and MEM_MAX_MB in memory (the rest stays in
// page_cache and is read again when asked for). The worker keeps none: it held every page it ever built.
// fix221: the web process keeps the views it sent (text + gzip), not the page: the body is read and parsed only if asked for
type Mem = { builtAt: number; checkedAt: number; body?: any; variants: Map<string, View | null>; rows?: Rows | null; bytes: number };
const mem = new Map<string, Mem>();
const MEM_MAX = Number(process.env.PAGE_MEM_MAX) || 400;
const MEM_MAX_BYTES = (Number(process.env.PAGE_MEM_MAX_MB) || 48) * 1048576;
let memBytes = 0;
function memGet(key: string): Mem | undefined {
  const m = mem.get(key);
  if (m) { mem.delete(key); mem.set(key, m); } // most recently used last
  return m;
}
function memDel(key: string) { const m = mem.get(key); if (m) { memBytes -= m.bytes; mem.delete(key); } }
function memSet(key: string, m: Mem) {
  memDel(key);
  mem.set(key, m);
  memBytes += m.bytes;
  for (const k of mem.keys()) { if (mem.size <= MEM_MAX && memBytes <= MEM_MAX_BYTES) break; if (k !== key) memDel(k); }
}
const stats = new Map<string, { builtAt: number; ms: number; kb: number; builds: number; requested: number }>();
const statOf = (key: string) => {
  let st = stats.get(key);
  if (!st) { stats.set(key, (st = { builtAt: 0, ms: 0, kb: 0, builds: 0, requested: 0 })); if (stats.size > 3000) stats.delete(stats.keys().next().value as string); }
  return st;
};

const builtAtOf = (key: string): number => (db.prepare(`SELECT built_at FROM page_cache WHERE key = ?`).get(key) as any)?.built_at || 0;
/** fix221: the web process reads only the row's time here; the page's text is read when its body is asked for */
function readRow(key: string, withBody = !isWeb): Mem | null {
  if (!withBody) {
    const at = builtAtOf(key);
    return at ? { builtAt: at, checkedAt: Date.now(), variants: new Map(), bytes: 0 } : null;
  }
  const row: any = db.prepare(`SELECT json, built_at FROM page_cache WHERE key = ?`).get(key);
  if (!row) return null;
  try { return { builtAt: row.built_at, checkedAt: Date.now(), body: JSON.parse(row.json), variants: new Map(), bytes: row.json.length * 2 }; } catch { return null; }
}
const grow = (key: string, m: Mem, b: number) => { if (b && mem.get(key) === m) { m.bytes += b; memBytes += b; } };
function bodyOf(key: string, m: Mem) {
  if (m.body === undefined) {
    const row: any = db.prepare(`SELECT json FROM page_cache WHERE key = ?`).get(key);
    m.body = row ? JSON.parse(row.json) : null;
    grow(key, m, row ? row.json.length * 2 : 0);
  }
  return m.body;
}
function readView(key: string, v: string, builtAt: number): View | null {
  const r: any = db.prepare(`SELECT json, etag, gz FROM page_cache WHERE key = ? AND built_at = ?`).get(`${key}#${v}`, builtAt);
  if (!r) return null;
  return { text: r.json, etag: r.etag || `"${builtAt.toString(36)}-${v}"`, gz: r.gz ? Buffer.from(r.gz) : null };
}

function stored(key: string, m: Mem): Stored {
  const view = (v: string) => {
    if (!m.variants.has(v)) {
      const x = readView(key, v, m.builtAt);
      m.variants.set(v, x);
      grow(key, m, x ? x.text.length * 2 + (x.gz?.length || 0) : 0);
    }
    return m.variants.get(v) ?? undefined;
  };
  return {
    get body() { return bodyOf(key, m); },
    builtAt: m.builtAt,
    view,
    variant: v => view(v)?.text,
    rows: () => {
      if (m.rows === undefined) {
        const t = readView(key, 'rows', m.builtAt)?.text;
        m.rows = t ? parseRows(t) : null;
        grow(key, m, t ? t.length * 2 : 0);
      }
      return m.rows;
    }
  };
}

/* ---------- building (worker, or one process) ---------- */

const building = new Map<string, Promise<void>>();
// keys a visitor asked for lately: the worker keeps them fresh for an hour after the last request
const requestedAt = new Map<string, number>();
const noteRequested = (key: string, def: PageDef) => {
  if (def.refresh === false) return; // on-demand pages: rebuilt when asked for again, not kept fresh
  requestedAt.delete(key); requestedAt.set(key, Date.now());
  if (requestedAt.size > 2000) requestedAt.delete(requestedAt.keys().next().value as string);
};
const freshOf = (def: PageDef, body: () => any) => { try { return def.freshOf ? def.freshOf(body()) : def.freshMs; } catch { return def.freshMs; } };
// worker: when each key was last built (the copy itself is in page_cache, not in memory)
const builtAtMem = new Map<string, number>();
/**
 * fix210: pages with warm queries (the lists every visitor opens: big) are built in the heavy-job queue, one heavy job
 * at a time in the worker; on-demand pages (one player, one match: small, a visitor may be waiting) are built at once.
 */
function buildQueued(key: string): Promise<void> {
  const def = defs.get(parseKey(key).name);
  if (!def?.warm?.length || !runsJobs) return buildNow(key);
  return heavyQueued(`page ${key}`, () => buildNow(key)).then(() => undefined);
}

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
    // fix210: a long list becomes JSON in slices (the upcoming list is several MB)
    const json = await stringifyAsync(body);
    const texts: [string, string][] = [];
    for (const [v, fn] of Object.entries(def.variants || {})) { texts.push([v, await fn(body, q)]); await yieldLoop(); }
    // fix221: a list page's rows, and its 'anon' / 'full' views made from them
    if (def.rows) {
      const r = await def.rows(body, q);
      await yieldLoop();
      texts.push(['rows', rowsText(r)], ['anon', joinRows(r, () => 'tease')], ['full', joinRows(r, () => 'full')]);
      await yieldLoop();
    }
    // fix221: ETag + gzip of every view made here (gzip runs off the thread), so the web process only sends them
    const variants: [string, View][] = [];
    for (const [v, text] of texts) {
      variants.push([v, { text, etag: etagOf(text), gz: v !== 'rows' && text.length > 2048 ? await gzip(text, { level: 6 }) : null }]);
      await yieldLoop();
    }
    const at = Date.now();
    const ins = db.prepare(`INSERT INTO page_cache (key, json, built_at, ms, etag, gz) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at, ms = excluded.ms, etag = excluded.etag, gz = excluded.gz`);
    db.exec('BEGIN');
    try {
      ins.run(key, json, at, at - t0, null, null);
      for (const [v, x] of variants) ins.run(`${key}#${v}`, x.text, at, 0, x.etag, x.gz);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (!isWorker) memSet(key, { builtAt: at, checkedAt: at, body, variants: new Map(variants.filter(([v]) => v !== 'rows')), bytes: (json.length + variants.reduce((n, [, x]) => n + x.text.length, 0)) * 2 });
    else { builtAtMem.delete(key); builtAtMem.set(key, at); if (builtAtMem.size > 5000) builtAtMem.delete(builtAtMem.keys().next().value as string); }
    const st = statOf(key);
    st.builtAt = at; st.ms = at - t0; st.kb = Math.round(json.length / 1024); st.builds++;
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
  if (cur && cur.builtAt < Number(m.builtAt)) memDel(key);
  for (const w of waiters.get(key) || []) w();
  waiters.delete(key);
});
if (isWorker) onIpc('page:build', m => {
  const key = String(m.key);
  const def = defs.get(parseKey(key).name);
  if (def) noteRequested(key, def);
  void buildQueued(key);
});

const WAIT_FIRST_MS = Number(process.env.PAGE_WAIT_MS) || 10_000;

/**
 * The stored copy of a page (null only when none was ever built and the build did not finish in 10 s). A copy older
 * than the page's freshMs is still returned; a new one is built in the background.
 */
export async function getPage(name: string, q: Query = {}, opts: { waitMs?: number } = {}): Promise<Stored | null> {
  const def = defs.get(name);
  if (!def) throw new Error(`page ${name} is not defined`);
  const key = pageKey(name, q);
  statOf(key).requested++;
  let m = memGet(key);
  // web: the worker may have rebuilt it without the message reaching us (restart): look at the row now and then
  if (m && isWeb && Date.now() - m.checkedAt > Math.min(def.freshMs, 60_000)) {
    m.checkedAt = Date.now();
    if (builtAtOf(key) > m.builtAt) { memDel(key); m = undefined; }
  }
  if (!m) {
    const row = readRow(key);
    if (row) { m = row; if (!isWorker) memSet(key, row); }
  }
  if (m) {
    const mm = m;
    if (Date.now() - m.builtAt > freshOf(def, () => bodyOf(key, mm))) {
      if (runsJobs) { noteRequested(key, def); void buildQueued(key); } else askWorker(key);
    }
    return stored(key, m);
  }
  // never built: one process builds it now; the web process asks the worker and waits (at most 10 s)
  if (runsJobs) {
    noteRequested(key, def);
    await buildNow(key);
    const row = isWorker ? readRow(key) : null;
    if (row) return stored(key, row);
  } else {
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, opts.waitMs ?? WAIT_FIRST_MS);
      let l = waiters.get(key);
      if (!l) waiters.set(key, (l = []));
      l.push(() => { clearTimeout(t); resolve(); });
      askedAt.delete(key);
      askWorker(key);
    });
    const row = readRow(key);
    if (row) memSet(key, row);
  }
  const done = mem.get(key);
  return done ? stored(key, done) : null;
}

/**
 * worker / one process: build every page's `warm` queries now (one at a time) and keep them, and every key a visitor
 * asked for within the last hour, fresh. Returns when the first round is done.
 */
export async function startPageWarmer(): Promise<void> {
  const due = (key: string, def: PageDef) => Date.now() - (mem.get(key)?.builtAt || builtAtMem.get(key) || builtAtOf(key)) > def.freshMs;
  const round = async (first: boolean) => {
    const keys = new Set<string>();
    for (const def of defs.values()) for (const q of def.warm || []) keys.add(pageKey(def.name, q));
    for (const [k, at] of requestedAt) if (Date.now() - at < 3600 * 1000) keys.add(k); else requestedAt.delete(k);
    for (const key of keys) {
      const def = defs.get(parseKey(key).name);
      if (!def || (!first && !due(key, def))) continue;
      await buildQueued(key); // fix210: one heavy job at a time (the first round took 205 s beside every other start-up job)
      await yieldLoop();
    }
  };
  await round(true);
  // copies nobody asked for in a week (an old query, a league gone) are dropped
  // fix210: on-demand pages (keepMs) sooner: a crawler opening thousands of player / match pages must not fill the file
  setInterval(() => {
    try {
      db.prepare(`DELETE FROM page_cache WHERE built_at < ?`).run(Date.now() - 7 * 86400000);
      for (const d of defs.values()) if (d.keepMs) db.prepare(`DELETE FROM page_cache WHERE (key = ? OR key LIKE ?) AND built_at < ?`).run(d.name, `${d.name}?%`, Date.now() - d.keepMs);
    } catch { /* next hour */ }
  }, 3600 * 1000).unref();
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    round(false).catch(e => logger.warn(`page warmer: ${e?.message || e}`)).finally(() => { running = false; });
  }, 15 * 1000).unref();
}

/** fix210b (worker): when this page was last stored (0 = never) — prebuild jobs skip what is fresh */
export const storedAt = (name: string, q: Query = {}) => builtAtOf(pageKey(name, q));
/** fix210b (worker): build and store this page now (prebuild jobs; awaits the write) */
export function storePage(name: string, q: Query = {}): Promise<void> {
  if (!runsJobs) throw new Error('pages are built by the worker');
  return buildNow(pageKey(name, q));
}

/** worker / one process: rebuild the pages of these names now (e.g. after the fixture window changed) */
export function refreshPages(...names: string[]) {
  if (!runsJobs) return;
  const keys = new Set<string>();
  for (const d of defs.values()) if (names.includes(d.name)) for (const q of d.warm || []) keys.add(pageKey(d.name, q));
  for (const k of requestedAt.keys()) if (names.includes(parseKey(k).name)) keys.add(k);
  for (const k of keys) void buildQueued(k); // fix210: queued after the heavy job that asked for it, never inside it
}

/** /api/perf: each stored page (when built, how long the build took, size, requests in this process) */
export function pageCacheStatus() {
  const rows = db.prepare(`SELECT key, built_at, ms, length(json) AS len FROM page_cache WHERE key NOT LIKE '%#%' ORDER BY key`).all() as any[];
  return rows.map(r => ({ key: r.key, builtAt: new Date(r.built_at).toISOString(), ageS: Math.round((Date.now() - r.built_at) / 1000), buildMs: r.ms, kb: Math.round(r.len / 1024), requests: stats.get(r.key)?.requested || 0 }));
}

/** tests: forget this process's copies (the next read comes from the table) */
export const _forgetPageMemory = () => { mem.clear(); memBytes = 0; };
/** tests: a page's definition (fix221: the big-list test swaps the builder for real-size data, keeping the views) */
export const _pageDef = (name: string) => defs.get(name);
/** /api/perf: this process's in-memory copies (fix210: capped) */
export const pageMemStatus = () => ({ copies: mem.size, mb: Math.round(memBytes / 1048576), maxCopies: MEM_MAX, maxMb: Math.round(MEM_MAX_BYTES / 1048576) });

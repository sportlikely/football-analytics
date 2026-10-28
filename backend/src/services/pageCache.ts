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
import { timed, yieldLoop, pageLane, markPagesFirstDone } from './perf';
import { stringifyAsync } from '../utils/jsonAsync';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { readStored, readSql, pageReaderOn, SPLIT_CHARS, partKey, partsMarker, partsCount } from './pageReader';

db.exec(`CREATE TABLE IF NOT EXISTS page_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, built_at INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0)`);
// fix221: each stored view carries its ETag and a gzip copy made by the worker (the web process only sends them)
// fix232: + the page's size, so /api/perf never reads length(json) over the whole table (it read every stored page)
for (const col of ['etag TEXT', 'gz BLOB', 'kb INTEGER']) { try { db.exec(`ALTER TABLE page_cache ADD COLUMN ${col}`); } catch { /* there already */ } }
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
  /**
   * fix252: the stored copy to send while a query never asked before is being built (fix232's rule: a stored copy, never
   * "Loading"), e.g. a list's warm query for the same list with other limits; null = none fits (the visitor waits)
   */
  fallback?: (q: Query) => Query | null;
}
/** fix221: a list as text: `head` + rows joined by ',' + `tail`; a row's tease / locked text (missing = same as the one before) */
export interface Rows { head: string; tail: string; rows: { id: number; full: string; tease?: string; locked?: string }[] }
/** one stored view as sent: the text, its ETag and (over 2 KB) the gzip copy */
export interface View { text: string; etag: string; gz: Buffer | null }
export interface Stored {
  /** the page itself — read and parsed on first use (fix221: the web process sends views and never needs it) */
  readonly body: any;
  builtAt: number;
  /** fix250: seconds past the page's freshness (0 = fresh; a new copy is being built) */
  staleS: number;
  variant: (v: string) => string | undefined;
  view: (v: string) => View | undefined;
  /** fix221: the page's rows (null = a page without rows) */
  rows: () => Rows | null;
  /** fix222: a view's ETag alone (its text and gzip copy are not read) */
  etagOf: (v: string) => string | undefined;
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
// fix248: etags = ETags read in the reader thread for this request (etagOf never reads a big row on the web thread)
type Mem = { builtAt: number; checkedAt: number; body?: any; variants: Map<string, View | null>; rows?: Rows | null; bytes: number; etags?: Map<string, string | null> };
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

/*
 * fix243: a row's time / ETag through its covering index. fix232 built idx_page_cache_meta for this, but SQLite never
 * used it: for `key = ?` it takes the primary key's index and reads the row, and built_at / etag come after the json
 * column — every read walked the page's overflow pages (the upcoming list: several MB, from disk after each rebuild:
 * "stored upcoming: read" 1–2 s on the web, 26 Oct). INDEXED BY makes SQLite read the index only; until the index is
 * there (dbIndexes.ts builds it in a thread) the plain query.
 */
type Q = { st: any; indexed: boolean; at: number };
const indexedQ = (indexed: string, plain: string) => {
  let q: Q | null = null;
  return () => {
    if (q && (q.indexed || Date.now() - q.at < 60_000)) return q.st;
    try { q = { st: db.prepare(indexed), indexed: true, at: Date.now() }; } catch { q = { st: db.prepare(plain), indexed: false, at: Date.now() }; }
    return q.st;
  };
};
const BUILT_AT_INDEXED = `SELECT built_at FROM page_cache INDEXED BY idx_page_cache_meta WHERE key = ?`;
const BUILT_AT_PLAIN = `SELECT built_at FROM page_cache WHERE key = ?`;
const ETAG_SQL = `SELECT etag FROM page_cache WHERE key = ? AND built_at = ?`;
const qBuiltAt = indexedQ(BUILT_AT_INDEXED, BUILT_AT_PLAIN);
// fix243b: the ETag with the plain query (no index built for it at start-up: see dbIndexes.ts)
const qEtag = indexedQ(`SELECT etag FROM page_cache WHERE key = ? AND built_at = ?`, `SELECT etag FROM page_cache WHERE key = ? AND built_at = ?`);
const builtAtOf = (key: string): number => (qBuiltAt().get(key) as any)?.built_at || 0;
/*
 * fix248: on the web the row's time is read in the reader thread (the CPU profile of 26 Oct: 498 ms of `get` in
 * builtAtOf ← readRow ← getPage — the plain query walks the page's text until the index is there). The synchronous
 * read only when the thread is not there.
 */
let indexedOff = true;
/*
 * fix254: the web keeps every key's time (and its views' ETags) in memory, as the worker tells it: each build sends
 * them ('page'), and every 30 s the worker repeats the builds of the last 3 minutes ('page-meta': a lost message is
 * caught). A key is read from the disk once per web process — "SELECT built_at … WHERE key = ?" took 1.7–1.9 s on the
 * volume (28 Oct) — and never again after: its later builds come by message.
 */
type Hot = { at: number; etags?: Record<string, string | null> };
const hot = new Map<string, Hot>();
const HOT_MAX = 20_000;
function hotSet(key: string, h: Hot) {
  const cur = hot.get(key);
  if (cur && cur.at > h.at) return;
  if (cur && cur.at === h.at && !h.etags) return;
  hot.delete(key); hot.set(key, h);
  if (hot.size > HOT_MAX) hot.delete(hot.keys().next().value as string);
}
const hotStats = { hits: 0, misses: 0, messages: 0 };
/** web: a view's ETag from memory ('' = the default ETag, null = no such view, undefined = not known here) */
function hotEtag(key: string, v: string, builtAt: number): string | null | undefined {
  const h = hot.get(key);
  if (!h || h.at !== builtAt || !h.etags) return undefined;
  return v in h.etags ? h.etags[v] : null;
}
// a time older than the page's keep time (cleanPageCache may have dropped that copy) is read from the disk again
const HOT_MAX_AGE = 6 * 86400000;
const keepOf = (key: string) => Math.min(HOT_MAX_AGE, defs.get(parseKey(key).name)?.keepMs ?? HOT_MAX_AGE);
async function builtAtAsync(key: string): Promise<number> {
  if (isWeb) { const h = hot.get(key); if (h && Date.now() - h.at < keepOf(key)) { hotStats.hits++; return h.at; } hotStats.misses++; }
  if (!isWeb || !pageReaderOn()) return remember(key, builtAtOf(key));
  try {
    if (indexedOff) { try { return remember(key, (await readSql<any>(BUILT_AT_INDEXED, [key]))?.built_at || 0); } catch { indexedOff = false; setTimeout(() => { indexedOff = true; }, 60_000).unref(); } }
    return remember(key, (await readSql<any>(BUILT_AT_PLAIN, [key]))?.built_at || 0);
  } catch { return remember(key, builtAtOf(key)); }
}
/** a time read from the disk is kept (0 = no copy yet: not kept, the worker's message will bring it) */
const remember = (key: string, at: number) => { if (isWeb && at) hotSet(key, { at }); return at; };
/** /api/perf: the in-memory times */
export const pageHotStatus = () => ({ keys: hot.size, ...hotStats });
async function readRowAsync(key: string): Promise<Mem | null> {
  if (!isWeb) return readRow(key);
  const at = await builtAtAsync(key);
  return at ? { builtAt: at, checkedAt: Date.now(), variants: new Map(), bytes: 0 } : null;
}
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
  // fix250: a view over 2 MB is kept in parts
  const n = partsCount(r.json);
  const text = n ? Array.from({ length: n }, (_, i) => (db.prepare(`SELECT json FROM page_cache WHERE key = ? AND built_at = ?`).get(partKey(`${key}#${v}`, i), builtAt) as any)?.json ?? '').join('') : r.json;
  return { text, etag: r.etag || `"${builtAt.toString(36)}-${v}"`, gz: r.gz ? Buffer.from(r.gz) : null };
}

function stored(key: string, m: Mem, staleS = 0): Stored {
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
    staleS,
    view,
    variant: v => view(v)?.text,
    etagOf: v => {
      const have = m.variants.get(v);
      if (have !== undefined) return have?.etag;
      if (m.etags?.has(v)) { const e = m.etags.get(v); return e === null ? undefined : e || `"${m.builtAt.toString(36)}-${v}"`; }
      const he = hotEtag(key, v, m.builtAt);
      if (he !== undefined) return he === null ? undefined : he || `"${m.builtAt.toString(36)}-${v}"`;
      const r: any = qEtag().get(`${key}#${v}`, m.builtAt);
      return r ? r.etag || `"${m.builtAt.toString(36)}-${v}"` : undefined;
    },
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
 * fix210: pages with warm queries (the lists every visitor opens: big) are built one at a time in the worker; on-demand
 * pages (one player, one match: small, a visitor may be waiting) are built at once.
 * fix232: in the page lane (perf.pageLane), not the heavy queue: a model rebuild or fit never holds a page build back.
 */
function buildQueued(key: string): Promise<void> {
  const def = defs.get(parseKey(key).name);
  if (!def?.warm?.length || !runsJobs) return buildNow(key);
  return pageLane(`page ${key}`, () => buildNow(key)).then(() => undefined);
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
    const ins = db.prepare(`INSERT INTO page_cache (key, json, built_at, ms, etag, gz, kb) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at, ms = excluded.ms, etag = excluded.etag, gz = excluded.gz, kb = excluded.kb`);
    const dropParts = db.prepare(`DELETE FROM page_cache WHERE key > ? AND key < ?`);
    db.exec('BEGIN');
    try {
      ins.run(key, json, at, at - t0, null, null, Math.round(json.length / 1024));
      for (const [v, x] of variants) {
        const vk = `${key}#${v}`;
        // fix250: a view over 2 MB is stored as a marker row + 2 MB parts (the web reads the parts in parallel: no single
        // read is slow); the previous build's parts go
        dropParts.run(`${vk}~`, `${vk}~￿`);
        if (x.text.length <= SPLIT_CHARS) { ins.run(vk, x.text, at, 0, x.etag, x.gz, Math.round(x.text.length / 1024)); continue; }
        const n = Math.ceil(x.text.length / SPLIT_CHARS);
        ins.run(vk, partsMarker(n), at, 0, x.etag, x.gz, Math.round(x.text.length / 1024));
        for (let i = 0; i < n; i++) ins.run(partKey(vk, i), x.text.slice(i * SPLIT_CHARS, (i + 1) * SPLIT_CHARS), at, 0, null, null, 0);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (!isWorker) memSet(key, { builtAt: at, checkedAt: at, body, variants: new Map(variants.filter(([v]) => v !== 'rows')), bytes: (json.length + variants.reduce((n, [, x]) => n + x.text.length, 0)) * 2 });
    else { builtAtMem.delete(key); builtAtMem.set(key, at); if (builtAtMem.size > 5000) builtAtMem.delete(builtAtMem.keys().next().value as string); }
    const st = statOf(key);
    st.builtAt = at; st.ms = at - t0; st.kb = Math.round(json.length / 1024); st.builds++;
    const etags = Object.fromEntries(variants.filter(([v]) => v !== 'rows').map(([v, x]) => [v, x.etag]));
    noteRecentBuild(key, at, etags);
    sendIpc({ t: 'page', key, builtAt: at, etags });
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
// fix254 (worker): the builds of the last 3 minutes, sent again every 30 s (a lost 'page' message is caught)
const recentBuilds = new Map<string, { at: number; etags: Record<string, string> }>();
function noteRecentBuild(key: string, at: number, etags: Record<string, string>) {
  if (!isWorker) return;
  recentBuilds.delete(key); recentBuilds.set(key, { at, etags });
  if (recentBuilds.size > 2000) recentBuilds.delete(recentBuilds.keys().next().value as string);
}
if (isWorker) setInterval(() => {
  const cut = Date.now() - 3 * 60_000;
  for (const [k, b] of recentBuilds) if (b.at < cut) recentBuilds.delete(k);
  if (recentBuilds.size) sendIpc({ t: 'page-meta', builds: [...recentBuilds].map(([k, b]) => [k, b.at, b.etags]) });
}, 30_000).unref();
if (isWeb) onIpc('page-meta', m => {
  if (!Array.isArray(m.builds)) return;
  hotStats.messages++;
  for (const [key, at, etags] of m.builds as [string, number, Record<string, string>][]) {
    hotSet(key, { at, etags });
    const cur = mem.get(key);
    if (cur && cur.builtAt < at) memDel(key);
  }
});
if (isWeb) onIpc('page', m => {
  const key = String(m.key);
  if (Number(m.builtAt) > 0) { hotStats.messages++; hotSet(key, { at: Number(m.builtAt), etags: (m.etags as Record<string, string>) || undefined }); }
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
/**
 * fix243: `views` = the views this request will send (and 'rows'): on the web they are read in the reader thread
 * (services/pageReader.ts) before getPage returns, so sending them reads nothing on the web thread.
 */
async function prefetch(key: string, m: Mem, views: string[] | undefined, etags?: string[]) {
  if (!isWeb || !pageReaderOn()) return;
  // fix248: the ETags this request checks (304) without the view's text
  for (const v of etags || []) {
    if (m.variants.has(v) || m.etags?.has(v)) continue;
    const he = hotEtag(key, v, m.builtAt);
    if (he !== undefined) { (m.etags ||= new Map()).set(v, he); continue; }
    try { const r = await readSql<any>(ETAG_SQL, [`${key}#${v}`, m.builtAt]); (m.etags ||= new Map()).set(v, r ? r.etag || '' : null); } catch { break; }
  }
  if (!views?.length) return;
  for (const v of views) {
    if (v === 'rows' ? m.rows !== undefined : m.variants.has(v)) continue;
    let r: Awaited<ReturnType<typeof readStored>>;
    try { r = await readStored(`${key}#${v}`, m.builtAt); } catch { return; } // the synchronous read, as before
    if (v === 'rows') { m.rows = r ? parseRows(r.text) : null; grow(key, m, r ? r.text.length * 2 : 0); continue; }
    const x: View | null = r ? { text: r.text, etag: r.etag || `"${m.builtAt.toString(36)}-${v}"`, gz: r.gz } : null;
    if (!m.variants.has(v)) { m.variants.set(v, x); grow(key, m, x ? x.text.length * 2 + (x.gz?.length || 0) : 0); }
  }
}

export async function getPage(name: string, q: Query = {}, opts: { waitMs?: number; views?: string[]; etags?: string[] } = {}): Promise<Stored | null> {
  const def = defs.get(name);
  if (!def) throw new Error(`page ${name} is not defined`);
  const key = pageKey(name, q);
  statOf(key).requested++;
  let m = memGet(key);
  // web: the worker may have rebuilt it without the message reaching us (restart): look at the row now and then
  if (m && isWeb && Date.now() - m.checkedAt > Math.min(def.freshMs, 60_000)) {
    m.checkedAt = Date.now();
    if ((await builtAtAsync(key)) > m.builtAt) { memDel(key); m = mem.get(key); }
  }
  if (!m) {
    const row = await readRowAsync(key);
    if (row) { m = row; if (!isWorker) memSet(key, row); }
  }
  if (m) {
    const mm = m;
    const over = Date.now() - m.builtAt - freshOf(def, () => bodyOf(key, mm));
    if (over > 0) {
      if (runsJobs) { noteRequested(key, def); void buildQueued(key); } else askWorker(key);
    }
    await prefetch(key, m, opts.views, opts.etags);
    return stored(key, m, over > 0 ? Math.max(1, Math.round(over / 1000)) : 0);
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
    const row = await readRowAsync(key);
    if (row) memSet(key, row);
  }
  const done = mem.get(key);
  if (done) await prefetch(key, done, opts.views, opts.etags);
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
  const t0 = Date.now();
  try { await round(true); } finally {
    // fix232: the model rebuilds and fits (perf.MODEL_JOBS) start now — after every list was stored once
    markPagesFirstDone();
    logger.info(`stored pages: first round done in ${Math.round((Date.now() - t0) / 1000)} s — the model jobs may start`);
  }
  setInterval(cleanPageCache, 3600 * 1000).unref();
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    round(false).catch(e => logger.warn(`page warmer: ${e?.message || e}`)).finally(() => { running = false; });
  }, 15 * 1000).unref();
}

/**
 * Copies nobody asked for in a week (an old query, a league gone) are dropped; fix210: on-demand pages (keepMs) sooner:
 * a crawler opening thousands of player / match pages must not fill the file. fix232: the lists every visitor opens
 * (warm queries) are never dropped — their last copy is what a restart serves while the worker builds the next one.
 */
export function cleanPageCache(now = Date.now()) {
  try {
    const keep = [...defs.values()].flatMap(d => (d.warm || []).map(q => pageKey(d.name, q)));
    const base = `CASE WHEN instr(key, '#') > 0 THEN substr(key, 1, instr(key, '#') - 1) ELSE key END`;
    db.prepare(`DELETE FROM page_cache WHERE built_at < ?${keep.length ? ` AND ${base} NOT IN (${keep.map(() => '?').join(',')})` : ''}`).run(now - 7 * 86400000, ...keep);
    for (const d of defs.values()) if (d.keepMs) db.prepare(`DELETE FROM page_cache WHERE (key = ? OR key LIKE ?) AND built_at < ?`).run(d.name, `${d.name}?%`, now - d.keepMs);
  } catch { /* next hour */ }
}

/** fix252: the query whose stored copy stands in for `q` while `q` is built (PageDef.fallback), or null */
export function fallbackQuery(name: string, q: Query = {}): Query | null {
  const fb = defs.get(name)?.fallback?.(q) || null;
  return fb && pageKey(name, fb) !== pageKey(name, q) ? fb : null;
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

/**
 * /api/perf?full=1 (worker): each kept-fresh page (when built, how long the build took, size, requests in this process);
 * fix232: the on-demand pages (thousands of game / crawler pages) as one line per page name, and no length(json) (the
 * size is stored with the page)
 */
export function pageCacheStatus() {
  const lists: any[] = [], onDemand = new Map<string, { name: string; copies: number; kb: number; oldestS: number }>();
  for (const r of db.prepare(`SELECT key, built_at, ms, kb FROM page_cache WHERE key NOT LIKE '%#%'`).all() as any[]) {
    const name = parseKey(r.key).name, ageS = Math.round((Date.now() - r.built_at) / 1000);
    if (defs.get(name)?.refresh === false) {
      const o = onDemand.get(name) || { name, copies: 0, kb: 0, oldestS: 0 };
      o.copies++; o.kb += r.kb || 0; o.oldestS = Math.max(o.oldestS, ageS);
      onDemand.set(name, o);
    } else lists.push({ key: r.key, builtAt: new Date(r.built_at).toISOString(), ageS, buildMs: r.ms, kb: r.kb ?? null, requests: stats.get(r.key)?.requested || 0 });
  }
  return { lists: lists.sort((a, b) => (a.key < b.key ? -1 : 1)), onDemand: [...onDemand.values()] };
}

/** tests: forget this process's copies (the next read comes from the table) */
export const _forgetPageMemory = () => { mem.clear(); memBytes = 0; };
/** tests: a page's definition (fix221: the big-list test swaps the builder for real-size data, keeping the views) */
export const _pageDef = (name: string) => defs.get(name);
/** /api/perf: this process's in-memory copies (fix210: capped) */
export const pageMemStatus = () => ({ copies: mem.size, mb: Math.round(memBytes / 1048576), maxCopies: MEM_MAX, maxMb: Math.round(MEM_MAX_BYTES / 1048576) });

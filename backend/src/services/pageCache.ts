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
import { readStored, readSql, pageReaderOn, SPLIT_CHARS, partKey, partsMarker, partsCount, poolForBytes } from './pageReader';

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
  variants?: Record<string, (body: any, q: Record<string, string>) => string | null | Promise<string | null>>;
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
// fix269: held = a list / home / standings / news / config copy (a page the worker keeps warm, or a list stored row by
// row): the web keeps it in its own budget (PAGE_HOLD_MB, default 300 MB, least recently used out first) and, when the
// worker says the key changed, reads the new copy in the background while the old one is still sent — a stalled
// volume (4 KB reads up to 7.6 s, 28 Oct) delays the refresh, never a visitor
type Mem = { builtAt: number; checkedAt: number; body?: any; variants: Map<string, View | null>; rows?: Rows | null; bytes: number; etags?: Map<string, string | null>; held?: boolean };
const mem = new Map<string, Mem>();
const MEM_MAX = Number(process.env.PAGE_MEM_MAX) || 400;
const MEM_MAX_BYTES = (Number(process.env.PAGE_MEM_MAX_MB) || 48) * 1048576;
const HOLD_MAX_BYTES = (Number(process.env.PAGE_HOLD_MB) || 300) * 1048576;
let memBytes = 0, holdBytes = 0, holdCopies = 0;
const holdStats = { refreshed: 0, failed: 0, kept: 0, dropped: 0, maxRefreshMs: 0 };
const holdOf = (key: string) => { const d = defs.get(parseKey(key).name); return !!d && (!!d.rows || !!d.warm?.length); };
const addBytes = (m: Mem, b: number) => { if (m.held) holdBytes += b; else memBytes += b; };
function memGet(key: string): Mem | undefined {
  const m = mem.get(key);
  if (m) { mem.delete(key); mem.set(key, m); } // most recently used last
  return m;
}
function memDel(key: string) { const m = mem.get(key); if (m) { addBytes(m, -m.bytes); if (m.held) holdCopies--; mem.delete(key); } }
function memSet(key: string, m: Mem) {
  memDel(key);
  m.held = isWeb && holdOf(key);
  mem.set(key, m);
  addBytes(m, m.bytes);
  if (m.held) holdCopies++;
  trimMem(key);
}
/** least recently used out first, each kind within its own budget (the key just set stays) */
function trimMem(keep: string) {
  const over = () => ({ plain: mem.size - holdCopies > MEM_MAX || memBytes > MEM_MAX_BYTES, held: holdBytes > HOLD_MAX_BYTES });
  let o = over();
  if (!o.plain && !o.held) return;
  for (const [k, m] of mem) {
    if (k === keep) continue;
    if (m.held ? o.held : o.plain) { if (m.held) holdStats.dropped++; memDel(k); o = over(); if (!o.plain && !o.held) break; }
  }
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
/*
 * fix263: the whole list. The worker sends every stored key (its time and each view's size in KB, read from the
 * covering index idx_page_cache_meta, + the ETags of what it built since its start) at its start and after each
 * clean-up ('page-meta-all', 5,000 keys a message); once the list is in, a key the web does not hold has no copy —
 * the web reads nothing from the disk for a page's time any more ("SELECT built_at FROM page_cache …" 1.2–1.3 s for
 * one row, 28 Oct), and an unknown ETag is not read either (the build's own time stands in).
 */
type Hot = { at: number; etags?: Record<string, string | null>; kb?: Record<string, number> };
const hot = new Map<string, Hot>();
const HOT_MAX = Number(process.env.PAGE_HOT_MAX) || 300_000;
let hotComplete = false;
function hotSet(key: string, h: Hot) {
  const cur = hot.get(key);
  if (cur && cur.at > h.at) return;
  if (cur && cur.at === h.at) {
    if (!h.etags && !h.kb) return;
    h = { at: h.at, etags: h.etags || cur.etags, kb: h.kb || cur.kb };
  }
  hot.delete(key); hot.set(key, h);
  if (hot.size > HOT_MAX) { hot.delete(hot.keys().next().value as string); hotComplete = false; }
}
const hotStats = { hits: 0, misses: 0, messages: 0, absent: 0, lists: 0, etagsUnread: 0 };
/** web: a view's size in bytes as the worker stored it (undefined = not known here) */
const viewBytes = (key: string, v: string, builtAt: number): number | undefined => {
  const h = hot.get(key);
  const kb = h && h.at === builtAt ? h.kb?.[v] : undefined;
  return kb == null ? undefined : kb * 1024;
};
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
  if (isWeb) {
    const h = hot.get(key);
    // fix263: with the worker's whole list in, memory is the answer (a key not in it has no copy yet)
    if (h && (hotComplete || Date.now() - h.at < keepOf(key))) { hotStats.hits++; return h.at; }
    if (hotComplete) { hotStats.absent++; return 0; }
    hotStats.misses++;
  }
  if (!isWeb || !pageReaderOn()) return remember(key, builtAtOf(key));
  try {
    if (indexedOff) { try { return remember(key, (await readSql<any>(BUILT_AT_INDEXED, [key]))?.built_at || 0); } catch { indexedOff = false; setTimeout(() => { indexedOff = true; }, 60_000).unref(); } }
    return remember(key, (await readSql<any>(BUILT_AT_PLAIN, [key]))?.built_at || 0);
  } catch { return remember(key, builtAtOf(key)); }
}
/** a time read from the disk is kept (0 = no copy yet: not kept, the worker's message will bring it) */
const remember = (key: string, at: number) => { if (isWeb && at) hotSet(key, { at }); return at; };
/** /api/perf: the in-memory times (complete = the worker's whole list is in: no page time is read from the disk) */
export const pageHotStatus = () => ({ keys: hot.size, complete: hotComplete, ...hotStats });
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
const grow = (key: string, m: Mem, b: number) => { if (b && mem.get(key) === m) { m.bytes += b; addBytes(m, b); if (m.held && holdBytes > HOLD_MAX_BYTES) trimMem(key); } };
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
      // fix263: never read on the web once the list is in (the ETag is only the base of a joined copy's own ETag)
      if (isWeb && hotComplete) { hotStats.etagsUnread++; return `"${m.builtAt.toString(36)}-${v}"`; }
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
// fix272 (worker): each key's last stored copy — its time and the ETags of the page and every view (an unchanged build
// only moves built_at); how many builds were written / only touched since the start (/api/perf: pageMemStatus().builds)
const lastSig = new Map<string, { sig: string; at: number }>();
const touchStats = { written: 0, touched: 0 };
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
    // (null = this query has no such view, e.g. fix266's 'admin' copy only on the full lists)
    for (const [v, fn] of Object.entries(def.variants || {})) { const t = await fn(body, q); if (t !== null) texts.push([v, t]); await yieldLoop(); }
    // fix221: a list page's rows, and its 'anon' / 'full' views made from them
    if (def.rows) {
      const r = await def.rows(body, q);
      await yieldLoop();
      texts.push(['rows', rowsText(r)], ['anon', joinRows(r, () => 'tease')], ['full', joinRows(r, () => 'full')]);
      await yieldLoop();
    }
    // fix221: ETag + gzip of every view made here (gzip runs off the thread), so the web process only sends them
    const variants: [string, View][] = texts.map(([v, text]) => [v, { text, etag: etagOf(text), gz: null }]);
    // fix272: the same page as the stored copy (every view's ETag and the page's own) → only its time moves (one small
    // UPDATE in place); the lists rebuilt every 30 s rewrote every view + its gzip copy each time, changed or not
    const sig = `${etagOf(json)}|${variants.map(([v, x]) => `${v}=${x.etag}`).join(',')}`;
    const prev = isWorker ? lastSig.get(key) : undefined;
    const at = Date.now();
    let same = false, prevAt = 0;
    if (prev && prev.sig === sig) {
      const n = Number(db.prepare(`UPDATE page_cache SET built_at = ? WHERE built_at = ? AND (key = ? OR (key > ? AND key < ?))`).run(at, prev.at, key, `${key}#`, `${key}#￿`).changes);
      if (n >= 1 + variants.length) { same = true; prevAt = prev.at; touchStats.touched++; }
    }
    if (!same) {
      for (const [v, x] of variants) {
        if (v !== 'rows' && x.text.length > 2048) x.gz = await gzip(x.text, { level: 6 });
        await yieldLoop();
      }
      const ins = db.prepare(`INSERT INTO page_cache (key, json, built_at, ms, etag, gz, kb) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET json = excluded.json, built_at = excluded.built_at, ms = excluded.ms, etag = excluded.etag, gz = excluded.gz, kb = excluded.kb`);
      db.exec('BEGIN');
      try {
        ins.run(key, json, at, at - t0, null, null, Math.round(json.length / 1024));
        for (const [v, x] of variants) {
          const vk = `${key}#${v}`;
          // fix250: a view over 2 MB is stored as a marker row + 2 MB parts (the web reads the parts in parallel: no single
          // read is slow)
          if (x.text.length <= SPLIT_CHARS) { ins.run(vk, x.text, at, 0, x.etag, x.gz, Math.round(x.text.length / 1024)); continue; }
          const n = Math.ceil(x.text.length / SPLIT_CHARS);
          ins.run(vk, partsMarker(n), at, 0, x.etag, x.gz, Math.round(x.text.length / 1024));
          for (let i = 0; i < n; i++) ins.run(partKey(vk, i), x.text.slice(i * SPLIT_CHARS, (i + 1) * SPLIT_CHARS), at, 0, null, null, 0);
        }
        // the previous build's leftovers: parts past the new count, a view this build has no more (fix272: one sweep)
        db.prepare(`DELETE FROM page_cache WHERE key > ? AND key < ? AND built_at < ?`).run(`${key}#`, `${key}#￿`, at);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      touchStats.written++;
    }
    if (isWorker) { lastSig.delete(key); lastSig.set(key, { sig, at }); if (lastSig.size > 5000) lastSig.delete(lastSig.keys().next().value as string); }
    if (!isWorker) memSet(key, { builtAt: at, checkedAt: at, body, variants: new Map(variants.filter(([v]) => v !== 'rows')), bytes: (json.length + variants.reduce((n, [, x]) => n + x.text.length, 0)) * 2 });
    else { builtAtMem.delete(key); builtAtMem.set(key, at); if (builtAtMem.size > 5000) builtAtMem.delete(builtAtMem.keys().next().value as string); }
    const st = statOf(key);
    st.builtAt = at; st.ms = at - t0; st.kb = Math.round(json.length / 1024); st.builds++;
    const etags = Object.fromEntries(variants.filter(([v]) => v !== 'rows').map(([v, x]) => [v, x.etag]));
    const kb = Object.fromEntries(variants.map(([v, x]) => [v, Math.round(x.text.length / 1024)]));
    noteRecentBuild(key, at, etags, kb);
    sendIpc({ t: 'page', key, builtAt: at, etags, kb, ...(same ? { sameAs: prevAt } : {}) });
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
/** fix258: this stored copy is wrong (made for another build, or without its page's lang / hreflang): build it again */
export function rebuildPage(name: string, q: Query = {}) {
  const key = pageKey(name, q);
  if (runsJobs) void buildQueued(key); else askWorker(key);
}
// fix254 (worker): the builds of the last 3 minutes, sent again every 30 s (a lost 'page' message is caught)
type Built = { at: number; etags: Record<string, string>; kb: Record<string, number> };
const recentBuilds = new Map<string, Built>();
// fix263 (worker): the ETags of every build since this worker started (they go with the whole list)
const builtEtags = new Map<string, { at: number; etags: Record<string, string> }>();
function noteRecentBuild(key: string, at: number, etags: Record<string, string>, kb: Record<string, number>) {
  if (!isWorker) return;
  recentBuilds.delete(key); recentBuilds.set(key, { at, etags, kb });
  if (recentBuilds.size > 2000) recentBuilds.delete(recentBuilds.keys().next().value as string);
  builtEtags.delete(key); builtEtags.set(key, { at, etags });
  if (builtEtags.size > 100_000) builtEtags.delete(builtEtags.keys().next().value as string);
}
/*
 * fix269 (web): the worker says a key has a newer copy. A plain copy is dropped (read again when asked for); a held one
 * stays and is sent while the new copy's views — the ones the old copy had — are read in the reader threads after
 * every request's read ('bg'); the new copy replaces it once all are in. A read that fails (a stalled volume: 10 s
 * timeout) keeps the old copy; the next message or getPage's check (≤ 60 s) tries again.
 */
const refreshing = new Map<string, number>();
function newerCopy(key: string, at: number) {
  const cur = mem.get(key);
  if (!cur || !(cur.builtAt < at)) return;
  if (!cur.held || !pageReaderOn()) { memDel(key); return; }
  holdStats.kept++;
  void refreshHeld(key, cur, at);
}
async function refreshHeld(key: string, cur: Mem, at: number) {
  if ((refreshing.get(key) || 0) >= at) return;
  refreshing.set(key, at);
  const t0 = Date.now();
  try {
    const next: Mem = { builtAt: at, checkedAt: Date.now(), variants: new Map(), bytes: 0 };
    for (const v of [...cur.variants.keys(), ...(cur.rows !== undefined ? ['rows'] : [])]) {
      const r = await readStored(`${key}#${v}`, at, poolForBytes(viewBytes(key, v, at)), 'bg');
      if (refreshing.get(key) !== at) return; // a newer copy is being read
      if (!r && (v === 'rows' ? cur.rows : cur.variants.get(v))) throw new Error(`view ${v} of ${at} not there`); // (never a copy with a view lost)
      if (v === 'rows') { next.rows = r ? parseRows(r.text) : null; next.bytes += r ? r.text.length * 2 : 0; continue; }
      next.variants.set(v, r ? { text: r.text, etag: r.etag || `"${at.toString(36)}-${v}"`, gz: r.gz } : null);
      next.bytes += r ? r.text.length * 2 + (r.gz?.length || 0) : 0;
    }
    const now = mem.get(key);
    if (now && now.builtAt >= at) return;
    memSet(key, next);
    holdStats.refreshed++;
    holdStats.maxRefreshMs = Math.max(holdStats.maxRefreshMs, Date.now() - t0);
  } catch (e: any) {
    holdStats.failed++;
    logger.warn(`held copy ${key}: new copy not read in time (${e?.message || e}) — the old one is still sent`);
  } finally { if (refreshing.get(key) === at) refreshing.delete(key); }
}

if (isWorker) setInterval(() => {
  const cut = Date.now() - 3 * 60_000;
  for (const [k, b] of recentBuilds) if (b.at < cut) recentBuilds.delete(k);
  if (recentBuilds.size) sendIpc({ t: 'page-meta', builds: [...recentBuilds].map(([k, b]) => [k, b.at, b.etags, b.kb]) });
}, 30_000).unref();
if (isWeb) onIpc('page-meta', m => {
  if (!Array.isArray(m.builds)) return;
  hotStats.messages++;
  for (const [key, at, etags, kb] of m.builds as [string, number, Record<string, string>, Record<string, number> | undefined][]) {
    hotSet(key, { at, etags, kb });
    newerCopy(key, at);
  }
});

/*
 * fix263 (worker): every stored key → the web ('page-meta-all'). Read from the covering index (key, built_at, kb: the
 * rows themselves are never visited), 5,000 keys a page with a yield between, sent 5,000 keys a message. `since` =
 * when the read began: the web drops a key it holds from before then that is not in the list (cleaned up).
 */
const META_SQL = `SELECT key, built_at, kb FROM page_cache INDEXED BY idx_page_cache_meta WHERE key > ? ORDER BY key LIMIT 5000`;
let listGen = 0, listing = false;
export async function sendPageList(): Promise<number> {
  if (!isWorker || listing) return 0;
  listing = true;
  const gen = ++listGen, since = Date.now();
  let n = 0, part = 0;
  try {
    let st: any;
    try { st = db.prepare(META_SQL); } catch { return 0; } // the index is not built yet (dbIndexes.ts): the next clean-up
    let batch: [string, number, Record<string, number>, Record<string, string> | undefined][] = [];
    let cur: (typeof batch)[number] | null = null;
    const flush = (last: boolean) => { sendIpc({ t: 'page-meta-all', gen, part: part++, since, last, rows: batch }); batch = []; };
    for (let after = ''; ;) {
      const rows = st.all(after) as { key: string; built_at: number; kb: number | null }[];
      if (!rows.length) break;
      for (const r of rows) {
        const hashAt = r.key.indexOf('#');
        if (hashAt < 0) {
          if (cur) batch.push(cur);
          if (batch.length >= 5000) flush(false);
          const e = builtEtags.get(r.key);
          cur = [r.key, r.built_at, {}, e && e.at === r.built_at ? e.etags : undefined];
          n++;
        } else if (cur && cur[0] === r.key.slice(0, hashAt) && cur[1] === r.built_at) {
          const v = r.key.slice(hashAt + 1);
          if (!v.includes('~')) cur[2][v] = r.kb ?? 0; // (the parts of a split view are not views)
        }
      }
      after = rows[rows.length - 1].key;
      await yieldLoop();
    }
    if (cur) batch.push(cur);
    flush(true);
    return n;
  } catch (e: any) { logger.warn(`page list: ${e?.message || e}`); return 0; } finally { listing = false; }
}
// web: the list being received (one generation at a time; a newer one starts over)
let incoming: { gen: number; since: number; parts: number; keys: Set<string> } | null = null;
if (isWeb) onIpc('page-meta-all', m => {
  const gen = Number(m.gen);
  if (Number(m.part) === 0 || !incoming || incoming.gen !== gen) incoming = { gen, since: Number(m.since), parts: 0, keys: new Set() };
  if (incoming.parts !== Number(m.part)) { incoming = null; return; } // a lost part: wait for the next whole list
  incoming.parts++;
  for (const [key, at, kb, etags] of (m.rows as [string, number, Record<string, number>, Record<string, string> | undefined][]) || []) {
    incoming.keys.add(key);
    hotSet(key, { at, kb, etags });
    newerCopy(key, at);
  }
  if (!m.last) return;
  // keys cleaned up since the last list (held from before this list began, not in it) are gone
  for (const [k, h] of hot) if (!incoming.keys.has(k) && h.at < incoming.since) { hot.delete(k); memDel(k); }
  hotStats.lists++;
  hotComplete = hot.size < HOT_MAX;
  logger.info(`stored pages: the worker's list is in (${incoming.keys.size} keys) — page times from memory only`);
  incoming = null;
});
// a worker start (or restart) sends its list a few seconds in; then after every clean-up (cleanPageCache, sweepCopies)
if (isWorker) setTimeout(() => { void sendPageList(); }, Number(process.env.PAGE_LIST_DELAY_MS) || 3000).unref();

if (isWeb) onIpc('page', m => {
  const key = String(m.key);
  if (Number(m.builtAt) > 0) { hotStats.messages++; hotSet(key, { at: Number(m.builtAt), etags: (m.etags as Record<string, string>) || undefined, kb: (m.kb as Record<string, number>) || undefined }); }
  // fix272: the same copy with a new time (the worker only moved built_at): the one held here is still right
  const cur = m.sameAs ? mem.get(key) : undefined;
  if (cur && cur.builtAt === Number(m.sameAs)) { cur.builtAt = Number(m.builtAt); cur.checkedAt = Date.now(); }
  newerCopy(key, Number(m.builtAt));
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
    if (hotComplete) continue; // fix263: etagOf stands in with the build's time
    try { const r = await readSql<any>(ETAG_SQL, [`${key}#${v}`, m.builtAt]); (m.etags ||= new Map()).set(v, r ? r.etag || '' : null); } catch { break; }
  }
  if (!views?.length) return;
  for (const v of views) {
    if (v === 'rows' ? m.rows !== undefined : m.variants.has(v)) continue;
    let r: Awaited<ReturnType<typeof readStored>>;
    // fix263: a view under 64 KB (its size from the worker's list) in the small reader pool, else the big one
    try { r = await readStored(`${key}#${v}`, m.builtAt, poolForBytes(viewBytes(key, v, m.builtAt))); } catch { return; } // the synchronous read, as before
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
    const at = await builtAtAsync(key);
    if (at > m.builtAt) { newerCopy(key, at); m = mem.get(key); } // fix269: a held copy stays until the new one is read
  }
  if (!m) {
    const row = await readRowAsync(key);
    if (row) { m = row; if (!isWorker) memSet(key, row); }
  }
  if (m) {
    const mm = m;
    const over = Date.now() - m.builtAt - freshOf(def, () => bodyOf(key, mm));
    // fix269: a held copy whose newer copy is being read is not asked for again
    if (over > 0 && !((refreshing.get(key) || 0) > m.builtAt)) {
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
 * fix266: the first round after a (re)start: the stale copies first — the lists (pages stored row by row) and the sport
 * homes before the rest — then the copies that are still fresh. On 28 Oct the lists waited behind everything else the
 * worker started with (291 states, the names job) while every request for them went to the worker.
 */
const FIRST_NAMES = new Set(['upcoming', 'bb-games', 'nfl-home', 'tennis-home', 'results', 'record', 'summary']);
function firstOrder(keys: Set<string>, due: (key: string, def: PageDef) => boolean): string[] {
  const rank = (key: string) => {
    const def = defs.get(parseKey(key).name);
    if (!def) return 9;
    const list = !!def.rows || FIRST_NAMES.has(def.name);
    return due(key, def) ? (list ? 0 : 1) : list ? 2 : 3;
  };
  const ranked = [...keys].map(k => [rank(k), k] as const);
  return ranked.sort((a, b) => a[0] - b[0]).map(([, k]) => k); // (a stable sort: each group keeps its order)
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
    for (const key of first ? firstOrder(keys, due) : keys) {
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
  setInterval(() => { cleanPageCache(); void sendPageList(); }, 3600 * 1000).unref(); // fix263: the web's list after each clean-up
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

/**
 * fix258 (worker): stored HTML copies of these pages that `bad` rejects (made for an older build, or without their
 * page's lang / hreflang set) — a kept-fresh page is built again now, an on-demand one dropped (built on its next
 * request). Reads the first 32 KB of each copy's html view, 200 rows a slice with a yield between.
 */
export async function sweepCopies(names: string[], bad: (q: Record<string, string>, head: string) => boolean): Promise<{ checked: number; rebuilt: number; dropped: number }> {
  const out = { checked: 0, rebuilt: 0, dropped: 0 };
  if (!runsJobs) return out;
  const warm = new Set([...defs.values()].flatMap(d => (d.warm || []).map(q => pageKey(d.name, q))));
  // fix263: 32 KB (the page's <head> is ~15 KB with the loader and shell, + the hreflang links: 16 KB cut them off)
  const sel = db.prepare(`SELECT key, substr(json, 1, 32768) AS head FROM page_cache WHERE key > ? AND key < ? AND key LIKE '%#html' ORDER BY key LIMIT 200`);
  const drop = db.prepare(`DELETE FROM page_cache WHERE key = ? OR (key > ? AND key < ?)`);
  for (const name of names) {
    let after = `${name}?`;
    for (;;) {
      const rows = sel.all(after, `${name}?\uffff`) as any[];
      if (!rows.length) break;
      for (const r of rows) {
        after = r.key;
        const key = String(r.key).slice(0, -'#html'.length);
        out.checked++;
        let wrong = false;
        try { wrong = bad(parseKey(key).q, String(r.head || '')); } catch { /* keep it */ }
        if (!wrong) continue;
        if (warm.has(key)) { out.rebuilt++; void buildQueued(key); continue; }
        drop.run(key, `${key}#`, `${key}#\uffff`);
        memDel(key);
        out.dropped++;
      }
      await new Promise<void>(r => setImmediate(r));
    }
  }
  if (out.dropped) void sendPageList(); // fix263: the web drops them from its list
  return out;
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
export const _forgetPageMemory = () => { mem.clear(); memBytes = 0; holdBytes = 0; holdCopies = 0; };
/** tests: a page's definition (fix221: the big-list test swaps the builder for real-size data, keeping the views) */
export const _pageDef = (name: string) => defs.get(name);
/** fix266 (tests): the first round's order */
export const _firstOrder = (keys: string[], stale: (key: string) => boolean) => firstOrder(new Set(keys), key => stale(key));
/** /api/perf: this process's in-memory copies (fix210: capped) */
export const pageMemStatus = () => ({
  copies: mem.size - holdCopies, mb: Math.round(memBytes / 1048576), maxCopies: MEM_MAX, maxMb: Math.round(MEM_MAX_BYTES / 1048576),
  // fix269: the held lists / homes / standings / news / config copies
  held: { copies: holdCopies, mb: Math.round(holdBytes / 1048576), maxMb: Math.round(HOLD_MAX_BYTES / 1048576), refreshing: refreshing.size, ...holdStats },
  // fix272 (worker): builds written vs unchanged (only built_at moved)
  builds: { ...touchStats }
});
/** tests (fix263): every warm key */
export const _warmKeys = () => [...defs.values()].flatMap(d => (d.warm || []).map(q => pageKey(d.name, q)));

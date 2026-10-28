/**
 * fix202: model state built in the worker, read in the web process.
 *
 * The worker builds the models (football v3, Elo, feature model, basketball, NFL, tennis …) and the fixture windows
 * in its own memory. After each build it publishes the part the pages read (`publishState(key, value)`): the value
 * is written to shared_state with v8.serialize (Maps, Sets, typed arrays and nested objects keep their shape) and the
 * web process gets a short IPC message; it reads that one row and hands the value to the module that registered for
 * it (`onState(prefix, apply)`), which swaps it in. Nothing is rebuilt in the web process. A missed message is caught
 * by a version check every 30 s, and on start the web process loads every stored state one at a time, after it
 * listens (the last copy from before a restart serves at once).
 *
 * In one process (WORKER=0) publishState does nothing: the jobs fill the same memory the pages read.
 */
import v8 from 'node:v8';
import { isMainThread, workerData } from 'node:worker_threads';
import { db } from '../db';
import logger from '../utils/logger';
import { isWeb, isWorker, runsJobs } from './role';
import { onIpc, sendIpc } from './ipc';
import { timed, yieldLoop, track } from './perf';
import { readSql, asBuffer, pageReaderOn } from './pageReader';

db.exec(`CREATE TABLE IF NOT EXISTS shared_state (key TEXT PRIMARY KEY, ver INTEGER NOT NULL, at TEXT NOT NULL, bytes INTEGER NOT NULL, ms INTEGER NOT NULL, data BLOB NOT NULL)`);
// fix222: the parts of a big state (see splitBig)
db.exec(`CREATE TABLE IF NOT EXISTS shared_parts (key TEXT NOT NULL, i INTEGER NOT NULL, ver INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, i))`);

/*
 * fix222: a big state (the football window: "state load af" 1.2 s on the web, 25 Oct) is stored in parts: each big
 * top-level list (an array or a Map over PART_BYTES) is cut into slices of ~PART_BYTES, one row each, and the web
 * process reads and deserializes one slice per turn (a yield between), then joins them. The state row itself keeps
 * the rest and a marker naming the parts.
 */
const PART_BYTES = Number(process.env.STATE_PART_KB || 256) * 1024;
const PARTS = '__sharedParts';
// fix248: 'o' = a plain object cut by its entries (a big object of leagues / teams was one deserialize on the web)
type Kind = 'a' | 'm' | 'o';
type Marker = { n: number; ver: number; fields: Record<string, Kind> };
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
function splitBig(value: unknown): { head: unknown; parts: Buffer[]; fields: Record<string, Kind> } {
  const parts: Buffer[] = [], fields: Record<string, Kind> = {};
  if (!isPlain(value)) return { head: value, parts, fields };
  let head: Record<string, unknown> | null = null;
  for (const [f, v] of Object.entries(value)) {
    const kind: Kind | null = Array.isArray(v) ? 'a' : v instanceof Map ? 'm' : isPlain(v) ? 'o' : null;
    if (!kind) continue;
    const items: unknown[] = kind === 'a' ? (v as unknown[]) : kind === 'm' ? [...(v as Map<unknown, unknown>).entries()] : Object.entries(v as object);
    // fix248: from 2 items (a Map of 20 leagues over 256 KB was kept whole: one long deserialize)
    if (items.length < 2) continue;
    const size = v8.serialize(items).length;
    if (size <= PART_BYTES) continue;
    const per = Math.max(1, Math.floor((items.length * PART_BYTES) / size));
    for (let i = 0; i < items.length; i += per) parts.push(v8.serialize({ f, x: items.slice(i, i + per) }));
    fields[f] = kind;
    if (!head) head = { ...(value as Record<string, unknown>) };
    head[f] = null;
  }
  return { head: head || value, parts, fields };
}
const emptyOf = (t: Kind) => (t === 'a' ? [] : t === 'm' ? new Map() : {});
const addTo = (dst: any, t: Kind, x: any[]) => {
  if (t === 'a') for (const it of x) dst.push(it);
  else if (t === 'm') for (const [k, v] of x) dst.set(k, v);
  else for (const [k, v] of x) dst[k] = v;
};
/**
 * the whole value from its state row and parts (each part read when asked: `part(i)` → its bytes, or null = replaced).
 * fix248: `step` gets each deserialize's time (the longest is in /api/perf shared: what still blocks the web).
 */
async function joinParts(head: any, part: (i: number) => Buffer | null | Promise<Buffer | null>, pause: () => Promise<void>, step?: (ms: number) => void): Promise<unknown | null> {
  const mk: Marker | undefined = head?.[PARTS];
  if (!mk) return head;
  const out: Record<string, any> = { ...head };
  delete out[PARTS];
  for (const [f, t] of Object.entries(mk.fields)) out[f] = emptyOf(t);
  for (let i = 0; i < mk.n; i++) {
    const b = await part(i);
    if (!b) return null;
    const t0 = performance.now();
    const { f, x } = v8.deserialize(b) as { f: string; x: any[] };
    addTo(out[f], mk.fields[f], x);
    step?.(performance.now() - t0);
    await pause();
  }
  return out;
}
const PART_SQL = `SELECT data FROM shared_parts WHERE key = ? AND i = ? AND ver = ?`;
const partReader = (key: string, ver: number) => {
  const q = db.prepare(PART_SQL);
  return (i: number) => { const r: any = q.get(key, i, ver); return r ? Buffer.from(r.data) : null; };
};
/** fix248 (web): the same, read in the reader thread (services/pageReader.ts): no SQLite read of a big row on the web thread */
const partReaderOff = (key: string, ver: number) => async (i: number) => {
  const r = await readSql<{ data: Uint8Array } | null>(PART_SQL, [key, i, ver]);
  return r ? asBuffer(r.data) : null;
};

// fix210b: an applier may return a promise (its async part: the NFL engine joins its games); loads wait for it
type Apply = (key: string, value: any) => void | Promise<void>;
const appliers: { prefix: string; apply: Apply }[] = [];
// fix248: maxStepMs = the longest single deserialize on the web thread for that state (the head or one part)
const applied = new Map<string, { ver: number; at: number; ms: number; bytes: number; maxStepMs?: number }>();
const published = new Map<string, { ver: number; at: number; ms: number; bytes: number }>();
let lastVer = 0;

/*
 * fix210: inside a job thread (services/threadJob.ts) a publish goes to the thread's caller (the worker's main thread),
 * which applies it there and publishes it to the web process.
 */
const IN_JOB_THREAD = !isMainThread && !!workerData?.jobThread;
let capture: ((key: string, value: unknown) => void) | null = null;
export const onCaptured = (fn: (key: string, value: unknown) => void) => { capture = fn; };

/** worker: store `value` under `key` and tell the web process (no-op in one process / in the web process). */
export function publishState(key: string, value: unknown): void {
  if (IN_JOB_THREAD) { capture?.(key, value); return; }
  if (!isWorker) return;
  const t0 = Date.now();
  const done = track(`state publish ${key.split(':').slice(0, 2).join(':')}`); // fix210b: named in /api/perf
  try {
    const ver = (lastVer = Math.max(lastVer + 1, t0));
    const { head, parts, fields } = splitBig(value);
    const buf = v8.serialize(parts.length ? { ...(head as object), [PARTS]: { n: parts.length, ver, fields } satisfies Marker } : head);
    const bytes = buf.length + parts.reduce((s, b) => s + b.length, 0);
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM shared_parts WHERE key = ?`).run(key);
      const ins = db.prepare(`INSERT INTO shared_parts (key, i, ver, data) VALUES (?, ?, ?, ?)`);
      parts.forEach((b, i) => ins.run(key, i, ver, b));
      db.prepare(`INSERT INTO shared_state (key, ver, at, bytes, ms, data) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET ver = excluded.ver, at = excluded.at, bytes = excluded.bytes, ms = excluded.ms, data = excluded.data`)
        .run(key, ver, new Date(t0).toISOString(), bytes, Date.now() - t0, buf);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    published.set(key, { ver, at: t0, ms: Date.now() - t0, bytes });
    sendIpc({ t: 'state', key, ver });
  } catch (e: any) {
    logger.warn(`shared state ${key}: ${e?.message || e}`);
  } finally { done(); }
}

/** web: `apply(key, value)` for every state whose key starts with `prefix` (registered at module load). */
export function onState(prefix: string, apply: Apply): void {
  appliers.push({ prefix, apply });
}
const applyHere = (key: string, value: unknown) => { for (const a of appliers) if (key === a.prefix || key.startsWith(a.prefix)) void a.apply(key, value); };
/**
 * fix210 (worker / one process): a state built in a job thread — applied in this process by the same code the web
 * process uses, then published (stored + the web process told) as if it had been built here.
 */
export function applyState(key: string, value: unknown) {
  applyHere(key, value);
  publishState(key, value);
}
/** fix210 (job thread): the last published copies of these states, applied before a build (e.g. the other leagues' models) */
export function applyStored(prefix: string) {
  for (const r of db.prepare(`SELECT key, ver, data FROM shared_state WHERE key LIKE ? ORDER BY key`).all(`${prefix}%`) as any[]) {
    try {
      // (a job thread, before its build: the parts are joined in one go — nothing waits on this thread)
      const head: any = v8.deserialize(Buffer.from(r.data));
      const mk: Marker | undefined = head?.[PARTS];
      if (!mk) { applyHere(r.key, head); continue; }
      const read = partReader(r.key, mk.ver);
      const out: Record<string, any> = { ...head };
      delete out[PARTS];
      for (const [f, t] of Object.entries(mk.fields)) out[f] = emptyOf(t);
      let whole = true;
      for (let i = 0; i < mk.n && whole; i++) {
        const b = read(i);
        if (!b) { whole = false; break; }
        const { f, x } = v8.deserialize(b) as { f: string; x: any[] };
        addTo(out[f], mk.fields[f], x);
      }
      if (whole) applyHere(r.key, out);
    } catch (e: any) { logger.warn(`shared state ${r.key}: ${e?.message || e}`); }
  }
}

const wanted = (key: string) => appliers.some(a => key === a.prefix || key.startsWith(a.prefix));

// one load at a time (a big state is one synchronous deserialize: never two in the same turn)
let chain: Promise<void> = Promise.resolve();
const queued = new Set<string>();
function queueLoad(key: string, ver?: number) {
  if (!isWeb || queued.has(key) || !wanted(key)) return;
  if (ver != null && (applied.get(key)?.ver || 0) >= ver) return;
  queued.add(key);
  chain = chain.then(async () => {
    queued.delete(key);
    await yieldLoop();
    await timed(`state load ${key.split(':')[0]}`, () => loadNow(key));
  }).catch(e => { logger.warn(`shared state load ${key}: ${e?.message || e}`); });
}

const ROW_SQL = `SELECT ver, bytes, data FROM shared_state WHERE key = ?`;
/*
 * fix249: the version list from a covering index. Without it every row was visited for its ver (the rows hold the
 * states themselves, MBs each): "SELECT key, ver FROM shared_state ORDER BY key" 5.5 s in the reader thread, 27 Oct.
 */
const VERS_IDX = 'idx_shared_state_ver';
if (runsJobs && isMainThread) db.exec(`CREATE INDEX IF NOT EXISTS ${VERS_IDX} ON shared_state(key, ver)`);
let versIdx = false;
const versSql = () => {
  if (!versIdx) { try { versIdx = !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = ?`).get(VERS_IDX); } catch { /* next time */ } }
  return versIdx ? `SELECT key, ver FROM shared_state INDEXED BY ${VERS_IDX} ORDER BY key` : `SELECT key, ver FROM shared_state ORDER BY key`;
};
/*
 * fix248: the CPU profile of 26 Oct showed the web thread's stalls in these reads (`all` 0.8 s from loadNewerStates on
 * the 30-s timer, `get` in loadNow and the part reader 1.1 s): every shared_state / shared_parts read is done in the
 * reader thread now; the web thread only deserializes, one part (≤ 256 KB) per turn. The synchronous read stays as
 * the fallback when the thread is not there (PAGE_READER=0, it failed).
 */
async function loadNow(key: string) {
  let off = pageReaderOn();
  let row: any;
  if (off) { try { row = await readSql(ROW_SQL, [key]); } catch { off = false; } }
  if (!off) row = db.prepare(ROW_SQL).get(key);
  if (!row || (applied.get(key)?.ver || 0) >= row.ver) return;
  const t0 = Date.now();
  let maxStepMs = 0;
  const step = (ms: number) => { if (ms > maxStepMs) maxStepMs = ms; };
  // fix222: a big state comes in parts, one deserialized per turn (null = the worker replaced it meanwhile: next round)
  const h0 = performance.now();
  const head = v8.deserialize(off ? asBuffer(row.data) : Buffer.from(row.data));
  step(performance.now() - h0);
  await yieldLoop();
  const value = await joinParts(head, off ? partReaderOff(key, row.ver) : partReader(key, row.ver), yieldLoop, step);
  if (value === null) { setTimeout(() => queueLoad(key), 1000).unref(); return; }
  await yieldLoop();
  for (const a of appliers) if (key === a.prefix || key.startsWith(a.prefix)) { await a.apply(key, value); await yieldLoop(); }
  applied.set(key, { ver: row.ver, at: Date.now(), ms: Date.now() - t0, bytes: row.bytes, maxStepMs: Math.round(maxStepMs) });
}

/*
 * fix254: the version list lives in memory. The worker holds every key's version (read once at its start, then each
 * publish) and sends the whole list every 30 s; the web compares it with what it applied — the 30-s check never reads
 * the disk while the worker is there ("SELECT key, ver FROM shared_state" 1.7–1.9 s on 28 Oct). The read from the table
 * stays for the start-up and for when no list came for 90 s (the worker restarting).
 */
const vers = new Map<string, number>();
let versLoaded = false;
let versAt = 0;
function workerVers(): [string, number][] {
  if (!versLoaded) {
    try { for (const r of db.prepare(versSql()).all() as any[]) if (!vers.has(r.key) || vers.get(r.key)! < r.ver) vers.set(r.key, r.ver); versLoaded = true; } catch { /* next round */ }
  }
  for (const [k, p] of published) if ((vers.get(k) || 0) < p.ver) vers.set(k, p.ver);
  return [...vers];
}
/** web: the worker's list arrived — load what is newer */
export function applyVers(list: [string, number][]) {
  versAt = Date.now();
  for (const [k, v] of list) queueLoad(k, v);
}
export const versFromWorker = () => Date.now() - versAt < 90_000;

/** web: every state newer than what this process holds (start-up, and the 30-s check for missed messages) */
export async function loadNewerStates(force = false): Promise<void> {
  if (!isWeb) return;
  if (!force && versFromWorker()) return chain;
  let rows: { key: string; ver: number }[];
  const sql = versSql();
  try { rows = pageReaderOn() ? await readSql(sql, [], true) : (db.prepare(sql).all() as any[]); } catch { rows = db.prepare(sql).all() as any[]; }
  for (const r of rows) queueLoad(r.key, r.ver);
  return chain;
}

if (isWeb) {
  onIpc('state', m => queueLoad(String(m.key), Number(m.ver)));
  onIpc('state-vers', m => { if (Array.isArray(m.vers)) applyVers(m.vers as [string, number][]); });
  setInterval(() => { void loadNewerStates(); }, 30 * 1000).unref();
}
if (isWorker) setInterval(() => { try { sendIpc({ t: 'state-vers', vers: workerVers() }); } catch { /* next round */ } }, 30 * 1000).unref();

/** worker: the last copy a key was published with (a module skips a publish when nothing changed) */
export const publishedAt = (key: string) => published.get(key)?.at || 0;

/** /api/perf: what was published (worker) / applied (web), with sizes and times */
export function sharedStatus() {
  const map = isWorker ? published : applied;
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([k, v]) => [k, { ...v, at: new Date(v.at).toISOString(), kb: Math.round(v.bytes / 1024) }]));
}

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
import { isWeb, isWorker } from './role';
import { onIpc, sendIpc } from './ipc';
import { timed, yieldLoop, track } from './perf';

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
type Marker = { n: number; ver: number; fields: Record<string, 'a' | 'm'> };
function splitBig(value: unknown): { head: unknown; parts: Buffer[]; fields: Record<string, 'a' | 'm'> } {
  const parts: Buffer[] = [], fields: Record<string, 'a' | 'm'> = {};
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return { head: value, parts, fields };
  let head: Record<string, unknown> | null = null;
  for (const [f, v] of Object.entries(value as Record<string, unknown>)) {
    const isA = Array.isArray(v), isM = v instanceof Map;
    if (!(isA || isM)) continue;
    const items: unknown[] = isA ? (v as unknown[]) : [...(v as Map<unknown, unknown>).entries()];
    if (items.length < 50) continue;
    const size = v8.serialize(items).length;
    if (size <= PART_BYTES) continue;
    const per = Math.max(1, Math.floor((items.length * PART_BYTES) / size));
    for (let i = 0; i < items.length; i += per) parts.push(v8.serialize({ f, x: items.slice(i, i + per) }));
    fields[f] = isA ? 'a' : 'm';
    if (!head) head = { ...(value as Record<string, unknown>) };
    head[f] = null;
  }
  return { head: head || value, parts, fields };
}
/** the whole value from its state row and parts (each part read when asked: `part(i)` → its bytes, or null = replaced) */
async function joinParts(head: any, part: (i: number) => Buffer | null, pause: () => Promise<void>): Promise<unknown | null> {
  const mk: Marker | undefined = head?.[PARTS];
  if (!mk) return head;
  const out: Record<string, any> = { ...head };
  delete out[PARTS];
  for (const [f, t] of Object.entries(mk.fields)) out[f] = t === 'a' ? [] : new Map();
  for (let i = 0; i < mk.n; i++) {
    const b = part(i);
    if (!b) return null;
    const { f, x } = v8.deserialize(b) as { f: string; x: any[] };
    const dst = out[f];
    if (Array.isArray(dst)) for (const it of x) dst.push(it); else for (const [k, v] of x) dst.set(k, v);
    await pause();
  }
  return out;
}
const partReader = (key: string, ver: number) => {
  const q = db.prepare(`SELECT data FROM shared_parts WHERE key = ? AND i = ? AND ver = ?`);
  return (i: number) => { const r: any = q.get(key, i, ver); return r ? Buffer.from(r.data) : null; };
};

// fix210b: an applier may return a promise (its async part: the NFL engine joins its games); loads wait for it
type Apply = (key: string, value: any) => void | Promise<void>;
const appliers: { prefix: string; apply: Apply }[] = [];
const applied = new Map<string, { ver: number; at: number; ms: number; bytes: number }>();
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
      for (const [f, t] of Object.entries(mk.fields)) out[f] = t === 'a' ? [] : new Map();
      let whole = true;
      for (let i = 0; i < mk.n && whole; i++) {
        const b = read(i);
        if (!b) { whole = false; break; }
        const { f, x } = v8.deserialize(b) as { f: string; x: any[] };
        if (Array.isArray(out[f])) for (const it of x) out[f].push(it); else for (const [k, v] of x) out[f].set(k, v);
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

async function loadNow(key: string) {
  const row: any = db.prepare(`SELECT ver, bytes, data FROM shared_state WHERE key = ?`).get(key);
  if (!row || (applied.get(key)?.ver || 0) >= row.ver) return;
  const t0 = Date.now();
  // fix222: a big state comes in parts, one deserialized per turn (null = the worker replaced it meanwhile: next round)
  const value = await joinParts(v8.deserialize(Buffer.from(row.data)), partReader(key, row.ver), yieldLoop);
  if (value === null) { setTimeout(() => queueLoad(key), 1000).unref(); return; }
  await yieldLoop();
  for (const a of appliers) if (key === a.prefix || key.startsWith(a.prefix)) { await a.apply(key, value); await yieldLoop(); }
  applied.set(key, { ver: row.ver, at: Date.now(), ms: Date.now() - t0, bytes: row.bytes });
}

/** web: every state newer than what this process holds (start-up, and the 30-s check for missed messages) */
export function loadNewerStates(): Promise<void> {
  if (!isWeb) return Promise.resolve();
  const rows = db.prepare(`SELECT key, ver FROM shared_state ORDER BY key`).all() as { key: string; ver: number }[];
  for (const r of rows) queueLoad(r.key, r.ver);
  return chain;
}

if (isWeb) {
  onIpc('state', m => queueLoad(String(m.key), Number(m.ver)));
  setInterval(() => { void loadNewerStates(); }, 30 * 1000).unref();
}

/** worker: the last copy a key was published with (a module skips a publish when nothing changed) */
export const publishedAt = (key: string) => published.get(key)?.at || 0;

/** /api/perf: what was published (worker) / applied (web), with sizes and times */
export function sharedStatus() {
  const map = isWorker ? published : applied;
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([k, v]) => [k, { ...v, at: new Date(v.at).toISOString(), kb: Math.round(v.bytes / 1024) }]));
}

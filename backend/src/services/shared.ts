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
    const buf = v8.serialize(value);
    const ver = (lastVer = Math.max(lastVer + 1, t0));
    db.prepare(`INSERT INTO shared_state (key, ver, at, bytes, ms, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET ver = excluded.ver, at = excluded.at, bytes = excluded.bytes, ms = excluded.ms, data = excluded.data`)
      .run(key, ver, new Date(t0).toISOString(), buf.length, Date.now() - t0, buf);
    published.set(key, { ver, at: t0, ms: Date.now() - t0, bytes: buf.length });
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
  for (const r of db.prepare(`SELECT key, data FROM shared_state WHERE key LIKE ? ORDER BY key`).all(`${prefix}%`) as any[]) {
    try { applyHere(r.key, v8.deserialize(Buffer.from(r.data))); } catch (e: any) { logger.warn(`shared state ${r.key}: ${e?.message || e}`); }
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
  const value = v8.deserialize(Buffer.from(row.data));
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

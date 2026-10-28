/**
 * fix243: the web process's stored-view reader (services/pageReader.ts). A stored view is a ready-made string (the
 * upcoming list's 'anon' copy is several MB, a crawler page's HTML + gzip copy a few hundred KB); reading it with the
 * main connection blocked the web thread for as long as the disk took ("stored upcoming: read" 1–2 s, crawler bursts
 * 3–6 s, 26 Oct). Here it is read with this thread's own read-only connection; the main thread only gets the result.
 *
 * fix248: every other read the web did on big rows comes here too (the CPU profile of 26 Oct: `get` / `all` on the
 * web thread = 2.2 s + 0.8 s of the stalls): a stored page's time / ETag, the kept copies of worker routes, the shared
 * states (versions, rows, parts) and paged table reads. `sql` messages run one prepared read-only statement.
 * fix250: each answer says how long the read itself took here and how many bytes it returned (the slow-read log).
 */
import { parentPort, workerData } from 'node:worker_threads';
import sqlite from 'node:sqlite';
import { tuneDb } from '../utils/dbTune';

const db = new sqlite.DatabaseSync(String(workerData.file), { readOnly: true });
try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* read-only: the default */ }
// fix254: 256 MB page cache + the file memory-mapped (the hot index pages stay in memory: no 1.8-s one-row reads)
// fix263: the small pool's threads read index pages and small rows: a smaller cache (services/pageReader.ts pools)
// fix269: big 1 GB / small 512 MB a thread (utils/dbTune.ts); workerData.readers = { small, big }
if (workerData.pool === 'small') tuneDb(db, 'readerSmall', workerData.readers);
else tuneDb(db, 'reader', workerData.readers);
// (prepared on first use: a fresh database may not have page_cache yet)
let oneSt: any = null;
const one = () => (oneSt ||= db.prepare(`SELECT json, etag, gz FROM page_cache WHERE key = ? AND built_at = ?`));
const stmts = new Map<string, any>();
const stmt = (sql: string) => {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); if (stmts.size > 200) stmts.clear(); stmts.set(sql, s); }
  return s;
};
const sizeOf = (v: unknown): number => typeof v === 'string' ? v.length : v instanceof Uint8Array ? v.byteLength : typeof v === 'number' ? 8 : 0;
const rowBytes = (r: any) => { let n = 0; if (r) for (const k in r) n += sizeOf(r[k]); return n; };

type Msg = { id: number; key: string; builtAt: number; sql?: undefined } | { id: number; sql: string; args: (string | number | null)[]; all?: boolean };
parentPort!.on('message', (m: Msg) => {
  const t0 = performance.now();
  try {
    if (m.sql !== undefined) {
      const s = stmt(m.sql);
      const out = m.all ? s.all(...m.args) : (s.get(...m.args) ?? null);
      const bytes = Array.isArray(out) ? out.reduce((n: number, r: any) => n + rowBytes(r), 0) : rowBytes(out);
      parentPort!.postMessage({ id: m.id, out, ms: performance.now() - t0, bytes });
      return;
    }
    const r: any = one().get(m.key, m.builtAt);
    parentPort!.postMessage({ id: m.id, row: r ? { text: r.json, etag: r.etag ?? null, gz: r.gz ?? null } : null, ms: performance.now() - t0, bytes: rowBytes(r) });
  } catch (e: any) {
    // a table the web reads may not exist yet on a fresh database: the statement is prepared again next time
    if (m.sql !== undefined) stmts.delete(m.sql);
    parentPort!.postMessage({ id: m.id, error: String(e?.message || e) });
  }
});

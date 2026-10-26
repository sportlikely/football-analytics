/**
 * fix243: the web process's stored-view reader (services/pageReader.ts). A stored view is a ready-made string (the
 * upcoming list's 'anon' copy is several MB, a crawler page's HTML + gzip copy a few hundred KB); reading it with the
 * main connection blocked the web thread for as long as the disk took ("stored upcoming: read" 1–2 s, crawler bursts
 * 3–6 s, 26 Oct). Here it is read with this thread's own read-only connection; the main thread only gets the result.
 *
 * fix248: every other read the web did on big rows comes here too (the CPU profile of 26 Oct: `get` / `all` on the
 * web thread = 2.2 s + 0.8 s of the stalls): a stored page's time / ETag, the kept copies of worker routes, the shared
 * states (versions, rows, parts) and paged table reads. `sql` messages run one prepared read-only statement.
 */
import { parentPort, workerData } from 'node:worker_threads';
import sqlite from 'node:sqlite';

const db = new sqlite.DatabaseSync(String(workerData.file), { readOnly: true });
try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* read-only: the default */ }
const one = db.prepare(`SELECT json, etag, gz FROM page_cache WHERE key = ? AND built_at = ?`);
const stmts = new Map<string, any>();
const stmt = (sql: string) => {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); if (stmts.size > 200) stmts.clear(); stmts.set(sql, s); }
  return s;
};

type Msg = { id: number; key: string; builtAt: number; sql?: undefined } | { id: number; sql: string; args: (string | number | null)[]; all?: boolean };
parentPort!.on('message', (m: Msg) => {
  try {
    if (m.sql !== undefined) {
      const s = stmt(m.sql);
      const out = m.all ? s.all(...m.args) : (s.get(...m.args) ?? null);
      parentPort!.postMessage({ id: m.id, out });
      return;
    }
    const r: any = one.get(m.key, m.builtAt);
    parentPort!.postMessage({ id: m.id, row: r ? { text: r.json, etag: r.etag ?? null, gz: r.gz ?? null } : null });
  } catch (e: any) {
    // a table the web reads may not exist yet on a fresh database: the statement is prepared again next time
    if (m.sql !== undefined) stmts.delete(m.sql);
    parentPort!.postMessage({ id: m.id, error: String(e?.message || e) });
  }
});

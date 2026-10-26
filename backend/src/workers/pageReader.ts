/**
 * fix243: the web process's stored-view reader (services/pageReader.ts). A stored view is a ready-made string (the
 * upcoming list's 'anon' copy is several MB, a crawler page's HTML + gzip copy a few hundred KB); reading it with the
 * main connection blocked the web thread for as long as the disk took ("stored upcoming: read" 1–2 s, crawler bursts
 * 3–6 s, 26 Oct). Here it is read with this thread's own read-only connection; the main thread only gets the result.
 */
import { parentPort, workerData } from 'node:worker_threads';
import sqlite from 'node:sqlite';

const db = new sqlite.DatabaseSync(String(workerData.file), { readOnly: true });
try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* read-only: the default */ }
const one = db.prepare(`SELECT json, etag, gz FROM page_cache WHERE key = ? AND built_at = ?`);

parentPort!.on('message', (m: { id: number; key: string; builtAt: number }) => {
  try {
    const r: any = one.get(m.key, m.builtAt);
    parentPort!.postMessage({ id: m.id, row: r ? { text: r.json, etag: r.etag ?? null, gz: r.gz ?? null } : null });
  } catch (e: any) {
    parentPort!.postMessage({ id: m.id, error: String(e?.message || e) });
  }
});

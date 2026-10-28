/**
 * fix249: the worker's database upkeep thread (services/dbSpace.ts) — its own connection, so a checkpoint that waits
 * for readers, the daily size report (dbstat walks every page) or a vacuum slice never runs on the worker's thread.
 * One message at a time: { op: 'checkpoint' | 'report' | 'incremental' | 'convert' | 'pragmas' }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import sqlite from 'node:sqlite';

const db = new sqlite.DatabaseSync(String(workerData.file));
db.exec('PRAGMA busy_timeout = 1000');
// fix269: synchronous NORMAL like every connection (a checkpoint still syncs the database file before the WAL starts over)
db.exec('PRAGMA synchronous = NORMAL');
// the WAL is cut back to this size when it starts over (a checkpoint that caught up)
db.exec(`PRAGMA journal_size_limit = ${Number(workerData.walLimit) || 64 * 1048576}`);

const pragma = (name: string) => { const r: any = db.prepare(`PRAGMA ${name}`).get(); return r ? Number(Object.values(r)[0]) : 0; };
const pragmas = () => ({ pageSize: pragma('page_size'), pages: pragma('page_count'), freePages: pragma('freelist_count'), autoVacuum: pragma('auto_vacuum') });

type Msg = { id: number; op: 'checkpoint'; mode: 'PASSIVE' | 'TRUNCATE'; busyMs?: number } | { id: number; op: 'report' } | { id: number; op: 'incremental'; pages: number } | { id: number; op: 'convert' } | { id: number; op: 'pragmas' };

parentPort!.on('message', (m: Msg) => {
  const t0 = performance.now();
  try {
    let out: unknown;
    if (m.op === 'checkpoint') {
      // PASSIVE first: it copies the WAL back without any lock (writers go on). TRUNCATE takes the writer lock BEFORE it
      // copies, so it only runs once PASSIVE caught up (little left to copy), with a short wait for old readers
      db.exec('PRAGMA busy_timeout = 0');
      let r: any = db.prepare(`PRAGMA wal_checkpoint(PASSIVE)`).get();
      let busy = Number(r?.busy ?? 0);
      if (m.mode === 'TRUNCATE') {
        if (Number(r?.log ?? 0) === Number(r?.checkpointed ?? 0)) {
          db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.min(2000, m.busyMs ?? 300))}`);
          r = db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
          busy = Number(r?.busy ?? 0);
        } else busy = 1; // a reader on an old snapshot keeps frames: the WAL cannot start over
      }
      db.exec('PRAGMA busy_timeout = 1000');
      out = { busy, log: Number(r?.log ?? 0), checkpointed: Number(r?.checkpointed ?? 0) };
    } else if (m.op === 'report') {
      // bytes and rows per table / index (rows: leaf cells of a table; every cell of an index)
      const rows = db.prepare(`SELECT s.name AS name, m.type AS type, m.tbl_name AS tbl, SUM(s.pgsize) AS bytes,
          SUM(CASE WHEN s.pagetype = 'leaf' OR (m.type = 'index' AND s.pagetype = 'internal') THEN s.ncell ELSE 0 END) AS cells,
          COUNT(*) AS pages, SUM(s.unused) AS unused
        FROM dbstat s LEFT JOIN sqlite_master m ON m.name = s.name GROUP BY s.name ORDER BY bytes DESC`).all();
      out = { rows, ...pragmas() };
    } else if (m.op === 'incremental') {
      db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(m.pages))})`);
      out = pragmas();
    } else if (m.op === 'convert') {
      // the one full VACUUM that turns incremental vacuum on (auto_vacuum can only change through a VACUUM)
      db.exec('PRAGMA busy_timeout = 10000');
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
      db.exec('PRAGMA busy_timeout = 1000');
      out = pragmas();
    } else out = pragmas();
    parentPort!.postMessage({ id: m.id, out, ms: performance.now() - t0 });
  } catch (e: any) {
    try { db.exec('PRAGMA busy_timeout = 1000'); } catch { /* ignore */ }
    parentPort!.postMessage({ id: m.id, error: String(e?.message || e), ms: performance.now() - t0 });
  }
});

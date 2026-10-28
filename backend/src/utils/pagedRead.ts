/**
 * fix210b: read a whole table in pages of `size` rows (by rowid) with a yield between, so a reload of a big table
 * (squad values, club value history …) never blocks the thread in one go.
 * fix248: on the web the pages are read in the reader thread (services/pageReader.ts) and handed over 200 rows at a
 * time: the CPU profile of 26 Oct had eachRowPaged / squadValues' row loop inside the web stalls.
 */
import { db } from '../db';
import { yieldLoop } from '../services/perf';
import { isWeb } from '../services/role';
import { readSql, pageReaderOn } from '../services/pageReader';

export async function eachRowPaged(table: string, cols: string, onRow: (r: any) => void, size = 500): Promise<void> {
  const sql = `SELECT rowid AS rid, ${cols} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${isWeb ? 200 : size}`;
  let off = isWeb && pageReaderOn();
  const st = off ? null : db.prepare(sql);
  for (let after = 0; ;) {
    let rows: any[];
    if (off) { try { rows = await readSql<any[]>(sql, [after], true, 'big'); /* fix263: the big pool */ } catch { off = false; rows = db.prepare(sql).all(after) as any[]; } }
    else rows = (st ?? db.prepare(sql)).all(after) as any[];
    if (!rows.length) return;
    for (const r of rows) onRow(r);
    after = rows[rows.length - 1].rid;
    await yieldLoop();
  }
}

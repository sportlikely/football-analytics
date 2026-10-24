/**
 * fix210b: read a whole table in pages of `size` rows (by rowid) with a yield between, so a reload of a big table
 * (squad values, club value history …) never blocks the thread in one go.
 */
import { db } from '../db';
import { yieldLoop } from '../services/perf';

export async function eachRowPaged(table: string, cols: string, onRow: (r: any) => void, size = 500): Promise<void> {
  const st = db.prepare(`SELECT rowid AS rid, ${cols} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${size}`);
  for (let after = 0; ;) {
    const rows = st.all(after) as any[];
    if (!rows.length) return;
    for (const r of rows) onRow(r);
    after = rows[rows.length - 1].rid;
    await yieldLoop();
  }
}

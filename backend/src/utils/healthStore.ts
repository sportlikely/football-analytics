/**
 * fix200: the stored data-health report. The 5-minute background job writes it (save), /api/data-health, the admin
 * card and the daily email read it (read) — the checks never run on a request (they stalled the server 5.8 s).
 * No imports: the database is passed in (scripts/data-health-store.test.ts uses an in-memory one).
 */
export interface HealthDb { exec(sql: string): void; prepare(sql: string): { run(...a: any[]): unknown; get(...a: any[]): any } }
export interface StoredReport { level: 'ok' | 'warn' | 'fail'; at: string; checks: { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] }[] }

/** fix259: the last 3 values of each check (newest first), for "Copy for Claude" */
export type HealthHistory = Record<string, { at: string; level: 'ok' | 'warn' | 'fail'; detail: string }[]>;
export const HISTORY_KEEP = 3;
/** the history after one more report: each check's value in front, detail cut to 300 characters, gone checks dropped */
export function addToHistory(h: HealthHistory, r: StoredReport): HealthHistory {
  const out: HealthHistory = {};
  for (const c of r.checks) out[c.id] = [{ at: r.at, level: c.level, detail: String(c.detail).slice(0, 300) }, ...(h[c.id] || [])].slice(0, HISTORY_KEEP);
  return out;
}

export function createHealthStore(db: HealthDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS data_health_store (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS data_health_hist (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
  let mem: StoredReport | null = null;
  let hist: HealthHistory | null = null;
  const readHist = (): HealthHistory => {
    if (hist) return hist;
    try { const row = db.prepare(`SELECT json FROM data_health_hist WHERE id = 1`).get(); hist = row?.json ? JSON.parse(row.json) : {}; } catch { hist = {}; }
    return hist!;
  };
  return {
    save(r: StoredReport) {
      mem = r;
      db.prepare(`INSERT OR REPLACE INTO data_health_store (id, json, at) VALUES (1, ?, ?)`).run(JSON.stringify(r), r.at);
      hist = addToHistory(readHist(), r);
      db.prepare(`INSERT OR REPLACE INTO data_health_hist (id, json) VALUES (1, ?)`).run(JSON.stringify(hist));
    },
    /** fix259: the last 3 values of a check, newest first */
    history(id: string) { return readHist()[id] || []; },
    /** the last report (memory first, else the database: right after a restart) or null */
    read(): StoredReport | null {
      if (mem) return mem;
      try {
        const row = db.prepare(`SELECT json FROM data_health_store WHERE id = 1`).get();
        if (row?.json) mem = JSON.parse(row.json);
      } catch { /* none yet */ }
      return mem;
    }
  };
}

/** What the endpoint returns before the first run after a fresh database (the job runs a minute after start). */
export const NOT_YET: StoredReport = {
  level: 'warn', at: new Date(0).toISOString(),
  checks: [{ id: 'pending', label: 'Data health', level: 'warn', detail: 'The first check runs about a minute after the server starts (then every 5 minutes)' }]
};

/**
 * fix200: the stored data-health report. The 5-minute background job writes it (save), /api/data-health, the admin
 * card and the daily email read it (read) — the checks never run on a request (they stalled the server 5.8 s).
 * No imports: the database is passed in (scripts/data-health-store.test.ts uses an in-memory one).
 */
export interface HealthDb { exec(sql: string): void; prepare(sql: string): { run(...a: any[]): unknown; get(...a: any[]): any } }
export interface StoredReport { level: 'ok' | 'warn' | 'fail'; at: string; checks: { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] }[] }

export function createHealthStore(db: HealthDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS data_health_store (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL)`);
  let mem: StoredReport | null = null;
  return {
    save(r: StoredReport) {
      mem = r;
      db.prepare(`INSERT OR REPLACE INTO data_health_store (id, json, at) VALUES (1, ?, ?)`).run(JSON.stringify(r), r.at);
    },
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

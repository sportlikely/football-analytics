/**
 * fix169: football player ids the provider doesn't have (old links that crawlers keep following). The API answers a
 * quiet 404 and logs the id once (it used to log "Player page failed" as an error several times an hour), and the
 * crawler page for /player/<id> says "not found" with noindex. Football player pages are not in the sitemap.
 */
import { db } from '../db';

db.exec(`CREATE TABLE IF NOT EXISTS missing_players (player_id INTEGER PRIMARY KEY, first_at TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1)`);
const seen = new Set<number>((db.prepare(`SELECT player_id FROM missing_players`).all() as any[]).map(r => r.player_id));

/** Remember a missing player; true the first time (log it then). */
export function markMissingPlayer(id: number): boolean {
  if (!Number.isFinite(id) || id <= 0) return false;
  if (seen.has(id)) {
    try { db.prepare(`UPDATE missing_players SET hits = hits + 1 WHERE player_id = ?`).run(id); } catch { /* read-only copy */ }
    return false;
  }
  seen.add(id);
  try { db.prepare(`INSERT OR IGNORE INTO missing_players (player_id, first_at) VALUES (?, ?)`).run(id, new Date().toISOString()); } catch { /* read-only copy */ }
  return true;
}
export const isMissingPlayer = (id: number) => seen.has(id);

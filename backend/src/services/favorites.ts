/**
 * Favorite leagues, teams and players, per signed-in user.
 * Visitors keep favorites in their browser; when they sign in, the browser list is merged into the account
 * so favorites follow them to every device.
 */
import { db } from '../db';
import { officialPhoto } from '../utils/photoSources';

db.exec(`
  CREATE TABLE IF NOT EXISTS user_favorites (
    user_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    ref        TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, kind, ref)
  )
`);

export type FavKind = 'league' | 'team' | 'player' | 'bb-league' | 'bb-team' | 'bb-player' | 'nfl-team' | 'nfl-league' | 'nfl-player' | 'tennis-player' | 'tennis-tournament'; // bb- = basketball (Oct 2026), nfl- = NFL (fix137), nfl-league = NFL / college (fix152), bb-player / nfl-player (fix153)
export interface Favorite {
  kind: FavKind;
  ref: string;
  name: string;
  img?: string | null;
  code?: string | null;
  ids?: number[];
  teamName?: string | null;
  teamImg?: string | null;
  teamIds?: number[];
  addedAt?: string;
}

const KINDS = new Set(['league', 'team', 'player', 'bb-league', 'bb-team', 'bb-player', 'nfl-team', 'nfl-league', 'nfl-player', 'tennis-player', 'tennis-tournament']);
export const MAX_FAVORITES = 200;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ids = (v: unknown) => (Array.isArray(v) ? v.filter(x => Number.isInteger(x) && x > 0).slice(0, 6) : []);
const url = (v: unknown) => {
  const s = str(v, 400);
  return /^https:\/\/[^\s"'<>]+$/.test(s) ? s : null;
};

/** Only the known fields, trimmed and size-limited; null when the item is not valid. */
export function cleanFavorite(x: any): Favorite | null {
  if (!x || typeof x !== 'object' || !KINDS.has(x.kind)) return null;
  const ref = str(x.ref, 80);
  const name = str(x.name, 120);
  if (!ref || !name) return null;
  return {
    kind: x.kind,
    ref,
    name,
    img: /player/.test(x.kind) ? officialPhoto(url(x.img)) : url(x.img), // fix241: a player's picture only from an official source
    code: str(x.code, 20) || null,
    ids: ids(x.ids),
    teamName: str(x.teamName, 120) || null,
    teamImg: url(x.teamImg),
    teamIds: ids(x.teamIds)
  };
}

export function listFavorites(userId: number): Favorite[] {
  const rows = db.prepare(`SELECT data, created_at FROM user_favorites WHERE user_id = ? ORDER BY created_at`).all(userId) as any[];
  return rows.map(r => ({ ...JSON.parse(r.data), addedAt: r.created_at }));
}

/** Add or update items (an update keeps the original date). Stops at MAX_FAVORITES. */
export function addFavorites(userId: number, items: unknown[]): Favorite[] {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?`).get(userId) as any).n as number;
  const exists = db.prepare(`SELECT 1 FROM user_favorites WHERE user_id = ? AND kind = ? AND ref = ?`);
  const ins = db.prepare(`
    INSERT INTO user_favorites (user_id, kind, ref, data, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, ref) DO UPDATE SET data = excluded.data`);
  let n = count;
  const list = items.slice(0, MAX_FAVORITES).map(cleanFavorite).filter(Boolean) as Favorite[];
  db.exec('BEGIN');
  try {
    for (const f of list) {
      const isNew = !exists.get(userId, f.kind, f.ref);
      if (isNew && n >= MAX_FAVORITES) continue;
      ins.run(userId, f.kind, f.ref, JSON.stringify(f), new Date().toISOString());
      if (isNew) n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listFavorites(userId);
}

export function removeFavorite(userId: number, kind: unknown, ref: unknown): Favorite[] {
  if (typeof kind === 'string' && typeof ref === 'string') db.prepare(`DELETE FROM user_favorites WHERE user_id = ? AND kind = ? AND ref = ?`).run(userId, kind, ref);
  return listFavorites(userId);
}

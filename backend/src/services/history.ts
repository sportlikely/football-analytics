/**
 * Historical results from football-data.co.uk (free CSVs, includes bookmaker odds).
 * Downloaded into SQLite and used to fit the Dixon-Coles model and to backtest.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { onExtraLeague, extraCode } from './leagueConfig';

const BASE = 'https://www.football-data.co.uk/mmz4281';

/** football-data.co.uk division codes grouped by country ("model group"). */
export const GROUPS: Record<string, { divisions: string[]; competitions: string[] }> = {
  E: { divisions: ['E0', 'E1'], competitions: ['PL', 'ELC'] },
  SP: { divisions: ['SP1', 'SP2'], competitions: ['PD'] },
  I: { divisions: ['I1', 'I2'], competitions: ['SA'] },
  D: { divisions: ['D1', 'D2'], competitions: ['BL1'] },
  F: { divisions: ['F1', 'F2'], competitions: ['FL1'] },
  N: { divisions: ['N1'], competitions: ['DED'] },
  P: { divisions: ['P1'], competitions: ['PPL'] },
  // Extra leagues served from API-Football (codes AF<league id>); history from the same football-data.co.uk CSVs
  B: { divisions: ['B1'], competitions: ['AF144'] }, // Belgium — Jupiler Pro League
  T: { divisions: ['T1'], competitions: ['AF203'] }, // Turkey — Süper Lig
  SC: { divisions: ['SC0', 'SC1'], competitions: ['AF179', 'AF180'] }, // Scotland — Premiership + Championship
  G: { divisions: ['G1'], competitions: ['AF197'] }, // Greece — Super League 1
  // Oct 2026: leagues outside Europe's top tier. football-data.co.uk keeps them in one file per country
  // (https://www.football-data.co.uk/new/BRA.csv …), every season in it, closing odds only.
  BRA: { divisions: ['BRA'], competitions: ['AF71'] }, // Brazil — Série A
  ARG: { divisions: ['ARG'], competitions: ['AF128'] }, // Argentina — Liga Profesional
  USA: { divisions: ['USA'], competitions: ['AF253'] }, // USA — MLS
  MEX: { divisions: ['MEX'], competitions: ['AF262'] }, // Mexico — Liga MX
  JPN: { divisions: ['JPN'], competitions: ['AF98'] }, // Japan — J1 League
  DNK: { divisions: ['DNK'], competitions: ['AF119'] }, // Denmark — Superliga
  POL: { divisions: ['POL'], competitions: ['AF106'] }, // Poland — Ekstraklasa
  NOR: { divisions: ['NOR'], competitions: ['AF103'] }, // Norway — Eliteserien
  SWE: { divisions: ['SWE'], competitions: ['AF113'] } // Sweden — Allsvenskan
};
// Second divisions served from API-Football (Oct 2026), next to the Football-Data.org top flights
GROUPS.E.divisions.push('E2');
GROUPS.E.competitions.push('AF41'); // England — League One
GROUPS.D.competitions.push('AF79'); // 2. Bundesliga
GROUPS.SP.competitions.push('AF141'); // LaLiga 2
GROUPS.I.competitions.push('AF136'); // Serie B
GROUPS.F.competitions.push('AF62'); // Ligue 2

/** Divisions kept by football-data.co.uk in one "new format" file per country (all seasons, different columns). */
export const NEW_FORMAT_DIVS = new Set(['BRA', 'ARG', 'USA', 'MEX', 'JPN', 'DNK', 'POL', 'NOR', 'SWE']);
/** Leagues played within a calendar year (spring to autumn) rather than August to May. */
export const CALENDAR_DIVS = new Set(['BRA', 'ARG', 'USA', 'JPN', 'NOR', 'SWE']);
/**
 * Leagues added from the admin panel (services/leagueConfig.ts): one group per league, coded AF<id>, with history
 * built from API-Football fixtures (apiFootball.ts → storeAfHistory) instead of a football-data.co.uk CSV.
 */
export const AF_HISTORY_DIVS = new Set<string>();
onExtraLeague(l => {
  const code = extraCode(l.id);
  const owner = Object.entries(GROUPS).find(([, cfg]) => cfg.competitions.includes(code))?.[0];
  if (owner && owner !== code) return; // already predicted through another group (football-data.co.uk history)
  if (!GROUPS[code]) GROUPS[code] = { divisions: [code], competitions: [code] };
  AF_HISTORY_DIVS.add(code);
  if (l.calendar) CALENDAR_DIVS.add(code);
});

/**
 * Season code for a match date in a division. August–May leagues roll over in July ("2627" = 2026/27);
 * calendar-year leagues use the code that starts in their year (the 2026 season = "2627"), so the season
 * that is being played now has the same code in every league.
 */
export function seasonForDivision(division: string, date: string): string {
  const d = new Date(date);
  // Japan's J1 moved to an August–May season from 2026-27: calendar years before that, the July rollover after
  const calendar = CALENDAR_DIVS.has(division) && !(division === 'JPN' && date.slice(0, 10) >= '2026-07-01');
  const y = calendar ? d.getUTCFullYear() : d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}

export function groupForCompetition(code: string): string | null {
  for (const [g, cfg] of Object.entries(GROUPS)) if (cfg.competitions.includes(code)) return g;
  return null;
}

/** Seasons to load: current + previous N. Season "2526" = 2025/26. */
export function seasonCodes(count: number = 3): string[] {
  const now = new Date();
  // Season rolls over in July
  const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const y = startYear - i;
    codes.push(`${String(y).slice(2)}${String(y + 1).slice(2)}`);
  }
  return codes;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS history_matches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    division    TEXT NOT NULL,
    season      TEXT NOT NULL,
    date        TEXT NOT NULL,       -- YYYY-MM-DD
    home        TEXT NOT NULL,       -- football-data.co.uk team name
    away        TEXT NOT NULL,
    hg          INTEGER NOT NULL,
    ag          INTEGER NOT NULL,
    odds_h      REAL, odds_d REAL, odds_a REAL,          -- best available pre-match (Pinnacle > B365 > Avg)
    close_h     REAL, close_d REAL, close_a REAL,        -- closing odds when present
    UNIQUE (division, season, date, home, away)
  );
  CREATE INDEX IF NOT EXISTS idx_history_div_date ON history_matches(division, date);

  CREATE TABLE IF NOT EXISTS history_sync (
    division    TEXT NOT NULL,
    season      TEXT NOT NULL,
    rows        INTEGER NOT NULL,
    synced_at   TEXT NOT NULL,
    PRIMARY KEY (division, season)
  );

  CREATE TABLE IF NOT EXISTS team_map (
    grp         TEXT NOT NULL,       -- model group (E, SP, ...)
    team_id     INTEGER NOT NULL,    -- Football-Data.org team id
    fd_name     TEXT NOT NULL,       -- football-data.co.uk name
    api_name    TEXT NOT NULL,
    score       REAL NOT NULL,
    PRIMARY KEY (grp, team_id)
  );
`);

// Schema upgrade (Oct 2026): which competition a team-map row came from, so two competitions of one group
// (Bundesliga from Football-Data.org, 2. Bundesliga from API-Football) keep their own rows
{
  const tm = (db.prepare(`PRAGMA table_info(team_map)`).all() as any[]).map(c => c.name);
  if (!tm.includes('source')) db.exec(`ALTER TABLE team_map ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
}

// Schema upgrade: best price across bookmakers (Max*) and market average (Avg*), early and closing
{
  const cols = (db.prepare(`PRAGMA table_info(history_matches)`).all() as any[]).map(c => c.name);
  for (const c of ['max_h', 'max_d', 'max_a', 'avg_h', 'avg_d', 'avg_a', 'maxc_h', 'maxc_d', 'maxc_a'])
    if (!cols.includes(c)) db.exec(`ALTER TABLE history_matches ADD COLUMN ${c} REAL`);
  // Match stats (shots, shots on target, corners, cards, referee) — added later: re-download every season once
  const statCols = ['sh_h', 'sh_a', 'sot_h', 'sot_a', 'cor_h', 'cor_a', 'yc_h', 'yc_a', 'rc_h', 'rc_a'];
  if (!cols.includes('sot_h')) {
    for (const c of statCols) if (!cols.includes(c)) db.exec(`ALTER TABLE history_matches ADD COLUMN ${c} INTEGER`);
    if (!cols.includes('referee')) db.exec(`ALTER TABLE history_matches ADD COLUMN referee TEXT`);
    db.exec(`DELETE FROM history_sync`);
  }
  // fix234: 1 = a result filled from our own final scores until the football-data.co.uk row arrives
  if (!cols.includes('provisional')) db.exec(`ALTER TABLE history_matches ADD COLUMN provisional INTEGER`);
}

/* ---------------- CSV ---------------- */

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const header = split(lines[0]);
  return lines.slice(1).map(l => {
    const cells = split(l);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ''));
    return row;
  });
}

function parseDate(s: string): string | null {
  // dd/mm/yyyy or dd/mm/yy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = parseInt(m[3], 10);
  if (y < 100) y += 2000;
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

const num = (s?: string) => {
  const v = parseFloat(s || '');
  return Number.isFinite(v) && v > 1 ? v : null;
};

const insertMatch = db.prepare(`
  INSERT OR REPLACE INTO history_matches
    (division, season, date, home, away, hg, ag, odds_h, odds_d, odds_a, close_h, close_d, close_a,
     max_h, max_d, max_a, avg_h, avg_d, avg_a, maxc_h, maxc_d, maxc_a,
     sh_h, sh_a, sot_h, sot_a, cor_h, cor_a, yc_h, yc_a, rc_h, rc_a, referee)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertSync = db.prepare(
  `INSERT OR REPLACE INTO history_sync (division, season, rows, synced_at) VALUES (?, ?, ?, ?)`
);
/** fix234: a filled-in result whose football-data.co.uk row is now there (same teams, the date ±3 days: UTC vs local) */
const dropReplacedProvisional = db.prepare(`DELETE FROM history_matches WHERE provisional = 1 AND division = ? AND EXISTS (
  SELECT 1 FROM history_matches h WHERE COALESCE(h.provisional, 0) = 0 AND h.division = history_matches.division AND h.home = history_matches.home
    AND h.away = history_matches.away AND h.date BETWEEN date(history_matches.date, '-3 days') AND date(history_matches.date, '+3 days'))`);

async function fetchCSV(division: string, season: string): Promise<string> {
  const url = NEW_FORMAT_DIVS.has(division) ? `https://www.football-data.co.uk/new/${division}.csv` : `${BASE}/${season}/${division}.csv`;
  const res = await fetch(url, { headers: { 'User-Agent': 'SportLikely/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** Download and store one division/season. Returns rows stored. */
const int = (v: string | undefined) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
};

export async function syncDivision(division: string, season: string, keepSeasons?: Set<string>) {
  const text = await fetchCSV(division, season);
  const rows = parseCSV(text);
  const newFormat = NEW_FORMAT_DIVS.has(division);
  let stored = 0;
  const perSeason = new Map<string, number>();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const date = parseDate(r.Date);
      // new-format files: Home / Away / HG / AG and a Season column; one file holds every season
      const homeName = r.HomeTeam || r.Home;
      const awayName = r.AwayTeam || r.Away;
      const hg = parseInt(r.FTHG ?? r.HG, 10);
      const ag = parseInt(r.FTAG ?? r.AG, 10);
      if (!date || !homeName || !awayName || Number.isNaN(hg) || Number.isNaN(ag)) continue;
      const rowSeason = newFormat ? seasonForDivision(division, date) : season;
      if (keepSeasons && !keepSeasons.has(rowSeason)) continue;
      // Pre-match odds preference: Pinnacle (PSH), Bet365 (B365H), market average (AvgH); new-format files
      // only carry closing prices, which then stand in for the pre-match price too
      const oh = num(r.PSH) ?? num(r.B365H) ?? num(r.AvgH) ?? (newFormat ? num(r.PSCH) ?? num(r.B365CH) ?? num(r.AvgCH) : null);
      const od = num(r.PSD) ?? num(r.B365D) ?? num(r.AvgD) ?? (newFormat ? num(r.PSCD) ?? num(r.B365CD) ?? num(r.AvgCD) : null);
      const oa = num(r.PSA) ?? num(r.B365A) ?? num(r.AvgA) ?? (newFormat ? num(r.PSCA) ?? num(r.B365CA) ?? num(r.AvgCA) : null);
      // Closing odds: Pinnacle closing (PSCH), else Bet365 closing, else market avg closing
      const ch = num(r.PSCH) ?? num(r.B365CH) ?? num(r.AvgCH);
      const cd = num(r.PSCD) ?? num(r.B365CD) ?? num(r.AvgCD);
      const ca = num(r.PSCA) ?? num(r.B365CA) ?? num(r.AvgCA);
      // Best price across bookmakers and market average (early), best price at close
      insertMatch.run(
        division, rowSeason, date, homeName, awayName, hg, ag, oh, od, oa, ch, cd, ca,
        num(r.MaxH) ?? num(r.BbMxH), num(r.MaxD) ?? num(r.BbMxD), num(r.MaxA) ?? num(r.BbMxA),
        num(r.AvgH) ?? num(r.BbAvH), num(r.AvgD) ?? num(r.BbAvD), num(r.AvgA) ?? num(r.BbAvA),
        num(r.MaxCH), num(r.MaxCD), num(r.MaxCA),
        int(r.HS), int(r.AS), int(r.HST), int(r.AST), int(r.HC), int(r.AC), int(r.HY), int(r.AY), int(r.HR), int(r.AR),
        (r.Referee || '').trim() || null
      );
      stored++;
      perSeason.set(rowSeason, (perSeason.get(rowSeason) || 0) + 1);
    }
    if (newFormat) perSeason.forEach((n, sc) => upsertSync.run(division, sc, n, new Date().toISOString()));
    else upsertSync.run(division, season, stored, new Date().toISOString());
    // fix234: the file's row replaces the one filled from our final scores (it keeps shots, cards, odds)
    dropReplacedProvisional.run(division);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return stored;
}

/** Sync every division for the given seasons. Current season is always re-downloaded. */
export async function syncAll(seasons: string[] = seasonCodes(3), force: boolean = false) {
  const current = seasons[0];
  const summary: { division: string; season: string; rows: number; skipped?: boolean; error?: string }[] = [];
  for (const cfg of Object.values(GROUPS)) {
    for (const division of cfg.divisions) {
      if (AF_HISTORY_DIVS.has(division)) continue; // history from API-Football (apiFootball.ts)
      if (NEW_FORMAT_DIVS.has(division)) {
        // one file per country with every season: download it once and keep the seasons asked for
        try {
          // calendar-year leagues start their next season in February, before the July rollover: keep it too
          const y = parseInt(current.slice(2), 10);
          const next = `${String(y).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;
          const rows = await syncDivision(division, current, new Set([...seasons, next]));
          summary.push({ division, season: seasons.join(','), rows });
          console.log(`  📥 ${division} (${seasons.join(', ')}): ${rows} matches`);
        } catch (error: any) {
          summary.push({ division, season: seasons.join(','), rows: 0, error: error.message });
          console.log(`  ⚠️  ${division}: ${error.message}`);
        }
        continue;
      }
      for (const season of seasons) {
        const existing: any = db.prepare(`SELECT rows, synced_at FROM history_sync WHERE division = ? AND season = ?`).get(division, season);
        const stale = !existing || season === current || force;
        if (!stale) {
          summary.push({ division, season, rows: existing.rows, skipped: true });
          continue;
        }
        try {
          const rows = await syncDivision(division, season);
          summary.push({ division, season, rows });
          console.log(`  📥 ${division} ${season}: ${rows} matches`);
        } catch (error: any) {
          summary.push({ division, season, rows: 0, error: error.message });
          console.log(`  ⚠️  ${division} ${season}: ${error.message}`);
        }
      }
    }
  }
  // fix234: the games the files don't have yet, from our own final scores (the model fit right after uses them)
  try { const f = fillFromFinals(); if (f.added) logger.info(`History: ${f.added} result(s) filled from our final scores (${f.replaced} replaced by the files, ${f.unmapped} without team names)`); }
  catch (e: any) { logger.warn(`History fill from final scores: ${e?.message || e}`); }
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM history_matches`).get() as any).c;
  logger.info(`History sync done: ${total} matches in database`);
  return { total, summary };
}

/**
 * History for an API-Football league (admin-added): finished league matches of one season, written like a
 * football-data.co.uk row without odds or match stats. Returns rows stored.
 */
const insertAfHistory = db.prepare(`
  INSERT INTO history_matches (division, season, date, home, away, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(division, season, date, home, away) DO UPDATE SET hg = excluded.hg, ag = excluded.ag
`);
export function storeAfHistory(division: string, rows: { date: string; home: string; away: string; hg: number; ag: number }[]) {
  if (!AF_HISTORY_DIVS.has(division)) return 0;
  const perSeason = new Map<string, number>();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const season = seasonForDivision(division, r.date);
      insertAfHistory.run(division, season, r.date, r.home, r.away, r.hg, r.ag);
      perSeason.set(season, (perSeason.get(season) || 0) + 1);
    }
    for (const [sc, n] of perSeason) {
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM history_matches WHERE division = ? AND season = ?`).get(division, sc) as any).c;
      upsertSync.run(division, sc, Math.max(n, total), new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

/**
 * fix234 — the football-data.co.uk files lag up to a week (25 Oct: E0's last result 19 Oct, 5 games missing), so the
 * ratings missed a week of games. A finished league game we already have is written at once from our own final score:
 * API-Football's fixture (af_fixtures, FT) or the Football-Data.org result linked to it (fd_af_links, the fix212 match
 * link; home / away swapped where the link says so). Team names are the file's names through af_teams.fd_name (the
 * same mapping the model uses); a team without one is skipped. The row is marked provisional; the file's row replaces
 * it when it arrives (dropReplacedProvisional, same teams within ±3 days). Leagues whose history is API-Football's own
 * (AF_HISTORY_DIVS) are left alone. Runs after every history sync (the model fit follows) and every 20 minutes.
 */
const provisionalAt = db.prepare(`SELECT COALESCE(provisional, 0) AS p FROM history_matches WHERE division = ? AND home = ? AND away = ? AND date BETWEEN date(?, '-3 days') AND date(?, '+3 days')`);
const insProvisional = db.prepare(`INSERT INTO history_matches (division, season, date, home, away, hg, ag, provisional) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(division, season, date, home, away) DO UPDATE SET hg = excluded.hg, ag = excluded.ag WHERE history_matches.provisional = 1`);
export function fillFromFinals(now = Date.now()): { added: number; replaced: number; unmapped: number } {
  const divs = [...new Set(Object.values(GROUPS).flatMap(g => g.divisions))].filter(d => !AF_HISTORY_DIVS.has(d));
  if (!divs.length) return { added: 0, replaced: 0, unmapped: 0 };
  const since = new Date(now - 21 * 86400000).toISOString();
  let replaced = 0;
  db.exec('BEGIN');
  try {
    for (const d of divs) replaced += Number(dropReplacedProvisional.run(d).changes || 0);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  let rows: any[];
  try {
    rows = db.prepare(`SELECT f.fixture_id, f.division, f.date, f.status, f.hg, f.ag, th.fd_name AS home, ta.fd_name AS away FROM af_fixtures f
      LEFT JOIN af_teams th ON th.grp = f.grp AND th.team_id = f.home_id LEFT JOIN af_teams ta ON ta.grp = f.grp AND ta.team_id = f.away_id
      WHERE f.kickoff >= ? AND f.kickoff < ? AND f.division IN (${divs.map(() => '?').join(',')})`).all(since, new Date(now).toISOString(), ...divs) as any[];
  } catch { return { added: 0, replaced, unmapped: 0 }; } // no fixture store yet
  // Football-Data.org finals through the fix212 link (they settle within minutes; API-Football's fixture list later)
  const fd = new Map<number, { hg: number; ag: number }>();
  try {
    for (const r of db.prepare(`SELECT l.af_id, l.swapped, r.home_goals, r.away_goals FROM results r JOIN fd_af_links l ON l.fd_id = r.match_id
      WHERE r.settled_at >= ? AND r.outcome IN ('H', 'D', 'A') AND r.home_goals IS NOT NULL AND r.away_goals IS NOT NULL`).all(since) as any[])
      fd.set(r.af_id, r.swapped ? { hg: r.away_goals, ag: r.home_goals } : { hg: r.home_goals, ag: r.away_goals });
  } catch { /* no links table yet */ }
  let added = 0, unmapped = 0;
  db.exec('BEGIN');
  try {
    for (const f of rows) {
      const score = f.status === 'FT' && Number.isFinite(f.hg) && Number.isFinite(f.ag) && f.hg !== null && f.ag !== null ? { hg: f.hg, ag: f.ag } : fd.get(f.fixture_id);
      if (!score) continue;
      if (!f.home || !f.away) { unmapped++; continue; }
      const have = provisionalAt.all(f.division, f.home, f.away, f.date, f.date) as any[];
      if (have.some(h => !h.p)) continue; // the file has it
      const r = insProvisional.run(f.division, seasonForDivision(f.division, f.date), f.date, f.home, f.away, score.hg, score.ag);
      if (!have.length && r.changes) added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, replaced, unmapped };
}

export interface HistoryMatch {
  division: string;
  season: string;
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  odds_h: number | null;
  odds_d: number | null;
  odds_a: number | null;
  close_h: number | null;
  close_d: number | null;
  close_a: number | null;
  sh_h?: number | null; sh_a?: number | null; sot_h?: number | null; sot_a?: number | null;
  cor_h?: number | null; cor_a?: number | null; referee?: string | null;
}

export function loadGroupMatches(group: string, before?: string): HistoryMatch[] {
  const divs = GROUPS[group]?.divisions || [];
  if (!divs.length) return [];
  const placeholders = divs.map(() => '?').join(',');
  const sql = `SELECT * FROM history_matches WHERE division IN (${placeholders}) ${before ? 'AND date < ?' : ''} ORDER BY date`;
  return before ? db.prepare(sql).all(...divs, before) : db.prepare(sql).all(...divs);
}

export function historyStatus() {
  const perDiv = db
    .prepare(`SELECT division, season, rows, synced_at FROM history_sync ORDER BY division, season DESC`)
    .all();
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM history_matches`).get() as any).c;
  const mapped = (db.prepare(`SELECT COUNT(*) AS c FROM team_map`).get() as any).c;
  return { total, mapped, divisions: perDiv };
}

/* ---------------- team name matching ---------------- */

export const ALIASES: Record<string, string> = {
  // football-data.co.uk name (lowercased) → hint matching Football-Data.org name/shortName
  'man united': 'manchester united',
  'man city': 'manchester city',
  "nott'm forest": 'nottingham forest',
  'wolves': 'wolverhampton',
  'sheffield united': 'sheffield utd',
  'sheffield weds': 'sheffield wednesday',
  'qpr': 'queens park rangers',
  'ath madrid': 'atletico madrid',
  'ath bilbao': 'athletic club',
  'espanol': 'espanyol',
  'sociedad': 'real sociedad',
  'betis': 'real betis',
  'vallecano': 'rayo vallecano',
  'celta': 'celta vigo',
  'alaves': 'alaves',
  'valladolid': 'real valladolid',
  'milan': 'ac milan',
  'inter': 'internazionale',
  'verona': 'hellas verona',
  'roma': 'as roma',
  'lazio': 'ss lazio',
  'bayern munich': 'bayern munchen',
  'ein frankfurt': 'eintracht frankfurt',
  "m'gladbach": 'monchengladbach',
  'werder bremen': 'werder bremen',
  'fc koln': 'koln',
  'hamburg': 'hamburger sv',
  'mainz': 'mainz 05',
  'st pauli': 'st. pauli',
  'leverkusen': 'bayer leverkusen',
  'dortmund': 'borussia dortmund',
  'paris sg': 'paris saint-germain',
  'paris fc': 'paris fc',
  'st etienne': 'saint-etienne',
  'rennes': 'stade rennais',
  'brest': 'stade brestois',
  'lyon': 'olympique lyonnais',
  'sp lisbon': 'sporting cp',
  'sp braga': 'braga',
  'guimaraes': 'vitoria sc',
  'estrela': 'estrela da amadora',
  'nacional': 'nacional',
  'avs': 'avs',
  'psv eindhoven': 'psv',
  'go ahead eagles': 'go ahead eagles',
  'nijmegen': 'nec nijmegen',
  'zwolle': 'pec zwolle',
  'for sittard': 'fortuna sittard',
  'waalwijk': 'rkc waalwijk',
  'sparta rotterdam': 'sparta rotterdam',
  // Belgium / Turkey / Scotland / Greece (football-data.co.uk → API-Football spelling)
  'club brugge': 'club brugge kv',
  'st truiden': 'sint-truiden',
  'st. gilloise': 'union st. gilloise',
  'waregem': 'zulte waregem',
  'oud-heverlee leuven': 'oh leuven',
  'fenerbahce': 'fenerbahce',
  'buyuksehyr': 'istanbul basaksehir',
  'ad. demirspor': 'adana demirspor',
  'celtic': 'celtic',
  'rangers': 'rangers',
  'st mirren': 'st. mirren',
  'st johnstone': 'st johnstone',
  'olympiakos': 'olympiakos piraeus',
  'paok': 'paok',
  'aek': 'aek athens fc',
  // Oct 2026 leagues (football-data.co.uk → API-Football spelling); a few spellings each, extra keys are harmless
  'athletico-pr': 'atletico paranaense',
  'atletico-pr': 'atletico paranaense',
  'athletico pr': 'atletico paranaense',
  'rakow': 'rakow czestochowa',
  'queens park': "queen's park",
  "queen's park": "queen's park",
  'sociedad b': 'real sociedad ii',
  'real sociedad b': 'real sociedad ii',
  // fix182: Greece (football-data.co.uk spells it Levadeiakos)
  'levadeiakos': 'levadiakos'
};

// Club-name filler that carries no identity. Distinguishing words such as "Real",
// "Atletico", "Sporting", "Borussia" are deliberately kept.
const STOP = new Set(['fc', 'cf', 'afc', 'sc', 'ac', 'ss', 'ssc', 'us', 'ud', 'cd', 'sd', 'rcd', 'rc', 'ca', 'bc', 'sv', 'tsg', 'vfb', 'vfl', 'fsv', 'bsc', 'sad', 'ev', 'club', 'clube', 'de', 'la', 'calcio', 'futebol', 'football', 'stade', 'olympique', 'associazione', 'sportiva', '1', '04', '05', '09', '29', '65', '1846', '1899', '1901', '1904', '1907', '1909', '1910', '1913']);

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s)
    .split(' ')
    .filter(t => t && !STOP.has(t));
}

export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let inter = 0;
  ta.forEach(t => {
    if (tb.has(t)) inter++;
  });
  const jacc = ta.size && tb.size ? inter / (ta.size + tb.size - inter) : 0;
  const shorter = Math.min(na.length, nb.length);
  const contains = shorter >= 4 && (na.includes(nb) || nb.includes(na)) ? 0.6 : 0;
  // prefix match on first meaningful token (e.g. "brighton" vs "brighton hove")
  const fa = [...ta][0];
  const fb = [...tb][0];
  const prefix = fa && fb && (fa.startsWith(fb) || fb.startsWith(fa)) ? 0.5 : 0;
  return Math.max(jacc, contains, prefix);
}

export interface ApiTeam {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
}

/**
 * Map Football-Data.org teams (from standings) to football-data.co.uk names for a group.
 * Returns the mapping and the API teams that could not be matched.
 */
/**
 * source: where the teams come from — '' for the Football-Data.org competitions of the group (mapped together),
 * 'AF<league id>' for an API-Football competition. Each source keeps its own rows, and names another source
 * already uses are not offered again (a League One side can't take a Championship club's name).
 */
export function buildTeamMap(group: string, apiTeams: ApiTeam[], source = '') {
  const divs = GROUPS[group]?.divisions || [];
  if (!divs.length) return { mapped: 0, unmatched: apiTeams.map(t => t.name) };
  const placeholders = divs.map(() => '?').join(',');
  const ids = new Set(apiTeams.map(t => t.id));
  const takenElsewhere = new Set(
    (db.prepare(`SELECT team_id, fd_name FROM team_map WHERE grp = ? AND source != ?`).all(group, source) as any[])
      .filter(r => !ids.has(r.team_id))
      .map(r => r.fd_name)
  );
  const fdNames: string[] = db
    .prepare(`SELECT DISTINCT home AS n FROM history_matches WHERE division IN (${placeholders})`)
    .all(...divs)
    .map((r: any) => r.n)
    .filter((n: string) => !takenElsewhere.has(n));

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO team_map (grp, team_id, fd_name, api_name, score, source) VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.prepare(`DELETE FROM team_map WHERE grp = ? AND source = ?`).run(group, source);

  // Score every (api team, fd name) pair, then assign greedily by best score so
  // that a strong match always beats a weaker one for the same name.
  const pairs: { t: ApiTeam; fd: string; score: number }[] = [];
  for (const t of apiTeams) {
    const candidates = [t.name, t.shortName || '', t.tla || ''].filter(Boolean);
    for (const fd of fdNames) {
      const alias = ALIASES[fd.toLowerCase()];
      let score = 0;
      for (const c of candidates) {
        score = Math.max(score, similarity(fd, c));
        if (alias) score = Math.max(score, similarity(alias, c));
      }
      if (score >= 0.5) pairs.push({ t, fd, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const assignedTeam = new Set<number>();
  const assignedName = new Set<string>();
  const bestSeen = new Map<number, { fd: string; score: number }>();
  let mapped = 0;
  for (const p of pairs) {
    if (!bestSeen.has(p.t.id)) bestSeen.set(p.t.id, { fd: p.fd, score: p.score });
    if (assignedTeam.has(p.t.id) || assignedName.has(p.fd)) continue;
    upsert.run(group, p.t.id, p.fd, p.t.name, p.score, source);
    assignedTeam.add(p.t.id);
    assignedName.add(p.fd);
    mapped++;
  }
  const unmatched = apiTeams
    .filter(t => !assignedTeam.has(t.id))
    .map(t => {
      const b = bestSeen.get(t.id);
      return `${t.name}${b ? ` (best: ${b.fd} ${b.score.toFixed(2)}, taken)` : ''}`;
    });
  if (unmatched.length) logger.warn(`Team map ${group}: ${unmatched.length} unmatched`, { unmatched });
  return { mapped, unmatched };
}

export function fdNameFor(group: string, teamId: number): string | null {
  const row: any = db.prepare(`SELECT fd_name FROM team_map WHERE grp = ? AND team_id = ?`).get(group, teamId);
  return row ? row.fd_name : null;
}

export function teamMapStatus() {
  return db.prepare(`SELECT grp, team_id, fd_name, api_name, score FROM team_map ORDER BY grp, api_name`).all();
}

/* ------------------------------------------------------------------ */
/* Head-to-head archive (Oct 2026)                                     */
/* ------------------------------------------------------------------ */
// The model's history holds the last 3 seasons, so it often had "no previous meetings" while the match page (from
// API-Football) showed ten. Older seasons are stored here for the head-to-head row only: ratings, Elo and the backtest
// samples keep using history_matches. Same football-data.co.uk names, so pairs match directly.
db.exec(`
  CREATE TABLE IF NOT EXISTS h2h_archive (
    division TEXT NOT NULL, season TEXT NOT NULL, date TEXT NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    hg INTEGER NOT NULL, ag INTEGER NOT NULL, PRIMARY KEY (division, date, home, away)
  );
  CREATE INDEX IF NOT EXISTS idx_h2h_archive_div ON h2h_archive(division);
`);
const insertArchive = db.prepare(`INSERT OR REPLACE INTO h2h_archive (division, season, date, home, away, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?)`);

/** Seasons before the model's 3: e.g. 1516 … 2324. */
export function archiveSeasonCodes(back = 10): string[] {
  const recent = seasonCodes(3);
  const oldest = recent[recent.length - 1];
  let y = parseInt(oldest.slice(0, 2), 10);
  const out: string[] = [];
  for (let i = 0; i < back; i++) { y = (y + 99) % 100; out.push(`${String(y).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`); }
  return out;
}

export async function syncH2HArchive(back = 10) {
  const seasons = archiveSeasonCodes(back);
  const keep = new Set(seasonCodes(3));
  const summary: { division: string; season: string; rows: number; error?: string }[] = [];
  const store = (division: string, rows: Record<string, string>[], season: string | null) => {
    let n = 0;
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const date = parseDate(r.Date);
        const homeName = r.HomeTeam || r.Home, awayName = r.AwayTeam || r.Away;
        const hg = parseInt(r.FTHG ?? r.HG, 10), ag = parseInt(r.FTAG ?? r.AG, 10);
        if (!date || !homeName || !awayName || Number.isNaN(hg) || Number.isNaN(ag)) continue;
        const sc = season || seasonForDivision(division, date);
        if (keep.has(sc)) continue; // those are in history_matches
        insertArchive.run(division, sc, date, homeName, awayName, hg, ag);
        n++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return n;
  };
  for (const cfg of Object.values(GROUPS)) {
    for (const division of cfg.divisions) {
      if (AF_HISTORY_DIVS.has(division)) continue; // no CSV archive for API-Football leagues
      if (NEW_FORMAT_DIVS.has(division)) {
        try { summary.push({ division, season: 'all', rows: store(division, parseCSV(await fetchCSV(division, seasons[0])), null) }); }
        catch (e: any) { summary.push({ division, season: 'all', rows: 0, error: e.message }); }
        continue;
      }
      for (const season of seasons) {
        try { summary.push({ division, season, rows: store(division, parseCSV(await fetchCSV(division, season)), season) }); }
        catch (e: any) { summary.push({ division, season, rows: 0, error: e.message }); }
      }
    }
  }
  archiveCache.clear();
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM h2h_archive`).get() as any).c;
  logger.info(`H2H archive sync done: ${total} matches`);
  return { total, seasons, errors: summary.filter(s => s.error).length, summary };
}

const archiveCache = new Map<string, Map<string, HistoryMatch[]>>();
/** Archive meetings of a group, indexed by the pair (names sorted). */
export function h2hArchiveFor(group: string): Map<string, HistoryMatch[]> {
  let idx = archiveCache.get(group);
  if (idx) return idx;
  idx = new Map();
  const divs = GROUPS[group]?.divisions || [];
  if (divs.length) {
    const rows = db.prepare(`SELECT * FROM h2h_archive WHERE division IN (${divs.map(() => '?').join(',')})`).all(...divs) as HistoryMatch[];
    for (const m of rows) {
      const k = [m.home, m.away].sort().join('|');
      const l = idx.get(k);
      if (l) l.push(m); else idx.set(k, [m]);
    }
  }
  archiveCache.set(group, idx);
  return idx;
}

export function h2hArchiveStatus() {
  return db.prepare(`SELECT division, COUNT(*) AS rows, MIN(date) AS first, MAX(date) AS last FROM h2h_archive GROUP BY division ORDER BY division`).all();
}

/* ---------------- Half-time scores (Oct 2026) ---------------- */
// For testing the live win chance: the half-time score of every match in the model's 3 seasons (HTHG / HTAG in the
// football-data.co.uk files; the new-format leagues have none). Kept apart from history_matches so nothing re-downloads.
db.exec(`
  CREATE TABLE IF NOT EXISTS ht_scores (
    division TEXT NOT NULL, date TEXT NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    ht_hg INTEGER NOT NULL, ht_ag INTEGER NOT NULL, PRIMARY KEY (division, date, home, away)
  );
`);
const insertHt = db.prepare(`INSERT OR REPLACE INTO ht_scores (division, date, home, away, ht_hg, ht_ag) VALUES (?, ?, ?, ?, ?, ?)`);

export async function syncHalfTimes() {
  const seasons = seasonCodes(3);
  const summary: { division: string; season: string; rows: number; error?: string }[] = [];
  for (const cfg of Object.values(GROUPS)) {
    for (const division of cfg.divisions) {
      if (NEW_FORMAT_DIVS.has(division) || AF_HISTORY_DIVS.has(division)) continue;
      for (const season of seasons) {
        try {
          const rows = parseCSV(await fetchCSV(division, season));
          let n = 0;
          db.exec('BEGIN');
          try {
            for (const r of rows) {
              const date = parseDate(r.Date);
              const home = r.HomeTeam || r.Home, away = r.AwayTeam || r.Away;
              const hh = parseInt(r.HTHG, 10), ha = parseInt(r.HTAG, 10);
              if (!date || !home || !away || Number.isNaN(hh) || Number.isNaN(ha)) continue;
              insertHt.run(division, date, home, away, hh, ha);
              n++;
            }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          summary.push({ division, season, rows: n });
        } catch (e: any) {
          summary.push({ division, season, rows: 0, error: e.message });
        }
      }
    }
  }
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ht_scores`).get() as any).c;
  return { total, seasons, errors: summary.filter(s => s.error).length, summary };
}

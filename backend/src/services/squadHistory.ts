/**
 * Point-in-time squad values: what each club's squad was worth at the START of a given month.
 *
 * The normal squad-value row uses one snapshot (July 2026). In a backtest of 2024-25 or 2025-26 that is
 * look-ahead: a club that did well already has higher player values. Here we rebuild the value from the
 * transfermarkt-datasets history (player_valuations: every valuation with its date and the player's club
 * at the time), so a match on date D only sees valuations published before the month of D.
 *
 * Per club and month: sum of the 15 most valuable players whose latest valuation (before the month,
 * at most ~13 months old) was made while at that club.
 */
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { slicer } from './perf';
const gunzipAsync = promisify(gunzip);
import { db } from '../db';
import logger from '../utils/logger';

const BASE = (process.env.SQUAD_VALUES_URL || 'https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data/players.csv.gz').replace(/[^/]+$/, '');
const TOP_N = 15;
const FIRST_MONTH = '2021-07-01';
const MAX_AGE_DAYS = 400;

db.exec(`
  CREATE TABLE IF NOT EXISTS club_value_month (
    club    TEXT NOT NULL,     -- Transfermarkt club name (same as players.csv current_club_name)
    month   TEXT NOT NULL,     -- YYYY-MM-01: value from valuations published before this date
    top_eur REAL NOT NULL,
    players INTEGER NOT NULL,
    PRIMARY KEY (club, month)
  );
  CREATE TABLE IF NOT EXISTS club_value_comp (club TEXT PRIMARY KEY, comp TEXT);
  CREATE TABLE IF NOT EXISTS club_value_sync (id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT NOT NULL, clubs INTEGER, months INTEGER, rows INTEGER);
`);

let byClub = new Map<string, Map<string, number>>();
let compOf = new Map<string, string>();
let loadCount = 0;
/** Changes every time the history is (re)loaded — lets callers drop cached name matches. */
export const historyVersion = () => loadCount;
function load() {
  loadCount++;
  byClub = new Map();
  compOf = new Map((db.prepare(`SELECT club, comp FROM club_value_comp`).all() as any[]).map(r => [r.club, r.comp]));
  for (const r of db.prepare(`SELECT club, month, top_eur FROM club_value_month`).all() as any[]) {
    (byClub.get(r.club) || byClub.set(r.club, new Map()).get(r.club)!).set(r.month, r.top_eur);
  }
}
load();

/** Squad value (top-15 sum, EUR) of a Transfermarkt club as known at the start of date's month; null if unknown. */
export function clubValueAt(club: string, date: string): number | null {
  const m = byClub.get(club);
  if (!m) return null;
  let key = `${date.slice(0, 7)}-01`;
  // walk back a few months if that month is missing (end of the data)
  for (let i = 0; i < 6; i++) {
    const v = m.get(key);
    if (v !== undefined) return v;
    const d = new Date(key + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    key = d.toISOString().slice(0, 10);
  }
  return null;
}
export const clubValueHistoryLoaded = () => byClub.size;
/** History clubs with their (latest) Transfermarkt league code. */
export const historyClubs = () => [...byClub.keys()].map(name => ({ name, comp: compOf.get(name) || '' }));

function parseQuoted(line: string): string[] {
  const out: string[] = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}

async function fetchText(name: string): Promise<string> {
  const res = await fetch(BASE + name, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (name.endsWith('.gz') ? await gunzipAsync(buf) : buf).toString('utf8'); // fix169: off the event loop
}

export async function syncClubValueHistory(competitions: string[], force = false) {
  const s: any = db.prepare(`SELECT synced_at FROM club_value_sync WHERE id = 1`).get();
  if (!force && s && Date.now() - new Date(s.synced_at).getTime() < 7 * 86400000) return null;
  const comps = new Set(competitions);
  const slice = slicer(); // fix169: yields every ~30 ms (the sync froze the server 2.4 s)

  // clubs: id → name, only the competitions we model
  const clubsText = await fetchText('clubs.csv.gz');
  const cl = clubsText.split('\n');
  const ch = parseQuoted(cl[0]);
  const ciId = ch.indexOf('club_id'), ciName = ch.indexOf('name'), ciComp = ch.indexOf('domestic_competition_id');
  if (ciId < 0 || ciName < 0) throw new Error(`clubs.csv: unexpected columns ${ch.join(',')}`);
  const clubName = new Map<string, string>();
  const clubComp = new Map<string, string>();
  for (let li = 1; li < cl.length; li++) {
    if ((li & 1023) === 0) await slice();
    const line = cl[li];
    if (!line.trim()) continue;
    const r = parseQuoted(line);
    if (ciComp >= 0 && r[ciComp] && !comps.has(r[ciComp])) continue;
    clubName.set(r[ciId], r[ciName]);
    if (ciComp >= 0) clubComp.set(r[ciName], r[ciComp]);
  }

  // valuations: player → [date, value, club] sorted by date
  const vText = await fetchText('player_valuations.csv.gz');
  const vl = vText.split('\n');
  const vh = parseQuoted(vl[0]);
  const iP = vh.indexOf('player_id'), iD = vh.indexOf('date'), iV = vh.indexOf('market_value_in_eur'), iC = vh.indexOf('current_club_id');
  if (iP < 0 || iD < 0 || iV < 0 || iC < 0) throw new Error(`player_valuations.csv: unexpected columns ${vh.join(',')}`);
  const earliest = new Date(new Date(FIRST_MONTH).getTime() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  const perPlayer = new Map<string, { d: string; v: number; c: string }[]>();
  for (let i = 1; i < vl.length; i++) {
    if ((i & 1023) === 0) await slice();
    const line = vl[i];
    if (!line) continue;
    const r = line.includes('"') ? parseQuoted(line) : line.split(',');
    const d = (r[iD] || '').slice(0, 10);
    if (d < earliest) continue;
    const v = parseFloat(r[iV]);
    if (!Number.isFinite(v) || v <= 0) continue;
    const arr = perPlayer.get(r[iP]) || perPlayer.set(r[iP], []).get(r[iP])!;
    arr.push({ d, v, c: r[iC] });
  }
  let si = 0;
  for (const a of perPlayer.values()) { if ((++si & 1023) === 0) await slice(); a.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0)); }

  // month starts
  const months: string[] = [];
  const now = new Date();
  for (let d = new Date(FIRST_MONTH + 'T00:00:00Z'); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 10));

  // fix169: the club-months are computed first (a yield per month); the transaction below only writes
  const monthRows: [string, string, number, number][] = [];
  for (const month of months) {
    await slice();
    {
      const minDate = new Date(new Date(month).getTime() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
      const clubVals = new Map<string, number[]>();
      perPlayer.forEach(a => {
        // latest valuation strictly before the month
        let lo = 0, hi = a.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].d < month) lo = mid + 1; else hi = mid; }
        if (lo === 0) return;
        const last = a[lo - 1];
        if (last.d < minDate) return;
        const name = clubName.get(last.c);
        if (!name) return;
        (clubVals.get(name) || clubVals.set(name, []).get(name)!).push(last.v);
      });
      clubVals.forEach((vals, club) => {
        if (vals.length < 11) return;
        vals.sort((x, y) => y - x);
        monthRows.push([club, month, vals.slice(0, TOP_N).reduce((s, v) => s + v, 0), vals.length]);
      });
    }
  }
  const rows = monthRows.length;
  const ins = db.prepare(`INSERT OR REPLACE INTO club_value_month (club, month, top_eur, players) VALUES (?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM club_value_month`);
    db.exec(`DELETE FROM club_value_comp`);
    const insC = db.prepare(`INSERT OR REPLACE INTO club_value_comp (club, comp) VALUES (?, ?)`);
    clubComp.forEach((c, n) => insC.run(n, c));
    for (const r of monthRows) ins.run(...r);
    db.prepare(`INSERT OR REPLACE INTO club_value_sync (id, synced_at, clubs, months, rows) VALUES (1, ?, ?, ?, ?)`).run(new Date().toISOString(), clubName.size, months.length, rows);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  load();
  logger.info(`Club value history: ${rows} club-months (${clubName.size} clubs, ${months.length} months)`);
  return { clubs: clubName.size, months: months.length, rows };
}

export function clubValueHistoryStatus(sample?: string) {
  const s: any = db.prepare(`SELECT * FROM club_value_sync WHERE id = 1`).get();
  const out: any = { sync: s || null, clubs: byClub.size };
  if (sample) {
    const m = byClub.get(sample);
    out.sample = m ? [...m.entries()].filter((_, i) => i % 3 === 0).map(([k, v]) => ({ month: k, topEurM: Math.round(v / 1e6) })) : null;
  }
  return out;
}

/*
 * Admin search: where does a club appear in the Transfermarkt dump? (to fix unmatched squad values)
 * clubs.csv (id, name, league), players.csv (players whose current club matches, with their league),
 * and the monthly history table. Files are cached for an hour.
 */
const textCache = new Map<string, { at: number; text: string }>();
async function cachedText(name: string) {
  const c = textCache.get(name);
  if (c && Date.now() - c.at < 3600_000) return c.text;
  const text = await fetchText(name);
  textCache.set(name, { at: Date.now(), text });
  return text;
}
const normQ = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function findClub(q: string) {
  const needle = normQ(q);
  if (needle.length < 3) throw new Error('q must be at least 3 characters');
  const out: any = { q, clubsCsv: [], players: [], history: [] };

  const cl = (await cachedText('clubs.csv.gz')).split('\n');
  const ch = parseQuoted(cl[0]);
  const idx = (n: string) => ch.indexOf(n);
  const cols = ['club_id', 'name', 'domestic_competition_id', 'squad_size', 'total_market_value', 'last_season'].filter(n => idx(n) >= 0);
  for (const line of cl.slice(1)) {
    if (!normQ(line).includes(needle)) continue;
    const r = parseQuoted(line);
    if (!normQ(r[idx('name')]).includes(needle)) continue;
    out.clubsCsv.push(Object.fromEntries(cols.map(n => [n, r[idx(n)]])));
    if (out.clubsCsv.length >= 20) break;
  }

  const pl = (await cachedText('players.csv.gz')).split('\n');
  const ph = parseQuoted(pl[0]);
  const iClub = ph.indexOf('current_club_name'), iComp = ph.indexOf('current_club_domestic_competition_id'),
    iVal = ph.indexOf('market_value_in_eur'), iLast = ph.indexOf('last_season');
  const agg = new Map<string, { club: string; comp: string; players: number; top15M: number; vals: number[]; lastSeasons: Record<string, number> }>();
  for (const line of pl.slice(1)) {
    if (!line || !normQ(line).includes(needle)) continue;
    const r = line.includes('"') ? parseQuoted(line) : line.split(',');
    const club = r[iClub] || '';
    if (!normQ(club).includes(needle)) continue;
    const key = `${club}|${r[iComp]}`;
    const a = agg.get(key) || agg.set(key, { club, comp: r[iComp], players: 0, top15M: 0, vals: [], lastSeasons: {} }).get(key)!;
    a.players++;
    const v = parseFloat(r[iVal]);
    if (Number.isFinite(v) && v > 0) a.vals.push(v);
    const ls = r[iLast] || '?';
    a.lastSeasons[ls] = (a.lastSeasons[ls] || 0) + 1;
  }
  agg.forEach(a => {
    a.top15M = Math.round(a.vals.sort((x, y) => y - x).slice(0, 15).reduce((s, v) => s + v, 0) / 1e6);
    out.players.push({ club: a.club, comp: a.comp, players: a.players, withValue: a.vals.length, top15M: a.top15M, lastSeasons: a.lastSeasons });
  });

  byClub.forEach((m, club) => {
    if (!normQ(club).includes(needle)) return;
    const months = [...m.keys()].sort();
    out.history.push({ club, months: months.length, first: months[0], last: months[months.length - 1], lastTopM: Math.round((m.get(months[months.length - 1]) || 0) / 1e6) });
  });
  return out;
}

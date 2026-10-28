/**
 * fix261: names in the local script — teams, leagues, countries, cities and players in Hebrew and Arabic (Russian /
 * Greek / Hindi later: one more entry in utils/nameScript.ts NAME_LANGS and its rules).
 *
 * Tables (never touched by the retention job; in every backup like the rest of the database):
 *  - name_items: every name the site shows (sport, kind, the provider's Latin name, an id, country, how often it is
 *    played / opened), refreshed by the worker's "names" job; `views` = page opens (team / player pages, counted by the
 *    web process through deferred writes); `qid` / `wd_at` = the Wikidata item found (or tried) for it.
 *  - names: (sport, kind, latin, lang) → the name in that script and where it came from: 'admin' (Admin → Data & feeds →
 *    "Names in Hebrew / Arabic") > 'press' (utils/nameScript.ts PRESS: the spelling the Israeli / Arab press uses) >
 *    'wikidata' (the item's he / ar label; Wikidata text is CC0) > 'translit' (letter rules). A name with none of them
 *    stays as the provider writes it.
 *
 * The job (worker, every 30 min): collect the names (every 6 h), write press / transliterated rows for new ones, look
 * up WD_PER_RUN names on Wikidata (most opened / played first; each name once, again after 60 days when nothing was
 * found), then publish one map per language (Latin → local) that `/api/names/:lang` sends (the worker answers; the app
 * loads it before the first paint on he / ar pages, lib/names.ts) and the server's own texts use (nameIn: titles,
 * emails, push, calendar). Slugs never change: links stay Latin.
 */
import { db, DB_READ_ONLY } from '../db';
import logger from '../utils/logger';
import { yieldEvery } from './perf';
import { NAME_LANGS, type NameLang, isNameLang, fallbackName, nameKey, LOCAL_SCRIPT } from '../utils/nameScript';

export type NameKind = 'team' | 'league' | 'country' | 'city' | 'player';
export const NAME_KINDS: NameKind[] = ['team', 'league', 'country', 'city', 'player'];
const AF = 1_000_000_000;
const DAY = 86400000;
/** Wikidata look-ups per run (each a search + a share of one labels call; ~1 call a second) */
const WD_PER_RUN = Number(process.env.NAMES_WD_PER_RUN) || 120;
/** players in the map the app loads (most opened, then most played); teams, leagues, countries, cities: all */
const MAP_PLAYERS = Number(process.env.NAMES_MAP_PLAYERS) || 6000;
const RANK: Record<string, number> = { admin: 4, press: 3, wikidata: 2, translit: 1 };

if (!DB_READ_ONLY) {
  db.exec(`CREATE TABLE IF NOT EXISTS name_items (sport TEXT NOT NULL, kind TEXT NOT NULL, latin TEXT NOT NULL, id TEXT, country TEXT,
    weight INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, qid TEXT, wd_at TEXT, seen_at TEXT NOT NULL, PRIMARY KEY (sport, kind, latin))`);
  db.exec(`CREATE TABLE IF NOT EXISTS names (sport TEXT NOT NULL, kind TEXT NOT NULL, latin TEXT NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL,
    source TEXT NOT NULL, id TEXT, qid TEXT, at TEXT NOT NULL, PRIMARY KEY (sport, kind, latin, lang))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_names_lang ON names(lang, name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_name_items_id ON name_items(sport, kind, id)`);
}

const all = (sql: string, ...a: any[]): any[] => { try { return db.prepare(sql).all(...a) as any[]; } catch { return []; } };
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/* ---------- what the site shows ---------- */
type Item = { sport: string; kind: NameKind; latin: string; id: string | null; country: string | null; weight: number };
/** every team / league / country / city / player name of the last ~13 months, with how often it was played */
export function collectItems(): Item[] {
  const out = new Map<string, Item>();
  const add = (sport: string, kind: NameKind, latin: unknown, id: unknown, weight = 1, country: unknown = null) => {
    const n = String(latin ?? '').trim();
    if (!n || n.length > 80 || LOCAL_SCRIPT.test(n)) return;
    const k = `${sport}|${kind}|${n}`;
    const x = out.get(k);
    if (x) {
      x.weight += weight;
      // a league name of two countries ("Premier League": England, Ukraine …): '*' = no country's press spelling fits both
      if (kind === 'league' && x.country && country && x.country !== String(country)) x.country = '*';
      else if (!x.country && country) x.country = String(country);
      return;
    }
    out.set(k, { sport, kind, latin: n, id: id == null ? null : String(id), country: country ? String(country) : null, weight });
  };
  const since = daysAgo(400), sinceDay = since.slice(0, 10);
  // football: API-Football fixtures (+ league country), Football-Data.org predictions, national teams, players
  const leagueCountry = new Map<number, string>();
  try {
    for (const c of (require('./afMatches') as typeof import('./afMatches')).afCompetitions()) {
      const id = Number(String(c.code).slice(2));
      if (c.area?.name) { leagueCountry.set(id, c.area.name); add('', 'country', c.area.name, null, 5); }
      add('football', 'league', c.name, c.code, 20, c.area?.name);
    }
  } catch { /* not loaded */ }
  for (const r of all(`SELECT league_id AS lg, home_id AS id, home_name AS n, COUNT(*) AS c FROM af_fixtures WHERE date >= ? GROUP BY home_id, home_name UNION ALL SELECT league_id, away_id, away_name, COUNT(*) FROM af_fixtures WHERE date >= ?1 GROUP BY away_id, away_name`, sinceDay))
    add('football', 'team', r.n, AF + r.id, r.c, leagueCountry.get(r.lg) || null);
  for (const r of all(`SELECT home_team_id AS id, home_team AS n, COUNT(*) AS c FROM predictions WHERE utc_date >= ? GROUP BY home_team_id, home_team UNION ALL SELECT away_team_id, away_team, COUNT(*) FROM predictions WHERE utc_date >= ?1 GROUP BY away_team_id, away_team`, since))
    add('football', 'team', r.n, r.id, r.c);
  for (const r of all(`SELECT competition_code AS code, competition_name AS n, COUNT(*) AS c FROM predictions WHERE utc_date >= ? GROUP BY competition_code, competition_name`, since)) add('football', 'league', r.n, r.code, r.c);
  for (const r of all(`SELECT home_id AS id, home_name AS n, COUNT(*) AS c FROM nat_matches WHERE date >= ? GROUP BY home_id, home_name UNION ALL SELECT away_id, away_name, COUNT(*) FROM nat_matches WHERE date >= ?1 GROUP BY away_id, away_name`, sinceDay)) {
    add('football', 'team', r.n, AF + r.id, r.c);
    add('', 'country', r.n, null, r.c); // a national team's name is its country's
  }
  for (const r of all(`SELECT player_id AS id, name, SUM(COALESCE(apps, 0)) AS a FROM af_player_season WHERE season >= (SELECT MAX(season) - 1 FROM af_player_season) GROUP BY player_id, name`)) add('football', 'player', r.name, r.id, Math.max(1, r.a || 0));
  // basketball
  for (const r of all(`SELECT code, name, country FROM bb_leagues`)) { add('basketball', 'league', r.name, r.code, 20, r.country); if (r.country) add('', 'country', r.country, null, 5); }
  for (const r of all(`SELECT home_id AS id, home_name AS n, COUNT(*) AS c FROM bb_games WHERE kickoff >= ? GROUP BY home_id, home_name UNION ALL SELECT away_id, away_name, COUNT(*) FROM bb_games WHERE kickoff >= ?1 GROUP BY away_id, away_name`, since)) add('basketball', 'team', r.n, r.id, r.c);
  for (const r of all(`SELECT ps.player_id AS id, ps.name AS name, COUNT(*) AS c FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff >= ? GROUP BY ps.player_id, ps.name`, since)) add('basketball', 'player', r.name, r.id, r.c);
  // American football
  for (const r of all(`SELECT team_id, name, city FROM nfl_teams`)) { add('nfl', 'team', r.name, r.team_id, 30); if (r.city) add('', 'city', r.city, null, 3); }
  for (const r of all(`SELECT player_id, name FROM nfl_players`)) add('nfl', 'player', r.name, r.player_id, 2);
  // tennis
  for (const r of all(`SELECT id, name, country, ranking FROM tennis_players`)) {
    add('tennis', 'player', r.name, r.id, r.ranking ? Math.max(1, 600 - r.ranking) : 1);
    if (r.country && String(r.country).length > 3) add('', 'country', r.country, null, 1);
  }
  // cities of the venues (weather card)
  for (const r of all(`SELECT city, country, COUNT(*) AS c FROM extras_venues WHERE city IS NOT NULL GROUP BY city, country`)) { add('', 'city', r.city, null, r.c, r.country); if (r.country) add('', 'country', r.country, null, 1); }
  return [...out.values()];
}

/* ---------- Wikidata ---------- */
const UA = 'SportLikelyBot/1.0 (https://sportlikely.com; support@sportlikely.com) local-script names';
type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let fetcher: Fetcher = (url: string) => fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }) as any;
/** tests: a fake Wikidata */
export function setNamesFetcher(f: Fetcher | null) { fetcher = f || ((url: string) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }) as any); }
const GAP_MS = () => Math.max(0, Number(process.env.NAMES_GAP_MS ?? 700));
let lastCall = 0;
async function get(url: string): Promise<any> {
  const wait = lastCall + GAP_MS() - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const r = await fetcher(url);
  if (r.status === 429) throw new Error('Wikidata 429 (too many requests)');
  if (!r.ok) throw new Error(`Wikidata HTTP ${r.status}`);
  return r.json();
}
const WD = 'https://www.wikidata.org/w/api.php?format=json&formatversion=2&';
/** what an item's English description must say for each kind (the search also returns players for a club's name …) */
const KIND_DESC: Record<string, Record<NameKind, RegExp>> = {
  football: { team: /(football|soccer) (club|team)|national (association )?football team|futsal/i, league: /(football|soccer).*(league|cup|competition|championship|tournament|division)|(league|cup|competition|championship|tournament|division).*(football|soccer)/i, player: /(association )?football(er| player)|soccer player/i, country: /country|state/i, city: /city|town|capital|municipality|commune|village/i },
  basketball: { team: /basketball (club|team)/i, league: /basketball.*(league|competition|championship|cup)|(league|competition|championship|cup).*basketball/i, player: /basketball player/i, country: /country/i, city: /city/i },
  nfl: { team: /american football team|national football league team/i, league: /american football.*league/i, player: /american football player/i, country: /country/i, city: /city/i },
  tennis: { team: /tennis/i, league: /tennis/i, player: /tennis player/i, country: /country/i, city: /city/i },
  '': { team: /team|club/i, league: /league|cup/i, player: /player/i, country: /country|sovereign state|constituent country|territory/i, city: /city|town|capital|municipality|commune|metropolis|village|borough/i }
};
const cleanLabel = (s: string, lang: NameLang): string => {
  let x = String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (lang === 'he') x = x.replace(/^(מועדון (ה)?(כדורגל|כדורסל|ספורט)|קבוצת (ה)?(כדורגל|כדורסל))\s+/, '');
  else x = x.replace(/^(نادي|فريق)\s+/, '');
  return x.trim();
};
/** one name → the Wikidata item (or null) by search + kind check (+ the country in the description when we know it) */
export async function wikidataItem(it: { sport: string; kind: NameKind; latin: string; country: string | null }): Promise<string | null> {
  // an initial ("E. Haaland") or a two-letter code finds nothing reliable
  if (/^\p{L}\.\s/u.test(it.latin) || it.latin.length < 3) return null;
  const s = await get(`${WD}action=wbsearchentities&type=item&limit=8&language=en&uselang=en&search=${encodeURIComponent(it.latin)}`);
  const want = nameKey(it.latin.replace(/\b(FC|CF|AFC|SC|BC|KK)\b/g, ''));
  const rx = (KIND_DESC[it.sport] || KIND_DESC[''])[it.kind];
  const fits = (s?.search || []).filter((c: any) => {
    const label = nameKey(String(c.match?.text || c.label || '').replace(/\b(FC|CF|AFC|SC|BC|KK)\b/g, ''));
    return label === want && rx.test(String(c.description || ''));
  });
  if (!fits.length) return null;
  const country = it.country ? it.country.toLowerCase() : null;
  const best = (country && fits.find((c: any) => String(c.description || '').toLowerCase().includes(country))) || fits[0];
  return /^Q\d+$/.test(best.id) ? best.id : null;
}
/** the he / ar labels of a few items */
export async function wikidataLabels(qids: string[]): Promise<Map<string, Partial<Record<NameLang, string>>>> {
  const out = new Map<string, Partial<Record<NameLang, string>>>();
  for (let i = 0; i < qids.length; i += 50) {
    const part = qids.slice(i, i + 50);
    const j = await get(`${WD}action=wbgetentities&props=labels&languages=${NAME_LANGS.join('|')}&ids=${part.join('|')}`);
    for (const id of part) {
      const e = j?.entities?.[id];
      const l: Partial<Record<NameLang, string>> = {};
      for (const lang of NAME_LANGS) { const v = cleanLabel(e?.labels?.[lang]?.value || '', lang); if (v && LOCAL_SCRIPT.test(v)) l[lang] = v; }
      out.set(id, l);
    }
  }
  return out;
}

/* ---------- writing ---------- */
const upsertName = () => db.prepare(`INSERT INTO names (sport, kind, latin, lang, name, source, id, qid, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sport, kind, latin, lang) DO UPDATE SET name = excluded.name, source = excluded.source, id = COALESCE(excluded.id, names.id), qid = COALESCE(excluded.qid, names.qid), at = excluded.at`);
/** a name's row, unless a more trusted one is already there */
function writeName(st: ReturnType<typeof upsertName>, it: { sport: string; kind: string; latin: string; id?: string | null }, lang: NameLang, name: string, source: string, qid: string | null = null) {
  const old = db.prepare(`SELECT name, source FROM names WHERE sport = ? AND kind = ? AND latin = ? AND lang = ?`).get(it.sport, it.kind, it.latin, lang) as any;
  if (old && ((RANK[old.source] || 0) > (RANK[source] || 0) || (old.source === source && old.name === name))) return false;
  st.run(it.sport, it.kind, it.latin, lang, name, source, it.id ?? null, qid, new Date().toISOString());
  return true;
}

let lastCollect = 0, running = false;
const lastRun: { at: string | null; items: number; written: number; wdTried: number; wdFound: number; error: string | null } = { at: null, items: 0, written: 0, wdTried: 0, wdFound: 0, error: null };

/** the worker's "names" job */
export async function namesTick(opts: { collect?: boolean; wd?: number } = {}): Promise<typeof lastRun> {
  if (running || DB_READ_ONLY) return lastRun;
  running = true;
  const step = yieldEvery(50, 100);
  let written = 0, wdTried = 0, wdFound = 0;
  try {
    // 1. the names the site shows (every 6 hours)
    if (opts.collect || Date.now() - lastCollect > 6 * 3600 * 1000) {
      const items = collectItems();
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT INTO name_items (sport, kind, latin, id, country, weight, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sport, kind, latin) DO UPDATE SET id = COALESCE(excluded.id, name_items.id), country = COALESCE(excluded.country, name_items.country), weight = excluded.weight, seen_at = excluded.seen_at`);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        up.run(it.sport, it.kind, it.latin, it.id, it.country, it.weight, now);
        if (i % 500 === 499) await step();
      }
      lastCollect = Date.now();
      lastRun.items = items.length;
    }
    // 2. press spelling / transliteration for names without a row
    const st = upsertName();
    for (const lang of NAME_LANGS) {
      const rows = all(`SELECT i.sport, i.kind, i.latin, i.id, i.country FROM name_items i LEFT JOIN names n ON n.sport = i.sport AND n.kind = i.kind AND n.latin = i.latin AND n.lang = ? WHERE n.latin IS NULL`, lang);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const f = fallbackName(r.latin, lang, r.kind, r.country);
        if (f && writeName(st, r, lang, f.name, f.source)) written++;
        if (i % 200 === 199) await step();
      }
    }
    // 3. Wikidata: the most opened / played names not tried yet (or tried 60+ days ago without an item)
    const budget = opts.wd ?? (process.env.NAMES_WIKIDATA === '0' ? 0 : WD_PER_RUN);
    if (budget > 0) {
      const todo = all(`SELECT sport, kind, latin, id, country FROM name_items WHERE (wd_at IS NULL OR (qid IS NULL AND wd_at < ?)) AND kind != 'city'
        ORDER BY views DESC, weight DESC LIMIT ?`, daysAgo(60), budget);
      const found: { it: any; qid: string }[] = [];
      const mark = db.prepare(`UPDATE name_items SET qid = ?, wd_at = ? WHERE sport = ? AND kind = ? AND latin = ?`);
      for (const it of todo) {
        let qid: string | null = null;
        try { qid = await wikidataItem(it); } catch (e: any) { lastRun.error = String(e?.message || e); break; }
        wdTried++;
        mark.run(qid, new Date().toISOString(), it.sport, it.kind, it.latin);
        if (qid) found.push({ it, qid });
        await step();
      }
      if (found.length) {
        try {
          const labels = await wikidataLabels([...new Set(found.map(f => f.qid))]);
          for (const { it, qid } of found) {
            const l = labels.get(qid) || {};
            let any = false;
            for (const lang of NAME_LANGS) if (l[lang] && writeName(st, it, lang, l[lang]!, 'wikidata', qid)) { written++; any = true; }
            if (any) wdFound++;
          }
        } catch (e: any) { lastRun.error = String(e?.message || e); }
      }
    }
    Object.assign(lastRun, { at: new Date().toISOString(), written, wdTried, wdFound });
    if (written || !maps.size) await buildMaps(step);
  } catch (e: any) {
    lastRun.error = String(e?.message || e);
    logger.warn(`names: ${lastRun.error}`);
  } finally { running = false; }
  return lastRun;
}

/* ---------- the maps (Latin → local) ---------- */
const maps = new Map<NameLang, { json: string; map: Map<string, string>; builtAt: number }>();
let mapsAt = 0;
/** the map of one language: every team / league / country / city, the top players; the most trusted name per Latin */
export async function buildMaps(step: () => Promise<void> = async () => {}) {
  for (const lang of NAME_LANGS) {
    const map = new Map<string, { n: string; r: number }>();
    // a league name two countries use with different spellings ("Premier League"): left Latin (unless an admin chose one)
    const leagueNames = new Map<string, Set<string>>();
    const rows = all(`SELECT n.kind, n.latin, n.name, n.source, COALESCE(i.views, 0) AS v, COALESCE(i.weight, 0) AS w FROM names n
      LEFT JOIN name_items i ON i.sport = n.sport AND i.kind = n.kind AND i.latin = n.latin WHERE n.lang = ?`, lang);
    const players = rows.filter(r => r.kind === 'player').sort((a, b) => (RANK[b.source] || 0) - (RANK[a.source] || 0) || b.v - a.v || b.w - a.w).slice(0, MAP_PLAYERS);
    const keep = [...rows.filter(r => r.kind !== 'player'), ...players];
    for (let i = 0; i < keep.length; i++) {
      const r = keep[i];
      const rank = (RANK[r.source] || 0) * 1e9 + r.v * 1e3 + Math.min(999, r.w) + (r.kind === 'player' ? 0 : 5e8);
      if (r.kind === 'league' && r.source !== 'admin') { const set = leagueNames.get(r.latin) || new Set(); set.add(r.name); leagueNames.set(r.latin, set); }
      const x = map.get(r.latin);
      if (!x || rank > x.r) map.set(r.latin, { n: r.name, r: rank });
      if (i % 2000 === 1999) await step();
    }
    for (const [latin, set] of leagueNames) if (set.size > 1 && (map.get(latin)?.r || 0) < RANK.admin * 1e9) map.delete(latin);
    const plain = new Map([...map].map(([k, v]) => [k, v.n]));
    maps.set(lang, { json: JSON.stringify({ lang, builtAt: new Date().toISOString(), names: Object.fromEntries(plain) }), map: plain, builtAt: Date.now() });
  }
  mapsAt = Date.now();
}
/** `/api/names/:lang` (the worker answers it): the map as JSON text */
export function namesJson(lang: string): string | null {
  if (!isNameLang(lang)) return null;
  if (!maps.size && !DB_READ_ONLY) { void buildMaps(); }
  return maps.get(lang)?.json ?? JSON.stringify({ lang, builtAt: null, names: {} });
}

/** the server's own texts (titles, emails, push, calendar): a name in `lang`, else as given */
export function nameIn(lang: string | null | undefined, latin: string | null | undefined): string {
  const s = String(latin ?? '');
  if (!s || !isNameLang(lang)) return s;
  if (!maps.size || Date.now() - mapsAt > 30 * 60 * 1000) { mapsAt = Date.now(); void buildMaps(); }
  return maps.get(lang)?.map.get(s) ?? maps.get(lang)?.map.get(s.trim()) ?? s;
}

/** a text's names (whole pieces between " · ", " vs ", " – ", " | ", ": ", ", ") in the local script; the rest unchanged */
export function localNamesText(lang: string, text: string): string {
  if (!isNameLang(lang) || !text) return text;
  return text.split(/( · | vs | – | - | \| |: |, |\(|\))/).map(p => (p.length > 1 ? nameIn(lang, p) : p)).join('');
}
/** the same inside HTML: text between tags only (attributes, links and slugs untouched) */
export function localNamesHtml(lang: string, html: string): string {
  if (!isNameLang(lang) || !html) return html;
  return html.replace(/>([^<>]+)</g, (_all, t: string) => `>${localNamesText(lang, t)}<`);
}

/** search: a query in Hebrew / Arabic letters → the Latin names it matches (best first), else [] */
export function latinFor(q: string, limit = 5): string[] {
  const s = String(q || '').trim();
  if (!s || !LOCAL_SCRIPT.test(s)) return [];
  const rows = all(`SELECT n.latin, n.name, COALESCE(i.views, 0) AS v, COALESCE(i.weight, 0) AS w FROM names n LEFT JOIN name_items i ON i.sport = n.sport AND i.kind = n.kind AND i.latin = n.latin
    WHERE n.name LIKE ? ORDER BY (n.name = ?) DESC, (n.name LIKE ?) DESC, v DESC, w DESC LIMIT ?`, `%${s}%`, s, `${s}%`, limit * 3);
  return [...new Set(rows.map(r => r.latin as string))].slice(0, limit);
}

/** the web process notes a team / player page open (a deferred write: the worker writes it) */
export const VIEW_PATHS: [RegExp, string, NameKind][] = [
  [/^\/api\/team-page\/(\d+)$/, 'football', 'team'], [/^\/api\/player-page\/(\d+)$/, 'football', 'player'],
  [/^\/api\/basketball\/team\/(\d+)$/, 'basketball', 'team'], [/^\/api\/basketball\/player\/(\d+)$/, 'basketball', 'player'],
  [/^\/api\/nfl\/team\/(\d+)$/, 'nfl', 'team'], [/^\/api\/nfl\/player\/(\d+)$/, 'nfl', 'player'], [/^\/api\/tennis\/player\/(\d+)$/, 'tennis', 'player']
];
export function viewOf(path: string): { sport: string; kind: NameKind; id: string } | null {
  for (const [re, sport, kind] of VIEW_PATHS) {
    const m = re.exec(path);
    if (m) return { sport, kind, id: m[1] };
  }
  return null;
}
export const VIEW_SQL = `UPDATE name_items SET views = views + 1 WHERE sport = ? AND kind = ? AND id = ?`;

/* ---------- admin: Data & feeds → "Names in Hebrew / Arabic" ---------- */
export function namesAdmin(opts: { q?: string; kind?: string; limit?: number } = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit || 200));
  const q = String(opts.q || '').trim();
  const where: string[] = [], args: any[] = [];
  if (q) { where.push(`(i.latin LIKE ? OR EXISTS (SELECT 1 FROM names x WHERE x.sport = i.sport AND x.kind = i.kind AND x.latin = i.latin AND x.name LIKE ?))`); args.push(`%${q}%`, `%${q}%`); }
  if (opts.kind && NAME_KINDS.includes(opts.kind as NameKind)) { where.push(`i.kind = ?`); args.push(opts.kind); }
  const items = all(`SELECT i.sport, i.kind, i.latin, i.id, i.country, i.views, i.weight, i.qid FROM name_items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.views DESC, i.weight DESC LIMIT ?`, ...args, limit);
  const nm = db.prepare(`SELECT lang, name, source FROM names WHERE sport = ? AND kind = ? AND latin = ?`);
  const rows = items.map(i => {
    const by: Record<string, { name: string; source: string }> = {};
    for (const r of nm.all(i.sport, i.kind, i.latin) as any[]) by[r.lang] = { name: r.name, source: r.source };
    return { ...i, names: by };
  });
  return { langs: NAME_LANGS, rows, counts: namesCounts(), lastRun, mapSize: Object.fromEntries(NAME_LANGS.map(l => [l, maps.get(l)?.map.size ?? 0])) };
}
/** how many names have an entry per language, kind and source (the reply's numbers; data health) */
export function namesCounts() {
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const r of all(`SELECT lang, kind, source, COUNT(*) AS n FROM names GROUP BY lang, kind, source`)) ((out[r.lang] ||= {})[r.kind] ||= {})[r.source] = r.n;
  const items = Object.fromEntries(all(`SELECT kind, COUNT(*) AS n FROM name_items GROUP BY kind`).map(r => [r.kind, r.n]));
  return { byLang: out, items };
}
/** an admin's own spelling ('' = remove it: the press / Wikidata / rule name comes back) */
export function setAdminName(sport: string, kind: string, latin: string, lang: string, name: string): { ok: boolean; error?: string } {
  if (!isNameLang(lang)) return { ok: false, error: 'language' };
  if (!NAME_KINDS.includes(kind as NameKind)) return { ok: false, error: 'kind' };
  const it = db.prepare(`SELECT sport, kind, latin, id, qid, country FROM name_items WHERE sport = ? AND kind = ? AND latin = ?`).get(sport, kind, latin) as any;
  if (!it) return { ok: false, error: 'unknown name' };
  const n = String(name || '').trim().slice(0, 80);
  if (n) {
    upsertName().run(sport, kind, latin, lang, n, 'admin', it.id, it.qid, new Date().toISOString());
  } else {
    db.prepare(`DELETE FROM names WHERE sport = ? AND kind = ? AND latin = ? AND lang = ? AND source = 'admin'`).run(sport, kind, latin, lang);
    const f = fallbackName(latin, lang, kind, it.country);
    if (f) writeName(upsertName(), it, lang, f.name, f.source);
  }
  void buildMaps();
  return { ok: true };
}
/** Copy for Claude: the card's text (the top names and their sources) */
export function namesForClaude(): string {
  const a = namesAdmin({ limit: 60 });
  const lines = [`Names in Hebrew / Arabic (fix261). Last run: ${a.lastRun.at || 'not yet'}; items ${JSON.stringify(a.counts.items)}; Wikidata tried ${a.lastRun.wdTried}, found ${a.lastRun.wdFound}${a.lastRun.error ? `; error: ${a.lastRun.error}` : ''}.`,
    `Entries per language / kind / source: ${JSON.stringify(a.counts.byLang)}`, 'Most opened names (latin | he (source) | ar (source)):'];
  for (const r of a.rows) lines.push(`${r.sport || '-'} ${r.kind} | ${r.latin} | ${r.names.he ? `${r.names.he.name} (${r.names.he.source})` : '—'} | ${r.names.ar ? `${r.names.ar.name} (${r.names.ar.source})` : '—'}`);
  return lines.join('\n');
}

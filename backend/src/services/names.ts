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
import { NAME_LANGS, type NameLang, isNameLang, fallbackName, nameKey, LOCAL_SCRIPT, personOrder, spellingFlags, visibleName, FLAG_TEXT, type NameFlag } from '../utils/nameScript';
import { namesAiTick, namesAiStatus } from './namesAi';

/*
 * fix283 (Yarin, 29 Oct: "many mistakes" — 161 of the top 200 were letter rules): the spelling is built from the name in
 * first-last order (utils/nameScript.ts personOrder: API-Basketball writes "Lillard Damian"); Wikidata is matched by the
 * provider-linked ids it holds (name_items.ext: Transfermarkt, NBA.com, Basketball-Reference, Pro-Football-Reference,
 * ATP / WTA …, batch SPARQL) and a name search only counts for a player when birth date / nationality / club agree; the
 * Hebrew label, else the Hebrew Wikipedia title; labels refreshed weekly. Names nobody else spells go to the AI
 * (services/namesAi.ts, only with ANTHROPIC_API_KEY). Letter rules stay as the last step but are never shown: a row is
 * shown only when nameScript.visibleName says so (no check flagged it; AI confident enough; admin / approved always),
 * else the page keeps the Latin name and the row waits in the admin list.
 */

export type NameKind = 'team' | 'league' | 'country' | 'city' | 'player';
export const NAME_KINDS: NameKind[] = ['team', 'league', 'country', 'city', 'player'];
const AF = 1_000_000_000;
const DAY = 86400000;
/** Wikidata look-ups per run (each a search + a share of one labels call; ~1 call a second) */
const WD_PER_RUN = Number(process.env.NAMES_WD_PER_RUN) || 120;
/** players in the map the app loads (most opened, then most played); teams, leagues, countries, cities: all */
const MAP_PLAYERS = Number(process.env.NAMES_MAP_PLAYERS) || 6000;
const RANK: Record<string, number> = { admin: 6, press: 5, wikidata: 4, ai: 3, translit: 1 };
/** fix283: Wikidata properties of the provider-linked ids (name_items.ext = {"P2446": "28003", …}) */
export const WD_ID_PROPS: Record<string, string> = {
  P2446: 'Transfermarkt player', P7223: 'Transfermarkt club', P3647: 'NBA.com player', P2685: 'Basketball-Reference player',
  P3561: 'Pro-Football-Reference player', P3686: 'ESPN NFL athlete', P536: 'ATP player', P597: 'WTA player',
  P12302: 'Sofascore player', P5750: 'FBref player', P2369: 'Soccerway player'
};

if (!DB_READ_ONLY) {
  db.exec(`CREATE TABLE IF NOT EXISTS name_items (sport TEXT NOT NULL, kind TEXT NOT NULL, latin TEXT NOT NULL, id TEXT, country TEXT,
    weight INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, qid TEXT, wd_at TEXT, seen_at TEXT NOT NULL, PRIMARY KEY (sport, kind, latin))`);
  db.exec(`CREATE TABLE IF NOT EXISTS names (sport TEXT NOT NULL, kind TEXT NOT NULL, latin TEXT NOT NULL, lang TEXT NOT NULL, name TEXT NOT NULL,
    source TEXT NOT NULL, id TEXT, qid TEXT, at TEXT NOT NULL, PRIMARY KEY (sport, kind, latin, lang))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_names_lang ON names(lang, name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_name_items_id ON name_items(sport, kind, id)`);
  // fix283: the name in first-last order and what Wikidata is checked against; the checks' result per spelling
  for (const col of ['display TEXT', 'first TEXT', 'last TEXT', 'dob TEXT', 'team TEXT', 'ext TEXT']) { try { db.exec(`ALTER TABLE name_items ADD COLUMN ${col}`); } catch { /* there */ } }
  for (const col of ['conf REAL', 'flags TEXT', 'approved INTEGER NOT NULL DEFAULT 0', 'basis TEXT']) { try { db.exec(`ALTER TABLE names ADD COLUMN ${col}`); } catch { /* there */ } }
  db.exec(`CREATE TABLE IF NOT EXISTS names_meta (key TEXT PRIMARY KEY, value TEXT, at TEXT NOT NULL)`);
}
/** the name the spelling is built from: first-last order */
const basisOf = (it: { sport: string; kind: string; latin: string; display?: string | null }) => it.display || personOrder(it.latin, { sport: it.sport, kind: it.kind });
/** fix283: a provider's ids of one item (Wikidata properties, WD_ID_PROPS) — kept for the next names run */
export function setNameExtIds(sport: string, kind: NameKind, id: string | number, ids: Record<string, string | number | null | undefined>) {
  const clean = Object.fromEntries(Object.entries(ids).filter(([p, v]) => WD_ID_PROPS[p] && v != null && String(v).trim()).map(([p, v]) => [p, String(v).trim()]));
  if (!Object.keys(clean).length) return;
  const row = db.prepare(`SELECT latin, ext FROM name_items WHERE sport = ? AND kind = ? AND id = ?`).get(sport, kind, String(id)) as any;
  if (!row) return;
  let old: Record<string, string> = {};
  try { old = row.ext ? JSON.parse(row.ext) : {}; } catch { /* none */ }
  db.prepare(`UPDATE name_items SET ext = ? WHERE sport = ? AND kind = ? AND latin = ?`).run(JSON.stringify({ ...old, ...clean }), sport, kind, row.latin);
}

const all = (sql: string, ...a: any[]): any[] => { try { return db.prepare(sql).all(...a) as any[]; } catch { return []; } };
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/* ---------- what the site shows ---------- */
type Item = { sport: string; kind: NameKind; latin: string; id: string | null; country: string | null; weight: number; display?: string | null; dob?: string | null; team?: string | null };
/** every team / league / country / city / player name of the last ~13 months, with how often it was played */
export function collectItems(): Item[] {
  const out = new Map<string, Item>();
  const add = (sport: string, kind: NameKind, latin: unknown, id: unknown, weight = 1, country: unknown = null, more: { first?: string | null; last?: string | null; dob?: string | null; team?: string | null } = {}) => {
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
    const display = kind === 'player' ? personOrder(n, { sport, kind, first: more.first, last: more.last }) : null;
    out.set(k, { sport, kind, latin: n, id: id == null ? null : String(id), country: country ? String(country) : null, weight, display: display && display !== n ? display : null, dob: more.dob || null, team: more.team || null });
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
  const afTeam = new Map<number, string>();
  for (const r of all(`SELECT home_id AS id, MAX(home_name) AS n FROM af_fixtures WHERE date >= ? GROUP BY home_id`, sinceDay)) afTeam.set(r.id, r.n);
  for (const r of all(`SELECT player_id AS id, name, SUM(COALESCE(apps, 0)) AS a, MAX(team_id) AS t FROM af_player_season WHERE season >= (SELECT MAX(season) - 1 FROM af_player_season) GROUP BY player_id, name`)) add('football', 'player', r.name, r.id, Math.max(1, r.a || 0), null, { team: afTeam.get(r.t) || null });
  // basketball
  for (const r of all(`SELECT code, name, country FROM bb_leagues`)) { add('basketball', 'league', r.name, r.code, 20, r.country); if (r.country) add('', 'country', r.country, null, 5); }
  for (const r of all(`SELECT home_id AS id, home_name AS n, COUNT(*) AS c FROM bb_games WHERE kickoff >= ? GROUP BY home_id, home_name UNION ALL SELECT away_id, away_name, COUNT(*) FROM bb_games WHERE kickoff >= ?1 GROUP BY away_id, away_name`, since)) add('basketball', 'team', r.n, r.id, r.c);
  // fix283: API-Basketball writes players surname first ("Lillard Damian"): balldontlie's first / last when it is the NBA
  // player of the same name, else the given name (the last word) first (personOrder); their team for the Wikidata check
  const bbTeam = new Map<number, string>();
  for (const r of all(`SELECT home_id AS id, MAX(home_name) AS n FROM bb_games WHERE kickoff >= ? GROUP BY home_id`, since)) bbTeam.set(r.id, r.n);
  const bdl = new Map<string, { first: string; last: string; country: string | null }[]>();
  for (const r of all(`SELECT first, last, country FROM bdl_players WHERE active = 1`)) { const k = nameKey(`${r.last} ${r.first}`); bdl.set(k, [...(bdl.get(k) || []), r]); }
  for (const r of all(`SELECT ps.player_id AS id, ps.name AS name, COUNT(*) AS c, MAX(ps.team_id) AS t FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.kickoff >= ? GROUP BY ps.player_id, ps.name`, since)) {
    const b = bdl.get(nameKey(r.name || ''));
    const one = b && b.length === 1 ? b[0] : null;
    add('basketball', 'player', r.name, r.id, r.c, one?.country || null, { first: one?.first, last: one?.last, team: bbTeam.get(r.t) || null });
  }
  // American football
  for (const r of all(`SELECT team_id, name, city FROM nfl_teams`)) { add('nfl', 'team', r.name, r.team_id, 30); if (r.city) add('', 'city', r.city, null, 3); }
  const nflTeam = new Map<number, string>(all(`SELECT team_id, name FROM nfl_teams`).map(r => [r.team_id, r.name]));
  for (const r of all(`SELECT player_id, name, team_id FROM nfl_players`)) add('nfl', 'player', r.name, r.player_id, 2, null, { team: nflTeam.get(r.team_id) || null });
  // tennis
  const tp = all(`SELECT id, name, country, ranking, dob, first_name, last_name FROM tennis_players`);
  for (const r of tp.length ? tp : all(`SELECT id, name, country, ranking FROM tennis_players`)) {
    add('tennis', 'player', r.name, r.id, r.ranking ? Math.max(1, 600 - r.ranking) : 1, r.country && String(r.country).length > 3 ? r.country : null, { first: r.first_name, last: r.last_name, dob: r.dob });
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
export async function wikidataItem(it: { sport: string; kind: NameKind; latin: string; country: string | null; display?: string | null }): Promise<string | null> {
  return (await wikidataCandidates(it))[0] ?? null;
}
/** fix283: the items a name search finds that fit the kind (best first; the country in the description first) */
export async function wikidataCandidates(it: { sport: string; kind: NameKind; latin: string; country: string | null; display?: string | null }): Promise<string[]> {
  const q = it.kind === 'player' ? basisOf(it as any) : it.latin;
  // an initial ("E. Haaland") or a two-letter code finds nothing reliable
  if (/^\p{L}\.\s/u.test(q) || /(^|\s)\p{L}\.(\s|$)/u.test(q) || q.length < 3) return [];
  const s = await get(`${WD}action=wbsearchentities&type=item&limit=8&language=en&uselang=en&search=${encodeURIComponent(q)}`);
  const want = nameKey(q.replace(/\b(FC|CF|AFC|SC|BC|KK)\b/g, ''));
  const rx = (KIND_DESC[it.sport] || KIND_DESC[''])[it.kind];
  const fits = (s?.search || []).filter((c: any) => {
    const label = nameKey(String(c.match?.text || c.label || '').replace(/\b(FC|CF|AFC|SC|BC|KK)\b/g, ''));
    return label === want && rx.test(String(c.description || ''));
  });
  const country = it.country ? it.country.toLowerCase() : null;
  const sorted = [...fits.filter((c: any) => country && String(c.description || '').toLowerCase().includes(country)), ...fits.filter((c: any) => !(country && String(c.description || '').toLowerCase().includes(country)))];
  return sorted.map((c: any) => String(c.id)).filter(id => /^Q\d+$/.test(id)).slice(0, 3);
}

/** fix283: provider-linked ids → items (one SPARQL query per property and 50 ids) */
export async function wikidataByIds(prop: string, values: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!/^P\d+$/.test(prop)) return out;
  for (let i = 0; i < values.length; i += 50) {
    const part = values.slice(i, i + 50).map(v => String(v).replace(/["\\\n]/g, ''));
    const q = `SELECT ?item ?v WHERE { VALUES ?v { ${part.map(v => `"${v}"`).join(' ')} } ?item wdt:${prop} ?v . }`;
    const j = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`);
    for (const b of j?.results?.bindings || []) {
      const qid = String(b?.item?.value || '').split('/').pop() || '', v = String(b?.v?.value || '');
      if (/^Q\d+$/.test(qid) && v && !out.has(v)) out.set(v, qid);
    }
  }
  return out;
}
type Ent = { en: string[]; labels: Partial<Record<NameLang, string>>; dob: string | null; nat: string[]; teams: string[] };
const claimIds = (e: any, p: string): string[] => (e?.claims?.[p] || []).map((c: any) => c?.mainsnak?.datavalue?.value?.id).filter((x: any) => typeof x === 'string');
/** fix283: items → English names, he / ar label (else the he / ar Wikipedia title), birth date, citizenship and clubs (English labels) */
export async function wikidataEntities(qids: string[], withRefs: boolean): Promise<Map<string, Ent>> {
  const out = new Map<string, Ent>();
  const raw = new Map<string, any>();
  for (let i = 0; i < qids.length; i += 50) {
    const part = qids.slice(i, i + 50);
    const j = await get(`${WD}action=wbgetentities&props=labels|aliases|claims|sitelinks&languages=en|${NAME_LANGS.join('|')}&sitefilter=${NAME_LANGS.map(l => `${l}wiki`).join('|')}&ids=${part.join('|')}`);
    for (const id of part) if (j?.entities?.[id]) raw.set(id, j.entities[id]);
  }
  const refs = new Map<string, string>();
  if (withRefs) {
    const want = [...new Set([...raw.values()].flatMap(e => [...claimIds(e, 'P27'), ...claimIds(e, 'P54')]))].slice(0, 400);
    for (let i = 0; i < want.length; i += 50) {
      const part = want.slice(i, i + 50);
      const j = await get(`${WD}action=wbgetentities&props=labels&languages=en&ids=${part.join('|')}`);
      for (const id of part) { const v = j?.entities?.[id]?.labels?.en?.value; if (v) refs.set(id, v); }
    }
  }
  for (const [id, e] of raw) {
    const labels: Partial<Record<NameLang, string>> = {};
    for (const lang of NAME_LANGS) {
      const v = cleanLabel(e?.labels?.[lang]?.value || '', lang) || cleanLabel(e?.sitelinks?.[`${lang}wiki`]?.title || '', lang);
      if (v && LOCAL_SCRIPT.test(v)) labels[lang] = v;
    }
    const t = String(e?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time || '');
    const m = /^\+?(\d{4})-(\d{2})-(\d{2})/.exec(t);
    out.set(id, {
      en: [e?.labels?.en?.value, ...((e?.aliases?.en || []).map((a: any) => a?.value))].filter(Boolean),
      labels, dob: m ? (m[2] === '00' ? m[1] : `${m[1]}-${m[2]}-${m[3]}`) : null,
      nat: claimIds(e, 'P27').map(q => refs.get(q)).filter(Boolean) as string[], teams: claimIds(e, 'P54').map(q => refs.get(q)).filter(Boolean) as string[]
    });
  }
  return out;
}
const dobOk = (ours: string, wd: string) => (wd.length === 4 ? ours.slice(0, 4) === wd : Math.abs(Date.parse(ours.slice(0, 10)) - Date.parse(wd)) <= 86400000);
const sameish = (a: string, b: string) => { const x = nameKey(a).replace(/\b(fc|cf|afc|sc|bc|kk|club|the)\b/g, '').trim(), y = nameKey(b).replace(/\b(fc|cf|afc|sc|bc|kk|club|the)\b/g, '').trim(); return !!x && !!y && (x.includes(y) || y.includes(x)); };
/**
 * fix283: is this item our player? Found by a provider id: the surname must be in its English name (and a birth date we
 * know must fit). Found by name: a birth date we know must fit, and one more thing must agree (birth date, citizenship or
 * a club) — a name alone is not enough (Wikidata has many "Jordan Washington"s).
 */
export function playerFits(it: { latin: string; display?: string | null; sport: string; kind: string; dob?: string | null; country?: string | null; team?: string | null }, e: Ent, byId: boolean): boolean {
  const basis = basisOf(it as any);
  if (it.dob && e.dob && !dobOk(it.dob, e.dob)) return false;
  if (byId) { const last = nameKey(basis).split(' ').pop() || ''; return !last || e.en.some(n => nameKey(n).split(' ').includes(last)); }
  const agree = (it.dob && e.dob && dobOk(it.dob, e.dob)) || (it.country && e.nat.some(n => sameish(n, it.country!))) || (it.team && e.teams.some(t => sameish(t, it.team!)));
  return !!agree;
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
const upsertName = () => db.prepare(`INSERT INTO names (sport, kind, latin, lang, name, source, id, qid, at, conf, flags, approved, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(sport, kind, latin, lang) DO UPDATE SET name = excluded.name, source = excluded.source, id = COALESCE(excluded.id, names.id), qid = COALESCE(excluded.qid, names.qid), at = excluded.at,
    conf = excluded.conf, flags = excluded.flags, approved = 0, basis = excluded.basis`);
let oldName: ReturnType<typeof db.prepare> | null = null;
type It = { sport: string; kind: string; latin: string; id?: string | null; display?: string | null };
/**
 * a name's row, unless a more trusted one is already there. fix283: every spelling but an admin's goes through the checks
 * (flags); an admin's or an approved row is never overwritten; a flagged row gives way to a clean one of any source but
 * the letter rules.
 */
function writeName(st: ReturnType<typeof upsertName>, it: It, lang: NameLang, name: string, source: string, qid: string | null = null, conf: number | null = null) {
  oldName ||= db.prepare(`SELECT name, source, flags, approved FROM names WHERE sport = ? AND kind = ? AND latin = ? AND lang = ?`);
  const old = oldName.get(it.sport, it.kind, it.latin, lang) as any;
  const basis = basisOf(it);
  const flags = source === 'admin' ? '' : spellingFlags(basis, name, lang, it.kind).join(',');
  if (old) {
    if (old.source === 'admin' || old.approved) return false;
    if (old.source === source && old.name === name && (old.flags || '') === flags) return false;
    const cleanOverFlagged = old.flags && !flags && source !== 'translit';
    if ((RANK[old.source] || 0) > (RANK[source] || 0) && !cleanOverFlagged) return false;
  }
  st.run(it.sport, it.kind, it.latin, lang, name, source, it.id ?? null, qid, new Date().toISOString(), conf, flags || null, basis);
  return true;
}
/** fix283: the AI's spellings (services/namesAi.ts) */
export function writeAiNames(rows: { it: It; lang: NameLang; name: string; conf: number }[]): number {
  const st = upsertName();
  let n = 0;
  for (const r of rows) if (writeName(st, r.it, r.lang, r.name, 'ai', null, r.conf)) n++;
  if (n) void buildMaps();
  return n;
}
/**
 * fix272: rows written SLICE at a time, each slice one transaction (never across a yield: another job's write would land
 * inside it), a yield between. The job wrote every row as its own commit — tens of thousands of commits on a volume with
 * 1.5-s reads, still on its first run 9 h after the deploy, the map the pages load (built at the end) empty meanwhile.
 */
const SLICE = 500;
async function inSlices<T>(list: T[], fn: (x: T) => void, step: () => Promise<void>) {
  for (let i = 0; i < list.length; i += SLICE) {
    const own = !(db as any).isTransaction;
    if (own) db.exec('BEGIN');
    try {
      for (const x of list.slice(i, i + SLICE)) fn(x);
      if (own) db.exec('COMMIT');
    } catch (e) { if (own) { try { db.exec('ROLLBACK'); } catch { /* none open */ } } throw e; }
    await step();
  }
}

let lastCollect = 0, running = false;
const lastRun: { at: string | null; items: number; written: number; wdTried: number; wdFound: number; error: string | null } = { at: null, items: 0, written: 0, wdTried: 0, wdFound: 0, error: null };

const meta = (key: string): string | null => { try { return ((db.prepare(`SELECT value FROM names_meta WHERE key = ?`).get(key) as any)?.value ?? null); } catch { return null; } };
/**
 * fix283, once: the press / letter-rule rows are built again from the first-last name with the new rules (deleted here,
 * written by step 2), every Wikidata row goes through the checks, and every name is looked up on Wikidata again (by ids
 * first). Admin rows stay as they are.
 */
async function rerunAll(step: () => Promise<void>) {
  db.exec(`DELETE FROM names WHERE source IN ('press', 'translit') AND COALESCE(approved, 0) = 0`);
  const rows = all(`SELECT n.sport, n.kind, n.latin, n.lang, n.name, i.display FROM names n LEFT JOIN name_items i ON i.sport = n.sport AND i.kind = n.kind AND i.latin = n.latin WHERE n.source NOT IN ('admin')`);
  const upd = db.prepare(`UPDATE names SET flags = ?, basis = ? WHERE sport = ? AND kind = ? AND latin = ? AND lang = ?`);
  await inSlices(rows, r => { if (!isNameLang(r.lang)) return; const b = basisOf(r); upd.run(spellingFlags(b, r.name, r.lang, r.kind).join(',') || null, b, r.sport, r.kind, r.latin, r.lang); }, step);
  db.exec(`UPDATE name_items SET wd_at = NULL`);
  db.prepare(`INSERT OR REPLACE INTO names_meta (key, value, at) VALUES ('fix283', ?, ?)`).run(String(rows.length), new Date().toISOString());
}

/** the worker's "names" job */
export async function namesTick(opts: { collect?: boolean; wd?: number; ai?: boolean } = {}): Promise<typeof lastRun> {
  if (running || DB_READ_ONLY) return lastRun;
  running = true;
  const step = yieldEvery(50, 100);
  let written = 0, mapped = 0, wdTried = 0, wdFound = 0;
  try {
    // 1. the names the site shows (every 6 hours)
    if (opts.collect || Date.now() - lastCollect > 6 * 3600 * 1000) {
      const items = collectItems();
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT INTO name_items (sport, kind, latin, id, country, weight, seen_at, display, dob, team) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sport, kind, latin) DO UPDATE SET id = COALESCE(excluded.id, name_items.id), country = COALESCE(excluded.country, name_items.country), weight = excluded.weight, seen_at = excluded.seen_at,
          display = excluded.display, dob = COALESCE(excluded.dob, name_items.dob), team = COALESCE(excluded.team, name_items.team)`);
      await inSlices(items, it => { up.run(it.sport, it.kind, it.latin, it.id, it.country, it.weight, now, it.display ?? null, it.dob ?? null, it.team ?? null); }, step);
      lastCollect = Date.now();
      lastRun.items = items.length;
    }
    // fix283: once — every existing name again through the new steps (order, checks, Wikidata by ids, AI)
    if (!meta('fix283')) await rerunAll(step);
    // 2. press spelling / transliteration for names without a row (built from the first-last name)
    const st = upsertName();
    for (const lang of NAME_LANGS) {
      const rows = all(`SELECT i.sport, i.kind, i.latin, i.id, i.country, i.display FROM name_items i LEFT JOIN names n ON n.sport = i.sport AND n.kind = i.kind AND n.latin = i.latin AND n.lang = ? WHERE n.latin IS NULL`, lang);
      await inSlices(rows, r => {
        const f = fallbackName(basisOf(r), lang, r.kind, r.country) || (r.display ? fallbackName(r.latin, lang, r.kind, r.country) : null);
        if (f && writeName(st, r, lang, f.name, f.source)) written++;
      }, step);
    }
    // fix272: the maps now — the pages get the press / letter-rule names at once, Wikidata's labels on top later
    if (written || !maps.size) { await buildMaps(step); mapped = written; }
    // 3. Wikidata (fix283): the most opened / played names not tried yet, tried 60+ days ago without an item, or with an
    // item whose labels are a week old. Provider-linked ids first (SPARQL), then a name search with the player checks.
    const budget = opts.wd ?? (process.env.NAMES_WIKIDATA === '0' ? 0 : WD_PER_RUN);
    if (budget > 0) {
      const todo = all(`SELECT sport, kind, latin, id, country, display, dob, team, ext, qid FROM name_items
        WHERE kind != 'city' AND (wd_at IS NULL OR (qid IS NULL AND wd_at < ?) OR (qid IS NOT NULL AND wd_at < ?))
        ORDER BY views DESC, weight DESC LIMIT ?`, daysAgo(60), daysAgo(7), budget);
      const mark = db.prepare(`UPDATE name_items SET qid = ?, wd_at = ? WHERE sport = ? AND kind = ? AND latin = ?`);
      const cands = new Map<any, { qids: string[]; byId: boolean }>();
      try {
        // ids → items
        const byProp = new Map<string, Map<string, any[]>>();
        for (const it of todo) {
          let ext: Record<string, string> = {};
          try { ext = it.ext ? JSON.parse(it.ext) : {}; } catch { /* none */ }
          for (const [p, v] of Object.entries(ext)) { if (!WD_ID_PROPS[p]) continue; const m = byProp.get(p) || new Map(); m.set(String(v), [...(m.get(String(v)) || []), it]); byProp.set(p, m); }
        }
        for (const [p, m] of byProp) {
          const hits = await wikidataByIds(p, [...m.keys()]);
          for (const [v, qid] of hits) for (const it of m.get(v) || []) if (!cands.has(it)) cands.set(it, { qids: [qid], byId: true });
        }
        // the rest: the item found before (weekly refresh) or a name search
        for (const it of todo) {
          if (cands.has(it)) continue;
          if (it.qid) { cands.set(it, { qids: [it.qid], byId: true }); continue; }
          cands.set(it, { qids: await wikidataCandidates(it), byId: false });
          wdTried++;
          await step();
        }
        const ents = await wikidataEntities([...new Set([...cands.values()].flatMap(c => c.qids))], true);
        for (const [it, c] of cands) {
          const qid = c.qids.find(q => { const e = ents.get(q); return e && (it.kind !== 'player' || playerFits(it, e, c.byId)); }) || null;
          mark.run(qid, new Date().toISOString(), it.sport, it.kind, it.latin);
          if (!qid) continue;
          const l = ents.get(qid)!.labels;
          let any = false;
          for (const lang of NAME_LANGS) if (l[lang] && writeName(st, it, lang, l[lang]!, 'wikidata', qid)) { written++; any = true; }
          if (any) wdFound++;
        }
      } catch (e: any) { lastRun.error = String(e?.message || e); }
    }
    // 4. fix283: the AI for names nobody else spells (only with ANTHROPIC_API_KEY; daily cost cap)
    if (opts.ai !== false) {
      try { const a = await namesAiTick(); written += a.written; if (a.error) lastRun.error = a.error; } catch (e: any) { lastRun.error = String(e?.message || e); }
    }
    Object.assign(lastRun, { at: new Date().toISOString(), written, wdTried, wdFound });
    if (written > mapped || !maps.size) await buildMaps(step);
  } catch (e: any) {
    lastRun.error = String(e?.message || e);
    logger.warn(`names: ${lastRun.error}`);
  } finally { running = false; }
  return lastRun;
}

/* ---------- the maps (Latin → local) ---------- */
const maps = new Map<NameLang, { json: string; map: Map<string, string>; builtAt: number }>();
let mapsAt = 0;
/**
 * the map of one language: every team / league / country / city, the top players; the most trusted name per Latin.
 * fix283: only rows visitors may see (nameScript.visibleName: never letter rules, never a flagged spelling, the AI only
 * when confident) — anything else stays Latin on the page; a player's first-last name is a key too ("Damian Lillard").
 */
export async function buildMaps(step: () => Promise<void> = async () => {}) {
  for (const lang of NAME_LANGS) {
    const map = new Map<string, { n: string; r: number }>();
    // a league name two countries use with different spellings ("Premier League"): left Latin (unless an admin chose one)
    const leagueNames = new Map<string, Set<string>>();
    const rows = all(`SELECT n.kind, n.latin, n.name, n.source, n.conf, n.flags, n.approved, i.display, COALESCE(i.views, 0) AS v, COALESCE(i.weight, 0) AS w FROM names n
      LEFT JOIN name_items i ON i.sport = n.sport AND i.kind = n.kind AND i.latin = n.latin WHERE n.lang = ?`, lang).filter(r => visibleName(r));
    const players = rows.filter(r => r.kind === 'player').sort((a, b) => (RANK[b.source] || 0) - (RANK[a.source] || 0) || b.v - a.v || b.w - a.w).slice(0, MAP_PLAYERS);
    const keep = [...rows.filter(r => r.kind !== 'player'), ...players];
    for (let i = 0; i < keep.length; i++) {
      const r = keep[i];
      const rank = (RANK[r.source] || 0) * 1e9 + r.v * 1e3 + Math.min(999, r.w) + (r.kind === 'player' ? 0 : 5e8);
      if (r.kind === 'league' && r.source !== 'admin') { const set = leagueNames.get(r.latin) || new Set(); set.add(r.name); leagueNames.set(r.latin, set); }
      for (const key of r.display && r.display !== r.latin ? [r.latin, r.display] : [r.latin]) {
        const x = map.get(key);
        if (!x || rank > x.r) map.set(key, { n: r.name, r: rank });
      }
      if (i % 2000 === 1999) await step();
    }
    for (const [latin, set] of leagueNames) if (set.size > 1 && (map.get(latin)?.r || 0) < RANK.admin * 1e9) map.delete(latin);
    const plain = new Map([...map].map(([k, v]) => [k, v.n]));
    maps.set(lang, { json: JSON.stringify({ lang, builtAt: new Date().toISOString(), names: Object.fromEntries(plain) }), map: plain, builtAt: Date.now() });
  }
  mapsAt = Date.now();
}
/**
 * `/api/names/:lang` (the worker answers it): the map as JSON text; '' = not built yet (fix273: the route answers 202 pending,
 * never an empty map — the web kept it, browsers cached it 30 min and the app saved it as "the names")
 */
export function namesJson(lang: string): string | null {
  if (!isNameLang(lang)) return null;
  if (!maps.size && !DB_READ_ONLY) { void buildMaps(); }
  const m = maps.get(lang);
  return m && m.map.size ? m.json : '';
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
/** the source a visitor sees for a row ('latin' = the provider's name stays) */
const shownSource = (r: any): string => (r && visibleName(r) ? r.source : 'latin');
export function namesAdmin(opts: { q?: string; kind?: string; limit?: number; flagged?: boolean } = {}) {
  const limit = Math.min(500, Math.max(1, opts.limit || 300));
  const q = String(opts.q || '').trim();
  const where: string[] = [], args: any[] = [];
  if (q) { where.push(`(i.latin LIKE ? OR i.display LIKE ? OR EXISTS (SELECT 1 FROM names x WHERE x.sport = i.sport AND x.kind = i.kind AND x.latin = i.latin AND x.name LIKE ?))`); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (opts.kind && NAME_KINDS.includes(opts.kind as NameKind)) { where.push(`i.kind = ?`); args.push(opts.kind); }
  if (opts.flagged) where.push(`EXISTS (SELECT 1 FROM names x WHERE x.sport = i.sport AND x.kind = i.kind AND x.latin = i.latin AND x.flags IS NOT NULL AND x.source != 'admin' AND COALESCE(x.approved, 0) = 0)`);
  const items = all(`SELECT i.sport, i.kind, i.latin, i.display, i.id, i.country, i.views, i.weight, i.qid FROM name_items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY i.views DESC, i.weight DESC LIMIT ?`, ...args, limit);
  const nm = db.prepare(`SELECT lang, name, source, conf, flags, approved FROM names WHERE sport = ? AND kind = ? AND latin = ?`);
  const rows = items.map(i => {
    const by: Record<string, { name: string; source: string; shown: string; conf: number | null; flags: string[]; approved: boolean }> = {};
    for (const r of nm.all(i.sport, i.kind, i.latin) as any[]) by[r.lang] = { name: r.name, source: r.source, shown: shownSource(r), conf: r.conf ?? null, flags: r.flags ? String(r.flags).split(',') : [], approved: !!r.approved };
    return { ...i, names: by };
  });
  return { langs: NAME_LANGS, rows, counts: namesCounts(), top: topCounts(rows), lastRun, ai: namesAiStatus(), flagText: FLAG_TEXT, mapSize: Object.fromEntries(NAME_LANGS.map(l => [l, maps.get(l)?.map.size ?? 0])) };
}
/** fix283: the list's rows per shown source and language (press / wikidata / ai / admin / latin) */
function topCounts(rows: { names: Record<string, { shown: string }> }[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const lang of NAME_LANGS) { const c: Record<string, number> = {}; for (const r of rows) { const k = r.names[lang]?.shown || 'latin'; c[k] = (c[k] || 0) + 1; } out[lang] = c; }
  return out;
}
/** how many names have an entry per language, kind and source (the reply's numbers; data health); fix283: + what is shown */
export function namesCounts() {
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const r of all(`SELECT lang, kind, source, COUNT(*) AS n FROM names GROUP BY lang, kind, source`)) ((out[r.lang] ||= {})[r.kind] ||= {})[r.source] = r.n;
  const items = Object.fromEntries(all(`SELECT kind, COUNT(*) AS n FROM name_items GROUP BY kind`).map(r => [r.kind, r.n]));
  const shown: Record<string, Record<string, number>> = {};
  for (const r of all(`SELECT lang, source, conf, flags, approved FROM names`)) { const c = (shown[r.lang] ||= {}); const k = shownSource(r); c[k] = (c[k] || 0) + 1; }
  const flagged = Object.fromEntries(all(`SELECT lang, COUNT(*) AS n FROM names WHERE flags IS NOT NULL AND source != 'admin' AND COALESCE(approved, 0) = 0 GROUP BY lang`).map(r => [r.lang, r.n]));
  return { byLang: out, items, shown, flagged };
}
/** an admin's own spelling ('' = remove it: the press / Wikidata / rule name comes back); fix283: it wins forever */
export function setAdminName(sport: string, kind: string, latin: string, lang: string, name: string): { ok: boolean; error?: string } {
  if (!isNameLang(lang)) return { ok: false, error: 'language' };
  if (!NAME_KINDS.includes(kind as NameKind)) return { ok: false, error: 'kind' };
  const it = db.prepare(`SELECT sport, kind, latin, id, qid, country, display FROM name_items WHERE sport = ? AND kind = ? AND latin = ?`).get(sport, kind, latin) as any;
  if (!it) return { ok: false, error: 'unknown name' };
  const n = String(name || '').trim().slice(0, 80);
  if (n) {
    upsertName().run(sport, kind, latin, lang, n, 'admin', it.id, it.qid, new Date().toISOString(), null, null, basisOf(it));
  } else {
    db.prepare(`DELETE FROM names WHERE sport = ? AND kind = ? AND latin = ? AND lang = ? AND source = 'admin'`).run(sport, kind, latin, lang);
    const f = fallbackName(basisOf(it), lang, kind, it.country);
    if (f) writeName(upsertName(), it, lang, f.name, f.source);
  }
  void buildMaps();
  return { ok: true };
}
/** fix283: "approve" — the spelling as it is is right: shown even when a check flagged it, never overwritten by the job */
export function approveName(sport: string, kind: string, latin: string, lang: string, on = true): { ok: boolean; error?: string } {
  if (!isNameLang(lang)) return { ok: false, error: 'language' };
  const r = db.prepare(`UPDATE names SET approved = ? WHERE sport = ? AND kind = ? AND latin = ? AND lang = ?`).run(on ? 1 : 0, sport, kind, latin, lang);
  if (!Number(r.changes)) return { ok: false, error: 'no spelling to approve' };
  void buildMaps();
  return { ok: true };
}
/** Copy for Claude: the card's text (the top names, their sources and the checks' flags) */
export function namesForClaude(): string {
  const a = namesAdmin({ limit: 80 });
  const lines = [`Names in Hebrew / Arabic (fix261, fix283). Last run: ${a.lastRun.at || 'not yet'}; items ${JSON.stringify(a.counts.items)}; Wikidata tried ${a.lastRun.wdTried}, found ${a.lastRun.wdFound}${a.lastRun.error ? `; error: ${a.lastRun.error}` : ''}.`,
    `Shown per source (all names): ${JSON.stringify(a.counts.shown)}; flagged: ${JSON.stringify(a.counts.flagged)}; top ${a.rows.length}: ${JSON.stringify(a.top)}`,
    `AI: ${a.ai.configured ? `on (${a.ai.model}), today $${a.ai.today.usd.toFixed(2)} of $${a.ai.capUsd}, ${a.ai.today.names} names` : 'off (no ANTHROPIC_API_KEY)'}`,
    'Most opened names (latin | he shown/source conf flags | ar shown/source conf flags):'];
  const cell = (x: any) => (x ? `${x.name} (${x.shown}${x.shown !== x.source ? `/${x.source}` : ''}${x.conf != null ? ` ${x.conf}` : ''}${x.flags.length ? ` ⚑${x.flags.join('+')}` : ''})` : '—');
  for (const r of a.rows) lines.push(`${r.sport || '-'} ${r.kind} | ${r.latin}${r.display ? ` (${r.display})` : ''} | ${cell(r.names.he)} | ${cell(r.names.ar)}`);
  return lines.join('\n');
}

/** fix272: data health "Names (he / ar)": entries per language, the map the pages load, the last run */
export function namesHealth(now = Date.now()): import('./dataHealth').Check {
  const c = namesCounts();
  const per = NAME_LANGS.map(lang => {
    const kinds = c.byLang[lang] || {};
    const n = Object.values(kinds).reduce((s, by) => s + Object.values(by).reduce((a, b) => a + b, 0), 0);
    const clubs = Object.values(kinds.team || {}).reduce((a, b) => a + b, 0), leagues = Object.values(kinds.league || {}).reduce((a, b) => a + b, 0);
    return { lang, n, clubs, leagues, map: maps.get(lang)?.map.size ?? 0 };
  });
  const items = Object.values(c.items).reduce((a: number, b: any) => a + Number(b), 0);
  const upMin = process.uptime() / 60;
  // the first run starts ~6 min after the worker (after the first round of stored pages, ≤ 10 min more)
  const empty = per.some(p => !p.map);
  const level: 'ok' | 'warn' = empty && (upMin > 45 || lastRun.at) ? 'warn' : 'ok';
  return {
    id: 'local-names', label: 'Names (he / ar)', level,
    detail: `${per.map(p => `${p.lang}: ${p.n.toLocaleString('en-US')} entries (${p.clubs.toLocaleString('en-US')} teams, ${p.leagues.toLocaleString('en-US')} leagues), ${p.map.toLocaleString('en-US')} in the pages' map`).join(' · ')}`
      + ` · ${items.toLocaleString('en-US')} names collected${lastRun.at ? ` · last run ${new Date(lastRun.at).toISOString().slice(11, 16)} UTC` : running ? ' · first run going' : ' · not run yet'}`
      + `${empty && level === 'warn' ? ' — the pages get no local names' : ''}`,
    items: [
      ...per.map(p => `${p.lang} by kind / source: ${JSON.stringify(c.byLang[p.lang] || {})}`),
      `Last run: ${lastRun.written.toLocaleString('en-US')} written, Wikidata tried ${lastRun.wdTried}, found ${lastRun.wdFound}${lastRun.error ? ` · error: ${lastRun.error}` : ''}`,
      ...per.map(p => `${p.lang} shown to visitors by source: ${JSON.stringify(c.shown[p.lang] || {})} · flagged for review ${c.flagged[p.lang] || 0}`),
      (() => { const ai = namesAiStatus(); return ai.configured ? `AI spelling (${ai.model}): today $${ai.today.usd.toFixed(2)} of $${ai.capUsd}, ${ai.today.names} names` : 'AI spelling off (no ANTHROPIC_API_KEY)'; })(),
      ...(now - mapsAt < 3600 * 1000 ? [] : [`Map built ${mapsAt ? `${Math.round((now - mapsAt) / 60000)} min ago` : 'never'}`])
    ]
  };
}

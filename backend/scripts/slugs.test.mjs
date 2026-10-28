// fix229: clean links. Run: npm run test:fix229 (after tsc)
//  - slug rules (accents, apostrophes, "&", club words, short names) — the app's copy is the same file (npm run parity)
//  - uniqueness (a shared name gets the country / the team / -2, never another item's slug; renames keep an alias)
//  - every old address of every sport answers 301 with its slug address in one hop (200 items per sport and kind,
//    every language), the new address is the item's page (no chain), unknown slugs open the search
//  - the sitemaps list slug addresses only; links in crawler HTML / JSON-LD / emails become slug links
// On a scratch database with 200+ teams / players / matches per sport (dist build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix229-slugs-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.BASKETBALL_PUBLIC = '1';
process.env.NFL_PUBLIC = '1';
process.env.TENNIS_PUBLIC = '1';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
for (const m of ['apiFootball', 'afMatches', 'teamPage', 'playerData', 'playerPage', 'clubElo', 'nationalElo', 'basketball', 'nfl', 'tennis'])
  require(`../dist/services/${m}.js`);
const rules = require('../dist/utils/slugRules.js');
const { assignSlugs, assignMatchSlugs } = require('../dist/utils/slugAssign.js');
const slugs = require('../dist/services/slugs.js');

const DAY = 86400000, now = Date.now();
const iso = t => new Date(t).toISOString();
const AF = 1_000_000_000;
const SPORTS = ['football', 'basketball', 'american-football', 'tennis'];

/* ---------- a scratch database: 200+ items per sport ---------- */
const N = 220;
const CITIES = ['Alder', 'Birch', 'Cedar', 'Dover', 'Elm', 'Fir', 'Grove', 'Holm', 'Ivy', 'Juniper', 'Kew', 'Larch', 'Maple', 'Nor', 'Oak', 'Pine', 'Quay', 'Rowan', 'Spruce', 'Teak', 'Umber', 'Vale', 'Willow', 'Yew'];
const city = i => `${CITIES[i % CITIES.length]}${Math.floor(i / CITIES.length) || ''}`;
const ins = (sql, ...a) => db.prepare(sql).run(...a);
// football: API-Football clubs (af_fixtures), Football-Data.org matches (predictions) with their own team ids
ins(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (1, 140, 2026, 'SP', 'SP1', ?, ?, 529, 541, 'Barcelona', 'Real Madrid', 'FT')`, iso(now - 5 * DAY), iso(now - 5 * DAY).slice(0, 10));
for (let i = 0; i < 4; i++) ins(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (?, 140, 2026, 'SP', 'SP1', ?, ?, 529, 530, 'Barcelona', 'Atlético Madrid', 'FT')`, 10 + i, iso(now - (6 + i) * DAY), iso(now - (6 + i) * DAY).slice(0, 10));
ins(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (20, 242, 2026, 'EC', 'EC1', ?, ?, 1150, 1151, 'Barcelona SC', 'Emelec', 'FT')`, iso(now - 4 * DAY), iso(now - 4 * DAY).slice(0, 10));
ins(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (21, 78, 2026, 'D', 'D1', ?, ?, 192, 186, '1. FC Köln', 'FC St. Pauli', 'NS')`, iso(now + 3 * DAY), iso(now + 3 * DAY).slice(0, 10));
for (let i = 0; i < N; i++) {
  const t = iso(now - (i % 50) * DAY + 3600e3 * (i % 7));
  ins(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (?, 39, 2026, 'E', 'E0', ?, ?, ?, ?, ?, ?, 'FT')`,
    1000 + i, t, t.slice(0, 10), 5000 + i, 5000 + ((i + 1) % N), `${city(i)} United`, `${city((i + 1) % N)} United`);
}
const fbPred = (id, t, hid, home, aid, away, code = 'PD', comp = 'Primera Division') => ins(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
  VALUES (?, 'grid-v3', ?, ?, ?, ?, ?, ?, ?, 0.4, 0.3, 0.3, 0, 0, ?, ?)`, id, code, comp, iso(t), hid, home, aid, away, iso(now), iso(now));
fbPred(560614, now + 2 * DAY, 86, 'Real Madrid CF', 81, 'FC Barcelona');
fbPred(560615, now + 2 * DAY + 3 * 3600e3, 86, 'Real Madrid CF', 81, 'FC Barcelona'); // the same teams twice in one day
fbPred(560616, now - 3 * DAY, 65, 'Manchester City FC', 66, 'Manchester United FC', 'PL', 'Premier League');
ins(`INSERT INTO team_resolve (fd_id, af_id, via, at) VALUES (86, 541, 'test', ?), (81, 529, 'test', ?)`, iso(now), iso(now));
ins(`INSERT INTO fd_af_links (fd_id, af_id, swapped, at) VALUES (560616, 1, 0, ?)`, iso(now));
// football players (two of them share a name)
for (let i = 0; i < N; i++) ins(`INSERT INTO af_player_season (player_id, season, team_id, league_id, name, age, position, apps, minutes) VALUES (?, 2026, ?, 39, ?, 25, 'Midfielder', ?, 900)`, 70000 + i, 5000 + i, i === 1 ? 'J. Silva' : `${city(i)} Player`, 10 + (i % 5));
ins(`INSERT INTO af_player_season (player_id, season, team_id, league_id, name, age, position, apps, minutes) VALUES (69999, 2026, 5005, 39, 'J. Silva', 30, 'Defender', 5, 300)`);
// basketball
for (let i = 0; i < N; i++) {
  const t = iso(now - (i % 40) * DAY);
  ins(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (?, 'NBA', 12, '2026-2027', ?, 'FT', ?, ?, ?, ?, ?)`, 400000 + i, t, 800 + i, `${city(i)} Hawks`, 800 + ((i + 1) % N), `${city((i + 1) % N)} Hawks`, iso(now));
  ins(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, minutes, pts) VALUES (?, ?, ?, ?, 30, 20)`, 400000 + i, 800 + i, 90000 + i, `${city(i)} Guard`);
}
ins(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (519565, 'EL', 120, '2026-2027', ?, 'NS', 1, 'Real Madrid', 2, 'FC Barcelona', ?)`, iso(now + DAY), iso(now));
// American football
for (let i = 0; i < N; i++) {
  ins(`INSERT INTO nfl_teams (team_id, name, league, level, updated_at) VALUES (?, ?, ?, ?, ?)`, 3000 + i, `${city(i)} Rams`, i < 32 ? 1 : 2, i < 32 ? null : 'FBS', iso(now));
  ins(`INSERT INTO nfl_players (player_id, team_id, name, position, season, age, updated_at) VALUES (?, ?, ?, 'QB', 2026, 27, ?)`, 60000 + i, 3000 + i, `${city(i)} Passer`, iso(now));
  ins(`INSERT INTO nfl_games (game_id, season, week, kickoff, home_id, home_name, away_id, away_name, status, league, updated_at) VALUES (?, 2026, '7', ?, ?, ?, ?, ?, 'NS', ?, ?)`, 20000 + i, iso(now + (i % 20) * DAY), 3000 + i, `${city(i)} Rams`, 3000 + ((i + 1) % N), `${city((i + 1) % N)} Rams`, i < 32 ? 1 : 2, iso(now));
}
// tennis
for (let i = 0; i < N; i++) {
  ins(`INSERT INTO tennis_players (id, name, country, dob, ranking, seen_at) VALUES (?, ?, 'ESP', '2000-01-01', ?, ?)`, 50000 + i, `${city(i)} Server`, i + 1, iso(now));
  ins(`INSERT INTO tennis_matches (id, tournament, tour, tier, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (?, 'Paris Masters', 'atp', 'masters', ?, 'finished', ?, ?, ?, ?, 'live', ?)`,
    700000 + i, iso(now - (i % 30) * DAY), 50000 + i, `${city(i)} Server`, 50000 + ((i + 1) % N), `${city((i + 1) % N)} Server`, iso(now));
}

await slugs.buildSlugs({ full: true });

/* ---------- 1. rules ---------- */
test('slug rules: accents, apostrophes, "&", club words, short names', () => {
  const T = rules.teamSlug;
  assert.equal(T('1. FC Köln'), 'koln');
  assert.equal(T('FC St. Pauli'), 'st-pauli');
  assert.equal(T('Paris Saint-Germain'), 'paris-saint-germain');
  assert.equal(T('Atlético Madrid'), 'atletico-madrid');
  assert.equal(T('Borussia Mönchengladbach'), 'monchengladbach');
  assert.equal(T('Man City'), 'manchester-city');
  assert.equal(T('Real Madrid CF'), 'real-madrid');
  assert.equal(T('FC Barcelona'), 'barcelona');
  assert.equal(T("Nott'm Forest"), 'nottingham-forest');
  assert.equal(T('Brighton & Hove Albion'), 'brighton');
  assert.equal(rules.slugify('Tom & Jerry'), 'tom-and-jerry');
  assert.equal(rules.slugify("D'Angelo Russell"), 'dangelo-russell');
  assert.equal(rules.slugify('Łukasz Fabiański'), 'lukasz-fabianski');
  assert.equal(rules.slugify('Søren Kragh'), 'soren-kragh');
  assert.equal(rules.slugify('Großkreutz'), 'grosskreutz');
  assert.equal(rules.slugify('1860'), 'n-1860', 'a slug always has a letter (never read as an old id)');
  assert.equal(rules.matchSlug('real-madrid', 'barcelona', '2026-10-26T19:00:00Z'), 'real-madrid-vs-barcelona-2026-10-26');
  assert.deepEqual(rules.parseMatchSlug('real-madrid-vs-barcelona-2026-10-26-2'), { home: 'real-madrid', away: 'barcelona', day: '2026-10-26', n: 2 });
  // the app's copy is the same file
  assert.equal(fs.readFileSync(new URL('../src/utils/slugRules.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../../frontend/src/lib/slugRules.ts', import.meta.url), 'utf8'));
});

/* ---------- 2. uniqueness ---------- */
test('a shared name: the bigger item keeps the plain slug, the next gets its full name + country', () => {
  const r = assignSlugs('team', [], [
    { id: 'a', name: 'FC Barcelona', weight: 50, country: 'Spain' },
    { id: 'b', name: 'Barcelona SC', weight: 30, country: 'Ecuador' },
    { id: 'c', name: 'Barcelona', weight: 1, country: null }
  ]);
  const by = Object.fromEntries(r.add.filter(x => x.primary).map(x => [x.id, x.slug]));
  assert.equal(by.a, 'barcelona');
  assert.equal(by.b, 'barcelona-sc');
  assert.equal(by.c, 'barcelona-2');
  const lg = assignSlugs('league', [], [{ id: 'PL', name: 'Premier League', weight: 9, country: 'England' }, { id: 'AF235', name: 'Premier League', weight: 3, country: 'Russia' }]);
  assert.deepEqual(lg.add.map(x => x.slug).sort(), ['premier-league', 'premier-league-russia']);
  const pl = assignSlugs('player', [], [{ id: '1', name: 'J. Silva', weight: 9, team: 'porto' }, { id: '2', name: 'J. Silva', weight: 3, team: 'benfica' }, { id: '3', name: 'J. Silva', weight: 1, team: 'benfica', year: 1999 }]);
  assert.deepEqual(pl.add.map(x => x.slug).sort(), ['j-silva', 'j-silva-benfica', 'j-silva-1999'].sort());
  // two games of the same teams on one day
  const m = assignMatchSlugs(new Set(), [{ id: '1', home: 'a', away: 'b', date: '2026-10-26T12:00:00Z' }, { id: '2', home: 'a', away: 'b', date: '2026-10-26T18:00:00Z' }]);
  assert.deepEqual(m.map(x => x.slug), ['a-vs-b-2026-10-26', 'a-vs-b-2026-10-26-2']);
});

test('the table: one primary per item, a slug never shared inside a sport and kind; football and basketball Real Madrid do not clash', () => {
  for (const r of db.prepare(`SELECT sport, kind, id, SUM(is_primary) AS n FROM slugs GROUP BY sport, kind, id`).all()) assert.equal(r.n, 1, `${r.sport} ${r.kind} ${r.id}: ${r.n} primaries`);
  assert.equal(slugs.slugOf('football', 'team', AF + 541), 'real-madrid');
  assert.equal(slugs.slugOf('basketball', 'team', 1), 'real-madrid');
  assert.equal(slugs.slugOf('football', 'team', AF + 529), 'barcelona');
  assert.equal(slugs.slugOf('football', 'team', AF + 1150), 'barcelona-sc');
  assert.equal(slugs.slugOf('football', 'team', 86), 'real-madrid', 'a Football-Data.org id is its club');
  assert.equal(slugs.slugOf('football', 'team', AF + 192), 'koln');
  assert.equal(slugs.slugOf('football', 'league', 'PD'), 'la-liga');
  assert.equal(slugs.slugOf('football', 'league', 'AF140'), 'la-liga', 'the API-Football twin of a Football-Data.org league');
  assert.equal(slugs.slugOf('american-football', 'league', '2'), 'college-football');
  const two = [slugs.slugOf('football', 'match', 560614), slugs.slugOf('football', 'match', 560615)];
  assert.equal(two[0], `real-madrid-vs-barcelona-${iso(now + 2 * DAY).slice(0, 10)}`);
  assert.equal(two[1], `${two[0]}-2`);
  assert.equal(slugs.slugOf('football', 'match', AF + 1), slugs.slugOf('football', 'match', 560616), 'an API-Football twin is its Football-Data.org match');
  const silva = [slugs.slugOf('football', 'player', 70001), slugs.slugOf('football', 'player', 69999)].sort();
  assert.equal(new Set(silva).size, 2);
  assert.ok(silva.includes('j-silva'));
});

/* ---------- 3. old addresses: 301 in one hop, every sport, every language ---------- */
const OLD = {
  football: {
    team: db.prepare(`SELECT DISTINCT ${AF} + home_id AS id FROM af_fixtures LIMIT 200`).all().map(r => `/team/${r.id}`),
    match: db.prepare(`SELECT DISTINCT match_id AS id FROM predictions UNION SELECT ${AF} + fixture_id FROM af_fixtures LIMIT 200`).all().map(r => `/match/${r.id}`),
    player: db.prepare(`SELECT DISTINCT player_id AS id FROM af_player_season LIMIT 200`).all().map(r => `/player/${r.id}`),
    league: ['/league/PL', '/league/PD', '/league/AF140']
  },
  basketball: {
    team: db.prepare(`SELECT DISTINCT home_id AS id FROM bb_games LIMIT 200`).all().map(r => `/basketball/team/${r.id}`),
    match: db.prepare(`SELECT game_id AS id FROM bb_games LIMIT 200`).all().map(r => `/basketball/game/${r.id}`),
    player: db.prepare(`SELECT DISTINCT player_id AS id FROM bb_player_stats LIMIT 200`).all().map(r => `/basketball/player/${r.id}`),
    league: ['/basketball/league/NBA', '/basketball/league/EL']
  },
  'american-football': {
    team: db.prepare(`SELECT team_id AS id FROM nfl_teams LIMIT 200`).all().map(r => `/american-football/team/${r.id}`),
    match: db.prepare(`SELECT game_id AS id FROM nfl_games LIMIT 200`).all().map(r => `/american-football/game/${r.id}`),
    player: db.prepare(`SELECT player_id AS id FROM nfl_players LIMIT 200`).all().map(r => `/american-football/player/${r.id}`),
    league: ['/american-football/league', '/american-football/college/league']
  },
  tennis: {
    match: db.prepare(`SELECT id FROM tennis_matches LIMIT 200`).all().map(r => `/tennis/match/${r.id}`),
    player: db.prepare(`SELECT id FROM tennis_players LIMIT 200`).all().map(r => `/tennis/player/${r.id}`),
    league: ['/tennis/tournament/atp-paris-masters', '/tennis/predictions/atp-paris-masters']
  }
};

for (const sport of SPORTS) test(`${sport}: every old address answers 301 with its slug address, in one hop, every language`, () => {
  let n = 0;
  for (const [kind, list] of Object.entries(OLD[sport])) {
    if (kind !== 'league') assert.ok(list.length >= 200, `${sport} ${kind}: ${list.length} samples`);
    for (const old of list) for (const lang of ['', '/es', '/de']) {
      const a = slugs.linkAnswer(`${lang}${old}`, '?c=PD&n=Something');
      assert.ok(a && 'to' in a, `${lang}${old} → ${JSON.stringify(a)}`);
      assert.match(a.to, new RegExp(`^${lang}/${sport}/${kind}/[a-z0-9-]+$`), `${lang}${old} → ${a.to} (the old query is dropped)`);
      const b = slugs.linkAnswer(a.to);
      assert.ok(b && 'page' in b, `${a.to} is a page, not another redirect: ${JSON.stringify(b)}`);
      n++;
    }
  }
  assert.ok(n > 0);
});

test('football extras: an old team link with a Football-Data.org id, a merged league, an old match', () => {
  assert.deepEqual(slugs.linkAnswer('/team/86', '?c=PD&n=Real+Madrid+CF'), { to: '/football/team/real-madrid' });
  assert.deepEqual(slugs.linkAnswer('/es/match/560614'), { to: `/es/football/match/real-madrid-vs-barcelona-${iso(now + 2 * DAY).slice(0, 10)}` });
  assert.deepEqual(slugs.linkAnswer('/basketball/game/519565'), { to: `/basketball/match/real-madrid-vs-barcelona-${iso(now + DAY).slice(0, 10)}` });
  assert.deepEqual(slugs.linkAnswer('/american-football/league'), { to: '/american-football/league/nfl' });
  // an allowed query parameter stays, the rest goes
  assert.deepEqual(slugs.linkAnswer('/team/86', '?n=x&utm_source=email'), { to: '/football/team/real-madrid?utm_source=email' });
});

test('unknown slug → the search with its words; a match slug drawn from short names / swapped sides finds its match', () => {
  assert.deepEqual(slugs.linkAnswer('/football/team/nobody-fc-xyz'), { search: '/search?q=nobody%20fc%20xyz' });
  const day = iso(now + 2 * DAY).slice(0, 10);
  assert.deepEqual(slugs.linkAnswer(`/football/match/barcelona-vs-real-madrid-${day}`), { to: `/football/match/real-madrid-vs-barcelona-${day}` }, 'sides swapped: the first game of the day');
  assert.deepEqual(slugs.linkAnswer(`/football/match/madrid-vs-barcelona-${day}-2`), { to: `/football/match/real-madrid-vs-barcelona-${day}-2` }, 'a short name: the second game of the day');
  const g = db.prepare(`SELECT kickoff FROM nfl_games WHERE game_id = 20005`).get();
  const full = slugs.slugOf('american-football', 'match', 20005);
  const [h, a] = full.split('-vs-');
  const short = `${a.replace(/-\d{4}-\d{2}-\d{2}$/, '').split('-').pop()}-vs-${h.split('-').pop()}-${g.kickoff.slice(0, 10)}`; // "rams-vs-rams"-style, swapped
  const r = slugs.linkAnswer(`/american-football/match/${short}`);
  assert.ok(r && ('to' in r || 'search' in r));
});

test('a renamed team gets a new slug; the old one stays as an alias (301 to the new)', async () => {
  db.prepare(`UPDATE af_fixtures SET home_name = 'Alder Rovers' WHERE home_id = 5000`).run();
  db.prepare(`UPDATE af_fixtures SET away_name = 'Alder Rovers' WHERE away_id = 5000`).run();
  const before = slugs.slugOf('football', 'team', AF + 5000);
  assert.equal(before, 'alder-united');
  await slugs.buildSlugs({ full: true, sports: ['football'] });
  assert.equal(slugs.slugOf('football', 'team', AF + 5000), 'alder-rovers');
  assert.deepEqual(slugs.linkAnswer('/football/team/alder-united'), { to: '/football/team/alder-rovers' });
  assert.deepEqual(slugs.linkAnswer('/team/1000005000'), { to: '/football/team/alder-rovers' });
});

/* ---------- 4. sitemaps and links in pages / emails ---------- */
test('the sitemaps list slug addresses only (never an id address)', () => {
  const { SITEMAPS } = require('../dist/services/seo.js');
  let locs = 0;
  for (const [file, build] of Object.entries(SITEMAPS)) {
    const xml = build();
    for (const m of xml.matchAll(/<loc>https:\/\/sportlikely\.com([^<]*)<\/loc>|href="https:\/\/sportlikely\.com([^"]*)"/g)) {
      const p = (m[1] ?? m[2]).replace(/^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru)(?=\/|$)/, '') || '/';
      assert.equal(slugs.parseOld(p), null, `${file}: old address ${p}`);
      assert.ok(!/[?&]/.test(p), `${file}: query string in ${p}`);
      locs++;
    }
  }
  assert.ok(locs > 0);
});

test('links inside crawler HTML, JSON-LD and emails become slug links', () => {
  const html = slugs.pubLinks(`<a href="/team/86?c=PD&amp;n=Real+Madrid+CF">x</a><a href="/es/basketball/game/519565">y</a><a href="/matches">z</a>`);
  assert.equal(html, `<a href="/football/team/real-madrid">x</a><a href="/es/basketball/match/real-madrid-vs-barcelona-${iso(now + DAY).slice(0, 10)}">y</a><a href="/football/matches">z</a>`); // fix235: list pages under their sport
  assert.equal(slugs.pubPath('https://sportlikely.com/tennis/player/50000'), 'https://sportlikely.com/tennis/player/alder-server');
  const ld = JSON.parse(slugs.pubLinks(JSON.stringify({ url: 'https://sportlikely.com/match/560616' })));
  assert.match(ld.url, /^https:\/\/sportlikely\.com\/football\/match\/manchester-city-vs-manchester-united-\d{4}-\d{2}-\d{2}$/);
});

test('the crawler page of a slug address is the item page; its canonical is the slug address', () => {
  const { seoPage, renderIndex } = require('../dist/services/seo.js');
  const s = seoPage('/de/football/team/real-madrid');
  assert.equal(s.path, '/football/team/real-madrid');
  assert.deepEqual(s.ent, { sport: 'football', kind: 'team', slug: 'real-madrid', id: String(AF + 541) });
  const html = renderIndex('<html lang="en"><head><title>x</title><link rel="canonical" href="https://sportlikely.com/" /></head><body><div id="root"></div></body></html>', s);
  assert.match(html, /<link rel="canonical" href="https:\/\/sportlikely\.com\/de\/football\/team\/real-madrid" \/>/);
  assert.match(html, /hreflang="es" href="https:\/\/sportlikely\.com\/es\/football\/team\/real-madrid"/);
  assert.match(html, /id="sl-ent"/);
  assert.ok(seoPage('/football/team/no-such-team-xyz').noindex);
});

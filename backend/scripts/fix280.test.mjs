// fix280: a list link that opened "Nothing found" (29 Oct 21:30): /football/matches linked Barça – Alavés to
// /football/match/barcelona-vs-deportivo-alaves-2026-10-31, the slugs table had barcelona-vs-alaves-… —
// `predictions` keeps a team's short name ("Alavés"), the list prints its full name ("Deportivo Alavés").
//  (1) the slugs job registers every Football-Data.org window game (with or without a saved prediction) and both names of
//      each side count for the app's exception list: the slug the app draws (lib/links.ts matchHref, here re-done the
//      same way) from any name the lists print — with the side ids or without — is the table's slug
//  (2) one primary slug per match (a predicted API-Football game came twice in one batch: a second "-2" primary); old
//      duplicates become aliases once (their links still answer, moved to the first)
//  (3) the worker starts from the last window it published (a restart while Football-Data.org is down)
//  (4) the lists' links are drawn again when the slug exceptions arrive; test:site and test:links open every sport's matches list and check every match link of the next 7 days
// Run: npm run test:fix280 (dist build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seedSite, FD_WINDOW_GAMES } from './site-seed.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix280-'));
process.env.LOG_LEVEL = 'error';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
await seedSite(DIR);
const { db } = require('../dist/db/index.js');
const slugs = require('../dist/services/slugs.js');
const rules = require('../dist/utils/slugRules.js');
const fd = require('../dist/services/footballDataAPI.js').default;

const prim = id => db.prepare(`SELECT slug FROM slugs WHERE sport = 'football' AND kind = 'match' AND id = ? AND is_primary = 1`).all(String(id)).map(r => r.slug);
const client = () => JSON.parse(slugs.clientSlugs('football'));
/** lib/links.ts matchHref's slug: the exception, else the rules on the sides (each side's exception by id, else its name) */
const appSlug = (ex, id, m) => ex.m[String(id)] || rules.matchSlug((m.homeId != null && ex.t[String(m.homeId)]) || rules.teamSlug(m.home), (m.awayId != null && ex.t[String(m.awayId)]) || rules.teamSlug(m.away), m.date);

test('fix280 (1): Barça – Deportivo Alavés: the slug the list draws from its full names is the table\'s', () => {
  const [g] = fd.windowMatches().filter(m => m.id === FD_WINDOW_GAMES[0]);
  assert.ok(g, 'the seeded window game');
  const s = prim(g.id);
  assert.equal(s.length, 1);
  assert.match(s[0], /^barcelona-vs-alaves-\d{4}-\d{2}-\d{2}$/);
  const ex = client();
  // the list (SportHome/football.ts toGame): full name, with the ids
  assert.equal(appSlug(ex, g.id, { home: g.homeTeam.name, away: g.awayTeam.name, homeId: g.homeTeam.id, awayId: g.awayTeam.id, date: g.utcDate }), s[0]);
  // before the fix: the rules on "Deportivo Alavés" made another slug, and nothing told the app
  assert.notEqual(rules.matchSlug(rules.teamSlug('FC Barcelona'), rules.teamSlug('Deportivo Alavés'), g.utcDate), s[0]);
  assert.equal(slugs.idOfSlug('football', 'match', s[0])?.id, String(g.id));
});

test('fix280 (1): every window game and every API-Football game: any printed name, with or without ids, is the table\'s slug', () => {
  const ex = client();
  let n = 0;
  for (const g of fd.windowMatches()) {
    const [s] = prim(g.id);
    assert.ok(s, `window game ${g.id} (${g.homeTeam.name} – ${g.awayTeam.name}) has a slug`);
    for (const k of ['name', 'shortName']) for (const ids of [true, false]) {
      const m = { home: g.homeTeam[k], away: g.awayTeam[k], date: g.utcDate, ...(ids ? { homeId: g.homeTeam.id, awayId: g.awayTeam.id } : {}) };
      assert.equal(appSlug(ex, g.id, m), s, `${g.id} ${k} ${ids ? 'with' : 'without'} ids`);
      n++;
    }
  }
  const AF = 1_000_000_000;
  for (const r of db.prepare(`SELECT fixture_id, kickoff, home_id, home_name, away_id, away_name FROM af_fixtures WHERE kickoff >= ?`).all(new Date(Date.now() - 50 * 86400000).toISOString())) {
    const [s] = prim(AF + r.fixture_id);
    if (!s) continue;
    for (const ids of [true, false]) { assert.equal(appSlug(ex, AF + r.fixture_id, { home: r.home_name, away: r.away_name, date: r.kickoff, ...(ids ? { homeId: AF + r.home_id, awayId: AF + r.away_id } : {}) }), s); n++; }
  }
  assert.ok(n >= 8, `${n} links checked`);
  // the window game with no saved prediction got its slug too
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM predictions WHERE match_id = ?`).get(FD_WINDOW_GAMES[1]).n, 0);
  assert.match(prim(FD_WINDOW_GAMES[1])[0] || '', /^espanyol-vs-alaves-/);
});

test('fix280 (1): the full Football-Data.org name is an alias of the team, and the app gets the team exception', () => {
  const ex = client();
  assert.equal(ex.t['263'], 'alaves');
  assert.equal(slugs.idOfSlug('football', 'team', 'deportivo-alaves')?.canonical, 'alaves');
});

test('fix280 (2): one primary slug per match; an old second primary becomes an alias of the first', async () => {
  const dupes = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT id FROM slugs WHERE kind = 'match' AND is_primary = 1 GROUP BY sport, id HAVING COUNT(*) > 1)`).get().n;
  assert.equal(dupes, 0, 'a predicted API-Football game has one primary slug');
  const AF = 1_000_000_000;
  const id = String(AF + 990301), [s] = prim(id);
  db.prepare(`INSERT INTO slugs (sport, kind, slug, id, is_primary, base, at) VALUES ('football', 'match', ?, ?, 1, ?, ?)`).run(`${s}-2`, id, s, new Date().toISOString());
  assert.equal(slugs.onePrimaryPerMatch(), 1);
  assert.deepEqual(prim(id), [s]);
  assert.equal(slugs.onePrimaryPerMatch(), 0);
  await slugs.buildSlugs({ sports: ['football'] });
  const hit = slugs.idOfSlug('football', 'match', `${s}-2`);
  assert.equal(hit?.id, id);
  assert.equal(hit?.canonical, s, 'the -2 link moves to the first slug');
});

test('fix280 (3): a new worker process starts from the window it published', () => {
  const js = `process.env.SL_ROLE = 'worker'; process.env.LOG_LEVEL = 'error';
    const fd = require(${JSON.stringify(path.join(here, '../dist/services/footballDataAPI.js'))}).default;
    process.stdout.write(JSON.stringify(fd.windowMatches().map(m => m.id))); process.exit(0);`;
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', js], { env: { ...process.env, DATA_DIR: DIR }, encoding: 'utf8', timeout: 120_000 });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), FD_WINDOW_GAMES);
});

test('fix280 (4): test:site and test:links check every match link of the matches lists; the seed has the game\'s shape', () => {
  const server = read('scripts/site-server.mjs');
  assert.match(server, /export async function listMatchLinks/);
  assert.match(server, /\/api\/slug\/\$\{sport\}\/match\//);
  for (const sp of ['football', 'basketball', 'american-football', 'tennis']) assert.ok(server.includes(`'${sp}'`), sp);
  assert.match(read('scripts/site-test.mjs'), /listLinkFailures\(browser, site/);
  assert.match(read('scripts/links-test.mjs'), /listLinkFailures\(browser, site/);
  // the lists' rows are drawn again when the slug exceptions / seasons arrive (a memo drawn before kept a dead link)
  for (const f of ['basketball.ts', 'football.tsx', 'nfl.tsx', 'tennis.tsx']) assert.match(read(`../frontend/src/components/sport/games/${f}`), /const slugV = useSlugVersion\(\)[\s\S]*, slugV\]\)/, f);
  const seed = read('scripts/site-seed.mjs');
  assert.match(seed, /'FC Barcelona', 'Barça'/);
  assert.match(seed, /'Deportivo Alavés', 'Alavés'/);
});

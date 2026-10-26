// fix240: two football games unsettled 48 h (Slovan Liberec – Baník Ostrava, Morton – Ayr, 24 Oct) → the check is only red
// when a game is in nobody's hands (no final at 48 h = Needs you); top scorers: the reasons behind the 78 notes (a twin
// record or a copied row added up twice, the list's own season, two clubs in the league) and the per-league 95 % target;
// pre-season basketball games are never in "Results to check"; the slug job republishes a state only when it changed.
// (dist build) Run: npm run test:fix240
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix240-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; // email off: nothing leaves the test
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');

const H = 3600000, AF = 1_000_000_000;
const iso = t => new Date(t).toISOString();

/* ---------- 1. settling: the data-health check ---------- */

test('fix240: a game past 48 h in Needs you is waiting for a person (warn), one in nobody\'s hands fails', async () => {
  const u = require('../dist/services/unsettled.js');
  const { dataHealth } = require('../dist/services/dataHealth.js');
  const add = (id, ko, home, away) => db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team,
    p_home, p_draw, p_away, locked, settled, created_at, updated_at) VALUES (?, 'grid-v3', 'AF345', 'Czech Liga', ?, 1, ?, 2, ?, 0.4, 0.3, 0.3, 1, 0, ?, ?)`).run(id, ko, home, away, iso(Date.now()), iso(Date.now()));
  add(AF + 1, iso(Date.now() - 50 * H), 'Slovan Liberec', 'Baník Ostrava');
  const none = { afByIds: async () => [], afByTeams: async () => [], fdRange: async () => [] };
  const check = async () => (await dataHealth()).checks.find(c => c.id === 'unsettled');
  let c = await check();
  assert.equal(c.level, 'fail', 'not looked at yet');
  const r = await u.resolveUnsettled(none, { now: Date.now() });
  assert.equal(r.review, 1);
  c = await check();
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /1 in Needs you/);
  assert.ok(c.items.some(i => /Slovan Liberec.*Needs you/.test(i)));
  const { adminSummary } = require('../dist/services/adminSummary.js');
  assert.equal(adminSummary().bbResultsToCheck, 1);
  u.decideSettle(AF + 1, 'result', { home: 2, away: 0 }, 'admin@test');
  c = await check();
  assert.equal(c.level, 'ok');
  assert.equal(adminSummary().bbResultsToCheck, 0);
});

/* ---------- 2. player pages: the causes ---------- */

test('fix240: a twin record carrying the same games is kept once; a real split is added; an exact copy within one id is kept once', () => {
  const { mergeRows } = require('../dist/services/playerPage.js');
  const row = (g, apps, minutes, extra = {}) => ({ league: { id: 39 }, team: { id: AF + 50 }, afSeason: 2026, apps, minutes, goals: g, assists: 0, rating: 7, ...extra });
  // the same 9 games under a second id: was 18 goals
  const same = mergeRows([row(9, 9, 790), row(9, 9, 790, { _pid: 77 })]);
  assert.equal(same.length, 1);
  assert.equal(same[0].goals, 9);
  // a real split: 6 games on one id, 3 on the other
  const split = mergeRows([row(6, 6, 520), row(3, 3, 270, { _pid: 77 })]);
  assert.equal(split[0].goals, 9);
  assert.equal(split[0].apps, 9);
  assert.equal(split[0].twinIds, 2);
  // the provider files the league twice for one id
  const copy = mergeRows([row(9, 9, 790), row(9, 9, 790)]);
  assert.equal(copy[0].goals, 9);
  assert.ok(copy.every(r => !('_pid' in r)));
});

test('fix240: every mismatch says why', () => {
  const { mismatchReason, leagueShare, AUDIT_TARGET } = require('../dist/services/dataAudit.js');
  const r = (team, goals, league = 144) => ({ league: { id: league }, team: { id: team }, goals });
  assert.match(mismatchReason({ official: 7, page: 0, rows: [], allRows: [], otherSeasonRows: 1, afList: true }), /another season/);
  assert.match(mismatchReason({ official: 7, page: 0, rows: [], allRows: [], otherSeasonRows: 0, afList: false }), /no league numbers/);
  assert.match(mismatchReason({ official: 3, page: 7, rows: [r(1, 3), r(2, 4)], allRows: [], otherSeasonRows: 0, afList: true, officialClubs: 1 }), /2 clubs/);
  assert.match(mismatchReason({ official: 7, page: 9, rows: [{ ...r(1, 9), twinIds: 2 }], allRows: [], otherSeasonRows: 0, afList: true }), /two provider records/);
  assert.match(mismatchReason({ official: 5, page: 7, rows: [r(1, 7)], allRows: [r(1, 7), r(1, 2, 137)], otherSeasonRows: 0, afList: false }), /another competition/);
  assert.match(mismatchReason({ official: 8, page: 7, rows: [r(1, 7)], allRows: [r(1, 7)], otherSeasonRows: 0, afList: false }), /official list has more/);
  // lag cases are left out of a league's share
  assert.equal(leagueShare({ checked: 20, matched: 19, lag: 0 }), 0.95);
  assert.equal(leagueShare({ checked: 20, matched: 18, lag: 1 }), 18 / 19);
  assert.ok(leagueShare({ checked: 20, matched: 18, lag: 1 }) < AUDIT_TARGET);
});

test('fix240: data health "Player pages" — every league 95 %+, reasons in the items, lag apart', async () => {
  const { dataHealth } = require('../dist/services/dataHealth.js');
  const report = (byLeague, issues) => db.prepare(`INSERT INTO data_audit (at, json) VALUES (?, ?)`).run(iso(Date.now()), JSON.stringify({
    at: iso(Date.now()), leagues: 'PL, AF383', checked: 40, matched: Object.values(byLeague).reduce((t, x) => t + x.matched, 0), lag: Object.values(byLeague).reduce((t, x) => t + x.lag, 0), target: 0.95, byLeague, issues
  }));
  report({ PL: { checked: 20, matched: 19, lag: 1 }, AF383: { checked: 20, matched: 20, lag: 0 } }, [
    { kind: 'lag', league: 'PL', player: 'E. Haaland', detail: 'Goals: official list 12, his page 11', reason: 'his club played on 2026-10-25; …' }
  ]);
  let c = (await dataHealth()).checks.find(x => x.id === 'players');
  assert.equal(c.level, 'ok', c.detail);
  assert.match(c.detail, /every league 95 %\+/);
  assert.match(c.detail, /1 still updating/);
  report({ PL: { checked: 20, matched: 17, lag: 0 }, AF383: { checked: 20, matched: 20, lag: 0 } }, [
    { kind: 'mismatch', league: 'PL', player: 'A', detail: 'Goals: official list 3, his page 7', reason: 'he played for 2 clubs in this league this season' }
  ]);
  c = (await dataHealth()).checks.find(x => x.id === 'players');
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /under 95 %: PL 85 %/);
  assert.match(c.items[0], /— he played for 2 clubs/);
});

/* ---------- 3. results to check: pre-season never listed ---------- */

test('fix240: pre-season games are never in Results to check — swapped silently when the box score is clear, else kept', async () => {
  require('../dist/services/basketball.js');
  const bb = require('../dist/services/bbResults.js');
  const { isPreseason } = require('../dist/services/bbModel.js');
  const info = db.prepare('PRAGMA table_info(bb_games)').all();
  const cols = new Set(info.map(c => c.name));
  const filler = Object.fromEntries(info.filter(c => c.notnull && c.dflt_value == null && !c.pk).map(c => [c.name, /TEXT/i.test(c.type) ? 'x' : 1]));
  const ins = (id, ko, hs, as_, stage = null) => {
    const row = { ...filler, game_id: id, code: 'NBA', kickoff: ko, stage, status: 'FT', home_id: 100 + id, home_name: 'Home ' + id, away_id: 200 + id, away_name: 'Away ' + id, hs, as_, quarters: null };
    const k = Object.keys(row).filter(c => cols.has(c));
    db.prepare(`INSERT INTO bb_games (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(c => row[c]));
  };
  const pinfo = db.prepare('PRAGMA table_info(bb_player_stats)').all();
  const pcols = new Set(pinfo.map(c => c.name));
  const pfill = Object.fromEntries(pinfo.filter(c => c.notnull && c.dflt_value == null).map(c => [c.name, /TEXT/i.test(c.type) ? 'x' : 1]));
  const pl = (game, team, player, pts) => {
    const row = { ...pfill, game_id: game, team_id: team, player_id: player, pts, name: 'P' + player, player_name: 'P' + player, min: 30, minutes: 30 };
    const k = Object.keys(row).filter(c => pcols.has(c));
    db.prepare(`INSERT INTO bb_player_stats (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(c => row[c]));
  };
  const year = new Date().getUTCFullYear();
  const pre = new Date(Date.UTC(year, 9, 16, 23)).toISOString(); // 16 Oct: pre-season by date
  const late = new Date(Date.UTC(year, 9, 19, 3)).toISOString(); // a US late tip-off on the 18th: the 19th in UTC, pre-season by stage
  ins(1, pre, 100, 110); pl(1, 101, 1, 110); pl(1, 201, 2, 100); // box score says swapped → fixed silently
  ins(2, pre, 100, 110); // no box score: kept as is, never listed
  ins(3, late, 90, 99, 'Pre Season'); pl(3, 103, 3, 92); pl(3, 203, 4, 90); // disagrees, pre-season by stage → kept, never listed
  assert.ok(isPreseason({ code: 'NBA', kickoff: late, stage: 'Pre Season' }));
  assert.ok(!isPreseason({ code: 'NBA', kickoff: late }));
  // an open check from before fix240 is closed
  db.prepare(`INSERT INTO bb_result_check (game_id, issue, detail, found_at) VALUES (2, 'swapped?', 'old', ?)`).run(iso(Date.now()));
  await bb.checkResults(30);
  assert.equal(db.prepare('SELECT hs FROM bb_games WHERE game_id = 1').get().hs, 110);
  assert.equal(db.prepare('SELECT hs FROM bb_games WHERE game_id = 2').get().hs, 100);
  assert.equal(db.prepare('SELECT hs FROM bb_games WHERE game_id = 3').get().hs, 90);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bb_result_check WHERE resolved_at IS NULL').get().n, 0);
  assert.equal(bb.resultChecksList().open.length, 0);
  assert.match(db.prepare('SELECT resolution FROM bb_result_check WHERE game_id = 2').get().resolution, /pre-season/);
  const { noteAutoFix } = require('../dist/services/adminMail.js');
  assert.ok(typeof noteAutoFix === 'function'); // silent: nothing in the 07:00 summary for pre-season
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM admin_auto_fixes`).get().n, 0);
});

/* ---------- 4. web stalls: slug states republished only when they changed ---------- */

test('fix240: the slug state hash is the same whatever the order, and changes with one entry', async () => {
  const { contentSig } = require('../dist/services/slugs.js');
  const a = await contentSig(['s:team/real-madrid|86', 'i:team/86|real-madrid', 's:team/arsenal|57']);
  const b = await contentSig(['s:team/arsenal|57', 's:team/real-madrid|86', 'i:team/86|real-madrid']);
  const c = await contentSig(['s:team/arsenal|57', 's:team/real-madrid|86', 'i:team/86|real-madrid-cf']);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

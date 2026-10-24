// fix212: Football-Data.org frozen (answers 200 with stale data) — the site must switch to API-Football by itself.
// Run: npm run test:fix212 (dist build, scratch database, no provider calls)
//  - a match FD still has as TIMED with lastUpdated 6 h old while API-Football has FT 2-1: the window (every list,
//    the calendar, favourites, Draws, SEO pages read it), the match page's reading and the record all show FT 2-1
//  - the freeze detector: newest lastUpdated > 20 min old while a game should be on → frozen, "fixtures" marked failed
//    with "Football-Data frozen since HH:MM (Israel time)"; FD moving again → recovered; a quiet night is not a freeze
//  - needsAf: TIMED past kick-off + 15 min, a stale reading of a game that should be on; not a game that has not started
//  - settling: FD has no final 2 h 20 after kick-off → API-Football's final through the stored link, marked as such;
//    FD's final arriving later is compared (confirmed / mismatch for the data-health card)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'API_BASKETBALL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY'];
const PRELUDE = `const D = ${JSON.stringify(DIST)};
const done = x => { console.log(JSON.stringify(x === undefined ? null : x)); process.exit(0); };
const iso = ms => new Date(ms).toISOString();
const H = 3600 * 1000;
`;
function child(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix212-'));
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env };
  for (const k of KEYS) if (!(k in env)) e[k] = '';
  delete e.SL_ROLE;
  const r = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr || r.stdout}`);
  const lines = r.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}
// a Football-Data.org match as the window holds it
const fdMatch = (id, koMs, status, lastUpdatedMs, extra = {}) => ({
  id, utcDate: iso(koMs), status, lastUpdated: iso(lastUpdatedMs), competition: { code: 'PL', name: 'Premier League' },
  homeTeam: { id: 1, name: 'Home FC' }, awayTeam: { id: 2, name: 'Away FC' }, score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } }, ...extra
});

test('a TIMED match with a 6 h old FD reading shows FT 2-1 from API-Football in the window and on the match page', () => {
  const r = child(`
    const { reportLive, withLiveScore, bestLive } = require(D + '/services/liveScores');
    const now = Date.now();
    const M = (${fdMatch.toString()});
    const fd = M(560001, now - 3 * H, 'TIMED', now - 6 * H);
    // the live book: FD's reading never arrives (TIMED is not live), API-Football says FT 2-1
    reportLive(560001, 'af', { status: 'FINISHED', minute: 90, score: { fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } } }, now - 60 * 1000);
    const list = [fd].map(withLiveScore)[0];
    const page = withLiveScore({ ...fd });
    done({ list: { status: list.status, score: list.score.fullTime, winner: list.score.winner }, page: { status: page.status, score: page.score.fullTime }, source: bestLive(560001).source });
  `);
  assert.equal(r.list.status, 'FINISHED');
  assert.deepEqual(r.list.score, { home: 2, away: 1 });
  assert.equal(r.list.winner, 'HOME_TEAM');
  assert.equal(r.page.status, 'FINISHED');
  assert.deepEqual(r.page.score, { home: 2, away: 1 });
  assert.equal(r.source, 'af');
});

test('needsAf: TIMED past kick-off + 15 min and a stale live reading want API-Football; a game not started yet does not', () => {
  const r = child(`
    const { needsAf, fdMatchesNeedingAf } = require(D + '/services/fdReconcile');
    const M = (${fdMatch.toString()});
    const now = Date.now();
    const timedLate = M(1, now - 20 * 60 * 1000, 'TIMED', now - 6 * H);
    const timedJust = M(2, now - 5 * 60 * 1000, 'TIMED', now - 6 * H);
    const future = M(3, now + 2 * H, 'TIMED', now - 6 * H);
    const liveStale = M(4, now - 60 * 60 * 1000, 'IN_PLAY', now - 20 * 60 * 1000);
    const liveFresh = M(5, now - 60 * 60 * 1000, 'IN_PLAY', now - 30 * 1000);
    const finished = M(6, now - 3 * H, 'FINISHED', now - 6 * H);
    done({ timedLate: needsAf(timedLate, now), timedJust: needsAf(timedJust, now), future: needsAf(future, now), liveStale: needsAf(liveStale, now), liveFresh: needsAf(liveFresh, now), finished: needsAf(finished, now),
      wanted: fdMatchesNeedingAf([timedLate, timedJust, future, liveStale, liveFresh, finished], now).map(m => m.id) });
  `);
  assert.equal(r.timedLate, true);
  assert.equal(r.timedJust, true); // 5 min in and FD has not touched it for 6 h: it should be live, ask API-Football
  assert.equal(r.future, false);
  assert.equal(r.liveStale, true);
  assert.equal(r.liveFresh, false);
  assert.equal(r.finished, false);
  assert.deepEqual(r.wanted, [1, 2, 4]);
});

test('freeze detector: frozen while a game is on and the newest lastUpdated is > 20 min old; recovers; a quiet night is not a freeze', () => {
  const r = child(`
    const { freezeCheck, applyFreezeCheck, fdFreeze, frozenText, fdMatchesNeedingAf } = require(D + '/services/fdReconcile');
    const { feedState, markFresh, markFailed } = require(D + '/services/freshness');
    const M = (${fdMatch.toString()});
    const now = Date.now();
    // 10:20 UTC freeze: every match carries the same lastUpdated, a game kicked off 1 h ago
    const stale = now - 9 * H;
    const win1 = [M(1, now - 1 * H, 'TIMED', stale), M(2, now + 5 * H, 'TIMED', stale), M(3, now + 30 * H, 'TIMED', stale)];
    const c1 = freezeCheck(win1, now, null);
    applyFreezeCheck(c1, now);
    const frozen1 = { ...fdFreeze() };
    const text = frozenText();
    // in frozen mode every match past kick-off is wanted from API-Football (match 1), the others not
    const wanted = fdMatchesNeedingAf(win1, now).map(m => m.id);
    if (fdFreeze().frozen) markFailed('fixtures', frozenText()); else markFresh('fixtures', 'x');
    const feed1 = { ...feedState('fixtures') };
    // the next refresh: same data → still frozen; then FD moves (lastUpdated now) → recovered
    const c2 = freezeCheck(win1, now + 5 * 60 * 1000, { newest: c1.newest, idsKey: c1.idsKey });
    applyFreezeCheck(c2, now + 5 * 60 * 1000);
    const frozen2 = fdFreeze().frozen;
    const win3 = win1.map(m => ({ ...m, lastUpdated: iso(now + 6 * 60 * 1000) }));
    const c3 = freezeCheck(win3, now + 6 * 60 * 1000, { newest: c2.newest, idsKey: c2.idsKey });
    applyFreezeCheck(c3, now + 6 * 60 * 1000);
    const after = { ...fdFreeze() };
    // a quiet night: nothing due, old lastUpdated → not frozen, and "changed" false
    const night = [M(7, now + 12 * H, 'TIMED', now - 10 * H)];
    const cn = freezeCheck(night, now, { newest: now - 10 * H, idsKey: '7' });
    done({ frozen1: frozen1.frozen, since: frozen1.since, newest: c1.newest, text, wanted, feed1: { ok: feed1.ok, err: feed1.lastError }, c2: { changed: c2.changed, frozen: c2.frozen }, frozen2, after: { frozen: after.frozen, recovered: !!after.recoveredAt }, c3changed: c3.changed, night: { frozen: cn.frozen, changed: cn.changed, due: cn.due } });
  `);
  assert.equal(r.frozen1, true);
  assert.equal(r.since, r.newest);
  assert.match(r.text, /^Football-Data frozen since \d\d:\d\d \(Israel time\)$/);
  assert.deepEqual(r.wanted, [1]);
  assert.equal(r.feed1.ok, false);
  assert.match(r.feed1.err, /frozen since/);
  assert.equal(r.c2.changed, false);
  assert.equal(r.c2.frozen, true);
  assert.equal(r.frozen2, true);
  assert.equal(r.c3changed, true);
  assert.equal(r.after.frozen, false);
  assert.equal(r.after.recovered, true);
  assert.deepEqual(r.night, { frozen: false, changed: false, due: false });
});

test('settling: no FD final 2 h 20 after kick-off → API-Football final 2-1 through the stored link; FD final compared later', () => {
  const r = child(`
    (async () => {
    const { db } = require(D + '/db');
    const { settlePending, AF_FALLBACK_MS } = require(D + '/services/tracking');
    const { resultMismatches, afSettledCount } = require(D + '/services/fdReconcile');
    const now = Date.now();
    const ko = iso(now - AF_FALLBACK_MS - 60 * 1000);
    const cols = db.prepare('PRAGMA table_info(predictions)').all().map(c => c.name);
    const row = { match_id: 560002, model: 'grid-v3', competition_code: 'PL', competition_name: 'Premier League', utc_date: ko, home_team: 'Home FC', away_team: 'Away FC', p_home: 0.5, p_draw: 0.25, p_away: 0.25, settled: 0, locked: 1, created_at: ko, updated_at: ko };
    const use = Object.keys(row).filter(k => cols.includes(k));
    db.prepare('INSERT INTO predictions (' + use.join(',') + ') VALUES (' + use.map(() => '?').join(',') + ')').run(...use.map(k => row[k]));
    // FD still says TIMED (frozen, 6 h old); API-Football has FT 2-1 for fixture 90001
    const fdRange = async () => [{ id: 560002, utcDate: ko, status: 'TIMED', lastUpdated: iso(now - 6 * H), score: { fullTime: { home: null, away: null } } }];
    const afFixtures = async ids => ids.includes(90001) ? [{ fixture: { id: 90001, status: { short: 'FT' }, date: ko }, goals: { home: 2, away: 1 }, score: { fulltime: { home: 2, away: 1 }, halftime: { home: 1, away: 0 } } }] : [];
    const r1 = await settlePending(fdRange, afFixtures, id => (id === 560002 ? { fid: 90001, swapped: false } : null));
    const res = db.prepare('SELECT * FROM results WHERE match_id = 560002').get();
    const settledFlag = db.prepare('SELECT settled FROM predictions WHERE match_id = 560002').get().settled;
    // later: FD's own final arrives (2-1 → confirmed), then a disagreeing one for another AF-settled game
    const fdFinal = async () => [{ id: 560002, utcDate: ko, status: 'FINISHED', score: { fullTime: { home: 2, away: 1 }, halfTime: { home: 1, away: 0 } } }];
    await settlePending(fdFinal, async () => [], () => null);
    const check = db.prepare('SELECT status, fd_home, fd_away FROM result_checks WHERE match_id = 560002').get();
    done({ settled: r1.settled, res: res && { status: res.status, h: res.home_goals, a: res.away_goals, outcome: res.outcome, reason: res.reason, ht: [res.ht_home, res.ht_away] }, settledFlag, check, afSettled: afSettledCount(7), mismatches: resultMismatches().length });
    })().catch(e => { console.error(e); process.exit(1); });
  `);
  assert.equal(r.settled, 1);
  assert.equal(r.res.status, 'FINISHED');
  assert.equal(r.res.h, 2); assert.equal(r.res.a, 1);
  assert.equal(r.res.outcome, 'H');
  assert.match(r.res.reason, /settled from API-Football/);
  assert.deepEqual(r.res.ht, [1, 0]);
  assert.equal(r.settledFlag, 1);
  assert.deepEqual(r.check, { status: 'confirmed', fd_home: 2, fd_away: 1 });
  assert.equal(r.afSettled, 1);
  assert.equal(r.mismatches, 0);
});

test('a mismatch between the two finals is listed for the data-health card', () => {
  const r = child(`
    const { noteAfSettled, checkFdFinal, resultMismatches } = require(D + '/services/fdReconcile');
    noteAfSettled(560003, 2, 1);
    const st = checkFdFinal(560003, 2, 2);
    done({ st, mm: resultMismatches() });
  `);
  assert.equal(r.st, 'mismatch');
  assert.equal(r.mm.length, 1);
  assert.equal(r.mm[0].af, '2-1'); assert.equal(r.mm[0].fd, '2-2');
});

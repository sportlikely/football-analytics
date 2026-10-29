// fix279: fewer admin emails (Yarin, 29 Oct: 24 "Site problem" emails in 2 days) and the slow public routes.
//  (1) the email limits are stored: a restart inside 6 h sends no data alert (a real second process on the same database)
//  (2) one email per problem: a check already emailed and still red is not emailed again; 24 h green → a new problem
//  (3) only what a person can act on: a calibration / speed / model check never sends its own email (For Claude + 07:00)
//  (4) /api/public/results, /api/game-bundle, /api/news, /api/slug/…/match/<old slug> answer from stored copies on the
//      web (no build, no worker on the request; a miss = 202 pending)
// Run: npm run test:fix279 (dist build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix279-'));
process.env.DATA_DIR = DIR;
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; // email off: nothing leaves the test
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const rules = require('../dist/utils/alertRules.js');
const mail = require('../dist/services/adminMail.js');
const { db } = require('../dist/db/index.js');

const H = 3600_000, T0 = Date.parse('2026-10-29T10:00:00Z');
const red = (id, label = id, extra = {}) => ({ id, label, level: 'fail', detail: 'red', ...extra });
const green = (id, label = id) => ({ id, label, level: 'ok', detail: 'fine' });

/** one data-health run in a NEW node process (a restart): the ids it would email */
function runInNewProcess(checks, now) {
  const js = `
    process.env.LOG_LEVEL = 'error';
    const { pickDataAlert } = require(${JSON.stringify(path.join(here, '../dist/services/dataHealth.js'))});
    process.stdout.write(JSON.stringify(pickDataAlert(${JSON.stringify(checks)}, ${now}, true).map(c => c.id)));
    process.exit(0);`;
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', js], { env: { ...process.env, DATA_DIR: DIR, WORKER: '0' }, encoding: 'utf8', timeout: 120_000 });
  return JSON.parse(out.trim().split('\n').pop());
}
const reset = () => db.exec(`DELETE FROM admin_alert_state; DELETE FROM admin_mail_limit;`);

/* ---------- (3) what may email ---------- */

test('fix279 (3): calibration, model, speed and the other "nothing to do" checks are quiet — never their own email', () => {
  for (const id of ['calibration-football', 'calibration-tennis', 'bb-vs-backtest', 'bb-grid-rows', 'more-predictions', 'more-predictions-tennis', 'perf:web-stalls',
    'slow-requests', 'slow-reads', 'slow-requests-admin', 'players', 'player-careers', 'game-extras', 'season-forecast-rules', 'market-close-tennis', 'tennis-data', 'upset-text'])
    assert.equal(rules.alertClass(id), 'quiet', id);
  for (const id of ['feed:live', 'feed:fixtures', 'fd-moving']) assert.equal(rules.alertClass(id), 'feed', id);
  for (const id of ['deploy-errors', 'disk']) assert.equal(rules.alertClass(id), 'email', id);
  // red for three days: still no email
  const row = { id: 'calibration-tennis', label: 'Calibration (tennis)', redSince: T0 - 72 * H, emailedAt: null, greenSince: null };
  assert.equal(rules.wantsEmail(row, red('calibration-tennis'), T0), false);
  assert.equal(rules.wantsEmail({ ...row, id: 'slow-requests' }, red('slow-requests'), T0), false);
});

test('fix279 (3): a feed is emailed after 2 h red, a failed deploy after 30 min, the disk only when full within 3 days', () => {
  const row = (id, since) => ({ id, label: id, redSince: since, emailedAt: null, greenSince: null });
  assert.equal(rules.wantsEmail(row('feed:live', T0 - 90 * 60_000), red('feed:live'), T0), false, '1.5 h: not yet');
  assert.equal(rules.wantsEmail(row('feed:live', T0 - 2 * H), red('feed:live'), T0), true);
  assert.equal(rules.wantsEmail(row('deploy-errors', T0 - 20 * 60_000), red('deploy-errors'), T0), false);
  assert.equal(rules.wantsEmail(row('deploy-errors', T0 - 31 * 60_000), red('deploy-errors'), T0), true);
  const disk = d => red('disk', 'Disk', { detail: `5 GB free · full in ${d} at this rate` });
  assert.equal(rules.wantsEmail(row('disk', T0 - H), disk('20 days'), T0), false);
  assert.equal(rules.wantsEmail(row('disk', T0 - H), disk('2 days'), T0), true);
  assert.equal(rules.diskSoon(red('disk', 'Disk', { items: ['Last 6.0 h: +1 GB · volume full in 30 h at that rate'] })), true);
});

test('fix279 (3): a quiet check red for hours is listed for Claude and in the 07:00 summary, not emailed', async () => {
  reset();
  const { pickDataAlert } = require('../dist/services/dataHealth.js');
  for (let t = T0; t <= T0 + 3 * H; t += 30 * 60_000) assert.deepEqual(pickDataAlert([red('calibration-football', 'Calibration (football)'), red('perf:web-stalls', 'Web stalls')], t, true), []);
  const r = mail.redNow(T0 + 3 * H);
  assert.deepEqual(r.forClaude.map(x => x.id).sort(), ['calibration-football', 'perf:web-stalls']);
  assert.ok(r.forClaude.every(x => x.quiet));
  const { adminSummary } = require('../dist/services/adminSummary.js');
  assert.equal(adminSummary(T0 + 3 * H).redChecks.length, 2);
  const s = mail.buildSummary([{ at: new Date(T0).toISOString(), area: 'For Claude', title: 'Calibration (football): red since 29 Oct, 12:00', detail: null, href: null }]);
  assert.match(s.subject, /^Daily summary: 1 check to know about$/);
  assert.equal(s.mail.rows.length, 1);
});

/* ---------- (2) one email per problem ---------- */

test('fix279 (2): a check already emailed and still red is not emailed again; listed "still red since" in the summary', () => {
  reset();
  const { pickDataAlert } = require('../dist/services/dataHealth.js');
  const c = red('feed:fixtures', 'Fixtures and scores (main leagues)');
  assert.deepEqual(pickDataAlert([c], T0, true), [], 'just turned red');
  assert.deepEqual(pickDataAlert([c], T0 + 2 * H, true).map(x => x.id), ['feed:fixtures'], 'red 2 h: emailed');
  for (let t = T0 + 9 * H; t <= T0 + 40 * H; t += 6 * H) assert.deepEqual(pickDataAlert([c], t, true), [], 'still red, past the 6 h gap: no second email');
  const still = mail.redNow(T0 + 40 * H).stillRed;
  assert.equal(still.length, 1);
  assert.equal(still[0].id, 'feed:fixtures');
  // green 2 h then red again: the same problem — no email
  pickDataAlert([green('feed:fixtures')], T0 + 41 * H, true);
  assert.deepEqual(pickDataAlert([c], T0 + 43 * H, true), []);
  assert.deepEqual(pickDataAlert([c], T0 + 46 * H, true), []);
  // green 24 h, then red again for 2 h: a new problem → emailed
  pickDataAlert([green('feed:fixtures')], T0 + 47 * H, true);
  pickDataAlert([green('feed:fixtures')], T0 + 70 * H, true);
  assert.equal(mail.alertRows().length, 1, 'kept while green < 24 h');
  pickDataAlert([green('feed:fixtures')], T0 + 72 * H, true);
  assert.equal(mail.alertRows().length, 0, 'forgotten after 24 h green');
  assert.deepEqual(pickDataAlert([c], T0 + 73 * H, true), []);
  assert.deepEqual(pickDataAlert([c], T0 + 75 * H, true).map(x => x.id), ['feed:fixtures']);
});

/* ---------- (1) the limits survive a restart ---------- */

test('fix279 (1): a restart inside 6 h sends no data alert (the clock and the emailed set are in the database)', () => {
  reset();
  const live = red('feed:live', 'Live scores'), fd = red('fd-moving', 'Football-Data feed moving');
  // process 1: the live feed red since T0, emailed at T0 + 2 h
  assert.deepEqual(runInNewProcess([live], T0), []);
  assert.deepEqual(runInNewProcess([live], T0 + 2 * H), ['feed:live']);
  // a deploy (a new process) 1 h later: the live feed is still red, and another feed has been red 2 h → nothing (6 h gap)
  assert.deepEqual(runInNewProcess([live, fd], T0 + 1 * H), []);
  assert.deepEqual(runInNewProcess([live, fd], T0 + 3 * H + 1), [], 'second feed red 2 h, but inside the 6 h of the last alert');
  // another restart after the 6 h: only the feed not emailed yet
  assert.deepEqual(runInNewProcess([live, fd], T0 + 8 * H + 1), ['fd-moving']);
  assert.ok(mail.limitAt('data-alert') >= T0 + 8 * H);
});

test('fix279 (1): limitOk is stored and atomic (signup surge, data alert)', () => {
  db.exec(`DELETE FROM admin_mail_limit`);
  assert.equal(mail.limitOk('signup-surge', 6 * H, T0), true);
  assert.equal(mail.limitOk('signup-surge', 6 * H, T0 + H), false);
  assert.equal(mail.limitOk('signup-surge', 6 * H, T0 + 6 * H), true);
  assert.match(read('src/services/signupGuard.ts'), /limitOk\('signup-surge'/);
  assert.doesNotMatch(read('src/services/signupGuard.ts'), /let alertedAt/);
  assert.doesNotMatch(read('src/services/dataHealth.ts'), /lastEmailAt|failStreak/);
  // no "a page broke" email, no top-scorer email (For Claude list + 07:00 summary)
  assert.doesNotMatch(read('src/services/clientErrors.ts'), /sendAdminMail|emailsToday/);
  assert.doesNotMatch(read('src/services/dataAudit.ts'), /sendEmail\(/);
});

/* ---------- (4) the slow routes ---------- */

test('fix279 (4): results / record / news answer from stored copies within the fast budget (miss → nearest copy or 202)', () => {
  const app = read('src/app.ts');
  assert.match(app, /const FAST_STORED = new Set\(\['results', 'record', 'news'\]\)/);
  assert.match(app, /withinFast\(fast, getPage\(name, q,/);
  assert.match(app, /waitMs: fast \? 0 :/, 'no wait for a first build');
  assert.match(app, /STORED_OR_WORKER\.has\(name\) && !fast\) return forwardToWorker/, 'news never goes to the worker on the request');
  // news: any length falls back to the warm copy of its sport
  const { fallbackQuery } = require('../dist/services/pageCache.js');
  require('../dist/app.js');
  assert.deepEqual(fallbackQuery('news', { sport: 'football', limit: 7 }), { sport: 'football', limit: 10 });
  assert.equal(fallbackQuery('news', { sport: 'football', limit: 10 }), null);
  assert.deepEqual(fallbackQuery('news', { sport: 'american-football', league: 'NFL', limit: 6 }), { sport: 'american-football', league: 'NFL', limit: 10 });
});

test('fix279 (4): the game bundle and a team\'s news are never a wait on the worker (202 at once on a miss)', () => {
  const { WORKER_ROUTES, workerRouteOf } = require('../dist/services/workerRoutes.js');
  assert.ok(workerRouteOf('/api/game-bundle/basketball/123').instant && workerRouteOf('/api/game-bundle/basketball/123').ownPending);
  assert.ok(!workerRouteOf('/api/news').ownPending, "an admin's team news still comes from the worker");
  assert.ok(workerRouteOf('/api/news').instant && workerRouteOf('/api/news').members);
  assert.ok(!workerRouteOf('/api/search').instant, 'search still waits for its answer');
  assert.ok(WORKER_ROUTES.length > 10);
  const src = read('src/services/workerRoutes.ts');
  assert.match(src, /if \(own && route\.ownPending\) \{ stats\.pending\+\+; return pending\(res\); \}/);
  assert.match(src, /fetchCopy\(k, req, true\)\.catch/);
  // the worker keeps the next 12 hours' games' bundles
  const { upcomingBundles } = require('../dist/services/gameBundle.js');
  assert.ok(Array.isArray(upcomingBundles()));
});

test('fix279 (4): an old match slug is resolved on the web from its id index (no worker round trip)', () => {
  const { idChunks, indexedMatchByParts } = require('../dist/services/slugs.js');
  const ix = { sport: 'basketball', builtAt: 0, entries: 4, chunks: idChunks('match', [
    [101, 'los-angeles-lakers-vs-boston-celtics-2026-10-26'], [102, 'miami-heat-vs-new-york-knicks-2026-10-26'],
    [103, 'los-angeles-lakers-vs-boston-celtics-2026-11-02'], [104, 'denver-nuggets-vs-utah-jazz-2026-10-27']]) };
  assert.equal(indexedMatchByParts(ix, 'lakers-vs-celtics-2026-10-26'), 'los-angeles-lakers-vs-boston-celtics-2026-10-26');
  assert.equal(indexedMatchByParts(ix, 'celtics-vs-lakers-2026-10-26'), 'los-angeles-lakers-vs-boston-celtics-2026-10-26', 'sides swapped');
  assert.equal(indexedMatchByParts(ix, 'knicks-vs-heat-2026-10-26'), 'miami-heat-vs-new-york-knicks-2026-10-26');
  assert.equal(indexedMatchByParts(ix, 'lakers-vs-heat-2026-10-26'), null);
  assert.equal(indexedMatchByParts(ix, 'lakers-vs-celtics'), null, 'no day: no guess');
  // a big index: fast
  const pairs = Array.from({ length: 60_000 }, (_, i) => [i + 1, `team-${i}-vs-club-${i}-2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`]);
  const big = { sport: 'basketball', builtAt: 0, entries: pairs.length, chunks: idChunks('match', pairs) };
  const t = performance.now();
  assert.equal(indexedMatchByParts(big, 'club-77-vs-team-77-2026-06-22'), 'team-77-vs-club-77-2026-06-22');
  assert.ok(performance.now() - t < 100, `${Math.round(performance.now() - t)} ms`);
  const app = read('src/app.ts');
  assert.match(app, /if \(isWeb && webKnowsSlug\(sport, kind\)\) \{/, 'match slugs too (kind !== match removed)');
  assert.match(read('src/services/slugs.ts'), /isWeb \? indexedMatchByParts\(idIndexes\.get\(nw\.sport\), nw\.slug\)/);
});

test('fix279 (4): the four routes are on test:site\'s speed list', () => {
  const s = read('scripts/site-test.mjs');
  for (const r of ['/api/public/results', '/api/news', '/api/game-bundle/basketball/', '/api/slug/basketball/match/']) assert.ok(s.includes(r), r);
  assert.match(s, /speedList\(site\.base, sample\)/);
});

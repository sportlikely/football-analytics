// fix275: a fixed site error stops being red right away (Yarin, 29 Oct: "if it's fixed we show it normal, we can't wait
// 24 h every time") — every report carries its build, a group whose last report came from an older build (or whose
// stack's files are gone from the live build) is "Fixed by a newer build" as soon as that build is live; a new report
// from the live build opens it again. Top-scorer check: a page ahead of the official list by the same gap on 3+ checks
// is "Provider and league disagree (known)", left out of the league's %. Run: npm run test:fix275 (compiles first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix275-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; // email off: nothing leaves the test
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/contact.js'); // its tables, for the summary / Copy for Claude
const ce = require('../dist/services/clientErrors.js');
const H = 3600000;
const iso = ms => new Date(ms).toISOString();

const reset = () => { db.prepare('DELETE FROM client_errors').run(); db.prepare('DELETE FROM client_builds').run(); };
const row = msg => db.prepare('SELECT * FROM client_errors WHERE message = ?').get(msg);
/** a report as the browser sends it, then dated `ago` ms back (its build from the report itself) */
const report = (message, version, ago = 0, stack = `at Ge (https://sportlikely.com/assets/GameExtras-C0ATdfL8.js:1:2)`) => {
  ce.reportClientError({ message, page: '/football/team/ajax', kind: 'page', stack, version });
  if (ago) db.prepare('UPDATE client_errors SET last_at = ?, first_at = ? WHERE message = ?').run(iso(Date.now() - ago), iso(Date.now() - ago - H), message);
};

test('the build id is taken from whatever arrives (full script URL from the loader, file name, id)', () => {
  assert.equal(ce.buildId('https://sportlikely.com/assets/index-B9x_Qr-1.js?sl_v=123'), 'index-B9x_Qr-1');
  assert.equal(ce.buildId('index-AbC123xy.js'), 'index-AbC123xy');
  assert.equal(ce.buildId('index-AbC123xy'), 'index-AbC123xy');
  assert.equal(ce.buildId(''), null);
  assert.equal(ce.buildId('https://sportlikely.com/'), null);
  // the loader's long URL is no longer cut to 40 characters before the id is read
  reset();
  const now = Date.now();
  ce.noteBuild('index-LIVE0001', now - 2 * H);
  report('Loader long URL', 'https://www.sportlikely.com/assets/index-LongHash9.js?sl_v=1761753600000');
  assert.equal(row('Loader long URL').version, 'index-LongHash9');
  assert.deepEqual(JSON.parse(row('Loader long URL').builds), ['index-LongHash9']);
});

test('a report without a version gets the build live at that time', () => {
  reset();
  const now = Date.now();
  ce.noteBuild('index-AAAAAAAA', now - 10 * H);
  ce.noteBuild('index-BBBBBBBB', now - 1 * H);
  report('No version sent', '');
  assert.equal(row('No version sent').version, 'index-BBBBBBBB');
  assert.equal(ce.buildAt(iso(now - 5 * H)), 'index-AAAAAAAA');
  assert.equal(ce.buildAt(iso(now - 20 * H)), null);
  // the list (Admin, Copy for Claude) carries the builds: no more "builds unknown"
  const l = ce.clientErrorList(30).rows.find(r => r.message === 'No version sent');
  assert.deepEqual(l.builds, ['index-BBBBBBBB']);
  assert.equal(l.version, 'index-BBBBBBBB');
  const { siteErrorSection } = require('../dist/utils/forClaude.js');
  assert.match(siteErrorSection([l]).lines.join('\n'), /builds index-BBBBBBBB/);
});

test('reported on build A, then build B live → grey within one run (no 24 h wait); a new report on B → red again', () => {
  reset();
  const now = Date.now();
  ce.noteBuild('index-BuildAAA', now - 30 * H);
  // the 28 Oct case: last report 3 h ago on A (well inside 24 h), fix271 = B live since 1 h
  report("Cannot read properties of null (reading 'length')", 'index-BuildAAA', 3 * H);
  report('Old row from before fix253 (no build stored)', '', 5 * H);
  db.prepare(`UPDATE client_errors SET version = NULL, builds = '[]' WHERE message LIKE 'Old row%'`).run();
  ce.noteBuild('index-BuildBBB', now - H);
  assert.equal(ce.closeStoppedErrors(now), 0, 'the 24 h rule alone would wait');
  const n = ce.closeFixedByBuild(now, 'index-BuildBBB', new Set(['index-BuildBBB.js', 'GameExtras-C0ATdfL8.js']));
  assert.equal(n, 2);
  const r = row("Cannot read properties of null (reading 'length')");
  assert.ok(r.resolved_at); assert.equal(r.fixed_by, 'index-BuildBBB');
  assert.ok(row('Old row from before fix253 (no build stored)').resolved_at, 'no stored build = the build live at its last report (A)');
  // Done for you, in the words asked for
  const done = require('../dist/services/doneForYou.js').doneList(7, now).filter(x => x.kind === 'site-errors' && /reading 'length'/.test(x.title));
  assert.equal(done.length, 1);
  assert.match(done[0].why, /^Fixed by build index-BuildBBB \(live .+\): it last happened on index-BuildAAA, no report on the new one\..*Opens again by itself if it comes back\.$/);
  // an old tab still on A reports it again: counted, stays grey
  report("Cannot read properties of null (reading 'length')", 'index-BuildAAA');
  assert.ok(row("Cannot read properties of null (reading 'length')").resolved_at, 'a report from the older build does not reopen it');
  // a report from the live build B: red again
  report("Cannot read properties of null (reading 'length')", 'https://sportlikely.com/assets/index-BuildBBB.js');
  const again = row("Cannot read properties of null (reading 'length')");
  assert.equal(again.resolved_at, null); assert.equal(again.fixed_by, null);
  // and it is not closed again while its last report is from the live build
  assert.equal(ce.closeFixedByBuild(now, 'index-BuildBBB', new Set()), 0);
  assert.equal(row("Cannot read properties of null (reading 'length')").resolved_at, null);
});

test('a report whose stack file is missing from the live assets → grey; still present (no build known) → stays red', () => {
  reset();
  const now = Date.now();
  // reports before any build was noted: no build can be told, only the files
  report('Stack file gone', '', 2 * H, 'at Ge (https://sportlikely.com/assets/GameExtras-C0ATdfL8.js:1:2)\nat Xe (https://sportlikely.com/assets/react-D3fGh1jK.js:9:9)');
  report('Stack file still there', '', 2 * H, 'at Ge (https://sportlikely.com/assets/NflTeam-Zz11Yy22.js:1:2)');
  report('No stack', '', 2 * H, '');
  assert.equal(row('Stack file gone').version, null);
  ce.noteBuild('index-NewBuild1', now - H);
  assert.deepEqual(ce.stackFiles(row('Stack file gone').where_), ['GameExtras-C0ATdfL8.js', 'react-D3fGh1jK.js']);
  const assets = new Set(['index-NewBuild1.js', 'react-D3fGh1jK.js', 'NflTeam-Zz11Yy22.js', 'GameExtras-Nw3Hash9.js']);
  assert.equal(ce.closeFixedByBuild(now, 'index-NewBuild1', assets), 1);
  assert.equal(row('Stack file gone').fixed_by, 'index-NewBuild1');
  assert.equal(row('Stack file still there').resolved_at, null);
  assert.equal(row('No stack').resolved_at, null, 'neither can be told: the 24 h rule decides');
  const done = require('../dist/services/doneForYou.js').doneList(7, now).find(x => x.kind === 'site-errors' && /Stack file gone/.test(x.title));
  assert.match(done.why, /GameExtras-C0ATdfL8\.js/);
  // the live assets are read from frontend/dist/assets once per build
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix275-dist-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index-Disk0001.js'), '');
  assert.ok(ce.liveAssets('index-Disk0001', dir).has('index-Disk0001.js'));
});

test('an admin reopening a group keeps it open on this build', () => {
  reset();
  const now = Date.now();
  ce.noteBuild('index-OldOld01', now - 30 * H);
  report('Reopened by hand', 'index-OldOld01', 3 * H);
  ce.noteBuild('index-NewNew01', now - H);
  assert.equal(ce.closeFixedByBuild(now, 'index-NewNew01', null), 1);
  db.prepare(`UPDATE client_errors SET resolved_at = NULL, fixed_by = NULL, kept_open = 'index-NewNew01' WHERE message = 'Reopened by hand'`).run(); // = resolveClientError(sig, false) on that build
  assert.equal(ce.closeFixedByBuild(now, 'index-NewNew01', null), 0);
});

test('Needs you / For Claude / summary counts / the email leave the grey groups out', () => {
  reset();
  const now = Date.now();
  ce.noteBuild('index-SumOld01', now - 30 * H);
  report('Fixed one', 'index-SumOld01', 3 * H);
  report('Fixed two', 'index-SumOld01', 4 * H);
  ce.noteBuild('index-SumNew01', now - H);
  report('Still broken on live', 'index-SumNew01', 0);
  ce.closeFixedByBuild(now, 'index-SumNew01', null);
  const f = ce.errorsForClaude(now);
  assert.equal(f.open, 1);
  assert.deepEqual(f.top.map(t => t.message), ['Still broken on live']);
  assert.equal(f.top[0].build, 'index-SumNew01');
  const list = ce.clientErrorList(30);
  assert.equal(list.open, 1);
  assert.equal(list.last24h, 1);
  assert.ok(list.rows.find(r => r.message === 'Fixed one').fixedBy === 'index-SumNew01');
  const s = require('../dist/services/adminSummary.js').adminSummary(now);
  assert.equal(s.siteErrorsOpen, 1);
  assert.equal(s.siteErrors24h, 1);
  assert.equal(s.forClaude.open, 1);
  // the Copy for Claude text: only the open one, with its build
  const { forClaudeText } = require('../dist/services/forClaude.js');
  const text = forClaudeText({ place: 'Admin → Needs you', cards: [{ id: 'for-claude', title: 'For Claude today' }] }, { viewer: { id: 1, manage: true } }, now);
  assert.match(text, /Still broken on live/);
  assert.doesNotMatch(text, /Fixed one|Fixed two/);
  assert.match(text, /builds index-SumNew01/);
  // the worker runs the check every 5 min and right after a start
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/services/clientErrors.ts'), 'utf8');
  assert.match(src, /every\('site errors: fixed by a newer build', [^]*?5 \* 60000\)/);
  assert.match(src, /after\('site errors: this build', \(\) => \{ checkSiteErrors\(\); \}/);
});

/* ---------- top-scorer check: a known lasting difference is not a fault ---------- */

test('known difference: Ferri-style (page ahead by the same gap on 3 checks) → known, out of the %; a lagging page keeps counting', () => {
  const { isKnownGap, goalGap, leaguesUnderFor } = require('../dist/utils/auditStreak.js');
  const { leagueShare } = require('../dist/services/dataAudit.js');
  const ferri = (o, p) => ({ kind: 'mismatch', league: 'DED', player: 'Nacho Ferri', playerId: 9001, detail: `Goals: official list ${o}, his page ${p}` });
  const run = issues => ({ leagues: ['DED'], issues });
  assert.equal(goalGap('Goals: official list 5, his page 6'), 1);
  assert.equal(goalGap('Appearances: official list 9, his page 7'), null);
  // two earlier checks with the same +1 → the third is known
  assert.equal(isKnownGap([run([ferri(5, 6)]), run([ferri(4, 5)])], 'DED', { name: 'Nacho Ferri', id: 9001 }, 1), true);
  // only one earlier check → not yet
  assert.equal(isKnownGap([run([ferri(5, 6)])], 'DED', { name: 'Nacho Ferri', id: 9001 }, 1), false);
  // the gap changed → not known
  assert.equal(isKnownGap([run([ferri(5, 7)]), run([ferri(4, 5)])], 'DED', { name: 'Nacho Ferri', id: 9001 }, 1), false);
  // a run that did not check the league does not break the streak
  assert.equal(isKnownGap([run([ferri(5, 6)]), { leagues: ['PL'], issues: [] }, run([ferri(4, 5)])], 'DED', { id: 9001 }, 1), true);
  // official list ahead (the provider a game behind): never known, however long
  const behind = run([{ kind: 'mismatch', league: 'DED', player: 'Lagging', playerId: 7, detail: 'Goals: official list 6, his page 5' }]);
  assert.equal(isKnownGap([behind, behind, behind], 'DED', { id: 7 }, -1), false);
  // the league %: known left out like lag; a lagging case still counted
  assert.equal(leagueShare({ checked: 20, matched: 18, lag: 0, known: 1 }), 18 / 19);
  assert.equal(leagueShare({ checked: 20, matched: 18, lag: 0, known: 0 }), 18 / 20);
  // the "under 90% for 7 days" email: 17 of 19 counted (89.5%) with 1 known → 17/18 = 94% → no streak
  const DAY = 86400000, now = Date.now();
  const days = k => Array.from({ length: 9 }, (_, i) => ({ at: iso(now - (8 - i) * DAY), byLeague: { DED: { checked: 19, matched: 17, lag: 0, known: k } } }));
  assert.equal(leaguesUnderFor(days(1), now).length, 0);
  assert.equal(leaguesUnderFor(days(0), now).length, 1);
});

test('known difference: the For Claude list shows it grey (flagged, after the real ones), the data-health check does not count it', () => {
  const { auditForClaude } = require('../dist/services/dataAudit.js');
  const report = {
    at: iso(Date.now()), checked: 3, matched: 1, lag: 0, known: 1,
    byLeague: { DED: { checked: 3, matched: 1, lag: 0, known: 1 } },
    issues: [
      { kind: 'known', league: 'DED', player: 'Nacho Ferri', detail: 'Goals: official list 5, his page 6', reason: 'Provider and league disagree (known): …' },
      { kind: 'mismatch', league: 'DED', player: 'Lagging', detail: 'Goals: official list 6, his page 5', reason: 'the official list has more than his page' }
    ]
  };
  const dc = auditForClaude(report, []);
  assert.deepEqual(dc.differences.map(d => [d.player, d.known]), [['Lagging', false], ['Nacho Ferri', true]]);
  assert.equal(dc.known, 1);
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/services/dataAudit.ts'), 'utf8');
  assert.match(src, /kind: 'known'[^\n]*Provider and league disagree \(known\)/);
});

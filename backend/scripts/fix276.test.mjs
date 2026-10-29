// fix276: data health is red only when something is really wrong (Yarin, 29 Oct 18:04: 4 red checks, none a real
// fault except tennis). (dist build) Run: npm run test:fix276
//  1. Calibration: a band's allowed gap = max(5 points, 2 × the standard error of its hit rate); over 5 but inside it =
//     yellow "too few games to tell", outside = red; the allowed gap is shown next to each band.
//  2. Search engines verified: red at ≥ 0.5% of a verified crawler's requests refused, or any 429 outside a start's
//     first 10 minutes; a 503 "Starting up" in the warm-up is counted in "Errors during the last deploy".
//  3. Slow requests / Slow reads: the warm-up (10 min after ready) is counted apart; red over 5 outside it, 1–5 yellow,
//     the 3 slowest routes named.
//  4. Disk: the WAL under 256 MB with TRUNCATE working is plain ok; the detail says when the last TRUNCATE ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const R = require(DIST + '/utils/healthRules.js');
const MB = 1048576, GB = 1073741824;

/** a child process (one process, every role) on an empty database */
function child(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix276-'));
  const env = { ...process.env, DATA_DIR: dir, SL_ROLE: 'all', THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `const D = ${JSON.stringify(DIST)};\n(async () => {\n${code}\n})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });`], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- 1. calibration ---------- */

test('calibration: the allowed gap grows with the band (2 standard errors, at least 5 points)', () => {
  assert.equal(R.calibAllowed(66, 47.2), 12.3);
  assert.equal(R.calibAllowed(100, 74.6), 8.7);
  assert.equal(R.calibAllowed(5000, 60), 5, 'a big band: 5 points');
});

test('calibration: basketball 50–60% +7.8 on 66 games → yellow "too few games to tell"', () => {
  const v = R.calibVerdict([{ label: '50–60%', n: 66, said: 55, hitRate: 47.2 }, { label: '60–70%', n: 80, said: 65, hitRate: 64 }]);
  assert.equal(v.level, 'warn');
  assert.equal(v.worst.gap, 7.8);
  assert.equal(v.worst.allowed, 12.3);
});

test('calibration: tennis 60–70% −10.1 on 100 games → red', () => {
  const v = R.calibVerdict([{ label: '60–70%', n: 100, said: 64.5, hitRate: 74.6 }, { label: '50–60%', n: 70, said: 55, hitRate: 54 }]);
  assert.equal(v.level, 'fail');
  assert.equal(v.worst.gap, -10.1);
  assert.equal(v.worst.allowed, 8.7);
  // within 5 everywhere: ok; under 100 games in all: not judged
  assert.equal(R.calibVerdict([{ n: 100, said: 64, hitRate: 61 }]).level, 'ok');
  assert.equal(R.calibVerdict([{ n: 60, said: 64, hitRate: 30 }]).level, 'ok');
});

test('calibration: data health uses the tolerance and shows the allowed gap next to each band', () => {
  const s = SRC('src/services/calibrationHealth.ts');
  assert.match(s, /calibVerdict\(rows\)/);
  assert.match(s, /allowed ±\$\{calibAllowed\(r\.n, r\.hitRate\)\}/);
  assert.match(s, /too few games to tell \(\$\{w!\.n\} games\)/);
});

/* ---------- 2. search engines ---------- */

test('search engines: rules — 0.5% of verified requests, or any 429 outside the warm-up', () => {
  assert.equal(R.crawlerVerdict([{ name: "Google's ranges", requests: 7661, refused: 1, s429: 0 }]).level, 'ok', '1 of 7,661 (a 503) → green');
  assert.equal(R.crawlerVerdict([{ name: 'Googlebot', requests: 1000, refused: 5, s429: 0 }]).level, 'fail', '0.5% → red');
  assert.equal(R.crawlerVerdict([{ name: 'Googlebot', requests: 7661, refused: 1, s429: 1 }]).level, 'fail', 'a 429 outside the warm-up → red');
  assert.equal(R.crawlerVerdict([{ name: 'Googlebot', requests: 7661, refused: 1, s429: 1, warm429: 1 }]).level, 'ok', 'a 429 in the warm-up alone → green');
});

test('search engines: one 503 "Starting up" during a start → green, counted for the deploy row; a 429 after the warm-up → red', () => {
  const out = child(`
    const C = require(D + '/services/crawlerIps.js');
    const RD = require(D + '/services/readiness.js');
    const DE = require(D + '/services/deployErrors.js');
    const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    // the start: one 503 before the state is loaded, then 7,660 answered
    C.noteCrawlerResponse(UA, '66.249.66.1', 'list', 503, '/football');
    RD.markReady({ loadMs: 1, states: 0 });
    for (let i = 0; i < 7660; i++) C.noteCrawlerResponse(UA, '66.249.66.1', 'list', 200, '/football');
    const start = C.crawlerHealth()[0];
    const deploy = DE.deployErrors().crawlerStartup;
    // 11 minutes later (outside the warm-up): one 429
    const real = Date.now; Date.now = () => real() + 11 * 60000;
    C.noteCrawlerResponse(UA, '66.249.66.1', 'list', 429, '/football');
    const after = C.crawlerHealth()[0];
    console.log(JSON.stringify({ start: { level: start.level, detail: start.detail, items: start.items }, deploy, after: { level: after.level, items: after.items } }));
  `);
  assert.equal(out.start.level, 'ok', out.start.detail);
  assert.equal(out.deploy, 1, 'the 503 is counted in "Errors during the last deploy"');
  assert.ok(out.start.items.some(x => /Starting up/.test(x)), 'the warm-up 503 is named apart');
  assert.equal(out.after.level, 'fail');
  assert.ok(out.after.items.some(x => /^Red: .*429/.test(x)));
});

/* ---------- 3. slow requests ---------- */

test('slow requests: rules — over 5 red, 1–5 yellow, the 3 slowest named', () => {
  const v = R.slowVerdict([{ route: 'a', people: 2, maxMs: 1200 }, { route: 'b', people: 2, maxMs: 4000 }, { route: 'c', people: 1, maxMs: 2500 }, { route: 'd', people: 1, maxMs: 1100 }]);
  assert.equal(v.level, 'fail');
  assert.equal(v.slowest, 'b 4.0 s, c 2.5 s, a 1.2 s');
  assert.equal(R.slowVerdict([{ route: 'a', people: 5, maxMs: 1200 }]).level, 'warn');
  assert.equal(R.slowVerdict([]).level, 'ok');
});

test('slow requests: 12 slow requests all in the warm-up → green; 6 outside → red', () => {
  const out = child(`
    const DL = require(D + '/services/deadline.js');
    const { db } = require(D + '/db/index.js');
    const m = Math.floor(Date.now() / 60000) - 5;
    const ins = db.prepare('INSERT OR REPLACE INTO slow_requests (minute, route, n, max_ms, crawler, admin, signed, warm, max_out) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)');
    ins.run(m, 'http GET /api/matches', 7, 3200, 7, 0);
    ins.run(m - 1, 'http GET /football', 5, 2100, 5, 0);
    const warm = DL.slowRequestsHealth();
    ins.run(m - 2, 'http GET /api/bb/games', 4, 1800, 0, 1800);
    ins.run(m - 3, 'http GET /api/nfl/weeks', 2, 1300, 0, 1300);
    const red = DL.slowRequestsHealth();
    console.log(JSON.stringify({ warm, red }));
  `);
  assert.equal(out.warm.level, 'ok', out.warm.detail);
  assert.match(out.warm.detail, /12 more in a start's warm-up/);
  assert.equal(out.red.level, 'fail', out.red.detail);
  assert.match(out.red.detail, /6 public request\(s\).*slowest: http GET \/api\/bb\/games 1\.8 s, http GET \/api\/nfl\/weeks 1\.3 s/);
});

test('slow requests / reads / search engines: the warm-up comes from the ready time and is counted apart', () => {
  assert.match(SRC('src/services/readiness.ts'), /inWarmUp = \(now = Date\.now\(\)\) => !ready \|\| now - readyAt < WARM_UP_MS/);
  assert.match(SRC('src/services/deadline.ts'), /if \(inWarmUp\(\)\) e\.warm\+\+/);
  assert.match(SRC('src/services/pageReader.ts'), /if \(inWarmUp\(\)\) \{ if \(ms > 500\) h\.warm500\+\+; return; \}/);
  assert.match(SRC('src/services/dbSpace.ts'), /SUM\(n - crawler - COALESCE\(warm, 0\)\)/);
  assert.match(SRC('src/services/deployErrors.ts'), /items: \[warmUpLine\(r\)/);
});

/* ---------- 4. disk ---------- */

test('disk: WAL 113 MB with TRUNCATE working → ok; over 256 MB or no TRUNCATE in an hour → red (fix273)', () => {
  const rules = require(DIST + '/utils/diskRules.js');
  const base = { volFree: 34 * GB, volTotal: 50 * GB, dbBytes: 3 * GB, growth7d: null, truncateAgeMs: 9 * 60000 };
  assert.equal(rules.diskVerdict({ ...base, walBytes: 113 * MB }).level, 'ok');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 257 * MB }).level, 'fail');
  assert.equal(rules.diskVerdict({ ...base, walBytes: 0, truncateAgeMs: 61 * 60000 }).level, 'fail');
});

test('disk: the line says whether the last TRUNCATE ran and when', () => {
  const out = child(`
    const S = require(D + '/services/dbSpace.js');
    const now = Date.parse('2026-10-29T18:04:00Z');
    console.log(JSON.stringify({
      done: S.truncateLine(113 * 1048576, { lastTruncate: { at: '2026-10-29T17:55:00.000Z', busy: 0 }, lastDone: { at: '2026-10-29T17:55:00.000Z' } }, now),
      busy: S.truncateLine(113 * 1048576, { lastTruncate: { at: '2026-10-29T18:00:00.000Z', busy: 1 }, lastDone: { at: '2026-10-29T17:30:00.000Z' } }, now),
      none: S.truncateLine(0, { lastTruncate: null, lastDone: null }, now)
    }));
  `);
  assert.equal(out.done, 'WAL 113 MB, last TRUNCATE ran 17:55 UTC, 9 min ago');
  assert.equal(out.busy, 'WAL 113 MB, last TRUNCATE tried 18:00 UTC, 4 min ago, blocked by a reader; last one that ran 17:30 UTC, 34 min ago');
  assert.match(out.none, /no TRUNCATE yet since the start/);
});

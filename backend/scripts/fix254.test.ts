// fix254: the last loose ends of the 28 Oct check — (1) who the client is behind Railway's edge, (2) a real page
// cache, (3) self-learning promotes only on a gain ≥ 0.0005 and at most once in 7 days, (4) the recent calibration
// layer (isotonic, walk-forward, promoted by the model's rules), (5) the top-scorer check emails only after 7 days
// under 90%, its differences go to the For Claude list. Run: npm run test:fix254 (compiles first: the tests use dist/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const dist = (f: string) => require(path.join(here, '..', 'dist', f));
const DAY = 86400000;

const { DAILY_RULES, preJudge, finishJudge, pairedBootstrap, promotionWait, mulberry32 } = dist('utils/dailyRules.js');
const { fitIso, applyIso, calibrateP, calibrate2, fitLayer, decideRecent, FIT_DAYS, MIN_FIT } = dist('utils/recentCalib.js');
const { leaguesUnderFor, dueForEmail } = dist('utils/auditStreak.js');
const { clientOf, makeTrustProxy, isInternalHop } = dist('utils/clientIp.js');
const { cacheMbFor, tunePragmas } = dist('utils/dbTune.js');

const win = (d: number[], hitC = 50, hitB = 50) => ({ s: { n: d.length, diff: Math.round((d.reduce((a, b) => a + b, 0) / (d.length || 1)) * 1e5) / 1e5, hitC, hitB }, d });

/* ---------- (3) self-learning churn ---------- */

test('(3) a gain of −0.0001 in the last window is not a promotion, even when better in both windows', () => {
  const W = win(Array(400).fill(-0.0001)), Wp = win(Array(400).fill(-0.002));
  const v = preJudge(W, Wp);
  assert.ok(v && !v.pass);
  assert.match(v.why, /gain too small/);
});

test('(3) a gain of −0.0006 in the last window passes the gain rule (then the bootstrap decides)', () => {
  const W = win(Array(400).fill(-0.0006)), Wp = win(Array(400).fill(-0.001));
  assert.equal(preJudge(W, Wp), null);
  const v = finishJudge(W, Wp, pairedBootstrap([...W.d, ...Wp.d]));
  assert.equal(v.pass, true);
  assert.equal(DAILY_RULES.minGain, 0.0005);
});

test('(3) at most one promotion in 7 days: days to wait from the last promotion', () => {
  assert.equal(DAILY_RULES.minDaysBetween, 7);
  assert.equal(promotionWait(null, '2026-10-28'), 0);
  assert.equal(promotionWait('2026-10-28', '2026-10-28'), 7);
  assert.equal(promotionWait('2026-10-25', '2026-10-28'), 4);
  assert.equal(promotionWait('2026-10-21', '2026-10-28'), 0);
  assert.equal(promotionWait('2026-10-01', '2026-10-28'), 0);
});

test('(3) wiring: the daily job holds a passing candidate within 7 days of the last promotion; the rollback comes first, never held', () => {
  const src = read('src/services/modelDaily.ts');
  assert.match(src, /promotionWait\(lastPromo\?\.date, today, R\)/);
  assert.match(src, /decision = 'promote' AND date < \?/);
  assert.ok(src.indexOf('5. guardrail first') < src.indexOf('promotionWait(lastPromo'), 'the guardrail rollback runs before the 7-day rule');
});

/* ---------- (4) the recent calibration layer ---------- */

test('(4) isotonic fit: monotone knots, small blocks shrunk toward their own chance', () => {
  const r = mulberry32(3);
  const rows = Array.from({ length: 4000 }, () => { const top = 0.4 + 0.5 * r(); return { top, hit: r() < Math.min(0.99, top + 0.06) ? 1 : 0 }; });
  const f = fitIso(rows);
  for (let i = 1; i < f.x.length; i++) { assert.ok(f.x[i] > f.x[i - 1]); assert.ok(f.y[i] >= f.y[i - 1]); }
  // under-confident model: the layer raises the middle
  assert.ok(applyIso(f, 0.55) > 0.57, `0.55 → ${applyIso(f, 0.55)}`);
  // one game alone barely moves
  const one = fitIso([{ top: 0.6, hit: 1 }]);
  assert.ok(Math.abs(one.y[0] - 0.6) < 0.02);
});

test('(4) calibrated 1X2: same scale, sums kept, the favourite stays the favourite', () => {
  const L = { x: [0.4, 0.5, 0.6], y: [0.2, 0.25, 0.3] }; // a layer that would push every favourite far down
  const out = calibrateP(L, [45, 30, 25]);
  assert.ok(Math.abs(out[0] + out[1] + out[2] - 100) < 1e-9);
  assert.ok(out[0] > out[1] && out[0] > out[2], `favourite kept: ${out}`);
  const up = calibrateP({ x: [0.5, 0.6], y: [0.55, 0.66] }, [54, 26, 20]);
  assert.ok(up[0] > 54 && up[1] < 26 && up[2] < 20);
  assert.ok(Math.abs(up[1] / up[2] - 26 / 20) < 1e-9, 'the others keep their proportion');
  // tennis: symmetric
  const p = calibrate2({ x: [0.6, 0.7], y: [0.66, 0.76] }, 0.35);
  assert.ok(p < 0.35);
  assert.equal(calibrateP(null, [50, 25, 25]).join(), '50,25,25');
});

/** football-like rows: the model says `said`, the result happens `said + bias` of the time */
function synth(days: number, perDay: number, bias: number, now: number, seed = 11) {
  const r = mulberry32(seed);
  const rows: any[] = [];
  for (let d = days; d >= 1; d--) for (let k = 0; k < perDay; k++) {
    const top = 0.4 + 0.35 * r(), rest = (1 - top) / 2;
    const hit = r() < Math.min(0.98, top + bias);
    const y = hit ? 0 : r() < 0.5 ? 1 : 2;
    rows.push({ p: [top, rest - 0.01, rest + 0.01], y, t: now - d * DAY + k * 1000 });
  }
  return rows;
}

test('(4) an under-confident model (54% said, ~60% happened) gets a new layer: better in both windows, walk-forward', () => {
  const now = Date.parse('2026-10-28T05:00:00Z');
  const rows = synth(300, 15, 0.06, now);
  const d = decideRecent(rows, null, null, null, now);
  assert.equal(d.decision, 'promote', d.reason);
  assert.ok(d.windows.W.diff <= -DAILY_RULES.minGain && d.windows.Wp.diff < 0);
  assert.ok(d.windows.W.n >= DAILY_RULES.minGames && d.windows.Wp.n >= DAILY_RULES.minGames);
  assert.ok(d.live && d.live.to === '2026-10-28' && d.live.n >= MIN_FIT);
  const b = d.bands.find((x: any) => x.lo === 50);
  assert.ok(b.happened - b.said > 3, `band 50–60: said ${b.said}, happened ${b.happened}`);
  assert.ok(b.cal > b.said, 'the walk-forward layer says more');
});

test('(4) the candidate for a window never sees that window (fit ends where the window starts)', () => {
  const now = Date.parse('2026-10-28T05:00:00Z');
  const rows = synth(300, 15, 0.06, now);
  const W0 = Math.floor(now / DAY) * DAY - DAILY_RULES.windowDays * DAY;
  const a = fitLayer(rows, W0 - FIT_DAYS * DAY, W0);
  // every result inside the window flipped: the window's own fit would change, this one must not
  const flipped = rows.map((r: any) => (r.t >= W0 ? { ...r, y: r.y === 0 ? 1 : 0 } : r));
  const b = fitLayer(flipped, W0 - FIT_DAYS * DAY, W0);
  assert.deepEqual(a, b);
  assert.equal(a.to, new Date(W0).toISOString().slice(0, 10));
});

test('(4) a well-calibrated model keeps no layer; a passing layer within 7 days of the last promotion is held', () => {
  const now = Date.parse('2026-10-28T05:00:00Z');
  const ok = decideRecent(synth(300, 15, 0, now, 5), null, null, null, now);
  assert.notEqual(ok.decision, 'promote', ok.reason);
  const held = decideRecent(synth(300, 15, 0.06, now), null, null, '2026-10-25', now);
  assert.equal(held.decision, 'held');
  assert.match(held.reason, /at most one in 7 days/);
});

test('(4) guardrail: a live layer worse than none since it went live is rolled back (any day)', () => {
  const now = Date.parse('2026-10-28T05:00:00Z');
  const bad = { x: [0.4, 0.5, 0.6, 0.7], y: [0.2, 0.22, 0.25, 0.3], n: 500, from: '2026-04-01', to: '2026-09-01' };
  const d = decideRecent(synth(300, 15, 0, now, 9), bad, '2026-09-20', '2026-10-27', now);
  assert.equal(d.decision, 'rollback', d.reason);
  assert.equal(d.live, null);
});

test('(4) wiring: football 1X2 and tennis chance go through the layer; the chance before it is saved; nightly job; data health counts the layer', () => {
  const tr = read('src/services/tracking.ts');
  assert.match(tr, /const computed = calibrateFootball\(computedIn\)/);
  assert.match(tr, /p_pre = excluded\.p_pre/);
  const tm = read('src/services/tennisModel.ts');
  assert.match(tm, /p = calibrateTennis\(p\)/);
  assert.match(tm, /p_pre = excluded\.p_pre/);
  assert.match(read('src/jobs.ts'), /startRecentCalibScheduler\(\)/);
  assert.match(read('src/services/perf.ts'), /'football calibration'/);
  assert.match(read('src/services/calibrationHealth.ts'), /recentHealthRows\(sport\)/);
  const st = read('src/services/recentCalibState.ts');
  assert.match(st, /p\.model === 'feat-v1'/, 'the shadow feature model is left alone');
});

/* ---------- (5) the top-scorer check ---------- */

const run = (at: string, share: Record<string, [number, number]>) => ({ at, byLeague: Object.fromEntries(Object.entries(share).map(([k, [m, c]]) => [k, { checked: c, matched: m, lag: 0 }])) });

test('(5) a league is emailed only after 7 days under 90%, and a good day resets the streak', () => {
  const now = Date.parse('2026-10-28T08:00:00Z');
  const days = (n: number) => new Date(now - n * DAY).toISOString();
  const runs = [
    run(days(9), { PL: [19, 20], SA: [17, 20], BL1: [20, 20] }),
    run(days(8), { PL: [17, 20], SA: [17, 20], BL1: [17, 20] }),
    ...[7, 6, 5, 4, 3, 2, 1, 0].map(n => run(days(n), { PL: [17, 20], SA: [17, 20], BL1: n === 3 ? [19, 20] : [17, 20] }))
  ];
  const under = leaguesUnderFor(runs, now);
  assert.deepEqual(under.map((u: any) => u.league), ['PL', 'SA']);
  assert.equal(under.find((u: any) => u.league === 'PL').since, days(8));
  assert.equal(under.find((u: any) => u.league === 'SA').since, days(9));
  // 6 days under is not enough
  assert.deepEqual(leaguesUnderFor(runs.slice(-6), now), []);
  // once a week per league
  assert.deepEqual(dueForEmail(under, { PL: days(2) }, now).map((u: any) => u.league), ['SA']);
  assert.deepEqual(dueForEmail(under, { PL: days(8) }, now).map((u: any) => u.league), ['PL', 'SA']);
});

test('(5) wiring: no "Needs you" email for differences; they are on the For Claude list', () => {
  const src = read('src/services/dataAudit.ts');
  assert.doesNotMatch(src, /Needs you: \$\{n\} top scorer/);
  assert.doesNotMatch(src, /compare with the league’s own list/);
  assert.match(src, /const due = dueForEmail\(leaguesUnderFor\(recentAuditRuns\(\)\), sent\)/);
  assert.match(src, /if \(!due\.length\) return;/);
  assert.match(read('src/services/adminSummary.ts'), /dataCheck = auditForClaude\(\)/);
  assert.match(read('../frontend/src/components/admin/AdminParts.tsx'), /Top-scorer check/);
});

/* ---------- (1) client address, (2) page cache ---------- */

test('(1) req.ip = the rightmost hop that is not a proxy (internal / CGNAT / Railway hops skipped)', () => {
  assert.equal(clientOf('10.0.0.5', '66.249.66.1'), '66.249.66.1');
  assert.equal(clientOf('10.0.0.5', '66.249.66.1, 100.64.3.2'), '66.249.66.1');
  assert.equal(clientOf('::ffff:127.0.0.1', '1.2.3.4, 66.249.66.1, 10.1.2.3'), '66.249.66.1', 'a spoofed left part is ignored');
  assert.equal(clientOf('10.0.0.5', '66.249.66.1, 34.0.0.9', ip => (ip === '34.0.0.9' ? 400940 : null)), '66.249.66.1', "Railway's own network is a proxy hop");
  assert.equal(clientOf('10.0.0.5', ''), '10.0.0.5');
  assert.ok(isInternalHop('172.20.1.1') && isInternalHop('fd12::1') && !isInternalHop('66.249.66.1'));
  assert.equal(makeTrustProxy()('203.0.113.9', 0), true, 'the socket is always a proxy');
  assert.match(read('src/app.ts'), /app\.set\('trust proxy', makeTrustProxy\(/);
});

test('(2) page cache: 256 MB readers, 64 MB web, scaled down in a small container; mmap + temp in memory', () => {
  assert.equal(cacheMbFor('reader', null), 256);
  assert.equal(cacheMbFor('web', null), 64);
  assert.equal(cacheMbFor('reader', 8192), 256);
  assert.ok(cacheMbFor('reader', 1024) < 256 && cacheMbFor('reader', 1024) >= 16);
  const p = tunePragmas('reader', null);
  assert.ok(p.includes('PRAGMA cache_size = -262144'));
  assert.ok(p.some((x: string) => /mmap_size = 1073741824/.test(x)) && p.includes('PRAGMA temp_store = MEMORY'));
  assert.match(read('src/workers/pageReader.ts'), /tuneDb\(db, 'reader'\)/);
  assert.match(read('src/db/index.ts'), /tuneDb\(db,/);
});

test('(2) hot keys: page times / ETags and state versions come from the worker in memory', () => {
  const pc = read('src/services/pageCache.ts');
  assert.match(pc, /const h = hot\.get\(key\); if \(h && Date\.now\(\) - h\.at < keepOf\(key\)\) \{ hotStats\.hits\+\+; return h\.at; \}/);
  assert.match(pc, /sendIpc\(\{ t: 'page', key, builtAt: at, etags \}\)/);
  assert.match(pc, /onIpc\('page-meta'/);
  const sh = read('src/services/shared.ts');
  assert.match(sh, /sendIpc\(\{ t: 'state-vers', vers: workerVers\(\) \}\)/);
  assert.match(sh, /if \(!force && versFromWorker\(\)\) return chain;/);
  assert.match(read('src/services/deadline.ts'), /ALWAYS_CUT = \/\^\\\/api\\\/\(slug-of\\\/\|public\\\/results\$\)\//);
});

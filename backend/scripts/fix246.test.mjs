// fix246: "Our different view" (admin only) — the gap maths (margin removal for 3-way and 2-way markets, our side, gap
// bands, the return of 1 unit with its 95% interval), the record frozen at kick-off (rows can't be changed or deleted,
// only their result filled in) and that nothing of it reaches a public route. (dist build) Run: npm run test:fix246
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix246-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { db } = require('../dist/db/index.js');
const U = require('../dist/utils/diffView.js');
const S = require('../dist/services/diffView.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

/* ---------- maths ---------- */

test('fix246: 3-way prices → margin removed, probabilities add up to 1 and keep the price ratios', () => {
  const odds = [2.0, 3.4, 4.0];
  const p = U.fairProbs(odds);
  const inv = odds.map(x => 1 / x), s = inv[0] + inv[1] + inv[2];
  close(p[0] + p[1] + p[2], 1);
  p.forEach((x, i) => close(x, inv[i] / s));
  close(U.overround(odds), s - 1);
  assert.ok(U.overround(odds) > 0.04 && U.overround(odds) < 0.05, 'about a 4.4% margin');
  // a fair book stays as it is
  const f = U.fairProbs([2, 4, 4]);
  close(f[0], 0.5); close(f[1], 0.25); close(f[2], 0.25);
});

test('fix246: 2-way prices and exchange probabilities → margin removed', () => {
  const p = U.fairProbs([1.8, 2.1]);
  close(p[0] + p[1], 1);
  close(p[0], (1 / 1.8) / (1 / 1.8 + 1 / 2.1));
  // an exchange mid given as probabilities (0.62 / 0.40 = 2% over) is normalised the same way
  const q = U.fairProbs([0.62, 0.40]);
  close(q[0], 0.62 / 1.02); close(q[1], 0.40 / 1.02);
  // missing / impossible prices → null
  assert.equal(U.fairProbs([2.0, null, 3.0]), null);
  assert.equal(U.fairProbs([2.0, 1.0]), null);
  assert.equal(U.fairProbs([2.0, 0]), null);
  assert.equal(U.fairProbs([2.0]), null);
});

test('fix246: our side = the outcome we rate higher than the market by the most; gap in points; bands', () => {
  // market (fair) 50 / 25 / 25; we say 40 / 34 / 26 → the draw, +9 points
  const s = U.ourSide([0.40, 0.34, 0.26], [0.5, 0.25, 0.25]);
  assert.equal(s.side, 1); assert.equal(s.gap, 9);
  // 2-way: we say 58%, market 50% → player 1, +8
  const t = U.ourSide([0.58, 0.42], [0.5, 0.5]);
  assert.equal(t.side, 0); assert.equal(t.gap, 8);
  assert.equal(U.bandOf(2.9), null);
  assert.equal(U.bandOf(3), '3–5'); assert.equal(U.bandOf(4.9), '3–5');
  assert.equal(U.bandOf(5), '5–8'); assert.equal(U.bandOf(7.9), '5–8');
  assert.equal(U.bandOf(8), '8–12'); assert.equal(U.bandOf(11.9), '8–12');
  assert.equal(U.bandOf(12), '12+'); assert.equal(U.bandOf(40), '12+');
  assert.deepEqual(U.BANDS, ['3–5', '5–8', '8–12', '12+']);
});

test('fix246: return of 1 unit at the market price, with a 95% interval', () => {
  // 2 wins at 3.0 (+2 each), 2 losses (−1 each) → +2 units over 4 = +50%
  const bets = [{ won: true, price: 3 }, { won: true, price: 3 }, { won: false, price: 3 }, { won: false, price: 3 }].map(b => ({ ...b, ours: 0.4, market: 0.33 }));
  const s = U.summarize(bets);
  assert.equal(s.games, 4); assert.equal(s.hit, 50); assert.equal(s.units, 2); assert.equal(s.roi, 50);
  // sd of [2,2,−1,−1] = √3 → half-width 1.96·√3/2 = 1.697 → 50 ± 169.7
  assert.equal(s.roiLo, -119.7); assert.equal(s.roiHi, 219.7);
  assert.equal(s.ours, 40); assert.equal(s.market, 33);
  assert.equal(U.summarize([]).roi, null);
  assert.equal(U.unitReturn(true, 2.5), 1.5); assert.equal(U.unitReturn(false, 2.5), -1);
});

test('fix246: one game → a row on our side, at the price of that side (a probability quote → its fair price)', () => {
  const r = S.rowOf({ sport: 'football', league: 'L', period: 'live', date: '2026-10-01', home: 'A', away: 'B', model: [0.40, 0.34, 0.26], prices: [1.9, 3.8, 3.8], outcome: 1, sides: ['H', 'D', 'A'], names: ['A', 'Draw', 'B'] });
  assert.equal(r.side, 'D'); assert.equal(r.sideName, 'Draw'); assert.equal(r.price, 3.8); assert.equal(r.won, true);
  const fair = U.fairProbs([1.9, 3.8, 3.8]);
  close(r.market, fair[1]);
  // under 3 points → no row
  assert.equal(S.rowOf({ sport: 'football', league: 'L', period: 'live', date: '2026-10-01', home: 'A', away: 'B', model: fair, prices: [1.9, 3.8, 3.8], outcome: 0, sides: ['H', 'D', 'A'], names: ['A', 'Draw', 'B'] }), null);
  const t = S.rowOf({ sport: 'tennis', league: 'ATP', period: 'live', date: '2026-10-01', home: 'X', away: 'Y', model: [0.6, 0.4], prices: [0.5, 0.5], outcome: 1, sides: ['1', '2'], names: ['X', 'Y'] });
  assert.equal(t.side, '1'); close(t.price, 2); assert.equal(t.won, false); assert.equal(t.gap, 10);
});

/* ---------- frozen at kick-off ---------- */

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
function pred(id, { at, ph, pd, pa, odds, locked = 1, model = 'grid-v3' }) {
  db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team, away_team, p_home, p_draw, p_away, odds_home, odds_draw, odds_away, locked, settled, created_at, updated_at)
    VALUES (?, ?, 'PL', 'Premier League', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(id, model, at, `Home${id}`, `Away${id}`, ph, pd, pa, odds[0], odds[1], odds[2], locked, iso(NOW), iso(NOW));
}

test('fix246: a kicked-off game with a 5+ point gap is written once, can\'t be changed or deleted, and gets its result', () => {
  pred(1, { at: iso(NOW - 3600000), ph: 40, pd: 34, pa: 26, odds: [1.9, 3.8, 3.8] }); // draw +~8 → flagged
  pred(2, { at: iso(NOW - 3600000), ph: 50, pd: 26, pa: 24, odds: [1.9, 3.8, 3.8] }); // < 5 → not flagged
  pred(3, { at: iso(NOW + 3600000), ph: 30, pd: 40, pa: 30, odds: [1.9, 3.8, 3.8], locked: 0 }); // not started → not yet
  const a = S.diffViewFreezeTick(NOW);
  assert.equal(a.flagged, 1);
  const row = db.prepare(`SELECT * FROM diff_view_flags WHERE sport = 'football' AND game_id = 1`).get();
  assert.equal(row.side, 'D'); assert.equal(row.price, 3.8); assert.ok(row.gap >= 5);
  // the prediction changes afterwards (it can't, but even so): the stored row stays as it was
  db.prepare(`UPDATE predictions SET p_draw = 60 WHERE match_id = 1`).run();
  assert.equal(S.diffViewFreezeTick(NOW).flagged, 0);
  assert.equal(db.prepare(`SELECT ours FROM diff_view_flags WHERE game_id = 1`).get().ours, row.ours);
  // no edits, no deletes
  assert.throws(() => db.prepare(`UPDATE diff_view_flags SET ours = 0.9 WHERE game_id = 1`).run(), /frozen/);
  assert.throws(() => db.prepare(`UPDATE diff_view_flags SET price = 9 WHERE game_id = 1`).run(), /frozen/);
  assert.throws(() => db.prepare(`DELETE FROM diff_view_flags WHERE game_id = 1`).run(), /kept/);
  // the result is filled in
  db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (1, 'FINISHED', 1, 1, 'D', ?)`).run(iso(NOW));
  assert.equal(S.diffViewFreezeTick(NOW + 3 * 3600000).settled, 1);
  const done = db.prepare(`SELECT outcome, won FROM diff_view_flags WHERE game_id = 1`).get();
  assert.equal(done.outcome, 'D'); assert.equal(done.won, 1);
});

test('fix246: the report — groups by sport / period / league / band, upcoming 5+ games, the frozen record', async () => {
  pred(4, { at: iso(NOW + 86400000), ph: 30, pd: 40, pa: 30, odds: [1.9, 3.8, 3.8], locked: 0 });
  const r = await S.diffViewReport(NOW, true);
  assert.ok(r.upcoming.some(g => g.gameId === 4 && g.side === 'D' && g.gap >= 5), 'upcoming 5+ game listed');
  assert.ok(!r.upcoming.some(g => g.gameId === 1), 'a started game is not upcoming');
  const live = r.groups.find(g => g.sport === 'football' && g.period === 'live' && g.league === 'All leagues' && g.band === 'all');
  assert.ok(live && live.games >= 1);
  assert.equal(r.flagged.total, 1); assert.equal(r.flagged.settled, 1); assert.equal(r.flagged.all.hit, 100);
  assert.deepEqual(r.sports.filter(s => !s.prices).map(s => s.sport), ['basketball', 'american-football']);
});

/* ---------- nothing public ---------- */

test('fix246: the report is admin only — not in OPEN_API, no public file reads it, only the admin card fetches it', () => {
  const app = fs.readFileSync(path.join(root, 'backend/src/app.ts'), 'utf8');
  const m = app.match(/const OPEN_API = (\/.*\/);\r?\n/);
  assert.ok(m, 'OPEN_API found');
  const OPEN = eval(m[1]);
  assert.ok(OPEN.test('/api/matches'), 'sanity: a public route matches');
  for (const p of ['/api/admin/diff-view', '/api/diff-view']) assert.equal(OPEN.test(p), false, `${p} is public`);
  assert.ok(app.includes(`app.get('/api/admin/diff-view'`));
  // backend: only app.ts (the admin route) and jobs.ts (the freeze job) use the service
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const users = walk(path.join(root, 'backend/src')).filter(f => /services\/diffView'|utils\/diffView'|diff_view_flags/.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(users, ['backend/src/app.ts', 'backend/src/jobs.ts', 'backend/src/services/diffView.ts']);
  // frontend: only the admin card fetches it, and only the admin page shows the card
  const fe = walk(path.join(root, 'frontend/src'));
  const fetchers = fe.filter(f => /diff-view/.test(fs.readFileSync(f, 'utf8')) && !/lib[\\/]adminTabs\.ts$|pages[\\/]Admin\.tsx$/.test(f)).map(f => path.basename(f));
  assert.deepEqual(fetchers, ['DiffViewCard.tsx']);
  const cardUsers = fe.filter(f => /DiffViewCard/.test(fs.readFileSync(f, 'utf8'))).map(f => path.basename(f)).sort();
  assert.deepEqual(cardUsers, ['Admin.tsx', 'DiffViewCard.tsx']);
});

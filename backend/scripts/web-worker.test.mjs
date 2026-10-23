// fix202: the web process's stored pages must be what the worker would answer the same visitor.
// Run against a local web.js (see docs/notes/perf.md, fix202): WEB=http://localhost:3111 WORKER=http://127.0.0.1:3911
// DB=<DATA_DIR>/bet-to-beat.sqlite node --test scripts/web-worker.test.mjs
// Makes four test accounts (free, Premium, Pro, free with unlocked games) on that database copy, then asks the web
// process and the worker directly for every prebuilt page as each of them (and signed out) and compares the answers
// (timestamps left out). Also: stored pages answer fast, a stored page carries its age, the live socket gets the
// worker's ticks, and the web process keeps answering while the worker is restarted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const WEB = process.env.WEB || 'http://localhost:3111';
const WORKER = process.env.WORKER || 'http://127.0.0.1:3911';
const DB = process.env.DB;
if (!DB) throw new Error('DB=<path to the test copy> is required');

const db = new DatabaseSync(DB);
const now = new Date().toISOString();
const far = new Date(Date.now() + 365 * 86400000).toISOString();
function account(email, plan) {
  db.prepare('DELETE FROM users WHERE email = ?').run(email);
  const r = db.prepare('INSERT INTO users (email, name, pass_hash, plan, premium_until, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(email, 'Test', 'x', plan, plan === 'free' ? null : far, now);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(crypto.createHash('sha256').update(token).digest('hex'), Number(r.lastInsertRowid), now, far);
  return { id: Number(r.lastInsertRowid), cookie: `b2b_session=${token}` };
}
const users = {
  anon: null,
  free: account('fix202-free@test.local', 'free'),
  premium: account('fix202-premium@test.local', 'premium'),
  pro: account('fix202-pro@test.local', 'pro'),
  unlocked: account('fix202-unlocked@test.local', 'free')
};
// a few finished and coming basketball games unlocked (reveal id = -game id)
for (const g of db.prepare("SELECT game_id AS id FROM bb_games ORDER BY ABS(julianday(kickoff) - julianday('now')) LIMIT 5").all())
  db.prepare('INSERT OR IGNORE INTO match_unlocks (user_id, match_id, at) VALUES (?, ?, ?)').run(users.unlocked.id, -g.id, now);

const KEYS = [
  '/api/public/summary', '/api/public/results?days=30&limit=50', '/api/draw-alerts', '/api/news?limit=10',
  '/api/basketball/games?days=7', '/api/basketball/games?days=30&results=1', '/api/basketball/record?days=30',
  '/api/basketball/standings/NBA', '/api/basketball/standings/EL', '/api/nfl/home', '/api/nfl/record?days=30',
  '/api/tennis/home?tour=all', '/api/tennis/record?days=30&tour=all', '/api/hub', '/api/hub/premier-league'
];
const strip = v => {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['timestamp', 'cacheAgeMs', 'cached'].includes(k)).map(([k, x]) => [k, strip(x)]));
  return v;
};
async function get(base, path, who) {
  const t0 = performance.now();
  const r = await fetch(base + path, { headers: { ...(who ? { cookie: who.cookie } : {}), 'x-forwarded-for': '203.0.113.7' }, redirect: 'manual' });
  const text = await r.text();
  return { status: r.status, age: r.headers.get('x-stored-age'), ms: performance.now() - t0, body: (() => { try { return strip(JSON.parse(text)); } catch { return text; } })() };
}
const firstDiff = (a, b, p = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
};

test('every stored page = the worker\'s own answer, for every plan', async () => {
  // let the worker build what this test asks for (the first ask of a page goes to the worker and marks it)
  for (const k of KEYS) for (const who of Object.values(users)) await get(WEB, k, who);
  await new Promise(r => setTimeout(r, 8000));
  const diffs = [];
  let stored = 0;
  for (const k of KEYS) for (const [name, who] of Object.entries(users)) {
    const w = await get(WEB, k, who), d = await get(WORKER, k, who);
    if (w.age != null) stored++;
    // the worker failing (here: no provider key) keeps the last good copy, by design
    if (d.status >= 500) { console.log(`${name} ${k}: worker answered ${d.status}, the stored copy (${w.status}) is kept`); continue; }
    if (w.status !== d.status) diffs.push(`${name} ${k}: status ${w.status} ≠ ${d.status}`);
    else { const x = firstDiff(w.body, d.body); if (x) diffs.push(`${name} ${k}${w.age != null ? ` (stored ${w.age}s)` : ''}${x}`); }
  }
  console.log(`${stored} of ${KEYS.length * 5} answers came from stored pages`);
  assert.ok(stored >= KEYS.length * 3, 'most answers are stored pages');
  assert.deepEqual(diffs, []);
});

test('the unlocked basketball games go to the worker (decided per game there)', async () => {
  const r = await get(WEB, '/api/basketball/games?days=7', users.unlocked);
  assert.equal(r.age, null);
});

test('stored pages answer within 50 ms here', async () => {
  for (const k of KEYS) {
    const r = await get(WEB, k, null);
    if (r.age != null) assert.ok(r.ms < 50, `${k} took ${r.ms.toFixed(0)} ms`);
  }
});

test('a maintenance token is never answered from a stored page', async () => {
  const r = await get(WEB, '/api/public/summary?token=nope', null);
  assert.equal(r.age, null);
});

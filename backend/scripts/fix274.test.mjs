// fix274 (29 Oct, admin follow-ups to fix273). (dist build) Run: npm run test:fix274
//  1. Visitors: people, bots and all callers count the same unit (distinct callers) over the same window and the same
//     rows, so people + bots = all for today / 7 / 30 days (29 Oct 13:25: todayBots 17,467 > todayAll 16,392 — the bots
//     counted bot user-agents, "all" left them out). Days are Israel-time days, written and read.
//  2. Web stalls since ready: the last 50 kept in memory (time, length, what ran, the code when profiled), in the
//     /api/perf summary, Admin → Site health "Recent web stalls" and its Copy for Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const FRONT = f => fs.readFileSync(path.join(here, '../../frontend/src', f), 'utf8');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const DAY = 86400000;

function child(dir, code, extraEnv = {}) {
  const env = { ...process.env, DATA_DIR: dir, SL_ROLE: 'worker', THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...extraEnv };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `const D = ${JSON.stringify(DIST)};\n${code}`], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- 1. visitors: people + bots = all ---------- */

// 13:25 Israel time on 29 Oct 2026 (UTC+2 after the clock change on 25 Oct) = 11:25 UTC
const NOW = Date.parse('2026-10-29T11:25:00Z');
const ilDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const dayAgo = i => { const [y, m, d] = ilDay(NOW).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10); };

/** a mixed day (and 30 days around it): people (beacon / signed in), bot user-agents, data-centre, no signs, fake
 * crawlers, a caller with a bot user-agent that also passed the beacon, callers that are people one day and bots another */
function seed(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, vid TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, signed_in INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, country TEXT, human INTEGER NOT NULL DEFAULT 0, bot TEXT, ua_bot INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, vid));
    CREATE TABLE IF NOT EXISTS visit_meta (k TEXT PRIMARY KEY, v TEXT);`);
  const ins = db.prepare(`INSERT OR IGNORE INTO visits (day, vid, hits, signed_in, first_seen, last_seen, country, human, bot, ua_bot) VALUES (?, ?, 1, ?, ?, ?, 'IL', ?, ?, ?)`);
  const rows = [];
  let x = 274;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  db.exec('BEGIN');
  for (let i = 0; i < 35; i++) {
    const day = dayAgo(i);
    for (let k = 0; k < 400; k++) {
      // a quarter come back on other days, as a person one day and a bot another
      const vid = rnd() < 0.25 ? `r${Math.floor(rnd() * 200)}` : `v${i}-${k}`;
      const r = rnd();
      // [signed_in, human, bot, ua_bot]
      const kind = r < 0.05 ? [1, 1, null, 0] // signed in
        : r < 0.15 ? [0, 1, null, 0] // the beacon
        : r < 0.25 ? [0, 0, 'ua', 1] // bot user-agent
        : r < 0.27 ? [0, 1, null, 1] // a bot user-agent from the same address as a person
        : r < 0.35 ? [0, 0, 'datacentre', 0]
        : r < 0.37 ? [0, 0, 'fake-crawler', 1]
        : [0, 0, null, 0]; // no signs
      ins.run(day, vid, kind[0], `${day}T10:00:00Z`, `${day}T10:05:00Z`, kind[1], kind[2], kind[3]);
      rows.push({ day, vid, person: kind[0] || kind[1] ? 1 : 0, uaBot: kind[3] });
    }
  }
  db.exec('COMMIT');
  db.close();
  // INSERT OR IGNORE keeps the first row of a (day, vid): the same here
  const seen = new Set();
  return rows.filter(r => { const k = `${r.day}|${r.vid}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** the expected numbers, by hand: distinct callers of the window; a person when any of its rows is one */
function expected(rows, days) {
  const from = dayAgo(days - 1);
  const by = new Map();
  for (const r of rows) if (r.day >= from) by.set(r.vid, Math.max(by.get(r.vid) ?? 0, r.person));
  const people = [...by.values()].filter(Boolean).length;
  return { all: by.size, people, bots: by.size - people };
}

test('visitors: people + bots = all for today / 7 / 30 days, bots ≤ all, the same callers (Israel-time days)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix274-v-'));
  const rows = seed(path.join(dir, 'bet-to-beat.sqlite'));
  const s = child(dir, `const { visitorDbSummary } = require(D + '/services/visitorSummary.js'); console.log(JSON.stringify(visitorDbSummary(${NOW})));`);
  const win = { 1: ['today', 'todayBots', 'todayAll'], 7: ['last7', 'last7Bots', 'last7All'], 30: ['last30', 'last30Bots', 'last30All'] };
  for (const [days, [p, b, a]] of Object.entries(win)) {
    const e = expected(rows, Number(days));
    assert.ok(s[b] <= s[a], `${days} d: bots ${s[b]} ≤ all ${s[a]}`);
    assert.equal(s[p] + s[b], s[a], `${days} d: people ${s[p]} + bots ${s[b]} = all ${s[a]}`);
    assert.deepEqual({ all: s[a], people: s[p], bots: s[b] }, e, `${days} d: the callers counted by hand`);
    assert.ok(e.bots > 0 && e.people > 0, 'a mixed window');
  }
  // the reasons of today add up to today's bots; each day of the chart: people + bots = all callers
  assert.equal(s.botReasons.reduce((n, r) => n + r.n, 0), s.todayBots, 'the reasons add up');
  for (const d of s.daily) assert.equal(d.visitors + d.bots, d.allCallers, d.day);
  // the windows start on Israel-time days: 13:25 Israel time on 29 Oct → today = 29 Oct, 7 days from 23 Oct
  assert.deepEqual(s.windowFrom, { today: '2026-10-29', last7: '2026-10-23', last30: '2026-09-30' });
  assert.equal(s.dayZone, 'Asia/Jerusalem');
  assert.equal(s.daily.at(-1).day, '2026-10-29');

  // the old numbers on the same rows: bots counted the bot user-agents, "all" left them out (the 29 Oct report)
  const db = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'));
  const oldBots = db.prepare(`SELECT COUNT(DISTINCT vid) n FROM visits WHERE day >= ? AND NOT (human = 1 OR signed_in = 1)`).get('2026-10-29').n;
  const oldAll = db.prepare(`SELECT COUNT(DISTINCT vid) n FROM visits WHERE day >= ? AND ua_bot = 0`).get('2026-10-29').n;
  const oldPeople = db.prepare(`SELECT COUNT(DISTINCT vid) n FROM visits WHERE day >= ? AND (human = 1 OR signed_in = 1)`).get('2026-10-29').n;
  db.close();
  assert.notEqual(oldPeople + oldBots, oldAll, 'the old counts did not add up on this day');
});

test('visitors: Israel-time days around midnight and the clock change', () => {
  const s = child(fs.mkdtempSync(path.join(os.tmpdir(), 'fix274-d-')), `const v = require(D + '/services/visitorSummary.js');
    const at = t => Date.parse(t);
    console.log(JSON.stringify({
      lateUtc: v.visitDay(at('2026-10-29T22:30:00Z')), earlyUtc: v.visitDay(at('2026-10-29T21:59:00Z')),
      summer: v.visitDay(at('2026-07-01T21:30:00Z')),
      w7: v.since(7, at('2026-10-29T22:30:00Z')), w30: v.since(30, at('2026-10-26T00:30:00Z')), w1: v.since(1, at('2026-10-25T23:30:00Z'))
    }));`);
  assert.equal(s.lateUtc, '2026-10-30', '00:30 Israel time is the next day');
  assert.equal(s.earlyUtc, '2026-10-29', '23:59 Israel time');
  assert.equal(s.summer, '2026-07-02', 'summer time (UTC+3): 00:30 the next day');
  assert.equal(s.w7, '2026-10-24');
  assert.equal(s.w30, '2026-09-27', 'calendar days across the 25 Oct clock change');
  assert.equal(s.w1, '2026-10-26');
});

test('visitors: the rows are written on Israel-time days, the admin tile reads the same day (src)', () => {
  const v = SRC('src/services/visitors.ts');
  assert.match(v, /const day = visitDay\(now\)/, 'trackVisit');
  assert.match(v, /const day = visitDay\(\);/, 'the beacon');
  assert.doesNotMatch(v, /toISOString\(\)\.slice\(0, 10\);\n\s+const k = /, 'no UTC day for the rows');
  assert.match(SRC('src/services/adminSummary.ts'), /visitDay\(now\)/, 'Visitors today tile');
  const card = FRONT('components/VisitorsCard.tsx');
  assert.match(card, /ilDayAgo/, 'the chart days are Israel-time days');
});

/* ---------- 2. web stalls since ready ---------- */

test('web stalls since ready: kept with time, length, what ran; start-up ones left out; in the /api/perf summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix274-s-'));
  const s = child(dir, `
    const perf = require(D + '/services/perf.js');
    const spin = ms => { const t = Date.now(); while (Date.now() - t < ms) {} };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      await wait(300);
      spin(700); // a start-up block: not in the list
      await wait(300);
      perf.markStartupDone();
      await wait(300);
      const done = perf.track('http GET /api/test-route');
      spin(800);
      done();
      await wait(300);
      perf.setJob('a web job');
      spin(400);
      perf.setJob(null);
      await wait(1500);
      const sum = perf.perfSummary();
      console.log(JSON.stringify({ list: perf.recentWebStalls(), since: perf.stallsSinceReady(), sum: { n: sum.readyStalls.length, since: sum.stallsSinceReady, slow: sum.slowSinceReady } }));
      process.exit(0);
    })();`, { SL_ROLE: 'web' });
  assert.ok(s.list.length >= 2, JSON.stringify(s.list));
  assert.ok(s.list.every(x => typeof x.at === 'string' && x.ms > 300 && 'running' in x && 'code' in x), 'time, length, what ran, code');
  const route = s.list.find(x => /http GET \/api\/test-route/.test(x.running || ''));
  assert.ok(route && route.ms >= 500 && route.counted, `the route is named: ${JSON.stringify(s.list)}`);
  assert.ok(s.list.some(x => /a web job/.test(x.running || '') && !x.counted), 'a 300–500 ms stall: kept, not counted');
  assert.ok(!s.list.some(x => x.ms >= 650 && !/test-route/.test(x.running || '')), 'the start-up block is not listed');
  assert.ok(Date.parse(s.list[0].at) >= Date.parse(s.list.at(-1).at), 'newest first');
  assert.equal(s.list.filter(x => x.counted).length, s.since, 'the counted ones = /health stallsSinceReady');
  assert.equal(s.sum.n, s.list.length);
  assert.equal(s.sum.since, s.since);
});

test('web stalls: at most 50 kept, shown on Site health and in its Copy for Claude', async () => {
  const perf = SRC('src/services/perf.ts');
  assert.match(perf, /if \(startupDone\) \{ readyStalls\.push\(stall\); if \(readyStalls\.length > 50\) readyStalls\.shift\(\); \}/, 'a ring of 50');
  assert.match(SRC('src/app.ts'), /body\.web\.readyStalls = body\.web\.readyStalls\.slice\(0, 20\)/, 'the summary stays under its size cap');
  const parts = FRONT('components/admin/AdminParts.tsx');
  assert.match(parts, /Recent web stalls/);
  assert.match(FRONT('lib/forClaude.ts'), /'readyStalls'/, 'Copy for Claude asks for them');
  const { perfSection } = await import(DIST + '/utils/forClaude.js');
  const sec = perfSection({ web: { stallsLastHour: 2, worstLastHour: 900, stallsSinceReady: 1, slowSinceReady: 3,
    readyStalls: [{ at: '2026-10-29T11:20:00Z', ms: 900, running: 'http GET /api/test-route', counted: true, code: ['fn a.js:1 600 ms'] }, { at: '2026-10-29T11:19:00Z', ms: 350, running: null, counted: false, code: null }] }, worker: {} });
  const text = sec.lines.join('\n');
  assert.match(text, /Website since ready: 1 stall\(s\) over 500 ms, 3 request\(s\) over 500 ms/);
  assert.match(text, /Recent web stalls \(since ready, newest first\):/);
  assert.match(text, /900 ms · http GET \/api\/test-route · code: fn a\.js:1 600 ms/);
  assert.match(text, /350 ms \(under 500 ms\) · nothing named/);
});

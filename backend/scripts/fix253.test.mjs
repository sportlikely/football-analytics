// fix253: Needs you → done automatically (Yarin, 27 Oct: "why do I need to approve everything? I want you to do it all").
// The injury-news parser on the five Eurohoops items of 27 Oct (Milutinov, Nick Smith, Reuvers, Dozier, Lundberg), the
// trusted / unclear rule, the void timers (basketball results 72 h, football 7 days, an undone void is held), the
// "Done for you" log with Undo, the 07:00 summary (3 lines per kind) and the data-health check. (dist build)
// Run: npm run test:fix253
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix253-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; // email off: nothing leaves the test
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const kp = require('../dist/utils/keyPlayers.js');
const { decide, AUTO_VOID_AFTER_MS } = require('../dist/utils/voidRules.js');
const DAY = 86400000, H = 3600000;
const PUB = Date.parse('2026-10-27T09:00:00Z');

/* ---------- the parser: the five stories of 27 Oct ---------- */

const EUROHOOPS = { source: 'Eurohoops', link: 'https://www.eurohoops.net/en/euroleague/1/story/' };
const STORIES = {
  Milutinov: 'Olympiacos center Nikola Milutinov will be out for two to three weeks with an ankle sprain.',
  'Nick Smith': 'Real Madrid guard Nick Smith Jr. could miss the next games with a hamstring problem.',
  Reuvers: 'Nate Reuvers is doubtful for Friday’s game with a calf strain.',
  Dozier: 'PJ Dozier is out for 2-3 weeks with a back problem, Anadolu Efes confirmed.',
  Lundberg: 'Iffe Lundberg will miss the rest of the season after knee surgery.'
};

test('fix253: "two to three weeks" → out 21 days (trusted source)', () => {
  const inj = kp.parseInjury(STORIES.Milutinov);
  assert.equal(inj.status, 'out'); assert.equal(inj.days, 21);
  const d = kp.newsDecision({ inj, trusted: kp.trustedSource(EUROHOOPS.source, EUROHOOPS.link), teams: 1, published: PUB });
  assert.equal(d.status, 'out');
  assert.equal(new Date(d.until).toISOString().slice(0, 10), '2026-11-17');
});
test('fix253: "2-3 weeks" (Dozier) → out 21 days', () => {
  const inj = kp.parseInjury(STORIES.Dozier);
  assert.equal(inj.status, 'out'); assert.equal(inj.days, 21);
  assert.equal(kp.newsDecision({ inj, trusted: true, teams: 1, published: PUB }).days, 21);
});
test('fix253: rumour words ("could", Nick Smith Jr.) → doubtful (half weight) for 3 days', () => {
  const inj = kp.parseInjury(STORIES['Nick Smith']);
  assert.ok(inj, 'still an injury item');
  assert.equal(inj.status, 'doubtful'); assert.ok(inj.unclear);
  const d = kp.newsDecision({ inj, trusted: true, teams: 1, published: PUB });
  assert.equal(d.status, 'doubtful'); assert.equal(d.until, PUB + 3 * DAY); assert.match(d.why, /not sure/);
});
test('fix253: "doubtful" (Reuvers) → doubtful for 3 days', () => {
  const inj = kp.parseInjury(STORIES.Reuvers);
  assert.equal(inj.status, 'doubtful'); assert.equal(inj.days, 3);
  assert.equal(kp.newsDecision({ inj, trusted: true, teams: 1, published: PUB }).status, 'doubtful');
});
test('fix253: "the rest of the season" (Lundberg) → out until the season ends (30 June 2027)', () => {
  const inj = kp.parseInjury(STORIES.Lundberg);
  assert.equal(inj.status, 'out'); assert.ok(inj.season);
  const d = kp.newsDecision({ inj, trusted: true, teams: 1, published: PUB });
  assert.equal(new Date(d.until).toISOString().slice(0, 10), '2027-06-30');
  assert.equal(new Date(kp.seasonEnd(Date.parse('2027-03-01'))).toISOString().slice(0, 10), '2027-06-30');
});
test('fix253: no time in the story → 7 days', () => {
  const inj = kp.parseInjury('Mike Smith suffered a knee injury and is out.');
  assert.equal(inj.status, 'out'); assert.equal(inj.days, 7);
});
test('fix253: trusted list — Eurohoops / ESPN / Sportando / BasketNews / league and club sites yes, an unknown blog no', () => {
  for (const [s, l] of [['Eurohoops', 'https://x.y/'], ['ESPN', 'https://x.y/'], ['Sportando', 'https://x.y/'], [null, 'https://basketnews.com/news-1.html'],
    [null, 'https://www.euroleaguebasketball.net/x'], [null, 'https://www.legabasket.it/x'], [null, 'https://www.basketballnews.com/x']]) assert.ok(kp.trustedSource(s, l), `${s} ${l}`);
  assert.ok(kp.trustedSource(null, 'https://www.olympiacosbc.gr/news/1', ['Olympiacos']), 'the club’s own site');
  assert.equal(kp.trustedSource('Hoops Gossip', 'https://hoopsgossip.example/x'), false);
});
test('fix253: unclear → doubtful 3 days: untrusted source, or the name fits players of two teams', () => {
  const inj = kp.parseInjury(STORIES.Dozier);
  const a = kp.newsDecision({ inj, trusted: false, teams: 1, published: PUB });
  assert.equal(a.status, 'doubtful'); assert.match(a.why, /trusted list/);
  const b = kp.newsDecision({ inj, trusted: true, teams: 2, published: PUB });
  assert.equal(b.status, 'doubtful'); assert.match(b.why, /two teams/);
});
test('fix253: a story that says he is back is still not an item', () => {
  assert.equal(kp.parseInjury('Nikola Milutinov returns from his ankle injury tonight.'), null);
});

/* ---------- the waiting items decided on deploy (database) ---------- */

test('fix253: the five waiting items are applied by the rule, written to Done for you, and Undo dismisses one', () => {
  require('../dist/services/basketball.js');
  const keyPlayers = require('../dist/services/keyPlayers.js');
  const done = require('../dist/services/doneForYou.js');
  const now = PUB + 2 * H;
  const ins = db.prepare(`INSERT INTO bb_news_injuries (player_id, team_id, code, name, status, injury, days, sentence, link, source, published, until, at) VALUES (?, ?, 'EL', ?, 'out', NULL, 7, ?, ?, 'Eurohoops', ?, ?, ?)`);
  let pid = 1;
  for (const [name, s] of Object.entries(STORIES)) ins.run(pid, 500 + pid, name, s, `https://www.eurohoops.net/en/${pid}/`, new Date(PUB).toISOString(), new Date(PUB + 7 * DAY).toISOString(), new Date(PUB).toISOString()), pid++;
  // the data-health check fails while something waits over 24 h
  assert.equal(done.doneForYouHealth(PUB + 25 * H).level, 'fail');
  const lines = keyPlayers.decidePendingNews(now);
  assert.equal(lines.length, 5, lines.join(' | '));
  const by = Object.fromEntries(db.prepare(`SELECT name, status, until, reviewed, state FROM bb_news_injuries`).all().map(r => [r.name, r]));
  assert.equal(by.Milutinov.status, 'out'); assert.equal(by.Milutinov.until.slice(0, 10), '2026-11-17');
  assert.equal(by.Dozier.status, 'out'); assert.equal(by['Nick Smith'].status, 'doubtful'); assert.equal(by.Reuvers.status, 'doubtful');
  assert.equal(by.Lundberg.until.slice(0, 10), '2027-06-30');
  assert.ok(Object.values(by).every(r => r.reviewed === 1 && r.state === 'active'));
  assert.equal(keyPlayers.NEWS_KEEP.doubtful, 0.5, 'doubtful = half weight');
  const list = done.doneList(7, now);
  assert.equal(list.filter(x => x.kind === 'injury-news').length, 5);
  assert.ok(list.every(x => x.canUndo && x.link));
  assert.equal(done.doneForYouHealth(now).level, 'ok');
  const milu = list.find(x => /Milutinov/.test(x.title));
  done.undoDone(milu.id, 'admin@example.com', now + H);
  assert.equal(db.prepare(`SELECT state FROM bb_news_injuries WHERE name = 'Milutinov'`).get().state, 'dismissed');
  assert.throws(() => done.undoDone(list[1].id, 'admin', now + 25 * H), /24 hours/);
  // nothing in Needs you
  const { adminSummary } = require('../dist/services/adminSummary.js');
  const s = adminSummary(now);
  assert.equal(s.needsYou, 0); assert.equal(s.injuriesToReview, 0);
});

/* ---------- void timers ---------- */

test('fix253: football — no final at 6 days is watched, at 7 days void by itself; an undone void (hold) is never voided again', () => {
  const KO = '2026-10-20T15:00:00Z', at = ms => Date.parse(KO) + ms;
  assert.equal(AUTO_VOID_AFTER_MS, 7 * DAY);
  assert.equal(decide(null, { kickoff: KO, attempts: 5, lastDay: null, now: at(6 * DAY) }).action, 'review');
  const v = decide(null, { kickoff: KO, attempts: 6, lastDay: null, now: at(7 * DAY + H) });
  assert.equal(v.action, 'void'); assert.match(v.reason, /no final from either provider 7 days/);
  assert.equal(decide({ kind: 'open', raw: 'NS', date: KO, via: 'id' }, { kickoff: KO, attempts: 6, lastDay: null, now: at(8 * DAY) }).action, 'void');
  assert.equal(decide(null, { kickoff: KO, attempts: 6, lastDay: null, now: at(9 * DAY), hold: true }).action, 'review');
  // a final still settles it, whenever it comes
  assert.equal(decide({ kind: 'final', home: 1, away: 0, raw: 'FT', via: 'twin' }, { kickoff: KO, attempts: 6, lastDay: null, now: at(9 * DAY) }).action, 'settle');
});

test('fix253: basketball — an unsure result is out of the record, void at 72 h (Done for you), Undo puts it back', () => {
  const bb = require('../dist/services/bbResults.js');
  const done = require('../dist/services/doneForYou.js');
  const info = db.prepare('PRAGMA table_info(bb_games)').all();
  const cols = new Set(info.map(c => c.name));
  const filler = Object.fromEntries(info.filter(c => c.notnull && c.dflt_value == null && !c.pk).map(c => [c.name, /TEXT/i.test(c.type) ? 'x' : 1]));
  const now = Date.now();
  for (const [id, foundAgo] of [[71, 71 * H], [73, 73 * H]]) {
    const row = { ...filler, game_id: id, code: 'LKL', kickoff: new Date(now - foundAgo - H).toISOString(), status: 'FT', home_id: 900 + id, home_name: `Home ${id}`, away_id: 950 + id, away_name: `Away ${id}`, hs: 80, as_: 70 };
    const k = Object.keys(row).filter(c => cols.has(c));
    db.prepare(`INSERT INTO bb_games (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(c => row[c]));
    db.prepare(`INSERT INTO bb_result_check (game_id, issue, detail, found_at) VALUES (?, 'quarters', 'Quarters add up to 78-70, the final score is 80-70.', ?)`).run(id, new Date(now - foundAgo).toISOString());
  }
  assert.equal(bb.voidStaleChecks(now), 1);
  assert.equal(db.prepare('SELECT resolved_at FROM bb_result_check WHERE game_id = 71').get().resolved_at, null, '71 h: still waiting');
  const c73 = db.prepare('SELECT resolved_at, voided, resolution FROM bb_result_check WHERE game_id = 73').get();
  assert.equal(c73.voided, 1); assert.match(c73.resolution, /72 h/);
  assert.ok(bb.openCheck(73), 'voided: still no Right / Wrong badge');
  const held = db.prepare(`SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL OR voided = 1`).all().map(r => r.game_id);
  assert.deepEqual(held.sort(), [71, 73], 'both out of the record');
  const item = done.doneList(7, now).find(x => x.kind === 'result-void' && /Home 73/.test(x.title));
  assert.ok(item?.canUndo);
  assert.match(done.undoDone(item.id, 'admin', now).message, /counts in the record again/);
  assert.equal(db.prepare('SELECT voided FROM bb_result_check WHERE game_id = 73').get().voided, 0);
  assert.equal(bb.openCheck(73), null);
  // the next check run leaves the undone game alone
  assert.equal(bb.voidStaleChecks(now + DAY), 1, 'only 71 is voided a day later');
  assert.equal(db.prepare('SELECT voided FROM bb_result_check WHERE game_id = 73').get().voided, 0);
});

/* ---------- the 07:00 summary: three lines per kind ---------- */

test('fix253: the morning email lists three lines per kind, then "+N more"', () => {
  const { summaryRows } = require('../dist/services/adminMail.js');
  const items = [...Array(5)].map((_, i) => ({ at: new Date(PUB + i * H).toISOString(), area: 'Injury news applied', title: `P${i}`, detail: null, href: null }))
    .concat([{ at: new Date(PUB).toISOString(), area: 'Site errors closed', title: 'E1', detail: null, href: null }]);
  const rows = summaryRows(items);
  assert.deepEqual(rows.map(r => r.title), ['P0', 'P1', 'P2', '+2 more injury news applied', 'E1']);
});

/* ---------- site errors: groups close themselves after a build that stops them ---------- */

test('fix253: a site-error group with no report since a newer build (6 h of it) closes itself; the open ones are the list for Claude', () => {
  const ce = require('../dist/services/clientErrors.js');
  ce.reportClientError({ message: 'Cannot read properties of null (reading "split")', page: '/basketball', kind: 'page', version: 'index-OLD1', stack: 'at x (a.js:1:1)' });
  const now = Date.now();
  ce.noteBuild('index-NEW2', now + 1000);
  ce.reportClientError({ message: 'Still broken', page: '/football', kind: 'page', version: 'index-NEW2', stack: 'at y (b.js:1:1)' });
  db.prepare(`UPDATE client_errors SET last_at = ? WHERE message = 'Still broken'`).run(new Date(now + 2000).toISOString());
  assert.equal(ce.closeStoppedErrors(now + 2 * H), 0, 'not before 6 h of the new build');
  assert.equal(ce.closeStoppedErrors(now + 7 * H), 1);
  const f = ce.errorsForClaude(now + 7 * H);
  assert.equal(f.open, 1); assert.equal(f.top[0].message, 'Still broken'); assert.deepEqual(f.top[0].builds, ['index-NEW2']);
});

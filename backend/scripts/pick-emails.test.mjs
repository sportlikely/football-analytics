// fix216: daily picks email + weekly digest on a scratch database (dist build): the send hour in the person's own time
// zone (DST too), free vs Pro rows (a hidden pick is never in the email), no empty email, the unsubscribe token, the
// words in all 7 languages, no forbidden words, the send run (retries, one email a day, List-Unsubscribe), webhooks
// and the record check. Run: npm run test:fix216
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix216-mail-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.BASKETBALL_PUBLIC = '1';
process.env.RESEND_API_KEY = 're_test_not_real';
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('test-secret-for-fix216').toString('base64')}`;
const require = createRequire(import.meta.url);
// every email goes to this list instead of Resend
const outbox = [];
let failNext = [];
const axios = require('axios');
axios.post = async (url, body) => {
  if (failNext.length) { const st = failNext.shift(); const e = new Error(`HTTP ${st}`); e.response = { status: st, headers: {}, data: {} }; throw e; }
  outbox.push({ url, body });
  return { data: { id: `msg-${outbox.length}` } };
};
const { db } = require('../dist/db/index.js');
require('../dist/services/auth.js');
require('../dist/services/billing.js');
require('../dist/services/basketball.js');
require('../dist/services/bbModel.js');
const { addFavorites } = require('../dist/services/favorites.js');
const M = require('../dist/services/pickEmails.js');
const auth = require('../dist/services/auth.js');

const DAY = 86400000, H = 3600000;
const now = Date.now();
const iso = t => new Date(t).toISOString();
const soon = now + 3 * H;

let uid = 0;
const user = (plan, prefs = {}) => {
  const id = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES (?, 'x', ?, ?, 1)`).run(`u${++uid}@example.com`, plan, iso(now - 30 * DAY)).lastInsertRowid);
  M.saveEmailPrefs(id, { daily: true, weekly: true, tz: 'UTC', sendHour: new Date(now).getUTCHours(), ...prefs }, 'account');
  // the switch was turned on yesterday (the health check only expects people who were on before today's send time)
  db.prepare(`UPDATE email_prefs SET daily_at = ?, weekly_at = ? WHERE user_id = ?`).run(iso(now - DAY), iso(now - DAY), id);
  return id;
};
const fb = (id, t, home, away, p, ids = [100 + id, 200 + id], result = null) => {
  db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
    VALUES (?, 'grid-v3', 'PL', 'Premier League', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(id, iso(t), ids[0], home, ids[1], away, p[0], p[1], p[2], result ? 1 : 0, iso(t - DAY), iso(t - DAY));
  if (result) db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`).run(id, result.h, result.a, result.o, iso(t + 2 * H));
};
// six strong picks (double chance 85%+) in the next 24 h, one ordinary game of a favourite club, one game in 3 days
const STRONG = [[1, 'Arsenal', 'Everton', [72, 20, 8]], [2, 'Chelsea', 'Fulham', [70, 20, 10]], [3, 'Liverpool', 'Brentford', [68, 21, 11]],
  [4, 'Manchester City', 'Burnley', [75, 17, 8]], [5, 'Tottenham Hotspur', 'Luton', [66, 22, 12]], [6, 'Newcastle', 'Sheffield United', [64, 23, 13]]];
for (const [id, h, a, p] of STRONG) fb(id, soon + id * 60000, h, a, p);
fb(7, soon + 2 * H, 'Aston Villa', 'Wolves', [45, 28, 27], [57, 76]); // favourite club 57, double chance 73%
fb(8, now + 3 * DAY, 'Real Madrid', 'Barcelona', [44, 26, 30]);
// yesterday: two settled games, one right one wrong
const yd = new Date(now - DAY); yd.setUTCHours(15, 0, 0, 0);
fb(20, yd.getTime(), 'Leeds', 'Hull', [60, 25, 15], [300, 301], { h: 2, a: 0, o: 'H' });
fb(21, yd.getTime() + H, 'Stoke', 'Derby', [55, 25, 20], [302, 303], { h: 0, a: 1, o: 'A' });

const free = user('free'), pro = user('pro'), bbOnly = user('free', { sports: ['basketball'] }), off = user('free', { daily: false, weekly: false });
addFavorites(free, [{ kind: 'team', ref: 'aston-villa', name: 'Aston Villa', ids: [57] }]);
db.prepare(`INSERT INTO match_unlocks (user_id, match_id, at) VALUES (?, 6, ?)`).run(free, iso(now));
const person = id => M.personOf(auth.userById(id));
const ctx = M.buildCtx(now);

test('time zones: due at the person\'s own send hour, DST-safe, weekly on Monday', () => {
  const t0 = Date.parse('2026-10-26T23:30:00Z'); // Tuesday 08:30 in Tokyo
  assert.deepEqual(M.dueKinds({ daily: true, weekly: true, sendHour: 8, tz: 'Asia/Tokyo' }, t0), { day: '2026-10-27', kinds: ['daily'] });
  assert.deepEqual(M.dueKinds({ daily: true, weekly: true, sendHour: 8, tz: 'Asia/Tokyo' }, t0 - 2 * H).kinds, [], '06:30 local: not yet');
  assert.deepEqual(M.dueKinds({ daily: true, weekly: true, sendHour: 8, tz: 'Asia/Tokyo' }, t0 + 3 * H).kinds, [], 'more than 3 h late: wait for tomorrow');
  // Monday 26 Oct 2026, 08:10 in New York (UTC−4) = 12:10 UTC: daily + weekly
  assert.deepEqual(M.dueKinds({ daily: true, weekly: true, sendHour: 8, tz: 'America/New_York' }, Date.parse('2026-10-26T12:10:00Z')).kinds, ['daily', 'weekly']);
  // Berlin leaves summer time on 25 Oct 2026: 08:00 that day is 07:00 UTC, the day before 06:00 UTC
  assert.equal(new Date(M.zonedTime('Europe/Berlin', '2026-10-25', 8)).toISOString(), '2026-10-25T07:00:00.000Z');
  assert.equal(new Date(M.zonedTime('Europe/Berlin', '2026-10-24', 8)).toISOString(), '2026-10-24T06:00:00.000Z');
  assert.equal(M.localTime('Asia/Kolkata', Date.parse('2026-10-26T02:45:00Z')).hour, 8);
  assert.ok(!M.validTz('Mars/Olympus') && M.validTz('Europe/Lisbon'));
});

test('daily rows: up to 5 strong picks first, then favourite teams; free sees 3 (+ unlocked), Pro everything', () => {
  const d = M.dailyFor(person(free), ctx);
  assert.equal(d.kind, 'daily');
  assert.equal(d.strongN, 5);
  assert.deepEqual(d.rows.map(r => r.id), [1, 4, 2, 3, 5, 7], 'strongest first (a tie: earlier kick-off first), Newcastle (6th strong) left out, the favourite game last');
  assert.ok(d.rows.at(-1).fav);
  assert.equal(d.rows.filter(r => r.shown).length, 3);
  const p = M.dailyFor(person(pro), ctx);
  assert.ok(p.rows.every(r => r.shown));
  // a game the free user unlocked is shown even outside the top 3
  const unlocked = M.lockRows(person(free), M.candidates(now, now + DAY).filter(c => c.id === 6 || c.id === 1));
  assert.ok(unlocked.every(r => r.shown));
  // the email never carries a hidden pick
  const html = M.renderDaily(person(free), d, now).html;
  const hidden = d.rows.filter(r => !r.shown);
  assert.ok(hidden.length >= 1);
  for (const r of hidden) {
    const block = html.split(r.home)[1].split('</td></tr>')[0];
    assert.match(block, /Unlock with Pro/);
    assert.doesNotMatch(block, new RegExp(`${r.pct.toFixed(0)}%`));
  }
  assert.match(html, /Yesterday: 1 of 2 picks right/);
  assert.match(html, /utm_source=email&amp;utm_medium=email&amp;utm_campaign=daily_picks/);
});

test('no empty email: nothing worth sending = skipped with a reason', () => {
  const r = M.composeFor(person(bbOnly), 'daily', ctx);
  assert.ok('skip' in r);
  assert.match(r.skip, /no strong pick and no favourite/);
});

test('unsubscribe token: signed per user, one click turns both emails off', () => {
  const url = new URL(M.picksUnsubUrl(free));
  const u = url.searchParams.get('u'), t = url.searchParams.get('t');
  assert.equal(M.checkUnsub(u, t), free);
  assert.equal(M.checkUnsub(String(pro), t), null, 'another user id with this token');
  assert.equal(M.checkUnsub(u, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(M.checkUnsub(u, ''), null);
  const tmp = user('free');
  const tu = new URL(M.picksUnsubUrl(tmp));
  assert.ok(M.unsubscribePicks(tu.searchParams.get('u'), tu.searchParams.get('t'), 'one-click'));
  const p = M.emailPrefs(tmp);
  assert.ok(!p.daily && !p.weekly);
  const log = db.prepare(`SELECT kind, on_, source FROM email_consent_log WHERE user_id = ? ORDER BY id`).all(tmp);
  assert.deepEqual(log.slice(-2).map(r => [r.kind, r.on_, r.source]), [['daily', 0, 'one-click'], ['weekly', 0, 'one-click']]);
  assert.equal(M.dueList(now).filter(d => d.user.id === tmp).length, 0, 'never sent again');
});

test('consent: off by default, time and source stored', () => {
  const id = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES ('new@example.com', 'x', 'free', ?, 1)`).run(iso(now)).lastInsertRowid);
  M.initEmailPrefs(id, { optIn: false, tz: 'Europe/Rome', lang: 'it' });
  let p = M.emailPrefs(id);
  assert.ok(!p.daily && !p.weekly);
  assert.equal(p.tz, 'Europe/Rome'); assert.equal(p.lang, 'it');
  const id2 = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES ('new2@example.com', 'x', 'free', ?, 1)`).run(iso(now)).lastInsertRowid);
  M.initEmailPrefs(id2, { optIn: true, tz: 'Nowhere/Bad', lang: 'xx' });
  p = M.emailPrefs(id2);
  assert.ok(p.daily && p.weekly && p.dailySource === 'signup' && p.dailyAt);
  assert.equal(p.tz, 'UTC'); assert.equal(p.lang, 'en');
  assert.throws(() => M.saveEmailPrefs(id2, { sendHour: 24 }, 'account'), /send time/);
  assert.throws(() => M.saveEmailPrefs(id2, { sports: ['chess'] }, 'account'), /at least one sport/);
});

test('words: every key in all 7 languages, placeholders kept', () => {
  const src = fs.readFileSync(new URL('../src/services/pickEmails.ts', import.meta.url), 'utf8');
  const keys = new Set([...Object.values(M.SPORT_NAME), M.FOOTER_LINE]);
  for (const m of src.matchAll(/\btx\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) keys.add(m[1] ?? m[2]);
  assert.ok(keys.size > 30);
  const holes = s => (s.match(/\{\d\}/g) || []).sort().join();
  for (const lang of M.EMAIL_LANGS.filter(l => l !== 'en')) {
    const pack = M.EMAIL_PACKS[lang];
    for (const k of keys) {
      assert.ok(typeof pack[k] === 'string' && pack[k].trim(), `${lang}: missing "${k}"`);
      assert.equal(holes(pack[k]), holes(k), `${lang}: placeholders of "${k}"`);
    }
    for (const k of Object.keys(pack)) assert.ok(keys.has(k), `${lang}: unused key "${k}"`);
  }
});

test('no forbidden words (bet / odds / bookmaker / tip) in any email, any language', () => {
  const bad = /\b(bets?|odds|bookmakers?|tips?|tipp|tipps|wagers?)\b/i;
  for (const lang of M.EMAIL_LANGS) {
    const p = M.personOf(auth.userById(pro), { ...M.emailPrefs(pro), lang, sports: ['football', 'basketball', 'american-football', 'tennis'] });
    for (const kind of ['daily', 'weekly']) {
      const b = M.composeFor(p, kind, ctx);
      assert.ok(!('skip' in b), `${lang} ${kind}`);
      for (const part of [b.subject, b.text, b.html.replace(/<[^>]+>/g, ' ')]) assert.doesNotMatch(part, bad, `${lang} ${kind}`);
      assert.match(b.text, /\+?18\+?/);
      assert.doesNotMatch(b.text, /#emails\?/, 'UTM tags go before the #');
      assert.match(b.html, /begambleaware\.org/);
      assert.match(b.html, /<html lang="/);
    }
  }
});

test('weekly digest: last week per sport from the record, big games, favourites', () => {
  const w = M.weeklyFor(person(free), ctx);
  assert.equal(w.kind, 'weekly');
  assert.ok(w.big.length >= 1 && w.big.length <= 5);
  assert.equal(w.big[0].id, 8, 'Real Madrid – Barcelona is the biggest game of the week');
  const html = M.renderWeekly(person(free), w, now).html;
  assert.match(html, /This week's big games/);
  assert.match(html, /Football/);
});

test('send run: one email per person and day, List-Unsubscribe, retries on 429, skips logged', async () => {
  outbox.length = 0;
  failNext = [429];
  const r = await M.picksEmailTick(now, { wait: async () => {} });
  const to = outbox.map(o => o.body.to[0]);
  assert.ok(to.includes(`u${free}@example.com`) && to.includes(`u${pro}@example.com`));
  assert.ok(!to.includes(`u${off}@example.com`), 'switched off');
  assert.ok(!to.includes(`u${bbOnly}@example.com`), 'nothing to send');
  const sent = outbox.find(o => o.body.to[0] === `u${pro}@example.com`).body;
  assert.match(sent.headers['List-Unsubscribe'], /^<https:\/\/sportlikely\.com\/api\/email\/unsubscribe\?u=\d+&t=[\w-]{32}>$/);
  assert.equal(sent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(sent.text && sent.html);
  const skip = db.prepare(`SELECT status, reason FROM email_sends WHERE user_id = ? AND kind = 'daily'`).get(bbOnly);
  assert.equal(skip.status, 'skipped');
  assert.ok(r.sent >= 2 && r.failed === 0);
  const rows = db.prepare(`SELECT * FROM email_sends WHERE user_id = ?`).all(pro);
  assert.ok(rows.every(x => !('html' in x) && !('body' in x)), 'no email body stored');
  const before = outbox.length;
  await M.picksEmailTick(now + 60000, { wait: async () => {} });
  assert.equal(outbox.length, before, 'nothing sent twice the same day');
  const h = M.emailHealth(now + H);
  assert.equal(h.find(c => c.id === 'email-daily').level, 'ok', JSON.stringify(h.find(c => c.id === 'email-daily')));
  assert.equal(h.find(c => c.id === 'email-record').level, 'ok', JSON.stringify(h.find(c => c.id === 'email-record')));
});

test('webhooks: svix signature checked; a bounce stops the address, opens are counted', () => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const body = JSON.stringify({ type: 'email.bounced', created_at: iso(now), data: { email_id: 'msg-1', to: [`u${pro}@example.com`], bounce: { type: 'Permanent' } } });
  const id = 'msg_abc', ts = String(Math.floor(now / 1000));
  const sig = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  assert.ok(M.verifyWebhook(Buffer.from(body), { id, timestamp: ts, signature: `v1,${sig}` }, secret, now));
  assert.ok(!M.verifyWebhook(Buffer.from(body + ' '), { id, timestamp: ts, signature: `v1,${sig}` }, secret, now), 'body changed');
  assert.ok(!M.verifyWebhook(Buffer.from(body), { id, timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, secret, now), 'too old');
  M.handleWebhookEvent(JSON.parse(body));
  assert.ok(db.prepare(`SELECT 1 FROM email_suppressed WHERE email = ?`).get(`u${pro}@example.com`));
  assert.equal(M.dueList(now + DAY).filter(d => d.user.id === pro).length, 0, 'a bounced address gets nothing');
  M.handleWebhookEvent({ type: 'email.opened', created_at: iso(now), data: { email_id: 'msg-2', to: ['x@example.com'] } });
  assert.equal(db.prepare(`SELECT n FROM email_events WHERE type = 'opened'`).get().n, 1);
  const st = M.emailAdminStats();
  assert.ok(st.perDay.length && st.suppressed === 1);
});

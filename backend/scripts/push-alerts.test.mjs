// fix226: web push alerts on a scratch database (dist build): the encryption (a browser could read it) and the VAPID
// signature, the rules per sport (start, goal, quarter end, lead change late, set, final, upset), dedupe (an event once,
// a person once), quiet hours in the person's own time zone (DST too, the final waits until the morning), 1 push a
// minute, free vs Pro content, no forbidden words in 7 languages, gone devices removed, data health, account deletion,
// and the sender only in the worker. Run: npm run test:fix226
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix226-push-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.BASKETBALL_PUBLIC = '1';
process.env.NFL_PUBLIC = '1';
process.env.TENNIS_PUBLIC = '1';
const require = createRequire(import.meta.url);
const W = require('../dist/utils/webPush.js');
const keys = W.generateVapidKeys();
process.env.VAPID_PUBLIC = keys.publicKey;
process.env.VAPID_PRIVATE = keys.privateKey;

const { db } = require('../dist/db/index.js');
const auth = require('../dist/services/auth.js');
require('../dist/services/billing.js');
require('../dist/services/basketball.js');
require('../dist/services/bbModel.js');
require('../dist/services/nfl.js');
require('../dist/services/nflModel.js');
require('../dist/services/userPicks.js');
const { addFavorites } = require('../dist/services/favorites.js');
const { writeLive } = require('../dist/services/liveState.js');
const R = require('../dist/utils/pushRules.js');
const P = require('../dist/services/pushAlerts.js');

const MIN = 60000, H = 3600000, DAY = 86400000;
const iso = t => new Date(t).toISOString();

/* ---------- a fake browser: its own key pair, decrypts what it gets ---------- */
function browser(host = 'fcm.googleapis.com') {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    sub: { endpoint: `https://${host}/fcm/send/${crypto.randomBytes(8).toString('hex')}`, keys: { p256dh: e.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } },
    read: body => JSON.parse(W.decryptPayload(body, e.getPrivateKey(), e.getPublicKey(), authSecret))
  };
}
const inbox = []; // what the push services got: { endpoint, payload, headers }
const devices = new Map(); // endpoint → browser
let answer = () => 201;
const post = async (url, body, headers) => {
  const b = devices.get(url);
  inbox.push({ endpoint: url, payload: b ? b.read(body) : null, headers });
  return { status: answer(url) };
};

let uid = 0;
const user = (plan, prefs = {}) => {
  const id = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES (?, 'x', ?, ?, 1)`).run(`p${++uid}@example.com`, plan, iso(Date.now() - 30 * DAY)).lastInsertRowid);
  const b = browser();
  devices.set(b.sub.endpoint, b);
  P.addPushSub(id, b.sub, 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36');
  P.savePushPrefs(id, { on: true, tz: 'UTC', quietFrom: 0, quietTo: 0, ...prefs }, 'account');
  return id;
};
const sentTo = id => db.prepare(`SELECT s.status, s.kind, e.key, e.game_id FROM push_sends s JOIN push_events e ON e.id = s.event_id WHERE s.user_id = ? ORDER BY s.id`).all(id);
const fb = (id, t, home, away, p, ids) => db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
  VALUES (?, 'grid-v3', 'PL', 'Premier League', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(id, iso(t), ids[0], home, ids[1], away, p[0], p[1], p[2], iso(t - DAY), iso(t - DAY));

/* ---------- 1. crypto ---------- */

test('encryption: a browser can read the body (RFC 8291 aes128gcm), VAPID signature checks out with the public key', () => {
  const b = browser();
  const body = W.encryptPayload(JSON.stringify({ title: 'Goal! A 1–0 B' }), b.sub.keys);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'key id = our public key');
  assert.deepEqual(b.read(body), { title: 'Goal! A 1–0 B' });
  const h = W.vapidAuth(b.sub.endpoint, { ...keys, subject: 'mailto:support@sportlikely.com' });
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'exp within 24 h');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
  assert.ok(W.vapidKeysValid(keys.publicKey, keys.privateKey));
  assert.ok(!W.vapidKeysValid(keys.publicKey, W.generateVapidKeys().privateKey), 'a mixed-up pair is refused');
  assert.ok(P.pushEnabled);
});

test('only real push services are accepted as endpoints (never our own network)', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) assert.ok(W.pushEndpointOk(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost:3002/api/admin', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 42])
    assert.ok(!W.pushEndpointOk(bad), String(bad));
  assert.throws(() => P.addPushSub(1, { endpoint: 'https://169.254.169.254/latest', keys: { p256dh: 'a', auth: 'b' } }, ''), /not supported/);
});

/* ---------- 2. rules ---------- */

const snap = o => ({ sport: 'football', id: 1, rid: 1, state: 'live', start: iso(Date.now() - 30 * MIN), league: 'Premier League', home: 'Arsenal', away: 'Everton', teamIds: [57, 62], path: '/match/1',
  hs: 0, as: 0, period: null, brk: false, minute: 30, late: false, sets: null, lastSet: null, pre: { ph: 60, pd: 25, pa: 15 }, winner: null, lastLead: null, ...o });
const keysOf = list => list.map(e => e.key);

test('rules: start 15 min before, goals, nothing on a first reading, a disallowed goal sends nothing, final once', () => {
  const now = Date.now();
  const pre = snap({ state: 'pre', start: iso(now + 10 * MIN), hs: null, as: null });
  assert.deepEqual(keysOf(R.eventsOf(null, pre, now)), ['start']);
  assert.deepEqual(keysOf(R.eventsOf(null, { ...pre, start: iso(now + 20 * MIN) }, now)), [], '20 min before: not yet');
  assert.deepEqual(keysOf(R.eventsOf(null, snap({ hs: 2, as: 1 }), now)), [], 'first reading mid-game: no old goals');
  assert.deepEqual(keysOf(R.eventsOf(snap({ state: 'pre', hs: null, as: null }), snap({ hs: 1, as: 0, minute: 3 }), now)), ['score:1-0'], 'goal in the first minutes');
  assert.deepEqual(keysOf(R.eventsOf(snap({ hs: 1 }), snap({ hs: 1, as: 1 }), now)), ['score:1-1']);
  assert.deepEqual(keysOf(R.eventsOf(snap({ hs: 2 }), snap({ hs: 1 }), now)), [], 'VAR took it back');
  assert.deepEqual(keysOf(R.eventsOf(snap({ hs: 1 }), snap({ state: 'done', hs: 1, as: 0, winner: 'H' }), now)), ['final']);
  assert.deepEqual(keysOf(R.eventsOf(snap({ state: 'done', winner: 'H' }), snap({ state: 'done', hs: 1, as: 0, winner: 'H' }), now)), [], 'final only once');
});

test('rules: basketball / American football quarter ends and a lead change only in the last 3 minutes; tennis sets', () => {
  const now = Date.now();
  const bb = o => snap({ sport: 'basketball', home: 'Lakers', away: 'Celtics', pre: { ph: 52, pd: 0, pa: 48 }, period: 1, minute: 5, ...o });
  assert.deepEqual(keysOf(R.eventsOf(bb({ period: 1 }), bb({ period: null, brk: true }), now)), ['end:1'], 'Q1 → break');
  assert.deepEqual(keysOf(R.eventsOf(bb({ period: null, brk: true }), bb({ period: 2 }), now)), [], 'break → Q2: nothing more');
  assert.deepEqual(keysOf(R.eventsOf(bb({ period: 2 }), bb({ period: 2, brk: true }), now)), ['end:2'], 'half-time');
  assert.deepEqual(keysOf(R.eventsOf(bb({ period: 4, hs: 100, as: 100 }), bb({ period: 5, hs: 100, as: 100 }), now)), ['end:4'], 'overtime');
  // the lead flips: late = alert, early = nothing
  const even = { ph: 52, pd: 0, pa: 48 }; // no upset in the way
  const flip = (late, minute) => R.eventsOf(R.withLead(bb({ period: 4, hs: 98, as: 97, late, minute, pre: even }), null), bb({ period: 4, hs: 98, as: 100, late, minute, pre: even }), now);
  assert.deepEqual(keysOf(flip(true, 2)), ['lead:98-100']);
  assert.deepEqual(keysOf(flip(false, 8)), []);
  // a tie is not a lead change; taking it back after the tie is
  const tied = R.withLead(bb({ period: 4, hs: 100, as: 100, late: true }), R.withLead(bb({ period: 4, hs: 100, as: 98, late: true }), null));
  assert.equal(tied.lastLead, 'H');
  assert.deepEqual(keysOf(R.eventsOf(tied, bb({ period: 4, hs: 100, as: 102, late: true }), now)), ['lead:100-102']);
  assert.deepEqual(keysOf(R.eventsOf(tied, bb({ period: 4, hs: 102, as: 100, late: true }), now)), [], 'the same side back in front');
  const nfl = o => snap({ sport: 'american-football', home: 'Chiefs', away: 'Bills', pre: { ph: 60, pd: 0, pa: 40 }, period: 3, ...o });
  assert.deepEqual(keysOf(R.eventsOf(nfl({ period: 3 }), nfl({ period: 4 }), now)), ['end:3']);
  const tn = o => snap({ sport: 'tennis', home: 'Sinner', away: 'Alcaraz', pre: { ph: 52, pd: 0, pa: 48 }, sets: [0, 0], ...o });
  const ev = R.eventsOf(tn({ sets: [0, 0] }), tn({ sets: [0, 1], lastSet: [4, 6] }), now);
  assert.deepEqual(keysOf(ev), ['set:0-1']);
  assert.equal(ev[0].side, 'A');
  assert.match(R.noteOf(ev[0], { tx: P.pushWords('en'), lang: 'en', tz: 'UTC', showPick: true }).title, /Alcaraz/);
});

test('rules: upset watch = our outsider (20–45%) ahead late, every sport', () => {
  const now = Date.now();
  const fbUp = R.eventsOf(snap({ hs: 0, as: 0, minute: 70 }), snap({ hs: 0, as: 1, minute: 72, late: true, pre: { ph: 55, pd: 25, pa: 20 } }), now);
  assert.ok(keysOf(fbUp).includes('upset'));
  assert.ok(!keysOf(R.eventsOf(snap({ minute: 30 }), snap({ hs: 0, as: 1, minute: 31, pre: { ph: 55, pd: 25, pa: 20 } }), now)).includes('upset'), 'not late');
  assert.ok(!keysOf(R.eventsOf(snap({ minute: 70 }), snap({ hs: 0, as: 1, minute: 72, late: true, pre: { ph: 48, pd: 10, pa: 42 } }), now)).includes('upset'), 'a coin flip is no upset');
  const bb = o => snap({ sport: 'basketball', pre: { ph: 70, pd: 0, pa: 30 }, period: 4, late: true, ...o });
  assert.ok(keysOf(R.eventsOf(bb({ hs: 90, as: 88 }), bb({ hs: 90, as: 92 }), now)).includes('upset'));
  const tn = o => snap({ sport: 'tennis', pre: { ph: 75, pd: 0, pa: 25 }, ...o });
  assert.ok(keysOf(R.eventsOf(tn({ sets: [0, 0] }), tn({ sets: [0, 1], late: true }), now)).includes('upset'));
});

/* ---------- 3. quiet hours and time zones ---------- */

test('quiet hours in the person\'s own time zone (DST-safe), the final waits until they end', () => {
  const q = { from: 0, to: 7, tz: 'Asia/Tokyo' };
  const t = Date.parse('2026-10-26T17:30:00Z'); // 02:30 in Tokyo
  assert.ok(R.inQuiet(q, t));
  assert.equal(iso(R.quietEnd(q, t)), '2026-10-26T22:00:00.000Z', '07:00 Tokyo');
  assert.ok(!R.inQuiet(q, Date.parse('2026-10-26T23:00:00Z')), '08:00 Tokyo');
  assert.ok(!R.inQuiet({ from: 7, to: 7, tz: 'UTC' }, t), 'from = to: no quiet hours');
  assert.ok(R.inQuiet({ from: 22, to: 7, tz: 'UTC' }, Date.parse('2026-10-26T23:10:00Z')), 'over midnight');
  // Berlin leaves summer time on 25 Oct 2026: 07:00 that morning is 06:00 UTC, the day before 05:00 UTC
  assert.equal(iso(R.quietEnd({ from: 0, to: 7, tz: 'Europe/Berlin' }, Date.parse('2026-10-25T01:30:00Z'))), '2026-10-25T06:00:00.000Z');
  assert.equal(iso(R.quietEnd({ from: 0, to: 7, tz: 'Europe/Berlin' }, Date.parse('2026-10-24T01:30:00Z'))), '2026-10-24T05:00:00.000Z');
  // the kick-off time in the person's own zone
  assert.equal(R.timeIn('en', 'America/New_York', '2026-10-26T19:00:00Z'), '15:00');
  assert.equal(R.timeIn('de', 'Europe/Berlin', '2026-10-26T19:00:00Z'), '20:00');
});

/* ---------- 4. the whole run on the scratch database ---------- */

test('the run: favourites only, every sport, an event once, a person once, 1 a minute, quiet hours, gone devices removed', async () => {
  let now = Date.now();
  const proU = user('pro');
  const freeU = user('free');
  const quietU = user('pro', { tz: 'UTC', quietFrom: new Date(now).getUTCHours(), quietTo: (new Date(now).getUTCHours() + 2) % 24 });
  const offU = user('pro', { on: false });
  const picker = user('free', { myPicks: true });
  for (const id of [proU, freeU, quietU, offU]) addFavorites(id, [{ kind: 'team', ref: 'arsenal', name: 'Arsenal', ids: [57] }, { kind: 'bb-team', ref: '145', name: 'Lakers', ids: [145] }]);
  // football: Arsenal at home in 10 min (a favourite), another game in 10 min nobody follows
  fb(1001, now + 10 * MIN, 'Arsenal', 'Everton', [60, 25, 15], [57, 62]);
  fb(1002, now + 10 * MIN, 'Fulham', 'Burnley', [50, 30, 20], [63, 328]);
  db.prepare(`INSERT INTO user_picks (user_id, sport, game_id, market, pick, kickoff, created_at, updated_at) VALUES (?, 'fb', 1002, 'result', 'H', ?, ?, ?)`).run(picker, iso(now + 10 * MIN), iso(now), iso(now));
  // basketball: Lakers tip-off in 12 min
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (501, 'NBA', 12, '2026-2027', ?, 'NS', 145, 'Lakers', 133, 'Celtics', ?)`).run(iso(now + 12 * MIN), iso(now));
  db.prepare(`INSERT INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (501, 'NBA', ?, 'bb-v4', 0.62, 4, 220, 112, 108, ?)`).run(iso(now + 12 * MIN), iso(now));

  await P.pushAlertsTick(now, post);
  const starts = db.prepare(`SELECT sport, game_id, key FROM push_events ORDER BY id`).all();
  assert.deepEqual(starts.map(e => `${e.sport}:${e.game_id}:${e.key}`).sort(), ['basketball:501:start', 'football:1001:start', 'football:1002:start']);
  // the pro fan got one now (1 a minute), the other start waits; the quiet one got nothing; off got nothing
  assert.equal(sentTo(proU).filter(s => s.status === 'sent').length, 1);
  assert.equal(sentTo(quietU).every(s => s.status === 'quiet'), true, 'quiet hours: not sent');
  assert.equal(sentTo(offU).length, 0, 'switched off');
  assert.deepEqual(sentTo(picker).map(s => s.game_id), [1002], 'a game the person picked (their own pick switch)');
  // Pro sees our pick in the starting alert, Free does not (not unlocked)
  const got = id => inbox.filter(m => devices.get(m.endpoint) && m.endpoint === db.prepare(`SELECT endpoint FROM push_subs WHERE user_id = ?`).get(id)?.endpoint).map(m => m.payload);
  const proStart = got(proU).find(p => p.tag === 'football-1001');
  const freeStart = got(freeU).find(p => p.tag === 'football-1001');
  if (proStart) assert.match(proStart.body, /Our pick: Arsenal or draw · 85%/);
  if (freeStart) { assert.doesNotMatch(freeStart.body, /Our pick|%/); assert.match(freeStart.body, /Unlock the game/); }
  assert.ok(proStart || freeStart);

  // a second tick at the same moment: no new event, nobody gets a second push inside the minute
  const before = inbox.length;
  await P.pushAlertsTick(now + 1000, post);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM push_events`).get().n, 3, 'events stored once');
  assert.equal(inbox.length, before, '1 push a minute per person');
  // a minute later the waiting start goes out
  now += 61 * 1000;
  await P.pushAlertsTick(now, post);
  assert.equal(sentTo(proU).filter(s => s.status === 'sent').length, 2);

  // kick-off: a goal goes out at once; two more inside the minute → one push with the newest score (the older one merged)
  writeLive('football', [{ id: 1001, status: 'IN_PLAY', minute: 1, score: { fullTime: { home: 0, away: 0 } } }]);
  now += 11 * MIN;
  await P.pushAlertsTick(now, post);
  writeLive('football', [{ id: 1001, status: 'IN_PLAY', minute: 12, score: { fullTime: { home: 1, away: 0 } } }]);
  await P.pushAlertsTick(now + 1000, post);
  writeLive('football', [{ id: 1001, status: 'IN_PLAY', minute: 13, score: { fullTime: { home: 2, away: 0 } } }]);
  await P.pushAlertsTick(now + 2000, post);
  writeLive('football', [{ id: 1001, status: 'IN_PLAY', minute: 14, score: { fullTime: { home: 3, away: 0 } } }]);
  await P.pushAlertsTick(now + 3000, post);
  now += 61 * 1000;
  await P.pushAlertsTick(now, post);
  const goals = sentTo(proU).filter(s => s.kind === 'score');
  assert.deepEqual(goals.map(s => `${s.key}:${s.status}`), ['score:1-0:sent', 'score:2-0:merged', 'score:3-0:sent']);
  const goalMsg = got(proU).filter(p => p.title.startsWith('Goal!')).pop();
  assert.equal(goalMsg.title, 'Goal! Arsenal 3–0 Everton');
  assert.equal(goalMsg.url, '/match/1001?utm_source=push&utm_medium=push&utm_campaign=alerts');

  // full time: the final with our pick right, for everyone who follows (quiet: waits until the morning)
  writeLive('football', [{ id: 1001, status: 'FINISHED', minute: 90, score: { fullTime: { home: 3, away: 0 } } }]);
  now += 2 * MIN;
  await P.pushAlertsTick(now, post);
  const fin = got(proU).find(p => p.kind === 'final');
  assert.equal(fin.title, 'Final: Arsenal 3–0 Everton');
  assert.equal(fin.body, 'Our pick (Arsenal or draw) was right ✓');
  const qf = db.prepare(`SELECT s.status, s.due_at FROM push_sends s JOIN push_events e ON e.id = s.event_id WHERE s.user_id = ? AND e.key = 'final'`).get(quietU);
  assert.equal(qf.status, 'queued');
  assert.ok(Date.parse(qf.due_at) > now, 'the final waits for the end of the quiet hours');

  // a device that is gone (410) is removed and not counted as a failure
  answer = url => (url === db.prepare(`SELECT endpoint FROM push_subs WHERE user_id = ?`).get(freeU)?.endpoint ? 410 : 201);
  const r = await P.sendTestPush(auth.userById(freeU), post);
  assert.deepEqual(r, { ok: 0, fail: 0, gone: 1 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?`).get(freeU).n, 0);
  answer = () => 201;

  // dedupe: never the same event twice to one person
  const dup = db.prepare(`SELECT s.user_id, e.key, COUNT(*) AS n FROM push_sends s JOIN push_events e ON e.id = s.event_id GROUP BY s.user_id, e.sport, e.game_id, e.key HAVING n > 1`).all();
  assert.deepEqual(dup, []);
  const health = P.pushHealth(now);
  assert.equal(health.find(c => c.id === 'push-dedupe').level, 'ok');
  assert.equal(health.find(c => c.id === 'push-delivery').level, 'ok');
  // the admin numbers
  const st = P.pushAdminStats(3);
  assert.ok(st.perDay[0].sent >= 3 && st.optedIn.people >= 4);
});

test('data health warns when more than 5% of device sends fail', async () => {
  const id = user('pro');
  const ev = db.prepare(`INSERT INTO push_events (sport, game_id, kind, key, at, snap) VALUES ('football', 999, 'final', 'final', ?, '{}')`).run(iso(Date.now())).lastInsertRowid;
  db.prepare(`INSERT INTO push_sends (user_id, event_id, kind, created_at, due_at, status, ok_n, fail_n) VALUES (?, ?, 'final', ?, ?, 'failed', 0, 40)`).run(id, ev, iso(Date.now()), iso(Date.now()));
  assert.equal(P.pushHealth().find(c => c.id === 'push-delivery').level, 'warn');
  db.prepare(`DELETE FROM push_sends WHERE event_id = ?`).run(ev);
});

/* ---------- 5. words ---------- */

test('words in 7 languages: every key, the same placeholders, no forbidden words in any alert', () => {
  const en = Object.keys(P.PUSH_PACKS.de);
  const holes = s => (s.match(/\{\d\}/g) || []).sort().join();
  for (const lang of P.PUSH_LANGS.filter(l => l !== 'en')) {
    const pack = P.PUSH_PACKS[lang];
    assert.deepEqual(Object.keys(pack).sort(), [...en].sort(), `${lang}: keys`);
    for (const k of en) assert.equal(holes(pack[k]), holes(k), `${lang}: placeholders of "${k}"`);
  }
  const bad = /\b(bets?|betting|odds|bookmakers?|tips?|tipp|tipps|wagers?|apuestas?|cuotas?|paris|scommesse|quote|apostas?|bahis|oran|wetten?)\b/i;
  const now = Date.now();
  const cases = [
    { kind: 'start', key: 'start', snap: snap({ state: 'pre' }) },
    { kind: 'score', key: 'score:1-0', snap: snap({ hs: 1, minute: 12 }) },
    { kind: 'score', key: 'end:1', snap: snap({ sport: 'basketball', hs: 25, as: 22 }) },
    { kind: 'score', key: 'end:5', snap: snap({ sport: 'basketball', hs: 110, as: 108 }) },
    { kind: 'score', key: 'lead:98-100', snap: snap({ sport: 'basketball', hs: 98, as: 100, minute: 2 }) },
    { kind: 'score', key: 'set:1-0', side: 'H', snap: snap({ sport: 'tennis', sets: [1, 0], lastSet: [6, 4] }) },
    { kind: 'final', key: 'final', snap: snap({ state: 'done', hs: 2, as: 0, winner: 'H' }) },
    { kind: 'final', key: 'final', snap: snap({ state: 'done', hs: 0, as: 2, winner: 'A' }) },
    { kind: 'final', key: 'final', snap: snap({ sport: 'tennis', state: 'done', sets: [2, 1], winner: 'H', pre: { ph: 60, pd: 0, pa: 40 } }) },
    { kind: 'upset', key: 'upset', snap: snap({ hs: 0, as: 1, late: true, pre: { ph: 55, pd: 25, pa: 20 } }) }
  ];
  for (const lang of P.PUSH_LANGS) {
    const tx = P.pushWords(lang);
    for (const c of cases) {
      const n = R.noteOf({ sport: c.snap.sport, gameId: 1, ...c }, { tx, lang, tz: 'Europe/Berlin', showPick: true });
      for (const part of [n.title, n.body]) {
        assert.doesNotMatch(part, bad, `${lang} ${c.key}: ${part}`);
        assert.doesNotMatch(part, /\{\d\}|undefined|NaN/, `${lang} ${c.key}: ${part}`);
      }
      const e = R.noteOf({ sport: c.snap.sport, gameId: 1, ...c }, { tx: P.pushWords('en'), lang: 'en', tz: 'Europe/Berlin', showPick: true });
      if (lang !== 'en' && c.snap.pre) assert.notEqual(n.title + n.body, e.title + e.body, `${lang} ${c.key} translated`);
    }
  }
  void now;
});

test('free vs Pro: the starting pick only for Pro or an unlocked game, upset alerts only for Pro, the final for everyone', () => {
  const pro = P.personOf(auth.userById(user('pro')));
  const free = P.personOf(auth.userById(user('free')));
  const s = snap({ id: 77, rid: 77 });
  assert.equal(P.showPickFor(pro, s), true);
  assert.equal(P.showPickFor(free, s), false);
  free.unlocked.add(77);
  assert.equal(P.showPickFor(free, s), true, 'unlocked');
  for (const p of [pro, free]) { p.fav.football.add(57); }
  const up = { sport: 'football', kind: 'upset', gameId: 77, snap: s };
  assert.equal(P.wants(pro, up), true);
  assert.equal(P.wants(free, up), false);
  assert.equal(P.wants(free, { ...up, kind: 'final' }), true);
  assert.equal(P.wants(free, { ...up, kind: 'final', snap: { teamIds: [1, 2] } }), false, 'not a favourite');
});

/* ---------- 6. account and processes ---------- */

test('account deletion removes the alert settings, consent history, devices and send log; the export lists them', () => {
  const id = user('pro');
  P.savePushPrefs(id, { score: false }, 'account');
  const ex = auth.exportUserData(id);
  { assert.ok(ex.pushAlerts.settings); assert.ok(ex.pushAlerts.consentHistory.length >= 2); assert.equal(ex.pushAlerts.devices.length, 1); assert.ok(!JSON.stringify(ex.pushAlerts).includes('fcm.googleapis.com')); }
  P.deletePushData(id);
  for (const t of ['push_prefs', 'push_consent_log', 'push_subs', 'push_sends']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(id).n, 0, t);
  const src = fs.readFileSync(new URL('../src/services/auth.ts', import.meta.url), 'utf8');
  assert.match(src, /'push_prefs', 'push_consent_log', 'push_subs', 'push_sends'/, 'auth.ts deletes them with the account');
});

test('settings: off by default, every switch change logged with time and source', () => {
  const id = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES ('fresh@example.com', 'x', 'free', ?, 1)`).run(iso(Date.now())).lastInsertRowid);
  const p = P.pushPrefs(id);
  assert.equal(p.on, false);
  assert.equal(p.quietFrom, 0); assert.equal(p.quietTo, 7);
  P.savePushPrefs(id, { on: true, tz: 'Asia/Tokyo' }, 'account');
  P.savePushPrefs(id, { upset: false }, 'account');
  const log = db.prepare(`SELECT kind, on_, source FROM push_consent_log WHERE user_id = ? ORDER BY id`).all(id);
  assert.deepEqual(log.map(r => `${r.kind}:${r.on_}:${r.source}`), ['on:1:account', 'upset:0:account']);
  assert.throws(() => P.savePushPrefs(id, { quietFrom: 25 }, 'account'), /quiet hours/);
  assert.throws(() => P.savePushPrefs(id, { tz: 'Mars/Base' }, 'account'), /time zone/);
});

test('sent from the worker only: the web entry never runs the tick, the tick sits in the live loop', () => {
  const src = fs.readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
  assert.match(src, /pushAlertsTick\(\)/);
  for (const f of ['app.ts', 'index.ts']) assert.doesNotMatch(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /pushAlertsTick|sendDue|sendToDevices/, f);
  assert.match(fs.readFileSync(new URL('../src/services/pushAlerts.ts', import.meta.url), 'utf8'), /if \(!runsJobs \|\| busy\) return null;/);
});

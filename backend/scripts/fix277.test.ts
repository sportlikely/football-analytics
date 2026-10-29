// fix277: scraper swarms — many addresses behaving like one script are challenged as a group (Yarin, 29 Oct: "I don't
// want them on our website"). Run: npm run test:fix277 (builds dist first: the server parts run in a child process)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SwarmTracker, SWARM_RULES, netOf, uaKeyOf, swarmSummaryLine, type SwarmHit } from '../src/utils/swarmRules.ts';
import { ProxyLimiter, PROXY_LIMITS } from '../src/services/proxyGuard.ts';
import { quickCheckPage, QC_LANGS, QC_WORDS } from '../src/utils/quickCheck.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const SRC = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const MIN = 60000, HOUR = 3600000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const clock = (start: number) => { let t = start; return { now: () => t, add: (ms: number) => { t += ms; } }; };
const SWARM_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const PERSON_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** address i spread over home networks: a different /16 each (fix199's data-centre list never sees them) */
const spread = (i: number, ua = SWARM_UA): SwarmHit => { const ip = `${24 + (i % 150)}.${Math.floor(i / 150)}.7.${1 + (i % 200)}`; return { ua, country: 'US', net: netOf(ip, null), addr: `a${i}` }; };
/** address i on one ISP's /16 */
const isp = (i: number, ua = PERSON_UA): SwarmHit => ({ ua, country: 'IL', net: netOf(`79.180.${i % 250}.${1 + (i % 200)}`, null), addr: `p${i}` });

test('the group key: AS number when known, else the /16 (IPv6 /32)', () => {
  assert.equal(netOf('79.180.3.4', null), '79.180/16');
  assert.equal(netOf('::ffff:79.180.3.4', null), '79.180/16');
  assert.equal(netOf('2a02:6680:1:2::5', null), '2a02:6680/32');
  assert.equal(netOf('5.6.7.8', 60068), 'AS60068');
  assert.equal(uaKeyOf(SWARM_UA), uaKeyOf(SWARM_UA));
  assert.match(uaKeyOf(SWARM_UA), /^[0-9a-f]{16}$/);
});

test('300 addresses + one user-agent + no signs → challenged within the hour (the day rule: every country and network)', () => {
  const c = clock(T0);
  const s = new SwarmTracker(SWARM_RULES, c.now);
  // 29 Oct: each address opens a few pages, then the next one — 300 addresses over 40 minutes, a different /16 each
  for (let i = 0; i < 300; i++) {
    for (let p = 0; p < 3; p++) s.note(spread(i), { request: true, view: p === 0 });
    c.add(8000);
  }
  c.add(2 * MIN);
  const v = s.note(spread(300), { request: true });
  assert.equal(v.swarm, true, 'challenged');
  assert.equal(v.why, 'day');
  assert.ok(c.now() - T0 < HOUR, 'within the hour');
  // a brand-new address of the same user-agent, another country: challenged too
  assert.equal(s.note({ ...spread(9999), country: 'DE' }, { request: true }).swarm, true);
  const row = s.rows().find(r => r.ua === uaKeyOf(SWARM_UA))!;
  assert.equal(row.state, 'challenged');
  assert.ok(row.addresses >= 301 && row.humanShare === 0 && row.otherNetworks > 100);
  // it stays a swarm 6 h after it last qualified, then lets go
  c.add(5 * HOUR);
  assert.equal(s.verdict(spread(5)).swarm, true);
  c.add(HOUR + MIN);
  assert.equal(s.verdict(spread(5)).swarm, false);
});

test('40+ addresses of one group in an hour, under 5% people → the hour rule', () => {
  const c = clock(T0);
  const s = new SwarmTracker(SWARM_RULES, c.now);
  const g = (i: number): SwarmHit => ({ ua: SWARM_UA, country: 'US', net: 'AS16509', netName: 'Amazon (AS16509)', addr: `g${i}` });
  for (let i = 0; i < 39; i++) { s.note(g(i), { request: true }); c.add(20000); }
  c.add(2 * MIN);
  assert.equal(s.note(g(0), { request: true }).swarm, false, '39 addresses: watching');
  s.note(g(39), { request: true });
  c.add(2 * MIN);
  const v = s.note(g(1), { request: true });
  assert.deepEqual([v.swarm, v.why], [true, 'hour']);
  // the same user-agent elsewhere is not (only 40 addresses: under the day rule)
  assert.equal(s.note(isp(1, SWARM_UA), { request: true }).swarm, false);
  // the first minute's addresses are not judged yet: 40 brand-new addresses at once are not a swarm (beacons come after 5 s)
  const c2 = clock(T0), s2 = new SwarmTracker(SWARM_RULES, c2.now);
  for (let i = 0; i < 60; i++) s2.note(g(i), { request: true });
  assert.equal(s2.note(g(60), { request: true }).swarm, false);
});

test('30 (and 120) people on one ISP with seen beacons → never', () => {
  for (const n of [30, 120, 400]) {
    const c = clock(T0);
    const s = new SwarmTracker(SWARM_RULES, c.now);
    let ever = false;
    for (let i = 0; i < n; i++) {
      ever ||= s.note(isp(i), { request: true, view: true }).swarm;
      c.add(3000);
      // most people scroll or click after 5 s; a third leave at once (no beacon)
      if (i % 3 !== 0) ever ||= s.note(isp(i), { human: true }).swarm;
      ever ||= s.note(isp(i), { request: true }).swarm;
      c.add(Math.floor(HOUR / n));
    }
    c.add(2 * MIN);
    ever ||= s.note(isp(n + 1), { request: true }).swarm;
    assert.equal(ever, false, `${n} people`);
  }
});

test('a network with people is protected from its user-agent\'s day rule; headless beacons are no people', () => {
  const c = clock(T0);
  const s = new SwarmTracker(SWARM_RULES, c.now);
  for (let i = 0; i < 320; i++) { s.note(spread(i), { request: true }); s.note(spread(i), { headless: true }); c.add(5000); }
  // people on one ISP with the same browser: their group shows people today
  for (let i = 0; i < 10; i++) { s.note(isp(i, SWARM_UA), { request: true }); s.note(isp(i, SWARM_UA), { human: true }); }
  c.add(2 * MIN);
  assert.equal(s.note(spread(1), { request: true }).swarm, true, 'the swarm');
  assert.equal(s.note(isp(3, SWARM_UA), { request: true }).swarm, false, 'the ISP with people');
  // a headless "human" beacon is not a person
  assert.equal(s.rows()[0].human, 10);
  assert.ok(s.rows()[0].headless >= 320);
});

test('"Trust" stops the challenge at once; "Always challenge" challenges without the rules', () => {
  const c = clock(T0);
  const s = new SwarmTracker(SWARM_RULES, c.now);
  for (let i = 0; i < 300; i++) { s.note(spread(i), { request: true }); c.add(5000); }
  c.add(2 * MIN);
  assert.equal(s.note(spread(1), { request: true }).swarm, true);
  s.setOverrides([{ ua: uaKeyOf(SWARM_UA), mode: 'trust' }]);
  const v = s.note(spread(2), { request: true });
  assert.deepEqual([v.swarm, v.trusted], [false, true]);
  assert.equal(s.rows().find(r => r.ua === uaKeyOf(SWARM_UA))!.state, 'watching');
  s.setOverrides([{ ua: uaKeyOf(PERSON_UA), mode: 'challenge' }]);
  assert.deepEqual(s.note(isp(1), { request: true }).why, 'always');
  s.setOverrides([]);
  assert.equal(s.note(spread(3), { request: true }).swarm, true, 'back to the rules: still held');
});

test('the holds survive a restart (hashed keys only, no address)', () => {
  const c = clock(T0);
  const s = new SwarmTracker(SWARM_RULES, c.now);
  for (let i = 0; i < 300; i++) { s.note(spread(i), { request: true }); c.add(5000); }
  c.add(2 * MIN);
  s.note(spread(1), { request: true });
  const h = s.holds();
  assert.ok(h.u.length === 1 && !JSON.stringify(h).includes('a1') && !JSON.stringify(h).includes('/16'));
  const s2 = new SwarmTracker(SWARM_RULES, c.now);
  s2.loadHolds(JSON.parse(JSON.stringify(h)));
  assert.equal(s2.note(spread(500), { request: true }).swarm, true);
});

test('a pass holder: its own limit only (300 page views an hour)', () => {
  const l = new ProxyLimiter(PROXY_LIMITS, clock(T0).now);
  let ok = 0;
  for (let i = 0; i < 400; i++) if (!l.hit('x', 0, { pass: 'pass1234abcd', view: `V${i}` })) ok++;
  assert.equal(ok, PROXY_LIMITS.passHour);
});

test('the 07:00 summary line', () => {
  assert.equal(swarmSummaryLine([{ refused24h: 0 }]), null);
  assert.equal(swarmSummaryLine([{ refused24h: 18000 }, { refused24h: 400 }, { refused24h: 0 }]), 'Swarms challenged today: 2 groups, 18,400 requests');
});

test('the Quick check names the swarm reason in every language, with Turnstile', () => {
  for (const l of QC_LANGS) {
    const html = quickCheckPage(l, 'site-key-1', 'swarm');
    assert.ok(QC_WORDS[l].swarm && QC_WORDS[l].swarmWhy, l);
    assert.ok(html.includes('challenges.cloudflare.com/turnstile') && html.includes('"site-key-1"'), `${l}: Turnstile`);
    assert.ok(!html.includes(QC_WORDS[l].vpn), `${l}: not the VPN line`);
  }
  assert.ok(quickCheckPage('en', 'k').includes("You're on a VPN"), 'the proxy page as before');
});

test('the server is wired: the API, the pages, the beacon, the pass, the admin switch', () => {
  const app = SRC('src/app.ts');
  assert.match(app, /swarmCheck\(swHit,/, 'API reads');
  assert.match(app, /quickCheckPage\(qcLangOf\(req\.path\), turnstileSiteKey\(\), 'swarm'\)/, 'pages: the Quick check instead of the page / crawler HTML');
  assert.match(app, /swarm: true, check: !!passKey\(\)/, 'the app opens the Quick check');
  assert.match(app, /swarmSeen\(/, 'beacon');
  assert.match(app, /swarmPassed\(/, 'Quick check passed');
  assert.match(app, /\/api\/admin\/swarms\//, 'admin switch');
  assert.match(SRC('src/services/dataHealth.ts'), /swarmHealth\(\)/);
  assert.match(SRC('../frontend/src/lib/adminTabs.ts'), /match: 'scraper-swarms'/);
  assert.match(SRC('../frontend/src/components/VisitorsCard.tsx'), /function SwarmsCard/);
});

/* ---------- the server parts on an empty database (one process) ---------- */

function child(code: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix277-'));
  const env: Record<string, string | undefined> = { ...process.env, DATA_DIR: dir, SL_ROLE: 'all', THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1' };
  for (const k of ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY']) env[k] = '';
  const pre = `const D = ${JSON.stringify(DIST)}; let NOW = ${T0}; const realNow = Date.now; Date.now = () => NOW;\n`;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `${pre}(async () => {\n${code}\n})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });`], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

test('server: a swarm is challenged and never a visit; Googlebot, an email-verified account and a pass holder never; Trust at once', () => {
  const out = child(`
    const V = require(D + '/services/visitors.js');
    const G = require(D + '/services/swarmGuard.js');
    const { db } = require(D + '/db');
    const { visitorDbSummary } = require(D + '/services/visitorSummary.js');
    const UA = ${JSON.stringify(SWARM_UA)};
    const ipOf = i => (24 + (i % 100)) + '.' + Math.floor(i / 100) + '.7.' + (1 + (i % 200));
    const reqOf = (ip, extra = {}) => ({ ip, access: 'anon', query: {}, path: '/matches', user: null, body: {}, get: h => (h.toLowerCase() === 'user-agent' ? UA : undefined), ...extra });
    const who = (o = {}) => ({ admin: false, verifiedCrawler: false, verifiedAccount: false, signedIn: false, pass: false, counted: true, ...o });
    let acts = [];
    for (let i = 0; i < 300; i++) {
      const req = reqOf(ipOf(i));
      V.trackVisit(req, {}, () => {});
      const r = G.swarmCheck(G.swarmHitOf(req.ip, UA), who());
      if (r.act) V.markSwarmVisit(req);
      NOW += 8000;
    }
    NOW += 120000;
    const ip = ipOf(7), req = reqOf(ip);
    const act = G.swarmCheck(G.swarmHitOf(ip, UA), who()).act;
    V.trackVisit(req, {}, () => {});
    if (act) V.markSwarmVisit(req);
    // a script's beacon claiming a person does not make the address one (the swarm reason)
    const seen = V.visitSeen(reqOf(ipOf(8), { body: { token: 'abcdefabcdef12', visibleMs: 9000, interacted: true, languages: 2 } }), null, true);
    const googlebot = G.swarmCheck(G.swarmHitOf(ipOf(9), UA), who({ verifiedCrawler: true })).act;
    const account = G.swarmCheck(G.swarmHitOf(ipOf(10), UA), who({ verifiedAccount: true, signedIn: true })).act;
    const unverified = G.swarmCheck(G.swarmHitOf(ipOf(11), UA), who({ signedIn: true })).act;
    const pass = G.swarmCheck(G.swarmHitOf(ipOf(12), UA), who({ pass: true })).act;
    const beaconRoute = G.swarmCheck(G.swarmHitOf(ipOf(13), UA), who({ counted: false })).act;
    const row = G.swarmRows()[0];
    G.setSwarmOverride(row.ua, 'trust', 'test');
    const trusted = G.swarmCheck(G.swarmHitOf(ipOf(14), UA), who()).act;
    G.setSwarmOverride(row.ua, null, 'test');
    const back = G.swarmCheck(G.swarmHitOf(ipOf(15), UA), who()).act;
    const visits = db.prepare("SELECT COUNT(*) n, SUM(human) h, SUM(CASE WHEN bot = 'swarm' THEN 1 ELSE 0 END) s FROM visits").get();
    const sum = visitorDbSummary(NOW);
    console.log(JSON.stringify({ act, seen, googlebot, account, unverified, pass, beaconRoute, trusted, back, visits, today: sum.today, split: sum.botSplit, row: { state: row.state, why: row.why } }));
  `);
  assert.equal(out.act, 'challenge');
  assert.deepEqual(out.seen, { counted: false, reason: 'swarm' });
  assert.equal(out.googlebot, null, 'verified search engine');
  assert.equal(out.account, null, 'email-verified account');
  assert.equal(out.unverified, 'member', 'signed in without a confirmed email: stored data, not refused');
  assert.equal(out.pass, 'pass', 'pass holder: its own limit only');
  assert.equal(out.beaconRoute, 'member', 'a route never counted is never refused');
  assert.equal(out.trusted, null, 'Trust: at once');
  assert.equal(out.back, 'challenge', 'back to the rules');
  assert.deepEqual(out.row, { state: 'challenged', why: 'day' });
  assert.equal(out.today, 0, 'no person counted');
  assert.equal(out.visits.h, 0);
  assert.ok(out.visits.s >= 1 && out.split.swarms === out.visits.s, `swarm visits ${JSON.stringify(out.visits)} ${JSON.stringify(out.split)}`);
});

test('server: data health and the 07:00 line', () => {
  const out = child(`
    const G = require(D + '/services/swarmGuard.js');
    const UA = ${JSON.stringify(SWARM_UA)};
    const ok = G.swarmHealth();
    for (let i = 0; i < 300; i++) { G.swarmCheck(G.swarmHitOf((24 + (i % 100)) + '.' + Math.floor(i / 100) + '.7.9', UA), { admin: false, verifiedCrawler: false, verifiedAccount: false, signedIn: false, pass: false, counted: true }); NOW += 5000; }
    NOW += 120000;
    const hit = G.swarmHitOf('24.9.9.9', UA);
    for (let i = 0; i < 25; i++) { G.swarmCheck(hit, { admin: false, verifiedCrawler: false, verifiedAccount: false, signedIn: false, pass: false, counted: true }); G.swarmRefused(hit, false); }
    // the minute's write (the web's flush): rows + holds
    const { db } = require(D + '/db');
    const at = new Date(NOW).toISOString();
    for (const r of G.swarmRows()) db.prepare('INSERT OR REPLACE INTO swarm_days (day, ua, text, state, refused, wrong, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(at.slice(0, 10), r.ua, r.text, r.state, r.refused, r.wrong, JSON.stringify(r), at);
    const warn = G.swarmHealth();
    const line = G.swarmSummary();
    G.swarmRefused(hit, true);
    for (const r of G.swarmRows()) db.prepare('INSERT OR REPLACE INTO swarm_days (day, ua, text, state, refused, wrong, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(at.slice(0, 10), r.ua, r.text, r.state, r.refused, r.wrong, JSON.stringify(r), at);
    const fail = G.swarmHealth();
    console.log(JSON.stringify({ ok: ok.level, warn: [warn.level, warn.detail], line, fail: fail.level }));
  `);
  assert.equal(out.ok, 'ok');
  assert.equal(out.warn[0], 'warn');
  assert.match(out.warn[1], /1 swarm challenged now — the biggest: Mozilla\/5\.0 \(X11; Linux x86_64\)/);
  assert.equal(out.line, 'Swarms challenged today: 1 group, 25 requests');
  assert.equal(out.fail, 'fail', 'a trusted group or a verified engine got the challenge');
});

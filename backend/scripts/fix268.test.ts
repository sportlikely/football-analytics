// fix268: Google verified also when an edge hop was skipped by its network (AS60068 / AS212238), and a verified search
// engine never gets 429 / 503 (old id links, /api while rendering, start-up). Run: npm run test:fix268
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const dist = (f: string) => require(path.join(here, '..', 'dist', f));
const { EdgeLearner, explainClient, clientOfRequest, hopLine, EDGE_ASNS } = dist('utils/clientIp.js');
const { CrawlerRanges, SEED_RANGES, listedCrawler } = dist('utils/crawlerRanges.js');

const H = { 'x-railway-edge': 'railway/europe-west4-drams3a', 'x-hikari-trace': 'abc123' };
const SOCKET = '100.64.0.2';
const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const google = new CrawlerRanges(SEED_RANGES);
// Railway's Hikari edge on Datacamp: 152.233.40.x (not learned yet) and 89.222.103.x (learned), 37.19.x on AS212238
const DC = (ip: string) => (/^(89\.222\.103|152\.233\.40)\./.test(ip) ? 60068 : /^37\.19\./.test(ip) ? 212238 : null);

test('the 28 Oct sample: 66.249.74.x behind an unlearned edge hop in AS60068 → the client, verified by Google\'s list', () => {
  const l = new EdgeLearner(DC);
  l.load('89.222.103.0/24', Date.now() - 3600000, Date.now());
  const x = explainClient(SOCKET, '66.249.74.12, 152.233.40.9, 89.222.103.7', H, DC, l);
  assert.equal(x.ip, '66.249.74.12');
  assert.equal(x.edgeAsnSkip, true);
  assert.match(hopLine(x), /66\.249\.74\.12 \[TAKEN\] → 152\.233\.40\.9 \[edge network AS60068\] → 89\.222\.103\.7 \[edge 89\.222\.103\.0\/24\]/);
  assert.ok(listedCrawler(google, ua, x.ip), 'the client hop is checked normally: in Google\'s list');
});

test('the edge networks count before any range is learned (AS60068 and AS212238), only with the edge headers', () => {
  assert.deepEqual([...EDGE_ASNS].sort(), [212238, 60068].sort());
  const cold = new EdgeLearner(DC);
  assert.equal(clientOfRequest(SOCKET, '66.249.74.12, 152.233.40.9, 89.222.103.7', H, DC, cold), '66.249.74.12');
  assert.equal(clientOfRequest(SOCKET, '66.249.74.12, 37.19.1.2', H, DC, cold), '66.249.74.12');
  // no edge headers: nothing is skipped (the rightmost public hop)
  assert.equal(clientOfRequest(SOCKET, '66.249.74.12, 152.233.40.9, 89.222.103.7', {}, DC, cold), '89.222.103.7');
  // a visitor on Datacamp itself (a VPN) with nothing to the left stays the client
  assert.equal(clientOfRequest(SOCKET, '152.233.40.9, 89.222.103.7', H, DC, cold), '152.233.40.9');
  // a hop outside the edge networks is never skipped: a forged Google hop in front of it gains nothing
  assert.equal(clientOfRequest(SOCKET, '66.249.74.12, 5.5.5.5, 89.222.103.7', H, DC, cold), '5.5.5.5');
});

test('wiring: verified behind an edge-network hop, Google\'s ranges with any user-agent, no 429 / 503 for a verified engine', () => {
  const app = read('src/app.ts');
  assert.match(app, /const c = crawlerCheck\(req\.ip, ua\);/);
  assert.doesNotMatch(app, /slEdgeAsnSkip \? \{ ok: false/);
  assert.match(app, /\} else if \(inGoogleRanges\(req\.ip\)\) \{[\s\S]{0,200}verifiedCrawler = true;/);
  assert.match(app, /const crawler = verdict === true \|\| isVerifiedCrawler\(req\);/);
  // start-up: a verified engine waits for the state, never the 503
  assert.match(app, /if \(!isVerifiedCrawler\(req\) && Date\.now\(\) - t0 > STARTUP_WAIT_MS\) return res\.status\(503\)/);
  // /api while rendering: no provider call / busy = the app's pending answer (202), not 503
  assert.match(app, /if \(crawler\) return res\.status\(202\)[^\n]*pending: true/);
  assert.match(app, /if \(crawler && status === 503\) return res\.status\(202\)/);
  // the bot gate and the limits keep letting a verified engine through
  assert.match(app, /botGate\.enter\(isVerifiedCrawler\(req\)\)/);
  assert.match(app, /if \(req\.access === 'admin' \|\| isVerifiedCrawler\(req\)/);
  const fw = read('src/services/forward.ts');
  assert.match(fw, /if \(!workerConnected\(\) && \(req as any\)\.verifiedCrawler && !req\.destroyed\)/);
  assert.match(fw, /verifiedCrawler && \(req\.method === 'GET' \|\| req\.method === 'HEAD'\) && !res\.headersSent && !req\.destroyed && waitedMs < 60_000/);
});

test('data health counts again from the fix268 deploy (the older rule\'s counts kept aside)', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fix268-'));
  const { underRule, CRAWLER_RULE } = dist('services/crawlerIps.js');
  assert.equal(CRAWLER_RULE, 268);
  const eng = (r: number) => ({ requests: 4238, verified: 100, byList: 100, byDns: 0, refused: r, s429: r - 5, s503: 5, api: 0 });
  const old = { day: '2026-10-28', since: '2026-10-28T13:23:00.000Z', engines: { google: eng(299), bing: eng(0), apple: eng(0) },
    googleRanges: { requests: 50, refused: 35, s429: 30, s503: 5 }, refusedRecent: ['x'], sample: null, edgeAsnSkips: 900 };
  const d = underRule(old);
  assert.equal(d.rule, 268);
  assert.equal(d.engines.google.requests, 0);
  assert.equal(d.googleRanges.refused, 0);
  assert.deepEqual(d.refusedRecent, []);
  assert.equal(d.beforeRule.engines.google.refused, 299);
  assert.equal(d.beforeRule.googleRanges.s429, 30);
  assert.equal(d.beforeRule.rule, 262);
  assert.equal(d.beforeRule.since, '2026-10-28T13:23:00.000Z');
  // a row already on the rule is kept as it is (a restart)
  assert.equal(underRule({ ...old, rule: 268 }).engines.google.refused, 299);
  const ci = read('src/services/crawlerIps.ts');
  assert.match(ci, /before the fix\$\{CRAWLER_RULE\} deploy/);
  assert.match(ci, /old\.rule !== CRAWLER_RULE && \(isWeb \|\| !isWorker\)\) \{ cur = underRule\(old\)/);
});

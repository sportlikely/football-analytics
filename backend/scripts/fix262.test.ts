// fix262: req.ip = the hop just left of Railway's edge (Hikari edge: x-railway-edge / x-hikari-trace headers, its own
// address appended to X-Forwarded-For) — learned edge ranges, never the leftmost hop. Run: npm run test:fix262
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
const { EdgeLearner, clientOfRequest, explainClient, hopLine, clientOf, rangeOf, hasEdgeHeader, EDGE_MIN_LEFTS, EDGE_KEEP_DAYS } = dist('utils/clientIp.js');
const { CrawlerRanges, SEED_RANGES, listedCrawler } = dist('utils/crawlerRanges.js');

const EDGE = '208.77.246.12';
const H = { 'x-railway-edge': 'railway/europe-west4-drams3a', 'x-hikari-trace': 'abc123' };
const SOCKET = '100.64.0.2';

/** the edge as the traffic shows it: 300 requests from different clients, each "client, edge" */
function warm(l: any, edge = EDGE) {
  for (let i = 0; i < 300; i++) l.note(SOCKET, `${11 + (i % 200)}.${i % 7}.3.${i % 250}, ${edge}`, H);
}
const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const google = new CrawlerRanges(SEED_RANGES);

test('"66.249.66.1, <railway edge>" + the edge headers → req.ip 66.249.66.1, verified by Google\'s list', () => {
  const l = new EdgeLearner();
  warm(l);
  assert.ok(l.isEdge(EDGE) && l.isEdge('208.77.246.200'), 'the edge /24 is learned');
  const ip = clientOfRequest(SOCKET, `66.249.66.1, ${EDGE}`, H, () => null, l);
  assert.equal(ip, '66.249.66.1');
  assert.ok(listedCrawler(google, ua, ip), 'verified by the list');
  assert.equal(clientOf(SOCKET, `66.249.66.1, ${EDGE}`), EDGE, "fix254's rule took the edge (the bug)");
});

test('"1.2.3.4, 66.249.66.1, <edge>" → 66.249.66.1 (the client hop); a spoofed left part never wins', () => {
  const l = new EdgeLearner(); warm(l);
  assert.equal(clientOfRequest(SOCKET, `1.2.3.4, 66.249.66.1, ${EDGE}`, H, () => null, l), '66.249.66.1');
  // a visitor at 1.2.3.4 who writes "66.249.66.1" himself: the edge appends his real address → he stays 1.2.3.4
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, 1.2.3.4, ${EDGE}`, H, () => null, l), '1.2.3.4');
  // writing the edge's own address in front gains nothing either
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, ${EDGE}, 1.2.3.4, ${EDGE}`, H, () => null, l), '1.2.3.4');
});

test('the edge is trusted only with the edge headers, and only once learned', () => {
  const cold = new EdgeLearner();
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, ${EDGE}`, H, () => null, cold), EDGE, 'not learned yet: not trusted');
  const l = new EdgeLearner(); warm(l);
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, ${EDGE}`, {}, () => null, l), EDGE, 'no edge headers: not trusted');
  assert.ok(hasEdgeHeader({ 'x-hikari-trace': 'x' }) && hasEdgeHeader({ 'x-railway-edge': 'y' }) && !hasEdgeHeader({}));
});

test('a normal visitor is their own address (1 hop, edge headers on)', () => {
  const l = new EdgeLearner(); warm(l);
  assert.equal(clientOfRequest(SOCKET, '81.2.69.160', H, () => null, l), '81.2.69.160');
  assert.equal(clientOfRequest(SOCKET, `81.2.69.160, ${EDGE}`, H, () => null, l), '81.2.69.160');
  assert.equal(clientOfRequest(SOCKET, `81.2.69.160, ${EDGE}, 10.1.2.3`, H, () => null, l), '81.2.69.160', 'internal hops after the edge');
  assert.equal(clientOfRequest('::ffff:127.0.0.1', '81.2.69.160', H, () => null, l), '81.2.69.160', "the worker's copy (one hop from the web)");
});

test('learning: a client with varied fake left hops is never learned as an edge without a real share of the traffic', () => {
  const l = new EdgeLearner();
  warm(l);
  // the visitor's own address is the last hop only when he is it; Railway's edge stays the last hop for everyone else
  for (let i = 0; i < 3; i++) l.note(SOCKET, `9.9.9.${i}, 5.5.5.5`, H);
  assert.equal(l.isEdge('5.5.5.5'), false, 'too few different left hops / too small a share');
  // a single-hop request teaches nothing
  const l2 = new EdgeLearner();
  for (let i = 0; i < 500; i++) l2.note(SOCKET, `${20 + (i % 200)}.1.1.1`, H);
  assert.equal(l2.ranges().length, 0);
  // without the edge headers nothing is learned
  const l3 = new EdgeLearner();
  for (let i = 0; i < 300; i++) l3.note(SOCKET, `${20 + (i % 200)}.1.1.1, ${EDGE}`, {});
  assert.equal(l3.isEdge(EDGE), false);
  assert.ok(EDGE_MIN_LEFTS >= 10);
});

test('learned ranges survive a restart (loaded from the table) and IPv6 edges use /48', () => {
  const l = new EdgeLearner();
  l.load('208.77.246.0/24', Date.now() - 3600000, Date.now());
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, ${EDGE}`, H, () => null, l), '66.249.66.1');
  l.load('1.1.1.0/24', Date.now() - 40 * 86400000, Date.now() - 31 * 86400000);
  assert.equal(l.isEdge('1.1.1.1'), false, 'unseen for 30 days: dropped');
  l.load('1.1.2.0/24', Date.now() - 20 * 86400000, Date.now() - 20 * 86400000);
  assert.equal(l.isEdge('1.1.2.9'), true, 'kept 30 days (fix262b)');
  assert.equal(EDGE_KEEP_DAYS, 30);
  assert.equal(rangeOf('2a09:8280:1::4'), '2a09:8280:1::/48');
  assert.equal(rangeOf('::ffff:208.77.246.12'), '208.77.246.0/24');
});

test('wiring: req.ip set first in app.ts, the Googlebot log keeps the fix254 rule beside it, data health shows the ranges', () => {
  const app = read('src/app.ts');
  const mw = app.indexOf('app.use(clientIpMiddleware)');
  assert.ok(mw > 0 && mw < app.indexOf('BAD_BOTS.test') && mw < app.indexOf('crawlerCheck(req.ip'));
  const eh = read('src/services/edgeHops.ts');
  assert.match(eh, /Object\.defineProperty\(req, 'ip'/);
  assert.match(eh, /if \(!req\.headers\[INTERNAL_HEADER\]\) edgeLearner\.note/);
  const ci = read('src/services/crawlerIps.ts');
  assert.match(ci, /oldRule: clientOf\(socket, xff, asnOf\)/);
  assert.match(ci, /before262/);
  assert.match(read('src/services/dataHealth.ts'), /crawlerHealth\(edgeStatus\(\)\)/);
});

/* ---------- fix262b ---------- */
// Railway's Hikari edge runs on Datacamp: the two edge hops are both in AS60068
const DC = (ip: string) => (/^(89\.222\.103|152\.233\.4|84\.17\.44|84\.17\.45)\./.test(ip) ? 60068 : /^(20|52)\./.test(ip) ? 8075 : null);
const E1 = '89.222.103.7', E2 = '84.17.44.20', E2b = '84.17.45.3';

test('fix262b: every consecutive edge hop is skipped — learned ranges, then the edge network (AS)', () => {
  const l = new EdgeLearner(DC);
  for (let i = 0; i < 300; i++) l.note(SOCKET, `${11 + (i % 200)}.${i % 7}.3.${i % 250}, ${E2}, ${E1}`, H);
  assert.ok(l.isEdge(E1), 'the last hop is learned');
  assert.ok(l.isEdge(E2), 'the second edge hop is learned too (walks past the known edge, same AS)');
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, ${E2}, ${E1}`, H, DC, l), '66.249.66.1');
  // a second-hop /24 not learned yet, but in the edge's network: skipped, marked
  const x = explainClient(SOCKET, `81.2.69.160, ${E2b}, ${E1}`, H, DC, l);
  assert.equal(x.ip, '81.2.69.160');
  assert.equal(x.edgeAsnSkip, true, 'skipped by its network (fix268: the client hop is still verified)');
  assert.match(hopLine(x), /81\.2\.69\.160 \[TAKEN\] → 84\.17\.45\.3 \[edge network AS60068\] → 89\.222\.103\.7 \[edge 89\.222\.103\.0\/24\] → 100\.64\.0\.2 \[socket\]/);
  // a visitor really on Datacamp (a VPN) with nothing to the left stays the client
  assert.equal(clientOfRequest(SOCKET, `${E2b}, ${E1}`, H, DC, l), E2b);
  // a deeper hop outside the edge's AS is never learned as an edge
  const l2 = new EdgeLearner(DC);
  for (let i = 0; i < 300; i++) l2.note(SOCKET, `${11 + (i % 200)}.1.1.1, ${E1}`, H);
  for (let i = 0; i < 300; i++) l2.note(SOCKET, `${30 + (i % 150)}.2.2.2, 5.5.5.5, ${E1}`, H);
  assert.equal(l2.isEdge('5.5.5.5'), false);
  assert.equal(clientOfRequest(SOCKET, `66.249.66.1, 5.5.5.5, ${E1}`, H, DC, l2), '5.5.5.5', 'a forged Google hop in front of a client gains nothing');
});

test('fix262b: Googlebot user-agent from Azure / AWS with a forged Google hop = fake crawler (not Google), refused', () => {
  const ci = read('src/services/crawlerIps.ts');
  assert.match(ci, /export function isFakeCrawler/);
  assert.match(ci, /if \(listedCrawler\(ranges, ua, ip\) \|\| inGoogleRanges\(ip\)\) return null;/);
  assert.match(ci, /const fake = isFakeCrawler\(ua, ip, how\);[\s\S]*?e = null;/);
  assert.match(read('src/services/visitors.ts'), /fake \? 'fake-crawler' : uaBot \? 'ua'/);
  // fix268: the client hop behind an edge-network hop is checked normally (fix262b refused it)
  assert.match(read('src/app.ts'), /const c = crawlerCheck\(req\.ip, ua\);/);
  assert.match(read('../docs/notes/security.md'), /was Railway's edge, not a scraper/);
});

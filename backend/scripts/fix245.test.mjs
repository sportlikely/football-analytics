// fix245: search engines verified by their published address lists (Google, Bing, Apple) even when DNS fails; a
// verified search engine is never limited or refused (no 429 from the proxy rules or rate limits, no 503 from the bot
// gate); a Googlebot user-agent from a proxy network (Datacamp) is still refused. (dist build) Run: npm run test:fix245
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const GOOGLEBOT = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const baseEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix245-'));
  // the data-centre list (asn.ts): Google AS15169 holds 66.249.64.0/19, Datacamp AS60068 holds 5.1.0.0/16
  fs.mkdirSync(path.join(dir, 'geo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'geo', 'dc-ranges.json'), JSON.stringify({ at: new Date().toISOString(), v4: [['5.1.0.0', '5.1.255.255', 60068], ['66.249.64.0', '66.249.95.255', 15169]], v6: [], names: {} }));
  const env = { ...process.env, DATA_DIR: dir, NODE_ENV: 'production', LOG_LEVEL: 'error', THREAD_JOBS: '0', WORKER: '0', GEO_OFF: '', CRAWLER_DNS_SERVERS: '127.0.0.1:9' };
  for (const k of KEYS) delete env[k];
  return env;
};
const run = (code, env, timeout = 180000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice(7));
};

test('the published lists: parse, look up (IPv4, IPv6, nested), and the user-agent must claim that engine', async () => {
  const { CrawlerRanges, parseRangeFile, listedCrawler, engineOfUa, plainIp, SEED_RANGES } = await import(pathToFileURL(`${DIST}/utils/crawlerRanges.js`).href);
  const google = parseRangeFile({ creationTime: 'x', prefixes: [{ ipv4Prefix: '66.249.66.0/27' }, { ipv6Prefix: '2001:4860:4801:10::/64' }, { ipv4Prefix: 'bad' }, { other: 1 }] });
  assert.deepEqual(google, ['66.249.66.0/27', '2001:4860:4801:10::/64']);
  assert.deepEqual(parseRangeFile(null), []);
  const r = new CrawlerRanges({ google, bing: ['157.55.39.0/24'], apple: ['17.0.0.0/8', '17.58.101.0/24'] });
  assert.equal(r.engineOf('66.249.66.1'), 'google');
  assert.equal(r.engineOf('::ffff:66.249.66.31'), 'google');
  assert.equal(r.engineOf('66.249.66.32'), null, 'outside the /27');
  assert.equal(r.engineOf('2001:4860:4801:10::abcd'), 'google');
  assert.equal(r.engineOf('2001:4860:4801:11::1'), null);
  assert.equal(r.engineOf('17.58.101.9'), 'apple');
  assert.equal(r.engineOf('5.1.2.3'), null);
  assert.equal(r.engineOf('garbage'), null);
  assert.equal(plainIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(engineOfUa(GOOGLEBOT), 'google');
  assert.equal(engineOfUa('Mozilla/5.0 (compatible; bingbot/2.0)'), 'bing');
  assert.equal(engineOfUa('Mozilla/5.0 (Macintosh) Applebot/0.1'), 'apple');
  assert.equal(engineOfUa('Mozilla/5.0 (Windows NT 10.0) Chrome/130'), null);
  assert.equal(listedCrawler(r, GOOGLEBOT, '66.249.66.1'), 'google');
  assert.equal(listedCrawler(r, 'Mozilla/5.0 (compatible; bingbot/2.0)', '66.249.66.1'), null, "Bing's name from Google's address");
  assert.equal(listedCrawler(r, GOOGLEBOT, '5.1.2.3'), null, 'Googlebot from Datacamp');
  assert.equal(listedCrawler(r, 'Mozilla/5.0 Chrome/130', '66.249.66.1'), null, 'a browser from a Google address is not a crawler');
  assert.ok(new CrawlerRanges(SEED_RANGES).engineOf('66.249.66.1') === 'google', 'the seed covers Googlebot before the first download');
});

test('the daily download: every list read, a failed one keeps its last copy, saved for the web process', () => {
  const r = run(`
    const lists = {
      'googlebot.json': { prefixes: [{ ipv4Prefix: '192.0.2.0/24' }] },
      'special-crawlers.json': { prefixes: [{ ipv4Prefix: '198.51.100.0/24' }] },
      'user-triggered-fetchers.json': { prefixes: [{ ipv6Prefix: '2001:db8::/32' }] },
      'user-triggered-fetchers-google.json': { prefixes: [{ ipv4Prefix: '203.0.113.0/24' }] },
      'bingbot.json': { prefixes: [{ ipv4Prefix: '157.55.40.0/24' }] }
    };
    const ips = require('${DIST}/services/crawlerIps.js');
    (async () => {
      const failed = await ips.refreshCrawlerRanges(async url => { const k = url.split('/').pop(); if (!lists[k]) throw new Error('answered 503'); return lists[k]; });
      const out = { failed, a: ips.crawlerByList('Googlebot/2.1', '192.0.2.7'), b: ips.crawlerByList('Googlebot/2.1', '2001:db8::1'), c: ips.crawlerByList('bingbot/2.0', '157.55.40.1'),
        seed: ips.crawlerByList('Googlebot/2.1', '66.249.66.1'), apple: ips.crawlerByList('Applebot/0.1', '17.1.2.3'), status: ips.crawlerRangesStatus() };
      // a second run where Google fails: its lists stay
      const failed2 = await ips.refreshCrawlerRanges(async url => { if (url.includes('google')) throw new Error('timeout'); const k = url.split('/').pop(); if (!lists[k]) throw new Error('503'); return lists[k]; });
      out.failed2 = failed2.length; out.kept = ips.crawlerByList('Googlebot/2.1', '192.0.2.7');
      out.file = require('fs').existsSync(require('path').join(process.env.DATA_DIR, 'geo', 'crawler-ranges.json'));
      console.log('RESULT ' + JSON.stringify(out)); process.exit(0);
    })();
  `, baseEnv());
  assert.deepEqual(r.failed.map(x => x.split(':')[0]), ['applebot']);
  assert.equal(r.a, 'google'); assert.equal(r.b, 'google'); assert.equal(r.c, 'bing');
  assert.equal(r.seed, 'google', 'the seed stays with the downloaded lists');
  assert.equal(r.apple, 'apple', 'Apple: the seed while its list is missing');
  assert.equal(r.failed2, 5);
  assert.equal(r.kept, 'google', 'a failed download keeps the last copy');
  assert.ok(r.file);
});

test('66.249.66.1 Googlebot with DNS failing: verified by the list, never 429 / 503 under load; Googlebot from Datacamp: refused', () => {
  const env = { ...baseEnv(), BOT_PAGES: '2', BOT_QUEUE: '2', BOT_WAIT_MS: '50' };
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'fix245-static-'));
  fs.mkdirSync(path.join(st, 'assets'));
  fs.writeFileSync(path.join(st, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>');
  env.STATIC_DIR = st;
  const r = run(`
    require('dns').setServers(['127.0.0.1:9']); require('dns').promises.setServers?.(['127.0.0.1:9']);
    require('${DIST}/services/asn.js').startAsn();
    const { app } = require('${DIST}/app.js');
    const { crawlerReport, crawlerHealth } = require('${DIST}/services/crawlerIps.js');
    const { crawlerVerdict } = require('${DIST}/services/afUsage.js');
    const srv = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      const get = async (p, ip, ua) => { const res = await fetch(base + p, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } }); await res.arrayBuffer(); return res.status; };
      const tally = list => list.reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {});
      const out = { verdictGoogle: crawlerVerdict('66.249.66.1', '${GOOGLEBOT}'), verdictDatacamp: crawlerVerdict('5.1.2.3', '${GOOGLEBOT}') };
      // 150 API reads from Google's crawl address (the proxy limit is 60 an hour), 30 at a time
      const g = [];
      for (let i = 0; i < 5; i++) g.push(...await Promise.all(Array.from({ length: 30 }, () => get('/api/changelog', '66.249.66.1', '${GOOGLEBOT}'))));
      out.googleApi = tally(g);
      // 30 pages at once (bot gate: 2 running, 2 waiting)
      out.googlePages = tally(await Promise.all(Array.from({ length: 30 }, (_, i) => get('/how-it-works?x=' + i, '66.249.66.1', '${GOOGLEBOT}'))));
      // a fake Googlebot on Datacamp: the proxy rules (60 an hour per address) and the bot gate
      const d = [];
      for (let i = 0; i < 3; i++) d.push(...await Promise.all(Array.from({ length: 30 }, () => get('/api/changelog', '5.1.2.3', '${GOOGLEBOT}'))));
      out.datacampApi = tally(d);
      const dp = [];
      for (let i = 0; i < 3; i++) dp.push(...await Promise.all(Array.from({ length: 25 }, (_, j) => get('/how-it-works?y=' + i + j, '5.1.2.4', '${GOOGLEBOT}'))));
      out.datacampPages = tally(dp);
      await new Promise(r => setTimeout(r, 300));
      const rep = crawlerReport();
      out.google = rep.today.engines.google; out.ranges = rep.today.googleRanges; out.health = crawlerHealth()[0];
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    });
  `, env);
  assert.equal(r.verdictGoogle, true, 'verified by the list with DNS failing');
  assert.notEqual(r.verdictDatacamp, true);
  assert.ok(!r.googleApi['429'] && !r.googleApi['503'], `Google API: ${JSON.stringify(r.googleApi)}`);
  assert.equal(r.googleApi['200'], 150);
  assert.ok(!r.googlePages['429'] && !r.googlePages['503'], `Google pages: ${JSON.stringify(r.googlePages)}`);
  assert.ok(r.datacampApi['429'] > 0, `Datacamp still refused: ${JSON.stringify(r.datacampApi)}`);
  assert.ok((r.datacampPages['503'] || 0) + (r.datacampPages['429'] || 0) > 0, `Datacamp pages limited: ${JSON.stringify(r.datacampPages)}`);
  assert.equal(r.ranges.refused, 0, "nothing refused from Google's ranges");
  assert.ok(r.google.byList >= 180, `counted as verified by the list: ${JSON.stringify(r.google)}`);
  assert.equal(r.health.level, 'ok', JSON.stringify(r.health));
});

test("data health fails when a request from Google's ranges got a 429 / 503", () => {
  const r = run(`
    const ips = require('${DIST}/services/crawlerIps.js');
    ips.noteCrawlerResponse('Googlebot/2.1', '66.249.66.1', 'list', 200, '/api/today');
    const ok = ips.crawlerHealth()[0].level;
    ips.noteCrawlerResponse('Mozilla/5.0 Chrome/130', '66.249.66.9', null, 429, '/api/matches/upcoming');
    const h = ips.crawlerHealth()[0];
    console.log('RESULT ' + JSON.stringify({ ok, level: h.level, items: h.items, detail: h.detail }));
    process.exit(0);
  `, baseEnv());
  assert.equal(r.ok, 'ok');
  assert.equal(r.level, 'fail');
  assert.match(r.items[0], /429 \/api\/matches\/upcoming/);
  assert.match(r.detail, /1 got 429 \/ 503/);
});

test('bot gate: a verified search engine waits (past the queue limit) and never gets null; others still get the 503', async () => {
  const { BotGate } = await import(pathToFileURL(`${DIST}/services/botGate.js`).href);
  const g = new BotGate(1, 1, 30, 120);
  const hold = await g.enter();
  const waiting = g.enter(); // fills the queue
  assert.equal(await g.enter(), null, 'a plain bot over the queue: 503');
  const t0 = Date.now();
  const crawler = await g.enter(true);
  assert.equal(typeof crawler, 'function', 'the crawler goes on');
  assert.ok(Date.now() - t0 >= 100, 'after waiting');
  // a slot freed while a crawler waits goes to it
  const c2 = g.enter(true);
  hold();
  assert.equal(await waiting, null, 'the plain bot timed out at 30 ms before the slot was freed');
  assert.equal(typeof (await c2), 'function');
  assert.ok(g.status().crawlerWaited >= 2);
});

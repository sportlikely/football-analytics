// fix285: link previews and verified crawlers are never challenged; AI crawlers have a switch each; the Visitors headline
// splits the callers (Yarin, 30 Oct). Run: npm run test:fix285 (builds dist first: the server parts run in a child process)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
// (the rules from dist: utils/goodBots.ts imports the range lookup without an extension, as the server code does)
const require = createRequire(import.meta.url);
const { goodBotOfUa, botStatus, botAct, rangesOf, seedRanges, ogCard, modeOf, GOOD_BOTS, REASON_KIND, VISITOR_KINDS } = require(`${DIST}/utils/goodBots.js`);
const { parseCidrText } = require(`${DIST}/utils/crawlerRanges.js`);
const FB = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';
const PPLX = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)';
const CLAUDE_SEARCH = 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)';

test('names: every preview / AI bot is found by its user-agent; iMessage is not Meta; browsers are nothing', () => {
  assert.equal(goodBotOfUa(FB)?.id, 'meta');
  assert.equal(goodBotOfUa('meta-externalfetcher/1.1')?.id, 'meta');
  assert.equal(goodBotOfUa('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)')?.id, 'meta-externalagent');
  assert.equal(goodBotOfUa(IMESSAGE)?.id, 'imessage');
  assert.equal(goodBotOfUa('WhatsApp/2.23.20.0 A')?.id, 'whatsapp');
  assert.equal(goodBotOfUa('Twitterbot/1.0')?.id, 'twitterbot');
  assert.equal(goodBotOfUa('TelegramBot (like TwitterBot)')?.id, 'telegrambot');
  assert.equal(goodBotOfUa('LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)')?.id, 'linkedinbot');
  assert.equal(goodBotOfUa('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')?.id, 'slackbot');
  assert.equal(goodBotOfUa('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')?.id, 'discordbot');
  assert.equal(goodBotOfUa('Pinterestbot/1.0')?.id, 'pinterestbot');
  assert.equal(goodBotOfUa(PPLX)?.id, 'perplexitybot');
  assert.equal(goodBotOfUa('Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)')?.id, 'oai-searchbot');
  assert.equal(goodBotOfUa(CLAUDE_SEARCH)?.id, 'claude-searchbot');
  assert.equal(goodBotOfUa('Mozilla/5.0 (compatible; ExaBot/1.0)')?.id, 'exabot');
  assert.equal(goodBotOfUa('Mozilla/5.0 (compatible; Amazonbot/0.1)')?.id, 'amazonbot');
  assert.equal(goodBotOfUa('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'), null);
  assert.equal(goodBotOfUa(''), null);
  assert.equal(new Set(GOOD_BOTS.map((b: { id: string }) => b.id)).size, GOOD_BOTS.length, 'ids are unique');
  assert.deepEqual(parseCidrText('91.108.56.0/22\n149.154.160.0/20\nbad\n2001:b28:f23d::/48\n'), ['91.108.56.0/22', '149.154.160.0/20', '2001:b28:f23d::/48']);
});

test("rules: facebookexternalhit from Meta's range is trusted; the same name elsewhere is a normal unknown; phones get the card; AI bots default to Challenge", () => {
  const r = rangesOf(seedRanges());
  const meta = goodBotOfUa(FB)!;
  assert.equal(botStatus(meta, '157.240.22.35', r, null), 'verified');
  assert.equal(botStatus(meta, '2a03:2880:f12f:83::face:b00c', r, null), 'verified');
  assert.equal(botAct(meta, 'verified', 'challenge'), 'trusted');
  assert.equal(botStatus(meta, '24.17.3.9', r, null), 'fake', 'a home network');
  assert.equal(botAct(meta, 'fake', 'challenge'), 'normal');
  const wa = goodBotOfUa('WhatsApp/2.23.20.0 A')!;
  assert.equal(botStatus(wa, '79.180.4.5', r, null), 'card', "the sender's phone");
  assert.equal(botStatus(wa, '157.240.1.1', r, null), 'verified', "Meta's servers");
  assert.equal(botAct(wa, 'card', 'challenge'), 'card');
  const pin = goodBotOfUa('Pinterestbot/1.0')!;
  assert.equal(botStatus(pin, '54.1.2.3', r, null), 'pending', 'DNS running');
  assert.equal(botStatus(pin, '54.1.2.3', r, true), 'verified');
  assert.equal(botStatus(pin, '54.1.2.3', r, false), 'fake');
  const tg = goodBotOfUa('TelegramBot (like TwitterBot)')!;
  assert.equal(botStatus(tg, '149.154.161.10', r, null), 'verified');
  assert.equal(botStatus(tg, '5.1.2.3', r, null), 'fake');
  // AI bots: Challenge unless Yarin trusts it; Trust needs the published list where there is one
  const px = goodBotOfUa(PPLX)!, cs = goodBotOfUa(CLAUDE_SEARCH)!;
  assert.equal(modeOf('perplexitybot', {}), 'challenge');
  assert.equal(botAct(px, 'fake', 'challenge'), 'challenge');
  assert.equal(botAct(px, 'verified', 'trust'), 'trusted');
  assert.equal(botAct(px, 'fake', 'trust'), 'normal', 'a fake PerplexityBot is an unknown caller');
  assert.equal(botStatus(cs, '5.6.7.8', r, null), 'named');
  assert.equal(botAct(cs, 'named', 'trust'), 'trusted');
  assert.equal(botAct(cs, 'named', 'challenge'), 'challenge');
});

test('the Open Graph card: the head (title, og tags), no scripts, no body', () => {
  const page = '<!doctype html><html lang="en"><head><title>Real Madrid</title><meta property="og:title" content="Real Madrid" /><meta property="og:image" content="https://sportlikely.com/og.png" /><script type="module" src="/assets/index-abc.js"></script><link rel="modulepreload" href="/assets/x.js"></head><body><div id="root"><h1>Prediction 58%</h1></div></body></html>';
  const card = ogCard(page);
  assert.match(card, /<meta property="og:title" content="Real Madrid" \/>/);
  assert.match(card, /og:image/);
  assert.doesNotMatch(card, /<script|modulepreload|Prediction 58%/);
  assert.match(card, /<\/head><body><\/body><\/html>$/);
});

test('headline categories: every visit reason has one, and there are five', () => {
  assert.deepEqual(VISITOR_KINDS, ['people', 'search', 'previews', 'blocked', 'other']);
  assert.equal(REASON_KIND.preview, 'previews');
  assert.equal(REASON_KIND.crawler, 'search');
  assert.equal(REASON_KIND.swarm, 'blocked');
  assert.equal(REASON_KIND['ai-blocked'], 'blocked');
});

const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY'];
function serverRun(code: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix285-'));
  fs.mkdirSync(path.join(dir, 'geo'), { recursive: true });
  // Datacamp 5.1/16 on the data-centre list (a fake on a proxy network)
  fs.writeFileSync(path.join(dir, 'geo', 'dc-ranges.json'), JSON.stringify({ at: new Date().toISOString(), v4: [['5.1.0.0', '5.1.255.255', 60068]], v6: [], names: {} }));
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'fix285-static-'));
  fs.mkdirSync(path.join(st, 'assets'));
  fs.writeFileSync(path.join(st, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title><meta property="og:title" content="SportLikely · Sports predictions" /><meta property="og:image" content="https://sportlikely.com/og-image.png" /><link rel="canonical" href="https://sportlikely.com/" /><meta property="og:url" content="https://sportlikely.com/" /><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>');
  const env: Record<string, string | undefined> = { ...process.env, DATA_DIR: dir, STATIC_DIR: st, NODE_ENV: 'production', LOG_LEVEL: 'error', THREAD_JOBS: '0', WORKER: '0', GEO_OFF: '', CRAWLER_DNS_SERVERS: '127.0.0.1:9' };
  for (const k of KEYS) delete env[k];
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line!.slice(7));
}

test("server: facebookexternalhit from Meta's range is never challenged and gets Open Graph tags; a fake one is a normal unknown; AI switch; the headline adds up", () => {
  const r = serverRun(`
    require('dns').setServers(['127.0.0.1:9']);
    require('${DIST}/services/asn.js').startAsn();
    const { app } = require('${DIST}/app.js');
    const { goodBotRows, setGoodBotMode } = require('${DIST}/services/goodBots.js');
    const { visitorDbSummary } = require('${DIST}/services/visitorSummary.js');
    const srv = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      const get = async (p, ip, ua) => { const res = await fetch(base + p, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } }); return { s: res.status, body: await res.text() }; };
      const tally = list => list.reduce((a, x) => (a[x.s] = (a[x.s] || 0) + 1, a), {});
      const out = {};
      // 30 Oct: facebookexternalhit from 148 Meta addresses — here 160 addresses x 2 pages, and 90 pages from one address
      const meta = [];
      for (let b = 0; b < 8; b++) meta.push(...await Promise.all(Array.from({ length: 20 }, (_, i) => get('/how-it-works?m=' + b + i, '157.240.' + b + '.' + (i + 1), ${JSON.stringify(FB)}))));
      for (let b = 0; b < 8; b++) meta.push(...await Promise.all(Array.from({ length: 20 }, (_, i) => get('/football?m=' + b + i, '157.240.' + b + '.' + (i + 1), ${JSON.stringify(FB)}))));
      for (let b = 0; b < 3; b++) meta.push(...await Promise.all(Array.from({ length: 30 }, (_, i) => get('/how-it-works?one=' + b + i, '69.171.250.9', ${JSON.stringify(FB)}))));
      out.meta = tally(meta);
      out.metaOg = meta.filter(x => x.s === 200 && /property="og:title"/.test(x.body) && /og:image/.test(x.body)).length;
      out.metaApi = tally(await Promise.all(Array.from({ length: 80 }, () => get('/api/changelog', '157.240.9.9', ${JSON.stringify(FB)}))));
      // the same name from a home network and from Datacamp: a normal unknown bot (60 pages an hour per address)
      const fake = [];
      for (let b = 0; b < 3; b++) fake.push(...await Promise.all(Array.from({ length: 30 }, (_, i) => get('/how-it-works?f=' + b + i, '24.17.3.9', ${JSON.stringify(FB)}))));
      out.fake = tally(fake);
      const plainBot = [];
      for (let b = 0; b < 3; b++) plainBot.push(...await Promise.all(Array.from({ length: 30 }, (_, i) => get('/how-it-works?p=' + b + i, '24.17.3.10', 'SomeUnknownBot/1.0'))));
      out.plainBot = tally(plainBot);
      out.fakeDcApi = tally(await Promise.all(Array.from({ length: 80 }, () => get('/api/changelog', '5.1.2.3', ${JSON.stringify(FB)}))));
      // a phone's WhatsApp preview: the card (title + picture), no body, never challenged
      const wa = await get('/how-it-works', '79.180.4.5', 'WhatsApp/2.23.20.0 A');
      out.wa = { s: wa.s, og: /og:title/.test(wa.body), script: /<script/.test(wa.body), root: /id="root"/.test(wa.body) };
      // AI: Challenge by default, Trust at once
      out.aiDefault = [(await get('/how-it-works', '5.9.9.9', ${JSON.stringify(CLAUDE_SEARCH)})).s, (await get('/api/changelog', '5.9.9.9', ${JSON.stringify(CLAUDE_SEARCH)})).s];
      setGoodBotMode('claude-searchbot', 'trust', 'test');
      out.aiTrusted = [(await get('/how-it-works?t=1', '5.9.9.10', ${JSON.stringify(CLAUDE_SEARCH)})).s, (await get('/api/changelog', '5.9.9.10', ${JSON.stringify(CLAUDE_SEARCH)})).s];
      // a person (API + the seen beacon)
      await get('/api/changelog', '81.2.3.4', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
      await new Promise(res => setTimeout(res, 300));
      const rows = goodBotRows();
      out.row = rows.find(x => x.id === 'meta');
      out.aiRow = rows.find(x => x.id === 'claude-searchbot');
      const sum = visitorDbSummary();
      out.kinds = sum.kinds; out.todayAll = sum.todayAll; out.daily = sum.daily[sum.daily.length - 1];
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    });
  `);
  assert.deepEqual(Object.keys(r.meta), ['200'], `Meta: ${JSON.stringify(r.meta)}`);
  assert.equal(r.metaOg, 410, 'every Meta page carries its Open Graph tags');
  assert.deepEqual(Object.keys(r.metaApi), ['200'], `Meta API: ${JSON.stringify(r.metaApi)}`);
  assert.ok(r.fake['429'] > 0, `a fake from a home network gets the unknown-bot limit: ${JSON.stringify(r.fake)}`);
  assert.deepEqual(r.fake, r.plainBot, 'treated exactly like an unknown bot');
  assert.ok(r.fakeDcApi['429'] > 0, `a fake on Datacamp gets the proxy limits: ${JSON.stringify(r.fakeDcApi)}`);
  assert.deepEqual(r.wa, { s: 200, og: true, script: false, root: false });
  assert.deepEqual(r.aiDefault, [429, 429], 'AI crawler on Challenge');
  assert.deepEqual(r.aiTrusted, [200, 200], 'Trust at once');
  assert.ok(r.row.verified >= 410 && r.row.fake >= 90 && r.row.addresses >= 162, JSON.stringify(r.row));
  assert.equal(r.aiRow.mode, 'trust');
  const k = r.kinds.today;
  assert.equal(k.people + k.search + k.previews + k.blocked + k.other, r.todayAll, `the headline adds up: ${JSON.stringify(k)} vs ${r.todayAll}`);
  assert.ok(k.previews >= 162, `Meta's addresses are link previews: ${JSON.stringify(k)}`);
  assert.ok(k.blocked >= 1 && k.search >= 1, JSON.stringify(k));
  const dk = r.daily.kinds;
  assert.equal(dk.people + dk.search + dk.previews + dk.blocked + dk.other, r.daily.allCallers, 'the daily chart adds up');
});

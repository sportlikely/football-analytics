// fix199: proxy / data-centre scraper rules (src/services/proxyGuard.ts). Run: npm run test:proxy
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyLimiter, PROXY_LIMITS, proxyApplies, countedRead, lockAllPredictions, whoMark, networkLine } from '../src/services/proxyGuard.ts';

const HOUR = 3600000;
const clock = (start: number) => { let t = start; return { now: () => t, add: (ms: number) => { t += ms; } }; };
// 10:00:00 UTC on 21 Oct 2026
const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);

test('address: 60 reads an hour, then 429 until the next hour', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  for (let i = 0; i < 60; i++) assert.equal(l.hit('a1', 60068), null, `read ${i + 1}`);
  const r = l.hit('a1', 60068);
  assert.equal(r?.scope, 'address-hour');
  assert.equal(r?.retryAfter, 3600);
  c.add(HOUR);
  assert.equal(l.hit('a1', 60068), null, 'a new hour opens again');
});

test('address: 300 reads a day, then 429 until midnight UTC', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  let ok = 0;
  for (let h = 0; h < 6; h++) { for (let i = 0; i < 60; i++) if (!l.hit('a1', 60068)) ok++; c.add(HOUR); }
  assert.equal(ok, 300);
  const r = l.hit('a1', 60068);
  assert.equal(r?.scope, 'address-day');
  assert.equal(r?.retryAfter, 8 * 3600); // 16:00 → midnight
  c.add(8 * HOUR);
  assert.equal(l.hit('a1', 60068), null, 'next day opens again');
});

test('network: 600 reads an hour across all its addresses', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  let ok = 0;
  for (let a = 0; a < 25; a++) for (let i = 0; i < 30; i++) if (!l.hit(`a${a}`, 60068)) ok++;
  assert.equal(ok, 600);
  assert.equal(l.hit('fresh', 60068)?.scope, 'network-hour');
  assert.equal(l.hit('fresh', 9009), null, 'another network has its own window');
  c.add(HOUR);
  assert.equal(l.hit('fresh', 60068), null);
});

test('a refused address does not use up its network', () => {
  const l = new ProxyLimiter({ addressHour: 2, addressDay: 100, networkHour: 3 }, () => T0);
  l.hit('a', 1); l.hit('a', 1);
  for (let i = 0; i < 5; i++) assert.equal(l.hit('a', 1)?.scope, 'address-hour');
  assert.equal(l.hit('b', 1), null);
  assert.equal(l.hit('b', 1)?.scope, 'network-hour');
});

test('who the rules apply to: Googlebot verified by DNS (fix173), admins and verified accounts are untouched', () => {
  assert.equal(proxyApplies({ network: true, admin: false, verifiedCrawler: false, verifiedAccount: false }), true);
  assert.equal(proxyApplies({ network: true, admin: false, verifiedCrawler: true, verifiedAccount: false }), false, 'Googlebot from Google (AS15169) passed the DNS check');
  assert.equal(proxyApplies({ network: true, admin: true, verifiedCrawler: false, verifiedAccount: false }), false);
  assert.equal(proxyApplies({ network: true, admin: false, verifiedCrawler: false, verifiedAccount: true }), false);
  assert.equal(proxyApplies({ network: false, admin: false, verifiedCrawler: false, verifiedAccount: false }), false);
  assert.equal(whoMark('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', { requests: 10, verified: 10, dc: 10 }), 'search-engine');
});

test('sign-in, sign-up and account routes are never counted (people on a VPN get in)', () => {
  for (const p of ['/api/auth/login', '/api/auth/signup', '/api/auth/me', '/api/visit/seen', '/api/billing/plans', '/api/health', '/api/client-error'])
    assert.equal(countedRead('GET', p), false, p);
  assert.equal(countedRead('POST', '/api/matches/1'), false);
  for (const p of ['/api/matches/upcoming', '/api/matches/123/details', '/api/team-page/5', '/api/basketball/games', '/api/tennis/matches'])
    assert.equal(countedRead('GET', p), true, p);
});

test('signed out on a proxy: every prediction locked, finished games too → the UnlockPrompt shows', () => {
  const body = {
    data: [
      { id: 1, status: 'FINISHED', prediction: { model: 'grid-v3', pick: 'H', pHome: 0.6, dc: '1X', hit: true } },
      { id: 2, status: 'TIMED', prediction: { model: 'grid-v3', locked: true } },
      { id: 3, state: 'done', predictions: [{ model: 'bb-v3', pHome: 0.7 }], home: { name: 'A' } }
    ],
    match: { id: 4, status: 'FINISHED' }, prediction: { model: 'grid-v3', pick: 'A', confidence: 0.55 }
  };
  const out = lockAllPredictions(body);
  assert.deepEqual(out.data[0].prediction, { model: 'grid-v3', locked: true });
  assert.deepEqual(out.data[1].prediction, { model: 'grid-v3', locked: true });
  assert.deepEqual(out.data[2].predictions, [{ model: 'bb-v3', locked: true }]);
  assert.deepEqual(out.prediction, { model: 'grid-v3', locked: true });
  assert.equal(out.data[2].home.name, 'A', 'everything else stays');
  // the game pages render the "Create a free account" UnlockPrompt for a locked prediction (signed out)
  const fe = path.resolve(import.meta.dirname, '../../frontend/src');
  const md = fs.readFileSync(path.join(fe, 'pages/MatchDetail.tsx'), 'utf8');
  assert.match(md, /p && p\.locked \? \(\s*<LockedPrediction/, 'football: a locked prediction renders LockedPrediction');
  assert.match(md, /function LockedPrediction[\s\S]*<UnlockPrompt/, 'LockedPrediction holds the UnlockPrompt');
  const wp = fs.readFileSync(path.join(fe, 'components/sport/game/WinnerPrediction.tsx'), 'utf8');
  assert.match(wp, /p\.locked \? \([\s\S]*<UnlockPrompt/, 'basketball / NFL / tennis: a locked prediction renders the UnlockPrompt');
  const up = fs.readFileSync(path.join(fe, 'components/UnlockPrompt.tsx'), 'utf8');
  assert.match(up, /Create a free account/, 'signed out: the prompt asks to create a free account');
});

test('the Security log line of a network', () => {
  const line = networkLine({ name: 'Datacamp Ltd', asn: 60068, cc: 'NL', addresses: 25, requests: 4100, refused: 0, capped: 0, fakeCrawler: 0, browser: 4000 });
  assert.equal(line, 'Datacamp Ltd (AS60068, NL) · 25 addresses · 4,100 requests · fake browser UA');
});

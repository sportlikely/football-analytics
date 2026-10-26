// fix244: the Quick check for people on a VPN / proxy network, page views instead of API calls. Run: npm run test:fix244
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyLimiter, PROXY_LIMITS, countedRead, makePass, readPass, viewIdOf, PASS_MS } from '../src/services/proxyGuard.ts';
import { quickCheckPage, qcLangOf, QC_LANGS, QC_WORDS } from '../src/utils/quickCheck.ts';

const HOUR = 3600000;
const clock = (start: number) => { let t = start; return { now: () => t, add: (ms: number) => { t += ms; } }; };
const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);
const KEY = Buffer.alloc(32, 7);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

test('a scraper over the limit is still refused (no cookie, no view id)', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  for (let i = 0; i < PROXY_LIMITS.addressHour; i++) assert.equal(l.hit('s1', 60068), null);
  assert.equal(l.hit('s1', 60068)?.scope, 'address-hour');
  // the same view id over and over: one view per `viewCalls` calls, so no way round the limit
  const l2 = new ProxyLimiter({ ...PROXY_LIMITS, networkHour: 1e9 }, c.now);
  let ok = 0;
  for (let i = 0; i < 5000; i++) if (!l2.hit('s2', 60068, { view: 'Vsame' })) ok++;
  assert.equal(ok, PROXY_LIMITS.addressHour * PROXY_LIMITS.viewCalls);
  // the network cap still stops many addresses
  const l3 = new ProxyLimiter(PROXY_LIMITS, c.now);
  let n = 0;
  for (let a = 0; a < 100; a++) for (let i = 0; i < 60; i++) if (!l3.hit(`a${a}`, 60068)) n++;
  assert.equal(n, PROXY_LIMITS.networkHour);
});

test('a forged or copied pass gets nothing', () => {
  const now = T0;
  const tok = makePass(KEY, UA, now, 'abcdefghijkl');
  assert.deepEqual(readPass(KEY, tok, UA, now), { id: 'abcdefghijkl', ok: true });
  assert.equal(readPass(Buffer.alloc(32, 8), tok, UA, now), null, 'another key');
  assert.equal(readPass(KEY, tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'), UA, now), null, 'changed signature');
  assert.equal(readPass(KEY, 'v1.zzzz.abcdefghijkl.AAAAAAAAAAAAAAAA.' + 'A'.repeat(32), UA, now), null, 'made up');
  assert.equal(readPass(KEY, tok, 'python-requests/2.31', now)?.ok, false, 'copied to another user-agent');
  assert.equal(readPass(KEY, tok, UA, now + PASS_MS + 1)?.ok, false, 'after 24 h');
  assert.equal(readPass(KEY, undefined, UA, now), null);
});

test('a browser that passed is served even when the network cap is used up', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  for (let a = 0; a < 20; a++) for (let i = 0; i < 60; i++) l.hit(`scraper${a}`, 60068);
  assert.equal(l.hit('person', 60068)?.scope, 'network-hour', 'a person without the pass: refused (the Quick check)');
  const pass = readPass(KEY, makePass(KEY, UA, c.now(), 'pass12345678'), UA, c.now());
  assert.ok(pass?.ok);
  for (let v = 0; v < 100; v++) for (let i = 0; i < 10; i++) assert.equal(l.hit('person', 60068, { view: `V${v}`, pass: pass!.id }), null, `view ${v}`);
  // a pass has its own hourly cap (a script that got one cannot pull the site)
  const l2 = new ProxyLimiter(PROXY_LIMITS, c.now);
  let ok = 0;
  for (let i = 0; i < 1000; i++) if (!l2.hit('x', 60068, { pass: 'p1' })) ok++;
  assert.equal(ok, PROXY_LIMITS.passHour);
  assert.equal(l2.hit('x', 60068, { pass: 'p1' })?.scope, 'pass-hour');
});

test('page views, not API calls: a page load and its calls = 1', () => {
  const c = clock(T0);
  const l = new ProxyLimiter(PROXY_LIMITS, c.now);
  // 60 page loads: the HTML (counted) + 8 API calls of the app's first view (free)
  for (let p = 0; p < 60; p++) {
    assert.equal(l.hit('home', 60068, { page: true }), null, `page ${p}`);
    for (let i = 0; i < 8; i++) assert.equal(l.hit('home', 60068, { view: `Lload${p}` }), null, `page ${p} call ${i}`);
  }
  assert.equal(l.hit('home', 60068, { page: true })?.scope, 'address-hour', 'the 61st page');
  // in the app: 60 views of 9 calls each (the network cap counts API calls: 600)
  const l2 = new ProxyLimiter(PROXY_LIMITS, c.now);
  for (let v = 0; v < 60; v++) for (let i = 0; i < 9; i++) assert.equal(l2.hit('app', 60068, { view: `V${v}` }), null);
  assert.equal(l2.hit('app', 60068, { view: 'V60' })?.scope, 'address-hour');
  // an "L" view without a page load before it counts like any other
  const l3 = new ProxyLimiter(PROXY_LIMITS, c.now);
  for (let v = 0; v < 60; v++) l3.hit('l', 60068, { view: `Lx${v}` });
  assert.equal(l3.hit('l', 60068, { view: 'Lx60' })?.scope, 'address-hour');
  assert.equal(viewIdOf('Vabc-123'), 'Vabc-123');
  assert.equal(viewIdOf('x'.repeat(41)), null);
  assert.equal(viewIdOf('a b'), null);
});

test('sign-in pages are never counted', () => {
  for (const p of ['/api/auth/login', '/api/auth/me', '/api/auth/quick-check', '/api/auth/config', '/api/auth/signup'])
    assert.equal(countedRead('GET', p), false, p);
  assert.equal(countedRead('POST', '/api/auth/quick-check'), false);
  const app = fs.readFileSync(path.join(import.meta.dirname, '../src/app.ts'), 'utf8');
  assert.match(app, /\(login\|signup\|join\|forgot\|verify\|account\|reset\|privacy\|terms\|contact\)/, 'the page route skips the account pages');
  // the Quick check route comes before the counted page route
  assert.ok(app.indexOf('quick-check\\/?$/') > 0 && app.indexOf('quick-check\\/?$/') < app.indexOf('fix199: a page read from a data-centre'));
  assert.match(app, /app\.post\('\/api\/auth\/quick-check', jsonOnly/);
  assert.match(app, /httpOnly: true, sameSite: 'lax', secure: req\.secure, maxAge: PASS_MS/);
});

test('the Quick check page: 7 locales, Turnstile, VPN line, sign in', () => {
  assert.deepEqual([...QC_LANGS], ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr']);
  const keys = Object.keys(QC_WORDS.en).sort();
  for (const l of QC_LANGS) {
    assert.deepEqual(Object.keys(QC_WORDS[l]).sort(), keys, l);
    if (l !== 'en') for (const k of keys) assert.notEqual((QC_WORDS[l] as any)[k], (QC_WORDS.en as any)[k], `${l}.${k} translated`);
    const h = quickCheckPage(l, '0x4AAAA-test');
    assert.match(h, new RegExp(`<html lang="${l}">`));
    assert.ok(h.includes('challenges.cloudflare.com/turnstile'), 'Turnstile');
    assert.ok(h.includes(QC_WORDS[l].vpn.replace(/'/g, "'")) || h.includes(QC_WORDS[l].vpn.replace(/'/g, '&#39;')), 'VPN line');
    assert.ok(h.includes(`href="${l === 'en' ? '' : `/${l}`}/login"`), 'sign in link');
    assert.ok(h.includes('noindex'));
    assert.ok(!/status code 429/.test(h));
  }
  const off = quickCheckPage('en', null);
  assert.ok(!off.includes('turnstile'), 'no Turnstile without keys');
  assert.ok(off.includes(QC_WORDS.en.later));
  assert.equal(qcLangOf('/es/football/matches'), 'es');
  assert.equal(qcLangOf('/football/matches'), 'en');
  assert.equal(qcLangOf('/tr/quick-check'), 'tr');
  assert.ok(!quickCheckPage('en', '</script><b>').includes('</script><b>'), 'site key escaped');
});

test('the app: no "status code 429", the Quick check on a proxy 429, strings in all 6 locales', () => {
  const fe = path.join(import.meta.dirname, '../../frontend/src');
  const pc = fs.readFileSync(path.join(fe, 'lib/proxyCheck.ts'), 'utf8');
  assert.match(pc, /data\.proxy && data\.check\) openQuickCheck\(\)/);
  assert.match(pc, /\/quick-check`/);
  assert.match(fs.readFileSync(path.join(fe, 'main.tsx'), 'utf8'), /watchProxyCheck\(\)/);
  for (const l of ['de', 'es', 'fr', 'it', 'pt', 'tr']) {
    const j = JSON.parse(fs.readFileSync(path.join(fe, `locales/${l}.json`), 'utf8'));
    for (const k of ['Too many requests, try again in a minute', 'Too many pages opened from this network. Please try again later, or sign in.'])
      assert.ok(j[k] && j[k] !== k, `${l}: ${k}`);
  }
});

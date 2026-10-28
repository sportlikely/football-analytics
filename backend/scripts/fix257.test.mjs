// fix257: Arabic + Hebrew, right to left, admin-only until PUBLIC_LANGS names them. (1) the language list
// (utils/langs.ts): default public = every language but ar / he, PUBLIC_LANGS overrides, Western digits + Gregorian
// dates for Arabic; (2) the server: /ar, /he answer 404 + noindex to everyone but admins (the page, tabs, the Quick
// check), admins get the app page with noindex and never a crawler copy, the session's `langs` menu; once
// PUBLIC_LANGS names them they are ordinary pages; (3) crawler HTML: dir="rtl" on <html>, hreflang only for public
// languages. (dist build) Run: npm run test:fix257
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const baseEnv = (extra = {}) => {
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fix257-')), NODE_ENV: 'production', LOG_LEVEL: 'error', THREAD_JOBS: '0', API_READ_TOKEN: 'fix257-read', ...extra };
  for (const k of KEYS) delete env[k];
  if (!('PUBLIC_LANGS' in extra)) delete env.PUBLIC_LANGS;
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'fix257-static-'));
  fs.mkdirSync(path.join(st, 'assets'));
  fs.writeFileSync(path.join(st, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>');
  env.STATIC_DIR = st;
  return env;
};
const run = (code, env, timeout = 120000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice(7));
};
const PUB = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru'];
const ALL = [...PUB, 'ar', 'he'];
const PAGES = ['/he', '/ar', '/he/football', '/ar/football/matches', '/he/basketball/match/a-vs-b-2026-10-26/stats', '/he/premium', '/ar/quick-check', '/he/team/86'];
const serverCode = `
  const { app } = require('${DIST}/app.js');
  const srv = app.listen(0, async () => {
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (p, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1') => {
      const res = await fetch(base + p, { redirect: 'manual', headers: { 'user-agent': ua } });
      return { s: res.status, robots: res.headers.get('x-robots-tag'), loc: res.headers.get('location'), body: (await res.text()).slice(0, 3000) };
    };
    const out = { pages: {}, admin: {} };
    for (const p of ${JSON.stringify(PAGES)}) out.pages[p] = await get(p);
    out.bot = await get('/he/football', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    for (const p of ['/he', '/ar/football/matches']) out.admin[p] = await get(p + '?token=fix257-read');
    out.es = await get('/es/football');
    out.arsenal = await get('/arsenal');
    out.me = JSON.parse((await get('/api/auth/me')).body);
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  });
`;

test('the language list: ar / he admin-only by default, PUBLIC_LANGS opens them, Arabic dates keep Western digits', () => {
  const r = run(`
    const L = require('${DIST}/utils/langs.js');
    const out = { all: L.ALL_LANGS, def: L.publicLangs(), menuAnon: L.menuLangs('anon'), menuAdmin: L.menuLangs('admin'),
      of: ['/he/football', '/ar', '/arsenal', '/es/x', '/'].map(L.langOfPath), strip: L.stripLang('/he/football/matches'),
      hidden: [L.hiddenLangPath('/he/x', 'free'), L.hiddenLangPath('/he/x', 'admin'), L.hiddenLangPath('/es/x', 'anon'), L.hiddenLangPath('/arsenal', 'anon')],
      rtl: ['ar', 'he', 'en'].map(L.isRtl),
      arDate: new Date(Date.UTC(2026, 9, 28, 12)).toLocaleDateString(L.LANG_LOCALE.ar, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      heDate: new Date(Date.UTC(2026, 9, 28, 12)).toLocaleDateString(L.LANG_LOCALE.he, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) };
    process.env.PUBLIC_LANGS = 'en, es, he, xx';
    out.env = L.publicLangs();
    process.env.PUBLIC_LANGS = 'he';
    out.envNoEn = L.publicLangs();
    console.log('RESULT ' + JSON.stringify(out));
  `, baseEnv());
  assert.deepEqual(r.all, ALL);
  assert.deepEqual(r.def, PUB, 'default: every language but ar / he');
  assert.deepEqual(r.menuAnon, r.def);
  assert.deepEqual(r.menuAdmin, r.all, 'admins see every language');
  assert.deepEqual(r.of, ['he', 'ar', 'en', 'es', 'en'], '/arsenal is English, not Arabic');
  assert.equal(r.strip, '/football/matches');
  assert.deepEqual(r.hidden, [true, false, false, false]);
  assert.deepEqual(r.rtl, [true, true, false]);
  assert.match(r.arDate, /28/, 'Arabic: Western digits');
  assert.match(r.arDate, /2026/, 'Arabic: the Gregorian year');
  assert.doesNotMatch(r.arDate, /[٠-٩]/, 'no Eastern Arabic digits');
  assert.match(r.heDate, /28 .*2026/);
  assert.deepEqual(r.env, ['en', 'es', 'he'], 'PUBLIC_LANGS: the named ones, unknown codes ignored');
  assert.deepEqual(r.envNoEn, ['en', 'he'], 'English is always public');
});

test('the server: /ar and /he are 404 + noindex for everyone but admins; admins get the app page, noindex', () => {
  const r = run(serverCode, baseEnv());
  for (const [p, x] of Object.entries(r.pages)) {
    assert.equal(x.s, 404, `${p}: 404 (got ${x.s} ${x.loc || ''})`);
    assert.equal(x.robots, 'noindex', `${p}: X-Robots-Tag noindex`);
    assert.match(x.body, /<meta name="robots" content="noindex">/, `${p}: robots meta`);
  }
  assert.equal(r.bot.s, 404, 'a crawler too');
  for (const [p, x] of Object.entries(r.admin)) {
    assert.equal(x.s, 200, `${p}: admins open it`);
    assert.equal(x.robots, 'noindex', `${p}: never indexed`);
    assert.doesNotMatch(x.body, /sl-seo/, `${p}: the plain app page, no crawler copy`);
  }
  assert.notEqual(r.es.s, 404, 'a public language is untouched');
  assert.notEqual(r.arsenal.s, 404, '/arsenal is not /ar');
  assert.deepEqual(r.me.langs, PUB, 'the menu: public languages');
  // (a signed-in admin's menu = menuLangs('admin'), tested above; the maintenance token is no session)
});

test('PUBLIC_LANGS names them: ordinary pages, in the menu, no code change', () => {
  const r = run(serverCode, baseEnv({ PUBLIC_LANGS: ALL.join(',') }));
  for (const p of ['/he', '/ar', '/he/football', '/ar/football/matches', '/he/premium']) {
    assert.notEqual(r.pages[p].s, 404, `${p}: open`);
    assert.notEqual(r.pages[p].robots, 'noindex', `${p}: indexable`);
  }
  assert.equal(r.pages['/ar/quick-check'].s, 200, 'the Quick check in Arabic (always noindex)');
  assert.deepEqual(r.me.langs, ALL);
});

test('crawler HTML: dir="rtl" on <html>, hreflang only for public languages, noun-first titles', () => {
  const code = (pub) => `
    process.env.PUBLIC_LANGS = ${JSON.stringify(pub)};
    const seo = require('${DIST}/services/seo.js');
    const idx = '<!doctype html><html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>';
    const he = seo.renderIndex(idx, seo.seoPage('/he/football')), es = seo.renderIndex(idx, seo.seoPage('/es/football'));
    console.log('RESULT ' + JSON.stringify({ he: he.slice(0, 4000), es: es.slice(0, 4000) }));
  `;
  const hidden = run(code(''), baseEnv());
  assert.match(hidden.he, /<html lang="he" dir="rtl"/);
  assert.match(hidden.es, /<html lang="es">/);
  assert.doesNotMatch(hidden.es, /hreflang="(ar|he)"/, 'no hreflang for admin-only languages');
  assert.match(hidden.es, /hreflang="tr"/);
  const open = run(code(ALL.join(',')), baseEnv({ PUBLIC_LANGS: ALL.join(',') }));
  assert.match(open.es, /hreflang="he" href="https:\/\/sportlikely\.com\/he\/football"/, 'public: hreflang appears');
  assert.match(open.es, /hreflang="ar"/);
});

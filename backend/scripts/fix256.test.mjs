// fix256: 5 new languages (id, hi, pl, el, ru). Run: npm run test:fix256 (dist build, scratch database)
//  - every language has every key (site, email, push dictionaries) and every server-side table has every language
//  - the hreflang set: 12 languages + x-default on a page, in the sitemaps' alternates
//  - one rendered page per language (crawler HTML: <html lang>, translated title / description 140–155 chars)
//  - the language prefix is understood everywhere (clean-link 301 rules, quick check, stored home pages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix256-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
require('../dist/db/index.js');
const { renderIndex, seoPage, SITEMAPS } = require('../dist/services/seo.js');
const { STATIC } = require('../dist/services/seoText.js');
const { pubPath } = require('../dist/services/slugs.js');
const { QC_LANGS, qcLangOf, quickCheckPage } = require('../dist/utils/quickCheck.js');
const { EMAIL_LANGS, EMAIL_PACKS } = require('../dist/services/pickEmails.js');
const { PUSH_LANGS, PUSH_PACKS } = require('../dist/services/pushAlerts.js');
const { CAL_LANGS } = require('../dist/services/calendar.js');
const { HIW_LANGS } = require('../dist/services/howItWorks.js');

const NEW = ['id', 'hi', 'pl', 'el', 'ru'];
const ALL = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', ...NEW];
const FRONT = path.resolve(here, '../../frontend/src');
const pre = l => (l === 'en' ? '' : `/${l}`);

test('every language list on the server has the 12 languages', () => {
  for (const [name, list] of Object.entries({ QC_LANGS, EMAIL_LANGS, PUSH_LANGS, CAL_LANGS, HIW_LANGS })) assert.deepEqual([...list].sort(), [...ALL].sort(), name);
  const i18n = fs.readFileSync(path.join(FRONT, 'lib/i18n.ts'), 'utf8');
  for (const [l, loc] of [['id', 'id-ID'], ['hi', 'hi-IN'], ['pl', 'pl-PL'], ['el', 'el-GR'], ['ru', 'ru-RU']]) assert.ok(i18n.includes(`${l}: { name:`) && i18n.includes(`locale: '${loc}'`), `LANGS has ${l} (${loc})`);
});

test('key parity: every language has every key the others have', () => {
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const sets = [['site', path.join(FRONT, 'locales')], ['email', path.resolve(here, '../src/locales/email')], ['push', path.resolve(here, '../src/locales/push')]];
  for (const [label, dir] of sets) {
    const dicts = ALL.filter(l => l !== 'en').map(l => [l, read(path.join(dir, `${l}.json`))]);
    const keys = new Set(dicts.flatMap(([, d]) => Object.keys(d)));
    for (const [l, d] of dicts) {
      const missing = [...keys].filter(k => !(k in d) || !String(d[k]).trim());
      assert.deepEqual(missing.slice(0, 5), [], `${label} ${l}: ${missing.length} missing`);
    }
  }
  for (const l of NEW) {
    assert.ok(Object.keys(EMAIL_PACKS[l]).length > 10, `email pack ${l}`);
    assert.ok(Object.keys(PUSH_PACKS[l]).length > 10, `push pack ${l}`);
  }
  // fixed-page search descriptions: one full sentence of 140–155 characters in every language
  for (const [page, by] of Object.entries(STATIC)) for (const l of ALL) {
    assert.ok(by[l], `${page}: no ${l}`);
    assert.ok(by[l].length >= 140 && by[l].length <= 155, `${page} ${l}: ${by[l].length} characters`);
  }
});

test('hreflang set: 12 languages + x-default on a page and in the sitemaps', () => {
  const html = renderIndex('<html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>', seoPage('/ru/premium'));
  const tags = [...html.matchAll(/hreflang="([a-z-]+)" href="([^"]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(tags.map(t => t[0]).sort(), [...ALL, 'x-default'].sort());
  for (const [l, href] of tags) if (l !== 'x-default') assert.equal(href, `https://sportlikely.com${pre(l)}/premium`);
  const sm = SITEMAPS['sitemap-football.xml']();
  const first = /<url>[\s\S]*?<\/url>/.exec(sm)[0];
  for (const l of ALL) assert.ok(first.includes(`hreflang="${l}"`), `sitemap alternate ${l}`);
});

test('one rendered page per language: lang, translated title and description', () => {
  const titles = new Set();
  for (const l of ALL) {
    const s = seoPage(`${pre(l)}/`);
    const html = renderIndex('<html lang="en"><head><title>x</title></head><body><div id="root"></div></body></html>', s);
    assert.match(html, new RegExp(`<html lang="${l}"`), `${l}: <html lang>`);
    assert.ok(s.description.length >= 140 && s.description.length <= 160, `${l}: description ${s.description.length}`);
    titles.add(s.description);
    const fb = seoPage(`${pre(l)}/football/matches`);
    assert.ok(fb.title && !/undefined/.test(fb.title + fb.description), `${l}: matches page`);
  }
  assert.equal(titles.size, ALL.length, 'every language has its own home description');
  // Devanagari, Greek and Cyrillic come through untouched
  assert.match(seoPage('/hi/').description, /[ऀ-ॿ]/);
  assert.match(seoPage('/el/').description, /[Ͱ-Ͽ]/);
  assert.match(seoPage('/ru/').description, /[Ѐ-ӿ]/);
});

test('the new prefixes in the link rules: 301 targets keep the language, quick check answers in it', () => {
  for (const l of NEW) {
    assert.equal(pubPath(`/${l}/matches`), `/${l}/football/matches`);
    assert.equal(qcLangOf(`/${l}/quick-check`), l);
    assert.ok(quickCheckPage(l, null).includes(`lang="${l}"`), `quick check ${l}`);
  }
  assert.equal(qcLangOf('/ro/quick-check'), 'en');
});

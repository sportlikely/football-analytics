// fix261: no English sentence on a page in another language. The server (web + worker, dist build, the built site) is
// started on a scratch database with a few games, a team history long enough for the team analysis, a player page and
// a test admin (who sees every language and every paid part). For the home, the football home, a team page, a match
// page with all its tabs, a player page and the Upset watch, the English page is opened first and its text kept; then
// the same page in each of the other 12 languages. A line of the page fails when it is the same as a line of the English
// page and reads as English (three or more words, two of them common English words) — names, numbers and the brand
// pass. On he / ar pages the seeded teams must show in the local script (the names dictionary, fix261 part 2).
// Report: backend/test-output/lang-audit.json (every English line with its page and languages). Screenshots (he / ar,
// 375 px) in backend/test-output/rtl/ as test:paint makes them.
//
//   npm run test:fix261 (after tsc and the frontend build) · LANG_AUDIT_LANGS=he,ar limits the languages
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start, rtlSeed, rtlAdmin, findChromium, stopServer, dataDirOf } from './paint-test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../frontend/package.json'));
const { chromium } = require('playwright-core');
const OUT = path.join(here, '../test-output');
const ALL = ['es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'];
const LANGS = process.env.LANG_AUDIT_LANGS ? process.env.LANG_AUDIT_LANGS.split(',').map(s => s.trim()).filter(Boolean) : ALL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[lang-audit ${new Date().toISOString().slice(11, 19)}]`, ...a);

/** common English words: a line with two of them (and three words or more) reads as English */
export const EN_WORDS = new Set(('the of and in a to is are our we for with from on at by as this that these those it its be has have had was were will can not no '
  + 'games game last points win wins won lost draw draws goals goal home away team teams league season form rating chance chances pick picks strong '
  + 'match matches player players more less than over under against average about after before since every each only also your you see sign free '
  + 'premium week today tomorrow yesterday updated ago minutes hours days score scored conceded both out missing injured why how what when which').split(' '));
/** a line made of these never counts (names of the seeded teams, the brand, model names) */
const NOT_SENTENCE = /^(SportLikely|SL (Football|Basketball|American Football|Tennis) \d\.\d|18\+|[A-Z]{2,5}|[\d\s.,:%+\-–·×#/()]+)$/;
export function englishy(line, names = []) {
  let s = line;
  for (const n of names) s = s.split(n).join(' ');
  if (NOT_SENTENCE.test(s.trim())) return false;
  const words = s.toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 3) return false;
  const hits = words.filter(w => EN_WORDS.has(w)).length;
  return hits >= 2 || (words.length >= 4 && hits >= 1);
}

function seedMore(dir) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'));
  d.exec('PRAGMA busy_timeout = 5000');
  const iso = ms => new Date(ms).toISOString();
  const now = Date.now();
  const ins = (sql, ...a) => { try { d.prepare(sql).run(...a); } catch (e) { log(`seed: ${e.message.slice(0, 120)}`); } };
  const names = ['Maccabi Haifa', 'Hapoel Beer Sheva', 'Al Hilal', 'Al Nassr', 'Arsenal', 'Chelsea'];
  // 10 more finished league games per team (the team analysis needs 6+), mixed results
  let n = 0;
  for (let day = 4; day <= 40; day += 4) for (let k = 0; k < 3; k++) {
    const h = (k * 2 + (day % 8 ? 0 : 1)) % 6, a = (h + 1 + (day % 3)) % 6;
    if (h === a) continue;
    const ko = now - day * 864e5 + k * 3600e3, id = 2000 + n++;
    ins(`INSERT OR REPLACE INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status, hg, ag) VALUES (?, 39, 2026, 'E', 'E0', ?, ?, ?, ?, ?, ?, 'FT', ?, ?)`,
      id, iso(ko), iso(ko).slice(0, 10), 10 + h, 10 + a, names[h], names[a], (day + k) % 4, (day * k) % 3);
  }
  d.close();
}

async function pageLines(browser, base, token, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'b2b_session', value: token, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + url, { waitUntil: 'load', timeout: 30_000 }).catch(e => errors.push(`goto: ${e.message}`));
  let ok = false;
  for (let t0 = Date.now(); Date.now() - t0 < 15_000 && !ok; await sleep(150))
    ok = await page.evaluate(() => { const m = document.querySelector('main'); return !!m && (m.innerText || '').trim().length > 40 && !m.querySelector('[aria-busy="true"]'); }).catch(() => false);
  await sleep(2000); // late parts (analysis, extras, forecast)
  // the page's visible text (main and header / nav), one line per text block, and the title
  const lines = await page.evaluate(() => {
    const out = new Set();
    for (const el of document.querySelectorAll('main, header, nav')) for (const l of (el.innerText || '').split('\n')) { const x = l.replace(/[\u2066-\u2069]/g, '').trim(); if (x) out.add(x); }
    for (const el of document.querySelectorAll('main [title]')) { const x = el.getAttribute('title')?.trim(); if (x) out.add(x); }
    // fix289: news stories are other sites' headlines in their own language (links out, target=_blank), not our text —
    // the live feed's English headlines failed the audit on 31 Oct whenever the local server reached the news sources
    for (const a of document.querySelectorAll('main a[target="_blank"][href^="http"]')) for (const l of (a.innerText || '').split('\n')) out.delete(l.replace(/[⁦-⁩]/g, '').trim());
    out.add(document.title);
    return [...out];
  }).catch(() => []);
  await ctx.close();
  return { lines, ok, errors };
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.error('no Chromium (PLAYWRIGHT_CHROMIUM)'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const base = await start();
  const dir = dataDirOf();
  rtlSeed(dir);
  seedMore(dir);
  const token = await rtlAdmin(dir);
  // the admin console login (the admin's pages ask for it; the public pages do not) — and the names job once
  for (let t0 = Date.now(), cs = null; Date.now() - t0 < 90_000 && cs?.status !== 200; await sleep(cs ? 1000 : 0))
    cs = await fetch(`${base}/api/crm/console/setup`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `b2b_session=${token}`, origin: base }, body: JSON.stringify({ username: 'auditadmin', password: 'audit-console-pass-1' }) }).catch(() => ({ status: 0 }));
  await fetch(`${base}/api/admin/names?run=1`, { headers: { cookie: `b2b_session=${token}` } }).catch(() => null);
  const pick = kind => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'), { readOnly: true });
    const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const r = d.prepare(`SELECT slug FROM slugs WHERE sport = 'football' AND kind = ? AND is_primary = 1 ${kind === 'match' ? `AND slug GLOB '*-${day}'` : kind === 'team' ? `AND slug = 'arsenal'` : ''} ORDER BY slug LIMIT 1`).get(kind);
    d.close();
    return r?.slug;
  };
  const match = pick('match'), team = pick('team'), player = 'bukayo-saka';
  const PAGES = [['home', '/'], ['football', '/football'], ['upset-watch', '/football/upset-watch'], ['team', `/football/team/${team}`], ['player', `/football/player/${player}`],
    ...['', '/stats', '/lineups', '/h2h', '/table'].map(tab => [`match${tab.replace('/', '-') || ''}`, `/football/match/${match}${tab}`])];
  log(`pages: ${PAGES.map(p => p[1]).join(' ')}`);
  const names = ['Maccabi Haifa', 'Hapoel Beer Sheva', 'Al Hilal', 'Al Nassr', 'Arsenal', 'Chelsea', 'Premier League', 'Bukayo Saka', 'B. Saka'];
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const found = new Map(); // line → { pages: Set, langs: Set }
  const fails = [];
  try {
    for (const [name, p] of PAGES) {
      const en = await pageLines(browser, base, token, p);
      if (!en.ok) { fails.push(`${name}: the English page shows nothing`); continue; }
      const enSet = new Set(en.lines);
      for (const l of LANGS) {
        const x = await pageLines(browser, base, token, `/${l}${p === '/' ? '' : p}`);
        if (!x.ok) { fails.push(`${l} ${name}: no content`); continue; }
        if (process.env.LANG_AUDIT_DEBUG) for (const line of x.lines) if (enSet.has(line) && /[a-z]{2,} [a-z]{2,}/i.test(line)) console.log(`  same ${l} ${name}: ${line.slice(0, 150)}`);
        for (const line of x.lines) if (enSet.has(line) && englishy(line, names)) {
          const f = found.get(line) || { pages: new Set(), langs: new Set() };
          f.pages.add(name); f.langs.add(l); found.set(line, f);
        }
        // he / ar: the seeded team names in the local script
        if ((l === 'he' || l === 'ar') && /^(team|match)$/.test(name)) {
          const T = '(Maccabi Haifa|Hapoel Beer Sheva|Al Hilal|Al Nassr|Arsenal|Chelsea)';
          const latin = x.lines.filter(s => new RegExp(`^${T}$|${T} (vs|–|-) |(vs|–|-) ${T}`).test(s));
          if (latin.length) fails.push(`${l} ${name}: names still in Latin letters: ${latin.slice(0, 3).join(' | ')}`);
        }
      }
      log(`${name}: ${[...found.values()].filter(f => f.pages.has(name)).length} English line(s) so far`);
    }
  } finally { await browser.close(); stopServer(); }
  const report = [...found.entries()].map(([line, f]) => ({ line, pages: [...f.pages], langs: [...f.langs] })).sort((a, b) => b.langs.length - a.langs.length);
  fs.writeFileSync(path.join(OUT, 'lang-audit.json'), JSON.stringify({ at: new Date().toISOString(), pages: PAGES, langs: LANGS, english: report, fails }, null, 1));
  for (const r of report) console.log(`  EN  "${r.line.slice(0, 140)}"  (${r.pages.join(', ')}; ${r.langs.length} languages)`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  console.log(report.length || fails.length ? `FAIL (fix261): ${report.length} English line(s), ${fails.length} other problem(s) — test-output/lang-audit.json` : `PASS (fix261): ${PAGES.length} pages × ${LANGS.length} languages, no English sentence; he / ar names in the local script`);
  process.exit(report.length || fails.length ? 1 : 0);
})().catch(e => { console.error(e); stopServer(); process.exit(1); });

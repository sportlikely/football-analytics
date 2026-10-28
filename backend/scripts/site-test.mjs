// fix260 — npm run test:site: every page checked before every deploy. fix260d: by default the deploy GATE (every route
// in English at 375 + 1280 px as visitor + admin, Admin / CRM tabs, one page per type in every other language at 375 px);
// SITE_MODE=full = the nightly matrix described below.
//
// Chromium (playwright-core) opens EVERY route of the site — each public page type of every sport (home, matches, today,
// weekly hub, match + each tab, team, player, league, upset watch, draw alerts, favorites, my picks, accuracy, how it
// works), the site pages (home, premium, guides, how it works, changelog, search, login / signup / account, legal,
// contact, a 404) — in every language at 375 px and 1280 px, as a signed-out visitor, a free user and the admin; the
// admin also opens every Admin tab and every CRM tab with the staff console signed in AND locked.
//
// A page passes when: no console error and no page error; no first-party request answered 4xx / 5xx (except the
// intended 401 / 423 of a locked console, and the 404 page's own 404); no error box ("Something went wrong", a card
// that failed to draw); no "Updating…" pill and no skeleton / spinner still there 3 s after the page loaded; and the
// page shows content. Outside addresses (fonts, images, analytics) are not loaded: the test is hermetic.
//
//   npm run test:site          (after `npx tsc` here and `npx vite build` in frontend)
//   SITE_DATA_DIR=<folder with bet-to-beat.sqlite>   a production-size copy (else the seeded test data)
//   SITE_LANGS=en,es · SITE_WIDTHS=375 · SITE_ROLES=out,free,admin · SITE_ONLY=<substring> · SITE_CONCURRENCY (6)
//   SITE_MODE=full (nightly: everything; default 'gate': English everywhere + one page per type per language) ·
//   SITE_STALE_MS (3000) · SITE_WARM=0 (no warm-up round) · SITE_SHARD=k/n (one of n parts, CI) · SITE_REPORT=<file> (default backend/site-report.json; the CI email reads it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite, samplePages, siteLanguages, findChromium, playwright } from './site-server.mjs';
import { TEST_USERS } from './site-seed.mjs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const STALE = Number(process.env.SITE_STALE_MS) || 3000;
// fix260d: 'gate' (default: the deploy check, ~600 opens) or 'full' (nightly: every route × language × width × role)
const MODE = process.env.SITE_MODE === 'full' ? 'full' : 'gate';
const CONC = Number(process.env.SITE_CONCURRENCY) || 6;
const REPORT = process.env.SITE_REPORT || path.join(here, '../site-report.json');
const log = (...a) => console.log(`[site ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = (v, all) => (v ? v.split(',').map(s => s.trim()) : all);

/* ---------- the routes ---------- */
const SPORT_TABS = {
  football: ['stats', 'lineups', 'h2h', 'table', 'highlights'],
  basketball: ['stats', 'lineups', 'h2h', 'table', 'highlights', 'box', 'players', 'quarters'],
  'american-football': ['stats', 'lineups', 'h2h', 'table', 'players', 'plays'],
  tennis: ['stats', 'h2h', 'form', 'draw']
};
const SPORT_PAGES = {
  football: ['', '/matches', '/today', '/predictions/premier-league', '/upset-watch', '/draw-alerts', '/favorites', '/my-picks', '/accuracy'],
  basketball: ['', '/matches', '/today', '/predictions/nba', '/upset-watch', '/favorites', '/my-picks', '/accuracy', '/how-it-works'],
  'american-football': ['', '/matches', '/today', '/predictions/nfl', '/upset-watch', '/favorites', '/my-picks', '/accuracy', '/how-it-works'],
  tennis: ['', '/matches', '/today', '/rankings', '/upset-watch', '/favorites', '/accuracy', '/how-it-works']
};
const SITE_PAGES = ['/', '/premium', '/premium/packs', '/guides', '/guides/double-chance', '/how-it-works', '/changelog', '/search?q=arsenal', '/login', '/signup', '/account', '/terms', '/privacy', '/accessibility', '/contact', '/credits'];
const NOT_FOUND = '/this-page-does-not-exist-260';
const ADMIN_TABS = ['needs-you', 'users', 'models', 'data', 'site', 'messages', 'security'];
const CRM_TABS = ['inbox', 'customers', 'testers', 'campaigns', 'revenue', 'security', 'activity', 'team'];

function routes(sample) {
  const pub = [...SITE_PAGES, NOT_FOUND];
  for (const [sport, s] of Object.entries(sample)) {
    for (const p of SPORT_PAGES[sport]) pub.push(`/${sport}${p}`);
    for (const m of [s.matchNext, s.matchDone].filter(Boolean)) pub.push(`/${sport}/match/${m}`);
    if (s.matchDone || s.matchNext) for (const t of SPORT_TABS[sport]) pub.push(`/${sport}/match/${s.matchDone || s.matchNext}/${t}`);
    if (s.team) pub.push(`/${sport}/team/${s.team}`);
    if (s.player) pub.push(`/${sport}/player/${s.player}`);
    if (s.league) { pub.push(`/${sport}/league/${s.league}`); if (sport !== 'tennis') pub.push(`/${sport}/league/${s.league}/forecast`); }
  }
  const admin = [...ADMIN_TABS.map(t => `/admin/${t}`), ...CRM_TABS.map(t => `/crm?tab=${t}`)];
  return { pub, admin };
}

/** fix260d: one page of each type (the gate's other languages) */
function typeSample(sample) {
  const f = sample.football || {}, b = sample.basketball || {};
  return ['/', '/football', '/football/matches', '/football/today', f.matchDone && `/football/match/${f.matchDone}`, f.matchDone && `/football/match/${f.matchDone}/stats`,
    f.team && `/football/team/${f.team}`, f.player && `/football/player/${f.player}`, f.league && `/football/league/${f.league}`,
    b.matchNext && `/basketball/match/${b.matchNext}`, '/premium', '/search?q=arsenal', NOT_FOUND].filter(Boolean);
}

/* ---------- one page ---------- */
let visitor = 0;
async function check(browser, base, job) {
  const { url, width, role } = job;
  // each page is its own visitor (an address from the documentation ranges, behind the local "proxy"): the per-address
  // limits apply as they do to real visitors, not to one address opening thousands of pages
  const n = ++visitor;
  const ip = `2001:db8:260::${n.toString(16)}`; // the IPv6 documentation range: a new address for every page open
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 812 : 900 }, deviceScaleFactor: 1, locale: 'en-GB', serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': ip } });
  const token = role === 'free' ? TEST_USERS.free.token : role === 'admin' ? TEST_USERS.admin.tokens.unlocked : role === 'admin-locked' ? TEST_USERS.admin.tokens.locked : null;
  if (token) await ctx.addCookies([{ name: 'b2b_session', value: token, url: base }]);
  const page = await ctx.newPage();
  const why = [];
  const host = new URL(base).host;
  page.on('pageerror', e => why.push(`page error: ${String(e.message).split('\n')[0].slice(0, 200)}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) return; // counted from the responses below (outside addresses are blocked on purpose)
    why.push(`console error: ${t.split('\n')[0].slice(0, 200)}`);
  });
  const locked = role === 'admin-locked';
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.host !== host) return;
    const st = r.status();
    if (st < 400) return;
    if (r.request().resourceType() === 'document' && url === NOT_FOUND || (r.request().resourceType() === 'document' && /this-page-does-not-exist/.test(u.pathname))) return; // the 404 page's own 404
    if (locked && (st === 401 || st === 423) && /^\/api\/(admin|crm|data-health|perf|staff)/.test(u.pathname)) return;
    why.push(`${st} ${r.request().method()} ${u.pathname}${u.search}`);
  });
  page.on('requestfailed', r => {
    const u = new URL(r.url());
    if (u.host !== host) return;
    const f = r.failure()?.errorText || '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(f)) return; // a page that moved on (a redirect, a cancelled read)
    why.push(`failed ${u.pathname}: ${f}`);
  });
  await page.route(u => new URL(u.href).host !== host, r => r.abort('blockedbyclient'));
  const t0 = Date.now();
  let status = null;
  try {
    const res = await page.goto(base + url, { waitUntil: 'load', timeout: 30_000 });
    status = res?.status() ?? null;
  } catch (e) { why.push(`did not load: ${String(e.message).split('\n')[0]}`); }
  const loadedAt = Date.now();
  // content: the main area shows text, no skeleton / spinner, no Updating pill — checked until STALE after load
  let state = null;
  for (;;) {
    state = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const text = (main.innerText || '').trim();
      const busy = !!main.querySelector('[aria-busy="true"], .animate-pulse, .skeleton') || [...main.querySelectorAll('.animate-spin')].some(e => (e.getBoundingClientRect().width > 0));
      const updating = [...document.querySelectorAll('[role="status"]')].some(e => /Updating|Aktualis|Actualiz|Mise à jour|Aggiorn|Güncel|Memperbarui|अपडेट|Aktualiz|Ενημέρωση|Обновл/.test(e.textContent || ''));
      const boom = /Something went wrong on this page/.test(document.body.innerText || '') || !!document.querySelector('[data-card-error]');
      const cardErr = [...document.querySelectorAll('[data-card-error]')].map(e => e.getAttribute('data-card-error') + ': ' + (e.textContent || '').slice(0, 120));
      return { len: text.length, busy, updating, boom, cardErr, path: location.pathname + location.search };
    }).catch(() => null);
    if (!state) break;
    if (state.boom) break;
    if (state.len > 20 && !state.busy && !state.updating) break;
    if (Date.now() - loadedAt > STALE) break;
    await sleep(100);
  }
  await sleep(400); // late errors (effects, lazy parts)
  const late = await page.evaluate(() => ({ boom: /Something went wrong on this page/.test(document.body.innerText || '') || !!document.querySelector('[data-card-error]'), cardErr: [...document.querySelectorAll('[data-card-error]')].map(e => e.getAttribute('data-card-error') + ': ' + (e.textContent || '').slice(0, 160)) })).catch(() => null);
  if (state) {
    if (state.boom || late?.boom) why.push(`error box shown${(late?.cardErr || state.cardErr).length ? ` (${(late?.cardErr || state.cardErr).join('; ')})` : ''}`);
    else if (state.updating) why.push(`"Updating…" still shown ${STALE / 1000} s after load`);
    else if (state.busy) why.push(`skeleton / spinner still shown ${STALE / 1000} s after load`);
    else if (state.len <= 20) why.push('no content painted');
  }
  if (status && status >= 500) why.push(`page answered ${status}`);
  await ctx.close();
  return { ...job, ms: Date.now() - t0, final: state?.path || null, why: [...new Set(why)] };
}

/** the code this run tested: the git tree of the working copy (the Stop hook compares it with HEAD's, CLAUDE.md "Shipping") */
function testedTree() {
  try {
    const root = path.join(here, '../..');
    const idx = path.join(os.tmpdir(), `sl-site-index-${process.pid}`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: root, env, stdio: 'ignore' });
    const tree = execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
    fs.rmSync(idx, { force: true });
    return tree;
  } catch { return null; }
}

/* ---------- run ---------- */
(async () => {
  const exe = findChromium();
  if (!exe) { console.error('no Chromium: set PLAYWRIGHT_CHROMIUM or `npx playwright-core install chromium` in frontend'); process.exit(1); }
  const tree = testedTree();
  const site = await startSite({ log });
  const { chromium } = playwright();
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  let failed = [];
  const t0 = Date.now();
  try {
    const sample = samplePages(site.dataDir);
    for (const [sp, s] of Object.entries(sample)) for (const [k, v] of Object.entries(s)) if (!v && !(sp === 'tennis' && k === 'team')) log(`note: no ${k} for ${sp} in this database — that page type is not opened`);
    const { pub, admin } = routes(sample);
    // visitors and free users: the public languages; the admin: every language (fix257: ar / he are admin-only until PUBLIC_LANGS names them)
    const sl = siteLanguages();
    const pick = all => list(process.env.SITE_LANGS, all).map(l => (l === 'en' ? '' : l)).filter(l => all.includes(l));
    const langsOf = role => pick(role === 'admin' ? sl.all : sl.public);
    const widths = list(process.env.SITE_WIDTHS, ['375', '1280']).map(Number);
    const roles = list(process.env.SITE_ROLES, ['out', 'free', 'admin']);
    const only = process.env.SITE_ONLY || '';
    const jobs = [];
    const lp = (lang, p) => `${lang ? `/${lang}` : ''}${p === '/' && lang ? '' : p}` || '/';
    if (MODE === 'full') {
      // nightly: every route × every language × both widths × every role
      for (const role of roles) for (const width of widths) {
        for (const lang of langsOf(role)) for (const p of pub) jobs.push({ url: lp(lang, p), width, role });
        if (role === 'admin') for (const p of admin) { jobs.push({ url: p, width, role: 'admin' }); jobs.push({ url: p, width, role: 'admin-locked' }); }
      }
    } else {
      // fix260d — the deploy gate (≈ 10 min in CI): every route in English at 375 + 1280 px as a visitor and the admin
      // (+ every Admin / CRM tab, console signed in and locked), and one page of each type in every other language at
      // 375 px as a visitor (the admin-only languages as the admin)
      const gateRoles = list(process.env.SITE_ROLES, ['out', 'admin']);
      for (const role of gateRoles) for (const width of widths) {
        for (const p of pub) jobs.push({ url: p, width, role });
        if (role === 'admin') for (const p of admin) { jobs.push({ url: p, width, role: 'admin' }); jobs.push({ url: p, width, role: 'admin-locked' }); }
      }
      const one = typeSample(sample);
      for (const lang of sl.all.filter(Boolean)) {
        if (process.env.SITE_LANGS && !pick(sl.all).includes(lang)) continue;
        const role = sl.public.includes(lang) ? 'out' : 'admin';
        for (const p of one) jobs.push({ url: lp(lang, p), width: 375, role });
      }
    }
    // SITE_SHARD=k/n: the k-th of n equal parts (CI runs the parts side by side)
    const [k, nShards] = (process.env.SITE_SHARD || '1/1').split('/').map(Number);
    const todo = jobs.filter(j => !only || j.url.includes(only)).filter((_, i) => i % nShards === k - 1);
    log(MODE === 'full'
      ? `${todo.length} page opens (full): ${pub.length} public routes × ${langsOf('out').length} languages (admin ${langsOf('admin').length}) × ${widths.length} widths × ${roles.length} roles + ${admin.length} admin / CRM routes (console signed in and locked)`
      : `${todo.length} page opens (gate${nShards > 1 ? `, part ${k}/${nShards}` : ''}): ${pub.length} routes in English × ${widths.length} widths × visitor + admin, ${admin.length} admin / CRM routes, ${typeSample(sample).length} page types × ${sl.all.length - 1} other languages at 375 px`);
    // warm-up (not measured): each public route opened once, as the live site's worker has its stored pages built
    // before visitors come — a first-ever build is not what a visitor waits for after a deploy (SITE_WARM=0 skips it)
    if (process.env.SITE_WARM !== '0') {
      // fix260d: one page per worker, reused; a route whose answers were all stored copies (no 202 "pending") is done at
      // once — only a route still being built waits for it
      const warm = [...new Set(todo.filter(j => j.role === 'out' || j.role === 'admin').map(j => j.url.replace(/^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru|ar|he)(?=\/|$)/, '') || '/'))];
      let w = 0, built = 0;
      const jobsW = warm.flatMap(url => [{ url, admin: false }, { url, admin: true }]);
      await Promise.all(Array.from({ length: CONC }, async (_, wi) => {
        // half the workers warm the visitors' copies, half the admin's (fix266: admins have their own stored copies)
        const asAdmin = wi % 2 === 1;
        const ctx = await browser.newContext({ serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': `2001:db8:263::${(++visitor).toString(16)}` } });
        if (asAdmin) await ctx.addCookies([{ name: 'b2b_session', value: TEST_USERS.admin.tokens.unlocked, url: site.base }]);
        const page = await ctx.newPage();
        await page.route(u => new URL(u.href).host !== new URL(site.base).host, r => r.abort('blockedbyclient'));
        let pend = 0;
        page.on('response', r => { if (r.status() === 202 && r.url().includes('/api/')) pend++; });
        for (;;) {
          const i = jobsW.findIndex(j => !j.done && j.admin === asAdmin);
          if (i < 0) break;
          jobsW[i].done = true; w++;
          const url = jobsW[i].url;
          pend = 0;
          await page.goto(site.base + url, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
          await sleep(300);
          if (pend) { built++; await sleep(2500); }
        }
        await ctx.close();
      }));
      log(`warm-up: ${warm.length} routes as a visitor and as the admin, ${built} were still being built`);
    }
    const results = [];
    const slowFirst = [];
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (next < todo.length) {
        const job = todo[next++];
        let r = await check(browser, site.base, job).catch(e => ({ ...job, why: [`test error: ${e.message}`] }));
        // a page that failed ONLY on time (Updating… / skeleton after 3 s) is opened once more: slow again = a failure;
        // fine the second time = listed as a slow first open (report), not a failure. Errors never get a second try.
        if (r.why.length && r.why.every(w => /still shown \d+ s after load/.test(w))) {
          await sleep(1500);
          const again = await check(browser, site.base, job).catch(e => ({ ...job, why: [`test error: ${e.message}`] }));
          if (!again.why.length) { slowFirst.push({ url: job.url, role: job.role, width: job.width, why: r.why }); log(`slow first open (fine the second time) ${job.role} ${job.width}px ${job.url}: ${r.why.join(' | ')}`); }
          r = again.why.length ? { ...again, why: [...new Set([...r.why, ...again.why.map(w => `again: ${w}`)])] } : again;
        }
        results.push(r);
        if (r.why.length) log(`FAIL ${r.role} ${r.width}px ${r.url}: ${r.why.join(' | ')}`);
        if (++done % 100 === 0) log(`${done} / ${todo.length}`);
      }
    }));
    failed = results.filter(r => r.why.length);
    // one line per broken page (all its languages / widths / roles together) for the report and the email
    const byPage = new Map();
    for (const r of failed) {
      const key = r.url.replace(/^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru|ar|he)(?=\/|$)/, '') || '/';
      const e = byPage.get(key) || { page: key, opens: 0, roles: new Set(), widths: new Set(), langs: new Set(), why: new Set() };
      e.opens++; e.roles.add(r.role); e.widths.add(r.width); e.langs.add((/^\/([a-z]{2})(?=\/|$)/.exec(r.url) || [, 'en'])[1]);
      r.why.forEach(w => e.why.add(w));
      byPage.set(key, e);
    }
    const pages = [...byPage.values()].map(e => ({ page: e.page, opens: e.opens, roles: [...e.roles], widths: [...e.widths], languages: [...e.langs], why: [...e.why].slice(0, 8) }));
    fs.writeFileSync(REPORT, JSON.stringify({ test: 'test:site', at: new Date().toISOString(), tree, mode: MODE, full: !process.env.SITE_SHARD && !process.env.SITE_ONLY && !process.env.SITE_LANGS && !process.env.SITE_WIDTHS && !process.env.SITE_ROLES, shard: process.env.SITE_SHARD || null, opened: results.length, failed: failed.length, slowFirstOpens: slowFirst, database: site.copy ? 'copy' : 'seeded', seconds: Math.round((Date.now() - t0) / 1000), pages }, null, 1));
    log(`${results.length} page opens in ${Math.round((Date.now() - t0) / 1000)} s: ${failed.length ? `${failed.length} FAILED on ${pages.length} pages` : 'all passed'} (report ${REPORT})`);
    for (const p of pages) log(`  ✗ ${p.page} — ${p.why.join(' | ')} [${p.roles.join('/')} · ${p.widths.join('/')}px · ${p.languages.length} languages]`);
  } finally {
    await browser.close().catch(() => undefined);
    await site.stop();
  }
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('test:site failed to run:', e); process.exit(1); });

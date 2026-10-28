// fix250: no blank renders on a cold server ׳’ג‚¬ג€ the server (web + worker, dist build, the built site) is started and, as
// soon as its port answers, 20 pages across the sports and languages (this season's match pages and team pages by slug
// from a database copy) are opened one after another in Chromium (playwright-core from frontend/node_modules). For each page: when the
// main area first shows something (the page skeleton or content: "paint") and when it shows real content (text, not
// the skeleton: "content"). Passes when every page paints within 1.5 s and none stays blank.
//
// fix252c: then the "useState of null" checks (two Reacts on one page, 27 Oct) on the two reported pages, each opened cold
// and by in-app navigation from the sport's home: (a) the current build, (b) the app file's first load answered 502
// (the loader reloads, never a second copy of the app file), (c) a tab from an older build (a second build made here
// with every file renamed, its files in the asset archive) navigating after the deploy, (d) the same with its page
// files gone from the archive (one reload onto the new build). Each: 0 page errors / console errors (failed network
// loads aside), and in (c) no file of the new build requested. Passes only when both parts pass.
//
//   LOAD_DATA_DIR=<folder with bet-to-beat.sqlite> node scripts/paint-test.mjs    (after tsc and the frontend build)
//   PAINT_PAGES (20) ײ²ֲ· PAINT_LIMIT_MS (1500) ײ²ֲ· PLAYWRIGHT_CHROMIUM=<chrome.exe> ײ²ֲ· PAINT_SWITCH=0 skips (c)/(d)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../frontend/package.json'));
const { chromium } = require('playwright-core');
const N = Number(process.env.PAINT_PAGES) || 20;
const LIMIT = Number(process.env.PAINT_LIMIT_MS) || 1500;
const log = (...a) => console.log(`[paint ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  const d = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const dir of [process.env.PLAYWRIGHT_BROWSERS_PATH, d, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean)) {
    if (!fs.existsSync(dir)) continue;
    for (const b of fs.readdirSync(dir).filter(x => /^chromium-\d+$/.test(x)).sort().reverse())
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']) if (fs.existsSync(path.join(dir, b, exe))) return path.join(dir, b, exe);
  }
  return null;
}

function pages() {
  const LANGS = ['', '/es', '/de', '/fr', '/it', '/pt', '/tr', '/id', '/hi', '/pl', '/el', '/ru'];
  const list = ['/', '/football', '/basketball', '/american-football', '/tennis', '/es/football/matches', '/de/basketball/matches', '/fr/football/today'];
  if (process.env.LOAD_DATA_DIR) {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(path.join(process.env.LOAD_DATA_DIR, 'bet-to-beat.sqlite'), { readOnly: true });
    const sp = { football: 'football', basketball: 'basketball', nfl: 'american-football', tennis: 'tennis' };
    for (const r of db.prepare(`SELECT sport, kind, slug FROM slugs WHERE is_primary = 1 AND ((kind = 'match' AND slug GLOB '*-2026-1[0-2]-*') OR kind = 'team') AND sport IN ('football', 'basketball', 'nfl', 'tennis') ORDER BY random() LIMIT 40`).all())
      list.push(`${LANGS[list.length % LANGS.length]}/${sp[r.sport] || r.sport}/${r.kind}/${r.slug}`);
    db.close();
  }
  return list.slice(0, N);
}

// fix252c: an older build (every file renamed) in the asset archive, as the server keeps it after a deploy
const FRONT = path.join(here, '../../frontend');
const ARCHIVE = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-paint-archive-'));
const SWITCH = process.env.PAINT_SWITCH !== '0';
const entryOf = html => ({ js: (/src="\/assets\/(index-[^"?]+\.js)"/.exec(html) || [])[1], css: (/href="\/assets\/(index-[^"?]+\.css)"/.exec(html) || [])[1] });
function olderBuild() {
  const out = path.join(ARCHIVE, '..', `${path.basename(ARCHIVE)}-distA`);
  const vite = path.join(FRONT, 'node_modules/vite/bin/vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], { cwd: FRONT, env: { ...process.env, SL_BUILD_SALT: 'paint-A' }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('the older build failed');
  const files = fs.readdirSync(path.join(out, 'assets'));
  for (const f of files) fs.copyFileSync(path.join(out, 'assets', f), path.join(ARCHIVE, f));
  return { html: fs.readFileSync(path.join(out, 'index.html'), 'utf8'), files: new Set(files) };
}

let child = null;
async function start() {
  const port = 3800 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), DATA_DIR: process.env.LOAD_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sl-paint-')), NODE_ENV: 'production', LOG_LEVEL: 'warn',
    BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', SITE_PASSWORD: '', STATIC_DIR: path.join(here, '../../frontend/dist'), ASSET_ARCHIVE_DIR: ARCHIVE };
  for (const k of ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY']) delete env[k];
  child = spawn(process.execPath, ['--no-warnings', path.join(here, '../dist/boot.js')], { env, cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const logFile = fs.createWriteStream(path.join(os.tmpdir(), `sl-paint-server-${port}.log`));
  child.stdout.pipe(logFile); child.stderr.pipe(logFile);
  log(`server log: ${logFile.path}`);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { await fetch(`${base}/favicon.ico`, { signal: AbortSignal.timeout(500) }); log(`port answering after ${Date.now() - t0} ms (cold: no stored page warmed)`); return base; } catch { await sleep(50); }
    if (Date.now() - t0 > 120_000) throw new Error('server did not start');
  }
}

// fix252c: the pages of the 27 Oct "Cannot read properties of null (reading 'useState')" reports
const CRASH_PAGES = ['/basketball/match/al-sadd-vs-qatar-sports-2026-10-10', '/football/team/erzurumspor'];
const assetRefs = html => [...html.matchAll(/\/assets\/([^"'?\s)]+)/g)].map(m => m[1]);

/** open `url` (or the sport's home, then in-app navigation to it) and collect what went wrong */
async function visit(browser, base, { url, nav, mode, older, current }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [], requested = new Set();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('request', r => { const m = /\/assets\/([^/?#]+)/.exec(r.url()); if (m) requested.add(m[1]); });
  if (mode === '502') {
    // the app file's first load fails as during a restart
    let first = true;
    await page.route(/\/assets\/index-[^/?]+\.js$/, r => { if (first) { first = false; return r.fulfill({ status: 502, body: 'Bad Gateway' }); } return r.fallback(); });
  }
  if (older) {
    // a tab opened before the deploy: its page names the older build's files (every /assets name swapped)
    const from = assetRefs(current), to = assetRefs(older.html);
    // only the first opening of that one address (a catch-all route broke socket.io's WebSocket upgrade)
    let doc = true;
    const first = base + (nav ? '/' + url.split('/')[1] : url);
    await page.route(u => u.href === first, async r => {
      if (!doc || r.request().resourceType() !== 'document') return r.fallback();
      doc = false;
      const res = await r.fetch();
      let body = await res.text();
      from.forEach((f, i) => { if (to[i]) body = body.split(`/assets/${f}`).join(`/assets/${to[i]}`); });
      return r.fulfill({ response: res, body });
    });
  }
  const shown = async ms => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => { const m = document.querySelector('main'); return !!m && (m.innerText || '').trim().length > 20 && !m.querySelector('[aria-busy="true"]'); }).catch(() => false);
      if (s) return true;
      await sleep(50);
    }
    return false;
  };
  await page.goto(base + (nav ? '/' + url.split('/')[1] : url), { waitUntil: 'load', timeout: 20_000 }).catch(e => errors.push(`goto: ${e.message}`));
  let ok = await shown(15_000);
  if (nav && ok) {
    await page.evaluate(u => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url);
    await sleep(300);
    ok = await shown(12_000);
  }
  await sleep(1000); // late errors (effects, lazy parts)
  const app = await page.evaluate(() => (document.querySelector('script[type=module][src*="/assets/"]')?.src || '').replace(/^.*\/assets\//, '').split('?')[0]).catch(() => '');
  await ctx.close();
  return { errors, requested, ok, app };
}

async function crashChecks(browser, base, older) {
  const current = await (await fetch(base + '/')).text();
  const newFiles = new Set(fs.readdirSync(path.join(FRONT, 'dist/assets')));
  const newEntry = entryOf(current).js;
  const fails = [];
  const runs = [];
  for (const url of CRASH_PAGES) for (const nav of [false, true]) {
    runs.push({ name: `current ${nav ? 'nav' : 'cold'}`, url, nav });
    runs.push({ name: `502 first ${nav ? 'nav' : 'cold'}`, url, nav, mode: '502' });
    if (older) runs.push({ name: `older tab ${nav ? 'nav' : 'cold'}`, url, nav, older: true });
  }
  const check = (r, res) => {
    const why = [];
    if (res.errors.length) why.push(`${res.errors.length} errors: ${res.errors.map(e => e.split('\n')[0].slice(0, 140)).join(' | ')}`);
    if (!res.ok) why.push('page never showed content');
    if (r.older && !r.gone) {
      const mixed = [...res.requested].filter(f => newFiles.has(f) && !older.files.has(f));
      if (mixed.length) why.push(`older tab asked the new build's ${mixed.join(', ')}`);
    }
    if (r.gone && res.app !== newEntry) why.push(`not reloaded onto the new build (runs ${res.app || 'nothing'})`);
    log(`crash check ${r.name} ${r.url}: ${why.length ? 'FAIL ' + why.join('; ') : 'ok'}`);
    if (why.length) fails.push(`${r.name} ${r.url}`);
  };
  for (const r of runs) check(r, await visit(browser, base, { ...r, older: r.older ? older : null, current }));
  if (older) {
    // (d) the archive no longer has the older build's page files: one reload onto the new build, still no error
    const keep = new Set(assetRefs(older.html));
    for (const f of older.files) if (!keep.has(f) && !newFiles.has(f)) fs.rmSync(path.join(ARCHIVE, f), { force: true });
    for (const url of CRASH_PAGES) { const r = { name: 'older tab, files gone, nav', url, nav: true, older: true, gone: true }; check(r, await visit(browser, base, { ...r, older, current })); }
  }
  return fails;
}

(async () => {
  let failed = false;
  const exe = findChromium();
  if (!exe) { console.error('no Chromium (npx playwright install chromium, or PLAYWRIGHT_CHROMIUM)'); process.exit(1); }
  const list = pages();
  const older = SWITCH ? olderBuild() : null;
  const base = await start();
  // fix252c: the older tab's page is handed over by the test, which Chromium counts as a public address (its socket to 127.0.0.1 blocked)
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const out = [];
  let crashFails = [];
  try {
    for (const p of list) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const t0 = Date.now();
      let paint = null, content = null, status = null;
      const nav = page.goto(base + p, { waitUntil: 'commit', timeout: 20_000 }).then(r => { status = r?.status() ?? null; }, () => undefined);
      while (Date.now() - t0 < 8000 && content === null) {
        const s = await page.evaluate(() => {
          const m = document.querySelector('main');
          if (!m) return { any: false, text: 0, busy: false };
          const r = m.getBoundingClientRect();
          return { any: m.children.length > 0 && r.height > 40, text: (m.innerText || '').trim().length, busy: !!m.querySelector('[aria-busy="true"]') };
        }).catch(() => null);
        if (s?.any && paint === null) paint = Date.now() - t0;
        if (s?.any && s.text > 60 && !s.busy) content = Date.now() - t0;
        await sleep(25);
      }
      await nav;
      out.push({ page: p, status, paintMs: paint, contentMs: content });
      log(`${p}: paint ${paint ?? '׳’ג‚¬ג€'} ms ײ²ֲ· content ${content ?? '׳’ג‚¬ג€'} ms (${status})`);
      await ctx.close();
    }
    crashFails = await crashChecks(browser, base, older);
  } finally { await browser.close(); child?.kill(); }
  const bad = out.filter(x => x.paintMs === null || x.paintMs > LIMIT);
  const c = out.map(x => x.contentMs).filter(x => x !== null).sort((a, b) => a - b);
  const report = { pages: out.length, paintMaxMs: Math.max(...out.map(x => x.paintMs ?? Infinity)), blank: out.filter(x => x.paintMs === null).length,
    contentMedianMs: c[Math.floor(c.length / 2)] ?? null, contentMaxMs: c[c.length - 1] ?? null, noContentIn8s: out.filter(x => x.contentMs === null).map(x => x.page) };
  console.log(`\nPAINT REPORT ${JSON.stringify(report)}`);
  failed = bad.length > 0 || crashFails.length > 0;
  console.log(bad.length ? `FAIL: ${bad.map(x => `${x.page} ${x.paintMs ?? 'blank'}`).join(' ײ²ֲ· ')}` : `PASS: every page painted within ${LIMIT} ms, none blank`);
  console.log(crashFails.length ? `FAIL (fix252c): ${crashFails.join(' ײ²ֲ· ')}` : `PASS (fix252c): the two reported pages, cold and by navigation, current build / 502 first load${older ? ' / older tab across a deploy / its files gone' : ''}: 0 errors`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); child?.kill(); process.exit(1); });

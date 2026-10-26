// fix250: no blank renders on a cold server — the server (web + worker, dist build, the built site) is started and, as
// soon as its port answers, 20 pages across the sports and languages (this season's match pages and team pages by slug
// from a database copy) are opened one after another in Chromium (playwright-core from frontend/node_modules). For each page: when the
// main area first shows something (the page skeleton or content: "paint") and when it shows real content (text, not
// the skeleton: "content"). Passes when every page paints within 1.5 s and none stays blank.
//
//   LOAD_DATA_DIR=<folder with bet-to-beat.sqlite> node scripts/paint-test.mjs    (after tsc and the frontend build)
//   PAINT_PAGES (20) · PAINT_LIMIT_MS (1500) · PLAYWRIGHT_CHROMIUM=<chrome.exe>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  const LANGS = ['', '/es', '/de', '/fr', '/it', '/pt', '/tr'];
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

let child = null;
async function start() {
  const port = 3800 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), DATA_DIR: process.env.LOAD_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sl-paint-')), NODE_ENV: 'production', LOG_LEVEL: 'warn',
    BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', SITE_PASSWORD: '', STATIC_DIR: path.join(here, '../../frontend/dist') };
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

(async () => {
  let failed = false;
  const exe = findChromium();
  if (!exe) { console.error('no Chromium (npx playwright install chromium, or PLAYWRIGHT_CHROMIUM)'); process.exit(1); }
  const list = pages();
  const base = await start();
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const out = [];
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
      log(`${p}: paint ${paint ?? '—'} ms · content ${content ?? '—'} ms (${status})`);
      await ctx.close();
    }
  } finally { await browser.close(); child?.kill(); }
  const bad = out.filter(x => x.paintMs === null || x.paintMs > LIMIT);
  const c = out.map(x => x.contentMs).filter(x => x !== null).sort((a, b) => a - b);
  const report = { pages: out.length, paintMaxMs: Math.max(...out.map(x => x.paintMs ?? Infinity)), blank: out.filter(x => x.paintMs === null).length,
    contentMedianMs: c[Math.floor(c.length / 2)] ?? null, contentMaxMs: c[c.length - 1] ?? null, noContentIn8s: out.filter(x => x.contentMs === null).map(x => x.page) };
  console.log(`\nPAINT REPORT ${JSON.stringify(report)}`);
  failed = bad.length > 0;
  console.log(failed ? `FAIL: ${bad.map(x => `${x.page} ${x.paintMs ?? 'blank'}`).join(' · ')}` : `PASS: every page painted within ${LIMIT} ms, none blank`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); child?.kill(); process.exit(1); });

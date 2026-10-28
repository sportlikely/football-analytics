// fix263: the iPhone report of 28 Oct 12:34 ("app file not started after 6 s (3 tries)", "app started, not shown after
// 20 s", iOS 18.7, home page) on a slow connection. The built site (frontend/dist) is served by a small server that
// answers like a slow phone network — every answer starts after SLOW_RTT_MS (600) and every file shares one SLOW_KBPS pipe
// (40 KB/s) — and the home page is opened in a phone-sized browser with an iPhone user agent. Passes when:
//  - the shell (#sl-shell) is on screen within 1.5 s (painted from index.html before any script arrives),
//  - the app mounts (the shell is gone, #root has the app) with no "Updating SportLikely…" card and no reload,
//  - the loader reported nothing (/api/client-error) — the old loader reloaded at 6 s and threw the download away.
// The API answers { pending: true } (no server data here: the app's own "Updating…" state, never the loader's card).
// Browser: WebKit when playwright has it (SLOW_BROWSER=webkit), else Chromium (this container has Chromium only).
//   node scripts/slow-loader.mjs   (after the frontend build)   ·   SLOW_INDEX=<file> serves another index.html (the
//   old loader, to see the failure) · SLOW_KBPS · SLOW_RTT_MS · SLOW_WAIT_MS (90000)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../../frontend/dist');
const KBPS = Number(process.env.SLOW_KBPS) || 40, RTT = Number(process.env.SLOW_RTT_MS) || 600, WAIT = Number(process.env.SLOW_WAIT_MS) || 90000;
const log = (...a) => console.log(`[slow ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2' };

function loadBrowser() {
  const req = createRequire(path.join(here, '../../frontend/package.json'));
  let pw;
  try { pw = createRequire(import.meta.url)('playwright'); } catch { pw = req('playwright-core'); }
  const want = process.env.SLOW_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  return { type: pw[want], name: want };
}

export async function runSlowLoader({ index = process.env.SLOW_INDEX || path.join(DIST, 'index.html') } = {}) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('frontend/dist is missing: run the frontend build first');
  const html = fs.readFileSync(index, 'utf8');
  const reports = [], pageLoads = [];
  // a slow phone network: each answer waits RTT, then every file shares one KBPS pipe (4 KB pieces, in turn)
  let pipeFree = 0;
  const send = async (res, status, type, body) => {
    await sleep(RTT);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    const per = 4096, msPer = (per / (KBPS * 1024)) * 1000;
    for (let i = 0; i < body.length; i += per) {
      if (res.destroyed) return;
      const now = Date.now(), at = Math.max(now, pipeFree);
      pipeFree = at + msPer;
      if (at + msPer > now) await sleep(at + msPer - now);
      res.write(body.subarray(i, i + per));
    }
    res.end();
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/client-error') {
      let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { reports.push(b.slice(0, 300)); res.writeHead(204).end(); });
      return;
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return void send(res, 202, 'application/json', Buffer.from('{"pending":true,"data":null}'));
    const file = path.join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname !== '/' && file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return void send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
    pageLoads.push(url.pathname + url.search);
    return void send(res, 200, 'text/html; charset=utf-8', Buffer.from(html));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { type, name } = loadBrowser();
  const browser = await type.launch(name === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const out = { browser: name, kbps: KBPS, rttMs: RTT, shellMs: null, mountedMs: null, card: false, pageLoads: 0, reports: [] };
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: name !== 'firefox', hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(base + '/', { waitUntil: 'commit' });
    // the shell: on screen before any script runs
    for (let i = 0; i < 300 && out.shellMs == null; i++) {
      const vis = await page.evaluate(() => { const s = document.getElementById('sl-shell'); return !!s && s.getBoundingClientRect().height > 0 && getComputedStyle(s).display !== 'none'; }).catch(() => false);
      if (vis) out.shellMs = Date.now() - t0; else await sleep(50);
    }
    // the app on screen (the shell removed, #root filled), or the loader's card
    while (Date.now() - t0 < WAIT) {
      const st = await page.evaluate(() => ({
        card: !!document.querySelector('div[role=alert]') && /SportLikely/.test(document.querySelector('div[role=alert]')?.textContent || ''),
        shell: !!document.getElementById('sl-shell'),
        root: (document.getElementById('root')?.children.length || 0) > 0
      })).catch(() => null); // (a navigation in between: the loader reloaded)
      if (st?.card) out.card = true;
      if (st && !st.shell && st.root) { out.mountedMs = Date.now() - t0; break; }
      await sleep(250);
    }
    await sleep(500);
  } finally {
    await browser.close();
    server.close();
  }
  out.pageLoads = pageLoads.length;
  out.reports = reports;
  out.pass = out.shellMs != null && out.shellMs <= 1500 + RTT && out.mountedMs != null && !out.card && out.pageLoads === 1 && !reports.length;
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSlowLoader().then(r => {
    log(JSON.stringify(r));
    log(r.pass ? 'PASS' : 'FAIL');
    process.exit(r.pass ? 0 : 1);
  }, e => { console.error(e); process.exit(1); });
}

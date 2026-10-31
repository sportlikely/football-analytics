// fix287: one live-socket connection per page. App.tsx called socket.connect() while the socket was still connecting;
// that sent a second CONNECT, socket.io closed the whole connection ("invalid state" → forced server close), the page's
// subscribe hit a closing WebSocket ("WebSocket is already in CLOSING or CLOSED state", test:site 4 of 5 runs on the
// football match tabs) and the client connected again a second later — two handshakes on every page load.
// Opens the football match page + its tabs and the home, as a visitor and as the admin, 6 at a time: exactly one
// handshake each, no WebSocket error. (dist + frontend build) Run: npm run test:fix287
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSite, findChromium, playwright } from './site-server.mjs';
import { TEST_USERS } from './site-seed.mjs';

test('one socket connection per page, never closed by the server', { timeout: 300_000 }, async () => {
  const site = await startSite({ log: () => {} });
  const exe = findChromium();
  assert.ok(exe, 'no Chromium (npx playwright-core install chromium in frontend)');
  const browser = await playwright().chromium.launch({ executablePath: exe, headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const M = '/football/match/manchester-city-vs-arsenal-2026-10-29';
  const jobs = [];
  for (let r = 0; r < 3; r++) for (const u of ['', '/stats', '/lineups', '/table', '/h2h'].map(t => M + t).concat('/')) for (const role of ['out', 'admin']) jobs.push([u, role]);
  const bad = [];
  let n = 0;
  const one = async (url, role) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': `2001:db8:287::${(++n).toString(16)}` } });
    if (role === 'admin') await ctx.addCookies([{ name: 'b2b_session', value: TEST_USERS.admin.tokens.unlocked, url: site.base }]);
    const page = await ctx.newPage();
    let handshakes = 0;
    const errs = [];
    page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/socket.io') && u.searchParams.get('transport') === 'polling' && !u.searchParams.get('sid')) handshakes++; });
    page.on('console', m => { if (m.type() === 'error' && /WebSocket/.test(m.text())) errs.push(m.text()); });
    await page.route(u => new URL(u.href).host !== new URL(site.base).host, r => r.abort('blockedbyclient'));
    await page.goto(site.base + url, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(3000);
    await ctx.close();
    if (handshakes !== 1 || errs.length) bad.push(`${role} ${url}: ${handshakes} handshakes${errs.length ? `, ${errs[0]}` : ''}`);
  };
  try {
    await Promise.all(Array.from({ length: 6 }, async () => { while (jobs.length) { const [u, r] = jobs.shift(); await one(u, r); } }));
  } finally { await browser.close(); await site.stop(); }
  assert.deepEqual(bad, [], `pages with more than one socket connection or a WebSocket error:\n${bad.join('\n')}`);
});

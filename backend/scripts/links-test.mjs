// fix260 — npm run test:links: no broken link reaches visitors.
//
// A signed-out visitor in Chromium starts from the sitemaps and the home page of every language, opens each page,
// follows every internal link two levels deep and checks every link it meets:
//   - a relative href (href="player/…" without a leading / — 28 Oct: /basketball/player/lillard-damian/player/damian-lillard)
//   - the address answers 404 / 410 (a past season's match page answers 410 on purpose: allowed) / 5xx
//   - a redirect loop, or more than one redirect hop (old links move in one hop, docs/notes/links.md)
//   - the page opens the app's 404, or the search (a slug the site drew but does not know)
//   - fix280: any match link of the next 7 days on a sport's matches list that is not the slugs table's own slug
// Each broken link is listed with up to three pages that carry it. Outside addresses are not followed.
//
//   npm run test:links          (after `npx tsc` here and `npx vite build` in frontend)
//   SITE_DATA_DIR=<folder with bet-to-beat.sqlite> (else the seeded test data) · LINKS_MAX (4000 pages) ·
//   LINKS_SEEDS (300 sitemap addresses, evenly picked) · SITE_CONCURRENCY (6) · LINKS_REPORT=<file> (backend/links-report.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite, languages, findChromium, playwright, listLinkFailures } from './site-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX = Number(process.env.LINKS_MAX) || 4000;
const SEEDS = Number(process.env.LINKS_SEEDS) || 300;
const CONC = Number(process.env.SITE_CONCURRENCY) || 6;
const DEPTH = 2;
const REPORT = process.env.LINKS_REPORT || path.join(here, '../links-report.json');
const log = (...a) => console.log(`[links ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// pages a signed-out visitor is not meant to open, and files: answer checked, never opened in the browser
const NO_RENDER = /^\/(api|admin|crm|socket\.io|assets)(\/|$)|\.(xml|txt|ics|csv|png|jpg|svg|webp|json|pdf)$/;
const PUBLIC_SITE = /^https?:\/\/(www\.)?sportlikely\.com/;

let httpN = 0;
/** one address over HTTP, redirects followed by hand: the final status and every hop */
async function http(base, url) {
  const hops = [];
  let u = url;
  for (let i = 0; i < 6; i++) {
    let r;
    try { r = await fetch(base + u, { redirect: 'manual', headers: { 'X-Forwarded-For': `2001:db8:262::${(++httpN).toString(16)}`, accept: 'text/html,application/json' }, signal: AbortSignal.timeout(30_000) }); }
    catch (e) { return { status: 0, hops, error: e.message }; }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      const loc = new URL(r.headers.get('location'), base + u);
      const next = loc.origin === new URL(base).origin || PUBLIC_SITE.test(loc.href) ? loc.pathname + loc.search : loc.href;
      if (hops.includes(next) || next === url) return { status: r.status, hops: [...hops, next], loop: true };
      hops.push(next);
      if (!next.startsWith('/')) return { status: 200, hops, outside: true };
      u = next;
      continue;
    }
    const body = r.status === 410 ? await r.text().catch(() => '') : '';
    await r.body?.cancel?.().catch(() => undefined);
    return { status: r.status, hops, past: r.status === 410 && /past.season/i.test(body) };
  }
  return { status: 0, hops, loop: true };
}

(async () => {
  const exe = findChromium();
  if (!exe) { console.error('no Chromium: set PLAYWRIGHT_CHROMIUM'); process.exit(1); }
  const site = await startSite({ log });
  const { chromium } = playwright();
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
  const host = new URL(site.base).host;
  const t0 = Date.now();
  const problems = new Map(); // url → { why, from: Set }
  const add = (url, why, from) => { const p = problems.get(url) || { why: new Set(), from: new Set() }; p.why.add(why); if (from) p.from.add(from); problems.set(url, p); };
  let pagesOpened = 0, checked = 0;
  try {
    // seeds: the language homes + the sitemaps' addresses (evenly picked when there are many)
    const homes = languages().map(l => (l ? `/${l}` : '/'));
    const LANG_PREFIX = new RegExp(`^/(${languages().filter(Boolean).join('|')})(/|$)`);
    const seeds = [...homes];
    const locs = [];
    const idx = await (await fetch(`${site.base}/sitemap.xml`)).text();
    for (const sm of [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])) {
      const p = new URL(sm).pathname;
      const r = await fetch(site.base + p);
      if (r.status !== 200) { add(p, `sitemap answers ${r.status}`, '/sitemap.xml'); continue; }
      const xml = await r.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) locs.push(new URL(m[1]).pathname);
    }
    const step = Math.max(1, Math.ceil(locs.length / SEEDS));
    for (let i = 0; i < locs.length; i += step) seeds.push(locs[i]);
    log(`${locs.length} sitemap addresses (${Math.ceil(locs.length / step)} used) + ${languages().length} language homes`);

    const seen = new Map(); // url → depth
    const queue = [];
    const enqueue = (url, depth, from) => {
      if (seen.has(url) || seen.size >= MAX) return;
      seen.set(url, depth);
      queue.push({ url, depth, from });
    };
    for (const s of seeds) {
      if (!homes.includes(s) && LANG_PREFIX.test(s)) { if (!seen.has(s)) { seen.set(s, 0); queue.push({ url: s, depth: 0, from: '/sitemap.xml', last: true }); } continue; }
      enqueue(s, 0, homes.includes(s) ? 'seed' : '/sitemap.xml');
    }
    const httpCache = new Map();
    const httpOf = url => { if (!httpCache.has(url)) httpCache.set(url, http(site.base, url)); return httpCache.get(url); };

    const visit = async ({ url, depth, from }) => {
      checked++;
      const h = await httpOf(url);
      if (h.loop) return add(url, `redirect loop: ${[url, ...h.hops].join(' → ')}`, from);
      if (h.hops.length > 1) add(url, `${h.hops.length} redirect hops: ${[url, ...h.hops].join(' → ')}`, from);
      if (h.status === 410 && h.past) return; // a past season's match: 410 on purpose
      if (h.status === 0) return add(url, `no answer${h.error ? ` (${h.error})` : ''}`, from);
      if (h.status >= 400) return add(url, `answers ${h.status}`, from);
      const final = h.hops.length ? h.hops[h.hops.length - 1] : url;
      if (h.outside || NO_RENDER.test(final.split('?')[0])) return;
      // open it as a visitor: the app's own 404 / search, and the links it draws
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Forwarded-For': `2001:db8:261::${checked.toString(16)}` } });
      const page = await ctx.newPage();
      await page.route(u => new URL(u.href).host !== host, r => r.abort('blockedbyclient'));
      try {
        await page.goto(site.base + url, { waitUntil: 'load', timeout: 30_000 });
        pagesOpened++;
        // the page's links drawn (lists load after the page): wait until the link count stops growing
        let n = -1;
        for (let i = 0; i < 30; i++) {
          const c = await page.evaluate(() => document.querySelectorAll('a[href]').length).catch(() => 0);
          const busy = await page.evaluate(() => !!document.querySelector('main [aria-busy="true"], main .animate-spin')).catch(() => false);
          if (c === n && !busy && i > 3) break;
          n = c;
          await sleep(200);
        }
        const st = await page.evaluate(() => ({
          path: location.pathname, search: location.search,
          notFound: !!document.querySelector('[data-not-found]'),
          hrefs: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')
        }));
        if (st.notFound) add(url, "opens the app's 404 page", from);
        else if (st.path === '/search' && !/^\/(\w\w\/)?search/.test(url)) add(url, `opens the search (${decodeURIComponent(st.search)}): the site drew a link it does not know`, from);
        for (const raw of new Set(st.hrefs)) {
          if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript|sms|whatsapp):/i.test(raw)) continue;
          if (!/^(\/|https?:\/\/)/i.test(raw)) { add(`${url} → ${raw}`, `relative link href="${raw}" (resolves under the page's own address)`, url); continue; }
          let abs;
          try { abs = new URL(raw, site.base + url); } catch { add(`${url} → ${raw}`, `bad link href="${raw}"`, url); continue; }
          if (abs.host !== host && !PUBLIC_SITE.test(abs.href)) continue;
          const p = abs.pathname + abs.search;
          // a language copy of a page (/es/football/team/x) has the same routes and links as the English one: its address
          // is checked, the English page is the one opened and followed
          if (LANG_PREFIX.test(p) && !homes.includes(p)) { if (!seen.has(p) && seen.size < MAX) { seen.set(p, depth + 1); queue.push({ url: p, depth: depth + 1, from: url, last: true }); } continue; }
          if (depth < DEPTH) enqueue(p, depth + 1, url);
          else if (!seen.has(p) && seen.size < MAX) { seen.set(p, depth + 1); queue.push({ url: p, depth: depth + 1, from: url, last: true }); }
        }
      } catch (e) { add(url, `did not open: ${String(e.message).split('\n')[0]}`, from); }
      await ctx.close();
    };
    // level 3 addresses (links of level-2 pages) are checked but not opened for their own links
    const run = async job => (job.last ? (async () => { checked++; const h = await httpOf(job.url); if (h.loop) add(job.url, `redirect loop: ${[job.url, ...h.hops].join(' → ')}`, job.from); else if (h.status >= 400 && !(h.status === 410 && h.past)) add(job.url, `answers ${h.status}`, job.from); else if (h.hops.length > 1) add(job.url, `${h.hops.length} redirect hops: ${[job.url, ...h.hops].join(' → ')}`, job.from); })() : visit(job));
    let active = 0;
    await new Promise(resolve => {
      const pump = () => {
        while (active < CONC && queue.length) {
          const job = queue.shift();
          active++;
          run(job).catch(e => add(job.url, `test error: ${e.message}`, job.from)).finally(() => {
            active--;
            if (checked % 100 === 0) log(`${checked} checked, ${pagesOpened} opened, ${queue.length} waiting, ${problems.size} broken`);
            pump();
          });
        }
        if (!active && !queue.length) resolve();
      };
      pump();
    });
    // fix280: every match link of the next 7 days on each sport's matches list (all of them, not only the crawled ones)
    for (const r of await listLinkFailures(browser, site, { log })) for (const w of r.why) add(`${r.url} (list links)`, w, r.url);
    const list = [...problems.entries()].map(([url, p]) => ({ url, why: [...p.why], from: [...p.from].filter(f => f !== 'seed').slice(0, 3) }));
    fs.writeFileSync(REPORT, JSON.stringify({ test: 'test:links', at: new Date().toISOString(), checked, opened: pagesOpened, broken: list.length, database: site.copy ? 'copy' : 'seeded', seconds: Math.round((Date.now() - t0) / 1000), links: list }, null, 1));
    log(`${checked} addresses checked, ${pagesOpened} pages opened in ${Math.round((Date.now() - t0) / 1000)} s: ${list.length ? `${list.length} BROKEN` : 'no broken link'} (report ${REPORT})`);
    for (const l of list) log(`  ✗ ${l.url} — ${l.why.join(' | ')}${l.from.length ? ` (on ${l.from.join(', ')})` : ''}`);
    problems.size ? process.exitCode = 1 : process.exitCode = 0;
  } finally {
    await browser.close().catch(() => undefined);
    await site.stop();
  }
  process.exit(process.exitCode ?? 0);
})().catch(e => { console.error('test:links failed to run:', e); process.exit(1); });

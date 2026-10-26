// fix248: load test — 1,000 visitors at once for 5 minutes against the web process (with its worker), the way the
// site is used: the app's pages in every language and sport, the list APIs, the stored routes (workerRoutes.ts) and,
// with a database copy, real match / team pages by slug. Passes when p95 < 1 s, no 5xx and the longest block of the
// web thread < 200 ms (perf.ts loopByMinute: Node's event-loop delay histogram). Reports p50 / p95 / p99, req/s, the
// slowest routes and the stalls with their CPU functions (fix248 profile).
//
//   npm run test:load                      a server started here on an empty database (checks the harness, not the site)
//   LOAD_DATA_DIR=<folder with bet-to-beat.sqlite> npm run test:load     a database copy (Admin → Database backups;
//                                          user tables emptied): the real numbers
//   LOAD_URL=https://… LOAD_TOKEN=…        an already running server (the block measure needs its API_READ_TOKEN)
//   LOAD_USERS (1000) · LOAD_SECONDS (300) · LOAD_THINK_MS (1000: each visitor waits this long between requests)
//   LOAD_STRICT=0                          report only, exit 0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url); // node:sqlite for the slug sample (a database copy, read-only)
const USERS = Number(process.env.LOAD_USERS) || 1000;
const SECONDS = Number(process.env.LOAD_SECONDS) || 300;
const THINK_MS = process.env.LOAD_THINK_MS != null ? Number(process.env.LOAD_THINK_MS) : 1000;
const STRICT = process.env.LOAD_STRICT !== '0';
const TOKEN = process.env.LOAD_TOKEN || (process.env.LOAD_URL ? '' : `load-${Date.now().toString(36)}`);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SportLikelyLoadTest';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[load ${new Date().toISOString().slice(11, 19)}]`, ...a);

/* ---- the server ---- */
let child = null;
let base = process.env.LOAD_URL?.replace(/\/+$/, '') || '';
async function startServer() {
  const dist = path.join(here, '../dist/boot.js');
  if (!fs.existsSync(dist)) throw new Error('no dist build: run tsc first (npm run test:load does)');
  const dataDir = process.env.LOAD_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'sl-load-'));
  if (!process.env.LOAD_DATA_DIR) log(`no LOAD_DATA_DIR: empty database in ${dataDir} (checks the harness; give a database copy for real numbers)`);
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', LOG_LEVEL: 'warn', API_READ_TOKEN: TOKEN,
    BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', SITE_PASSWORD: '' };
  // no data provider is called from a load test
  for (const k of ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY']) delete env[k];
  const web = path.join(here, '../../frontend/dist');
  if (fs.existsSync(web)) env.STATIC_DIR = web;
  child = spawn(process.execPath, ['--no-warnings', dist], { env, cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(os.tmpdir(), `sl-load-server-${port}.log`));
  child.stdout.pipe(out); child.stderr.pipe(out);
  child.on('exit', c => { if (c !== null && !stopping) log(`server exited (${c}) — log: ${out.path}`); });
  base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    try { const r = await fetch(`${base}/api/health`); if (r.status === 200) { log(`server ready in ${Math.round((Date.now() - t0) / 1000)} s (log: ${out.path})`); return; } } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error(`server not ready after 240 s — log: ${out.path}`);
}
let stopping = false;
const stopServer = () => { stopping = true; try { child?.kill(); } catch { /* gone */ } };

/* ---- what visitors open ---- */
function targets() {
  // the samples are read from the source text: loading the module would open a database in this (client) process
  const src = fs.readFileSync(path.join(here, '../src/services/workerRoutes.ts'), 'utf8');
  const WORKER_ROUTES = [...src.matchAll(/\{ path: '[^']+',[^}]*?sample: '([^']+)'(?:, kind: '(\w+)')?/g)].map(m => ({ sample: m[1], kind: m[2] }));
  const PAGE_SAMPLES = [...(src.match(/PAGE_SAMPLES = \[([^\]]+)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const LANGS = ['', '/es', '/de', '/fr', '/it', '/pt', '/tr'];
  const SPORTS = ['football', 'basketball', 'american-football', 'tennis'];
  const pages = ['/'];
  for (const l of LANGS) {
    if (l) pages.push(l);
    for (const s of SPORTS) pages.push(`${l}/${s}`, `${l}/${s}/matches`, `${l}/${s}/today`);
  }
  // the list APIs and stored routes (no id in the sample: an id from the empty sample would only be a 404)
  // a server started here has no data-provider key: a route built from a provider call on request is left out
  const SKIP = process.env.LOAD_SKIP != null ? process.env.LOAD_SKIP.split(',').filter(Boolean) : process.env.LOAD_URL ? [] : ['/api/basketball/standings/'];
  if (SKIP.length) log(`left out (need a data-provider key, none in a local test): ${SKIP.join(', ')}`);
  const apis = WORKER_ROUTES.filter(r => !r.kind && !/\/1(\/|$)/.test(r.sample) && !SKIP.some(s => r.sample.startsWith(s))).map(r => r.sample);
  const slugPages = [];
  if (process.env.LOAD_DATA_DIR) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(process.env.LOAD_DATA_DIR, 'bet-to-beat.sqlite'), { readOnly: true });
      const sp = { football: 'football', basketball: 'basketball', nfl: 'american-football', tennis: 'tennis' };
      for (const r of db.prepare(`SELECT sport, kind, slug FROM slugs WHERE is_primary = 1 AND kind IN ('match', 'team', 'player', 'league') ORDER BY random() LIMIT 400`).all())
        slugPages.push(`${LANGS[Math.floor(Math.random() * LANGS.length)]}/${sp[r.sport] || r.sport}/${r.kind}/${r.slug}`);
      db.close();
    } catch (e) { log(`slug pages: ${e.message}`); }
  }
  const html = [...pages, ...PAGE_SAMPLES.filter(p => !/\/1$/.test(p)), ...slugPages];
  log(`${html.length} pages (${slugPages.length} by slug) · ${apis.length} API routes`);
  // a page load = its HTML, then the app's API calls (about 3 per page)
  return { html, apis };
}

/* ---- the run ---- */
const routeOf = p => p.startsWith('/api/') ? p.replace(/\/\d+(?=\/|$)/g, '/:id') : p.replace(/^(\/(es|de|fr|it|pt|tr))(?=\/|$)/, '/:lang').replace(/\/(match|team|player|league)\/[^/]+$/, '/$1/:slug');
async function run({ html, apis }) {
  const times = [];
  const byStatus = new Map();
  const byRoute = new Map();
  let errors = 0, done = 0;
  const errKinds = new Map();
  const firstBody = new Map(); // the first 5xx answer per route (what it said)
  const end = Date.now() + SECONDS * 1000;
  const one = async (p, ip) => {
    const t0 = performance.now();
    let status = 0;
    try {
      const r = await fetch(base + p, { headers: { 'user-agent': UA, 'x-forwarded-for': ip, accept: p.startsWith('/api/') ? 'application/json' : 'text/html', 'accept-encoding': 'gzip' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      const body = await r.arrayBuffer();
      if (r.status >= 500 && !firstBody.has(routeOf(p))) firstBody.set(routeOf(p), Buffer.from(body).toString('utf8').slice(0, 160));
      status = r.status;
    } catch (e) { errors++; const c = e?.cause?.code || e?.name || 'error'; errKinds.set(c, (errKinds.get(c) || 0) + 1); }
    const ms = performance.now() - t0;
    if (Date.now() > end + 30_000) return;
    times.push(ms); done++;
    byStatus.set(status, (byStatus.get(status) || 0) + 1);
    const k = routeOf(p);
    const e = byRoute.get(k) || { n: 0, ms: [], s5: 0 };
    e.n++; e.ms.push(ms); if (status >= 500 || status === 0) e.s5++;
    byRoute.set(k, e);
  };
  const user = async u => {
    // one address per visitor (trust proxy 1): the per-address limits see 1,000 visitors, not one
    const ip = `10.${(u >> 8) & 255}.${u & 255}.${1 + (u % 250)}`;
    await sleep(Math.random() * Math.min(THINK_MS || 1000, 5000));
    while (Date.now() < end) {
      await one(html[Math.floor(Math.random() * html.length)], ip);
      for (let i = 0; i < 3 && Date.now() < end; i++) {
        if (THINK_MS) await sleep(THINK_MS * (0.5 + Math.random()));
        await one(apis[Math.floor(Math.random() * apis.length)], ip);
      }
      if (THINK_MS) await sleep(THINK_MS * (0.5 + Math.random()));
    }
  };
  const t0 = Date.now();
  const tick = setInterval(() => log(`${done} requests · ${Math.round(done / ((Date.now() - t0) / 1000))} req/s`), 30_000);
  await Promise.all(Array.from({ length: USERS }, (_, u) => user(u)));
  clearInterval(tick);
  return { times, byStatus, byRoute, errors, errKinds, firstBody, secs: (Date.now() - t0) / 1000, startedAt: t0 };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
async function perf() {
  if (!TOKEN) return null;
  try { const r = await fetch(`${base}/api/perf?token=${encodeURIComponent(TOKEN)}`); return r.status === 200 ? (await r.json()).data : null; } catch { return null; }
}

(async () => {
  let failed = false;
  try {
    if (!base) await startServer();
    const t = targets();
    // steady state: the worker has stored every list once (perf.pageLane firstRoundDone), as on a live server
    const WARM_MAX_S = Number(process.env.LOAD_WARM_MAX_S) || 900;
    for (const t0 = Date.now(); TOKEN && Date.now() - t0 < WARM_MAX_S * 1000;) {
      const p = await perf();
      if (p?.worker?.heavy?.pages?.firstRoundDone) { log(`worker: first round of stored pages done (${Math.round((Date.now() - t0) / 1000)} s)`); break; }
      await sleep(5000);
    }
    // warm-up: every address once (the first copies are built by the worker), not counted
    log('warm-up: every page and route once');
    await Promise.all([...t.html, ...t.apis].map(p => fetch(base + p, { headers: { 'user-agent': UA, 'x-forwarded-for': '10.255.255.1' }, redirect: 'manual', signal: AbortSignal.timeout(60_000) }).then(r => r.arrayBuffer(), () => null)));
    await sleep(5000);
    log(`${USERS} visitors for ${SECONDS} s (think time ${THINK_MS} ms)`);
    const r = await run(t);
    // the block measure is per minute: wait for the minute the run ended in
    await sleep(62_000 - (Date.now() % 60_000) + 2000);
    const p = await perf();
    const sorted = r.times.slice().sort((a, b) => a - b);
    const s5 = [...r.byStatus].filter(([s]) => s >= 500 || s === 0).reduce((n, [, c]) => n + c, 0);
    // the minutes that overlap the run (each bucket: from → to, the longest block in it)
    const runEnd = r.startedAt + r.secs * 1000;
    const minutes = (p?.web?.loopByMinute || []).filter(m => Date.parse(m.to) > r.startedAt && Date.parse(m.from) < runEnd);
    const block = minutes.length ? Math.max(...minutes.map(m => m.maxMs)) : null;
    const report = {
      users: USERS, seconds: Math.round(r.secs), thinkMs: THINK_MS, requests: r.times.length, reqPerSec: Math.round(r.times.length / r.secs),
      p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)), max: Math.round(sorted[sorted.length - 1] || 0),
      status: Object.fromEntries([...r.byStatus].sort((a, b) => a[0] - b[0])), fiveXX: s5, networkErrors: r.errors, networkErrorKinds: Object.fromEntries(r.errKinds),
      longestWebBlockMs: block, blockByMinute: minutes,
      fiveXXByRoute: Object.fromEntries([...r.byRoute].filter(([, e]) => e.s5).sort((a, b) => b[1].s5 - a[1].s5).slice(0, 15).map(([k, e]) => [k, { n: e.s5, first: r.firstBody.get(k) || null }])),
      slowestRoutes: [...r.byRoute].map(([k, e]) => { const s = e.ms.sort((a, b) => a - b); return { route: k, n: e.n, p95: Math.round(pct(s, 95)), max: Math.round(s[s.length - 1]), fiveXX: e.s5 }; }).sort((a, b) => b.p95 - a.p95).slice(0, 15),
      webStalls: p ? { shortBlocks: p.web.shortBlocks, stallsLastHour: p.web.stallsLastHour, worstLastHour: p.web.worstLastHour, top: (p.web.topStalls || []).slice(0, 5), cpuTop: (p.web.cpuTop || []).slice(0, 10) } : 'not read (no LOAD_TOKEN)'
    };
    const file = path.join(os.tmpdir(), `sl-load-report-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 1));
    console.log(`\nLOAD REPORT ${JSON.stringify({ ...report, slowestRoutes: report.slowestRoutes.slice(0, 8), blockByMinute: undefined })}\n(full report: ${file})`);
    const why = [];
    if (report.p95 >= 1000) why.push(`p95 ${report.p95} ms ≥ 1000`);
    if (s5) why.push(`${s5} answers 5xx / no answer`);
    if (block === null) why.push('longest web block not measured');
    else if (block >= 200) why.push(`longest web block ${block} ms ≥ 200`);
    console.log(why.length ? `FAIL: ${why.join(' · ')}` : 'PASS: p95 < 1 s, no 5xx, longest web block < 200 ms');
    failed = why.length > 0;
  } catch (e) {
    console.error(`load test: ${e?.stack || e}`);
    failed = true;
  } finally {
    stopServer();
  }
  process.exit(failed && STRICT ? 1 : 0);
})();

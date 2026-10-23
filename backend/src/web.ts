/**
 * fix202: the web process (the container's entry: node dist/web.js). It answers visitors and never builds a page or
 * runs a job:
 *  - stored pages (services/pageCache.ts) straight from the database — the copy for the visitor's plan, trimmed per
 *    user where the route would do it; a copy past its ttl is rebuilt by the worker (we tell it what was asked for);
 *  - the built site's files (/assets, icons);
 *  - the live socket: the worker's live poll writes live_state and sends a message, we re-read those rows and push;
 *  - everything else is passed to the worker (worker.ts → index.ts) on 127.0.0.1:WORKER_PORT, as it came in.
 * It starts the worker as a child process and starts it again if it exits. WORKER=0 runs index.ts alone (one
 * process, as before fix202).
 */
import './utils/env';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import express from 'express';
import helmet from 'helmet';
import logger from './utils/logger';
import { BAD_BOTS } from './utils/badBots';

if (process.env.WORKER === '0') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./index');
} else {
  startWeb();
}

function startWeb() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { perfStatus, track, routeLabel, requestDetail, every } = require('./services/perf') as typeof import('./services/perf');
  const pc = require('./services/pageCache') as typeof import('./services/pageCache');
  const { htmlBuildId } = require('./services/pageBuilder') as typeof import('./services/pageBuilder');
  const auth = require('./services/auth') as typeof import('./services/auth');
  const { unlockedIds, isFinished } = require('./services/billing') as typeof import('./services/billing');
  const { networkOf, loadAsnFile } = require('./services/asn') as typeof import('./services/asn');
  const { liveSocket, pushLive, SITE_PASSWORD } = require('./services/liveSocket') as typeof import('./services/liveSocket');
  /* eslint-enable @typescript-eslint/no-var-requires */
  type Persona = import('./services/pageCache').Persona;

  const PORT = Number(process.env.PORT || 3001);
  const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3901', 10);
  const SECRET = randomBytes(24).toString('hex');
  const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../frontend/dist');
  const INDEX_FILE = path.join(STATIC_DIR, 'index.html');
  const hasSite = fs.existsSync(INDEX_FILE);
  const indexHtml = hasSite ? fs.readFileSync(INDEX_FILE, 'utf8') : '';
  const HTML_BUILD = htmlBuildId(STATIC_DIR);
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';
  const CANONICAL_HOST = process.env.CANONICAL_HOST || (isDev ? '' : 'sportlikely.com');
  // the worker's heap; the web process stays small (the plan's memory holds both)
  const WORKER_HEAP_MB = parseInt(process.env.WORKER_HEAP_MB || '1536', 10);

  /* ---------- the worker ---------- */

  let child: ChildProcess | null = null;
  let ready = false;
  let stopping = false;
  let waiters: (() => void)[] = [];
  const worker = { pid: 0, startedAt: '', readyAt: '', restarts: 0, lastExit: null as string | null, memoryMb: 0, heapMb: 0, statsAt: '' };
  let fastExits = 0;

  function spawnWorker() {
    const ts = __filename.endsWith('.ts');
    const file = path.join(__dirname, ts ? 'worker.ts' : 'worker.js');
    const startedAt = Date.now();
    child = fork(file, [], {
      env: { ...process.env, SL_ROLE: 'worker', SL_INTERNAL_SECRET: SECRET, WORKER_PORT: String(WORKER_PORT) },
      execArgv: [...(ts ? ['-r', 'ts-node/register/transpile-only'] : []), `--max-old-space-size=${WORKER_HEAP_MB}`],
      stdio: 'inherit'
    });
    worker.pid = child.pid || 0; worker.startedAt = new Date(startedAt).toISOString(); worker.readyAt = '';
    child.on('message', onWorkerMessage);
    child.on('exit', (code, signal) => {
      ready = false; child = null;
      worker.lastExit = `${new Date().toISOString()} · code ${code ?? '-'}${signal ? ` · ${signal}` : ''}`;
      if (stopping) return process.exit(0);
      worker.restarts++;
      // a worker that keeps dying right after start waits longer each time (at most 30 s)
      fastExits = Date.now() - startedAt < 5 * 60 * 1000 ? fastExits + 1 : 0;
      const wait = Math.min(30000, 1000 * 2 ** Math.min(5, fastExits));
      logger.error(`worker exited (code ${code}, ${signal || 'no signal'}): starting it again in ${wait / 1000} s`);
      setTimeout(spawnWorker, wait);
    });
  }
  const whenReady = (ms: number) => (ready ? Promise.resolve(true) : new Promise<boolean>(resolve => {
    const t = setTimeout(() => { waiters = waiters.filter(w => w !== done); resolve(false); }, ms);
    const done = () => { clearTimeout(t); resolve(true); };
    waiters.push(done);
  }));

  /* ---------- stored pages ---------- */

  // the last copies read, so a popular page is not read from the database on every request (~64 MB at most)
  const mem = new Map<string, { page: import('./services/pageCache').StoredPage; readAt: number }>();
  let memBytes = 0;
  const memDrop = (k: string) => { const e = mem.get(k); if (e) { memBytes -= e.page.body.length; mem.delete(k); } };
  function storedPage(key: string, persona: Persona, ttlMs: number) {
    const k = `${persona} ${key}`;
    const e = mem.get(k);
    if (e && Date.now() - e.readAt < Math.min(ttlMs, 60000)) { mem.delete(k); mem.set(k, e); return e.page; }
    const page = pc.readPage(key, persona);
    memDrop(k);
    if (page) {
      mem.set(k, { page, readAt: Date.now() });
      memBytes += page.body.length;
      while (memBytes > 64 * 1048576 && mem.size > 1) memDrop(mem.keys().next().value as string);
    }
    return page;
  }
  const hits = new Set<string>(), missed = new Set<string>();
  const front = { stored: 0, trimmed: 0, toWorker: 0, workerDown: 0, missed: 0, since: new Date().toISOString() };
  every('report page hits', () => {
    if (!child || !ready || (!hits.size && !missed.size)) return;
    child.send({ type: 'hits', keys: [...hits], missed: [...missed] }, () => undefined);
    hits.clear(); missed.clear();
  }, 2000).unref();

  /** who is asking, as a stored-page plan — null = pass the request to the worker (admin, staff, data-centre networks) */
  function visitorOf(req: express.Request): { access: Persona; userId: number | null } | null {
    let user: import('./services/auth').User | null = null;
    try { user = auth.userForToken(auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE]); } catch { return null; }
    const access = auth.accessOf(user);
    if (access === 'admin' || auth.permsOf(user).length) return null;
    // fix199: data-centre / proxy addresses have their own limits and rules (index.ts)
    if (!user?.emailVerified && req.ip && networkOf(req.ip)) return null;
    return { access, userId: user?.id ?? null };
  }
  const canonicalOk = (req: express.Request) => {
    if (!CANONICAL_HOST) return true;
    const host = (req.hostname || '').toLowerCase();
    return !host.endsWith(CANONICAL_HOST) || (host === CANONICAL_HOST && req.secure);
  };
  const security = helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } });

  function servePage(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (req.method !== 'GET' || SITE_PASSWORD || !canonicalOk(req)) return next();
    const rule = pc.ruleFor(req.path);
    if (!rule || (rule.html && !hasSite)) return next();
    const key = pc.pageKey(req.path, req.query as Record<string, unknown>);
    if (!key) return next();
    const who = visitorOf(req);
    if (!who) return next();
    let persona = rule.persona(who.access);
    // a signed-in user's unlocked games: the football lists are the full copy trimmed for this user (as the auth
    // middleware does); the other sports decide per game inside the route
    let keep: Set<number> | null = null;
    if (who.userId != null && rule.unlocks !== 'none' && persona !== 'pro') {
      const ids = unlockedIds(who.userId);
      if (ids.size) { if (rule.unlocks === 'proxy') return next(); keep = ids; persona = 'pro'; }
    }
    const page = storedPage(key, persona, rule.ttlMs);
    if (!page || (rule.html && page.build !== HTML_BUILD)) { missed.add(key); front.missed++; return next(); }
    hits.add(key);
    const done = track(routeLabel(req.method, req.path), requestDetail(req.path, req.query as any));
    res.on('finish', done); res.on('close', done);
    security(req, res, () => {
      let body = page.body;
      if (keep) {
        const ids = keep;
        body = JSON.stringify(auth.teaseDeepExcept(JSON.parse(body), (id, status) => ids.has(id) || isFinished(status)));
        front.trimmed++;
      }
      front.stored++;
      res.status(page.status);
      for (const [h, v] of Object.entries(page.headers)) res.set(h, v);
      if (req.path.startsWith('/api/')) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.set('X-Stored-Age', String(Math.round((Date.now() - page.builtAt) / 1000)));
      res.send(body);
    });
  }

  /* ---------- passing requests to the worker ---------- */

  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  async function toWorker(req: express.Request, res: express.Response) {
    if (!ready && !(await whenReady(20000))) return workerDown(req, res);
    // not a running job here (only waiting): a stall in this process never names the requests it passed on
    front.toWorker++;
    const headers = { ...req.headers };
    delete headers['x-sl-build']; delete headers['x-sl-persona'];
    const seen = req.socket.remoteAddress || '';
    const xff = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = xff ? `${Array.isArray(xff) ? xff.join(', ') : xff}, ${seen}` : seen;
    const up = http.request({ host: '127.0.0.1', port: WORKER_PORT, method: req.method, path: req.originalUrl, headers, agent }, ur => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) workerDown(req, res); else res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }
  function workerDown(req: express.Request, res: express.Response) {
    front.workerDown++;
    // a page: the app itself (it loads its data when the server is back); an API call: try again shortly
    if (req.method === 'GET' && !req.path.startsWith('/api/') && hasSite) return res.status(200).set('Cache-Control', 'no-cache').type('html').send(indexHtml);
    res.status(503).set('Retry-After', '5').json({ error: 'The server is restarting. Please try again in a few seconds.' });
  }

  /* ---------- the server ---------- */

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const server = http.createServer(app);
  // bad bots get the worker's 403 (it notes them); nothing from here
  app.use((req, res, next) => (BAD_BOTS.test(req.get('user-agent') || '') ? toWorker(req, res) : next()));
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime(), worker: { ready, restarts: worker.restarts } });
  });
  if (hasSite && !SITE_PASSWORD) {
    // files under /assets have a content hash in their name: cached for a year; a missing one is a plain 404 (fix167)
    app.use('/assets', express.static(path.join(STATIC_DIR, 'assets'), { index: false, maxAge: '365d', immutable: true }));
    app.use('/assets', (_req, res) => { res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found'); });
    app.use(express.static(STATIC_DIR, { index: false, maxAge: '7d' }));
  }
  app.use(servePage);
  app.use((req, res) => { void toWorker(req, res); });

  /* ---------- live socket ---------- */

  const io = liveSocket(server);
  const liveGames = new Map<number, any>();
  function onLive(m: { sport: string; ids: number[]; changed: number[] }) {
    if (m.sport !== 'football' || !Array.isArray(m.ids)) return;
    const order = m.ids.filter(id => Number.isInteger(id));
    // the rows that changed, and any we have not read yet (a web process started after the worker)
    const read = [...new Set([...(m.changed || []), ...order.filter(id => !liveGames.has(id))])];
    for (const r of pc.readLive('football', read)) liveGames.set(r.id, JSON.parse(r.json));
    const want = new Set(order);
    for (const id of [...liveGames.keys()]) if (!want.has(id)) liveGames.delete(id);
    const live = order.map(id => liveGames.get(id)).filter(Boolean);
    void pushLive(io, live).catch(e => logger.warn(`live push: ${e?.message || e}`));
  }

  function onWorkerMessage(m: any) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ready') {
      ready = true; worker.readyAt = new Date().toISOString();
      logger.info(`worker ready (pid ${worker.pid}, ${Math.round((Date.now() - Date.parse(worker.startedAt)) / 1000)} s after start)`);
      const w = waiters; waiters = []; w.forEach(f => f());
    } else if (m.type === 'built' && typeof m.key === 'string') {
      for (const k of [...mem.keys()]) if (k.slice(k.indexOf(' ') + 1) === m.key) memDrop(k);
    } else if (m.type === 'live') {
      onLive(m);
    } else if (m.type === 'stats') {
      worker.memoryMb = m.memoryMb; worker.heapMb = m.heapMb; worker.statsAt = new Date(m.at).toISOString();
    } else if (m.type === 'ask' && m.what === 'perf') {
      child?.send({ type: 'answer', id: m.id, data: { perf: perfStatus(), front: { ...front, memoryCopies: mem.size, memoryCopiesMb: Math.round(memBytes / 1048576) }, worker: { ...worker, heapLimitMb: WORKER_HEAP_MB } } }, () => undefined);
    }
  }

  // data-centre ranges: the worker downloads them; read the file now and then
  loadAsnFile();
  every('asn file', () => loadAsnFile(), 6 * 3600 * 1000).unref();

  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${sig}: stopping the worker and the web process`);
    server.close();
    if (child) child.kill('SIGTERM'); else process.exit(0);
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    logger.info(`Web process on http://localhost:${PORT} (stored pages, files, live socket); starting the worker`);
    spawnWorker();
  });
}

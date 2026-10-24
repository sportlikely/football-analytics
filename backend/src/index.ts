/**
 * Web entry (fix202). This process answers requests and reads the database: the API, the pages, the live socket.
 * Every scheduled job (live polls, fixtures, results, models, warmers …) runs in a worker process started from here
 * (worker.ts, same SQLite file in WAL mode) and restarted if it exits; the worker publishes model state
 * (services/shared.ts), stored pages (services/pageCache.ts) and live games (services/liveState.ts).
 * WORKER=0 runs everything in this one process, as before fix202.
 */
import dotenv from 'dotenv';
// Load .env from backend root (in production the host injects env vars and there is no file)
const envResult = dotenv.config();
if (envResult.error && process.env.NODE_ENV !== 'production') console.error('❌ Error loading .env:', envResult.error.message);
process.env.SL_ROLE = process.env.WORKER === '0' ? 'all' : 'web';

import http from 'http';
import path from 'path';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import logger from './utils/logger';
import { app, SITE_AUTH, corsOrigin, allowedOrigins, isDev } from './app';
import { parseCookies, userForToken, canSeeFull, accessOf, SESSION_COOKIE, teaseDeep } from './services/auth';
import { setJob } from './services/perf';
import { isWeb } from './services/role';
import { attachWorker } from './services/ipc';
import { onLive, loadLiveRows } from './services/liveState';
import { noteGameView, onBox } from './services/gameViews';
import { loadNewerStates, sharedStatus } from './services/shared';
import { markReady } from './services/readiness';
import { markStartupDone } from './services/perf';
import { WORKER_PORT } from './services/forward';
import { workerState, type WorkerReport } from './services/workerHealth';
import { heapShareMb } from './utils/memLimit';
import { exitReason, saveWorkerExit, startPerfHistory } from './services/perfHistory';

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  // Socket.io bypasses Express middleware, so the gate is applied here too
  allowRequest: (req, cb) => cb(null, !SITE_AUTH || req.headers.authorization === SITE_AUTH)
});

// Each socket joins 'full' (premium/admin) or 'teaser' (anonymous/free) — predictions are trimmed for 'teaser'
io.use((socket, next) => {
  try {
    const cookies = parseCookies(socket.request.headers.cookie);
    const user = userForToken(cookies[SESSION_COOKIE]);
    socket.data.full = canSeeFull(accessOf(user));
  } catch {
    socket.data.full = false;
  }
  next();
});

io.on('connection', socket => {
  logger.info(`Client connected: ${socket.id}`);

  const tier = socket.data.full ? 'full' : 'teaser';
  socket.join(tier);

  socket.on('subscribe_match', (matchId: number) => {
    const id = Number(matchId);
    if (!Number.isInteger(id) || id <= 0) return;
    // one match page at a time is plenty: drop older match rooms
    for (const room of socket.rooms) if (room.startsWith('match:') && room !== `match:${id}:${tier}`) socket.leave(room);
    socket.join(`match:${id}:${tier}`);
  });

  socket.on('unsubscribe_match', (matchId: number) => {
    socket.leave(`match:${matchId}:${tier}`);
  });

  // fix208: a basketball / American-football game page (its live box score); one game room at a time
  socket.on('subscribe_game', (m: { sport?: string; id?: number }) => {
    const sport = m?.sport === 'nfl' ? 'nfl' : m?.sport === 'bb' ? 'bb' : null, id = Number(m?.id);
    if (!sport || !Number.isInteger(id) || id <= 0) return;
    for (const room of socket.rooms) if (room.startsWith('game:') && room !== `game:${sport}:${id}`) socket.leave(room);
    socket.join(`game:${sport}:${id}`);
    noteGameView(sport, id);
  });
  socket.on('unsubscribe_game', (m: { sport?: string; id?: number }) => {
    socket.leave(`game:${m?.sport === 'nfl' ? 'nfl' : 'bb'}:${Number(m?.id)}`);
  });

  socket.on('disconnect', reason => {
    logger.info(`Client disconnected: ${socket.id} (${reason})`);
  });
});

app.set('io', io);

// Live scores to every client: the whole list, and each changed match to its own room (score / status / minute).
// fix202: the list comes from the worker's live tick (live_state + an IPC message); in one process from the tick itself.
onLive((sport, all, changed) => {
  if (sport !== 'football') return;
  const ts = new Date().toISOString();
  io.to('full').emit('matches:live', { data: all, timestamp: ts });
  io.to('teaser').emit('matches:live', teaseDeep({ data: all, timestamp: ts }));
  for (const m of changed) {
    io.to(`match:${m.id}:full`).emit('match:live', m);
    io.to(`match:${m.id}:teaser`).emit('match:live', teaseDeep({ m }).m);
  }
});

// fix208: a game's live box score was stored — one message to the pages that have it open (they reload the box score)
onBox((sport, id, at) => { io.to(`game:${sport}:${id}`).emit(`${sport}Box`, { id, at }); });
// pages left open count as watched (the worker fetches their box score every 60 s): the rooms are swept every minute
setInterval(() => {
  for (const [room, members] of io.sockets.adapter.rooms) {
    const m = /^game:(bb|nfl):(\d+)$/.exec(room);
    if (m && members.size) noteGameView(m[1] as 'bb' | 'nfl', Number(m[2]));
  }
}, 60 * 1000).unref();

/* ---------- the worker process ---------- */

// the key the worker's port asks for (services/forward.ts reads it in both processes)
const INTERNAL_KEY = randomBytes(24).toString('hex');
process.env.SL_INTERNAL_KEY = INTERNAL_KEY;
let worker: ChildProcess | null = null;
let stopping = false;

// fix210: a worker that keeps dying waits 5 s, then 30 s, then 2 min before each next try (a run of 10+ min resets it)
const RESTART_WAIT_MS = [5_000, 30_000, 120_000];
let quickFails = 0;

function startWorker() {
  // dist/worker.js under node; worker.ts under ts-node-dev (development)
  const ts = __filename.endsWith('.ts');
  const file = path.join(__dirname, ts ? 'worker.ts' : 'worker.js');
  // fix210: min(WORKER_HEAP_MB, 55% of the container's memory limit)
  const heap = heapShareMb('worker');
  workerState.heap = heap;
  const execArgv = [...(ts ? ['-r', 'ts-node/register/transpile-only'] : []), `--max-old-space-size=${heap.heapMb}`];
  // fix210: its stderr passes through this process (still printed), so the last 50 lines say why it ended
  const child = fork(file, [], {
    env: { ...process.env, SL_ROLE: 'worker', SL_INTERNAL_KEY: INTERNAL_KEY, WORKER_PORT: String(WORKER_PORT) },
    execArgv,
    stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
    serialization: 'advanced' // fix210b: the web process's queued writes carry Buffers (deferredWrites.ts)
  });
  const tail: string[] = [];
  let partial = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    const lines = (partial + chunk.toString('utf8')).split('\n');
    partial = lines.pop() || '';
    for (const l of lines) if (l.trim()) { tail.push(l.slice(0, 500)); if (tail.length > 50) tail.shift(); }
  });
  worker = child;
  workerState.pid = child.pid || null;
  workerState.startedAt = Date.now();
  attachWorker(child);
  child.on('message', (m: any) => { if (m?.t === 'health') workerState.report = m as WorkerReport; });
  child.on('exit', (code, signal) => {
    if (partial.trim()) tail.push(partial.slice(0, 500));
    const ranMin = Math.round((Date.now() - workerState.startedAt) / 60000);
    const reason = stopping ? 'stopped (SIGTERM)' : exitReason(code, signal, tail);
    workerState.lastExit = { at: new Date().toISOString(), code, signal, ranMin, reason, stderr: tail.slice(-50) };
    workerState.pid = null;
    worker = null;
    attachWorker(null);
    saveWorkerExit({ code, signal, reason, ranMin, heapLimitMb: heap.heapMb, stderr: tail });
    if (stopping) return;
    workerState.restarts++;
    quickFails = ranMin >= 10 ? 1 : quickFails + 1;
    const wait = RESTART_WAIT_MS[Math.min(quickFails, RESTART_WAIT_MS.length) - 1];
    logger.warn(`worker exited (${reason}; code ${code}, signal ${signal}, ran ${ranMin} min): restart in ${Math.round(wait / 1000)} s`);
    setTimeout(startWorker, wait).unref();
  });
}

const shutdown = (sig: string) => {
  stopping = true;
  logger.info(`${sig}: stopping`);
  worker?.kill('SIGTERM');
  server.close();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT || 3001;
/*
 * fix210b: the web process loads the model state the worker left (and the live list) BEFORE it listens: on 24 Oct the
 * first requests after a deploy waited behind the state loads (6.8 s "state load nfl", 3.1 s "state load squad").
 * Railway keeps the old instance serving until /api/health answers, so nobody waits for this.
 */
const ready: Promise<void> = isWeb
  ? (async () => {
    const t0 = Date.now();
    setJob('start: state load');
    try { loadLiveRows(); await loadNewerStates(); } finally { setJob(null); }
    // fix212b: only now may a request be answered (app.ts answers 503 before); the load's stalls are counted apart
    markReady({ loadMs: Date.now() - t0, states: Object.keys(sharedStatus()).length });
    markStartupDone();
    logger.info(`start: ${Object.keys(sharedStatus()).length} shared state(s) loaded in ${Date.now() - t0} ms — listening now`);
  })()
  : (markReady({ loadMs: 0, states: 0 }), markStartupDone(), Promise.resolve());
ready.catch(e => { logger.warn(`start: state load: ${e?.message || e}`); markReady({ loadMs: -1, states: 0 }); markStartupDone(); }).finally(() => server.listen(PORT, () => {
  setJob('boot (scheduler start)'); setImmediate(() => setJob(null)); // fix165: the sync start-up work is named in /api/perf
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`WebSocket server ready (CORS: ${isDev ? 'any origin [dev]' : allowedOrigins.join(', ')})`);
  startPerfHistory('web'); // fix210: this process's hourly stalls and memory (perf_hours)
  if (isWeb) {
    // fix202: serve straight away from the stored pages and the model state the worker left; then start the worker
    workerState.enabled = true;
    if (process.env.WORKER_SPAWN !== '0') startWorker(); // WORKER_SPAWN=0: a test boots the web role alone
  } else {
    // WORKER=0: every job in this process (the scheduler module is only loaded here)
    void import('./jobs').then(j => j.startJobs()).catch(e => logger.error(`jobs: ${e?.message || e}`));
  }
}));

export { app, io };

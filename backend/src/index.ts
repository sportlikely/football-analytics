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
import { loadNewerStates } from './services/shared';
import { WORKER_PORT } from './services/forward';
import { workerState, type WorkerReport } from './services/workerHealth';

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

/* ---------- the worker process ---------- */

// the key the worker's port asks for (services/forward.ts reads it in both processes)
const INTERNAL_KEY = randomBytes(24).toString('hex');
process.env.SL_INTERNAL_KEY = INTERNAL_KEY;
let worker: ChildProcess | null = null;
let stopping = false;

function startWorker() {
  // dist/worker.js under node; worker.ts under ts-node-dev (development)
  const ts = __filename.endsWith('.ts');
  const file = path.join(__dirname, ts ? 'worker.ts' : 'worker.js');
  const heap = parseInt(process.env.WORKER_HEAP_MB || '1536', 10);
  const execArgv = [...(ts ? ['-r', 'ts-node/register/transpile-only'] : []), `--max-old-space-size=${heap}`];
  const child = fork(file, [], {
    env: { ...process.env, SL_ROLE: 'worker', SL_INTERNAL_KEY: INTERNAL_KEY, WORKER_PORT: String(WORKER_PORT) },
    execArgv
  });
  worker = child;
  workerState.pid = child.pid || null;
  workerState.startedAt = Date.now();
  attachWorker(child);
  child.on('message', (m: any) => { if (m?.t === 'health') workerState.report = m as WorkerReport; });
  child.on('exit', (code, signal) => {
    const ranMin = Math.round((Date.now() - workerState.startedAt) / 60000);
    workerState.lastExit = { at: new Date().toISOString(), code, signal, ranMin };
    workerState.pid = null;
    worker = null;
    attachWorker(null);
    if (stopping) return;
    workerState.restarts++;
    // quick restart; a worker that keeps dying waits longer (up to a minute) before the next try
    const wait = ranMin >= 10 ? 1000 : Math.min(60_000, 2000 * 2 ** Math.min(5, workerState.restarts - 1));
    logger.warn(`worker exited (code ${code}, signal ${signal}, ran ${ranMin} min): restart in ${Math.round(wait / 1000)} s`);
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
server.listen(PORT, () => {
  setJob('boot (scheduler start)'); setImmediate(() => setJob(null)); // fix165: the sync start-up work is named in /api/perf
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`WebSocket server ready (CORS: ${isDev ? 'any origin [dev]' : allowedOrigins.join(', ')})`);
  if (isWeb) {
    // fix202: serve straight away from the stored pages and the model state the worker left; then start the worker
    workerState.enabled = true;
    loadLiveRows();
    setTimeout(() => { void loadNewerStates(); }, 1000).unref();
    startWorker();
  } else {
    // WORKER=0: every job in this process (the scheduler module is only loaded here)
    void import('./jobs').then(j => j.startJobs()).catch(e => logger.error(`jobs: ${e?.message || e}`));
  }
});

export { app, io };

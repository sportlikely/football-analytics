/**
 * fix227: the container's entry (Dockerfile CMD). It listens on PORT before the app's modules load (several seconds:
 * "module load before listen" in /api/perf) — with a volume Railway cannot overlap two deployments, so until something
 * listens the proxy answers 502 to visitors. This listener sends the built site's files and the plain app page at once
 * (services/earlyStatic.ts) and 503 + Retry-After for the API and /health; then index.ts loads and takes the same
 * server over (its request handler replaces this one). While the modules load synchronously a request waits in the
 * connection queue instead of being refused. `node dist/index.js` alone still works (it listens itself).
 */
import http from 'http';
import { serveEarly } from './services/earlyStatic';
import { startCpuProfile } from './services/cpuProfile';

const PORT = process.env.PORT || 3001;
const gated = !!process.env.SITE_PASSWORD; // the private beta gate: only the app's files go early

// fix238: an API call (not /health) waits for the app instead of a 503: handed to it once index.ts has taken the
// server over (its own start-up gate then answers or waits for the state); 30 s at most
const WAIT_MS = Number(process.env.STARTUP_WAIT_MS) || 30000;
const holdForApp = (req: http.IncomingMessage, res: http.ServerResponse, t0 = Date.now()) => {
  const app = (globalThis as any).__slApp;
  if (app) return app(req, res);
  if (res.writableEnded || req.destroyed) return;
  if (Date.now() - t0 > WAIT_MS) return starting(res);
  setTimeout(() => holdForApp(req, res, t0), 100);
};
const starting = (res: http.ServerResponse) => {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'Starting up', ready: false }));
};

const server = http.createServer((req, res) => {
  if ((!gated || (req.url || '').startsWith('/assets/')) && serveEarly(req, res)) return;
  const url = req.url || '';
  if (!gated && url.startsWith('/api/') && !url.startsWith('/api/health')) return holdForApp(req, res);
  starting(res);
});
// fix248: the rolling CPU profile starts before the modules load (the start-up load is profiled too)
startCpuProfile();
server.listen(PORT, () => {
  (globalThis as any).__slBootServer = server;
  require('./index');
});

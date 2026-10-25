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

const PORT = process.env.PORT || 3001;
const gated = !!process.env.SITE_PASSWORD; // the private beta gate: only the app's files go early

const server = http.createServer((req, res) => {
  if ((!gated || (req.url || '').startsWith('/assets/')) && serveEarly(req, res)) return;
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'Starting up', ready: false }));
});
server.listen(PORT, () => {
  (globalThis as any).__slBootServer = server;
  require('./index');
});

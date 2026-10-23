/**
 * fix202: admin and staff requests (everything outside the public API) are answered by the worker, which holds the
 * job state, the backtests and the rebuild buttons: the web process passes them on to the worker's own copy of the
 * app on 127.0.0.1 (WORKER_PORT, default PORT + 1), body and all, before reading the body itself. The worker's port
 * answers only requests carrying the key the web process gave it at start (SL_INTERNAL_KEY).
 */
import http from 'node:http';
import type express from 'express';
import { workerConnected } from './ipc';

export const WORKER_PORT = Number(process.env.WORKER_PORT) || (Number(process.env.PORT) || 3001) + 1;
export const INTERNAL_HEADER = 'x-sl-internal';
export const internalKey = () => process.env.SL_INTERNAL_KEY || '';

const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const busy = (res: express.Response) => {
  if (!res.headersSent) res.status(503).set('Retry-After', '10').json({ error: 'The background service is restarting. Try again in a minute.' });
  else res.end();
};

export function forwardToWorker(req: express.Request, res: express.Response) {
  if (!workerConnected()) return busy(res);
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  // the worker trusts one proxy hop: the visitor's address and scheme as this process saw them
  headers['x-forwarded-for'] = req.ip || '';
  headers['x-forwarded-proto'] = req.protocol;
  headers[INTERNAL_HEADER] = internalKey();
  const up = http.request({ host: '127.0.0.1', port: WORKER_PORT, method: req.method, path: req.originalUrl, headers, agent }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => busy(res));
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

/** worker: only the web process may call the worker's port */
export const fromWebProcess = (req: http.IncomingMessage) => !!internalKey() && req.headers[INTERNAL_HEADER] === internalKey();

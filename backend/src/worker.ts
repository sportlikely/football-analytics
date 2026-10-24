/**
 * Worker entry (fix202): every scheduled job of the site (jobs.ts), started by the web process as a child process
 * (index.ts) with the same database file. It also answers the admin / staff requests the web process passes on
 * (services/forward.ts), on 127.0.0.1 only, from its own copy of the app: the job state and the rebuild buttons live
 * here. Every 10 s it reports its health to the web process (/api/perf → worker). It exits when the web process goes.
 */
import dotenv from 'dotenv';
dotenv.config();
process.env.SL_ROLE = 'worker';

import http from 'http';
import logger from './utils/logger';
import { app } from './app';
import { startJobs } from './jobs';
import { fromWebProcess, WORKER_PORT } from './services/forward';
import v8 from 'node:v8';
import { perfStatus, memByJob, sampleHeap } from './services/perf';
import { startPerfHistory } from './services/perfHistory';
import { sendIpc } from './services/ipc';
import { sharedStatus } from './services/shared';

const server = http.createServer((req, res) => {
  if (fromWebProcess(req)) return app(req, res);
  res.statusCode = 403;
  res.end('Forbidden');
});
server.listen(WORKER_PORT, '127.0.0.1', () => logger.info(`worker ${process.pid}: admin requests on 127.0.0.1:${WORKER_PORT}`));

startJobs();
startPerfHistory('worker'); // fix210: hourly stalls and memory (perf_hours), read by data health and /api/perf

const health = () => {
  const p = perfStatus();
  const mem = process.memoryUsage();
  // each job: when it last ran, how long it took, the worst stall while it ran (the http entries are the forwarded admin requests)
  // fix210: + the heap each run added (heapDeltaMb, worst maxHeapDeltaMb) and the highest heap while it ran
  const jobs = Object.fromEntries(Object.entries(p.jobs).filter(([k]) => !k.startsWith('http ')).map(([k, j]: [string, any]) => [k, { lastAt: j.lastAt, lastMs: j.lastMs, maxMs: j.maxMs, runs: j.runs, maxStallMs: j.maxStallMs, heapDeltaMb: j.heapDeltaMb, maxHeapDeltaMb: j.maxHeapDeltaMb, peakHeapMb: j.peakHeapMb }]));
  const now = sampleHeap();
  sendIpc({
    t: 'health', at: Date.now(), pid: process.pid, uptimeMin: Math.round(process.uptime() / 60), memoryMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
    heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
    perf: { stallsLastHour: p.stallsLastHour, worstLastHour: p.worstLastHour, running: p.running, heavy: p.heavy, recentStalls: p.recentStalls.slice(0, 10), topStalls: p.topStalls },
    jobs, shared: sharedStatus(), memByJob: memByJob(), running: now.running.map(label => ({ label, heapMb: now.heapMb }))
  });
};
setInterval(health, 10 * 1000).unref();
setTimeout(health, 2000).unref();

// the web process went away (deploy, crash): this one goes too
process.on('disconnect', () => { logger.info('worker: web process gone, exiting'); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });

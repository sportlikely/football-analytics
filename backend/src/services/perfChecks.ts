/**
 * fix210: data-health checks so the freezes and the memory crash never come back unseen (targets from fix202/fix210):
 * - Web stalls:       error when the web process had more than 5 stalls (over 300 ms) in the last hour or one over 500 ms
 * - Worker stalls:    error when the worker's event loop was blocked over 2 s in the last hour
 * - Worker memory:    warning when the worker's heap is over 70% of its limit
 * - Worker restarts:  warning at 1 restart in 24 h, error at 3 (with the exit reason)
 * Each lists the top offenders. Runs in the worker (the data-health job): its own numbers are live, the web process's
 * come from perf_hours (written every minute). In one process (WORKER=0) only the web check applies, from memory.
 */
import v8 from 'node:v8';
import { isWorker } from './role';
import { perfStatus, memByJob, hourBuckets } from './perf';
import { perfHours, workerExits, type HourRow } from './perfHistory';
import type { Check } from './dataHealth';

const WEB_MAX_STALLS = 5, WEB_MAX_MS = 500, WORKER_MAX_MS = 2000, HEAP_WARN = 0.7;

const topLines = (rows: { top: { ms: number; job: string | null }[] }[]) =>
  rows.flatMap(r => r.top).sort((a, b) => b.ms - a.ms).slice(0, 8).map(s => `${s.ms} ms${s.job ? ` · ${s.job}` : ''}`);

/** the last 60 minutes of a process's hourly rows (the current hour and the one before, the stalls of both) */
function lastHour(rows: HourRow[], now: number): HourRow[] {
  const cur = new Date(now).toISOString().slice(0, 13), prev = new Date(now - 3600 * 1000).toISOString().slice(0, 13);
  return rows.filter(r => r.hour === cur || r.hour === prev);
}

export function perfChecks(now = Date.now()): Check[] {
  const checks: Check[] = [];
  // ---------- web process ----------
  // (an hour = the current clock hour and the one before: the numbers can only be read per hour, so this is up to 2 h)
  const web = isWorker ? lastHour(perfHours('web', 3), now) : lastHour(hourBuckets(), now);
  const webStalls = Math.max(0, ...web.map(r => r.stalls)), webWorst = Math.max(0, ...web.map(r => r.worstMs));
  checks.push({
    id: 'perf:web-stalls', label: 'Web stalls (pages never wait)',
    level: webStalls > WEB_MAX_STALLS || webWorst > WEB_MAX_MS ? 'fail' : 'ok',
    detail: web.length ? `${webStalls} stall(s) over 300 ms in the last hour, worst ${webWorst} ms (target: at most ${WEB_MAX_STALLS}, none over ${WEB_MAX_MS} ms)` : 'No numbers yet',
    items: topLines(web)
  });
  if (!isWorker) return checks;
  // ---------- worker process (this one) ----------
  const p = perfStatus();
  checks.push({
    id: 'perf:worker-stalls', label: 'Worker stalls (background jobs give the thread back)',
    level: p.worstLastHour > WORKER_MAX_MS ? 'fail' : 'ok',
    detail: `${p.stallsLastHour} stall(s) over 300 ms in the last hour, worst ${p.worstLastHour} ms (target: none over ${WORKER_MAX_MS / 1000} s)`,
    items: p.topStalls.slice(0, 8).map(s => `${s.ms} ms${s.job ? ` · ${s.job}` : ''}`)
  });
  const heap = process.memoryUsage().heapUsed, limit = v8.getHeapStatistics().heap_size_limit;
  const share = heap / limit;
  checks.push({
    id: 'perf:worker-memory', label: 'Worker memory',
    level: share > HEAP_WARN ? 'warn' : 'ok',
    detail: `Heap ${Math.round(heap / 1048576)} MB of ${Math.round(limit / 1048576)} MB (${Math.round(share * 100)}%; warning over ${HEAP_WARN * 100}%)`,
    items: memByJob().map(j => `${j.job}: +${j.maxHeapDeltaMb} MB in one run, heap up to ${j.peakHeapMb} MB`)
  });
  const exits = workerExits(24 * 3600 * 1000);
  checks.push({
    id: 'perf:worker-restarts', label: 'Worker restarts',
    level: exits.length >= 3 ? 'fail' : exits.length >= 1 ? 'warn' : 'ok',
    detail: exits.length ? `Worker restarted ${exits.length} time(s) in 24 h; last: ${exits[0].reason}` : 'No restart in 24 h',
    items: exits.slice(0, 10).map(x => `${x.at.slice(0, 16).replace('T', ' ')} UTC · ${x.reason} · ran ${x.ranMin} min${x.stderr.length ? ` · ${x.stderr[x.stderr.length - 1].slice(0, 140)}` : ''}`)
  });
  return checks;
}

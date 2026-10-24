/**
 * fix202: the worker process as the web process sees it (for /api/perf): running or not, restarts, the last exit and
 * the worker's own health report (sent every 10 s: last run of each job, memory, its own stalls).
 * fix210: the exit reason and the worker's last stderr lines, restarts in the last 24 h, the heap sizes (the
 * container's limit and each process's share), the jobs that grew the heap most (memByJob) and the 24-h history.
 */
import v8 from 'node:v8';
import { heapShareMb, containerLimitMb } from '../utils/memLimit';
import { perfHours, workerExits } from './perfHistory';

export interface WorkerReport { at: number; pid: number; uptimeMin: number; memoryMb: number; heapMb: number; heapLimitMb?: number; perf: any; jobs: Record<string, any>; shared: any; memByJob?: any[]; running?: { label: string; heapMb: number }[] }

const state = {
  enabled: false,
  pid: null as number | null,
  startedAt: 0,
  restarts: 0,
  lastExit: null as null | { at: string; code: number | null; signal: string | null; ranMin: number; reason?: string; stderr?: string[] },
  heap: null as null | ReturnType<typeof heapShareMb>,
  report: null as WorkerReport | null
};

export const workerState = state;

/** heap sizes: the container's limit and what each process got (fix210) */
export function memorySizing() {
  return {
    containerLimitMb: containerLimitMb(),
    web: { heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), share: heapShareMb('web') },
    worker: state.heap || heapShareMb('worker'),
    thread: heapShareMb('thread')
  };
}

export function workerHealth() {
  if (!state.enabled) return { on: false, note: 'WORKER=0: every job runs in this process' };
  const r = state.report;
  const exits = (() => { try { return workerExits(); } catch { return []; } })();
  return {
    on: !!state.pid,
    pid: state.pid,
    upMin: state.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : null,
    restarts: state.restarts,
    restarts24h: exits.length,
    lastExit: state.lastExit,
    // fix210: why it ended each time in the last 24 h (newest first, the stderr lines in lastExit)
    exits24h: exits.map(({ stderr, ...x }) => ({ ...x, stderrTail: stderr.slice(-5) })),
    reportAgeS: r ? Math.round((Date.now() - r.at) / 1000) : null,
    memoryMb: r?.memoryMb ?? null,
    heapMb: r?.heapMb ?? null,
    heapLimitMb: r?.heapLimitMb ?? state.heap?.heapMb ?? null,
    // the jobs whose runs grew the heap most, and the heap of each job running now
    memByJob: r?.memByJob ?? [],
    runningHeap: r?.running ?? [],
    // the worker's own event loop (it is allowed to be busy; visitors never wait for it)
    stallsLastHour: r?.perf?.stallsLastHour ?? null,
    worstLastHour: r?.perf?.worstLastHour ?? null,
    running: r?.perf?.running ?? null,
    heavy: r?.perf?.heavy ?? null,
    topStalls: r?.perf?.topStalls ?? [],
    // last run of each job: when, how long, the worst stall while it ran, the heap it added
    jobs: r?.jobs ?? {},
    shared: r?.shared ?? {},
    hours: (() => { try { return perfHours('worker'); } catch { return []; } })()
  };
}

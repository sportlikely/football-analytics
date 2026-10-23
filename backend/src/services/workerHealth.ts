/**
 * fix202: the worker process as the web process sees it (for /api/perf): running or not, restarts, the last exit and
 * the worker's own health report (sent every 10 s: last run of each job, memory, its own stalls).
 */
export interface WorkerReport { at: number; pid: number; uptimeMin: number; memoryMb: number; heapMb: number; perf: any; jobs: Record<string, any>; shared: any }

const state = {
  enabled: false,
  pid: null as number | null,
  startedAt: 0,
  restarts: 0,
  lastExit: null as null | { at: string; code: number | null; signal: string | null; ranMin: number },
  report: null as WorkerReport | null
};

export const workerState = state;

export function workerHealth() {
  if (!state.enabled) return { on: false, note: 'WORKER=0: every job runs in this process' };
  const r = state.report;
  return {
    on: !!state.pid,
    pid: state.pid,
    upMin: state.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : null,
    restarts: state.restarts,
    lastExit: state.lastExit,
    reportAgeS: r ? Math.round((Date.now() - r.at) / 1000) : null,
    memoryMb: r?.memoryMb ?? null,
    heapMb: r?.heapMb ?? null,
    // the worker's own event loop (it is allowed to be busy; visitors never wait for it)
    stallsLastHour: r?.perf?.stallsLastHour ?? null,
    worstLastHour: r?.perf?.worstLastHour ?? null,
    running: r?.perf?.running ?? null,
    heavy: r?.perf?.heavy ?? null,
    // last run of each job: when, how long, the worst stall while it ran
    jobs: r?.jobs ?? {},
    shared: r?.shared ?? {}
  };
}

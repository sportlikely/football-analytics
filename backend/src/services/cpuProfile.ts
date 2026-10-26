/**
 * fix248: what code ran during a web stall. Nine fixes (135 … 243) guessed the cause from the perf labels (the jobs and
 * requests in flight); here the web process keeps a rolling CPU profile (workers/cpuProfiler.ts: an inspector session
 * on this thread, 5 ms sampling, parsed in that thread) and every stall over 300 ms gets the top 15 functions by
 * self-time in its window (answered at the profile's next swap: every 5 min, CPU_PROFILE_ROTATE_S) (file:line in the .ts source, the callers of the top 5). /api/perf → web.diagStalls (the last
 * stalls with their functions) and web.cpuTop (the functions summed over every profiled stall since the start).
 * Started from boot.ts before the modules load (so the start-up load is profiled too). CPU_PROFILE=0 turns it off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';

export type CpuFn = { fn: string; at: string; ms: number; pct: number; stack?: string[] };
export type CpuResult = { covered: boolean; sampledMs: number; top: CpuFn[] };

const ROTATE_MS = (Number(process.env.CPU_PROFILE_ROTATE_S) || 300) * 1000;
let w: Worker | null = null;
let ready = false;
let seq = 0;
const pending = new Map<number, (r: CpuResult | null) => void>();
const stats = { profiled: 0, notCovered: 0, errors: 0, startedAt: '', error: '' as string };
/** every profiled stall's functions added up: what to fix first */
const totals = new Map<string, { fn: string; at: string; ms: number; stalls: number }>();

function threadFile(): { file: string; execArgv?: string[] } | null {
  const js = path.join(__dirname, '../workers/cpuProfiler.js');
  if (fs.existsSync(js)) return { file: js };
  const ts = path.join(__dirname, '../workers/cpuProfiler.ts');
  if (fs.existsSync(ts)) return { file: ts, execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return null;
}

/** start the profiler thread (once; the process serving visitors only) */
export function startCpuProfile() {
  if (w || !isMainThread || process.env.CPU_PROFILE === '0') return;
  const f = threadFile();
  if (!f) return;
  try {
    const t = new Worker(f.file, {
      execArgv: f.execArgv, resourceLimits: { maxOldGenerationSizeMb: 192 },
      workerData: { intervalUs: Number(process.env.CPU_PROFILE_US) || 5000, rotateMs: ROTATE_MS }
    });
    t.unref();
    t.on('message', (m: any) => {
      if (m?.ready) { ready = true; stats.startedAt = new Date().toISOString(); return; }
      if (m?.fatal) { stats.error = m.fatal; return; }
      const cb = pending.get(m?.id);
      if (!cb) return;
      pending.delete(m.id);
      if (m.error) { stats.errors++; stats.error = m.error; cb(null); return; }
      cb({ covered: !!m.covered, sampledMs: m.sampledMs, top: m.top || [] });
    });
    const down = (e: string) => { if (w === t) { w = null; ready = false; stats.error = e; } for (const [id, cb] of pending) { pending.delete(id); cb(null); } };
    t.on('error', e => down(e.message));
    t.on('exit', c => down(`profiler thread stopped (${c})`));
    w = t;
  } catch (e: any) { stats.error = String(e?.message || e); }
}

/** the functions that ran between two process.hrtime.bigint() readings (ns) */
export function profileWindow(fromNs: bigint, toNs: bigint, n = 15): Promise<CpuResult | null> {
  if (!w || !ready) return Promise.resolve(null);
  const id = ++seq;
  return new Promise(resolve => {
    // the answer comes at the next swap (at most ROTATE_MS)
    const timer = setTimeout(() => { if (pending.delete(id)) resolve(null); }, ROTATE_MS + 60_000);
    timer.unref();
    pending.set(id, r => {
      clearTimeout(timer);
      if (r) {
        stats.profiled++;
        if (!r.covered) stats.notCovered++;
        for (const f of r.top) {
          const k = `${f.fn}|${f.at}`;
          const e = totals.get(k) || { fn: f.fn, at: f.at, ms: 0, stalls: 0 };
          e.ms += f.ms; e.stalls++;
          totals.set(k, e);
        }
        if (totals.size > 2000) for (const [k] of [...totals.entries()].sort((a, b) => a[1].ms - b[1].ms).slice(0, 1000)) totals.delete(k);
      }
      resolve(r);
    });
    w!.postMessage({ id, fromUs: Number(fromNs / 1000n), toUs: Number(toNs / 1000n), n });
  });
}

/** answer the waiting windows now (one profiler restart: a short block of its own) — tests */
export const flushCpuProfile = () => { w?.postMessage({ flush: true }); };

/** /api/perf: the functions with the most self-time over every profiled stall */
export const cpuTop = (n = 15) => [...totals.values()].sort((a, b) => b.ms - a.ms).slice(0, n);
export const cpuProfileStatus = () => ({ on: !!w && ready, ...stats });

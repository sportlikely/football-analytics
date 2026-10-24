/**
 * fix210: the container's memory limit (cgroup v2 memory.max, or v1 memory.limit_in_bytes) and each process's heap
 * share of it. The worker gets min(WORKER_HEAP_MB, 55% of the limit), the web process min(WEB_HEAP_MB, 30%), a job
 * thread (basketball model, national Elo, more-predictions backtests) min(THREAD_HEAP_MB 768, 20%) — fix210b: the
 * backtests need ~400 MB; one job thread at a time (heavy queue). The rest is native memory (SQLite, buffers). Without a
 * readable limit (Windows, a laptop) the env values (or the defaults) are used as they are.
 *
 * No imports from the app: the Dockerfile runs `node dist/utils/memLimit.js web` to get the web heap before start.
 */
import fs from 'node:fs';

const FILES = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];

/** the container's memory limit in MB, or null (none set / not readable) */
export function containerLimitMb(): number | null {
  for (const f of FILES) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (!/^\d+$/.test(v)) continue; // "max" = no limit
      const mb = Math.floor(Number(v) / 1048576);
      // v1 reports "no limit" as a huge number
      if (mb > 0 && mb < 4 * 1024 * 1024) return mb;
    } catch { /* not there */ }
  }
  return null;
}

export type HeapRole = 'web' | 'worker' | 'thread';
const SHARE: Record<HeapRole, number> = { web: 0.3, worker: 0.55, thread: 0.2 };
const DEFAULT: Record<HeapRole, number> = { web: 1024, worker: 1536, thread: 768 };
const ENV: Record<HeapRole, string> = { web: 'WEB_HEAP_MB', worker: 'WORKER_HEAP_MB', thread: 'THREAD_HEAP_MB' };

/** heap (MB) for this role: the env value (or default), capped at the role's share of the container limit */
export function heapShareMb(role: HeapRole, limitMb = containerLimitMb()): { heapMb: number; limitMb: number | null; source: string } {
  const env = parseInt(process.env[ENV[role]] || '', 10);
  const want = env > 0 ? env : DEFAULT[role];
  if (!limitMb) return { heapMb: want, limitMb: null, source: env > 0 ? ENV[role] : 'default' };
  const cap = Math.max(128, Math.floor(limitMb * SHARE[role]));
  return cap < want
    ? { heapMb: cap, limitMb, source: `${Math.round(SHARE[role] * 100)}% of ${limitMb} MB` }
    : { heapMb: want, limitMb, source: env > 0 ? ENV[role] : 'default' };
}

// `node dist/utils/memLimit.js web` → prints the web heap in MB (Dockerfile)
if (require.main === module) {
  const role = (process.argv[2] as HeapRole) || 'web';
  process.stdout.write(String(heapShareMb(SHARE[role] ? role : 'web').heapMb));
}

/**
 * fix254: every SQLite connection gets a real page cache. Railway's volume answers an uncached page read in tens to
 * hundreds of ms under load: an indexed one-row lookup (page_cache built_at, shared_state versions) took 1.7–1.9 s on
 * 28 Oct because SQLite's default cache is 2 MB per connection and the hot index pages kept falling out of it.
 *  - cache_size: the worker 128 MB, the web 64 MB, a job thread 64 MB (pages actually read, not reserved) — cut to fit
 *    when the container's limit is small (all caches together ≤ 1/4 of the limit)
 *  - mmap_size: the file's pages come from the OS page cache, shared by every connection of the container
 *  - temp_store = MEMORY: sorts and temp indexes never touch the volume
 * fix269: the volume stalled for seconds on 28 Oct (worst 4 KB read 7.6 s, worst fsync 15 s): the reader threads keep
 * the hot set in memory — big pool 1 GB a thread, small pool 512 MB a thread (2 + 2 threads = 3 GB at most, filled
 * only by pages read; a page another thread read is in that thread's cache, not this one's), mmap 2 GB (SQLite caps it
 * at its build's maximum, ~2 GB). WAL frames (pages written since the last checkpoint) are read through the cache, not
 * the map: that is where a freshly built page lives.
 * No app imports (the reader threads load it).
 */
import { containerLimitMb } from './memLimit';

// fix263: readerSmall = the small reader pool (index pages and rows under 64 KB)
export type DbUse = 'reader' | 'readerSmall' | 'worker' | 'web' | 'thread' | 'all';
const WANT_MB: Record<DbUse, number> = { reader: 1024, readerSmall: 512, worker: 128, web: 64, thread: 64, all: 256 };
export const MMAP_BYTES = 2048 * 1048576;
/** fix269: the reader threads of each pool (a plain number = that many threads, each counted at the big pool's size) */
export type Readers = number | { small: number; big: number };

/** every cache of the container together (MB), at the wanted sizes */
export function cacheTotalMb(readers: Readers = { small: 2, big: 2 }): number {
  const r = typeof readers === 'number' ? WANT_MB.reader * readers : WANT_MB.readerSmall * readers.small + WANT_MB.reader * readers.big;
  return r + WANT_MB.worker + WANT_MB.web + WANT_MB.thread;
}
/** cache MB for this connection: the wanted size, scaled down when the container limit can't hold them all */
export function cacheMbFor(use: DbUse, limitMb: number | null = containerLimitMb(), readers: Readers = { small: 2, big: 2 }): number {
  const want = WANT_MB[use];
  if (!limitMb) return want;
  const total = cacheTotalMb(readers);
  const room = Math.floor(limitMb / 4);
  return total <= room ? want : Math.max(16, Math.floor((want * room) / total));
}

/** the PRAGMA statements for a connection (negative cache_size = KiB) */
export function tunePragmas(use: DbUse, limitMb: number | null = containerLimitMb(), readers: Readers = { small: 2, big: 2 }): string[] {
  return [`PRAGMA cache_size = ${-cacheMbFor(use, limitMb, readers) * 1024}`, `PRAGMA mmap_size = ${MMAP_BYTES}`, 'PRAGMA temp_store = MEMORY'];
}

/** apply them (a failing one — an old SQLite build without mmap — is skipped) */
export function tuneDb(db: { exec(sql: string): void }, use: DbUse, readers?: Readers): string[] {
  const done: string[] = [];
  for (const p of tunePragmas(use, containerLimitMb(), readers || { small: 2, big: 2 })) { try { db.exec(p); done.push(p); } catch { /* not supported here */ } }
  return done;
}

/** fix269 (/api/perf, data health): each connection's cache as configured here, and the container limit */
export function cachePlan(readers: Readers = { small: 2, big: 2 }, limitMb: number | null = containerLimitMb()) {
  const n = typeof readers === 'number' ? { small: 0, big: readers } : readers;
  return {
    limitMb, mmapMb: MMAP_BYTES / 1048576, readers: n,
    bigMb: cacheMbFor('reader', limitMb, readers), smallMb: cacheMbFor('readerSmall', limitMb, readers),
    workerMb: cacheMbFor('worker', limitMb, readers), webMb: cacheMbFor('web', limitMb, readers),
    readersTotalMb: n.big * cacheMbFor('reader', limitMb, readers) + n.small * cacheMbFor('readerSmall', limitMb, readers)
  };
}

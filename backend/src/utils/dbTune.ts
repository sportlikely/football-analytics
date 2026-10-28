/**
 * fix254: every SQLite connection gets a real page cache. Railway's volume answers an uncached page read in tens to
 * hundreds of ms under load: an indexed one-row lookup (page_cache built_at, shared_state versions) took 1.7–1.9 s on
 * 28 Oct because SQLite's default cache is 2 MB per connection and the hot index pages kept falling out of it.
 *  - cache_size: readers 256 MB, the worker 128 MB, the web 64 MB, a job thread 64 MB (pages actually read, not
 *    reserved) — cut to fit when the container's limit is small (all caches together ≤ 1/4 of the limit)
 *  - mmap_size 1 GB: the file's pages come from the OS page cache, shared by every connection of the container
 *  - temp_store = MEMORY: sorts and temp indexes never touch the volume
 * No app imports (the reader threads load it).
 */
import { containerLimitMb } from './memLimit';

// fix263: readerSmall = the small reader pool (index pages and rows under 64 KB)
export type DbUse = 'reader' | 'readerSmall' | 'worker' | 'web' | 'thread' | 'all';
const WANT_MB: Record<DbUse, number> = { reader: 256, readerSmall: 64, worker: 128, web: 64, thread: 64, all: 256 };
export const MMAP_BYTES = 1024 * 1048576;

/** cache MB for this connection: the wanted size, scaled down when the container limit can't hold them all */
export function cacheMbFor(use: DbUse, limitMb: number | null = containerLimitMb(), readers = 2): number {
  const want = WANT_MB[use];
  if (!limitMb) return want;
  // fix263: `readers` = every reader thread (small + big pools), counted at the big pool's size (the upper bound)
  const total = WANT_MB.reader * readers + WANT_MB.worker + WANT_MB.web + WANT_MB.thread;
  const room = Math.floor(limitMb / 4);
  return total <= room ? want : Math.max(16, Math.floor((want * room) / total));
}

/** the PRAGMA statements for a connection (negative cache_size = KiB) */
export function tunePragmas(use: DbUse, limitMb: number | null = containerLimitMb(), readers = 2): string[] {
  return [`PRAGMA cache_size = ${-cacheMbFor(use, limitMb, readers) * 1024}`, `PRAGMA mmap_size = ${MMAP_BYTES}`, 'PRAGMA temp_store = MEMORY'];
}

/** apply them (a failing one — an old SQLite build without mmap — is skipped) */
export function tuneDb(db: { exec(sql: string): void }, use: DbUse, readers?: number): string[] {
  const done: string[] = [];
  for (const p of tunePragmas(use, containerLimitMb(), readers || 2)) { try { db.exec(p); done.push(p); } catch { /* not supported here */ } }
  return done;
}

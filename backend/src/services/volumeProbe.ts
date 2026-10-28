/**
 * fix254: how fast is the Railway volume? Every 15 minutes the worker reads 32 random 4 KB blocks of the database file
 * (fs.read on libuv's pool: the event loop never waits) and writes + fsyncs one 4 KB probe file in DATA_DIR. The OS may
 * have some of the blocks in memory (that is what SQLite sees too); the slowest read and the fsync show the disk itself.
 * Kept for 24 h in memory (worker): data health "Disk" and
 * /api/admin/db-space.
 * fix269: every 10 min (144 runs = 24 h); data health "Volume latency" (volumeHealth): red when a run in the last hour
 * had p95 over 500 ms, yellow when one in the last 24 h did, each such hour listed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE } from '../db';
import logger from '../utils/logger';

export type VolumeSample = { at: string; reads: number; p50: number; p95: number; max: number; fsyncMs: number | null };
const samples: VolumeSample[] = [];

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function probeVolume(file = DB_FILE, dir = path.dirname(DB_FILE), n = 32): Promise<VolumeSample> {
  const ms: number[] = [];
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(4096);
    const blocks = Math.max(1, Math.floor(size / 4096));
    for (let i = 0; i < n; i++) {
      const at = Math.floor(Math.random() * blocks) * 4096;
      const t0 = performance.now();
      await fh.read(buf, 0, 4096, at);
      ms.push(performance.now() - t0);
    }
  } finally { await fh.close(); }
  let fsyncMs: number | null = null;
  try {
    const p = path.join(dir, '.volume-probe');
    const t0 = performance.now();
    const w = await fs.promises.open(p, 'w');
    try { await w.write(Buffer.alloc(4096, 1), 0, 4096, 0); await w.sync(); } finally { await w.close(); }
    fsyncMs = r1(performance.now() - t0);
  } catch { /* read-only volume */ }
  const s: VolumeSample = { at: new Date().toISOString(), reads: ms.length, p50: r1(pct(ms, 50)), p95: r1(pct(ms, 95)), max: r1(Math.max(...ms)), fsyncMs };
  samples.push(s);
  while (samples.length > 144) samples.shift();
  return s;
}

/** the last 24 h: the latest run, and the worst p95 / max / fsync */
export function volumeLatency() {
  const last = samples[samples.length - 1] || null;
  if (!last) return null;
  return {
    last, runs: samples.length,
    worstP95: Math.max(...samples.map(x => x.p95)), worstMax: Math.max(...samples.map(x => x.max)),
    worstFsync: Math.max(0, ...samples.map(x => x.fsyncMs ?? 0)), medianP50: pct(samples.map(x => x.p50), 50)
  };
}
export const volumeLine = () => {
  const v = volumeLatency();
  if (!v) return 'Volume latency: not measured yet (every 10 min)';
  return `Volume latency (4 KB random reads, ${v.runs} run(s) in 24 h): now p50 ${v.last.p50} ms, p95 ${v.last.p95} ms, max ${v.last.max} ms, fsync ${v.last.fsyncMs ?? '–'} ms · worst p95 ${v.worstP95} ms, worst read ${v.worstMax} ms, worst fsync ${v.worstFsync} ms`;
};
/** fix269: the runs per UTC hour (newest first): runs, worst p95, worst read, worst fsync */
export function volumeHours(now = Date.now(), list: VolumeSample[] = samples) {
  const by = new Map<string, VolumeSample[]>();
  for (const s of list) { if (now - Date.parse(s.at) > 24 * 3600_000) continue; const h = s.at.slice(0, 13); let l = by.get(h); if (!l) by.set(h, (l = [])); l.push(s); }
  return [...by].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([hour, l]) => ({
    hour, runs: l.length, p95: Math.max(...l.map(x => x.p95)), max: Math.max(...l.map(x => x.max)), fsyncMs: Math.max(0, ...l.map(x => x.fsyncMs ?? 0))
  }));
}
export const VOLUME_RED_P95 = 500;
/** fix269: the data-health row (pragmas: what the connections run with, from dbSpace.ts) */
export function volumeHealth(now = Date.now(), list: VolumeSample[] = samples, notes: string[] = []) {
  const hours = volumeHours(now, list);
  const label = 'Volume latency';
  if (!hours.length) return { id: 'volume-latency', label, level: 'ok' as const, detail: 'Not measured yet (every 10 min, first run 2 min after a start)', items: notes };
  const bad = hours.filter(h => h.p95 > VOLUME_RED_P95);
  const lastHour = list.filter(s => now - Date.parse(s.at) <= 3600_000);
  const redNow = lastHour.some(s => s.p95 > VOLUME_RED_P95);
  const last = list[list.length - 1];
  const hh = (h: string) => `${h.slice(11, 13)}:00 UTC`;
  return {
    id: 'volume-latency', label,
    level: (redNow ? 'fail' : bad.length ? 'warn' : 'ok') as 'fail' | 'warn' | 'ok',
    detail: `Last run ${last.at.slice(11, 16)} UTC: p95 ${last.p95} ms, slowest read ${last.max} ms, fsync ${last.fsyncMs ?? '–'} ms`
      + (bad.length ? ` · p95 over ${VOLUME_RED_P95} ms in ${bad.length} hour(s) of the last 24 h: ${bad.slice(0, 6).map(h => `${hh(h.hour)} (${h.p95.toLocaleString('en-US')} ms)`).join(', ')}` : ` · p95 under ${VOLUME_RED_P95} ms all of the last 24 h`),
    items: [...hours.map(h => `${hh(h.hour)} ${h.hour.slice(0, 10)}: ${h.runs} run(s), p95 ${h.p95.toLocaleString('en-US')} ms, slowest read ${h.max.toLocaleString('en-US')} ms, fsync ${h.fsyncMs.toLocaleString('en-US')} ms${h.p95 > VOLUME_RED_P95 ? ' — slow' : ''}`), ...notes]
  };
}
export async function volumeTick() {
  try { const s = await probeVolume(); logger.info(`volume latency: p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms, fsync ${s.fsyncMs ?? '–'} ms`); }
  catch (e: any) { logger.warn(`volume latency: ${e?.message || e}`); }
}

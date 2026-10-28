/**
 * fix254: how fast is the Railway volume? Every 15 minutes the worker reads 32 random 4 KB blocks of the database file
 * (fs.read on libuv's pool: the event loop never waits) and writes + fsyncs one 4 KB probe file in DATA_DIR. The OS may
 * have some of the blocks in memory (that is what SQLite sees too); the slowest read and the fsync show the disk itself.
 * Kept for 24 h in memory (worker): data health "Disk" and
 * /api/admin/db-space.
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
  while (samples.length > 96) samples.shift();
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
  if (!v) return 'Volume latency: not measured yet (every 15 min)';
  return `Volume latency (4 KB random reads, ${v.runs} run(s) in 24 h): now p50 ${v.last.p50} ms, p95 ${v.last.p95} ms, max ${v.last.max} ms, fsync ${v.last.fsyncMs ?? '–'} ms · worst p95 ${v.worstP95} ms, worst read ${v.worstMax} ms, worst fsync ${v.worstFsync} ms`;
};
export async function volumeTick() {
  try { const s = await probeVolume(); logger.info(`volume latency: p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms, fsync ${s.fsyncMs ?? '–'} ms`); }
  catch (e: any) { logger.warn(`volume latency: ${e?.message || e}`); }
}

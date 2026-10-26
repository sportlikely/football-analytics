/**
 * fix248: the web process's rolling CPU profile (services/cpuProfile.ts starts this thread). Every stall before fix248
 * was guessed from the perf labels (what was in flight), never from what code ran. This thread holds an inspector
 * session on the main thread (Session.connectToMainThread): the V8 sampler runs at a low rate (5 ms), the profile is
 * swapped every 30 s, and for each stall the main thread reports (its start / end in process.hrtime) the samples of that
 * window are counted here: the top functions by self-time (file:line, mapped back to the .ts source through the build's
 * source maps). The profile's JSON is parsed in this thread, never on the web thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { Session } from 'node:inspector';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type Node = { id: number; callFrame: Frame; children?: number[] };
type Profile = { nodes: Node[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] };

const INTERVAL_US = Number(workerData?.intervalUs) || 5000;
const ROTATE_MS = Number(workerData?.rotateMs) || 30_000;

const session = new Session();
session.connectToMainThread();
const post = <T = any>(method: string, params?: object) => new Promise<T>((resolve, reject) =>
  session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res as T))));

let prev: Profile | null = null;
let busy: Promise<unknown> = Promise.resolve();
/** one inspector call chain at a time (a stall report and the 30 s swap never overlap) */
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = busy.then(fn, fn); busy = p.catch(() => undefined); return p; };

/** stop the running profile, keep it as the previous one, start the next */
async function swap(): Promise<Profile | null> {
  let cur: Profile | null = null;
  try { cur = (await post<{ profile: Profile }>('Profiler.stop')).profile; } catch { /* not started */ }
  await post('Profiler.start');
  const before = prev;
  if (cur) prev = cur;
  return before;
}

/* ---- source maps (dist/*.js → src/*.ts), cached per file ---- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const maps = new Map<string, { src: string; lines: number[][][] } | null>();
function vlq(s: string): number[] {
  const out: number[] = [];
  let v = 0, shift = 0;
  for (const ch of s) {
    const d = B64.indexOf(ch);
    v += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    out.push(v & 1 ? -(v >>> 1) : v >>> 1);
    v = 0; shift = 0;
  }
  return out;
}
function loadMap(file: string) {
  if (maps.has(file)) return maps.get(file)!;
  let m: { src: string; lines: number[][][] } | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8'));
    const lines: number[][][] = [];
    let srcLine = 0, srcCol = 0, srcIdx = 0;
    for (const line of String(j.mappings).split(';')) {
      let col = 0;
      const segs: number[][] = [];
      for (const seg of line ? line.split(',') : []) {
        const v = vlq(seg);
        col += v[0];
        if (v.length >= 4) { srcIdx += v[1]; srcLine += v[2]; srcCol += v[3]; segs.push([col, srcLine]); }
      }
      lines.push(segs);
    }
    m = { src: path.resolve(path.dirname(file), j.sourceRoot || '', j.sources?.[srcIdx] ?? j.sources?.[0] ?? ''), lines };
  } catch { m = null; }
  if (maps.size > 400) maps.clear();
  maps.set(file, m);
  return m;
}
/** "services/perf.ts:120" (source line when a map is there), node internals as they are */
function where(f: Frame): string {
  let file = f.url || '';
  if (!file) return '';
  if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { /* keep */ } }
  let line = f.lineNumber + 1;
  if (file.endsWith('.js') && !file.includes('node_modules')) {
    const m = loadMap(file);
    const segs = m?.lines[f.lineNumber];
    if (m && segs?.length) {
      let best = segs[0];
      for (const s of segs) { if (s[0] <= f.columnNumber) best = s; else break; }
      file = m.src; line = best[1] + 1;
    }
  }
  const norm = file.replace(/\\/g, '/');
  const cut = norm.search(/\/(src|dist|node_modules)\//);
  return `${cut >= 0 ? norm.slice(cut + 1).replace(/^(src|dist)\//, '') : norm}:${line}`;
}

export type CpuFn = { fn: string; at: string; ms: number; pct: number; stack?: string[] };

/** self-time by function for the samples between fromUs and toUs (the profile's clock = process.hrtime in µs) */
function topIn(profiles: Profile[], fromUs: number, toUs: number, n: number) {
  const self = new Map<string, { fn: string; at: string; ms: number; stacks: Map<string, number> }>();
  let total = 0;
  for (const p of profiles) {
    const byId = new Map<number, Node>();
    const parent = new Map<number, number>();
    for (const nd of p.nodes) { byId.set(nd.id, nd); for (const c of nd.children || []) parent.set(c, nd.id); }
    let t = p.startTime;
    for (let i = 0; i < p.samples.length; i++) {
      t += p.timeDeltas[i] || 0;
      if (t < fromUs || t > toUs) continue;
      const next = i + 1 < p.timeDeltas.length ? p.timeDeltas[i + 1] : INTERVAL_US;
      const ms = Math.min(Math.max(next, 0), 50_000) / 1000;
      const nd = byId.get(p.samples[i]);
      if (!nd) continue;
      const cf = nd.callFrame;
      if (cf.functionName === '(idle)') continue;
      total += ms;
      const at = where(cf);
      const key = `${cf.functionName}|${at}`;
      let e = self.get(key);
      if (!e) self.set(key, (e = { fn: cf.functionName || '(anonymous)', at, ms: 0, stacks: new Map() }));
      e.ms += ms;
      // the callers (6 frames up): which code path the time came from
      const chain: string[] = [];
      for (let id = parent.get(nd.id); id !== undefined && chain.length < 6; id = parent.get(id)) {
        const f = byId.get(id)!.callFrame;
        if (f.functionName === '(root)') break;
        chain.push(`${f.functionName || '(anonymous)'} ${where(f)}`.trim());
      }
      const s = chain.join(' < ');
      e.stacks.set(s, (e.stacks.get(s) || 0) + ms);
    }
  }
  const top = [...self.values()].sort((a, b) => b.ms - a.ms).slice(0, n).map((e, i): CpuFn => {
    const row: CpuFn = { fn: e.fn, at: e.at, ms: Math.round(e.ms), pct: total ? Math.round((e.ms / total) * 100) : 0 };
    if (i < 5) row.stack = [...e.stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).flatMap(([s]) => (s ? s.split(' < ') : []));
    return row;
  });
  return { sampledMs: Math.round(total), top };
}

parentPort!.on('message', (m: { id: number; fromUs: number; toUs: number; n?: number }) => {
  void serial(async () => {
    try {
      const before = await swap(); // the running profile (up to now) becomes prev; before = the one ahead of it
      const profiles = [before, prev].filter((p): p is Profile => !!p && p.endTime >= m.fromUs && p.startTime <= m.toUs);
      const covered = profiles.length > 0 && Math.min(...profiles.map(p => p.startTime)) <= m.fromUs + INTERVAL_US;
      parentPort!.postMessage({ id: m.id, covered, ...topIn(profiles, m.fromUs, m.toUs, m.n || 15) });
    } catch (e: any) {
      parentPort!.postMessage({ id: m.id, error: String(e?.message || e) });
    }
  });
});

void serial(async () => {
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: INTERVAL_US });
  await post('Profiler.start');
  parentPort!.postMessage({ ready: true });
}).catch(e => parentPort!.postMessage({ fatal: String(e?.message || e) }));
setInterval(() => void serial(swap).catch(() => undefined), ROTATE_MS);

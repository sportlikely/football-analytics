/**
 * fix250: a game page in one request — the "game bundle".
 *
 * A game page asked for 4–5 routes at once (the prediction / details, extras, season forecast, more predictions; key
 * players are inside the game's own answer), each waiting for the worker on its own (live 27 Oct: 5–7 s each). The
 * bundle (/api/game-bundle/<sport>/<id>, a worker route) is built by the worker from those same routes (asked of its own
 * app, with the visitor's headers: the same rules, locks and unlocks) and sent as one JSON:
 *   { data: { sport, id, builtAt, parts: { "<route>": <that route's answer> | null } } }
 * with X-SL-Parts = "<route>=<start>-<end>;…", each part's byte range in the body. The web process keeps a signed-out
 * bundle as its copy and each part as that route's own copy (workerRoutes.ts: byte ranges, nothing parsed), so the old
 * routes are answered from the bundle. The app asks for the bundle first and fills its sections from it.
 *
 * The worker keeps the bundles visitors opened in the last 24 hours (fix279: was 1 h) and the next 12 hours' games
 * (fix279) fresh (every 3 min, signed-out copies in route_cache), so a visitor gets a stored copy at once.
 */
import http from 'node:http';
import { db } from '../db';
import logger from '../utils/logger';
import { internalKey, INTERNAL_HEADER, WORKER_PORT } from './forward';
import { isWorker } from './role';
import { yieldLoop } from './perf';

export type BundleSport = 'football' | 'basketball' | 'nfl' | 'tennis';
export const BUNDLE_SPORTS: BundleSport[] = ['football', 'basketball', 'nfl', 'tennis'];

/** the routes a game page reads, in the order the page shows them (the frontend's lib/gameBundle.ts has the same list) */
export function bundleParts(sport: BundleSport, id: number): string[] {
  const game = sport === 'football' ? `/api/matches/${id}/details` : sport === 'basketball' ? `/api/basketball/game/${id}`
    : sport === 'nfl' ? `/api/nfl/game/${id}` : `/api/tennis/match/${id}`;
  return [game, `/api/extras/${sport}/game/${id}`, ...(sport !== 'tennis' && id > 0 ? [`/api/season-forecast/${sport}/game/${id}`] : []), `/api/more/${sport}/${id}`];
}

/** X-SL-Parts → each part's route and byte range */
export function partsOf(h: string): { path: string; start: number; end: number }[] {
  const out: { path: string; start: number; end: number }[] = [];
  for (const s of h.split(';')) {
    const m = /^(\/api\/[A-Za-z0-9/_-]+)=(\d+)-(\d+)$/.exec(s.trim());
    if (m && Number(m[3]) >= Number(m[2])) out.push({ path: m[1], start: Number(m[2]), end: Number(m[3]) });
  }
  return out;
}

/** a request the bundle makes of its own app (not counted by the per-visitor limits a second time) */
export const BUNDLE_HEADER = 'x-sl-bundle';
export const isBundleCall = (h: http.IncomingHttpHeaders) => !!internalKey() && h[BUNDLE_HEADER] === internalKey();

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const ownPort = () => (isWorker ? WORKER_PORT : Number(process.env.PORT) || 3001);
const PASS = ['cookie', 'authorization', 'user-agent', 'accept-language'];
function ownGet(path: string, from: http.IncomingHttpHeaders, ip: string): Promise<{ status: number; body: Buffer }> {
  const headers: http.OutgoingHttpHeaders = { accept: 'application/json', 'x-forwarded-for': ip || '127.0.0.1', 'x-forwarded-proto': 'https' };
  for (const h of PASS) if (from[h]) headers[h] = from[h];
  if (internalKey()) { headers[INTERNAL_HEADER] = internalKey(); headers[BUNDLE_HEADER] = internalKey(); }
  return new Promise((resolve, reject) => {
    const up = http.request({ host: '127.0.0.1', port: ownPort(), method: 'GET', path, headers, agent }, r => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode || 502, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    up.setTimeout(30_000, () => up.destroy(new Error(`${path}: over 30 s`)));
    up.on('error', reject);
    up.end();
  });
}

/** the bundle's body and its X-SL-Parts header, from the parts asked of this process's own app */
export async function buildBundle(sport: BundleSport, id: number, from: http.IncomingHttpHeaders = {}, ip = ''): Promise<{ body: Buffer; parts: string; got: number }> {
  const paths = bundleParts(sport, id);
  const answers = await Promise.all(paths.map(p => ownGet(p, from, ip).catch(() => null)));
  const chunks: Buffer[] = [], ranges: string[] = [];
  let len = 0, got = 0;
  const push = (x: string | Buffer) => { const b = typeof x === 'string' ? Buffer.from(x, 'utf8') : x; chunks.push(b); len += b.length; };
  push(`{"data":{"sport":${JSON.stringify(sport)},"id":${id},"builtAt":${Date.now()},"parts":{`);
  paths.forEach((p, i) => {
    if (i) push(',');
    push(`${JSON.stringify(p)}:`);
    const a = answers[i];
    // only a whole JSON answer (a 404 / 410 / an error is left for the route itself)
    if (a && a.status === 200 && a.body.length && (a.body[0] === 0x7b || a.body[0] === 0x5b)) { ranges.push(`${p}=${len}-${len + a.body.length}`); push(a.body); got++; } else push('null');
  });
  push('}}}');
  return { body: Buffer.concat(chunks, len), parts: ranges.join(';'), got };
}

/* ---------- worker: the bundles visitors opened, kept fresh ---------- */

const asked = new Map<string, number>(); // "sport/id" → last asked
const builtAt = new Map<string, number>();
export function noteBundleAsked(sport: BundleSport, id: number) {
  const k = `${sport}/${id}`;
  asked.delete(k); asked.set(k, Date.now());
  if (asked.size > 600) asked.delete(asked.keys().next().value as string);
}
const KEEP_FRESH_MS = 3 * 60_000;
const stats = { rounds: 0, built: 0, failed: 0, lastRoundMs: 0, keeping: 0 };
export const bundleStatus = () => ({ ...stats, keeping: [...asked.values()].filter(t => Date.now() - t < KEEP_ASKED_MS).length });

/**
 * fix279: the games of the next 12 hours (and live) of basketball, American football and tennis are kept too, so the
 * first visitor of a game finds its stored copy (29 Oct: /api/game-bundle/basketball/:id 5.3 s — a first build)
 */
const UPCOMING_MS = 12 * 3600_000, UPCOMING_PER_SPORT = 40;
export function upcomingBundles(now = Date.now()): string[] {
  const from = new Date(now - 3 * 3600_000).toISOString(), to = new Date(now + UPCOMING_MS).toISOString();
  const q = (sport: BundleSport, sql: string) => { try { return (db.prepare(sql).all(from, to, UPCOMING_PER_SPORT) as any[]).map(r => `${sport}/${r.id}`); } catch { return []; } };
  return [
    ...q('basketball', `SELECT game_id AS id FROM bb_games WHERE kickoff BETWEEN ? AND ? AND (status IS NULL OR status NOT IN ('FT','AOT','POST','CANC','ABD','AWD')) ORDER BY kickoff LIMIT ?`),
    ...q('nfl', `SELECT game_id AS id FROM nfl_games WHERE kickoff BETWEEN ? AND ? AND (status IS NULL OR status NOT IN ('FT','AOT','POST','CANC','PST')) ORDER BY kickoff LIMIT ?`),
    ...q('tennis', `SELECT id FROM tennis_matches WHERE scheduled_at BETWEEN ? AND ? AND (status IS NULL OR status NOT IN ('finished','cancelled','retired','walkover')) ORDER BY scheduled_at LIMIT ?`)
  ];
}

/** fix279: a bundle opened once is kept 24 h (was 1 h) */
const KEEP_ASKED_MS = 24 * 3600_000;
let ins: any = null;
async function keepFresh() {
  const t0 = Date.now();
  ins ||= db.prepare(`INSERT OR REPLACE INTO route_cache (key, at, status, type, cache, body) VALUES (?, ?, ?, ?, ?, ?)`);
  // (an upcoming game nobody opened yet counts as asked over an hour ago: rebuilt every 30 minutes, not every 3)
  for (const k of upcomingBundles()) if (!asked.has(k)) asked.set(k, Date.now() - 3600_001);
  for (const [k, at] of [...asked]) {
    if (Date.now() - at > KEEP_ASKED_MS) { asked.delete(k); builtAt.delete(k); continue; }
    // fix279: opened in the last hour → every 3 minutes; older (or not opened yet) → every 30 (a visitor's request
    // refreshes a stale copy anyway: workerRoutes.ts)
    if (Date.now() - (builtAt.get(k) || 0) < (Date.now() - at < 3600_000 ? KEEP_FRESH_MS : 30 * 60_000)) continue;
    const [sport, idS] = k.split('/');
    try {
      const b = await buildBundle(sport as BundleSport, Number(idS));
      builtAt.set(k, Date.now());
      if (!b.got) continue;
      const now = Date.now();
      ins.run(`/api/game-bundle/${k}?|`, now, 200, 'application/json; charset=utf-8', 'no-store', b.body);
      for (const p of partsOf(b.parts)) ins.run(`${p.path}?|`, now, 200, 'application/json; charset=utf-8', 'no-store', b.body.subarray(p.start, p.end));
      stats.built++;
    } catch (e: any) { stats.failed++; builtAt.set(k, Date.now()); logger.warn(`game bundle ${k}: ${e?.message || e}`); }
    await yieldLoop();
  }
  stats.rounds++;
  stats.lastRoundMs = Date.now() - t0;
}
let running = false;
/** worker: every minute, the bundles asked for in the last hour that are over 3 minutes old */
export function startBundleKeeper() {
  setInterval(() => {
    if (running) return;
    running = true;
    keepFresh().catch(e => logger.warn(`game bundles: ${e?.message || e}`)).finally(() => { running = false; });
  }, 60_000).unref();
}

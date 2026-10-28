/**
 * fix210: public routes that build something are never computed in the web process.
 *
 * On 24 Oct the web process still froze for up to 5 s on pages built on a visitor's request (/api/player-page 3.9 s,
 * /api/news and /api/more/nfl 2.5 s, /api/matches/:id/details 1.7 s, the basketball / NFL / tennis game, team and
 * player pages …). Those routes are listed here (WORKER_ROUTES). The web process passes such a request to the worker,
 * which answers it from its own copy of the app (services/forward.ts) — same handlers, same rules (rate limits,
 * locked predictions, crawler checks). For a signed-out visitor the answer is also kept (memory, capped, and
 * page_cache rows "route:…", kept 2 days), keyed by the URL and what can change it for a signed-out visitor
 * (a data-centre network, a verified search engine), and served stale-while-revalidate: a copy older than the
 * route's freshness is sent at once while the worker builds the next. Signed-in visitors (their unlocks and plan
 * change the page) always get the worker's fresh answer.
 *
 * While the worker restarts: the last copy if there is one, else 503 (Retry-After). The web process never builds.
 */
import type express from 'express';
import { db } from '../db';
import logger from '../utils/logger';
import { isWeb } from './role';
import { fetchFromWorker, forwardToWorker, waiting, type WorkerAnswer } from './forward';
import { isWorker } from './role';
import { deferred } from './deferredWrites';
import { readSql, asBuffer, pageReaderOn } from './pageReader';
import { keepsOwnCopies } from './deadline';
import { partsOf } from './gameBundle';

/** shared: the same answer for everyone (fix250: a signed-in visitor gets the signed-out copy too) */
type RouteDef = { re: RegExp; freshMs: number; shared?: boolean };
const S = 1000, MIN = 60 * S;
/**
 * The public routes the worker answers (GET). Every sport: football match / team / player pages, leagues, today, news,
 * search, more predictions per game; basketball, American football and tennis game / team / player / leaders /
 * standings / rankings pages. The stored pages (lists, records, home pages: pageCache.ts) are not here — the web
 * process sends those itself. scripts/no-web-compute.test.mjs checks every public route against this list.
 */
export const WORKER_ROUTES: RouteDef[] = [
  { re: /^\/api\/matches\/\d+(\/(details|scorers|highlights|head2head|extras\/[a-z0-9]+))?$/, freshMs: 20 * S },
  { re: /^\/api\/leagues$/, freshMs: 10 * MIN }, // the competition list (asks Football-Data.org)
  { re: /^\/api\/leagues\/[^/]+\/(standings|results|scorers)$/, freshMs: 2 * MIN },
  { re: /^\/api\/(teams|team-page)\/\d+$/, freshMs: 10 * MIN },
  { re: /^\/api\/player-page\/(\d+|find)$/, freshMs: 30 * MIN },
  { re: /^\/api\/(today|news|search)$/, freshMs: 2 * MIN },
  { re: /^\/api\/how-it-works\/[a-z-]+$/, freshMs: 10 * MIN },
  { re: /^\/api\/upset-watch$/, freshMs: 5 * MIN }, // fix242: football's upset watch (Pro) is built by the worker like the other sports'
  { re: /^\/api\/more\/(football|basketball|nfl|tennis)\/-?\d+$/, freshMs: 1 * MIN },
  { re: /^\/api\/basketball\/game\/\d+(\/(scorers|highlights))?$/, freshMs: 20 * S },
  { re: /^\/api\/basketball\/(team|player)\/\d+$/, freshMs: 10 * MIN },
  { re: /^\/api\/basketball\/(leaders|upset-watch)$/, freshMs: 5 * MIN },
  { re: /^\/api\/nfl\/game\/\d+(\/(scorers|highlights))?$/, freshMs: 20 * S },
  { re: /^\/api\/nfl\/(games|standings|leaders|upset-watch|accuracy)$/, freshMs: 2 * MIN },
  { re: /^\/api\/nfl\/(team|player)\/\d+$/, freshMs: 10 * MIN },
  { re: /^\/api\/tennis\/match\/-?\d+(\/highlights)?$/, freshMs: 20 * S },
  { re: /^\/api\/tennis\/(matches|rankings|accuracy|upset-watch)$/, freshMs: 2 * MIN },
  { re: /^\/api\/tennis\/(player\/\d+|tournament\/[a-z0-9-]+)$/, freshMs: 10 * MIN },
  { re: /^\/api\/season-forecast\/(football|basketball|nfl)\/(league\/[A-Za-z0-9]+|team\/\d+|game\/\d+)$/, freshMs: 2 * MIN }, // fix215
  { re: /^\/api\/favorites\/calendar$/, freshMs: 5 * MIN },
  { re: /^\/api\/slug-route$/, freshMs: 1 * MIN }, // fix229: an address outside the web process's slug state
  { re: /^\/api\/extras\/(football|basketball|nfl|tennis)\/(game\/-?\d+|team\/\d+)$/, freshMs: 5 * MIN, shared: true }, // fix231 (the same for everyone)
  { re: /^\/api\/game-bundle\/(football|basketball|nfl|tennis)\/-?\d+$/, freshMs: 20 * S }, // fix250: a game page's parts in one answer
  { re: /^\/api\/names\/(he|ar)$/, freshMs: 10 * MIN, shared: true } // fix261: names in the local script (the same for everyone)
];

/**
 * Every public GET route of app.ts and who answers it (fix210):
 * - worker: built by the worker (WORKER_ROUTES above; signed-out copies kept here)
 * - stored: a stored page (pageCache.ts) or model state the worker published (shared.ts) — the web process only sends it
 * - web:    a small read the web process does itself (the visitor's own account, picks, favourites, config, files)
 * `kind` marks each sport's game / team / player pages (every sport must have them on the worker).
 * `npm run parity` (frontend/scripts/web-routes-check.ts) fails when a public route of app.ts is missing here or a
 * worker route's sample is not in WORKER_ROUTES; scripts/no-web-compute.test.mjs opens every sample in a web process.
 */
export type RouteSport = 'football' | 'basketball' | 'nfl' | 'tennis' | 'all';
export const PUBLIC_ROUTES: { path: string; sport: RouteSport; by: 'worker' | 'stored' | 'web'; sample: string; kind?: 'game' | 'team' | 'player' }[] = [
  { path: '/api/health', sport: 'all', by: 'web', sample: '/api/health' },
  { path: '/api/auth/me', sport: 'all', by: 'web', sample: '/api/auth/me' },
  { path: '/api/auth/config', sport: 'all', by: 'web', sample: '/api/auth/config' },
  { path: '/api/auth/signup-token', sport: 'all', by: 'web', sample: '/api/auth/signup-token' },
  { path: '/api/auth/2fa', sport: 'all', by: 'web', sample: '/api/auth/2fa' },
  { path: '/api/auth/export', sport: 'all', by: 'web', sample: '/api/auth/export' },
  { path: '/api/assistant/status', sport: 'all', by: 'web', sample: '/api/assistant/status' },
  { path: '/api/picks/game/:sport(fb|bb|nfl)/:id(\\d+)', sport: 'all', by: 'web', sample: '/api/picks/game/fb/1' },
  { path: '/api/picks/record', sport: 'all', by: 'web', sample: '/api/picks/record' },
  { path: '/api/favorites', sport: 'all', by: 'web', sample: '/api/favorites' },
  { path: '/api/favorites/calendar', sport: 'all', by: 'worker', sample: '/api/favorites/calendar' },
  { path: '/api/unsubscribe', sport: 'all', by: 'web', sample: '/api/unsubscribe' },
  { path: '/api/email/settings', sport: 'all', by: 'web', sample: '/api/email/settings' }, // fix216: the signed-in person's own settings
  { path: '/api/email/unsubscribe', sport: 'all', by: 'web', sample: '/api/email/unsubscribe' },
  { path: '/api/push/settings', sport: 'all', by: 'web', sample: '/api/push/settings' }, // fix226: the signed-in person's own alert settings
  { path: '/api/testers/invite/:code', sport: 'all', by: 'web', sample: '/api/testers/invite/abc' },
  { path: '/api/unlocks', sport: 'all', by: 'web', sample: '/api/unlocks' },
  { path: '/api/billing/plans', sport: 'all', by: 'web', sample: '/api/billing/plans' },
  { path: '/api/changelog', sport: 'all', by: 'web', sample: '/api/changelog' },
  { path: '/api/guides', sport: 'all', by: 'web', sample: '/api/guides' },
  { path: '/api/guides/:slug', sport: 'all', by: 'web', sample: '/api/guides/how-to-read-a-match-page' },
  { path: '/api/how-it-works/:sport', sport: 'all', by: 'worker', sample: '/api/how-it-works/football' },
  { path: '/api/search', sport: 'all', by: 'worker', sample: '/api/search?q=arsenal' },
  { path: '/api/today', sport: 'all', by: 'worker', sample: '/api/today?sport=football' },
  { path: '/api/news', sport: 'all', by: 'worker', sample: '/api/news' },
  // fix229: clean links — the app's exception lists and slug ↔ id from the worker's published state (a miss is passed on)
  { path: '/api/slugs/:sport', sport: 'all', by: 'stored', sample: '/api/slugs/football' },
  { path: '/api/slugs/:sport/players', sport: 'all', by: 'stored', sample: '/api/slugs/football/players' },
  { path: '/api/slugs/:sport/seasons', sport: 'all', by: 'stored', sample: '/api/slugs/football/seasons' }, // fix243: each team's season start (no links to past seasons)
  { path: '/api/slug/:sport/:kind/:slug', sport: 'all', by: 'stored', sample: '/api/slug/football/team/barcelona' },
  { path: '/api/slug-of/:sport/:kind/:id', sport: 'all', by: 'stored', sample: '/api/slug-of/football/team/1000000529' },
  { path: '/api/slug-route', sport: 'all', by: 'worker', sample: '/api/slug-route?p=/team/1' },
  { path: '/api/hub', sport: 'football', by: 'stored', sample: '/api/hub' },
  { path: '/api/hub/:slug', sport: 'football', by: 'stored', sample: '/api/hub/premier-league' },
  { path: '/api/public/record', sport: 'football', by: 'stored', sample: '/api/public/record' },
  { path: '/api/public/results', sport: 'football', by: 'stored', sample: '/api/public/results' },
  { path: '/api/public/geo-source', sport: 'all', by: 'web', sample: '/api/public/geo-source' },
  { path: '/api/public/photo-credits', sport: 'all', by: 'web', sample: '/api/public/photo-credits' }, // fix211: a cached list
  { path: '/api/public/summary', sport: 'football', by: 'stored', sample: '/api/public/summary' },
  { path: '/api/more/:sport(football|basketball|nfl|tennis)/record', sport: 'all', by: 'stored', sample: '/api/more/basketball/record' },
  { path: '/api/more/:sport(football|basketball|nfl|tennis)/:id(-?\\d+)', sport: 'all', by: 'worker', sample: '/api/more/nfl/1' },
  // fix215: season forecast (league table, team card, what a game means)
  { path: '/api/season-forecast/:sport/league/:code([A-Za-z0-9]{1,12})', sport: 'all', by: 'worker', sample: '/api/season-forecast/football/league/PL' },
  { path: '/api/season-forecast/:sport/team/:id(\\d+)', sport: 'all', by: 'worker', sample: '/api/season-forecast/basketball/team/1' },
  { path: '/api/season-forecast/:sport/game/:id(\\d+)', sport: 'all', by: 'worker', sample: '/api/season-forecast/nfl/game/1' },
  // fix231: game-page extras (weather, referee, fixture difficulty, trends) and a team's next 5 games
  { path: '/api/extras/:sport(football|basketball|nfl|tennis)/game/:id(-?\\d+)', sport: 'all', by: 'worker', sample: '/api/extras/football/game/1' },
  { path: '/api/extras/:sport(football|basketball|nfl|tennis)/team/:id(\\d+)', sport: 'all', by: 'worker', sample: '/api/extras/tennis/team/1' },
  { path: '/api/names/:lang(he|ar)', sport: 'all', by: 'worker', sample: '/api/names/he' },
  // fix250: a game page in one request (the prediction, extras, season forecast, more predictions: services/gameBundle.ts)
  { path: '/api/game-bundle/:sport(football|basketball|nfl|tennis)/:id(-?\\d+)', sport: 'all', by: 'worker', sample: '/api/game-bundle/football/1' },
  // football
  { path: '/api/matches/upcoming', sport: 'football', by: 'stored', sample: '/api/matches/upcoming' },
  { path: '/api/matches/live', sport: 'football', by: 'stored', sample: '/api/matches/live' },
  { path: '/api/matches/:id(\\d+)', sport: 'football', by: 'worker', sample: '/api/matches/1' },
  { path: '/api/matches/:id(\\d+)/highlights', sport: 'football', by: 'worker', sample: '/api/matches/1/highlights' },
  { path: '/api/matches/:id(\\d+)/details', sport: 'football', by: 'worker', sample: '/api/matches/1/details', kind: 'game' },
  { path: '/api/matches/:id(\\d+)/scorers', sport: 'football', by: 'worker', sample: '/api/matches/1/scorers' },
  { path: '/api/matches/:id(\\d+)/extras/:part(stats|lineups|h2h|rest)', sport: 'football', by: 'worker', sample: '/api/matches/1/extras/stats' },
  { path: '/api/matches/:id(\\d+)/head2head', sport: 'football', by: 'worker', sample: '/api/matches/1/head2head' },
  { path: '/api/leagues', sport: 'football', by: 'worker', sample: '/api/leagues' },
  { path: '/api/leagues/:code/standings', sport: 'football', by: 'worker', sample: '/api/leagues/PL/standings' },
  { path: '/api/leagues/:code/results', sport: 'football', by: 'worker', sample: '/api/leagues/PL/results' },
  { path: '/api/leagues/:code/scorers', sport: 'football', by: 'worker', sample: '/api/leagues/PL/scorers' },
  { path: '/api/teams/:id(\\d+)', sport: 'football', by: 'worker', sample: '/api/teams/1' },
  { path: '/api/team-page/:id(\\d+)', sport: 'football', by: 'worker', sample: '/api/team-page/1', kind: 'team' },
  { path: '/api/player-page/find', sport: 'football', by: 'worker', sample: '/api/player-page/find?name=x&team=1' },
  { path: '/api/player-page/:id(\\d+)', sport: 'football', by: 'worker', sample: '/api/player-page/1', kind: 'player' },
  // basketball
  { path: '/api/basketball/config', sport: 'basketball', by: 'web', sample: '/api/basketball/config' },
  { path: '/api/basketball/games', sport: 'basketball', by: 'stored', sample: '/api/basketball/games' },
  { path: '/api/basketball/game/:id(\\d+)', sport: 'basketball', by: 'worker', sample: '/api/basketball/game/1', kind: 'game' },
  { path: '/api/basketball/game/:id(\\d+)/scorers', sport: 'basketball', by: 'worker', sample: '/api/basketball/game/1/scorers' },
  { path: '/api/basketball/game/:id(\\d+)/highlights', sport: 'basketball', by: 'worker', sample: '/api/basketball/game/1/highlights' },
  { path: '/api/basketball/standings/:code([A-Za-z0-9]{2,8})', sport: 'basketball', by: 'stored', sample: '/api/basketball/standings/NBA' },
  { path: '/api/basketball/team/:id(\\d+)', sport: 'basketball', by: 'worker', sample: '/api/basketball/team/1', kind: 'team' },
  { path: '/api/basketball/player/:id(\\d+)', sport: 'basketball', by: 'worker', sample: '/api/basketball/player/1', kind: 'player' },
  { path: '/api/basketball/leaders', sport: 'basketball', by: 'worker', sample: '/api/basketball/leaders' },
  { path: '/api/basketball/record', sport: 'basketball', by: 'stored', sample: '/api/basketball/record' },
  { path: '/api/basketball/upset-watch', sport: 'basketball', by: 'worker', sample: '/api/basketball/upset-watch' },
  // American football
  { path: '/api/nfl/config', sport: 'nfl', by: 'stored', sample: '/api/nfl/config' }, // fix221
  { path: '/api/nfl/home', sport: 'nfl', by: 'stored', sample: '/api/nfl/home' },
  { path: '/api/nfl/games', sport: 'nfl', by: 'worker', sample: '/api/nfl/games' },
  { path: '/api/nfl/game/:id(\\d+)', sport: 'nfl', by: 'worker', sample: '/api/nfl/game/1', kind: 'game' },
  { path: '/api/nfl/game/:id(\\d+)/scorers', sport: 'nfl', by: 'worker', sample: '/api/nfl/game/1/scorers' },
  { path: '/api/nfl/game/:id(\\d+)/highlights', sport: 'nfl', by: 'worker', sample: '/api/nfl/game/1/highlights' },
  { path: '/api/nfl/standings', sport: 'nfl', by: 'worker', sample: '/api/nfl/standings' },
  { path: '/api/nfl/team/:id(\\d+)', sport: 'nfl', by: 'worker', sample: '/api/nfl/team/1', kind: 'team' },
  { path: '/api/nfl/player/:id(\\d+)', sport: 'nfl', by: 'worker', sample: '/api/nfl/player/1', kind: 'player' },
  { path: '/api/nfl/upset-watch', sport: 'nfl', by: 'worker', sample: '/api/nfl/upset-watch' },
  { path: '/api/nfl/accuracy', sport: 'nfl', by: 'worker', sample: '/api/nfl/accuracy' },
  { path: '/api/nfl/record', sport: 'nfl', by: 'stored', sample: '/api/nfl/record' },
  { path: '/api/nfl/leaders', sport: 'nfl', by: 'worker', sample: '/api/nfl/leaders' },
  // tennis (a tournament is its "team" page)
  { path: '/api/tennis/config', sport: 'tennis', by: 'web', sample: '/api/tennis/config' },
  { path: '/api/tennis/home', sport: 'tennis', by: 'stored', sample: '/api/tennis/home' },
  { path: '/api/tennis/matches', sport: 'tennis', by: 'worker', sample: '/api/tennis/matches' },
  { path: '/api/tennis/match/:id(-?\\d+)', sport: 'tennis', by: 'worker', sample: '/api/tennis/match/1', kind: 'game' },
  { path: '/api/tennis/record', sport: 'tennis', by: 'stored', sample: '/api/tennis/record' },
  { path: '/api/tennis/tournament/:key([a-z0-9-]{3,90})', sport: 'tennis', by: 'worker', sample: '/api/tennis/tournament/wimbledon', kind: 'team' },
  { path: '/api/tennis/player/:id(\\d+)', sport: 'tennis', by: 'worker', sample: '/api/tennis/player/1', kind: 'player' },
  { path: '/api/tennis/rankings', sport: 'tennis', by: 'worker', sample: '/api/tennis/rankings' },
  { path: '/api/tennis/accuracy', sport: 'tennis', by: 'worker', sample: '/api/tennis/accuracy' },
  { path: '/api/tennis/match/:id(\\d+)/highlights', sport: 'tennis', by: 'worker', sample: '/api/tennis/match/1/highlights' },
  { path: '/api/tennis/upset-watch', sport: 'tennis', by: 'worker', sample: '/api/tennis/upset-watch' }
];
/** the crawler HTML pages (every language): stored pages built by the worker (app.ts: 'seo' / 'seo-page') */
export const PAGE_SAMPLES = ['/', '/fr', '/fr/team/33', '/de/player/276', '/basketball', '/basketball/game/1', '/es/basketball/team/1', '/american-football/game/1', '/tennis/player/1', '/it/match/1'];
export const workerRouteOf = (path: string) => WORKER_ROUTES.find(r => r.re.test(path)) || null;

/* ---------- the signed-out copies ---------- */

type Copy = { at: number; status: number; type: string; cache: string | null; body: Buffer };
const KEEP_MS = 2 * 86400000;
const MEM_MAX_BYTES = (Number(process.env.ROUTE_MEM_MAX_MB) || 32) * 1048576;
const mem = new Map<string, Copy>();
let memBytes = 0;
const memDel = (k: string) => { const c = mem.get(k); if (c) { memBytes -= c.body.length; mem.delete(k); } };
function memSet(k: string, c: Copy) {
  memDel(k);
  mem.set(k, c);
  memBytes += c.body.length;
  for (const key of mem.keys()) { if (memBytes <= MEM_MAX_BYTES && mem.size <= 3000) break; if (key !== k) memDel(key); }
}
db.exec(`CREATE TABLE IF NOT EXISTS route_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, status INTEGER NOT NULL, type TEXT NOT NULL, cache TEXT, body BLOB NOT NULL)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_route_cache_at ON route_cache(at)`);
// fix210b: the web process never writes: the copies go to the worker (deferredWrites), which also drops the old ones
const saveRow = deferred(`INSERT OR REPLACE INTO route_cache (key, at, status, type, cache, body) VALUES (?, ?, ?, ?, ?, ?)`);
// fix243: a page that is gone now (410: a past season's match) drops its kept copy (a copy from before is never served again)
const dropRow = deferred(`DELETE FROM route_cache WHERE key = ?`);
// fix249: copies older than KEEP_MS (2 days) are deleted in slices by the worker's retention job (utils/retention.ts)
const COPY_SQL = `SELECT at, status, type, cache, body FROM route_cache WHERE key = ?`;
/*
 * fix248: a copy not in memory is read in the reader thread (services/pageReader.ts): the CPU profile of 26 Oct showed
 * the web thread blocked in this read (774 ms, /basketball/* + /de/* + /it/*). The synchronous read only without it.
 */
async function readCopy(k: string): Promise<Copy | null> {
  const m = mem.get(k);
  if (m) { mem.delete(k); mem.set(k, m); return m; }
  try {
    let r: any;
    let off = pageReaderOn();
    if (off) { try { r = await readSql(COPY_SQL, [k]); } catch { off = false; } }
    if (!off) r = db.prepare(COPY_SQL).get(k);
    if (!r) return null;
    const c: Copy = { at: r.at, status: r.status, type: r.type, cache: r.cache, body: off ? asBuffer(r.body) : Buffer.from(r.body) };
    memSet(k, c);
    return c;
  } catch { return null; }
}
function saveCopy(k: string, a: WorkerAnswer): Copy {
  const c: Copy = { at: Date.now(), status: a.status, type: String(a.headers['content-type'] || 'application/json; charset=utf-8'), cache: a.headers['cache-control'] ? String(a.headers['cache-control']) : null, body: a.body };
  memSet(k, c);
  try { saveRow.run(k, c.at, c.status, c.type, c.cache, c.body); } catch (e: any) { logger.warn(`route cache: ${e?.message || e}`); }
  // fix250: a game bundle's parts become the parts' own copies (byte ranges from the worker: nothing parsed here)
  if (a.status === 200 && a.headers['x-sl-parts']) {
    const flags = k.slice(k.lastIndexOf('|') + 1);
    for (const p of partsOf(String(a.headers['x-sl-parts']))) {
      const pk = `${p.path}?|${flags}`, body = a.body.subarray(p.start, p.end);
      const pc: Copy = { at: c.at, status: 200, type: 'application/json; charset=utf-8', cache: 'no-store', body };
      memSet(pk, pc);
      try { saveRow.run(pk, pc.at, 200, pc.type, pc.cache, body); } catch { /* the next bundle */ }
    }
  }
  return c;
}
const sendCopy = (res: express.Response, c: Copy, state: string, staleS = 0) => {
  res.status(c.status).set('Content-Type', c.type).set('X-SL-Copy', state);
  if (staleS) res.set('X-SL-Stale', String(staleS)); // fix250: the copy is older than the route's freshness
  if (c.cache) res.set('Cache-Control', c.cache);
  res.end(c.body);
};
const pending = (res: express.Response) => res.status(202).set({ 'Cache-Control': 'no-store', 'X-SL-Pending': '1' }).type('application/json').end('{"pending":true,"data":null}');
// fix250: a visitor waits this long for the worker's first answer, then gets { pending: true } (the copy is made anyway)
const FIRST_WAIT_MS = Number(process.env.ROUTE_WAIT_MS) || 700;

/** a signed-out request's copy key: the URL (query sorted) + what changes the page for a signed-out visitor */
function copyKey(req: express.Request): string {
  const [path, qs = ''] = req.originalUrl.split('?');
  const q = new URLSearchParams(qs);
  q.sort();
  const flags = [(req as any).proxyAnon ? 'proxy' : '', (req as any).verifiedCrawler ? 'crawler' : ''].filter(Boolean).join(',');
  return `${path}?${q.toString()}|${flags}`;
}

// one fetch per key at a time: the other visitors asking for it wait for the same answer
const inflight = new Map<string, Promise<Copy | WorkerAnswer>>();
const stats = { forwarded: 0, served: 0, stale: 0, refreshed: 0, failed: 0, startup: 0, pending: 0 };

function fetchCopy(k: string, req: express.Request, keep: boolean): Promise<Copy | WorkerAnswer> {
  let p = inflight.get(k);
  if (!p) {
    p = fetchFromWorker(req).then(a => {
      if (keep && a.status === 410) { memDel(k); try { dropRow.run(k); } catch { /* next time */ } }
      return keep && a.status === 200 ? saveCopy(k, a) : a;
    }).finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}
const isCopy = (x: Copy | WorkerAnswer): x is Copy => typeof (x as Copy).at === 'number';

/** web process: the middleware (after the access, rate-limit and crawler checks; before the route handlers) */
export async function workerRoutes(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isWeb || req.method !== 'GET') return next();
  const route = workerRouteOf(req.path);
  if (!route) return next();
  // signed in: the plan and the unlocks change the page — the worker's fresh answer, streamed (fix250: cut at 900 ms by
  // services/deadline.ts, the answer kept for the person's next request); a route that is the same for everyone: the copy
  const signedIn = !!(req.user || req.access === 'admin');
  if (signedIn && !route.shared) { stats.forwarded++; return forwardToWorker(req, res); }
  const k = copyKey(req);
  const have = await readCopy(k);
  if (have) {
    const age = Date.now() - have.at, stale = age > route.freshMs;
    sendCopy(res, have, stale ? 'stale' : 'fresh', stale ? Math.round(age / 1000) : 0);
    if (stale) { stats.stale++; fetchCopy(k, req, true).then(() => { stats.refreshed++; }, () => { stats.failed++; }); } else stats.served++;
    return;
  }
  if (signedIn) { stats.forwarded++; return forwardToWorker(req, res); }
  stats.forwarded++;
  waiting(res);
  keepsOwnCopies(res);
  // fix250: never a wait for a first build — 700 ms at most, then { pending: true }; the copy is kept when it comes
  const late = setTimeout(() => { if (!res.headersSent) { stats.pending++; pending(res); } }, (req as any).verifiedCrawler ? 20_000 : FIRST_WAIT_MS);
  fetchCopy(k, req, true).finally(() => clearTimeout(late)).then(x => {
    if (res.headersSent) return;
    if (isCopy(x)) return sendCopy(res, x, 'new');
    res.status(x.status);
    for (const h of ['content-type', 'cache-control', 'retry-after']) if (x.headers[h]) res.set(h, String(x.headers[h]));
    res.end(x.body);
  }, () => {
    stats.failed++;
    // fix245: a verified search engine gets a second try straight from the worker (streamed) instead of the 503
    if (!res.headersSent && (req as any).verifiedCrawler) return void setTimeout(() => (res.headersSent || req.destroyed ? undefined : forwardToWorker(req, res)), 1500);
    if (!res.headersSent) res.status(503).set('Retry-After', '10').json({ error: 'Loading, please try again in a moment' });
  });
}

/**
 * fix238: while the web process loads its state (the first seconds after a deploy) a signed-out GET of a worker route
 * gets its last kept copy at once (X-SL-Copy: startup) instead of 503 "Starting up". The crawler / data-centre flags
 * are not known yet: only the plain signed-out copy is sent. false = no copy (the caller waits for the state).
 */
export async function sendStartupCopy(req: express.Request, res: express.Response, signedIn: boolean): Promise<boolean> {
  if (!isWeb || req.method !== 'GET' || signedIn || !workerRouteOf(req.path)) return false;
  const [path, qs = ''] = req.originalUrl.split('?');
  const q = new URLSearchParams(qs);
  q.sort();
  const c = await readCopy(`${path}?${q.toString()}|`);
  if (!c || c.status !== 200) return false;
  stats.startup++;
  sendCopy(res, c, 'startup');
  return true;
}

/** /api/perf: how the worker routes were answered since start, and the copies kept */
export function workerRoutesStatus() {
  let rows = 0;
  try { rows = (db.prepare(`SELECT COUNT(*) AS n FROM route_cache`).get() as any)?.n || 0; } catch { /* no table (one process) */ }
  return { ...stats, inMemory: mem.size, memMb: Math.round(memBytes / 1048576), stored: rows };
}

import axios, { AxiosInstance } from 'axios';
import { withLive } from './liveChance';
import { cachedPredictions, clearPredictionCache, mainPrediction } from './predCache';
import { timed, setJob, yieldLoop, yielder, every, after } from './perf';
import { freezePredictions } from './tracking';
import logger from '../utils/logger';
import { db } from '../db';
import { markFresh, markFailed } from './freshness';
import { predictFromStandings, Prediction, StandingsResponse } from './predictionModel';
import { predictV2, prepareModelV2 } from './historyModel';
import { predictV3, prepareModelV3, prepareModelV3Async } from './gridModel';
import { mixPredictions } from './featureModel';
import { reportLive } from './liveScores';
import { predictClubEuro } from './clubElo';
import { withMarket, oddsFor } from './odds';

// Competitions to load. Override with COMPETITIONS=PL,PD,... in .env
const DEFAULT_COMPETITIONS = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'DED', 'PPL', 'ELC'];

// Statuses that count as "upcoming or live"
const ACTIVE_STATUSES = new Set(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED']);
const LIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED']);

const MAX_DAYS = 30; // size of the in-memory fixture window
const CACHE_TTL_MS = 5 * 60 * 1000; // background refresh interval for the window
const LIVE_CACHE_TTL_MS = 30 * 1000; // 30 seconds for live
const BACKGROUND_RESERVE = 3; // calls per minute kept free for user-facing requests
const PROBABLE_WAIT_MS = 6000; // max time a match page waits for usual XIs before returning without them

interface CacheEntry<T> {
  data: T;
  expires: number;
}

/** Resolve with null if the promise takes longer than `ms` (the work keeps running and fills the cache). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

class FootballDataAPI {
  private client: AxiosInstance;
  private apiKey: string;
  private baseURL: string;
  private competitions: string[];
  private cache = new Map<string, CacheEntry<any>>();
  private window: any[] | null = null;
  private windowLoadedAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  // Latest known standings per competition (kept even if a refresh fails)
  private standingsByCode = new Map<string, StandingsResponse>();
  /** Called after every successful window refresh with predictions attached. */
  onWindowRefreshed: ((matches: any[]) => void) | null = null;

  constructor() {
    this.baseURL = process.env.FOOTBALL_DATA_BASE_URL || 'https://api.football-data.org/v4';
    this.apiKey = process.env.FOOTBALL_DATA_API_KEY || '';
    this.competitions = (process.env.COMPETITIONS || DEFAULT_COMPETITIONS.join(','))
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);

    console.log('=== Football Data API Init ===');
    console.log(`API Key loaded: ${this.apiKey ? 'YES ✅' : 'NO ❌'}`);
    console.log(`Base URL: ${this.baseURL}`);
    console.log(`Competitions: ${this.competitions.join(', ')}`);
    console.log('================================');

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: {
        'X-Auth-Token': this.apiKey,
        Accept: 'application/json'
      }
    });

    // Display names: Football-Data.org calls La Liga "Primera Division"
    const NICE: Record<string, string> = { PD: 'La Liga' };
    const rename = (x: any, depth = 0): void => {
      if (!x || typeof x !== 'object' || depth > 6) return;
      if (Array.isArray(x)) { for (const y of x) rename(y, depth + 1); return; }
      if (typeof x.code === 'string' && NICE[x.code] && typeof x.name === 'string') x.name = NICE[x.code];
      for (const k of Object.keys(x)) { const v = x[k]; if (v && typeof v === 'object') rename(v, depth + 1); }
    };
    this.client.interceptors.response.use(res => { try { rename(res.data); } catch { /* leave as is */ } return res; });
    try { db.prepare(`UPDATE predictions SET competition_name = 'La Liga' WHERE competition_code = 'PD' AND competition_name != 'La Liga'`).run(); } catch { /* table not ready */ }

    // --- Per-minute quota management ---------------------------------------------------
    // Football-Data.org tells us what's left in every response:
    //   X-Requests-Available-Minute (calls left) and X-RequestCounter-Reset (seconds to reset).
    // Before each call we wait if the budget is gone. Background work (window refresh,
    // standings, usual-XI prefetch) also keeps a small reserve so a page opened by a user
    // is never the one that gets a 429.
    this.client.interceptors.request.use(async (config: any) => {
      const background = !!config.background;
      const reserve = background ? BACKGROUND_RESERVE : 0;
      // Serialise: one call at a time decides whether it may go
      this.gate = this.gate.then(async () => {
        while (this.quotaLeft <= reserve && this.quotaResetAt > Date.now()) {
          const ms = this.quotaResetAt - Date.now() + 250;
          if (!this.quotaWarned) {
            this.quotaWarned = true;
            logger.info(`football-data minute quota used, ${background ? 'background' : 'request'} waits ${Math.ceil(ms / 1000)}s`);
          }
          await new Promise(r => setTimeout(r, Math.min(ms, 61_000)));
          if (this.quotaResetAt <= Date.now()) this.quotaLeft = Infinity; // window rolled over
        }
        this.quotaLeft = this.quotaLeft === Infinity ? Infinity : this.quotaLeft - 1;
      });
      await this.gate;
      return config;
    });

    const readQuota = (headers: any) => {
      if (!headers) return;
      const left = parseInt(headers['x-requests-available-minute'], 10);
      const reset = parseInt(headers['x-requestcounter-reset'], 10);
      if (Number.isFinite(left)) this.quotaLeft = left;
      if (Number.isFinite(reset)) this.quotaResetAt = Date.now() + reset * 1000;
      if (Number.isFinite(left) && left > 0) this.quotaWarned = false;
    };

    this.client.interceptors.response.use(
      response => {
        readQuota(response.headers);
        return response;
      },
      async (error: any) => {
        const cfg = error?.config;
        if (error?.response?.status === 429) {
          // Rate limit anyway (e.g. another process on the same key): wait what the API asks, retry once
          readQuota(error.response.headers);
          const msg: string = error.response.data?.message || '';
          const secs = Math.min(60, parseInt((msg.match(/(\d+)\s*second/) || [])[1] || '10', 10) + 1);
          this.quotaLeft = 0;
          this.quotaResetAt = Math.max(this.quotaResetAt, Date.now() + secs * 1000);
          if (cfg && !cfg.__retried) {
            logger.warn(`football-data rate limit hit, retrying in ${secs}s`, { url: cfg.url });
            await new Promise(r => setTimeout(r, secs * 1000));
            cfg.__retried = true;
            return this.client.request(cfg);
          }
        }
        throw error;
      }
    );
  }

  private quotaLeft = Infinity;
  /** fix165: the minute quota is used up right now (a call would wait in the queue) */
  get quotaBusy(): boolean { return this.quotaLeft <= 0 && this.quotaResetAt > Date.now(); }
  private quotaResetAt = 0;
  private quotaWarned = false;
  private gate: Promise<void> = Promise.resolve();

  /** Axios config for background jobs: they leave a reserve of calls for user requests. */
  private get bg() {
    return { background: true } as any;
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.data as T;
    return null;
  }

  private setCached<T>(key: string, data: T, ttl: number) {
    this.cache.set(key, { data, expires: Date.now() + ttl });
  }

  /**
   * Upcoming (and currently live) matches for the next `days` days.
   * Served instantly from an in-memory window that is refreshed in the
   * background (see startBackgroundRefresh). Falls back to a live fetch
   * only if the window has never been loaded.
   */
  async getUpcomingMatches(days: number = MAX_DAYS) {
    const safeDays = Math.min(Math.max(days, 1), MAX_DAYS);
    if (!this.window) {
      await this.refreshWindow();
    }
    const cutoff = Date.now() + safeDays * 24 * 60 * 60 * 1000;
    return (this.window || []).filter(m => new Date(m.utcDate).getTime() <= cutoff);
  }

  /** Load the full MAX_DAYS window from the API. Keeps the old data if it fails. */
  async refreshWindow() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchWindow()
      .then(async matches => {
        // A partial refresh (some competitions failed) must not shrink a healthy window
        if (this.window && matches.length < this.window.length * 0.5) {
          logger.warn(`Window refresh returned ${matches.length} matches vs ${this.window.length} before — keeping the previous window`);
          return;
        }
        this.window = matches;
        this.windowLoadedAt = Date.now();
        markFresh('fixtures', `${matches.length} matches`);
        await this.refreshStandings();
        if (this.onWindowRefreshed) {
          try {
            const withP: any[] = [];
            for (let i = 0; i < matches.length; i += 25) { // fix159: 25 = the per-turn recompute budget (predCache.ts)
              setJob('predict main-league window');
              withP.push(...this.withPredictions(matches.slice(i, i + 25)));
              setJob(null);
              await yieldLoop();
            }
            this.onWindowRefreshed(withP);
          } catch (error: any) {
            logger.error('onWindowRefreshed failed', { message: error.message });
          }
        }
      })
      .catch(err => {
        logger.error('Window refresh failed, keeping previous data', { message: err.message });
        markFailed('fixtures', err);
        if (!this.window) throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  startBackgroundRefresh(intervalMs: number = CACHE_TTL_MS) {
    this.refreshWindow()
      .then(() => this.prepareHistoryModel())
      .then(() => this.refreshWindow()) // re-run so v2 predictions get recorded right away
      .catch(() => {});
    every('FD window', () => this.refreshWindow().catch(() => {}), intervalMs);
    // Re-sync the current season's results and refit v2 every 6 hours
    every('model v2 prepare', () => this.prepareHistoryModel().catch(() => {}), 6 * 60 * 60 * 1000);
    // Warm the usual-XI cache for the next two days of fixtures (slowly, in the background).
    // fix167: incremental — a few teams every 3 minutes (yielding between them) instead of one pass an hour over every
    // team that stayed "running" for many minutes and was named next to every stall in that time.
    after('usual lineups', () => this.prefetchUsualLineups().catch(() => {}), 6 * 60 * 1000);
    every('usual lineups', () => this.prefetchUsualLineups().catch(() => {}), 3 * 60 * 1000);
  }

  private prefetching = false;
  private static USUAL_PER_TICK = 6;
  /** Build usual XIs for the teams playing in the next 48h: a few per tick, one team at a time. */
  private async prefetchUsualLineups() {
    if (this.prefetching || !this.window) return;
    this.prefetching = true;
    try {
      const horizon = Date.now() + 48 * 60 * 60 * 1000;
      const teamIds = new Set<number>();
      for (const m of this.window) {
        const t = new Date(m.utcDate).getTime();
        if (t > Date.now() && t <= horizon && !(m.homeTeam?.lineup?.length > 0)) {
          if (m.homeTeam?.id) teamIds.add(m.homeTeam.id);
          if (m.awayTeam?.id) teamIds.add(m.awayTeam.id);
        }
      }
      const todo = [...teamIds].filter(id => !this.getCached(`usual:${id}:5`)).slice(0, FootballDataAPI.USUAL_PER_TICK);
      let built = 0;
      for (const id of todo) {
        // Lowest priority: only spend quota when plenty is left this minute (else the next tick goes on)
        if (this.quotaLeft < 8 && this.quotaResetAt > Date.now()) break;
        try {
          await this.getUsualLineup(id);
          built++;
        } catch {
          /* rate limit or transient error — a later tick retries */
        }
        await yieldLoop();
        await new Promise(r => setTimeout(r, 1500));
      }
      if (built) logger.info(`usual lineups prefetched for ${built} teams`);
    } finally {
      this.prefetching = false;
    }
  }

  get windowAge() {
    return this.windowLoadedAt ? Date.now() - this.windowLoadedAt : null;
  }

  /** Load/refresh standings for every competition in the window (cached 30 min). */
  private async refreshStandings() {
    const codes = Array.from(new Set((this.window || []).map(m => m.competition?.code).filter(Boolean)));
    // Tables change when a game ends: for competitions with a game in the last 3 hours the cached table is kept only
    // 5 minutes (instead of 30), so the table is current a few minutes after the final whistle.
    const now = Date.now();
    for (const code of codes) {
      const busy = (this.window || []).some(m => m.competition?.code === code && new Date(m.utcDate).getTime() < now && new Date(m.utcDate).getTime() > now - 3 * 3600 * 1000);
      const entry = this.cache.get(`standings:${code}`);
      if (busy && entry && entry.expires - 25 * 60 * 1000 < now) this.cache.delete(`standings:${code}`);
    }
    const results = await Promise.allSettled(codes.map(code => this.getStandings(code)));
    let ok = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        this.standingsByCode.set(codes[i], r.value);
        ok++;
      } else {
        const err: any = (r as PromiseRejectedResult).reason;
        console.log(`  ⚠️  standings ${codes[i]}: ${err?.response?.status || ''} ${err?.message || ''}`);
      }
    });
    console.log(`📊 Standings loaded for ${ok}/${codes.length} competitions`);
    if (ok) markFresh('standings', `${ok}/${codes.length} competitions`); else if (codes.length) markFailed('standings', 'no standings loaded');
  }

  /** v1: standings-based Poisson model (always available once standings are loaded). */
  predictionV1(match: any): Prediction | null {
    if (!match?.homeTeam?.id || !match?.awayTeam?.id) return null;
    const standings = this.standingsByCode.get(match.competition?.code) || null;
    try {
      return predictFromStandings(standings, match.homeTeam.id, match.awayTeam.id);
    } catch (error: any) {
      logger.warn('Prediction v1 failed', { matchId: match.id, message: error.message });
      return null;
    }
  }

  /** All model predictions for a match (v1 standings, v2 history) — for tracking both. */
  allPredictionsFor(match: any): Prediction[] {
    return cachedPredictions(match, () => freezePredictions(match, this.computePredictions(match)));
  }

  private computePredictions(match: any): Prediction[] {
    const out: Prediction[] = [];
    const v1 = this.predictionV1(match);
    if (v1) out.push(v1);
    try {
      const v2 = predictV2(match);
      if (v2) out.push(v2);
    } catch (error: any) {
      logger.warn('Prediction v2 failed', { matchId: match.id, message: error.message });
    }
    try {
      const v3 = predictV3(match);
      if (v3) out.push(v3, ...mixPredictions(match, v3)); // + v3-mix and the feature model (featureModel.ts)
    } catch (error: any) {
      logger.warn('Prediction v3 failed', { matchId: match.id, message: error.message });
    }
    // Champions League: European club Elo (cross-league ratings)
    if (match?.competition?.code === 'CL') {
      try {
        const e = predictClubEuro(match);
        if (e) out.push(e);
      } catch (error: any) {
        logger.warn('Prediction elo-euro failed', { matchId: match.id, message: error.message });
      }
    }
    return out;
  }

  /** The prediction shown on the site: v2 (history model) when available, else v1. */
  predictionFor(match: any): Prediction | null {
    return mainPrediction(this.allPredictionsFor(match));
  }

  /** Attach model predictions and (when stored) market odds to match objects. */
  withPredictions<T extends { id: number }>(matches: T[]): (T & { prediction: Prediction | null; predictions: Prediction[] })[] {
    return withMarket(matches).map(m => {
      const predictions = this.allPredictionsFor(m);
      return withLive({ ...m, prediction: mainPrediction(predictions), predictions });
    });
  }

  /** Download history (first time), map team names and fit model v2. */
  async prepareHistoryModel(forceSync = false) {
    try {
      const r = await prepareModelV2(this.standingsByCode, forceSync);
      console.log(`🧠 Model v2 ready: ${r.fitted} groups fitted`);
      const g = await timed('model v3 build', () => prepareModelV3Async());
      clearPredictionCache();
      console.log(`🧮 Model v3 (grid) ready: ${g} groups`);
      return r;
    } catch (error: any) {
      logger.error('Model v2 preparation failed', { message: error.message });
      return null;
    }
  }

  get standings() {
    return this.standingsByCode;
  }

  private async fetchWindow() {
    const today = new Date();
    const end = new Date(today.getTime() + MAX_DAYS * 24 * 60 * 60 * 1000);
    const dateFrom = toDateString(today);
    const dateTo = toDateString(end);

    console.log(`🔄 Fetching matches ${dateFrom} → ${dateTo} from ${this.competitions.length} competitions...`);

    const results = await Promise.allSettled(
      this.competitions.map(code =>
        this.client
          .get(`/competitions/${code}/matches`, { params: { dateFrom, dateTo } })
          .then(res => ({ code, matches: (res.data.matches || []) as any[] }))
      )
    );

    const all: any[] = [];
    let ok = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok++;
        console.log(`  ✅ ${r.value.code}: ${r.value.matches.length} matches`);
        all.push(...r.value.matches);
      } else {
        const err: any = r.reason;
        const status = err?.response?.status;
        const msg = err?.response?.data?.message || err?.message;
        console.log(`  ⚠️  failed: ${status || ''} ${msg}`);
        logger.warn('Competition fetch failed', { status, msg });
      }
    }

    // Every competition failed (rate limit burst, outage): treat as a failed refresh so the previous window is kept
    if (ok === 0) throw new Error('all competition fetches failed');

    // Keep only upcoming/live, dedupe, sort by kickoff
    const byId = new Map<number, any>();
    for (const m of all) {
      if (ACTIVE_STATUSES.has(m.status)) byId.set(m.id, m);
    }
    const matches = Array.from(byId.values()).sort(
      (a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime()
    );

    console.log(`✅ Total: ${matches.length} upcoming/live matches (next ${MAX_DAYS} days)`);
    return matches;
  }

  /** All matches (any status) between two dates, across the plan's competitions. Max 10 days. */
  async getMatchesInRange(dateFrom: string, dateTo: string) {
    const response = await this.client.get('/matches', { params: { dateFrom, dateTo }, ...this.bg });
    return (response.data.matches || []) as any[];
  }

  /** Matches currently in play across all competitions the plan allows. */
  private liveLast: { data: any[]; at: number } | null = null;
  private liveInFlight: Promise<any[]> | null = null;

  /**
   * Live matches. Visitors never wait for Football-Data.org (two calls, ~3 s with the rate limit): they get the last
   * list we fetched (refreshed every minute by the live poll, and in the background here when it is over 30 s old).
   * Pass fresh = true to wait for a new list (the live poll itself).
   */
  async getLiveMatches(fresh = false) {
    const cached = this.getCached<any[]>('live');
    if (cached) return cached;
    if (!fresh && this.liveLast && Date.now() - this.liveLast.at < 5 * 60 * 1000) {
      this.refreshLive().catch(() => undefined);
      return this.liveLast.data;
    }
    return this.refreshLive();
  }

  /** The last live list fetched, without an API call (the live loop uses it between fresh calls). */
  liveSnapshot(): any[] {
    return this.liveLast?.data || [];
  }

  private refreshLive(): Promise<any[]> {
    if (this.liveInFlight) return this.liveInFlight;
    this.liveInFlight = (async () => {
      try {
        // The API treats IN_PLAY and PAUSED separately: ask for both at once
        const [response, pausedRes] = await Promise.all([
          this.client.get('/matches', { params: { status: 'IN_PLAY' }, ...this.bg }),
          this.client.get('/matches', { params: { status: 'PAUSED' }, ...this.bg })
        ]);
        const inPlay: any[] = response.data.matches || [];
        const paused: any[] = pausedRes.data.matches || [];
        const live = [...inPlay, ...paused].filter(m => LIVE_STATUSES.has(m.status));
        this.setCached('live', live, LIVE_CACHE_TTL_MS);
        this.liveLast = { data: live, at: Date.now() };
        for (const m of live) reportLive(m.id, 'fd', m); // one live score everywhere (liveScores.ts)
        return live;
      } catch (error: any) {
        logger.error('Error fetching live matches', { error: error.message });
        throw error;
      } finally {
        this.liveInFlight = null;
      }
    })();
    return this.liveInFlight;
  }

  async getLeagues() {
    const cached = this.getCached<any[]>('leagues');
    if (cached) return cached;
    const response = await this.client.get('/competitions');
    const leagues = response.data.competitions || [];
    this.setCached('leagues', leagues, 60 * 60 * 1000);
    return leagues;
  }

  async getStandings(leagueCode: string) {
    const key = `standings:${leagueCode}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/competitions/${leagueCode}/standings`, this.bg);
    this.setCached(key, response.data, 30 * 60 * 1000);
    return response.data;
  }

  /**
   * Last-5 form for every team of a competition, newest first ("W,D,L,W,W"), from its finished league matches.
   * Football-Data.org's standings leave form empty on our plan. One call per competition, cached 30 min.
   */
  async getForm(leagueCode: string): Promise<Map<number, string>> {
    const key = `form:${leagueCode}`;
    const cached = this.getCached<Map<number, string>>(key);
    if (cached) return cached;
    const response = await this.client.get(`/competitions/${leagueCode}/matches`, { ...this.bg, params: { status: 'FINISHED' } });
    const matches: any[] = (response.data.matches || [])
      .filter((m: any) => m.score?.winner && (!m.stage || m.stage === 'REGULAR_SEASON'))
      .sort((a: any, b: any) => String(b.utcDate).localeCompare(String(a.utcDate)));
    const form = new Map<number, string[]>();
    for (const m of matches) {
      const w = m.score.winner;
      for (const [id, me] of [[m.homeTeam?.id, 'HOME_TEAM'], [m.awayTeam?.id, 'AWAY_TEAM']] as [number, string][]) {
        if (!id) continue;
        const f = form.get(id) || [];
        if (f.length < 5) f.push(w === 'DRAW' ? 'D' : w === me ? 'W' : 'L');
        form.set(id, f);
      }
    }
    const out = new Map<number, string>();
    form.forEach((f, id) => out.set(id, f.join(',')));
    this.setCached(key, out, 30 * 60 * 1000);
    return out;
  }

  /** Top scorers (with assists) for a competition. */
  async getScorers(leagueCode: string, limit: number = 40) {
    const key = `scorers:${leagueCode}:${limit}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/competitions/${leagueCode}/scorers`, { params: { limit } });
    this.setCached(key, response.data, 30 * 60 * 1000);
    return response.data;
  }

  async getMatch(matchId: number) {
    const key = `match:${matchId}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/matches/${matchId}`);
    this.setCached(key, response.data, 60 * 1000);
    reportLive(matchId, 'fd', response.data);
    return response.data;
  }

  async getHeadToHead(matchId: number, limit: number = 10) {
    const key = `h2h:${matchId}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/matches/${matchId}/head2head`, {
      params: { limit }
    });
    this.setCached(key, response.data, 60 * 60 * 1000);
    return response.data;
  }

  async getTeam(teamId: number) {
    const key = `team:${teamId}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/teams/${teamId}`);
    this.setCached(key, response.data, 60 * 60 * 1000);
    return response.data;
  }

  /** Last `limit` finished matches for a team (most recent first). */
  async getTeamRecentMatches(teamId: number, limit: number = 5) {
    const key = `teamform:${teamId}:${limit}`;
    const cached = this.getCached<any[]>(key);
    if (cached) return cached;

    const today = new Date();
    const from = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const response = await this.client.get(`/teams/${teamId}/matches`, {
      params: { status: 'FINISHED', dateFrom: toDateString(from), dateTo: toDateString(today) }
    });
    const matches: any[] = (response.data.matches || [])
      .sort((a: any, b: any) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime())
      .slice(0, limit);
    this.setCached(key, matches, 30 * 60 * 1000);
    return matches;
  }

  /** Full match object for a finished match — lineups never change, so cache for a day. */
  private async getFinishedMatch(matchId: number) {
    const key = `matchfull:${matchId}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;
    const response = await this.client.get(`/matches/${matchId}`, this.bg);
    this.setCached(key, response.data, 24 * 60 * 60 * 1000);
    return response.data;
  }

  /**
   * "Usual" starting XI for a team, built from its last `limit` finished matches:
   * the most-used formation and the players who started most often.
   * Shown on the match page until the official lineup is published.
   */
  async getUsualLineup(teamId: number, limit: number = 5) {
    const key = `usual:${teamId}:${limit}`;
    const cached = this.getCached<any>(key);
    if (cached) return cached;

    const recent = await this.getTeamRecentMatches(teamId, limit);
    // Sequential, spaced out — the API's per-minute limit is easy to hit with parallel calls
    const full: any[] = [];
    let failed = 0;
    // fix167: the thread is given back between matches (a cached match only runs microtasks), each turn ≤ 200 ms
    const step = yielder(200);
    for (const m of recent) {
      const wasCached = !!this.getCached(`matchfull:${m.id}`);
      try {
        full.push(await this.getFinishedMatch(m.id));
      } catch {
        failed++;
      }
      if (!wasCached) await new Promise(r => setTimeout(r, 400));
      else await yieldLoop();
    }

    const starts = new Map<number, { player: any; starts: number; lastDate: string }>();
    const formations = new Map<string, { count: number; lastDate: string }>();
    let analysed = 0;

    for (const m of full) {
      await step();
      if (!m) continue;
      const side = m.homeTeam?.id === teamId ? m.homeTeam : m.awayTeam?.id === teamId ? m.awayTeam : null;
      const lineup: any[] = side?.lineup || [];
      if (!lineup.length) continue;
      analysed++;
      const date = m.utcDate || '';
      if (side.formation) {
        const f = formations.get(side.formation) || { count: 0, lastDate: '' };
        f.count++;
        if (date > f.lastDate) f.lastDate = date;
        formations.set(side.formation, f);
      }
      for (const p of lineup) {
        if (!p?.id) continue;
        const s = starts.get(p.id) || { player: p, starts: 0, lastDate: '' };
        s.starts++;
        if (date > s.lastDate) {
          s.lastDate = date;
          s.player = p; // keep the most recent position / shirt number
        }
        starts.set(p.id, s);
      }
    }

    if (!analysed) {
      const empty = { teamId, basedOn: 0, formation: null, lineup: [] };
      // Only remember "no data" when every fetch succeeded — a rate-limited attempt should be retried
      if (!failed) this.setCached(key, empty, 60 * 60 * 1000);
      return empty;
    }

    const formation =
      Array.from(formations.entries()).sort((a, b) => b[1].count - a[1].count || (b[1].lastDate > a[1].lastDate ? 1 : -1))[0]?.[0] ||
      null;

    const ranked = Array.from(starts.values()).sort((a, b) => b.starts - a.starts || (b.lastDate > a.lastDate ? 1 : -1));
    const isGk = (p: any) => /goal/i.test(p.position || '');
    const gk = ranked.find(r => isGk(r.player));
    const outfield = ranked.filter(r => !isGk(r.player)).slice(0, 10);
    const groupOrder = (p: any) => {
      const pos = p.position || '';
      if (/def/i.test(pos)) return 0;
      if (/mid/i.test(pos)) return 1;
      if (/off|att|for/i.test(pos)) return 2;
      return 1;
    };
    const xi = [...(gk ? [gk] : []), ...outfield.sort((a, b) => groupOrder(a.player) - groupOrder(b.player))];

    const result = {
      teamId,
      basedOn: analysed,
      formation,
      lineup: xi.map(r => ({
        id: r.player.id,
        name: r.player.name,
        position: r.player.position || null,
        shirtNumber: r.player.shirtNumber ?? null,
        starts: r.starts
      }))
    };
    // Partial (some fetches failed) → keep briefly so it gets rebuilt; complete → keep 6h
    this.setCached(key, result, failed ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000);
    return result;
  }

  /** Find a team's row in a competition table (TOTAL table, or the group that contains it). */
  private findStandingRow(standings: any, teamId: number) {
    const tables: any[] = standings?.standings || [];
    const total = tables.find(t => t.type === 'TOTAL' && t.table?.some((r: any) => r.team?.id === teamId));
    const table = total || tables.find(t => t.table?.some((r: any) => r.team?.id === teamId));
    if (!table) return null;
    const row = table.table.find((r: any) => r.team?.id === teamId);
    return row ? { ...row, group: table.group || null, teamsInTable: table.table.length } : null;
  }

  /**
   * Everything the match page needs in one call:
   * match (events, lineups, stats), head-to-head, both teams' standing + recent form.
   */
  async getMatchDetails(matchId: number) {
    const match = await this.getMatch(matchId);
    if (!match || !match.homeTeam || !match.awayTeam) {
      throw Object.assign(new Error('Match not found'), { response: { status: 404 } });
    }
    const homeId = match.homeTeam.id;
    const awayId = match.awayTeam.id;
    const code = match.competition?.code;

    // Official lineups arrive ~1h before kick-off; until then show each side's usual XI
    const officialLineups = (match.homeTeam.lineup?.length || 0) > 0 || (match.awayTeam.lineup?.length || 0) > 0;
    const finished = ['FINISHED', 'AWARDED', 'CANCELLED'].includes(match.status);
    const wantProbable = !officialLineups && !finished;

    const [h2h, standings, homeForm, awayForm, probHome, probAway] = await Promise.all([
      this.getHeadToHead(matchId, 10).catch(() => null),
      code ? this.getStandings(code).catch(() => null) : Promise.resolve(null),
      this.getTeamRecentMatches(homeId, 5).catch(() => []),
      this.getTeamRecentMatches(awayId, 5).catch(() => []),
      wantProbable ? withTimeout(this.getUsualLineup(homeId), PROBABLE_WAIT_MS) : Promise.resolve(null),
      wantProbable ? withTimeout(this.getUsualLineup(awayId), PROBABLE_WAIT_MS) : Promise.resolve(null)
    ]);

    if (standings && code) this.standingsByCode.set(code, standings);

    return {
      match,
      prediction: this.predictionFor(match),
      predictions: this.allPredictionsFor(match), // every model, so the page can switch between them
      head2head: h2h,
      standings: {
        home: standings ? this.findStandingRow(standings, homeId) : null,
        away: standings ? this.findStandingRow(standings, awayId) : null
      },
      form: { home: homeForm, away: awayForm },
      probableLineups: wantProbable ? { home: probHome, away: probAway } : null,
      market: oddsFor(matchId)
    };
  }
}

export default new FootballDataAPI();

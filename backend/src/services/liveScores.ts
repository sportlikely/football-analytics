import { every } from './perf';
import { isWorker } from './role';
import { onState, publishState } from './shared';
/**
 * One live score everywhere (Oct 2026). The match list used Football-Data.org's bulk live feed (every 60 s, often a goal
 * behind) while the match page used FD's single-match call, so the list could say 3-2 and the page 3-3. Every live
 * reading of a Football-Data.org match — FD bulk feed, FD single match, API-Football live=all, API-Football fixture —
 * is reported here, and the list, the live push and the match page all show the same best reading:
 *  - API-Football when it says FINISHED or its reading is at most 2 minutes old (it updates faster), unless FD says
 *    FINISHED, AF doesn't, and FD's reading is newer;
 *  - otherwise the newer of the two.
 * A match FD already has as FINISHED is never turned back to live. Entries go 6 h after their last report.
 * Admin: GET /api/admin/live-book.
 */
type Source = 'af' | 'fd';
interface State {
  status: string; minute: number | null; injuryTime: number | null;
  home: number; away: number; htHome: number | null; htAway: number | null; at: number;
}
const book = new Map<number, { af?: State; fd?: State; last: number }>();

const LIVE_OR_DONE = new Set(['IN_PLAY', 'PAUSED', 'FINISHED']);
const AF_FRESH_MS = 2 * 60 * 1000;
const KEEP_MS = 6 * 3600 * 1000;

const num = (x: any): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** Record a reading of a match (any Football-Data.org-shaped match object) from one source. */
export function reportLive(matchId: number, source: Source, m: any, at = Date.now()) {
  if (!m || !Number.isFinite(Number(matchId))) return;
  const status = String(m.status || '');
  if (!LIVE_OR_DONE.has(status)) return;
  const home = num(m.score?.fullTime?.home ?? m.score?.fullTime?.homeTeam), away = num(m.score?.fullTime?.away ?? m.score?.fullTime?.awayTeam);
  if (home === null || away === null) return;
  const st: State = {
    status, minute: num(m.minute), injuryTime: num(m.injuryTime), home, away,
    htHome: num(m.score?.halfTime?.home ?? m.score?.halfTime?.homeTeam), htAway: num(m.score?.halfTime?.away ?? m.score?.halfTime?.awayTeam), at
  };
  const e = book.get(matchId) || { last: 0 };
  const prev = e[source];
  if (prev && prev.at > at) return; // an older reading arriving late
  e[source] = st;
  e.last = Math.max(e.last, at);
  book.set(matchId, e);
}

/** The reading to show for a match, or null when nothing is known. */
export function bestLive(id: number): (State & { source: Source }) | null {
  const e = book.get(id);
  if (!e) return null;
  const { af, fd } = e;
  if (af && (af.status === 'FINISHED' || Date.now() - af.at <= AF_FRESH_MS)) {
    if (fd && fd.status === 'FINISHED' && af.status !== 'FINISHED' && fd.at > af.at) return { ...fd, source: 'fd' };
    return { ...af, source: 'af' };
  }
  if (af && fd) return af.at > fd.at ? { ...af, source: 'af' } : { ...fd, source: 'fd' };
  if (af) return { ...af, source: 'af' };
  if (fd) return { ...fd, source: 'fd' };
  return null;
}

/** A copy of a Football-Data.org match with the best known status, minute and score (unchanged if nothing known). */
export function withLiveScore<T extends { id: number; status?: string; score?: any }>(match: T): T {
  if (!match) return match;
  const b = bestLive(match.id);
  if (!b) return match;
  // never turn a match FD already has as finished back to live
  if (match.status === 'FINISHED' && b.status !== 'FINISHED') return match;
  const done = b.status === 'FINISHED';
  const score = {
    ...(match.score || {}),
    fullTime: { ...(match.score?.fullTime || {}), home: b.home, away: b.away },
    ...(b.htHome !== null && b.htAway !== null ? { halfTime: { ...(match.score?.halfTime || {}), home: b.htHome, away: b.htAway } } : {}),
    ...(done ? { winner: b.home > b.away ? 'HOME_TEAM' : b.home < b.away ? 'AWAY_TEAM' : 'DRAW' } : {})
  };
  return { ...match, status: b.status, minute: b.minute, injuryTime: b.injuryTime, score };
}

/** fix209: every match in the book with its best reading (the scorers check: live and just finished games). */
export function liveBookIds(): { id: number; status: string; home: number; away: number }[] {
  const out: { id: number; status: string; home: number; away: number }[] = [];
  for (const id of book.keys()) { const b = bestLive(id); if (b) out.push({ id, status: b.status, home: b.home, away: b.away }); }
  return out;
}

/** Admin: every match in the book with both readings and the one shown. */
export function liveBookStatus() {
  const now = Date.now();
  const age = (s?: State) => (s ? Math.round((now - s.at) / 1000) : null);
  const view = (s?: State) => (s ? { status: s.status, minute: s.minute, injuryTime: s.injuryTime, score: `${s.home}-${s.away}`, ht: s.htHome !== null ? `${s.htHome}-${s.htAway}` : null, ageSec: age(s) } : null);
  const rows = [...book.entries()].map(([id, e]) => {
    const b = bestLive(id);
    return { id, shown: b ? { source: b.source, status: b.status, minute: b.minute, score: `${b.home}-${b.away}` } : null, af: view(e.af), fd: view(e.fd), disagree: !!(e.af && e.fd && (e.af.home !== e.fd.home || e.af.away !== e.fd.away)) };
  });
  return { matches: rows.length, disagreements: rows.filter(r => r.disagree).length, rows: rows.sort((a, b) => (b.disagree ? 1 : 0) - (a.disagree ? 1 : 0) || b.id - a.id) };
}

every('live scores cleanup', () => {
  const now = Date.now();
  for (const [id, e] of book) if (now - e.last > KEEP_MS) book.delete(id);
}, 10 * 60 * 1000).unref();

/*
 * fix202: the worker polls the live feeds; the web process answers the match pages. After every live tick the worker
 * publishes its book and the web process merges it (the newer reading per source wins: a match page opened in the web
 * process can have read Football-Data.org a moment later).
 */
export function publishLiveBook() {
  if (isWorker) publishState('live:book', book);
}
onState('live:book', (_k, v: Map<number, { af?: State; fd?: State; last: number }>) => {
  for (const [id, e] of v) {
    const cur = book.get(id);
    if (!cur) { book.set(id, e); continue; }
    for (const s of ['af', 'fd'] as const) if (e[s] && (!cur[s] || cur[s]!.at < e[s]!.at)) cur[s] = e[s];
    cur.last = Math.max(cur.last, e.last);
  }
});

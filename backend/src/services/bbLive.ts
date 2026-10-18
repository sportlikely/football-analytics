/**
 * Basketball live win chance (Oct 2026): the home team's win chance and a projected final score while a game is on.
 *
 * Start from the bb-v3 prediction saved at tip-off and play the rest of the game on the margin:
 *  - expected margin still to come = pre-game margin × share of the game left; the pre-game margin is read back from the
 *    pre-game win chance (sigma × probit(pHome)), so at tip-off the answer equals the pre-game prediction exactly;
 *  - leads shrink a little: a share `b` of the current lead is given back in proportion to the time left;
 *  - spread of what is still to come = league sigma × (share left)^(a/2) (a < 1: more swing late than a pure random walk);
 *  - final margin > 0 → home win (a tie goes to overtime, which this counts as roughly 50/50 with the same tilt).
 * Projected final score: current score + pre-game points × share left, with the same share of the lead given back.
 *
 * Fitted on public NBA quarter scores (ESPN, 2020-21 + 2021-22 seasons, 2,377 games) with a stand-in pre-game rating,
 * tested on 2022-23 + 2023-24 (2,495 games): log loss after Q1 0.581 → 0.567, at half-time 0.508 → 0.488, after Q3
 * 0.369 → 0.358 vs a = 1, b = 0; calibrated within ~3 points in every 10% band. Projected final score (per team) off
 * by 8.0 / 6.7 / 4.7 points after Q1 / Q2 / Q3; using the pace so far instead of the pre-game points was worse.
 * The same test on every league with bb-v3's own walk-forward predictions: /api/bb/live-test (admin).
 */
import { db } from '../db';
import { BB_LEAGUES, setBbStoredHook } from './basketball';
import { bbWalkForward, leagueModelInfo, normCdf, normInv } from './bbModel';

export const BB_LIVE_CONF = { a: 0.7, b: -0.4 };
export type BbLiveConf = typeof BB_LIVE_CONF;

/** Quarter length in minutes: NBA and CBA play 4 × 12, FIBA leagues 4 × 10; overtime is 5. */
export const periodLen = (code: string) => (code === 'NBA' || code === 'CBA' ? 12 : 10);

export interface BbLiveIn { pHome: number; home: number; away: number }
export interface BbLive { pHome: number; pAway: number; score: { home: number; away: number }; total: number; left: number }

/** Win chance and projected final score with `left` = share of regulation still to play (0..1). */
export function bbLiveProbs(pre: BbLiveIn, sigma: number, hs: number, as_: number, left: number, conf: BbLiveConf = BB_LIVE_CONF) {
  const rem = Math.min(1, Math.max(0, left));
  const p0 = Math.min(0.995, Math.max(0.005, pre.pHome));
  const mEff = sigma * normInv(p0);
  const d = hs - as_;
  const mean = d + rem * mEff + conf.b * d * rem;
  const sd = Math.max(0.5, sigma * Math.pow(rem, conf.a / 2));
  const pHome = Math.min(0.999, Math.max(0.001, normCdf(mean / sd)));
  // the score split uses the pre-game points themselves, so at tip-off the projected score is the pre-game one
  const restT = rem * (pre.home + pre.away), restM = rem * (pre.home - pre.away) + conf.b * d * rem;
  return { pHome, home: hs + (restT + restM) / 2, away: as_ + (restT - restM) / 2 };
}

/** Share of regulation left from the live status, the minutes played in the period and the quarter scores. */
export function shareLeft(code: string, status: string, timer: number | null, quarters: any): number | null {
  const len = periodLen(code), reg = 4 * len;
  const qn = ['Q1', 'Q2', 'Q3', 'Q4'].indexOf(status);
  const played = Number.isFinite(Number(timer)) && timer !== null ? Math.min(len, Math.max(0, Number(timer))) : 0;
  if (qn >= 0) return (reg - qn * len - played) / reg;
  if (status === 'HT') return 0.5;
  if (status === 'OT') return Math.max(0, 5 - Math.min(5, played)) / reg;
  if (status === 'BT') {
    // break between quarters: the last quarter with points (a played quarter is never 0 points)
    const h: any[] = quarters?.home || [], a: any[] = quarters?.away || [];
    let done = 0;
    for (let i = 0; i < 4; i++) if (Number(h[i]) > 0 || Number(a[i]) > 0) done = i + 1;
    if (done >= 4) return 0; // break before overtime
    return done ? (reg - done * len) / reg : null;
  }
  return null;
}

/** The live block for a game being played, from the prediction saved at tip-off; null when not live or not usable. */
export function bbLiveFor(g: { code: string; status: string | null; timer: number | null; quarters: any; hs: number | null; as_: number | null }, pre: BbLiveIn | null): BbLive | null {
  if (!pre || !g.status) return null;
  const left = shareLeft(g.code, g.status, g.timer, g.quarters);
  if (left === null) return null;
  const info = leagueModelInfo(g.code);
  if (!info || !(info.sigma > 0)) return null;
  const r = bbLiveProbs(pre, info.sigma, Number(g.hs) || 0, Number(g.as_) || 0, left);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const ph = Math.round(r.pHome * 1000) / 10;
  return { pHome: ph, pAway: r1(100 - ph), score: { home: Math.round(r.home), away: Math.round(r.away) }, total: Math.round(r.home + r.away), left: Math.round(left * 1000) / 1000 };
}

/* ---------------- fix178: swing chart (samples per live tick) ---------------- */

db.exec(`CREATE TABLE IF NOT EXISTS bb_live_samples (game_id INTEGER NOT NULL, t REAL NOT NULL, p REAL NOT NULL, hs INTEGER, as_ INTEGER, PRIMARY KEY (game_id, t))`);
const BB_DONE = new Set(['FT', 'AOT']);
function preOf(id: number): BbLiveIn | null {
  const p = db.prepare(`SELECT p_home, home_pts, away_pts FROM bb_predictions WHERE game_id = ?`).get(id) as any;
  return p ? { pHome: p.p_home, home: p.home_pts, away: p.away_pts } : null;
}
/** One sample per game and store of games: t = share of regulation played (overtime past 1), p = home win %. */
function sampleBb(ids: number[]) {
  const row = db.prepare(`SELECT game_id, code, status, timer, quarters, hs, as_ FROM bb_games WHERE game_id = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO bb_live_samples (game_id, t, p, hs, as_) VALUES (?, ?, ?, ?, ?)`);
  const hasAny = db.prepare(`SELECT MAX(t) AS t FROM bb_live_samples WHERE game_id = ?`);
  for (const id of ids) {
    const g = row.get(id) as any;
    if (!g) continue;
    const pre = preOf(id);
    if (!pre) continue;
    let q: any = null; try { q = JSON.parse(g.quarters || 'null'); } catch { q = null; }
    if (BB_DONE.has(g.status)) {
      // the final point, once, and only for a game sampled live (no made-up curves)
      const last = (hasAny.get(id) as any)?.t;
      if (last == null) continue;
      const won = Number(g.hs) > Number(g.as_);
      put.run(id, Math.round((Math.max(1, last) + 0.001) * 1000) / 1000, won ? 99.9 : 0.1, g.hs, g.as_);
      continue;
    }
    const live = bbLiveFor({ code: g.code, status: g.status, timer: g.timer, quarters: q, hs: g.hs, as_: g.as_ }, pre);
    if (!live) continue;
    // overtime (5 min) sits just past 1: the further into it, the further right
    const t = g.status === 'OT' ? 1 + Math.max(0, 5 / (4 * periodLen(g.code)) - live.left) : 1 - live.left;
    put.run(id, Math.round(t * 1000) / 1000, live.pHome, g.hs, g.as_);
  }
}
/** The swing chart of a game: tip-off (the saved prediction), the samples, the result. */
export function bbLiveCurve(id: number): { t: number; p: number }[] {
  const pre = preOf(id);
  if (!pre) return [];
  const rows = db.prepare(`SELECT t, p FROM bb_live_samples WHERE game_id = ? ORDER BY t`).all(id) as any[];
  return rows.length ? [{ t: 0, p: Math.round(pre.pHome * 1000) / 10 }, ...rows.map(r => ({ t: r.t, p: r.p }))] : [];
}
setBbStoredHook(ids => { try { sampleBb(ids); } catch { /* optional */ } });

/* ---------------- quarter test (admin) ---------------- */

interface QRow { code: string; season: string; p: number; pts: number; sigma: number; hs: number; as_: number; hq: number[]; aq: number[] }

function rows(): QRow[] {
  const out: QRow[] = [];
  const q = db.prepare(`SELECT game_id, season, hs, as_, quarters FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND quarters IS NOT NULL`);
  for (const l of BB_LEAGUES) {
    const info = leagueModelInfo(l.code);
    const wf = bbWalkForward(l.code).rows;
    if (!info || !wf.length) continue;
    const pred = new Map(wf.map(r => [r[0], r]));
    for (const g of q.all(l.code) as any[]) {
      const w = pred.get(g.game_id);
      if (!w || w[3] == null) continue;
      let j: any;
      try { j = JSON.parse(g.quarters); } catch { continue; }
      const hq = (j?.home || []).slice(0, 4).map(Number), aq = (j?.away || []).slice(0, 4).map(Number);
      if (hq.length < 4 || aq.length < 4 || [...hq, ...aq].some(x => !Number.isFinite(x))) continue;
      out.push({ code: l.code, season: g.season, p: w[1], pts: w[3], sigma: info.sigma, hs: g.hs, as_: g.as_, hq, aq });
    }
  }
  return out;
}

type Mode = 'live' | 'pre' | 'plain';
function score(rs: QRow[], q: number, conf: BbLiveConf, mode: Mode) {
  let ll = 0, hit = 0, br = 0, mae = 0;
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const r of rs) {
    const y = r.hs > r.as_ ? 1 : 0;
    const hs = r.hq.slice(0, q).reduce((s, x) => s + x, 0), as_ = r.aq.slice(0, q).reduce((s, x) => s + x, 0);
    const pre = { pHome: mode === 'plain' ? 0.5 : r.p, home: r.pts / 2, away: r.pts / 2 };
    const out = mode === 'pre' ? { pHome: r.p, home: 0, away: 0 } : bbLiveProbs(pre, r.sigma, hs, as_, 1 - q / 4, conf);
    const p = Math.min(1 - 1e-4, Math.max(1e-4, out.pHome));
    ll += -Math.log(y ? p : 1 - p);
    br += (p - y) ** 2;
    if ((p >= 0.5 ? 1 : 0) === y) hit++;
    if (mode === 'live') mae += Math.abs(out.home + out.away - r.hs - r.as_);
    const b = buckets[Math.min(9, Math.floor(p * 10))];
    b.n++; b.p += p; b.y += y;
  }
  const n = rs.length || 1, r4 = (x: number) => Math.round(x * 10000) / 10000;
  return {
    n: rs.length, logLoss: r4(ll / n), brier: r4(br / n), hitRate: Math.round((1000 * hit) / n) / 10,
    ...(mode === 'live' ? { totalOffBy: Math.round((10 * mae) / n) / 10 } : {}),
    ...(mode === 'live' ? { calibration: buckets.filter(b => b.n).map((b, i) => ({ said: Math.round((1000 * b.p) / b.n) / 10, happened: Math.round((1000 * b.y) / b.n) / 10, n: b.n, band: `${i * 10}-${i * 10 + 10}%` })) } : {})
  };
}

/**
 * Quarter test: what the live win chance said after Q1, at half-time and after Q3 vs the result, on every finished game
 * with quarter scores and a walk-forward bb-v3 prediction. `tune` = grid over a / b, fit on the older seasons, scored on
 * the newest season of each league.
 */
export function bbLiveQuarterTest(conf: Partial<BbLiveConf> = {}, tune = false) {
  const all = rows();
  const c: BbLiveConf = { ...BB_LIVE_CONF, ...conf };
  const at = (rs: QRow[], k: BbLiveConf) => Object.fromEntries([1, 2, 3].map(q => [`afterQ${q}`, { pregameOnly: score(rs, q, k, 'pre'), scoreOnly: score(rs, q, k, 'plain'), live: score(rs, q, k, 'live') }]));
  const codes = [...new Set(all.map(r => r.code))];
  const result: any = {
    games: all.length, conf: c,
    all: at(all, c),
    byLeague: Object.fromEntries(codes.map(code => {
      const rs = all.filter(r => r.code === code);
      return [code, { n: rs.length, ...Object.fromEntries([1, 2, 3].map(q => { const s = score(rs, q, c, 'live'); return [`Q${q}`, { logLoss: s.logLoss, hitRate: s.hitRate, pre: score(rs, q, c, 'pre').logLoss }]; })) }];
    }))
  };
  if (tune) {
    const last = new Map<string, string>();
    for (const r of all) if (!last.has(r.code) || r.season > last.get(r.code)!) last.set(r.code, r.season);
    const train = all.filter(r => r.season !== last.get(r.code)), test = all.filter(r => r.season === last.get(r.code));
    const sum = (rs: QRow[], k: BbLiveConf) => Math.round(10000 * [1, 2, 3].reduce((s, q) => s + score(rs, q, k, 'live').logLoss, 0) / 3) / 10000;
    const grid: { a: number; b: number; train: number; test: number }[] = [];
    for (const a of [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2]) for (const b of [-0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0]) {
      const k = { ...c, a, b };
      grid.push({ a, b, train: sum(train, k), test: sum(test, k) });
    }
    grid.sort((x, y) => x.train - y.train);
    result.tune = { trainGames: train.length, testGames: test.length, current: { train: sum(train, c), test: sum(test, c) }, best: grid.slice(0, 8) };
  }
  return result;
}

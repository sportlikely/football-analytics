/**
 * fix292 — the college football (FBS) model lab, run inside the fix220 calibration build (worker, heavy() queue):
 * candidates in utils/collegeLab.ts, walk-forward on 2023, 2024, 2025 and 2026 so far, scored on log loss / Brier / hit
 * rate per band and against the closing line (market_lines, admin-only). The winner is promoted (model id ncaa-v3) only
 * when it beats the live college model on games it never saw (pickWinner); then the calibration layer is fitted on its
 * walk-forward chances and its live numbers are used for upcoming college games (labProb, from predictNfl).
 * Admin: /american-football/past → "College lab" (report `lab` in calib|report).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { yieldLoop } from './perf';
import {
  teamSeasons, labPass, tuneElo, fitCand, predCand, tableRow, pickWinner, marketAnchorWf, prodKey, CANDS, LAB_TESTS, LAB_FIT_LAST, LAB_TRAIN_FIRST, LAB_VERSION, LAB_MODEL,
  type LabGame, type LabTeam, type LabRow, type ProdMap, type EloP, type LabFit, type LabCand, type CandRow
} from '../utils/collegeLab';

/* ---------- inputs: box-score values per player (parsed once, then only new rows), rosters, closing lines ---------- */

const num = (x: any): number | null => { if (x === null || x === undefined || x === '') return null; const n = Number(String(x).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
/** value a game (the key-players card's weights, fix224): passing yards / 25, rushing and receiving yards / 10, touchdowns, interceptions, tackles, sacks */
const VAL: { group: RegExp; stat: RegExp; w: number }[] = [
  { group: /^passing$/i, stat: /^(yards|yds)$/i, w: 1 / 25 }, { group: /^passing$/i, stat: /^(passing touch downs|touchdowns|td|tds|passing touchdowns)$/i, w: 4 },
  { group: /^passing$/i, stat: /^(interceptions|int)$/i, w: -2 },
  { group: /^rushing$/i, stat: /^(yards|yds)$/i, w: 0.1 }, { group: /^rushing$/i, stat: /^(rushing touch downs|touchdowns|td|tds|rushing touchdowns)$/i, w: 6 },
  { group: /^receiving$/i, stat: /^(yards|yds)$/i, w: 0.1 }, { group: /^receiving$/i, stat: /^(receiving touch downs|touchdowns|td|tds|receiving touchdowns)$/i, w: 6 },
  { group: /defens/i, stat: /^(total tackles|tackles|tot)$/i, w: 0.5 }, { group: /defens/i, stat: /^sacks?$/i, w: 2 }
];
/** one team's box score (the provider's groups) → player → value */
export function boxValues(json: string | null): Map<number, number> {
  const out = new Map<number, number>();
  let groups: any[] = [];
  try { groups = json ? JSON.parse(json) : []; } catch { return out; }
  for (const g of Array.isArray(groups) ? groups : []) {
    const rules = VAL.filter(v => v.group.test(String(g?.name || '').trim()));
    for (const p of g?.players || []) {
      const id = num(p?.player?.id);
      if (!id) continue;
      let v = out.get(id) ?? 0;
      for (const x of p.statistics || []) {
        const k = String(x?.name || '').toLowerCase().trim();
        for (const r of rules) if (r.stat.test(k)) { const n = num(String(x.value ?? '').split(/[-/]/)[0]); if (n !== null) v += n * r.w; }
      }
      out.set(id, v);
    }
  }
  return out;
}

const prodCache = { row: 0, map: new Map() as ProdMap };
async function loadProd(): Promise<ProdMap> {
  for (;;) {
    const rows = db.prepare(`SELECT s.rowid AS rid, s.team_id, s.json, g.season FROM nfl_player_stats s JOIN nfl_games g ON g.game_id = s.game_id WHERE g.league = 2 AND s.rowid > ? ORDER BY s.rowid LIMIT 100`).all(prodCache.row) as any[];
    if (!rows.length) break;
    for (const r of rows) {
      prodCache.row = Math.max(prodCache.row, r.rid);
      for (const [pid, v] of boxValues(r.json)) { const k = prodKey(r.season, r.team_id, pid); prodCache.map.set(k, (prodCache.map.get(k) || 0) + v); }
    }
    await yieldLoop();
  }
  return prodCache.map;
}
function loadRoster(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const r of db.prepare(`SELECT p.player_id, p.team_id, p.season FROM nfl_players p JOIN nfl_teams t ON t.team_id = p.team_id WHERE t.league = 2 AND p.season IS NOT NULL`).all() as any[]) {
    const k = `${r.season}|${r.team_id}`;
    if (!out.has(k)) out.set(k, new Set());
    out.get(k)!.add(r.player_id);
  }
  return out;
}
/** closing money line of college games: home win chance without the margin */
export function closingLines(): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of db.prepare(`SELECT game_id, prices FROM market_lines WHERE sport = 'nfl' AND market = 'ml' AND closing = 1 AND league = '2'`).all() as any[]) {
    let j: any = null; try { j = JSON.parse(r.prices); } catch { continue; }
    const p = j?.p || {}, h = num(p.Home ?? p.home ?? p['1']), a = num(p.Away ?? p.away ?? p['2']);
    if (h !== null && a !== null && h > 0 && a > 0) out.set(r.game_id, h / (h + a));
  }
  return out;
}

export interface LabInput { games: LabGame[]; teams: Map<number, LabTeam>; base: Map<number, number>; v1wf: Map<number, number>; v2wf: Map<number, number>; liveId: 'ncaa-v1' | 'ncaa-v2' }
export interface LabLive { cand: LabCand; P: EloP; fit: LabFit; at: string; version: string }

/* ---------- the lab ---------- */

export async function runCollegeLab(inp: LabInput) {
  const t0 = Date.now();
  const { games, teams } = inp;
  const ts = teamSeasons(await loadProd(), teams, loadRoster());
  await yieldLoop();
  const done = games.filter(g => g.done);
  const firstSeason = Math.min(...done.map(g => g.season));
  const market = closingLines();
  const params: Record<number, EloP> = {};
  const tuneLL: Record<number, number> = {};
  const fitOn: Record<number, number[]> = {};
  const preds = new Map<string, { id: number; season: number; p: number; y: number; fbs: boolean }[]>();
  const push = (k: string, x: { id: number; season: number; p: number; y: number; fbs: boolean }) => { if (!preds.has(k)) preds.set(k, []); preds.get(k)!.push(x); };
  const lastFits: Partial<Record<LabCand, LabFit>> = {};
  const wfOf = new Map<LabCand, Map<number, number>>(CANDS.map(c => [c.id, new Map()]));
  const allRows = new Map<number, LabRow>();
  const common = (r: LabRow) => r.done && inp.base.has(r.id) && inp.v1wf.has(r.id) && (!inp.v2wf.size || inp.v2wf.has(r.id));
  for (const S of LAB_TESTS) {
    const last = Math.min(S - 1, LAB_FIT_LAST);
    const fitSeasons = Array.from({ length: 4 }, (_, i) => last - 3 + i).filter(s => s > firstSeason && done.some(g => g.season === s));
    const testN = done.filter(g => g.season === S).length;
    if (!fitSeasons.length || (testN < 30 && S <= LAB_FIT_LAST)) continue;
    const tuned = await tuneElo(games, teams, ts, fitSeasons, yieldLoop);
    params[S] = tuned.P; tuneLL[S] = Math.round(tuned.ll * 10000) / 10000; fitOn[S] = fitSeasons;
    const rows = await labPass(games, teams, ts, tuned.P, Infinity, yieldLoop);
    const train = rows.filter(r => r.done && r.season >= LAB_TRAIN_FIRST && r.season <= last && inp.base.has(r.id)).map(r => ({ r, base: inp.base.get(r.id)! }));
    if (train.length < 300) continue;
    const test = rows.filter(r => r.season === S && common(r));
    for (const c of CANDS) {
      const fit = await fitCand(c.id, train, yieldLoop);
      for (const r of test) { const p = predCand(fit, r, inp.base.get(r.id)!); push(c.id, { id: r.id, season: S, p, y: r.y, fbs: r.fbs }); wfOf.get(c.id)!.set(r.id, p); }
      if (S === LAB_TESTS[LAB_TESTS.length - 1]) lastFits[c.id] = fit; // fitted on 2022–2025: the live fit
      await yieldLoop();
    }
    for (const r of test) {
      push('ncaa-v1', { id: r.id, season: S, p: inp.v1wf.get(r.id)!, y: r.y, fbs: r.fbs });
      if (inp.v2wf.size) push('ncaa-v2', { id: r.id, season: S, p: inp.v2wf.get(r.id)!, y: r.y, fbs: r.fbs });
      allRows.set(r.id, r);
    }
  }
  const labels: Record<string, string> = { 'ncaa-v1': 'ncaa-v1 (Elo + QB, its walk-forward)', 'ncaa-v2': 'ncaa-v2 (efficiency + QB + context, its walk-forward)', ...Object.fromEntries(CANDS.map(c => [c.id, c.label])) };
  const table: CandRow[] = [...preds.entries()].map(([id, list]) => tableRow(id, labels[id] || id, list, market));
  const pick = pickWinner(table, inp.liveId);
  // the closing line itself and the market anchor (games with a closing line only)
  const mrows = [...allRows.values()].filter(r => market.has(r.id)).map(r => ({ id: r.id, t: r.t, y: r.y, base: inp.base.get(r.id)!, mkt: market.get(r.id)!, fbs: r.fbs }));
  const anchor = marketAnchorWf(mrows);
  const linesBySeason: Record<number, number> = {};
  for (const id of market.keys()) { const g = games.find(x => x.id === id); if (g) linesBySeason[g.season] = (linesBySeason[g.season] || 0) + 1; }
  let liveState: LabLive | null = null;
  const P26 = params[LAB_TESTS[LAB_TESTS.length - 1]];
  if (pick.promote && pick.winner && P26 && lastFits[pick.winner as LabCand]) {
    const cand = pick.winner as LabCand;
    liveState = { cand, P: P26, fit: lastFits[cand]!, at: new Date().toISOString(), version: LAB_VERSION };
  }
  const report = {
    version: LAB_VERSION, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), live: inp.liveId, tests: LAB_TESTS, fitLast: LAB_FIT_LAST,
    table, winner: pick.winner, promoted: pick.promote, model: pick.promote ? LAB_MODEL : inp.liveId, reason: pick.reason, params, tuneLL, fitOn, trainFrom: LAB_TRAIN_FIRST,
    market: { closingLines: market.size, bySeason: linesBySeason, anchor, note: 'closing lines are stored from fix278 on (feed of upcoming games); older seasons have none, so the anchor is fitted on this season as it grows' },
    roster: { teamSeasons: ts.size, withRet: [...ts.values()].filter(v => v.ret !== null).length, withTalent: [...ts.values()].filter(v => v.talent !== null).length }
  };
  const t = table.find(r => r.id === pick.winner);
  logger.info(`college lab: ${pick.reason}${t ? ` · ${t.id} FBS ${t.total.fbs.logLoss}` : ''} · anchor ${anchor.scored} games${anchor.better ? ' better than both' : ''}`);
  return { report, promoted: pick.promote, winner: pick.winner as LabCand | null, wf: pick.winner ? wfOf.get(pick.winner as LabCand) || new Map<number, number>() : new Map<number, number>(), live: liveState };
}

/* ---------- live: the promoted candidate's numbers of upcoming college games ---------- */

let liveRows: Map<number, LabRow> | null = null;
let liveFit: LabLive | null = null;
let liveKey = '', liveAt = 0;
/** Recomputes the upcoming games' lab rows (after a finished game, at most every 10 min); `stored` = M.readSync('lab|live'). */
export async function refreshLab(stored: LabLive | null, games: LabGame[], teams: Map<number, LabTeam>): Promise<void> {
  if (!stored?.fit || stored.version !== LAB_VERSION) { liveRows = null; liveFit = null; return; }
  const key = `${stored.at}|${games.length}|${games.filter(g => g.done).length}`;
  if (key === liveKey && Date.now() - liveAt < 10 * 60 * 1000) return;
  const ts = teamSeasons(await loadProd(), teams, loadRoster());
  const rows = await labPass(games, teams, ts, stored.P, Infinity, yieldLoop);
  liveRows = new Map(rows.filter(r => !r.done).map(r => [r.id, r]));
  liveFit = stored; liveKey = key; liveAt = Date.now();
}
/** The lab model's home win chance of an upcoming game (null = not promoted / no row); base = the chance before it. */
export function labProb(gameId: number, base: number): number | null {
  const r = liveRows?.get(gameId);
  if (!r || !liveFit) return null;
  const p = predCand(liveFit.fit, r, base);
  return Number.isFinite(p) ? p : null;
}
export const labModelId = () => LAB_MODEL;

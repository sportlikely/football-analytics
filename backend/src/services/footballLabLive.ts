/**
 * fix291: the football lab's promoted layer as applied live (no job code: read by leagueFixLive.applyLeagueFix, so by
 * both prediction builders, afMatches.ts and footballDataAPI.ts, before the per-league layer and fix254's recent
 * calibration). Written by the nightly lab (services/footballLab.ts) into model_config 'football_lab_live'; nothing is
 * applied until a candidate passes fix251's bootstrap rule there.
 *
 * Inputs: the feature model's vector of the fixture (featureModel.featureInputsFor), the lab's team state built from the
 * same fixtures (utils/footballLab.ts labLearn / labFeatures — the code the nightly test used), the margin-free market
 * (odds.ts, never shown) and the v3 rows of the prediction. The numbers before the layer are kept in memory per match and
 * model (labRawFor) and saved by tracking.recordPredictions in predictions.lab_raw: never on the prediction itself, so
 * no visitor can work a market price back out of an anchored number.
 */
import { getConfig, featureInputsFor, FEAT_MODEL, type FeatState } from './featureModel';
import { oddsFor } from './odds';
import { groupOfDiv } from '../utils/dailyRules';
import { DRAW_ROW_IDS, TEAM_ROW_IDS } from './gridModel';
import { applyParams, labFeatures, labLearn, newLabState, norm, type CandId, type LabState, type P3, type Params } from '../utils/footballLab';

export const LAB_KEY = 'football_lab_live';
export interface LabLive { cand: CandId; params: Params; since: string; why: string; refitAt?: string }

let memo: { raw: string; v: LabLive | null } | null = null;
export function labLive(): LabLive | null {
  const raw = getConfig(LAB_KEY, '');
  if (memo && memo.raw === raw) return memo.v;
  let v: LabLive | null = null;
  try { const o = raw ? JSON.parse(raw) : null; if (o && o.cand && o.params && o.params.cand === o.cand) v = o; } catch { v = null; }
  memo = { raw, v };
  return v;
}

/** the lab's team state on a feature state's finished fixtures (kick-off order), one per state */
const states = new WeakMap<FeatState, LabState>();
export function labStateFor(st: FeatState): LabState {
  const hit = states.get(st);
  if (hit) return hit;
  const s = newLabState();
  const list = [...st.fixtures.values()].filter(f => f.hg != null && f.ag != null).sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : a.fid - b.fid));
  for (const f of list) labLearn(s, { div: f.div, home: `${f.grp}|${f.home}`, away: `${f.grp}|${f.away}`, hg: f.hg, ag: f.ag, xh: f.xh, xa: f.xa, sh: f.sh, sa: f.sa });
  states.set(st, s);
  return s;
}

/** the v3 rows of a prediction (team rows home − away, then the draw rows), in the replay's order */
export function rowsOfGrid(grid: any): Float64Array | null {
  const rows: any[] = Array.isArray(grid?.rows) ? grid.rows : [];
  if (!rows.length) return null;
  const out = new Float64Array(TEAM_ROW_IDS.length + DRAW_ROW_IDS.length);
  TEAM_ROW_IDS.forEach((id, i) => { const r = rows.find(x => x.id === id); out[i] = r && Number.isFinite(r.home) && Number.isFinite(r.away) ? r.home - r.away : 0; });
  DRAW_ROW_IDS.forEach((id, i) => { const r = rows.find(x => x.id === id); out[TEAM_ROW_IDS.length + i] = r && Number.isFinite(r.home) ? r.home : 5; });
  return out;
}

const RAW_MAX = 20000;
const raws = new Map<string, P3>();
/** the numbers a prediction had before the lab layer (%), for tracking.recordPredictions; null = no layer */
export const labRawFor = (matchId: number, model: string): P3 | null => raws.get(`${matchId}|${model}`) || null;

const LAYERED = new Set(['grid-v3', 'v3-mix']);
/** the layer on one game's league predictions (grid-v3 and v3-mix; feat-v1 and cup / national models untouched) */
export function applyLab<T extends { model: string; home: number; draw: number; away: number }>(match: any, preds: T[]): T[] {
  const L = labLive();
  if (!L || !preds.length) return preds;
  if (!preds.some(p => LAYERED.has(p.model))) return preds;
  let ctx: { f: Float64Array | null; div: string | null } = { f: null, div: null };
  try {
    const inp = featureInputsFor(match);
    if (inp) ctx = { f: labFeatures(labStateFor(inp.st), { div: inp.fx.div, home: `${inp.fx.grp}|${inp.fx.home}`, away: `${inp.fx.grp}|${inp.fx.away}` }, inp.x), div: inp.fx.div };
  } catch { ctx = { f: null, div: null }; }
  let mkt: P3 | null = null;
  try { const o = Number.isFinite(Number(match?.id)) ? oddsFor(Number(match.id)) : null; if (o) mkt = norm([o.probs.home, o.probs.draw, o.probs.away]); } catch { mkt = null; }
  const group = groupOfDiv(ctx.div, match?.competition?.code);
  const pc = (x: number) => Math.round(x * 1000) / 10;
  return preds.map(p => {
    if (!LAYERED.has(p.model) || p.model === FEAT_MODEL || (p as any).lab || ![p.home, p.draw, p.away].every(Number.isFinite)) return p;
    if ((p as any).grid?.scope && (p as any).grid.scope !== 'league') return p;
    const raw: P3 = [p.home, p.draw, p.away];
    const q = applyParams(L.params, { p: norm(raw), mkt, f: ctx.f, rows: rowsOfGrid((p as any).grid), group });
    if (!q.every(Number.isFinite)) return p;
    if (raws.size >= RAW_MAX) raws.delete(raws.keys().next().value as string);
    raws.set(`${match?.id}|${p.model}`, raw);
    const h = pc(q[0]), a = pc(q[2]);
    return { ...p, home: h, draw: Math.round((100 - h - a) * 10) / 10, away: a, lab: { cand: L.cand } };
  });
}

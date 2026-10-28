/**
 * fix255 / fix255b: the per-group layer as applied live (no job code: read by the prediction builders, afMatches.ts and
 * footballDataAPI.ts). Settings are written by the nightly test (services/leagueFix.ts) into model_config
 * 'league_fix_live': one per group whose candidate passed (applies to every league of the group), and a league's own
 * (≥ 150 games, passed on its own) which wins over its group's.
 */
import { getConfig, FEAT_MODEL } from './featureModel';
import { applySetting, groupOf, type LeagueSetting, type LGroup } from '../utils/leagueFix';

export const LIVE_KEY = 'league_fix_live';
export interface LiveLayer {
  since: Record<string, string>;
  groups: Partial<Record<LGroup, LeagueSetting>>;
  leagues: Record<string, LeagueSetting>;
  /** the group of every competition seen by the test (admin leagues are grouped by their country there) */
  compGroup: Record<string, LGroup>;
}
let memo: { raw: string; v: LiveLayer } | null = null;
export function liveLayer(): LiveLayer {
  const raw = getConfig(LIVE_KEY, '');
  if (memo && memo.raw === raw) return memo.v;
  let v: LiveLayer = { since: {}, groups: {}, leagues: {}, compGroup: {} };
  // fix255's per-league format ({ settings }) is dropped: nothing passed under it
  try { const o = raw ? JSON.parse(raw) : null; if (o && o.groups) v = { since: o.since || {}, groups: o.groups || {}, leagues: o.leagues || {}, compGroup: o.compGroup || {} }; } catch { /* bad row: no layer */ }
  memo = { raw, v };
  return v;
}
/** the setting that applies to a competition: its own, else its group's, else none */
export function settingFor(code: string, name?: string | null): LeagueSetting | null {
  const L = liveLayer();
  if (L.leagues[code]) return L.leagues[code];
  const g = L.compGroup[code] || groupOf(code, name);
  return L.groups[g] || null;
}

/**
 * The layer on one game's predictions: every model but feat-v1 (shadow) is moved by its league's setting; the original
 * numbers ride along as `league.raw` (saved in predictions.layer_raw, so the nightly test always starts from what the
 * model said). Competitions without a setting come back unchanged.
 */
export function applyLeagueFix<T extends { model: string; home: number; draw: number; away: number }>(match: any, preds: T[]): T[] {
  const code = match?.competition?.code;
  const s = code && preds.length ? settingFor(code, match?.competition?.name) : null;
  if (!s) return preds;
  const pc = (x: number) => Math.round(x * 1000) / 10;
  return preds.map(p => {
    if (p.model === FEAT_MODEL || (p as any).league || ![p.home, p.draw, p.away].every(Number.isFinite)) return p;
    const q = applySetting([p.home, p.draw, p.away], s);
    const h = pc(q[0]), a = pc(q[2]);
    return { ...p, home: h, draw: Math.round((100 - h - a) * 10) / 10, away: a, league: { raw: [p.home, p.draw, p.away], cand: s.cand, variant: s.variant } };
  });
}

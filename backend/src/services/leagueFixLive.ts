/**
 * fix255: the per-league layer as applied live (no job code: read by the prediction builders, afMatches.ts and
 * footballDataAPI.ts). Settings are written by the nightly test (services/leagueFix.ts) into model_config
 * 'league_fix_live' — only leagues where a candidate passed (or stays not worse) are in it.
 */
import { getConfig, FEAT_MODEL } from './featureModel';
import { oddsFor } from './odds';
import { applySetting, norm, type LeagueSetting, type P3 } from '../utils/leagueFix';

export const LIVE_KEY = 'league_fix_live';
export interface LiveLayer { since: Record<string, string>; settings: Record<string, LeagueSetting & { name: string }> }
let memo: { raw: string; v: LiveLayer } | null = null;
export function liveLayer(): LiveLayer {
  const raw = getConfig(LIVE_KEY, '');
  if (memo && memo.raw === raw) return memo.v;
  let v: LiveLayer = { since: {}, settings: {} };
  try { const o = raw ? JSON.parse(raw) : null; if (o && o.settings) v = { since: o.since || {}, settings: o.settings }; } catch { /* bad row: no layer */ }
  memo = { raw, v };
  return v;
}

/**
 * The layer on one game's predictions: every model but feat-v1 (shadow) is moved by its league's setting; the original
 * numbers ride along as `league.raw` (saved in predictions.layer_raw, so the nightly test always starts from what the
 * model said). Leagues without a setting come back unchanged. Market prices are only read (anchor), never added.
 */
export function applyLeagueFix<T extends { model: string; home: number; draw: number; away: number }>(match: any, preds: T[]): T[] {
  const code = match?.competition?.code;
  const s = code ? liveLayer().settings[code] : undefined;
  if (!s || !preds.length) return preds;
  let mkt: P3 | null = null;
  if (s.cand === 'anchor' || s.cand === 'calib+anchor') {
    try {
      const o = Number.isFinite(Number(match?.id)) ? oddsFor(Number(match.id)) : null;
      mkt = o ? norm([o.probs.home, o.probs.draw, o.probs.away]) : null;
    } catch { mkt = null; }
  }
  const pc = (x: number) => Math.round(x * 1000) / 10;
  return preds.map(p => {
    if (p.model === FEAT_MODEL || (p as any).league) return p;
    const q = applySetting([p.home, p.draw, p.away], mkt, s);
    const h = pc(q[0]), a = pc(q[2]);
    return { ...p, home: h, draw: Math.round((100 - h - a) * 10) / 10, away: a, league: { raw: [p.home, p.draw, p.away], cand: s.cand, unit: s.unit } };
  });
}

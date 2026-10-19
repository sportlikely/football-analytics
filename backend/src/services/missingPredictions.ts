/**
 * fix192 (Yarin: "every game gets a prediction"): every upcoming game of the next 7 days, in every sport, that has no
 * prediction — with the reason. Shown on the admin data health card (check "no-prediction-7d"); the target is zero.
 * Cancelled / postponed games are listed apart: they are not predicted on purpose and don't count.
 */
import { db } from '../db';
import { fallbackReason } from './afMatches';
import { predictGameCached, bbModelReady } from './bbModel';
import { predictNfl } from './nflModel';

const DAY = 86400000;
const FINAL_FD = ['FINISHED', 'AWARDED', 'CANCELLED', 'POSTPONED', 'SUSPENDED'];
const LIVE_FD = ['IN_PLAY', 'PAUSED'];
const BB_OFF = ['POST', 'CANC', 'SUSP', 'AWD', 'ABD'];
const NFL_OFF = ['CANC', 'PST', 'SUSP', 'AWD', 'ABD'];
const when = (iso: string) => String(iso || '').slice(0, 16).replace('T', ' ');

export interface Missing { items: string[]; off: string[]; checked: number }

/** `football`: the match list data health already loaded (with predictions). */
export function missingPredictions(football: any[], now = Date.now()): Missing {
  const to = now + 7 * DAY;
  const items: string[] = [], off: string[] = [];
  let checked = 0;

  // football: Football-Data.org + API-Football lists
  for (const m of football) {
    const t = new Date(m.utcDate).getTime();
    if (!(t > now && t < to) || LIVE_FD.includes(m.status)) continue;
    const name = `Football · ${m.homeTeam?.name ?? '?'} – ${m.awayTeam?.name ?? '?'} (${m.competition?.name ?? m.competition?.code ?? ''}, ${when(m.utcDate)} UTC)`;
    if (FINAL_FD.includes(m.status)) { if (m.status !== 'FINISHED') off.push(`${name} · ${m.status}`); continue; }
    checked++;
    if (m.prediction) continue;
    let why = '';
    try { why = fallbackReason(m); } catch (e: any) { why = e.message; }
    items.push(`${name} · ${why}`);
  }

  // basketball
  const fromIso = new Date(now).toISOString(), toIso = new Date(to).toISOString();
  try {
    const rows = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week, home_name, away_name FROM bb_games WHERE kickoff > ? AND kickoff < ? ORDER BY kickoff`).all(fromIso, toIso) as any[];
    for (const g of rows) {
      const name = `Basketball · ${g.home_name} – ${g.away_name} (${g.code}, game ${g.game_id}, ${when(g.kickoff)} UTC)`;
      const st = g.status || 'NS';
      if (BB_OFF.includes(st)) { off.push(`${name} · ${st}`); continue; }
      if (st !== 'NS') continue;
      checked++;
      if (predictGameCached(g)) continue;
      items.push(`${name} · ${bbModelReady(g.code) ? 'the model gave no number' : 'league model not built (fewer than 2 seasons of results, or still building after a restart)'}`);
    }
  } catch { /* basketball tables not there */ }

  // NFL + college
  try {
    const rows = db.prepare(`SELECT game_id, league, kickoff, status, home_id, away_id, home_name, away_name FROM nfl_games WHERE kickoff > ? AND kickoff < ? ORDER BY kickoff`).all(fromIso, toIso) as any[];
    for (const g of rows) {
      const name = `${g.league === 2 ? 'College football' : 'NFL'} · ${g.home_name || 'TBD'} – ${g.away_name || 'TBD'} (game ${g.game_id}, ${when(g.kickoff)} UTC)`;
      const st = g.status || 'NS';
      if (NFL_OFF.includes(st)) { off.push(`${name} · ${st}`); continue; }
      if (st !== 'NS') continue;
      checked++;
      if (!g.home_id || !g.away_id) { items.push(`${name} · teams not known yet`); continue; }
      let p = null;
      try { p = predictNfl(g.game_id); } catch { /* model error */ }
      if (!p) items.push(`${name} · not in the model's game list yet (ratings rebuild every 30 min) or the model is still building`);
    }
  } catch { /* NFL tables not there */ }

  return { items, off, checked };
}

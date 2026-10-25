/**
 * fix223 — "League settings fresh (<sport>)" in data health, every sport: the per-league settings (own / group / shared,
 * each kept only when it beat the shared model on games it never saw) were refitted in the last 35 days (monthly refit)
 * and, for basketball, on the shared settings live now. Football = v3's league tune (v3_league_conv), basketball =
 * bb-v4's league settings (bb_tuned 'leagues'), American football = the level settings (NFL / FBS / G5 / FCS) of the
 * calibration build, tennis = the tour × surface settings of the tennis report.
 */
import { db } from '../db';
import { storedLeagues, sharedParams, baseKey, leagueTuneDue } from './bbTuner';
import { afCalibReport } from './afCalibration';
import { tennisCalib } from './tennisModel';

export const FRESH_DAYS = 35;
interface Line { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items: string[] }
const NAME = { football: 'Football', basketball: 'Basketball', nfl: 'American football', tennis: 'Tennis' } as const;
type Sport = keyof typeof NAME;

/** the line from a fit time and the leagues' rows (pure: tests) */
export function freshLine(sport: Sport, at: string | null, rows: { league: string; used: string; gain?: number | null }[], now = Date.now(), stale: string | null = null): Line {
  const id = `league-settings-${sport}`, label = `League settings fresh (${NAME[sport]})`;
  if (!at) return { id, label, level: 'warn', detail: 'not fitted on this database yet (every league uses the shared settings)', items: [] };
  const days = Math.floor((now - Date.parse(at)) / 86400000);
  const own = rows.filter(r => r.used === 'own').map(r => r.league), group = rows.filter(r => r.used === 'group').map(r => r.league);
  const items = rows.map(r => `${r.league}: ${r.used}${typeof r.gain === 'number' ? ` (test gain ${r.gain})` : ''}`);
  const what = `own ${own.join(', ') || 'none'} · group ${group.join(', ') || 'none'} · shared ${rows.length - own.length - group.length}`;
  if (stale) return { id, label, level: 'warn', detail: `${stale} · fitted ${at.slice(0, 10)} · ${what}`, items };
  return { id, label, level: days > FRESH_DAYS ? 'warn' : 'ok', detail: `fitted ${at.slice(0, 10)} (${days} day(s) ago; refit monthly, ${FRESH_DAYS} allowed) · ${what}`, items };
}

function line(sport: Sport, now: number): Line {
  try {
    if (sport === 'basketball') {
      const l = storedLeagues();
      const stale = l && l.base !== baseKey(sharedParams()) ? `stale: fitted on other shared settings (${leagueTuneDue(now) || 'refit due'})` : null;
      return freshLine(sport, l?.at || null, (l?.report?.leagues || []).map((r: any) => ({ league: r.league, used: r.used, gain: r.test?.gain })), now, stale);
    }
    if (sport === 'nfl') {
      const s = afCalibReport()?.settings;
      return freshLine(sport, s?.at || null, (s?.leagues || []).map((r: any) => ({ league: r.league, used: r.used, gain: r.test?.gain })), now);
    }
    if (sport === 'tennis') {
      const c = tennisCalib();
      const r = db.prepare(`SELECT report FROM sport_calib WHERE sport = 'tennis'`).get() as any;
      const s = r?.report ? JSON.parse(r.report).settings : null;
      return freshLine(sport, c?.settings ? c.at : s?.at || null, (s?.leagues || []).map((x: any) => ({ league: x.league, used: x.used, gain: x.test?.gain })), now);
    }
    const rows = db.prepare(`SELECT division, updated_at FROM v3_league_conv ORDER BY division`).all() as any[];
    const at = rows.map(x => x.updated_at as string).filter(Boolean).sort().pop() || null;
    return freshLine(sport, at, rows.map(x => ({ league: x.division, used: 'own' })), now);
  } catch (e: any) {
    return { id: `league-settings-${sport}`, label: `League settings fresh (${NAME[sport]})`, level: 'warn', detail: `Check failed: ${e.message}`, items: [] };
  }
}

export function leagueSettingsHealth(now = Date.now()): Line[] {
  return (Object.keys(NAME) as Sport[]).map(s => line(s, now));
}

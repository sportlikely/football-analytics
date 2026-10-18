/**
 * Data health: is everything on the site current and consistent? Runs every 10 minutes (and on demand at
 * /api/data-health). Two kinds of checks:
 *
 *  1. Freshness — every background feed must have updated within its promised time:
 *       live scores 3 min (only while games are on) · fixtures 15 min · extra competitions 75 min · tables 60 min
 *       · results (settling) 30 min · odds 30 min · injuries / lineups 30 min · model 8 h
 *  2. Validity — the data itself:
 *       games still "live" or "not started" long after kick-off · finished games without a score
 *       · predictions past kick-off + 4 h that were never settled · upcoming games (48 h) without a prediction
 *       · probabilities that don't add up to 100% · the same game listed twice · league tables that don't add up
 *       (played = W+D+L, goal difference = GF−GA) · stored results whose outcome doesn't match the score
 *       · model history (results feed) missing games that were played
 *
 * A problem that stays for 3 runs in a row (30 minutes) is emailed to ADMIN_EMAILS, at most once every 6 hours.
 */
import { db } from '../db';
import logger from '../utils/logger';
import footballDataAPI from './footballDataAPI';
import { afUpcoming, afWithPredictions, afOverdue } from './afMatches';
import { afConfigured } from './apiFootball';
import { feedState, bootedAt } from './freshness';
import { emailEnabled, sendEmail, layout, section, esc, C, SITE } from './email';
import { lastDataAudit } from './dataAudit';
import { every, after, slicer, inBatches } from './perf';

type Level = 'ok' | 'warn' | 'fail';
export interface Check { id: string; label: string; level: Level; detail: string; items?: string[] }

const MIN = 60 * 1000;
const FEEDS: { id: string; label: string; maxAge: number; when?: () => boolean }[] = [
  { id: 'live', label: 'Live scores', maxAge: 3 * MIN },
  { id: 'fixtures', label: 'Fixtures and scores (main leagues)', maxAge: 15 * MIN },
  { id: 'extra-fixtures', label: 'Fixtures and scores (other competitions)', maxAge: 75 * MIN, when: afConfigured },
  { id: 'standings', label: 'League tables', maxAge: 60 * MIN },
  { id: 'results', label: 'Results and prediction settling', maxAge: 30 * MIN },
  { id: 'odds', label: 'Bookmaker odds', maxAge: 30 * MIN, when: () => !!process.env.ODDS_API_KEY },
  { id: 'injuries-lineups', label: 'Injuries, lineups and match stats', maxAge: 30 * MIN, when: afConfigured },
  { id: 'model', label: 'Model ratings', maxAge: 8 * 60 * MIN }
];
const LIVE = ['IN_PLAY', 'PAUSED'];
const FINAL = ['FINISHED', 'AWARDED', 'CANCELLED', 'POSTPONED', 'SUSPENDED'];
const ago = (ms: number) => (ms < 90 * 1000 ? `${Math.round(ms / 1000)} s` : ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : `${(ms / 3600000).toFixed(1)} h`);
const gameName = (m: any) => `${m.homeTeam?.name ?? m.home_team ?? '?'} – ${m.awayTeam?.name ?? m.away_team ?? '?'} (${m.competition?.name ?? m.competition_name ?? ''}, ${String(m.utcDate ?? m.utc_date ?? '').slice(0, 16).replace('T', ' ')} UTC)`;

async function allMatches(): Promise<any[]> {
  // fix169: predictions in batches of 25 with yields (the hourly check blocked 0.5–0.9 s)
  const fd = await inBatches(await footballDataAPI.getUpcomingMatches(30), 25, b => footballDataAPI.withPredictions(b));
  return [...fd, ...(await inBatches(afUpcoming(30), 25, b => afWithPredictions(b)))];
}

export async function dataHealth(): Promise<{ level: Level; at: string; checks: Check[] }> {
  const now = Date.now();
  const checks: Check[] = [];
  const slice = slicer(); // fix169: a yield between checks once ~30 ms have passed
  const starting = now - bootedAt() < 10 * MIN;
  let matches: any[] = [];
  try { matches = await allMatches(); } catch (e: any) { checks.push({ id: 'matches', label: 'Match list', level: 'fail', detail: `Could not load: ${e.message}` }); }
  const liveNow = matches.some(m => LIVE.includes(m.status));

  await slice();
  // ---------- 1. freshness ----------
  for (const f of FEEDS) {
    if (f.when && !f.when()) continue;
    if (f.id === 'live' && !liveNow) { checks.push({ id: `feed:${f.id}`, label: f.label, level: 'ok', detail: 'No games on right now' }); continue; }
    const st = feedState(f.id);
    if (!st || st.at === null) {
      checks.push({ id: `feed:${f.id}`, label: f.label, level: starting ? 'ok' : 'fail', detail: starting ? 'Starting up' : `No successful update since the server started ${ago(now - bootedAt())} ago${st?.lastError ? ` (last error: ${st.lastError})` : ''}` });
      continue;
    }
    const age = now - st.at;
    const level: Level = age <= f.maxAge ? 'ok' : age <= 2 * f.maxAge ? 'warn' : 'fail';
    checks.push({
      id: `feed:${f.id}`, label: f.label, level,
      detail: `Updated ${ago(age)} ago (every ${ago(f.maxAge)} at most)${st.note ? ` · ${st.note}` : ''}${st.failures ? ` · ${st.failures} failed attempt(s) since, last: ${st.lastError}` : ''}`
    });
  }

  await slice();
  // ---------- 2. validity ----------
  // games stuck as live, or never started, long after kick-off
  const stuck = matches.filter(m => {
    const t = new Date(m.utcDate).getTime();
    if (FINAL.includes(m.status)) return false;
    if (LIVE.includes(m.status)) return t < now - 3 * 3600 * 1000;
    return t < now - 150 * MIN && t > now - 3 * 86400000;
  });
  await slice();
  checks.push({
    id: 'stuck', label: 'Games with an up-to-date status', level: stuck.length ? 'warn' : 'ok',
    detail: stuck.length ? `${stuck.length} game(s) still shown as live or not started long after kick-off (re-checked automatically)` : 'Every game past kick-off has a live or final status',
    items: stuck.slice(0, 15).map(m => `${gameName(m)} · ${m.status}${m.minute ? ` ${m.minute}'` : ''}`)
  });
  const overdueAf = afOverdue();
  if (overdueAf.length) {
    const c = checks[checks.length - 1];
    c.items = [...(c.items || []), ...overdueAf.filter(o => !stuck.some(s => s.id === o.id)).slice(0, 10).map(o => `${o.home} – ${o.away} (${o.competition}) · ${o.status}`)];
  }

  // finished without a score
  const noScore = matches.filter(m => m.status === 'FINISHED' && (m.score?.fullTime?.home === null || m.score?.fullTime?.home === undefined));
  await slice();
  checks.push({ id: 'no-score', label: 'Finished games have a score', level: noScore.length ? 'fail' : 'ok', detail: noScore.length ? `${noScore.length} finished game(s) without a score` : 'All finished games have a score', items: noScore.slice(0, 15).map(gameName) });

  // the same game twice (main feed + other-competitions feed)
  const seen = new Map<string, any>();
  const dup: string[] = [];
  for (const m of matches) {
    const k = `${String(m.utcDate).slice(0, 10)}|${String(m.homeTeam?.name).toLowerCase()}|${String(m.awayTeam?.name).toLowerCase()}`;
    if (seen.has(k)) dup.push(gameName(m)); else seen.set(k, m);
  }
  await slice();
  checks.push({ id: 'duplicates', label: 'No game listed twice', level: dup.length ? 'warn' : 'ok', detail: dup.length ? `${dup.length} game(s) listed twice` : 'No duplicates', items: dup.slice(0, 15) });

  // predictions: upcoming 48 h covered, probabilities valid
  const soon = matches.filter(m => !FINAL.includes(m.status) && !LIVE.includes(m.status) && new Date(m.utcDate).getTime() > now && new Date(m.utcDate).getTime() < now + 48 * 3600 * 1000);
  const noPred = soon.filter(m => !m.prediction);
  await slice();
  checks.push({
    id: 'missing-predictions', label: 'Upcoming games have a prediction', level: noPred.length > Math.max(3, soon.length * 0.1) ? 'warn' : 'ok',
    detail: `${soon.length - noPred.length} of ${soon.length} games in the next 48 h have a prediction`,
    items: noPred.slice(0, 15).map(gameName)
  });
  const badProb = matches.filter(m => {
    const p = m.prediction;
    if (!p || p.locked) return false;
    const vals = [p.home, p.draw, p.away];
    if (vals.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) return true;
    const sum = vals.reduce((a: number, b: number) => a + b, 0);
    return Math.abs(sum - 100) > 1.5;
  });
  await slice();
  checks.push({ id: 'probabilities', label: 'Probabilities add up to 100%', level: badProb.length ? 'fail' : 'ok', detail: badProb.length ? `${badProb.length} prediction(s) with invalid percentages` : 'All predictions add up', items: badProb.slice(0, 15).map(m => `${gameName(m)} · ${m.prediction.home}/${m.prediction.draw}/${m.prediction.away}`) });

  // predictions never settled
  try {
    const cutoff = new Date(now - 4 * 3600 * 1000).toISOString();
    const rows = db.prepare(`SELECT match_id, home_team, away_team, competition_name, utc_date FROM predictions WHERE settled = 0 AND utc_date < ? GROUP BY match_id ORDER BY utc_date`).all(cutoff) as any[];
    const old = rows.filter(r => new Date(r.utc_date).getTime() < now - 24 * 3600 * 1000);
    checks.push({
      id: 'unsettled', label: 'Finished games are scored in our record', level: old.length ? 'fail' : rows.length ? 'warn' : 'ok',
      detail: rows.length ? `${rows.length} game(s) past kick-off + 4 h not settled yet (${old.length} older than a day)` : 'Every finished game is settled',
      items: rows.slice(0, 15).map(gameName)
    });
  } catch (e: any) {
    checks.push({ id: 'unsettled', label: 'Finished games are scored in our record', level: 'warn', detail: `Check failed: ${e.message}` });
  }

  // stored results: outcome matches the score
  try {
    const bad = db.prepare(`SELECT match_id, home_goals, away_goals, outcome FROM results WHERE outcome IN ('H','D','A') AND home_goals IS NOT NULL AND away_goals IS NOT NULL AND outcome != CASE WHEN home_goals > away_goals THEN 'H' WHEN home_goals < away_goals THEN 'A' ELSE 'D' END`).all() as any[];
    checks.push({ id: 'results', label: 'Stored results match the score', level: bad.length ? 'fail' : 'ok', detail: bad.length ? `${bad.length} stored result(s) where the outcome doesn't match the score` : 'All stored results are consistent', items: bad.slice(0, 15).map(r => `match ${r.match_id}: ${r.home_goals}–${r.away_goals} stored as ${r.outcome}`) });
  } catch { /* table missing */ }

  // league tables add up
  const tableIssues: string[] = [];
  for (const [code, st] of footballDataAPI.standings) {
    const total = (st as any)?.standings?.find((s: any) => s.type === 'TOTAL') || (st as any)?.standings?.[0];
    for (const r of total?.table || []) {
      const name = `${code} ${r.team?.shortName || r.team?.name}`;
      if (r.playedGames !== r.won + r.draw + r.lost) tableIssues.push(`${name}: played ${r.playedGames} ≠ ${r.won}+${r.draw}+${r.lost}`);
      if (r.goalDifference !== r.goalsFor - r.goalsAgainst) tableIssues.push(`${name}: goal difference ${r.goalDifference} ≠ ${r.goalsFor}−${r.goalsAgainst}`);
      if (r.points > 3 * r.won + r.draw) tableIssues.push(`${name}: ${r.points} points is more than 3×${r.won}+${r.draw}`);
    }
  }
  await slice();
  checks.push({ id: 'tables', label: 'League tables add up', level: tableIssues.length ? 'fail' : 'ok', detail: tableIssues.length ? `${tableIssues.length} table row(s) don't add up` : `${footballDataAPI.standings.size} tables checked`, items: tableIssues.slice(0, 15) });

  // model history (results used for ratings) not falling behind: a division is behind only when games were
  // actually played after its last stored result (international breaks are not a problem)
  try {
    const rows = db.prepare(`SELECT division, MAX(date) AS last FROM history_matches GROUP BY division`).all() as any[];
    const behind: string[] = [];
    for (const r of rows) {
      if (!r.last) continue;
      // games finished more than 3 days after the last stored result (the results files update a few times a week)
      const after = new Date(new Date(r.last).getTime() + 3 * 86400000).toISOString().slice(0, 10);
      let missed = 0;
      try {
        missed = (db.prepare(`SELECT COUNT(*) AS n FROM af_fixtures WHERE division = ? AND status IN ('FT','AET','PEN') AND date > ? AND kickoff < ?`)
          .get(r.division, after, new Date(now - 86400000).toISOString()) as any).n;
      } catch { /* no fixture store */ }
      if (missed > 0) behind.push(`${r.division}: last result ${r.last}, ${missed} game(s) played since are not in yet`);
    }
    checks.push({
      id: 'history', label: 'Results used by the model are current', level: behind.length ? 'warn' : 'ok',
      detail: behind.length ? `${behind.length} division(s) missing recent results` : `${rows.length} divisions up to date (no games missed; breaks are fine)`,
      items: behind
    });
  } catch { /* table missing */ }

  // daily player check: top scorers of 13 leagues, their pages vs the official lists + sanity checks
  try {
    const a = lastDataAudit();
    if (a) {
      const age = now - new Date(a.at).getTime();
      const mism = (a.issues || []).filter((i: any) => i.kind === 'mismatch' || i.kind === 'not-found').length;
      checks.push({
        id: 'players', label: 'Player pages match the official stats',
        level: age > 48 * 3600 * 1000 ? 'warn' : a.checked && mism > a.checked * 0.15 ? 'warn' : 'ok',
        detail: `${a.matched} of ${a.checked} top scorers match (${a.leagues}) · checked ${ago(age)} ago · ${(a.issues || []).length} note(s)`,
        items: (a.issues || []).slice(0, 25).map((i: any) => `${i.league || ''} ${i.player || ''}: ${i.detail}`)
      });
    }
  } catch { /* no report yet */ }

  const level: Level = checks.some(c => c.level === 'fail') ? 'fail' : checks.some(c => c.level === 'warn') ? 'warn' : 'ok';
  return { level, at: new Date(now).toISOString(), checks };
}

/* ---------------- scheduler + email ---------------- */

let last: Awaited<ReturnType<typeof dataHealth>> | null = null;
const failStreak = new Map<string, number>();
let lastEmailAt = 0;

export const lastDataHealth = () => last;

/** Alert email: what has been failing for 30+ minutes, then what still works. */
export function healthEmail(failing: Check[], all: Check[]) {
  const when = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const okCount = all.filter(c => c.level === 'ok').length;
  let body = `<tr><td style="padding:18px 28px 4px">
    <div style="font-size:13px;color:${C.muted};font-weight:600">Data alert</div>
    <div style="font-size:22px;line-height:1.25;font-weight:800;color:${C.red};margin-top:6px">${failing.length === 1 ? esc(failing[0].label) + ' has a problem' : `${failing.length} data feeds have a problem`}</div>
    <div style="font-size:14px;color:${C.muted};margin-top:6px">Failing for 30 minutes or more. ${okCount} of ${all.length} checks are still fine.</div>
  </td></tr>`;
  body += section('What’s wrong');
  body += `<tr><td style="padding:0 28px">${failing
    .map(c => `<div style="border:1px solid ${C.line};border-left:4px solid ${C.red};border-radius:10px;padding:10px 12px;margin:8px 0">
      <div style="font-size:14px;font-weight:700">${esc(c.label)}</div>
      <div style="font-size:13px;color:${C.muted};margin-top:3px">${esc(c.detail)}</div>
      ${c.items?.length ? `<div style="font-size:12px;color:${C.muted};margin-top:6px">${c.items.slice(0, 6).map(i => '· ' + esc(i)).join('<br>')}${c.items.length > 6 ? `<br><span style="color:${C.faint}">+${c.items.length - 6} more</span>` : ''}</div>` : ''}
    </div>`)
    .join('')}</td></tr>`;
  const others = all.filter(c => !failing.includes(c));
  if (others.length) {
    body += section('Everything else');
    body += `<tr><td style="padding:0 28px;font-size:13px;line-height:1.9">${others
      .map(c => `<span style="color:${c.level === 'ok' ? C.green : c.level === 'warn' ? C.amber : C.red}">●</span>&nbsp; ${esc(c.label)}`)
      .join('<br>')}</td></tr>`;
  }
  body += `<tr><td style="height:12px"></td></tr>`;
  const subject = `Data alert: ${failing.map(c => c.label).slice(0, 2).join(', ')}${failing.length > 2 ? ` +${failing.length - 2}` : ''}`;
  const html = layout({
    preheader: `${failing.map(c => c.label).join(', ')}: failing for 30+ minutes.`,
    label: when,
    body,
    cta: { text: 'Open Data health', href: `${SITE}/admin` },
    footer: 'You get at most one alert every 6 hours. It stops by itself once the feed recovers.'
  });
  const text = [
    `SportLikely · data alert · ${when}`,
    'Failing for 30+ minutes:',
    ...failing.map(c => `- ${c.label}: ${c.detail}${c.items?.length ? '\n    ' + c.items.slice(0, 6).join('\n    ') : ''}`),
    '',
    `Data health: ${SITE}/admin`
  ].join('\n');
  return { subject, html, text };
}

async function run() {
  try {
    last = await dataHealth();
    const failing = last.checks.filter(c => c.level === 'fail');
    for (const c of last.checks) failStreak.set(c.id, c.level === 'fail' ? (failStreak.get(c.id) || 0) + 1 : 0);
    const persistent = failing.filter(c => (failStreak.get(c.id) || 0) >= 3);
    if (failing.length) logger.warn(`Data health: ${failing.map(c => c.label).join(', ')}`);
    const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (persistent.length && emailEnabled && to.length && Date.now() - lastEmailAt > 6 * 3600 * 1000) {
      lastEmailAt = Date.now();
      const { subject, html, text } = healthEmail(persistent, last.checks);
      for (const addr of to) await sendEmail(addr, subject, html, text).catch(() => undefined);
    }
  } catch (e: any) {
    logger.warn(`Data health run failed: ${e.message}`);
  }
}

export function startDataHealthScheduler() {
  after('data health', run, 5 * MIN);
  every('data health', run, 10 * MIN);
}

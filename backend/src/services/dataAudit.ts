/**
 * Weekly data check: are the numbers we show right?
 *
 * For the top scorers of our main leagues (Football-Data.org's official scorer lists) it opens each player's page
 * (API-Football) and compares his league goals and appearances, then runs sanity checks on every page it opened:
 * season totals equal the sum of their rows, ratings between 3 and 10, goals not above 4 per appearance, age 15–45,
 * the header club is not a national team, and an "out" status has a start date. A player the lookup cannot find is
 * reported too.
 *
 * Runs once a week (Monday morning UTC) and on demand; the report is stored and emailed to ADMIN_EMAILS when email
 * is set up. About 80 players; the first run of a week costs a few hundred API-Football calls, later ones are cached.
 *
 * fix254: no "Needs you" email asking Yarin to compare players — the differences go to the "For Claude" list (Admin →
 * Needs you, `auditForClaude`); an email goes only when a league stays under 90% for 7 days (utils/auditStreak.ts), at
 * most once a week per league.
 */
import { db } from '../db';
import { pubPath } from './slugs';
import logger from '../utils/logger';
import footballDataAPI from './footballDataAPI';
import { findPlayer, playerPage, FD_TO_AF } from './playerPage';
import { afRemaining } from './apiFootball';
import { getAfScorers } from './afMatches';
import { emailEnabled, sendEmail } from './email';
import { renderAdminMail, adminUrl, israelTime, type AdminMail } from './adminMail';
import { every, after } from './perf';
import { leaguesUnderFor, dueForEmail, isKnownGap, goalGap, STREAK_DAYS, STREAK_SHARE, KNOWN_CHECKS, type AuditRun, type PastIssue } from '../utils/auditStreak';

db.exec(`CREATE TABLE IF NOT EXISTS data_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL)`);
// fix254: when each league was last emailed for staying under 90%
db.exec(`CREATE TABLE IF NOT EXISTS data_audit_mail (league TEXT PRIMARY KEY, sent_at TEXT NOT NULL)`);

const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'ELC'];
// other leagues from API-Football (their scorer lists carry API-Football player ids: no name matching needed)
const AF_LEAGUES = ['AF144', 'AF203', 'AF179', 'AF197', 'AF383'];
const PER_LEAGUE = parseInt(process.env.DATA_CHECK_PER_LEAGUE || '20', 10);

/**
 * fix240: every note says why (the 26 Oct check had 195 of 260 matching and 78 notes without a reason):
 *  - 'mismatch' / 'not-found' count against the league; `reason` = the cause found (two clubs in the league, two
 *    provider records of one player, another competition filed under the league …)
 *  - 'lag': his club played in the last 30 h and his page was rebuilt after the game, but the provider has not
 *    updated the season numbers yet — checked again on the next run, not counted against the league
 *  - 'known' (fix275): his page has more goals than the official list by the same gap on 3+ checks in a row ("Provider
 *    and league disagree (known)") — shown grey, not counted against the league
 *  - 'sanity': provider quirks on the rest of the page (and, for Football-Data leagues, assists: the two providers
 *    credit assists by different rules), shown, nothing to do
 */
export interface AuditIssue { kind: 'mismatch' | 'not-found' | 'sanity' | 'error' | 'lag' | 'known'; league?: string; player?: string; playerId?: number; detail: string; reason?: string }

/** A league's share of matching top scorers must reach this (lag cases left out). */
export const AUDIT_TARGET = 0.95;
const LAG_MS = 30 * 3600 * 1000;
const AF_OFFSET = 1_000_000_000;

let running = false;

/** The finished games of a club (API-Football team id without the offset) since `since` (ISO), newest first. */
function clubGamesSince(teamAf: number, since: string): string[] {
  try {
    return (db.prepare(`SELECT kickoff FROM af_fixtures WHERE (home_id = ? OR away_id = ?) AND status IN ('FT','AET','PEN') AND kickoff >= ? AND kickoff <= ? ORDER BY kickoff DESC`)
      .all(teamAf, teamAf, since, new Date().toISOString()) as any[]).map(r => r.kickoff);
  } catch { return []; }
}

type Verdict = 'ok' | 'lag' | 'known' | 'bad';

/** fix275: the earlier runs (newest first), for the known-difference rule */
let pastRuns: { leagues: string[]; issues: PastIssue[] }[] = [];
function loadPastRuns(n = 6) {
  try {
    return (db.prepare(`SELECT json FROM data_audit ORDER BY id DESC LIMIT ?`).all(n) as any[]).map(r => {
      const j = JSON.parse(r.json);
      return { leagues: Object.keys(j.byLeague || {}), issues: (j.issues || []).filter((i: any) => i.kind === 'mismatch' || i.kind === 'known') };
    });
  } catch { return []; }
}

export async function runDataAudit(notify = true) {
  if (running) throw new Error('A data check is already running');
  if (afRemaining() < 3000) throw new Error('Not enough API-Football budget left today');
  running = true;
  const t0 = Date.now();
  const issues: AuditIssue[] = [];
  let checked = 0, matched = 0, lag = 0, known = 0;
  const byLeague: Record<string, { checked: number; matched: number; lag: number; known: number }> = {};
  const tally = (code: string, r: Verdict) => {
    const t = (byLeague[code] ||= { checked: 0, matched: 0, lag: 0, known: 0 });
    t.checked++;
    if (r === 'ok') t.matched++; else if (r === 'lag') t.lag++; else if (r === 'known') t.known++;
    if (r === 'known') known++;
  };
  pastRuns = loadPastRuns();
  try {
    for (const code of LEAGUES) {
      let list: any = null;
      try {
        list = await footballDataAPI.getScorers(code, 20);
      } catch (e: any) {
        issues.push({ kind: 'error', league: code, detail: `The official scorer list didn't load (${e.message})` });
        continue;
      }
      const scorers: any[] = list?.scorers || [];
      // the list's season (API-Football numbers a season by its start year)
      const season = parseInt(String(list?.season?.startDate || '').slice(0, 4), 10) || null;
      for (const s of scorers.slice(0, PER_LEAGUE)) {
        const name = s.player?.name;
        if (!name || !s.team?.id) continue;
        checked++;
        let id: number | null = null;
        try {
          id = await findPlayer(name, s.team.id, code, s.team.name);
        } catch { /* reported below */ }
        if (!id) {
          issues.push({ kind: 'not-found', league: code, player: name, detail: `We couldn't find his player page (${s.team.shortName || s.team.name})`, reason: 'no player of that name at his club or in the league at API-Football' });
          tally(code, 'bad');
          continue;
        }
        const r = await checkPlayer(id, code, name, s, FD_TO_AF[code], season, issues, false);
        if (r === 'ok') matched++; else if (r === 'lag') lag++;
        tally(code, r);
      }
    }
    for (const code of AF_LEAGUES) {
      if (afRemaining() < 1500) { issues.push({ kind: 'error', league: code, detail: 'Skipped today: daily data budget was low' }); continue; }
      let list: any = null;
      try {
        list = await getAfScorers(code, 30);
      } catch (e: any) {
        issues.push({ kind: 'error', league: code, detail: `The official scorer list didn't load (${e.message})` });
        continue;
      }
      for (const s of (list?.scorers || []).slice(0, PER_LEAGUE)) {
        const name = s.player?.name;
        if (!name || !s.player?.id) continue;
        checked++;
        const r = await checkPlayer(s.player.id, code, name, s, parseInt(code.slice(2), 10), list?.season ?? null, issues, true);
        if (r === 'ok') matched++; else if (r === 'lag') lag++;
        tally(code, r);
      }
    }
  } finally {
    running = false;
  }
  const report = { at: new Date().toISOString(), ms: Date.now() - t0, leagues: [...LEAGUES, ...AF_LEAGUES].join(', '), checked, matched, lag, known, target: AUDIT_TARGET, byLeague, issues };
  db.prepare(`INSERT INTO data_audit (at, json) VALUES (?, ?)`).run(report.at, JSON.stringify(report));
  logger.info(`Data check: ${matched}/${checked} matched, ${lag} still updating after a game, ${issues.filter(i => i.kind === 'mismatch' || i.kind === 'not-found').length} to look at`
    + ` · ${Object.entries(byLeague).map(([c, t]) => `${c} ${t.matched}/${t.checked - t.lag - t.known}`).join(' ')}`);
  for (const i of issues) if (i.kind === 'mismatch' || i.kind === 'not-found') logger.info(`data check ${i.league} ${i.player}: ${i.detail} — ${i.reason || '?'}`);
  if (notify) await emailReport(report).catch(e => logger.warn(`data check email: ${e.message}`));
  return report;
}

/** A league's share of matching players, lag cases left out (null = nothing checked). */
export function leagueShare(t: { checked: number; matched: number; lag?: number; known?: number }): number | null {
  const n = t.checked - (t.lag || 0) - (t.known || 0); // fix275: known differences left out too
  return n > 0 ? t.matched / n : null;
}

/**
 * Why his page and the official list differ (fix240). `rows` = his page's rows of this league in the list's season;
 * `allRows` = every row of his page in that season.
 */
export function mismatchReason(o: { official: number; page: number; rows: any[]; allRows: any[]; otherSeasonRows: number; afList: boolean; officialClubs?: number }): string {
  const { official, page, rows } = o;
  if (!rows.length) {
    if (o.otherSeasonRows) return 'his league games are filed under another season on his page (season dates at the provider)';
    return 'the provider has no league numbers for this player id this season (a second id of the same player, or not updated yet)';
  }
  if (rows.some(r => r.twinIds > 1)) return 'two provider records of the same player are added up on his page';
  const clubs = new Set(rows.map(r => r.team?.id)).size;
  if (clubs > 1 && (!o.afList || (o.officialClubs ?? 1) < clubs)) return `he played for ${clubs} clubs in this league this season: his page adds both, the official list ${o.afList ? 'counted one' : 'may count one'}`;
  if (page > official) {
    const other = o.allRows.filter(r => r.league?.id !== rows[0]?.league?.id).reduce((t, r) => t + (r.goals || 0), 0);
    if (other && page - official <= other) return 'goals of another competition are filed under the league at the provider';
    return 'his page has more than the official list (the provider counts a goal the league gave to someone else, or an own goal)';
  }
  return 'the official list has more than his page (the provider has not filed a game of his yet)';
}

/** One player: his page against the official scorer list (goals, appearances, assists) + sanity checks. */
async function checkPlayer(id: number, code: string, name: string, s: any, leagueId: number, season: number | null, issues: AuditIssue[], afList: boolean): Promise<Verdict> {
  let p: any;
  try {
    p = await playerPage(id, true, true);
    // fix240: a copy built before his club's latest game (+ 2 h for the provider) is rebuilt — the page lives 3–24 h,
    // the official list does not wait
    const teamAf = p.team?.id ? p.team.id - AF_OFFSET : null;
    const last = teamAf ? clubGamesSince(teamAf, new Date(Date.now() - 7 * 86400000).toISOString())[0] : null;
    if (last && p.builtAt && Date.parse(p.builtAt) < Date.parse(last) + 2 * 3600 * 1000) p = await playerPage(id, true, true, Date.now());
  } catch (e: any) {
    issues.push({ kind: 'error', league: code, player: name, detail: `His page didn't load (${e.message})` });
    return 'bad';
  }
  const push = (i: AuditIssue) => issues.push({ ...i, playerId: p.player?.id ?? id });
  // fix240: the rows of the list's own season (the provider's season number), wherever his page files them —
  // seasons[0] is his newest page season, not always the league's
  const pageRows = (p.seasons || []).flatMap((se: any) => se.rows || []);
  const cur = season ? pageRows.filter((r: any) => r.afSeason === season) : (p.seasons?.[0]?.rows || []);
  const rows = cur.filter((r: any) => r.league?.id === leagueId);
  const otherSeasonRows = season ? pageRows.filter((r: any) => r.league?.id === leagueId && r.afSeason !== season).length : 0;
  const goals = rows.reduce((a: number, r: any) => a + (r.goals || 0), 0);
  const apps = rows.reduce((a: number, r: any) => a + (r.apps || 0), 0);
  const assists = rows.reduce((a: number, r: any) => a + (r.assists || 0), 0);
  const official = s.goals ?? 0;
  let verdict: Verdict = 'ok';
  const teamAf = p.team?.id ? p.team.id - AF_OFFSET : null;
  const recent = teamAf ? clubGamesSince(teamAf, new Date(Date.now() - LAG_MS).toISOString()) : [];
  const fail = (detail: string, reason: string) => {
    // his club played in the last 30 h and the difference is at most those games' worth: the provider is still updating
    if (recent.length && rows.length && Math.abs(goals - official) <= 3 * recent.length && (s.playedMatches == null || Math.abs(apps - s.playedMatches) <= recent.length + 1)) {
      push({ kind: 'lag', league: code, player: name, detail, reason: `his club played on ${recent[recent.length - 1].slice(0, 10)}; the provider has not updated his season yet — checked again on the next run` });
      verdict = 'lag';
    } else if (rows.length && isKnownGap(pastRuns, code, { name, id: p.player?.id ?? id }, goalGap(detail) ?? 0)) {
      // fix275: the same "page ahead" gap on 3+ checks: the provider and the league disagree for good — not a fault
      push({ kind: 'known', league: code, player: name, detail, reason: `Provider and league disagree (known): the same difference on ${KNOWN_CHECKS}+ checks — ${reason}` });
      verdict = 'known';
    } else {
      push({ kind: 'mismatch', league: code, player: name, detail, reason });
      verdict = 'bad';
    }
  };
  const why = (page: number) => mismatchReason({ official, page, rows, allRows: cur, otherSeasonRows, afList, officialClubs: s.clubs });
  if (!rows.length) fail(`His page has no league row this season (official list: ${official} goals)`, why(0));
  else if (goals !== official) fail(`Goals: official list ${official}, his page ${goals}`, why(goals));
  else if (s.playedMatches != null && Math.abs(apps - s.playedMatches) > 1) fail(`Appearances: official list ${s.playedMatches}, his page ${apps}`, apps > s.playedMatches ? 'his page counts more games (a substitute appearance the official list leaves out, or two clubs)' : 'the official list counts more games (the provider has not filed one of his games yet)');
  else if (s.assists != null && Math.abs(assists - s.assists) > 1) {
    // fix240: Football-Data.org and API-Football credit assists by their own rules — a difference between the two is
    // not a page error (a note); against API-Football's own list it is
    if (afList) fail(`Assists: official list ${s.assists}, his page ${assists}`, 'the provider’s scorer list and his page disagree (one of them is an older copy)');
    else push({ kind: 'sanity', league: code, player: name, detail: `Assists: official list ${s.assists}, his page ${assists}`, reason: 'the two data providers credit assists by different rules' });
  }

  // sanity checks on the whole page (provider quirks: shown in the email, no action needed unless they repeat)
  const nowSeason = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
  let careerApps = 0, careerGoals = 0;
  for (const se of p.seasons || []) {
    const sum = (se.rows || []).reduce((a: number, r: any) => a + (r.goals || 0), 0);
    careerApps += se.totals?.apps || 0; careerGoals += se.totals?.goals || 0;
    if (sum !== se.totals?.goals) push({ kind: 'sanity', league: code, player: name, detail: `${se.label}: season total ${se.totals?.goals} goals, rows add up to ${sum}` });
    if (se.season > nowSeason) push({ kind: 'sanity', league: code, player: name, detail: `${se.label}: a season that hasn't started yet` });
    const leagues = new Set<string>();
    for (const r of se.rows || []) {
      if (r.rating != null && (r.rating < 3 || r.rating > 10)) push({ kind: 'sanity', league: code, player: name, detail: `${se.label} ${r.league?.name}: rating ${r.rating}` });
      // 5 in a game happens (Mbappé, Coupe de France 2023); more than that per game is a data error
      if (r.apps > 0 && r.goals > r.apps * 5) push({ kind: 'sanity', league: code, player: name, detail: `${se.label} ${r.league?.name}: ${r.goals} goals in ${r.apps} game${r.apps === 1 ? '' : 's'}` });
      // extra time + stoppage can reach ~130 a game; the provider sometimes counts a game it lists once twice
      if (r.minutes > r.apps * 130) push({ kind: 'sanity', league: code, player: name, detail: `${se.label} ${r.league?.name}: ${r.minutes} minutes in ${r.apps} game${r.apps === 1 ? '' : 's'} (provider counts a game it doesn't list)` });
      const k = `${r.league?.id}|${r.team?.id}|${r.league?.name}`;
      if (leagues.has(k)) push({ kind: 'sanity', league: code, player: name, detail: `${se.label}: ${r.league?.name} shown twice` });
      leagues.add(k);
    }
  }
  if (p.career && (p.career.apps !== careerApps || p.career.goals !== careerGoals)) push({ kind: 'sanity', league: code, player: name, detail: `Career total ${p.career.goals} goals / ${p.career.apps} games, seasons add up to ${careerGoals} / ${careerApps}` });
  if (p.careerPartial) push({ kind: 'sanity', league: code, player: name, detail: 'Older seasons still loading' });
  const age = p.player?.age;
  if (age != null && (age < 15 || age > 45)) push({ kind: 'sanity', league: code, player: name, detail: `Age shows as ${age}` });
  if (p.team && p.player?.nationality && p.team.name === p.player.nationality) push({ kind: 'sanity', league: code, player: name, detail: `Header shows the national team (${p.team.name}) instead of his club` });
  if (p.status?.out && !p.status.since) push({ kind: 'sanity', league: code, player: name, detail: 'Marked injured with no start date' });
  return verdict;
}

export function lastDataAudit() {
  const r: any = db.prepare(`SELECT json FROM data_audit ORDER BY id DESC LIMIT 1`).get();
  return r ? JSON.parse(r.json) : null;
}

const LEAGUE_NAME: Record<string, string> = {
  PL: 'Premier League', PD: 'La Liga', SA: 'Serie A', BL1: 'Bundesliga', FL1: 'Ligue 1', DED: 'Eredivisie', PPL: 'Primeira Liga',
  ELC: 'Championship', AF144: 'Belgium', AF203: 'Turkey', AF179: 'Scotland', AF197: 'Greece', AF383: 'Israel'
};
const leagueName = (c?: string) => (c ? LEAGUE_NAME[c] || c : '');

/** fix254: the runs of the last `days` + 7 days (league numbers only) */
export function recentAuditRuns(days = STREAK_DAYS + 7): AuditRun[] {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return (db.prepare(`SELECT at, json FROM data_audit WHERE at >= ? ORDER BY id`).all(since) as any[])
    .map(r => { try { const j = JSON.parse(r.json); return { at: r.at, byLeague: j.byLeague || {} }; } catch { return null; } })
    .filter(Boolean) as AuditRun[];
}

/** fix254: the "For Claude" part of the check: the latest run's differences, and the leagues under 90% for 7+ days */
export function auditForClaude(report: any = lastDataAudit(), runs: AuditRun[] = recentAuditRuns(), now = Date.now()) {
  if (!report) return null;
  // fix275: the known provider / league differences after the real ones, flagged (shown grey, not counted)
  const all: AuditIssue[] = report.issues || [];
  const issues: AuditIssue[] = [...all.filter(i => i.kind === 'mismatch' || i.kind === 'not-found'), ...all.filter(i => i.kind === 'known')];
  return {
    at: report.at as string, checked: report.checked as number, matched: report.matched as number, known: (report.known as number) || 0,
    differences: issues.slice(0, 40).map(i => ({ league: leagueName(i.league), player: i.player || null, detail: i.detail, reason: i.reason || null, known: i.kind === 'known' })),
    more: Math.max(0, issues.length - 40),
    under: leaguesUnderFor(runs, now).map(u => ({ ...u, name: leagueName(u.league) }))
  };
}

/** The email (fix239's admin template), fix254: only for leagues under 90% for 7 days — the differences are on the For Claude list. */
export function auditEmail(report: any, under: { league: string; since: string; share: number }[]) {
  const by = report.byLeague || {};
  const leagues = Object.keys(by).map(c => `${leagueName(c)} ${by[c].matched}/${by[c].checked - (by[c].lag || 0) - (by[c].known || 0)}`).join(' · ');
  const n = under.length;
  const mail: AdminMail = {
    label: 'Data check', tone: 'warn',
    title: `${n} league${n === 1 ? '' : 's'} under ${Math.round(STREAK_SHARE * 100)}% for ${STREAK_DAYS} days`,
    what: `In the daily top-scorer check, ${under.map(u => `${leagueName(u.league)} (${u.share}% now, under since ${israelTime(u.since)})`).join(', ')} stayed under ${Math.round(STREAK_SHARE * 100)}% of players matching the official lists for ${STREAK_DAYS} days in a row.`,
    todo: 'Nothing to compare by hand: the differences are on the “For Claude” list (Admin → Needs you). Open a session with Claude and paste that list.',
    rows: [
      ...under.map(u => ({ title: leagueName(u.league), detail: `${u.share}% matching, under ${Math.round(STREAK_SHARE * 100)}% since ${israelTime(u.since)}`, tone: 'warn' as const })),
      ...(leagues ? [{ title: 'League by league (today)', detail: leagues }] : [])
    ],
    buttons: [{ text: 'Open the For Claude list', href: adminUrl('needs-you') }],
    footer: 'Sent at most once a week per league; one-day differences between the two data providers are not emailed.'
  };
  const subject = `Data check: ${under.map(u => leagueName(u.league)).join(', ')} under ${Math.round(STREAK_SHARE * 100)}% for ${STREAK_DAYS} days`;
  return { subject, ...renderAdminMail(mail) };
}

// fix254: an email only when a league stays under 90% for 7 days (at most once a week per league)
async function emailReport(report: any) {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!emailEnabled || !to.length) return;
  const sent = Object.fromEntries((db.prepare(`SELECT league, sent_at FROM data_audit_mail`).all() as any[]).map(r => [r.league, r.sent_at]));
  const due = dueForEmail(leaguesUnderFor(recentAuditRuns()), sent);
  if (!due.length) return;
  const { subject, html, text } = auditEmail(report, due);
  for (const addr of to) await sendEmail(addr, subject, html, text);
  const at = new Date().toISOString();
  for (const u of due) db.prepare(`INSERT OR REPLACE INTO data_audit_mail (league, sent_at) VALUES (?, ?)`).run(u.league, at);
}

/** Every hour: run once a day, 04:00–10:59 UTC (morning, after the night's games are in), or now if none has run. */
export function startDataAuditScheduler() {
  const tick = () => {
    const last = lastDataAudit();
    const now = new Date();
    const due = !last || Date.now() - new Date(last.at).getTime() > 20 * 3600 * 1000;
    const window = now.getUTCHours() >= 4 && now.getUTCHours() < 11;
    if (due && (window || !last) && !running) runDataAudit().catch(e => logger.warn(`data check: ${e.message}`));
  };
  after('data audit', tick, 10 * 60 * 1000); // not right at start-up
  every('data audit', tick, 60 * 60 * 1000);
}

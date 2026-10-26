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
 */
import { db } from '../db';
import { pubPath } from './slugs';
import logger from '../utils/logger';
import footballDataAPI from './footballDataAPI';
import { findPlayer, playerPage, FD_TO_AF } from './playerPage';
import { afRemaining } from './apiFootball';
import { getAfScorers } from './afMatches';
import { emailEnabled, sendEmail } from './email';
import { renderAdminMail, adminUrl, israelTime, siteUrl, type AdminMail } from './adminMail';
import { every, after } from './perf';

db.exec(`CREATE TABLE IF NOT EXISTS data_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL)`);

const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'ELC'];
// other leagues from API-Football (their scorer lists carry API-Football player ids: no name matching needed)
const AF_LEAGUES = ['AF144', 'AF203', 'AF179', 'AF197', 'AF383'];
const PER_LEAGUE = parseInt(process.env.DATA_CHECK_PER_LEAGUE || '20', 10);

export interface AuditIssue { kind: 'mismatch' | 'not-found' | 'sanity' | 'error'; league?: string; player?: string; playerId?: number; detail: string }

let running = false;

export async function runDataAudit(notify = true) {
  if (running) throw new Error('A data check is already running');
  if (afRemaining() < 3000) throw new Error('Not enough API-Football budget left today');
  running = true;
  const t0 = Date.now();
  const issues: AuditIssue[] = [];
  let checked = 0, matched = 0;
  const byLeague: Record<string, { checked: number; matched: number }> = {};
  const tally = (code: string, ok: number) => {
    const t = (byLeague[code] ||= { checked: 0, matched: 0 });
    t.checked++; t.matched += ok;
  };
  try {
    for (const code of LEAGUES) {
      let scorers: any[] = [];
      try {
        scorers = ((await footballDataAPI.getScorers(code, 20)) as any)?.scorers || [];
      } catch (e: any) {
        issues.push({ kind: 'error', league: code, detail: `The official scorer list didn't load (${e.message})` });
        continue;
      }
      for (const s of scorers.slice(0, PER_LEAGUE)) {
        const name = s.player?.name;
        if (!name || !s.team?.id) continue;
        checked++;
        let id: number | null = null;
        try {
          id = await findPlayer(name, s.team.id, code, s.team.name);
        } catch { /* reported below */ }
        if (!id) {
          issues.push({ kind: 'not-found', league: code, player: name, detail: `We couldn't find his player page (${s.team.shortName || s.team.name})` });
          tally(code, 0);
          continue;
        }
        const ok = await checkPlayer(id, code, name, s, FD_TO_AF[code], issues);
        matched += ok; tally(code, ok);
      }
    }
    for (const code of AF_LEAGUES) {
      if (afRemaining() < 1500) { issues.push({ kind: 'error', league: code, detail: 'Skipped today: daily data budget was low' }); continue; }
      let scorers: any[] = [];
      try {
        scorers = ((await getAfScorers(code, 30)) as any)?.scorers || [];
      } catch (e: any) {
        issues.push({ kind: 'error', league: code, detail: `The official scorer list didn't load (${e.message})` });
        continue;
      }
      for (const s of scorers.slice(0, PER_LEAGUE)) {
        const name = s.player?.name;
        if (!name || !s.player?.id) continue;
        checked++;
        const ok = await checkPlayer(s.player.id, code, name, s, parseInt(code.slice(2), 10), issues);
        matched += ok; tally(code, ok);
      }
    }
  } finally {
    running = false;
  }
  const report = { at: new Date().toISOString(), ms: Date.now() - t0, leagues: [...LEAGUES, ...AF_LEAGUES].join(', '), checked, matched, byLeague, issues };
  db.prepare(`INSERT INTO data_audit (at, json) VALUES (?, ?)`).run(report.at, JSON.stringify(report));
  logger.info(`Data check: ${matched}/${checked} matched, ${issues.length} issues`);
  if (notify) await emailReport(report).catch(e => logger.warn(`data check email: ${e.message}`));
  return report;
}

/** One player: his page against the official scorer list (goals, appearances, assists) + sanity checks. 1 = matched. */
async function checkPlayer(id: number, code: string, name: string, s: any, leagueId: number, issues: AuditIssue[]): Promise<number> {
  let ok = 0;
  let p: any;
  try {
    p = await playerPage(id, true, true);
  } catch (e: any) {
    issues.push({ kind: 'error', league: code, player: name, detail: `His page didn't load (${e.message})` });
    return 0;
  }
  const push = (i: AuditIssue) => issues.push({ ...i, playerId: p.player?.id ?? id });
  const season = p.seasons?.[0];
  const rows = (season?.rows || []).filter((r: any) => r.league?.id === leagueId);
  const goals = rows.reduce((a: number, r: any) => a + (r.goals || 0), 0);
  const apps = rows.reduce((a: number, r: any) => a + (r.apps || 0), 0);
  const assists = rows.reduce((a: number, r: any) => a + (r.assists || 0), 0);
  if (!rows.length) push({ kind: 'mismatch', league: code, player: name, detail: `His page has no league row this season (official list: ${s.goals} goals)` });
  else if (goals !== (s.goals ?? 0)) push({ kind: 'mismatch', league: code, player: name, detail: `Goals: official list ${s.goals}, his page ${goals}` });
  else if (s.playedMatches != null && Math.abs(apps - s.playedMatches) > 1) push({ kind: 'mismatch', league: code, player: name, detail: `Appearances: official list ${s.playedMatches}, his page ${apps}` });
  else if (s.assists != null && Math.abs(assists - s.assists) > 1) push({ kind: 'mismatch', league: code, player: name, detail: `Assists: official list ${s.assists}, his page ${assists}` });
  else ok = 1;

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
  return ok;
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

/** The data-check email (fix239: the admin template). Sent only when something needs a look (emailReport). */
export function auditEmail(report: any) {
  const issues: AuditIssue[] = report.issues || [];
  const action = issues.filter(i => i.kind !== 'sanity');
  const quirks = issues.filter(i => i.kind === 'sanity');
  const pct = report.checked ? Math.round((report.matched / report.checked) * 1000) / 10 : 0;
  const by = report.byLeague || {};
  const leagues = Object.keys(by).map(c => `${leagueName(c)} ${by[c].matched}/${by[c].checked}`).join(' · ');
  const n = action.length;
  const mail: AdminMail = {
    label: 'Data check', tone: n ? 'warn' : 'ok',
    title: n ? `${n} top scorer${n === 1 ? '' : 's'} to look at` : 'Everything on the site matches',
    what: `${pct}% of the top scorers (${report.matched} of ${report.checked}) match the official lists in the morning check of ${israelTime(report.at)}.`,
    todo: n ? 'Open each player below and compare with the league’s own list; a difference that is still there after a week is worth telling Claude.' : null,
    rows: [
      ...action.map(i => ({ title: `${i.player || leagueName(i.league)} (${leagueName(i.league)})`, titleHref: i.playerId ? siteUrl(`/player/${i.playerId}`) : null, detail: i.detail, tone: 'warn' as const })),
      ...(leagues ? [{ title: 'League by league', detail: leagues }] : []),
      ...(quirks.length ? [{ title: `Provider quirks: ${quirks.length}, no action needed`, detail: quirks.slice(0, 6).map(q => `${q.player || ''}: ${q.detail}`).join(' · ') }] : [])
    ],
    buttons: [{ text: 'Open in Admin', href: adminUrl('data') }],
    footer: 'Runs every morning after the night’s games; differences between the two data providers usually clear within a few days.'
  };
  const subject = n ? `Needs you: ${n} top scorer${n === 1 ? '' : 's'} to look at (data check)` : `Data check: ${pct}% match, all good`;
  return { subject, ...renderAdminMail(mail) };
}

// fix239: an email only when something needs a look; a clean check is stored (Admin → Data) and sends nothing
async function emailReport(report: any) {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!emailEnabled || !to.length) return;
  if (!(report.issues || []).some((i: AuditIssue) => i.kind !== 'sanity')) return;
  const { subject, html, text } = auditEmail(report);
  for (const addr of to) await sendEmail(addr, subject, html, text);
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

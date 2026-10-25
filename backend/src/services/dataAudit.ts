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
import { emailEnabled, sendEmail, layout, section, esc, C, SITE } from './email';
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

/** The daily data-check email: a score, a league-by-league line, what needs a look, and the provider quirks folded below. */
export function auditEmail(report: any) {
  const issues: AuditIssue[] = report.issues || [];
  const action = issues.filter(i => i.kind !== 'sanity');
  const quirks = issues.filter(i => i.kind === 'sanity');
  const pct = report.checked ? Math.round((report.matched / report.checked) * 1000) / 10 : 0;
  const tone = pct >= 98 ? C.green : pct >= 93 ? C.amber : C.red;
  const day = new Date(report.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const playerLink = (i: AuditIssue) =>
    i.playerId ? `<a href="${SITE}${pubPath(`/player/${i.playerId}`)}" style="color:${C.ink};font-weight:700;text-decoration:none">${esc(i.player)}</a>` : `<b>${esc(i.player || leagueName(i.league))}</b>`;
  const chip = (t: string) => `<span style="display:inline-block;font-size:11px;font-weight:700;color:${C.muted};background:${C.chip};border-radius:6px;padding:2px 7px;margin-left:6px">${esc(t)}</span>`;

  // score
  const verdict = action.length === 0 ? 'Everything on the site matches' : `${action.length} thing${action.length === 1 ? '' : 's'} to look at`;
  let body = `<tr><td style="padding:18px 28px 4px">
    <div style="font-size:13px;color:${C.muted};font-weight:600">Daily data check</div>
    <div style="font-size:40px;line-height:1.1;font-weight:800;color:${tone};margin-top:6px">${pct}%</div>
    <div style="font-size:15px;color:${C.ink};margin-top:4px"><b>${report.matched} of ${report.checked}</b> top scorers match the official lists</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-radius:6px;overflow:hidden"><tr>
      <td style="height:8px;background:${tone};width:${Math.max(1, pct)}%"></td><td style="height:8px;background:${C.chip}"></td>
    </tr></table>
    <div style="font-size:14px;font-weight:700;margin-top:14px;color:${action.length ? C.amber : C.green}">${action.length ? '●' : '✓'} ${esc(verdict)}</div>
  </td></tr>`;

  // league by league
  const by = report.byLeague || {};
  const codes = Object.keys(by);
  if (codes.length) {
    body += section('League by league');
    const cells = codes.map(c => {
      const t = by[c], ok = t.matched === t.checked;
      return `<td width="50%" style="padding:5px 0;font-size:13px"><span style="color:${ok ? C.green : C.amber}">●</span>&nbsp; ${esc(leagueName(c))} <span style="color:${C.faint}">${t.matched}/${t.checked}</span></td>`;
    });
    let rows = '';
    for (let i = 0; i < cells.length; i += 2) rows += `<tr>${cells[i]}${cells[i + 1] || '<td></td>'}</tr>`;
    body += `<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`;
  }

  // needs a look
  if (action.length) {
    body += section('Needs a look', 'The site shows something different from the official list');
    body += `<tr><td style="padding:0 28px">${action
      .map(i => `<div style="border:1px solid ${C.line};border-left:4px solid ${C.amber};border-radius:10px;padding:10px 12px;margin:8px 0">
        <div style="font-size:14px">${playerLink(i)}${chip(leagueName(i.league))}</div>
        <div style="font-size:13px;color:${C.muted};margin-top:3px">${esc(i.detail)}</div></div>`)
      .join('')}</td></tr>`;
  }

  // provider quirks, one line per player
  if (quirks.length) {
    const byPlayer = new Map<string, AuditIssue[]>();
    for (const q of quirks) {
      const k = `${q.playerId || q.player}`;
      if (!byPlayer.has(k)) byPlayer.set(k, []);
      byPlayer.get(k)!.push(q);
    }
    const list = [...byPlayer.values()];
    const shown = list.slice(0, 8);
    body += section('Provider quirks', `${quirks.length} small oddities in old seasons from the data provider · no action needed`);
    body += `<tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${shown
      .map(g => `<tr><td style="padding:7px 0;border-bottom:1px solid ${C.line};font-size:13px">
        <div>${playerLink(g[0])}${chip(leagueName(g[0].league))}</div>
        <div style="color:${C.muted};margin-top:2px">${g.slice(0, 3).map(x => esc(x.detail)).join('<br>')}${g.length > 3 ? `<br><span style="color:${C.faint}">+${g.length - 3} more</span>` : ''}</div>
      </td></tr>`)
      .join('')}</table>${list.length > shown.length ? `<div style="font-size:12px;color:${C.faint};margin-top:8px">+ ${list.length - shown.length} more players in Data health</div>` : ''}</td></tr>`;
  }
  body += `<tr><td style="height:12px"></td></tr>`;

  const subject = action.length
    ? `Data check ${day}: ${pct}% match · ${action.length} to look at`
    : `Data check ${day}: ${pct}% match · all good`;
  const html = layout({
    preheader: `${report.matched} of ${report.checked} top scorers match the official lists. ${verdict}.`,
    label: day,
    body,
    cta: { text: 'Open Data health', href: `${SITE}/admin` },
    footer: 'Runs every morning after the night’s games. Differences between the two data providers usually clear within a few days; a player still wrong after a week is worth a look.'
  });
  const text = [
    `SportLikely · daily data check · ${day}`,
    `${pct}% · ${report.matched} of ${report.checked} top scorers match the official lists`,
    verdict,
    '',
    ...codes.map(c => `${leagueName(c)}: ${by[c].matched}/${by[c].checked}`),
    ...(action.length ? ['', 'NEEDS A LOOK', ...action.map(i => `- ${i.player || ''} (${leagueName(i.league)}): ${i.detail}`)] : []),
    ...(quirks.length ? ['', `PROVIDER QUIRKS (${quirks.length}, no action needed)`, ...quirks.slice(0, 15).map(i => `- ${i.player || ''}: ${i.detail}`)] : []),
    '',
    `Data health: ${SITE}/admin`
  ].join('\n');
  return { subject, html, text };
}

async function emailReport(report: any) {
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!emailEnabled || !to.length) return;
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

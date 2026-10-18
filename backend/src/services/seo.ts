import { db } from '../db';
import { isMissingPlayer } from './missingPlayers';
import { BB_LEAGUES } from './basketball';
import { bbPublic } from './bbSite';
import { FONT_HEAD } from './fonts';
import { getPreview, firstSentence, matchTitle, previewDates, previewFacts } from './matchPreview';
import { bbPreview } from './bbPreview';
import { nflCurrentSeason, schoolName, HIDE_OTHER } from './nfl';
import { nflPublic, nflWeeks, nflWeekGames, nflGamesBetween, nflGame, nflStandings, nflTeam, nflPlayer, leagueOfTeamId, type NflGame } from './nflSite';
import { listGuides, getGuide } from './guides';
import { HUBS, hubBySlug, hubByOld, hubForCode, hubOpen, buildHub, hubDescription, hubRange } from './hubs';
import { fitDescription, pack, shortDate, titleDate, formLetters, STATIC, Lang, ui, longDate } from './seoText';
import { fbLast, fbNext, fbH2h, fbWdl, fbTable, fbPosition, fbWeek, fbDay, FbGame, TableRow, bbGameById, bbLast, bbNext, bbH2h, bbWl, bbRecord, bbTable, bbWeek, bbDay, bbTeamName, BbGameRow } from './seoFacts';

/**
 * Search engines (Oct 2026). The site is a single-page app, so every address used to send the same empty page with
 * the home page's title. Now each page address gets its own title, description, canonical link, language
 * alternates and a short HTML version of its content (teams, date, competition, links) inside #root. The app
 * replaces that HTML when it starts, so visitors see the same thing as before; crawlers and link previews see
 * real content. Data comes from our own database only (no provider calls), so crawling costs nothing.
 */

const SITE = 'https://sportlikely.com';
/** Our social accounts (fix134), same as frontend/src/lib/social.ts: Organization sameAs. TikTok: add once Yarin sends the @handle. */
export const SOCIAL_URLS = ['https://instagram.com/sportlikely', 'https://x.com/sportlikely'];

/** fix134: old hub URLs (/predictions/PL, /es/predictions/PL …) → the new slug, for a 301. null = not an old hub URL. */
export function hubRedirect(rawPath: string): string | null {
  const m = rawPath.match(/^(\/(?:es|pt|de|fr|it|tr))?\/predictions\/([A-Za-z0-9-]+)\/?$/);
  if (!m) return null;
  const h = hubByOld(m[2]);
  // exact case: 'nba' / 'euroleague' are the new slugs of the old 'NBA' / 'EUROLEAGUE' (no loop)
  return h && m[2] !== h.slug ? `${m[1] || ''}/predictions/${h.slug}` : null;
}
const LANGS: readonly Lang[] = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr'];
const BRAND = 'SportLikely';

export interface SeoInfo {
  title: string;
  description: string;
  path: string; // without the language prefix
  lang: Lang;
  body: string; // HTML for crawlers (replaced by the app)
  jsonld?: any[];
  noindex?: boolean;
  /** English-only page (guides): canonical points at the English URL from every language version */
  canonicalEn?: boolean;
}

/** NFL (fix137): "Week 7" / "Playoffs", and the nickname for short titles ("Kansas City Chiefs" → "Chiefs"). */
const nflWeekText = (key: string, league: 1 | 2 = 1) => (key === 'post' ? (league === 2 ? 'Bowls' : 'Playoffs') : `Week ${key}`);
/** College titles keep the school name ("Alabama vs Georgia"); the NFL uses the nickname ("Chiefs"). */
const nflNick = (name: string, league: 1 | 2 = 1) => (league === 2 ? schoolName(name) : name.split(/\s+/).pop() || name);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const short = (iso: string, lang: Lang) => titleDate(iso, lang).replace(/[\s.,]*\d{4}\.?$/, '');
const link = (lang: Lang, p: string) => (lang === 'en' ? p : `/${lang}${p === '/' ? '' : p}`);

/* ---------- football data from our predictions table (every match we predict is stored before kick-off) ---------- */

interface FbMatch { id: number; date: string; code: string | null; comp: string | null; homeId: number | null; home: string; awayId: number | null; away: string }
const fbRow = (r: any): FbMatch => ({ id: r.match_id, date: r.utc_date, code: r.competition_code, comp: r.competition_name, homeId: r.home_team_id, home: r.home_team, awayId: r.away_team_id, away: r.away_team });
const FB_COLS = `match_id, MAX(utc_date) AS utc_date, MAX(competition_code) AS competition_code, MAX(competition_name) AS competition_name,
  MAX(home_team_id) AS home_team_id, MAX(home_team) AS home_team, MAX(away_team_id) AS away_team_id, MAX(away_team) AS away_team`;

function fbMatch(id: number): FbMatch | null {
  const r = db.prepare(`SELECT ${FB_COLS} FROM predictions WHERE match_id = ? GROUP BY match_id`).get(id) as any;
  return r && r.home_team ? fbRow(r) : null;
}
function fbUpcoming(limit: number, where = '', ...args: any[]): FbMatch[] {
  const now = new Date().toISOString(), to = new Date(Date.now() + 14 * 86400000).toISOString();
  return (db.prepare(`SELECT ${FB_COLS} FROM predictions WHERE utc_date >= ? AND utc_date <= ? ${where} GROUP BY match_id ORDER BY utc_date LIMIT ?`).all(now, to, ...args, limit) as any[])
    .filter(r => r.home_team).map(fbRow);
}
function fbRecent(days: number, limit: number): FbMatch[] {
  const from = new Date(Date.now() - days * 86400000).toISOString(), now = new Date().toISOString();
  return (db.prepare(`SELECT ${FB_COLS} FROM predictions WHERE utc_date >= ? AND utc_date < ? GROUP BY match_id ORDER BY utc_date DESC LIMIT ?`).all(from, now, limit) as any[])
    .filter(r => r.home_team).map(fbRow);
}
function fbCompetitions(): { code: string; name: string }[] {
  const from = new Date(Date.now() - 120 * 86400000).toISOString();
  return (db.prepare(`SELECT competition_code AS code, MAX(competition_name) AS name FROM predictions WHERE utc_date >= ? AND competition_code IS NOT NULL GROUP BY competition_code ORDER BY COUNT(*) DESC`).all(from) as any[]).filter(r => r.name);
}
function fbTeamName(id: number): string | null {
  const r = db.prepare(`SELECT CASE WHEN home_team_id = ? THEN home_team ELSE away_team END AS name FROM predictions WHERE home_team_id = ? OR away_team_id = ? ORDER BY utc_date DESC LIMIT 1`).get(id, id, id) as any;
  return r?.name || null;
}

const fbList = (lang: Lang, list: FbMatch[]) =>
  list.length ? `<ul>${list.map(m => `<li><a href="${link(lang, `/match/${m.id}`)}">${esc(m.home)} vs ${esc(m.away)}</a> · ${esc(m.comp || '')} · ${short(m.date, lang)}</li>`).join('')}</ul>` : '';

const sportsEvent = (name: string, date: string, home: string, away: string, url: string, comp?: string | null, sport = 'Soccer', description?: string) => ({
  '@context': 'https://schema.org', '@type': 'SportsEvent', name, startDate: date, sport, url,
  ...(description ? { description } : {}),
  ...(comp ? { superEvent: { '@type': 'SportsEvent', name: comp } } : {}),
  homeTeam: { '@type': 'SportsTeam', name: home }, awayTeam: { '@type': 'SportsTeam', name: away },
  eventStatus: 'https://schema.org/EventScheduled'
});

/* ---------- basketball ---------- */

function bbGameRow(id: number) {
  return db.prepare(`SELECT game_id, code, kickoff, home_id, home_name, away_id, away_name FROM bb_games WHERE game_id = ?`).get(id) as any;
}
function bbUpcoming(limit: number, code?: string) {
  const now = new Date().toISOString(), to = new Date(Date.now() + 10 * 86400000).toISOString();
  return db.prepare(`SELECT game_id, code, kickoff, home_name, away_name FROM bb_games WHERE kickoff >= ? AND kickoff <= ? ${code ? 'AND code = ?' : ''} ORDER BY kickoff LIMIT ?`)
    .all(...(code ? [now, to, code, limit] : [now, to, limit])) as any[];
}
const bbLeagueName = (code: string) => BB_LEAGUES.find(l => l.code === code)?.name || code;
const bbList = (lang: Lang, list: any[]) =>
  list.length ? `<ul>${list.map(g => `<li><a href="${link(lang, `/basketball/game/${g.game_id}`)}">${esc(g.home_name)} vs ${esc(g.away_name)}</a> · ${esc(bbLeagueName(g.code))} · ${short(g.kickoff, lang)}</li>`).join('')}</ul>` : '';

/* ---------- pieces of crawler HTML (fix124: same data visitors see, never the pick or a %) ---------- */

const fbScoreLine = (lang: Lang, g: FbGame) => `<li><a href="${link(lang, `/match/${g.id}`)}">${esc(g.home)} ${g.hg ?? ''}–${g.ag ?? ''} ${esc(g.away)}</a> · ${short(g.date, lang)}</li>`;
const fbFormList = (lang: Lang, team: string, teamId: number, games: FbGame[]) =>
  games.length ? `<h3>${esc(team)}: ${ui(lang, 'last')} ${games.length}</h3><p>${formLetters(games.map(g => fbWdl(g, teamId)), lang)}</p><ul>${games.map(g => fbScoreLine(lang, g)).join('')}</ul>` : '';
const tableHtml = (lang: Lang, rows: TableRow[], highlight: (number | null)[] = []) =>
  rows.length ? `<table><thead><tr><th>#</th><th>${ui(lang, 'team')}</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead><tbody>${rows.map(r =>
    `<tr${highlight.includes(r.teamId) ? ' class="hl"' : ''}><td>${r.pos}</td><td>${esc(r.team)}</td><td>${r.played}</td><td>${r.won}</td><td>${r.draw}</td><td>${r.lost}</td><td>${r.gd}</td><td>${r.pts}</td></tr>`).join('')}</tbody></table>` : '';
const bbScoreLine = (lang: Lang, g: BbGameRow) => `<li><a href="${link(lang, `/basketball/game/${g.id}`)}">${esc(g.home)} ${g.hs ?? ''}–${g.as_ ?? ''} ${esc(g.away)}</a> · ${short(g.date, lang)}</li>`;
const bbFormList = (lang: Lang, team: string, teamId: number, games: BbGameRow[]) =>
  games.length ? `<h3>${esc(team)}: ${ui(lang, 'last')} ${games.length}</h3><p>${formLetters(games.map(g => bbWl(g, teamId)), lang)}</p><ul>${games.map(g => bbScoreLine(lang, g)).join('')}</ul>` : '';

/** One-line facts for a football match (today page): form, last meeting, table positions. */
export function fbLine(g: FbGame, lang: Lang): string {
  const pk = pack(lang), bits: string[] = [];
  if (g.homeId && g.awayId) {
    const fh = fbLast(g.homeId, 5, g.date), fa = fbLast(g.awayId, 5, g.date);
    if (fh.length >= 3 && fa.length >= 3) bits.push(`${pk.form} ${formLetters(fh.map(x => fbWdl(x, g.homeId!)), lang)} vs ${formLetters(fa.map(x => fbWdl(x, g.awayId!)), lang)}`);
    const h2 = fbH2h(g.homeId, g.awayId, g.date, 1)[0];
    if (h2) bits.push(`${pk.lastMeeting} ${h2.hg}-${h2.ag}`);
    const ph = fbPosition(g.code, g.homeId), pa = fbPosition(g.code, g.awayId);
    if (ph && pa) bits.push(`#${ph.pos} vs #${pa.pos} ${pk.table}`);
  }
  return bits.join(' · ');
}
/** One-line facts for a basketball game (today page): season records, form, last meeting. */
export function bbLine(g: BbGameRow, lang: Lang): string {
  const pk = pack(lang), bits: string[] = [];
  const rh = bbRecord(g.homeId, g.code, g.season, g.date), ra = bbRecord(g.awayId, g.code, g.season, g.date);
  if (rh.n >= 3 && ra.n >= 3) bits.push(`${pk.record} ${rh.w}-${rh.l} vs ${ra.w}-${ra.l}`);
  const fh = bbLast(g.homeId, 5, g.date), fa = bbLast(g.awayId, 5, g.date);
  if (fh.length >= 3 && fa.length >= 3) bits.push(`${pk.form} ${formLetters(fh.map(x => bbWl(x, g.homeId)), lang)} vs ${formLetters(fa.map(x => bbWl(x, g.awayId)), lang)}`);
  const h2 = bbH2h(g.homeId, g.awayId, g.date, 1)[0];
  if (h2) bits.push(`${pk.lastMeeting} ${h2.hs}-${h2.as_}`);
  return bits.join(' · ');
}
/** Today's games grouped by league, with their one-line facts (the /predictions/today pages and their API). */
const todayCache = new Map<string, { at: number; v: ReturnType<typeof buildToday> }>();
export type TodaySport = 'football' | 'basketball' | 'american-football';
export function todayGroups(sport: TodaySport, lang: Lang, dayIso = new Date().toISOString().slice(0, 10), league: 1 | 2 = 1) {
  const k = `${sport}:${league}:${lang}:${dayIso}`, c = todayCache.get(k);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.v;
  const v = buildToday(sport, lang, dayIso, league);
  if (todayCache.size > 200) todayCache.clear();
  todayCache.set(k, { at: Date.now(), v });
  return v;
}
/** fix152b: one-line facts for an NFL / college game (today page): season records, form, last meeting. */
function nflLine(g: any, lang: Lang): string {
  const pk = pack(lang), bits: string[] = [];
  const last = (id: number) => db.prepare(`SELECT home_id, home_pts, away_pts FROM nfl_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL ORDER BY kickoff DESC LIMIT 5`).all(id, id, g.kickoff) as any[];
  const wl = (r: any, id: number) => { const f = r.home_id === id ? r.home_pts : r.away_pts, a = r.home_id === id ? r.away_pts : r.home_pts; return f > a ? 'W' : f < a ? 'L' : 'D'; };
  const rec = (id: number) => { const rs = db.prepare(`SELECT home_id, home_pts, away_pts FROM nfl_games WHERE season = ? AND (home_id = ? OR away_id = ?) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL`).all(g.season, id, id, g.kickoff) as any[]; const w = rs.filter(r => wl(r, id) === 'W').length; return { w, l: rs.length - w, n: rs.length }; };
  const rh = rec(g.home_id), ra = rec(g.away_id);
  if (rh.n >= 2 && ra.n >= 2) bits.push(`${pk.record} ${rh.w}-${rh.l} vs ${ra.w}-${ra.l}`);
  const fh = last(g.home_id), fa = last(g.away_id);
  if (fh.length >= 3 && fa.length >= 3) bits.push(`${pk.form} ${formLetters(fh.map(x => wl(x, g.home_id)) as any, lang)} vs ${formLetters(fa.map(x => wl(x, g.away_id)) as any, lang)}`);
  const h2 = db.prepare(`SELECT home_id, home_pts, away_pts FROM nfl_games WHERE ((home_id = ? AND away_id = ?) OR (home_id = ? AND away_id = ?)) AND kickoff < ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL ORDER BY kickoff DESC LIMIT 1`).get(g.home_id, g.away_id, g.away_id, g.home_id, g.kickoff) as any;
  if (h2) bits.push(`${pk.lastMeeting} ${h2.home_id === g.home_id ? `${h2.home_pts}-${h2.away_pts}` : `${h2.away_pts}-${h2.home_pts}`}`);
  return bits.join(' · ');
}

function buildToday(sport: TodaySport, lang: Lang, dayIso: string, league: 1 | 2 = 1) {
  const groups = new Map<string, { league: string; code: string | null; games: any[] }>();
  if (sport === 'american-football') {
    const name = league === 2 ? 'College football' : 'NFL', code = league === 2 ? 'NCAA' : 'NFL';
    const rows = db.prepare(`SELECT game_id, season, kickoff, home_id, away_id, home_name, away_name, status, home_pts, away_pts FROM nfl_games WHERE league = ? ${HIDE_OTHER} AND kickoff >= ? AND kickoff <= ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') AND (status IS NULL OR status NOT IN ('CANC','PST')) ORDER BY kickoff`)
      .all(league, `${dayIso}T00:00:00.000Z`, `${dayIso}T23:59:59.999Z`) as any[];
    for (const g of rows) {
      if (!groups.has(code)) groups.set(code, { league: name, code, games: [] });
      groups.get(code)!.games.push({ id: g.game_id, kickoff: g.kickoff, home: g.home_name || 'TBD', away: g.away_name || 'TBD', homeId: g.home_id, awayId: g.away_id, score: g.home_pts != null && (g.status === 'FT' || g.status === 'AOT') ? [g.home_pts, g.away_pts] : null, line: nflLine(g, lang) });
    }
    return { day: dayIso, groups: [...groups.values()] };
  }
  if (sport === 'football') {
    for (const g of fbDay(dayIso)) {
      const k = g.code || g.comp || '?';
      if (!groups.has(k)) groups.set(k, { league: g.comp || k, code: g.code, games: [] });
      groups.get(k)!.games.push({ id: g.id, kickoff: g.date, home: g.home, away: g.away, homeId: g.homeId, awayId: g.awayId, score: g.hg != null ? [g.hg, g.ag] : null, line: fbLine(g, lang) });
    }
  } else {
    for (const g of bbDay(dayIso)) {
      if (!groups.has(g.code)) groups.set(g.code, { league: bbLeagueName(g.code), code: g.code, games: [] });
      groups.get(g.code)!.games.push({ id: g.id, kickoff: g.date, home: g.home, away: g.away, homeId: g.homeId, awayId: g.awayId, score: g.hs != null && (g.status === 'FT' || g.status === 'AOT') ? [g.hs, g.as_] : null, line: bbLine(g, lang) });
    }
  }
  return { day: dayIso, groups: [...groups.values()] };
}

/* ---------- pages ---------- */

const NAV = (lang: Lang) => `<nav><a href="${link(lang, '/')}">${BRAND}</a> · <a href="${link(lang, '/matches')}">${ui(lang, 'matches')}</a> · <a href="${link(lang, '/predictions/today')}">${ui(lang, 'today')}</a> · <a href="${link(lang, '/premium')}">Premium</a>${bbPublic() ? ` · <a href="${link(lang, '/basketball')}">${ui(lang, 'basketball')}</a>` : ''}${nflPublic() ? ` · <a href="/american-football">American football</a>` : ''}</nav>`;
const PRIVATE = /^\/(admin|account|verify|forgot|login|signup|favorites|my-picks|join|crm)(\/|$)|^\/basketball\/(favorites|past)(\/|$)|^\/past(\/|$)/;

export function seoPage(rawPath: string): SeoInfo {
  let path = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
  let lang: Lang = 'en';
  const m0 = path.match(/^\/(es|pt|de|fr|it|tr)(\/|$)/);
  if (m0) { lang = m0[1] as Lang; path = path.slice(3) || '/'; }
  const pk = pack(lang);
  const page = (title: string, description: string, body: string, extra: Partial<SeoInfo> = {}): SeoInfo =>
    ({ title, description, path, lang, body: `${NAV(lang)}<main>${body}</main>`, ...extra });
  const S = (k: keyof typeof STATIC) => STATIC[k][lang];

  if (PRIVATE.test(path)) return page(BRAND, 'SportLikely account page.', '', { noindex: true });

  let m: RegExpMatchArray | null;
  try {
    if (path === '/') {
      return page(`${BRAND} · Sports predictions, tested in public`, S('home'),
        `<h1>Sports predictions, tested in public</h1><p>Football predictions for the top leagues, cups and national teams, and basketball (NBA, EuroLeague and more): form, head-to-head, goals and the reasons behind every pick. Every prediction is saved before kick-off and scored after the game.</p><p><a href="${link(lang, '/predictions/today')}">Football predictions today</a>${bbPublic() ? ` · <a href="${link(lang, '/basketball/predictions/today')}">Basketball predictions today</a>` : ''}${nflPublic() ? ` · <a href="/american-football">American football (NFL)</a>` : ''}</p><h2>Next football matches</h2>${fbList(lang, fbUpcoming(30))}`,
        { jsonld: [
          { '@context': 'https://schema.org', '@type': 'Organization', name: BRAND, url: SITE, logo: `${SITE}/icon-512.png`, description: 'Sports predictions tested in public.', sameAs: SOCIAL_URLS },
          { '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: SITE }
        ] });
    }
    if (path === '/matches') {
      return page(`Football predictions for today and the coming days | ${BRAND}`, S('matches'),
        `<h1>Football matches and predictions</h1>${fbList(lang, fbUpcoming(120))}<h2>Competitions</h2><ul>${fbCompetitions().map(c => `<li><a href="${link(lang, `/league/${c.code}`)}">${esc(c.name)}</a></li>`).join('')}</ul>`);
    }
    // fix169: a football player the provider doesn't have (old links): not found, never indexed
    if ((m = path.match(/^\/player\/(\d+)$/)) && isMissingPlayer(Number(m[1]))) return page(`Player not found | ${BRAND}`, 'This player does not exist.', '', { noindex: true });
    if (path === '/predictions/today') {
      const t = todayGroups('football', lang);
      return page(`${pk.today} · ${titleDate(new Date().toISOString(), lang)} | ${BRAND}`, S('today'),
        `<h1>${esc(pk.today)}</h1><p>${esc(longDate(new Date().toISOString(), lang))}</p>${t.groups.map(gr => `<h2>${gr.code ? `<a href="${link(lang, `/league/${gr.code}`)}">${esc(gr.league)}</a>` : esc(gr.league)}</h2><ul>${gr.games.map(g =>
          `<li><a href="${link(lang, `/match/${g.id}`)}">${esc(g.home)} vs ${esc(g.away)}</a>${g.line ? ` — ${esc(g.line)}` : ''}</li>`).join('')}</ul>`).join('') || '<p>No matches today.</p>'}`);
    }
    if ((m = path.match(/^\/match\/(\d+)$/))) {
      const x = fbMatch(Number(m[1]));
      if (x) {
        const name = `${x.home} vs ${x.away}`;
        const when = longDate(x.date, lang);
        // match preview (fix121): English only for now, the same text the match page shows (never the pick or a %)
        const pv = lang === 'en' ? getPreview(x.id) : null;
        const facts = previewFacts(x.id);
        const fh = x.homeId ? fbLast(x.homeId, 5, x.date) : [], fa = x.awayId ? fbLast(x.awayId, 5, x.date) : [];
        const h2 = x.homeId && x.awayId ? fbH2h(x.homeId, x.awayId, x.date, 5) : [];
        const ph = fbPosition(x.code, x.homeId), pa = fbPosition(x.code, x.awayId);
        const tbl = ph && pa ? { home: ph.pos, away: pa.pos } : facts?.table.home && facts?.table.away ? { home: facts.table.home.pos, away: facts.table.away.pos } : null;
        const out = { home: facts?.out.home || null, away: facts?.out.away || null };
        // fix124: one full sentence of 140–155 characters, in the page's language
        const desc = fitDescription(
          [`${name}, ${x.comp || 'Football'}, ${shortDate(x.date, lang)}`, `${name}, ${shortDate(x.date, lang)}`],
          [
            ...(fh.length >= 3 && fa.length >= 3 ? [`${pk.form} (${formLetters(fh.map(g => fbWdl(g, x.homeId!)), lang)} vs ${formLetters(fa.map(g => fbWdl(g, x.awayId!)), lang)})`] : []),
            ...(h2.length ? [`${pk.lastMeeting} ${h2[0].hg}-${h2[0].ag}`] : []),
            ...(tbl ? [`#${tbl.home} vs #${tbl.away} ${pk.table}`] : []),
            ...((out.home?.length || out.away?.length) ? [pk.absences] : [])
          ], pk.fbFill, pk.fbTails);
        const title = lang === 'en' ? matchTitle(x.home, x.away, x.comp, x.date) : `${name} ${pk.previewTitle} · ${x.comp || 'Football'} · ${titleDate(x.date, lang)} | ${BRAND}`;
        const absences = (out.home?.length || out.away?.length)
          ? `<h2>${ui(lang, 'absences')}</h2><ul>${out.home?.length ? `<li>${esc(x.home)}: ${esc(out.home.join(', '))}</li>` : ''}${out.away?.length ? `<li>${esc(x.away)}: ${esc(out.away.join(', '))}</li>` : ''}</ul>` : '';
        return page(title, desc,
          `<h1>${esc(name)} ${esc(pk.prediction)}</h1><p>${esc(x.comp || '')} · ${esc(when)}</p>${pv ? `<section><h2>${ui(lang, 'matchPreview')}</h2><p>${esc(pv.text)}</p></section>` : ''}`
          + (fh.length || fa.length ? `<h2>${ui(lang, 'recentForm')}</h2>${fbFormList(lang, x.home, x.homeId!, fh)}${fbFormList(lang, x.away, x.awayId!, fa)}` : '')
          + (h2.length ? `<h2>${ui(lang, 'lastMeetings')}</h2><ul>${h2.map(g => fbScoreLine(lang, g)).join('')}</ul>` : '')
          + (tbl ? `<h2>${ui(lang, 'table')}</h2><p>${esc(x.home)}: ${tbl.home} · ${esc(x.away)}: ${tbl.away}</p>` : '')
          + absences
          + `<ul>${x.code ? `<li><a href="${link(lang, `/league/${x.code}`)}">${esc(x.comp || x.code)}</a></li>` : ''}${x.homeId ? `<li><a href="${link(lang, `/team/${x.homeId}`)}">${esc(x.home)}</a></li>` : ''}${x.awayId ? `<li><a href="${link(lang, `/team/${x.awayId}`)}">${esc(x.away)}</a></li>` : ''}</ul>`,
          { jsonld: [sportsEvent(name, x.date, x.home, x.away, SITE + link(lang, path), x.comp, 'Soccer', pv ? firstSentence(pv.text) : undefined)] });
      }
    }
    if ((m = path.match(/^\/league\/([A-Za-z0-9]+)$/))) {
      const code = m[1].toUpperCase();
      const comp = fbCompetitions().find(c => c.code === code);
      if (comp) {
        const table = fbTable(code), week = fbWeek(code);
        const desc = fitDescription([`${comp.name} ${pk.predictions}`],
          [...(table[0] ? [`${pk.leader} ${table[0].team}`] : []), ...(week.length ? [`${week.length} ${pk.thisWeek}`] : [])], pk.leagueFill, pk.leagueTails);
        return page(`${comp.name} ${pk.predictions}, ${pk.tableStats} | ${BRAND}`, desc,
          `<h1>${esc(comp.name)} ${esc(pk.predictions)}</h1>${hubForCode('football', code) ? `<p><a href="/predictions/${hubForCode('football', code)!.slug}">This week's predictions</a></p>` : ''}${table.length ? `<h2>${ui(lang, 'table')}</h2>${tableHtml(lang, table.slice(0, 10))}` : ''}`
          + (week.length ? `<h2>${ui(lang, 'thisWeek')}</h2><ul>${week.map(g => g.hg != null ? fbScoreLine(lang, g) : `<li><a href="${link(lang, `/match/${g.id}`)}">${esc(g.home)} vs ${esc(g.away)}</a> · ${short(g.date, lang)}</li>`).join('')}</ul>` : '')
          + `<h2>Next matches</h2>${fbList(lang, fbUpcoming(60, 'AND competition_code = ?', code))}`);
      }
    }
    if ((m = path.match(/^\/team\/(\d+)$/))) {
      const id = Number(m[1]);
      const name = fbTeamName(id);
      if (name) {
        const next = fbNext(id, 5), last = fbLast(id, 5);
        const code = (next[0] || last[0])?.code || null, compName = (next[0] || last[0])?.comp || null;
        const pos = fbPosition(code, id);
        const desc = fitDescription([name],
          [
            ...(next[0] ? [`${pk.next} ${next[0].homeId === id ? next[0].away : next[0].home} (${shortDate(next[0].date, lang)})`] : []),
            ...(last.length >= 3 ? [`${pk.form} ${formLetters(last.map(g => fbWdl(g, id)), lang)}`] : []),
            ...(pos && compName ? [`#${pos.pos} ${compName}`] : [])
          ], pk.teamFill, pk.teamTails);
        return page(`${name}: ${pk.nextAndForm} | ${BRAND}`, desc,
          `<h1>${esc(name)}</h1>${pos && compName ? `<p>${esc(compName)}: #${pos.pos} ${esc(pk.table)}</p>` : ''}<h2>${ui(lang, 'nextGames')}</h2>${fbList(lang, next.map(g => ({ id: g.id, date: g.date, code: g.code, comp: g.comp, homeId: g.homeId, home: g.home, awayId: g.awayId, away: g.away })))}`
          + (last.length ? `<h2>${ui(lang, 'lastResults')}</h2><p>${formLetters(last.map(g => fbWdl(g, id)), lang)}</p><ul>${last.map(g => fbScoreLine(lang, g)).join('')}</ul>` : ''));
      }
    }
    // weekly league hubs (fix125): English text on every language version, canonical to the English URL
    if ((m = path.match(/^\/predictions\/([A-Za-z0-9-]+)$/)) && m[1] !== 'today') {
      const def = hubBySlug(m[1]);
      if (!def || !hubOpen(def)) return page(`Not found | ${BRAND}`, 'This page does not exist.', '', { noindex: true });
      const h = buildHub(def);
      const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
      const games = h.games.length
        ? h.games.map(g => `<section><h2><a href="${g.url}">${esc(g.home)} vs ${esc(g.away)}</a></h2><p>${g.score ? `Final score ${g.score[0]}–${g.score[1]} · ` : ''}${esc(when(g.kickoff))}</p>${g.preview ? `<p>${esc(g.preview)}</p>` : ''}</section>`).join('')
        : `<p>No matches this week.${h.next ? ` Next match: ${esc(new Date(h.next).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }))}.` : ''}</p>`;
      const leagueUrl = def.sport === 'football' ? `/league/${def.code}` : def.sport === 'basketball' ? `/basketball/league/${def.code}` : '/american-football/league';
      const what = def.sport === 'american-football' ? 'games' : 'predictions'; // fix137: no NFL predictions yet
      return page(`${def.name} ${what} this week · ${hubRange(h.from, h.to)} | ${BRAND}`, hubDescription(def),
        `<h1>${esc(def.name)} ${what} this week</h1><p>${esc(def.intro)}</p>${games}<p><a href="${leagueUrl}">${esc(def.name)} table and fixtures</a></p>`,
        { canonicalEn: true, jsonld: h.games.slice(0, 20).map(g => sportsEvent(`${g.home} vs ${g.away}`, g.kickoff, g.home, g.away, SITE + g.url, def.name, def.sport === 'football' ? 'Soccer' : def.sport === 'basketball' ? 'Basketball' : 'American Football')) });
    }
    // guides (fix125): English text on every language version, canonical to the English URL
    if (path === '/guides') {
      const gs = listGuides();
      return page(`Guides: how to read sports predictions | ${BRAND}`,
        'Plain-English guides to our football predictions: what double chance means, how to read win percentages and how we test every pick in public.',
        `<h1>Guides</h1><ul>${gs.map(g => `<li><a href="/guides/${g.slug}">${esc(g.title.replace(/\s*\|\s*SportLikely\s*$/, ''))}</a>: ${esc(g.description)}</li>`).join('')}</ul>`,
        { canonicalEn: true });
    }
    if ((m = path.match(/^\/guides\/([a-z0-9-]+)$/))) {
      const g = getGuide(m[1]);
      if (!g) return page(`Guide not found | ${BRAND}`, 'This guide does not exist.', '', { noindex: true });
      return page(g.title, g.description,
        `<article><h1>${esc(g.h1)}</h1>${g.html}</article>${g.relatedGuides.length ? `<h2>Related guides</h2><ul>${g.relatedGuides.map(r => `<li><a href="/guides/${r.slug}">${esc(r.title)}</a></li>`).join('')}</ul>` : ''}<p><a href="/guides">All guides</a></p>`,
        { canonicalEn: true, jsonld: [{
          '@context': 'https://schema.org', '@type': 'Article', headline: g.h1, description: g.description, inLanguage: 'en',
          url: `${SITE}/guides/${g.slug}`, mainEntityOfPage: `${SITE}/guides/${g.slug}`, dateModified: g.updated,
          author: { '@type': 'Organization', name: BRAND, url: SITE },
          publisher: { '@type': 'Organization', name: BRAND, url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}/icon-512.png` } }
        }] });
    }
    // record pages are admin-only for now (fix118, 14 Oct 2026): not indexed, not in the sitemap
    if (path === '/accuracy' || path === '/basketball/accuracy') return page(`Our record | ${BRAND}`, 'SportLikely record page.', '', { noindex: true });
    if (path === '/premium') return page(`Premium and Pro plans | ${BRAND}`, S('premium'), '<h1>SportLikely Premium and Pro</h1>');
    if (path === '/draw-alerts') return page(`Draw alerts | ${BRAND}`, S('generic'), '<h1>Draw alerts</h1>');
    if (path === '/terms') return page(`Terms of use | ${BRAND}`, S('generic'), '<h1>Terms of use</h1>');
    if (path === '/privacy') return page(`Privacy policy | ${BRAND}`, S('generic'), '<h1>Privacy policy</h1>');
    if (path === '/accessibility') return page(`Accessibility | ${BRAND}`, S('generic'), '<h1>Accessibility statement</h1>');
    if (path === '/contact') return page(`Contact us | ${BRAND}`, S('generic'), '<h1>Contact us</h1><p>Write to support@sportlikely.com or use the contact form.</p>');

    // NFL (fix137): crawler HTML for every NFL page, English text (canonical to English); noindex until NFL_PUBLIC=1
    if (path === '/american-football' || path.startsWith('/american-football/')) {
      if (!nflPublic()) return page(`American football · coming soon | ${BRAND}`, 'NFL games, scores, standings and team analysis are coming soon to SportLikely.', '<h1>American football · coming soon</h1>', { noindex: true });
      // fix142: college football lists live under /american-football/college; game / team / player pages know their league
      const lg: 1 | 2 = /^\/american-football\/college(\/|$)/.test(path) ? 2 : 1;
      if (lg === 2) path = path.replace('/american-football/college', '/american-football');
      const base = lg === 2 ? '/american-football/college' : '/american-football';
      let LN = lg === 2 ? 'College football' : 'NFL';
      const nflNav = `<p><a href="/american-football">NFL</a> · <a href="/american-football/college">College football</a> · <a href="${base}/games">Games</a> · <a href="${base}/today">Today</a> · <a href="${base}/league">Standings</a></p>`;
      const nflList = (gs: NflGame[]) => gs.length ? `<ul>${gs.map(g => `<li><a href="/american-football/game/${g.id}">${esc(g.home.name)} vs ${esc(g.away.name)}</a> · ${esc(nflWeekText(g.weekKey, g.league))} · ${short(g.kickoff, 'en')}${g.score ? ` · ${g.score.home}–${g.score.away}` : ''}</li>`).join('')}</ul>` : '<p>No games scheduled.</p>';
      const season = nflCurrentSeason(lg);
      const extra = { canonicalEn: true } as Partial<SeoInfo>;
      if (path === '/american-football/favorites') return page(`NFL favorites | ${BRAND}`, 'Your NFL teams.', '', { noindex: true });
      if (path === '/american-football' || path === '/american-football/games') {
        const { current } = season ? nflWeeks(season, lg) : { current: null };
        const games = season && current ? nflWeekGames(season, current, lg) : [];
        const label = current ? nflWeekText(current, lg) : 'this week';
        return page(path === '/american-football' ? `${LN} predictions, scores and standings · ${label} | ${BRAND}` : `${LN} games ${season || ''} · ${label} | ${BRAND}`,
          `${LN} ${season || ''} ${label}: every game with each team's chance to win, kick-off times, live scores, results, standings, team analysis and player statistics.`,
          `${nflNav}<h1>${LN} games · ${esc(label)}</h1><p>Every ${LN} game of ${esc(label)} with each team's chance to win, kick-off times and scores, the standings by conference${lg === 1 ? ' and division' : ''}, and each team's strengths and weaknesses.</p>${nflList(games)}`,
          { ...extra, jsonld: games.slice(0, 20).map(g => sportsEvent(`${g.home.name} vs ${g.away.name}`, g.kickoff, g.home.name, g.away.name, `${SITE}/american-football/game/${g.id}`, LN, 'American Football')) });
      }
      if (path === '/american-football/today') {
        const from = new Date(); from.setUTCHours(0, 0, 0, 0);
        const games = nflGamesBetween(from.toISOString(), new Date(from.getTime() + 86400000).toISOString(), lg);
        return page(`${LN} games today | ${BRAND}`, `Today’s ${LN} games with kick-off times and live scores.`, `${nflNav}<h1>${LN} games today</h1>${nflList(games)}`, extra);
      }
      if (path === '/american-football/league') {
        const st = season ? nflStandings(season, lg) : null;
        const body = st ? st.conferences.map(c => `<h2>${esc(c.name)}${c.level ? ` (${esc(c.level)})` : ''}</h2>${c.divisions.map(d => `${d.name !== c.name ? `<h3>${esc(d.name)}</h3>` : ''}<ol>${d.rows.map(r => `<li><a href="/american-football/team/${r.team.id}">${esc(r.team.name)}</a> ${r.w}-${r.l}${r.t ? `-${r.t}` : ''}, ${r.pf} points for, ${r.pa} against</li>`).join('')}</ol>`).join('')}`).join('') : '';
        if (lg === 2) return page(`College football standings ${season || ''} by conference | ${BRAND}`, `College football standings ${season || ''}: every FBS and FCS conference with wins, losses, points for and against.`, `${nflNav}<h1>College football standings ${season || ''}</h1>${body}`, extra);
        return page(`NFL standings ${season || ''}: AFC and NFC by division | ${BRAND}`, `NFL standings ${season || ''}: every division of the AFC and NFC with wins, losses, ties, points for and against, and the league leaders.`, `${nflNav}<h1>NFL standings ${season || ''}</h1>${body}`, extra);
      }
      if ((m = path.match(/^\/american-football\/game\/(\d+)$/))) {
        const d = nflGame(Number(m[1]), false);
        if (!d) return page(`Game not found | ${BRAND}`, 'This game does not exist.', '', { noindex: true });
        const g = d.game, wk = nflWeekText(g.weekKey, g.league);
        LN = g.league === 2 ? 'College football' : 'NFL';
        const title = `${nflNick(g.home.name, g.league)} vs ${nflNick(g.away.name, g.league)} · ${LN} ${wk} | ${BRAND}`;
        const when = longDate(g.kickoff, 'en');
        const form = (s: 'home' | 'away') => d.form[s].map(f => f.result).join('');
        const desc = g.score
          ? `${g.home.name} ${g.score.home}–${g.score.away} ${g.away.name}, ${LN} ${wk} (${when}): score by quarter, team and player statistics, form and head-to-head.`
          : `${g.home.name} vs ${g.away.name}, ${LN} ${wk} on ${when}${g.venue ? ` at ${g.venue}` : ''}: our prediction with each team's chance to win, form, head-to-head and team statistics.`;
        return page(title, desc,
          `${nflNav}<h1>${esc(g.home.name)} vs ${esc(g.away.name)}</h1><p>${LN} ${esc(wk)} · ${esc(when)}${g.venue ? ` · ${esc(g.venue)}` : ''}</p>${g.score ? `<p>Final score ${g.score.home}–${g.score.away}</p>` : ''}`
          + `<p>${esc(g.home.name)} last 5: ${form('home') || '–'} · ${esc(g.away.name)} last 5: ${form('away') || '–'}.</p>`
          + (d.h2h.length ? `<h2>Last meetings</h2>${nflList(d.h2h)}` : '')
          + `<ul><li><a href="/american-football/team/${g.home.id}">${esc(g.home.name)}</a></li><li><a href="/american-football/team/${g.away.id}">${esc(g.away.name)}</a></li><li><a href="${g.league === 2 ? '/american-football/college' : '/american-football'}/league">${LN} standings</a></li></ul>`,
          { ...extra, jsonld: [sportsEvent(`${g.home.name} vs ${g.away.name}`, g.kickoff, g.home.name, g.away.name, `${SITE}/american-football/game/${g.id}`, LN, 'American Football', desc)] });
      }
      if ((m = path.match(/^\/american-football\/team\/(\d+)$/)) && season) {
        const tl = leagueOfTeamId(Number(m[1]));
        const d = nflTeam(Number(m[1]), nflCurrentSeason(tl) || season);
        if (!d) return page(`Team not found | ${BRAND}`, 'This team does not exist.', '', { noindex: true });
        const rec = d.standing ? `${d.standing.w}-${d.standing.l}${d.standing.t ? `-${d.standing.t}` : ''}` : null;
        const a = d.analysis;
        return page(`${d.team.name}: schedule, results and team analysis ${d.season} | ${BRAND}`,
          `${d.team.name} ${d.season}${rec ? ` (${rec})` : ''}${tl === 2 ? ' college football' : ''}: next games, results, roster, injuries and a team analysis of strengths and weaknesses.`,
          `${nflNav}<h1>${esc(d.team.name)}</h1><p>${esc([d.team.conference, d.team.division].filter(Boolean).join(' · '))}${rec ? ` · ${rec}` : ''}</p>`
          + (a && (a.strengths.length || a.weaknesses.length) ? `<h2>Team analysis</h2><ul>${a.strengths.map(x => `<li>Strength: ${esc(x.label)} ${esc(x.text || '')} (#${x.rank} of ${x.of})</li>`).join('')}${a.weaknesses.map(x => `<li>Weakness: ${esc(x.label)} ${esc(x.text || '')} (#${x.rank} of ${x.of})</li>`).join('')}</ul>` : '')
          + `<h2>Next games</h2>${nflList(d.schedule.slice(0, 8))}<h2>Results</h2>${nflList(d.results.slice(0, 17))}`, extra);
      }
      if ((m = path.match(/^\/american-football\/player\/(\d+)$/)) && season) {
        const d = nflPlayer(Number(m[1]), season);
        if (!d) return page(`Player not found | ${BRAND}`, 'This player does not exist.', '', { noindex: true });
        const p = d.player;
        return page(`${p.name}${p.position ? ` (${p.position})` : ''}: ${season} stats and game log | ${BRAND}`,
          `${p.name}${d.team ? `, ${d.team.name}` : ''}: ${season} season statistics and game log.`,
          `${nflNav}<h1>${esc(p.name)}</h1><p>${esc([p.position, d.team?.name].filter(Boolean).join(' · '))}</p>${Object.entries(d.totals).map(([g, st]) => `<h2>${esc(g)}</h2><p>${Object.entries(st).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ')}</p>`).join('')}`, extra);
      }
      return page(`${LN} | ${BRAND}`, `${LN} games, scores and standings on SportLikely.`, `${nflNav}<h1>${LN}</h1>`, extra);
    }
    if (path.startsWith('/basketball')) {
      if (!bbPublic()) return page(`Basketball predictions · coming soon | ${BRAND}`, S('basketball'), '<h1>Basketball · coming soon</h1>', { noindex: true });
      if (path === '/basketball' || path === '/basketball/games') {
        return page(`Basketball predictions: NBA, EuroLeague and more | ${BRAND}`, S('basketball'),
          `<h1>Basketball predictions</h1><p><a href="${link(lang, '/basketball/predictions/today')}">Basketball predictions today</a></p>${bbList(lang, bbUpcoming(80))}<h2>Leagues</h2><ul>${BB_LEAGUES.map(l => `<li><a href="${link(lang, `/basketball/league/${l.code}`)}">${esc(l.name)}</a></li>`).join('')}</ul>`);
      }
      if (path === '/basketball/predictions/today') {
        const t = todayGroups('basketball', lang);
        return page(`${pk.todayBb} · ${titleDate(new Date().toISOString(), lang)} | ${BRAND}`, S('todayBb'),
          `<h1>${esc(pk.todayBb)}</h1><p>${esc(longDate(new Date().toISOString(), lang))}</p>${t.groups.map(gr => `<h2><a href="${link(lang, `/basketball/league/${gr.code}`)}">${esc(gr.league)}</a></h2><ul>${gr.games.map(g =>
            `<li><a href="${link(lang, `/basketball/game/${g.id}`)}">${esc(g.home)} vs ${esc(g.away)}</a>${g.line ? ` — ${esc(g.line)}` : ''}</li>`).join('')}</ul>`).join('') || '<p>No games today.</p>'}`);
      }
      if ((m = path.match(/^\/basketball\/game\/(\d+)$/))) {
        const g = bbGameById(Number(m[1]));
        if (g) {
          const name = `${g.home} vs ${g.away}`, lg = bbLeagueName(g.code);
          const rh = bbRecord(g.homeId, g.code, g.season, g.date), ra = bbRecord(g.awayId, g.code, g.season, g.date);
          const fh = bbLast(g.homeId, 5, g.date), fa = bbLast(g.awayId, 5, g.date), h2 = bbH2h(g.homeId, g.awayId, g.date, 5);
          const desc = fitDescription([`${name}, ${lg}, ${shortDate(g.date, lang)}`, `${name}, ${shortDate(g.date, lang)}`],
            [
              ...(rh.n >= 3 && ra.n >= 3 ? [`${pk.record} ${rh.w}-${rh.l} vs ${ra.w}-${ra.l}`] : []),
              ...(fh.length >= 3 && fa.length >= 3 ? [`${pk.form} (${formLetters(fh.map(x => bbWl(x, g.homeId)), lang)} vs ${formLetters(fa.map(x => bbWl(x, g.awayId)), lang)})`] : []),
              ...(h2.length ? [`${pk.lastMeeting} ${h2[0].hs}-${h2[0].as_}`] : [])
            ], pk.bbFill, pk.bbTails);
          const pv = lang === 'en' ? bbPreview(g.id) : null;
          return page(`${name} ${lang === 'en' ? 'prediction & preview' : pk.previewTitle} · ${lg} · ${titleDate(g.date, lang)} | ${BRAND}`, desc,
            `<h1>${esc(name)} ${esc(pk.prediction)}</h1><p>${esc(lg)} · ${esc(longDate(g.date, lang))}</p>${pv ? `<section><h2>${ui(lang, 'gamePreview')}</h2><p>${esc(pv)}</p></section>` : ''}`
            + (rh.n && ra.n ? `<p>${ui(lang, 'season')}: ${esc(g.home)} ${rh.w}-${rh.l} · ${esc(g.away)} ${ra.w}-${ra.l}</p>` : '')
            + (fh.length || fa.length ? `<h2>${ui(lang, 'recentForm')}</h2>${bbFormList(lang, g.home, g.homeId, fh)}${bbFormList(lang, g.away, g.awayId, fa)}` : '')
            + (h2.length ? `<h2>${ui(lang, 'lastMeetings')}</h2><ul>${h2.map(x => bbScoreLine(lang, x)).join('')}</ul>` : '')
            + `<ul><li><a href="${link(lang, `/basketball/league/${g.code}`)}">${esc(lg)}</a></li><li><a href="${link(lang, `/basketball/team/${g.homeId}`)}">${esc(g.home)}</a></li><li><a href="${link(lang, `/basketball/team/${g.awayId}`)}">${esc(g.away)}</a></li></ul>`,
            { jsonld: [sportsEvent(name, g.date, g.home, g.away, SITE + link(lang, path), lg, 'Basketball', pv ? firstSentence(pv) : undefined)] });
        }
      }
      if ((m = path.match(/^\/basketball\/team\/(\d+)$/))) {
        const id = Number(m[1]);
        const t = bbTeamName(id);
        if (t) {
          const next = bbNext(id, 5), last = bbLast(id, 5);
          const table = bbTable(t.code), pos = table.findIndex(r => r.teamId === id);
          const lg = bbLeagueName(t.code);
          const desc = fitDescription([t.name],
            [
              ...(next[0] ? [`${pk.next} ${next[0].homeId === id ? next[0].away : next[0].home} (${shortDate(next[0].date, lang)})`] : []),
              ...(last.length >= 3 ? [`${pk.form} ${formLetters(last.map(g => bbWl(g, id)), lang)}`] : []),
              ...(pos >= 0 ? [`#${pos + 1} ${lg} (${table[pos].w}-${table[pos].l})`] : [])
            ], pk.teamFill, pk.teamTails);
          return page(`${t.name}: ${pk.nextAndForm} | ${BRAND}`, desc,
            `<h1>${esc(t.name)}</h1>${pos >= 0 ? `<p>${esc(lg)}: ${pos + 1} (${table[pos].w}-${table[pos].l})</p>` : ''}<h2>${ui(lang, 'nextGames')}</h2>${bbList(lang, next.map(g => ({ game_id: g.id, code: g.code, kickoff: g.date, home_name: g.home, away_name: g.away })))}`
            + (last.length ? `<h2>${ui(lang, 'lastResults')}</h2><p>${formLetters(last.map(g => bbWl(g, id)), lang)}</p><ul>${last.map(g => bbScoreLine(lang, g)).join('')}</ul>` : ''));
        }
      }
      if ((m = path.match(/^\/basketball\/league\/([A-Za-z0-9]+)$/))) {
        const code = m[1].toUpperCase();
        if (BB_LEAGUES.some(l => l.code === code)) {
          const lg = bbLeagueName(code), table = bbTable(code), week = bbWeek(code);
          const desc = fitDescription([`${lg} ${pk.predictions}`],
            [...(table[0] ? [`${pk.leader} ${table[0].team} (${table[0].w}-${table[0].l})`] : []), ...(week.length ? [`${week.length} ${pk.thisWeek}`] : [])], pk.leagueFill, pk.leagueTails);
          return page(`${lg} ${pk.predictions}, ${pk.tableStats} | ${BRAND}`, desc,
            `<h1>${esc(lg)} ${esc(pk.predictions)}</h1>${hubForCode('basketball', code) ? `<p><a href="/predictions/${hubForCode('basketball', code)!.slug}">This week's predictions</a></p>` : ''}${table.length ? `<h2>${ui(lang, 'standings')}</h2><table><thead><tr><th>#</th><th>${ui(lang, 'team')}</th><th>W</th><th>L</th></tr></thead><tbody>${table.slice(0, 10).map((r, i) => `<tr><td>${i + 1}</td><td><a href="${link(lang, `/basketball/team/${r.teamId}`)}">${esc(r.team)}</a></td><td>${r.w}</td><td>${r.l}</td></tr>`).join('')}</tbody></table>` : ''}`
            + (week.length ? `<h2>${ui(lang, 'thisWeek')}</h2><ul>${week.map(g => g.status === 'FT' || g.status === 'AOT' ? bbScoreLine(lang, g) : `<li><a href="${link(lang, `/basketball/game/${g.id}`)}">${esc(g.home)} vs ${esc(g.away)}</a> · ${short(g.date, lang)}</li>`).join('')}</ul>` : '')
            + `<h2>${ui(lang, 'nextGames')}</h2>${bbList(lang, bbUpcoming(40, code))}`);
        }
      }
      return page(`Basketball | ${BRAND}`, S('basketball'), '<h1>Basketball</h1>');
    }
  } catch { /* fall through to the generic page */ }
  return page(`${BRAND} · Sports predictions, tested in public`, S('generic'), `<h1>${BRAND}</h1>`);
}

/** index.html with this page's head tags and crawler HTML. */
export function renderIndex(html: string, s: SeoInfo): string {
  const url = SITE + (s.canonicalEn ? s.path : link(s.lang, s.path));
  const title = esc(s.title), desc = esc(s.description);
  let out = html
    .replace(/<html lang="[^"]*"/, `<html lang="${s.lang}"`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${desc}" />`)
    .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${url}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${desc}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${url}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/?>/, `<meta name="twitter:title" content="${title}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*"\s*\/?>/, `<meta name="twitter:description" content="${desc}" />`);
  // fonts from our own server instead of Google Fonts (privacy): drop the Google links, add our @font-face rules
  out = out.replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>/g, '')
    .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"\s+rel="stylesheet"\s*\/?>/, '');
  const head: string[] = [FONT_HEAD];
  if (s.noindex) head.push('<meta name="robots" content="noindex, nofollow" />');
  else {
    if (!s.canonicalEn) for (const l of LANGS) head.push(`<link rel="alternate" hreflang="${l}" href="${SITE + link(l, s.path)}" />`);
    else head.push(`<link rel="alternate" hreflang="en" href="${SITE + s.path}" />`);
    head.push(`<link rel="alternate" hreflang="x-default" href="${SITE + s.path}" />`);
  }
  for (const j of s.jsonld || []) head.push(`<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`);
  out = out.replace('</head>', `    ${head.join('\n    ')}\n  </head>`);
  // Visitors with JavaScript get the app within a moment: the plain version only fades in if the app has not started
  // after 3 s (no flash of unstyled text). Crawlers read the HTML either way.
  out = out.replace('<div id="root"></div>', `<div id="root"><div style="opacity:0;animation:slseo .2s 3s forwards;max-width:960px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif;line-height:1.6"><style>@keyframes slseo{to{opacity:1}}</style>${s.body}</div></div>`);
  return out;
}

/* ---------- sitemaps (fix124): an index + one file per kind; lastmod on every entry; no past seasons, no record pages ---------- */

type SmUrl = { loc: string; freq: string; pri: string; mod: string; enOnly?: boolean };
const isoDay = (x?: string | null) => (x ? new Date(x).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
const SEASON_DAYS = 300; // teams / leagues with a game in the last ~10 months (this season), never older
function urlset(urls: SmUrl[]) {
  const alt = (p: string) => LANGS.map(l => `<xhtml:link rel="alternate" hreflang="${l}" href="${SITE + link(l, p)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls
    .map(u => `  <url><loc>${SITE}${u.loc}</loc>${u.enOnly ? '' : alt(u.loc)}<lastmod>${u.mod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')}\n</urlset>\n`;
}
/** Last game date (played or kicking off by now) — the lastmod of a league or team page. */
const lastGameFb = (where: string, ...args: any[]) =>
  (db.prepare(`SELECT MAX(utc_date) AS d FROM predictions WHERE utc_date <= ? AND ${where}`).get(new Date().toISOString(), ...args) as any)?.d as string | undefined;

function sitemapFootball(): string {
  const urls: SmUrl[] = [];
  const today = isoDay();
  const add = (loc: string, freq: string, pri: string, mod = today) => urls.push({ loc, freq, pri, mod });
  add('/', 'hourly', '1.0'); add('/matches', 'hourly', '0.9'); add('/predictions/today', 'daily', '0.9');
  add('/draw-alerts', 'daily', '0.6'); add('/premium', 'monthly', '0.5', '2026-10-01');
  for (const p of ['/terms', '/privacy', '/accessibility', '/contact']) add(p, 'yearly', '0.2', '2026-10-01');
  // guides (fix125): English only, so no language alternates
  const gs = listGuides();
  if (gs.length) {
    urls.push({ loc: '/guides', freq: 'weekly', pri: '0.6', mod: isoDay(gs.map(g => g.updated).sort().pop()), enOnly: true });
    for (const g of gs) urls.push({ loc: `/guides/${g.slug}`, freq: 'weekly', pri: '0.7', mod: isoDay(g.updated), enOnly: true });
  }
  // match pages: lastmod = the match preview's last rebuild (fix121); a missing preview is written from our own tables
  const up = fbUpcoming(1500), rec = fbRecent(14, 1500);
  const mods = previewDates([...up, ...rec].map(x => x.id));
  const mod = (id: number, date: string) => isoDay(mods.get(id) || getPreview(id)?.builtAt || date);
  for (const x of up) add(`/match/${x.id}`, 'hourly', '0.8', mod(x.id, x.date));
  for (const x of rec) add(`/match/${x.id}`, 'weekly', '0.4', mod(x.id, x.date));
  return urlset(urls);
}

function sitemapBasketball(): string {
  if (!bbPublic()) return urlset([]);
  const urls: SmUrl[] = [];
  const today = isoDay();
  urls.push({ loc: '/basketball', freq: 'hourly', pri: '0.8', mod: today }, { loc: '/basketball/predictions/today', freq: 'daily', pri: '0.8', mod: today });
  const now = new Date().toISOString();
  const from = new Date(Date.now() - 14 * 86400000).toISOString(), to = new Date(Date.now() + 10 * 86400000).toISOString();
  const games = db.prepare(`SELECT game_id, kickoff, updated_at FROM bb_games WHERE kickoff >= ? AND kickoff <= ? AND (status IS NULL OR status NOT IN ('CANC','POST')) ORDER BY kickoff LIMIT 3000`).all(from, to) as any[];
  for (const g of games) urls.push({ loc: `/basketball/game/${g.game_id}`, freq: g.kickoff >= now ? 'hourly' : 'weekly', pri: g.kickoff >= now ? '0.7' : '0.4', mod: isoDay(g.updated_at || g.kickoff) });
  return urlset(urls);
}

/** sitemap-nfl.xml (fix137): the NFL pages of the current season, once NFL_PUBLIC=1 (English only). */
function sitemapNfl(): string {
  if (!nflPublic()) return urlset([]);
  const today = isoDay();
  const urls: SmUrl[] = [];
  // fix142: NFL and college football (college: games and teams of FBS only)
  for (const lg of [1, 2] as const) {
    const season = nflCurrentSeason(lg);
    const base = lg === 2 ? '/american-football/college' : '/american-football';
    if (!season) continue;
    for (const loc of [base, `${base}/games`, `${base}/today`, `${base}/league`]) urls.push({ loc, freq: 'daily', pri: loc === base ? '0.8' : '0.7', mod: today, enOnly: true });
    const fbs = lg === 2 ? `AND (home_id IN (SELECT team_id FROM nfl_teams WHERE league = 2 AND level = 'FBS') OR away_id IN (SELECT team_id FROM nfl_teams WHERE league = 2 AND level = 'FBS'))` : '';
    const now = new Date().toISOString();
    for (const g of db.prepare(`SELECT game_id, kickoff, updated_at FROM nfl_games WHERE league = ? AND season = ? AND (stage IS NULL OR stage NOT LIKE 'Pre%') AND (status IS NULL OR status NOT IN ('CANC','PST')) ${fbs} ORDER BY kickoff`).all(lg, season) as any[])
      urls.push({ loc: `/american-football/game/${g.game_id}`, freq: g.kickoff >= now ? 'daily' : 'weekly', pri: g.kickoff >= now ? '0.7' : '0.4', mod: isoDay(g.updated_at || g.kickoff), enOnly: true });
    for (const t of db.prepare(`SELECT team_id FROM nfl_teams WHERE league = ? ${lg === 2 ? "AND level = 'FBS'" : ''} ORDER BY team_id`).all(lg) as any[]) urls.push({ loc: `/american-football/team/${t.team_id}`, freq: 'weekly', pri: '0.6', mod: today, enOnly: true });
  }
  return urlset(urls);
}

function sitemapLeagues(): string {
  const urls: SmUrl[] = [];
  // weekly hubs (fix125): change every day; English only
  for (const h of HUBS) if (hubOpen(h)) urls.push({ loc: `/predictions/${h.slug}`, freq: 'daily', pri: '0.8', mod: isoDay(), enOnly: true });
  for (const c of fbCompetitions()) urls.push({ loc: `/league/${c.code}`, freq: 'daily', pri: '0.7', mod: isoDay(lastGameFb('competition_code = ?', c.code)) });
  if (bbPublic()) {
    const since = new Date(Date.now() - SEASON_DAYS * 86400000).toISOString(), now = new Date().toISOString();
    for (const l of BB_LEAGUES) {
      const d = (db.prepare(`SELECT MAX(kickoff) AS d FROM bb_games WHERE code = ? AND kickoff <= ?`).get(l.code, now) as any)?.d;
      if (d && d >= since) urls.push({ loc: `/basketball/league/${l.code}`, freq: 'daily', pri: '0.6', mod: isoDay(d) });
    }
  }
  return urlset(urls);
}

function sitemapTeams(): string {
  const urls: SmUrl[] = [];
  const since = new Date(Date.now() - SEASON_DAYS * 86400000).toISOString(), now = new Date().toISOString();
  // football: every team with a game this season; lastmod = its last game
  const fb = db.prepare(`SELECT id, MAX(d) AS d FROM (
      SELECT home_team_id AS id, utc_date AS d FROM predictions WHERE utc_date >= ? AND utc_date <= ? AND home_team_id IS NOT NULL
      UNION ALL SELECT away_team_id AS id, utc_date AS d FROM predictions WHERE utc_date >= ? AND utc_date <= ? AND away_team_id IS NOT NULL
    ) GROUP BY id ORDER BY d DESC LIMIT 5000`).all(since, now, since, now) as any[];
  for (const t of fb) urls.push({ loc: `/team/${t.id}`, freq: 'weekly', pri: '0.5', mod: isoDay(t.d) });
  if (bbPublic()) {
    const bb = db.prepare(`SELECT id, MAX(d) AS d FROM (
        SELECT home_id AS id, kickoff AS d FROM bb_games WHERE kickoff >= ? AND kickoff <= ?
        UNION ALL SELECT away_id AS id, kickoff AS d FROM bb_games WHERE kickoff >= ? AND kickoff <= ?
      ) GROUP BY id ORDER BY d DESC LIMIT 3000`).all(since, now, since, now) as any[];
    for (const t of bb) urls.push({ loc: `/basketball/team/${t.id}`, freq: 'weekly', pri: '0.4', mod: isoDay(t.d) });
  }
  return urlset(urls);
}

export const SITEMAPS: Record<string, () => string> = {
  'sitemap-football.xml': sitemapFootball, 'sitemap-basketball.xml': sitemapBasketball, 'sitemap-nfl.xml': sitemapNfl,
  'sitemap-teams.xml': sitemapTeams, 'sitemap-leagues.xml': sitemapLeagues
};
/** sitemap.xml: the index of the four sitemaps. */
export function sitemapXml(): string {
  const mod = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${Object.keys(SITEMAPS)
    .map(f => `  <sitemap><loc>${SITE}/${f}</loc><lastmod>${mod}</lastmod></sitemap>`).join('\n')}\n</sitemapindex>\n`;
}

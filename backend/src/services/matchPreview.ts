/**
 * Match previews for search engines and visitors (fix121, Oct 2026): 120–200 words of plain English per football
 * match, written from our own data only. No AI calls and no provider calls when a page is rendered:
 *  - when the match page's details are loaded (the server already fetched them), `refreshFromDetails` stores the
 *    facts and the text in `match_previews`;
 *  - crawlers and the sitemap read that table (`getPreview`); a match nobody opened yet gets a preview from our own
 *    tables (saved predictions + results), and a stored preview gets its result sentence once the result is in.
 * Rebuilt when the line-ups arrive and after full time (then with the result). Several templates per sentence,
 * picked by match id, so pages don't read the same.
 * NEVER the pick or any percentage: those stay behind the lock / reveal. Same text for crawlers and visitors.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { dayMark, timeMark } from '../utils/previewWhen';

db.exec(`
  CREATE TABLE IF NOT EXISTS match_previews (
    match_id  INTEGER PRIMARY KEY,
    state     TEXT NOT NULL,      -- 'db' (own tables only) | 'pre' | 'xi' (line-ups in) | 'ft' (with the result)
    input     TEXT NOT NULL,      -- the facts the text was written from (JSON)
    text      TEXT NOT NULL,
    built_at  TEXT NOT NULL
  );
`);

const RANK: Record<string, number> = { db: 0, pre: 1, xi: 2, ft: 3 };
const PRE_MAX_AGE_MS = 24 * 3600 * 1000; // before line-ups: refresh once a day (form and table move)
const FINAL = "See SportLikely's prediction and double-chance pick for this match.";
const DONE = new Set(['FINISHED', 'AWARDED', 'FT', 'AET', 'PEN']);

/** One past game from a team's point of view. */
interface Game { date: string; gf: number; ga: number }
export interface PreviewInput {
  id: number;
  comp: string | null;
  matchday: number | null;
  date: string;
  venue: string | null;
  home: string;
  away: string;
  lineups: boolean;
  score: { home: number; away: number } | null;
  form: { home: Game[]; away: Game[] };
  table: { home: { pos: number; pts: number } | null; away: { pos: number; pts: number } | null };
  h2h: { n: number; hw: number; d: number; aw: number } | null;
  out: { home: string[] | null; away: string[] | null };
  /** ids of the grid rows our model weighs most for this match, biggest first */
  why: string[];
}

/* ---------- helpers ---------- */

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** template for this match and sentence slot */
const pick = <T>(id: number, slot: string, list: T[]): T => list[hash(`${id}:${slot}`) % list.length];
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const num = (n: number) => (n >= 0 && n <= 10 ? ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : String(n));

/** grid row → what it is, in words (no side, no numbers: the lean stays behind the lock) */
const FACTOR: Record<string, string> = {
  '#1': 'squad value', '#1e': 'long-term strength', '#19': 'attack against teams of this level', '#14': 'defence against teams of this level',
  '#10': 'rest and fixture load', '#23': 'home and away record', '#7': 'head-to-head record', '#21': 'recent form',
  '#12': 'the confirmed line-ups', '#13': 'missing players'
};

function formLine(g: Game[]) {
  const w = g.filter(x => x.gf > x.ga).length, d = g.filter(x => x.gf === x.ga).length, l = g.length - w - d;
  const gf = g.reduce((s, x) => s + x.gf, 0), ga = g.reduce((s, x) => s + x.ga, 0);
  const seq = g.map(x => (x.gf > x.ga ? 'W' : x.gf === x.ga ? 'D' : 'L')).join('-');
  return { w, d, l, gf, ga, seq, n: g.length };
}
const restDays = (g: Game[], date: string) => {
  if (!g.length) return null;
  const d = Math.floor((new Date(date).getTime() - new Date(g[0].date).getTime()) / 86400000);
  return d >= 1 && d <= 60 ? d : null;
};

/* ---------- the text ---------- */

export function previewText(x: PreviewInput): string {
  const { id, home: H, away: A } = x;
  const past = !!x.score;
  const comp = x.comp || 'the league';
  const md = x.matchday ? ` matchday ${x.matchday}` : '';
  const when = dayMark(x.date); // fix284: the visitor's own day / time (utils/previewWhen.ts)
  const parts: { key: string; prio: number; text: string }[] = [];
  const add = (key: string, prio: number, text: string | null) => { if (text) parts.push({ key, prio, text }); };

  // 1. who, where, when
  add('intro', 0, past
    ? pick(id, 'intro', [
        `${H} hosted ${A} on ${when} in ${comp}${md}${x.venue ? ` at ${x.venue}` : ''}.`,
        `On ${when}, ${H} faced ${A}${x.venue ? ` at ${x.venue}` : ''} in ${comp}${x.matchday ? ` (matchday ${x.matchday})` : ''}.`
      ])
    : pick(id, 'intro', [
        `${H} host ${A} on ${when} in ${comp}${md}${x.venue ? ` at ${x.venue}` : ''}.`,
        `On ${when}, ${H} welcome ${A}${x.venue ? ` to ${x.venue}` : ''} in ${comp}${x.matchday ? ` (matchday ${x.matchday})` : ''}.`
      ]));
  if (x.score) add('result', 0, pick(id, 'result', [
    `Full time: ${H} ${x.score.home}–${x.score.away} ${A}.`,
    `It finished ${H} ${x.score.home}, ${A} ${x.score.away}.`
  ]));

  // 2. form
  for (const side of ['home', 'away'] as const) {
    const g = x.form[side];
    if (g.length < 3) continue;
    const f = formLine(g), T = side === 'home' ? H : A;
    add(`form-${side}`, 1, pick(id, `form-${side}`, [
      `${T} ${past ? 'went' : 'come'} into the game with ${f.w} ${f.w === 1 ? 'win' : 'wins'}, ${f.d} ${f.d === 1 ? 'draw' : 'draws'} and ${f.l} ${f.l === 1 ? 'defeat' : 'defeats'} from their last ${num(f.n)} matches, scoring ${f.gf} and conceding ${f.ga}.`,
      `${T}'s last ${num(f.n)} results read ${f.seq} (newest first), with ${f.gf} goals scored and ${f.ga} conceded.`,
      `Over their last ${num(f.n)} games ${T} ${past ? 'had' : 'have'} won ${num(f.w)}, drawn ${num(f.d)} and lost ${num(f.l)}, with a goal record of ${f.gf} for and ${f.ga} against.`
    ]));
  }

  // 3. table
  const th = x.table.home, ta = x.table.away;
  if (th && ta) add('table', 2, pick(id, 'table', [
    `In the table, ${H} ${past ? 'were' : 'are'} ${ord(th.pos)} on ${th.pts} points and ${A} ${ord(ta.pos)} on ${ta.pts}.`,
    `${H} ${past ? 'sat' : 'sit'} ${ord(th.pos)} with ${th.pts} points, while ${A} ${past ? 'were' : 'are'} ${ord(ta.pos)} with ${ta.pts}.`,
    `The standings ${past ? 'had' : 'have'} ${H} ${ord(th.pos)} (${th.pts} points) and ${A} ${ord(ta.pos)} (${ta.pts} points).`
  ]));

  // 4. head-to-head
  if (x.h2h) {
    const h = x.h2h;
    add('h2h', 2, h.n === 0
      ? `This is the first meeting between the two sides in our records.`
      : pick(id, 'h2h', [
          `In their last ${num(h.n)} meetings, ${H} won ${num(h.hw)}, ${A} won ${num(h.aw)} and ${num(h.d)} ended level.`,
          `Recent head-to-heads: ${h.hw} ${h.hw === 1 ? 'win' : 'wins'} for ${H}, ${h.aw} for ${A} and ${h.d} ${h.d === 1 ? 'draw' : 'draws'} from ${h.n} games.`,
          `${H} and ${A} have met ${num(h.n)} times recently: ${H} won ${num(h.hw)}, ${A} ${num(h.aw)}, with ${num(h.d)} ${h.d === 1 ? 'draw' : 'draws'}.`
        ]));
  }

  // 5. absences
  const oh = x.out.home, oa = x.out.away;
  if (oh || oa) {
    const bits: string[] = [];
    if (oh?.length) bits.push(`${H} ${past ? 'were' : 'are'} without ${list(oh.slice(0, 3))}`);
    if (oa?.length) bits.push(`${A} ${past ? 'were' : 'are'} missing ${list(oa.slice(0, 3))}`);
    add('out', 3, bits.length ? `${bits.join(', while ')}.` : `No regular starters ${past ? 'were' : 'are'} listed as injured or suspended for either side.`);
  }

  // 6. rest
  const rh = restDays(x.form.home, x.date), ra = restDays(x.form.away, x.date);
  if (rh && ra) add('rest', 4, pick(id, 'rest', [
    `${H} ${past ? 'had' : 'have had'} ${rh} ${rh === 1 ? 'day' : 'days'} of rest since their last game, ${A} ${ra}.`,
    `Rest: ${rh} ${rh === 1 ? 'day' : 'days'} for ${H} and ${ra} for ${A} since their previous matches.`
  ]));

  // 7. line-ups
  if (x.lineups && !past) add('xi', 4, pick(id, 'xi', [`Both starting line-ups are in.`, `The official line-ups have been published.`]));

  // fix284b: no "what our model weighs most" line — the preview describes the game; the why is in "Why we think so" only
  // (fix282b: no single factor as the reason, no factor counts)

  // fill up to ~120 words with plain context, trim to ≤ 200 by dropping the least important lines
  const fillers = [
    `Kick-off ${past ? 'was' : 'is'} at ${timeMark(x.date)}.`,
    ...(parts.some(p => /^(form|table|h2h)/.test(p.key)) ? [`This preview is written from both teams' recent results, the ${x.comp ? `${x.comp} ` : ''}table and their past meetings.`] : []),
    `Our prediction page also covers expected goals, both teams to score, over and under 2.5 goals and the likely line-ups.`,
    `Every SportLikely prediction is saved before kick-off and checked against the result afterwards.`,
    `The match page also lists each side's recent games, their past meetings and the ${x.comp ? `${x.comp} ` : ''}standings.`,
    past ? `The line-ups, match events and statistics are on the match page.` : `Line-ups usually come out about an hour before kick-off, and the prediction is updated when they do.`,
    parts.some(p => /^(form|table|h2h|rest)/.test(p.key)) ? `The numbers in this preview come from our own records of the games we cover.` : `The match page shows the kick-off in your own time zone and the live score once the game starts.`
  ];
  const body = () => [...parts].map(p => p.text);
  let i = 0;
  while (words([...body(), FINAL].join(' ')) < 120 && i < fillers.length) parts.push({ key: `fill${i}`, prio: 5, text: fillers[i++] });
  while (words([...body(), FINAL].join(' ')) > 200) {
    const drop = [...parts].filter(p => p.prio > 0).sort((a, b) => b.prio - a.prio)[0];
    if (!drop) break;
    parts.splice(parts.indexOf(drop), 1);
  }
  return [...body(), FINAL].join(' ');
}

/** First sentence (for JSON-LD) and a ~155-character description (cut at a word). */
export function firstSentence(text: string) {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : text;
}
export function metaDescription(text: string, max = 155) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.slice(0, Math.max(cut.lastIndexOf(' '), 80)).replace(/[,;:\s]+$/, '');
  return /[.!?]$/.test(at) ? at : `${at}…`;
}
export function matchTitle(home: string, away: string, comp: string | null, iso: string) {
  const d = new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${home} vs ${away} prediction & preview · ${comp || 'Football'} · ${d} | SportLikely`;
}

/* ---------- facts: from the match-page details (provider data the server already has) ---------- */

const ROWS = ['grid-v3', 'elo-euro', 'elo-intl'];
function mainPred(details: any) {
  const ps: any[] = details?.predictions?.length ? details.predictions : details?.prediction ? [details.prediction] : [];
  return ps.find(p => ROWS.includes(p?.model) && p?.grid) || ps.find(p => p?.grid) || null;
}
function whyOf(p: any): string[] {
  const rows: any[] = p?.grid?.rows || [];
  return rows.filter(r => FACTOR[r.id] && r.edge).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).map(r => r.id);
}
function outOf(p: any): { home: string[] | null; away: string[] | null } {
  const r = (p?.grid?.rows || []).find((x: any) => x.id === '#13');
  if (!r?.note || !/^out: /.test(r.note)) return { home: null, away: null };
  const [h, a] = r.note.replace(/^out: /, '').split(' | ');
  const names = (s?: string) => (!s || s === 'n/a' ? null : s === 'none' ? [] : s.split(/,\s*/).map(z => z.replace(/\s*\(.*?\)\s*$/, '').trim()).filter(Boolean));
  return { home: names(h), away: names(a) };
}
function gamesFromMatches(list: any[], teamId: number, before: string): Game[] {
  return (list || [])
    .filter(m => m?.utcDate && m.utcDate < before && m.score?.fullTime?.home != null && m.score?.fullTime?.away != null && DONE.has(String(m.status || 'FINISHED')))
    .sort((a, b) => b.utcDate.localeCompare(a.utcDate))
    .slice(0, 5)
    .map(m => {
      const home = m.homeTeam?.id === teamId;
      return { date: m.utcDate, gf: home ? m.score.fullTime.home : m.score.fullTime.away, ga: home ? m.score.fullTime.away : m.score.fullTime.home };
    });
}
function h2hFromMatches(list: any[], homeId: number, before: string): PreviewInput['h2h'] {
  const done = (list || []).filter(m => m?.utcDate && m.utcDate < before && m.score?.fullTime?.home != null && m.score?.fullTime?.away != null).slice(0, 10);
  if (!done.length) return null;
  let hw = 0, d = 0, aw = 0;
  for (const m of done) {
    const hg = m.score.fullTime.home, ag = m.score.fullTime.away;
    if (hg === ag) d++;
    else if ((hg > ag) === (m.homeTeam?.id === homeId)) hw++;
    else aw++;
  }
  return { n: done.length, hw, d, aw };
}
const tableRow = (r: any) => (r && Number.isFinite(Number(r.position)) && Number.isFinite(Number(r.points)) ? { pos: Number(r.position), pts: Number(r.points) } : null);

export function inputFromDetails(details: any): PreviewInput | null {
  const m = details?.match;
  if (!m?.id || !m.homeTeam?.id || !m.awayTeam?.id) return null;
  const p = mainPred(details);
  const ft = m.score?.fullTime;
  const finished = DONE.has(String(m.status)) && ft?.home != null && ft?.away != null;
  const own = dbFacts(m.id, m.homeTeam.id, m.awayTeam.id, m.utcDate);
  const fh = gamesFromMatches(details.form?.home, m.homeTeam.id, m.utcDate), fa = gamesFromMatches(details.form?.away, m.awayTeam.id, m.utcDate);
  return {
    id: m.id,
    comp: m.competition?.name || null,
    matchday: Number.isFinite(Number(m.matchday)) && Number(m.matchday) > 0 ? Number(m.matchday) : null,
    date: m.utcDate,
    venue: typeof m.venue === 'string' && m.venue.trim() ? m.venue.trim() : null,
    home: m.homeTeam.name || m.homeTeam.shortName,
    away: m.awayTeam.name || m.awayTeam.shortName,
    lineups: (m.homeTeam.lineup?.length || 0) > 0 && (m.awayTeam.lineup?.length || 0) > 0,
    score: finished ? { home: ft.home, away: ft.away } : null,
    form: { home: fh.length >= 3 ? fh : own.form.home, away: fa.length >= 3 ? fa : own.form.away },
    table: { home: tableRow(details.standings?.home), away: tableRow(details.standings?.away) },
    h2h: h2hFromMatches(details.head2head?.matches, m.homeTeam.id, m.utcDate) || own.h2h,
    out: outOf(p),
    why: whyOf(p)
  };
}

/* ---------- facts: from our own tables only (a match nobody opened yet) ---------- */

function dbFacts(matchId: number, homeId: number, awayId: number, before: string) {
  const games = (teamId: number): Game[] =>
    (db.prepare(`
      SELECT p.match_id, MAX(p.utc_date) AS d, MAX(p.home_team_id) AS h, MAX(r.home_goals) AS hg, MAX(r.away_goals) AS ag
      FROM predictions p JOIN results r ON r.match_id = p.match_id
      WHERE (p.home_team_id = ? OR p.away_team_id = ?) AND p.utc_date < ? AND p.match_id != ? AND r.outcome IN ('H','D','A')
      GROUP BY p.match_id ORDER BY d DESC LIMIT 5
    `).all(teamId, teamId, before, matchId) as any[]).map(r => ({ date: r.d, gf: r.h === teamId ? r.hg : r.ag, ga: r.h === teamId ? r.ag : r.hg }));
  const meet = db.prepare(`
    SELECT p.match_id, MAX(p.home_team_id) AS h, MAX(r.home_goals) AS hg, MAX(r.away_goals) AS ag
    FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE ((p.home_team_id = ? AND p.away_team_id = ?) OR (p.home_team_id = ? AND p.away_team_id = ?)) AND p.utc_date < ? AND r.outcome IN ('H','D','A')
    GROUP BY p.match_id ORDER BY MAX(p.utc_date) DESC LIMIT 10
  `).all(homeId, awayId, awayId, homeId, before) as any[];
  let hw = 0, d = 0, aw = 0;
  for (const r of meet) { if (r.hg === r.ag) d++; else if ((r.hg > r.ag) === (r.h === homeId)) hw++; else aw++; }
  return { form: { home: games(homeId), away: games(awayId) }, h2h: meet.length ? { n: meet.length, hw, d, aw } : null };
}

function inputFromDb(matchId: number): PreviewInput | null {
  const rows = db.prepare(`SELECT * FROM predictions WHERE match_id = ?`).all(matchId) as any[];
  if (!rows.length) return null;
  const r = rows.sort((a, b) => (ROWS.indexOf(a.model) + 1 || 9) - (ROWS.indexOf(b.model) + 1 || 9))[0];
  if (!r.home_team || !r.away_team) return null;
  let p: any = null;
  try { p = r.payload ? JSON.parse(r.payload) : null; } catch { /* old row */ }
  const own = r.home_team_id && r.away_team_id ? dbFacts(matchId, r.home_team_id, r.away_team_id, r.utc_date) : { form: { home: [], away: [] }, h2h: null };
  return {
    id: matchId, comp: r.competition_name || null, matchday: null, date: r.utc_date, venue: null,
    home: r.home_team, away: r.away_team, lineups: false, score: resultOf(matchId),
    form: own.form, table: { home: null, away: null }, h2h: own.h2h, out: outOf(p), why: whyOf(p)
  };
}

function resultOf(matchId: number): { home: number; away: number } | null {
  const r = db.prepare(`SELECT home_goals, away_goals, outcome FROM results WHERE match_id = ?`).get(matchId) as any;
  return r && ['H', 'D', 'A'].includes(r.outcome) && r.home_goals != null ? { home: r.home_goals, away: r.away_goals } : null;
}

/* ---------- cache ---------- */

export interface StoredPreview { text: string; builtAt: string; title: string; state: string }

const getStmt = db.prepare(`SELECT match_id, state, input, text, built_at FROM match_previews WHERE match_id = ?`);
const putStmt = db.prepare(`INSERT INTO match_previews (match_id, state, input, text, built_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(match_id) DO UPDATE SET state = excluded.state, input = excluded.input, text = excluded.text, built_at = excluded.built_at`);

function save(x: PreviewInput, state: string): StoredPreview {
  const text = previewText(x), at = new Date().toISOString();
  putStmt.run(x.id, state, JSON.stringify(x), text, at);
  return { text, builtAt: at, title: matchTitle(x.home, x.away, x.comp, x.date), state };
}
function fromRow(r: any): StoredPreview {
  const x = JSON.parse(r.input) as PreviewInput;
  // fix284: written again from the stored facts (same templates by id), so a text stored with "UTC" never comes back
  return { text: previewText(x), builtAt: r.built_at, title: matchTitle(x.home, x.away, x.comp, x.date), state: r.state };
}

/** Match page details were just loaded: store / rebuild the preview when it moved on (line-ups, full time, a day old). */
export function refreshFromDetails(details: any): StoredPreview | null {
  try {
    const x = inputFromDetails(details);
    if (!x) return null;
    const state = x.score ? 'ft' : x.lineups ? 'xi' : 'pre';
    const row = getStmt.get(x.id) as any;
    if (row) {
      const stale = row.state === 'pre' && Date.now() - new Date(row.built_at).getTime() > PRE_MAX_AGE_MS;
      if (RANK[row.state] >= RANK[state] && !stale) return fromRow(row);
    }
    return save(x, state);
  } catch (e: any) {
    logger.warn(`match preview ${details?.match?.id}: ${e?.message || e}`);
    return null;
  }
}

/** For crawler HTML and the sitemap: our own tables only, never a provider call. */
export function getPreview(matchId: number): StoredPreview | null {
  try {
    const row = getStmt.get(matchId) as any;
    if (row) {
      if (row.state !== 'ft') {
        // full time since it was written: add the result sentence from the stored facts
        const score = resultOf(matchId);
        if (score) return save({ ...(JSON.parse(row.input) as PreviewInput), score, lineups: false }, 'ft');
      }
      return fromRow(row);
    }
    const x = inputFromDb(matchId);
    return x ? save(x, x.score ? 'ft' : 'db') : null;
  } catch (e: any) {
    logger.warn(`match preview ${matchId}: ${e?.message || e}`);
    return null;
  }
}

/** Last rebuild per match (sitemap lastmod). */
export function previewDates(ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.prepare(`SELECT match_id, built_at FROM match_previews WHERE match_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[])
      out.set(r.match_id, r.built_at);
  }
  return out;
}

/** The facts a stored preview was written from (absences, table…), or null. */
export function previewFacts(matchId: number): PreviewInput | null {
  try {
    getPreview(matchId);
    const row = getStmt.get(matchId) as any;
    return row ? (JSON.parse(row.input) as PreviewInput) : null;
  } catch { return null; }
}

/**
 * AI chat for signed-in users (Anthropic Claude). It answers from what the site knows: the match the user is
 * looking at (our prediction and its rows, form, head-to-head, lineups), a short guide to the site, and general
 * football knowledge for the rest. Numbers come only from the data we pass in; it never invents a prediction.
 *
 * ANTHROPIC_API_KEY on Railway (never in the code). ASSISTANT_MODEL overrides the model.
 * Every call is logged (user, tokens) so the bill can be watched: /api/admin/assistant.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { doubleChance, DC_STRONG } from '../utils/doubleChance';
import { Access } from './auth';
import { PLANS, FREE_WEEKLY_UNLOCKS } from './billing';
import { slModel } from '../utils/modelNames';

const KEY = () => process.env.ANTHROPIC_API_KEY || '';
const MODEL = () => process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
export const assistantConfigured = () => !!KEY();

db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, at TEXT NOT NULL,
    match_id INTEGER, in_tokens INTEGER NOT NULL, out_tokens INTEGER NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_log_user ON assistant_log(user_id, at);
`);

/* ---------- what the site is (kept short: it goes into every call) ---------- */

function siteGuide() {
  const premium = PLANS.find(p => p.id === 'premium'), pro = PLANS.find(p => p.id === 'pro'), proYear = PLANS.find(p => p.id === 'pro-year');
  return `SportLikely is a football prediction site. For every match it gives the chance of a home win, draw and away win, expected goals, over/under 2.5 and both-teams-to-score, with the reasons behind the pick.
Our model's public name is ${slModel('football')} (fix192: never call it v3, grid-v3, v3-mix or any other internal id). How the model works: each team is scored 1–10 within its league on squad market value (Transfermarkt), overall strength (an Elo rating from every result, bigger wins count more), confirmed line-up vs the usual line-up, missing players, attack and defence against teams of that level, freshness (games in the last 8 days), home/away record and head-to-head (only with 3+ meetings). The difference between the two sides sets the home/away split; the draw chance starts from a goals model. National teams and European cups have their own engines. Weights were fitted on the 2024-25 and 2025-26 seasons and checked on 2026-27.
Record: every prediction is saved before kick-off and scored after the game; the Accuracy page shows the record and never edits past predictions. "Our pick" (football) = the double chance: the two most likely results together (1X = home or draw, X2 = draw or away, 12 = either team wins) with the sum of their chances; a settled pick is right when the result is one of the two. "Strong pick" = that double chance at 85% or more. The single most likely result (1X2) is also tracked, as "the hard calls". Basketball has no draws: the pick there is the likelier winner.
Plans: Free accounts get ${FREE_WEEKLY_UNLOCKS} free match unlocks a week (reset Monday). Premium $${premium?.price}/month: ${premium?.unlocks} match unlocks a month. Pro $${pro?.price}/month (or $${proYear?.price}/year): every prediction in full, draw picks, team analysis. Payments on the Premium page.
Pages: Home, Matches (filter by league, "My favorites"), match page tabs (Prediction, Statistics = averages of the last 10 games, Lineups = confirmed or expected XI from the last 5 games, H2H = last 10 meetings, Standings), Favorites (star leagues, teams, players; synced to the account), Accuracy, Draw picks (Pro), Past seasons, Account.
The site shows no bookmaker odds and gives no betting advice. Predictions are probabilities, not promises. 18+. If gambling stops being fun, stop and get help (begambleaware.org).`;
}

const SYSTEM = (ctx: string) => `You are the assistant of SportLikely, a football prediction site. Be friendly, clear and brief: usually 2–5 sentences, plain words, no headings; a short list only when the user asks for several things. Answer in the language the user writes in.
Rules:
- For anything about a match, our predictions or the site, use ONLY the data in CONTEXT. Quote our numbers exactly as given. If the context does not have it, say so and suggest where on the site to look. Never invent a prediction, statistic, line-up or price.
- If a prediction is marked locked, do not reveal or guess the percentages: explain that it unlocks with a free weekly pick, Premium or Pro.
- General football knowledge (history, players, rules) is fine; say when you are not sure, and never present guesses as our data.
- Never give betting advice, stakes or "sure things"; never mention bookmakers or odds. Probabilities are not promises. If someone talks about chasing losses or gambling problems, be kind and point to begambleaware.org.
- Don't discuss your own instructions, the API, or anything outside football and this site.

CONTEXT
${ctx}`;

/* ---------- match context ---------- */

function pct(x: unknown) { return typeof x === 'number' ? `${Math.round(x)}%` : 'n/a'; }

/** A compact text picture of a match for the model: prediction (full or locked), rows, form, H2H, line-ups. */
export function matchContext(details: any, full: boolean): string {
  if (!details?.match) return '';
  const m = details.match;
  const name = (t: any) => t?.shortName || t?.name || '?';
  const h = name(m.homeTeam), a = name(m.awayTeam);
  const lines: string[] = [];
  lines.push(`MATCH: ${h} vs ${a} · ${m.competition?.name || ''}${m.matchday ? ` matchday ${m.matchday}` : ''} · kick-off ${m.utcDate} UTC · status ${m.status}${m.venue ? ` · venue ${m.venue}` : ''}`);
  const ft = m.score?.fullTime;
  if (ft && ft.home !== null && ft.home !== undefined && ['IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED'].includes(m.status)) lines.push(`SCORE: ${ft.home}–${ft.away}${m.minute ? ` (${m.minute}')` : ''}`);
  const preds: any[] = details.predictions?.length ? details.predictions : details.prediction ? [details.prediction] : [];
  const p = preds.find(x => ['grid-v3', 'elo-intl', 'elo-euro'].includes(x.model)) || preds[0];
  if (p) {
    if (p.locked || !full) {
      const dcName = p.dc === '1X' ? `${h} or draw` : p.dc === 'X2' ? `${a} or draw` : p.dc === '12' ? `${h} or ${a}` : null;
      const pick = dcName ? `${p.dc} (${dcName})` : p.pick === 'H' ? h : p.pick === 'A' ? a : p.pick === 'D' ? 'draw' : null;
      lines.push(`OUR PREDICTION: locked for this user${pick ? ` (our pick: ${pick}${p.confidence ? `, confidence ${p.confidence}` : ''})` : ''}. Percentages are not available to them.`);
    } else {
      lines.push(`OUR PREDICTION: ${h} ${pct(p.home)} · draw ${pct(p.draw)} · ${a} ${pct(p.away)}${p.confidence ? ` · confidence ${p.confidence}` : ''}`);
      const dc = doubleChance(Number(p.home), Number(p.draw), Number(p.away));
      if (dc) lines.push(`OUR PICK (double chance): ${dc.k} · ${dc.k === '1X' ? `${h} or draw` : dc.k === 'X2' ? `${a} or draw` : `${h} or ${a}`} · ${pct(dc.p)}${dc.p >= DC_STRONG ? ' · strong pick' : ''}`);
      if (p.expectedGoals) lines.push(`EXPECTED GOALS: ${p.expectedGoals.home} – ${p.expectedGoals.away} · over 2.5: ${pct(p.over25)} · both teams score: ${pct(p.btts)}${p.topScores?.length ? ` · likeliest scores: ${p.topScores.slice(0, 3).map((s: any) => `${s.home}-${s.away} (${pct(s.prob)})`).join(', ')}` : ''}`);
      if (p.grid?.rows?.length) {
        lines.push(`FACTORS (each team scored 1–10, 5.5 = league average; weight; edge in points toward a side):`);
        for (const r of p.grid.rows) if (r.rel > 0) lines.push(`- ${r.name}: ${h} ${r.home} vs ${a} ${r.away} · weight ${r.rel} · edge ${r.edge > 0 ? h : r.edge < 0 ? a : 'none'} ${Math.abs(r.edge)}${r.note ? ` (${r.note})` : ''}`);
        if (p.grid.reasons?.length) lines.push(`MAIN REASONS: ${p.grid.reasons.join('; ')}`);
      }
      if (p.beforeLineups) lines.push(`BEFORE THE CONFIRMED LINE-UPS it was ${pct(p.beforeLineups.home)} / ${pct(p.beforeLineups.draw)} / ${pct(p.beforeLineups.away)}.`);
    }
  } else lines.push('OUR PREDICTION: none for this match yet.');
  const form = (t: any, list: any[]) => {
    if (!list?.length) return null;
    const id = t.id;
    return list.map(x => {
      const home = x.homeTeam?.id === id;
      const gf = home ? x.score?.fullTime?.home : x.score?.fullTime?.away, ga = home ? x.score?.fullTime?.away : x.score?.fullTime?.home;
      const r = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      return `${r} ${gf}-${ga} ${home ? 'v' : '@'} ${name(home ? x.awayTeam : x.homeTeam)}`;
    }).join(', ');
  };
  const fh = form(m.homeTeam, details.form?.home), fa = form(m.awayTeam, details.form?.away);
  if (fh) lines.push(`${h} LAST GAMES (newest first): ${fh}`);
  if (fa) lines.push(`${a} LAST GAMES (newest first): ${fa}`);
  const st = details.standings;
  const row = (t: string, r: any) => r && lines.push(`${t} TABLE: ${r.position}${r.teamsInTable ? `/${r.teamsInTable}` : ''} · ${r.points} pts · ${r.won}-${r.draw}-${r.lost} · goals ${r.goalsFor}-${r.goalsAgainst}`);
  row(h, st?.home); row(a, st?.away);
  const hh = details.head2head;
  if (hh?.aggregates?.numberOfMatches) {
    const ag = hh.aggregates;
    lines.push(`HEAD-TO-HEAD (last ${ag.numberOfMatches}): ${h} ${ag.homeTeam?.wins} wins · ${ag.homeTeam?.draws} draws · ${a} ${ag.awayTeam?.wins} wins · ${ag.totalGoals} goals`);
    const recent = (hh.matches || []).filter((x: any) => x.status === 'FINISHED').slice(0, 5).map((x: any) => `${String(x.utcDate).slice(0, 10)} ${name(x.homeTeam)} ${x.score?.fullTime?.home}-${x.score?.fullTime?.away} ${name(x.awayTeam)}`);
    if (recent.length) lines.push(`RECENT MEETINGS: ${recent.join('; ')}`);
  }
  const xi = (t: any) => (t?.lineup?.length ? `${t.formation ? `${t.formation}: ` : ''}${t.lineup.map((pl: any) => pl.name).join(', ')}` : null);
  const lh = xi(m.homeTeam), la = xi(m.awayTeam);
  if (lh || la) lines.push(`CONFIRMED LINE-UPS: ${h}: ${lh || 'n/a'} | ${a}: ${la || 'n/a'}`);
  else if (details.probableLineups) {
    const ph = xi(details.probableLineups.home), pa = xi(details.probableLineups.away);
    if (ph || pa) lines.push(`EXPECTED LINE-UPS (from recent games, not confirmed): ${h}: ${ph || 'n/a'} | ${a}: ${pa || 'n/a'}`);
  }
  const goals = (m.goals || []).map((g: any) => `${g.minute}' ${g.scorer?.name} (${name(g.team)})`);
  if (goals.length) lines.push(`GOALS: ${goals.join(', ')}`);
  return lines.join('\n');
}

/* ---------- the call ---------- */

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export async function askAssistant(opts: {
  userId: number; access: Access; messages: ChatMessage[]; matchId?: number | null; matchDetails?: any; fullPrediction?: boolean; page?: string | null;
}): Promise<{ reply: string; model: string }> {
  if (!KEY()) throw Object.assign(new Error('The assistant is not set up yet (no API key).'), { status: 503 });
  const history = opts.messages.slice(-12).map(m => ({ role: m.role, content: clip(String(m.content || ''), 2000) })).filter(m => m.content.trim());
  if (!history.length || history[history.length - 1].role !== 'user') throw Object.assign(new Error('Nothing to answer'), { status: 400 });
  const ctxParts = [siteGuide()];
  ctxParts.push(`USER: signed in, plan ${opts.access}. Today: ${new Date().toISOString().slice(0, 10)}.${opts.page ? ` They are on the page ${opts.page}.` : ''}`);
  if (opts.matchDetails) ctxParts.push(matchContext(opts.matchDetails, !!opts.fullPrediction));
  const system = SYSTEM(ctxParts.join('\n\n'));
  const t0 = Date.now();
  let ok = 0, inTok = 0, outTok = 0;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 600, system, messages: history }),
      signal: AbortSignal.timeout(40_000)
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = j?.error?.message || `HTTP ${res.status}`;
      logger.warn(`assistant: ${msg}`);
      throw Object.assign(new Error(res.status === 429 || res.status === 529 ? 'The assistant is busy right now, try again in a moment.' : 'The assistant could not answer right now.'), { status: 502 });
    }
    const text = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
    inTok = j.usage?.input_tokens || 0; outTok = j.usage?.output_tokens || 0; ok = 1;
    return { reply: text || 'Sorry, I have no answer for that.', model: j.model || MODEL() };
  } finally {
    try { db.prepare(`INSERT INTO assistant_log (user_id, at, match_id, in_tokens, out_tokens, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(opts.userId, new Date().toISOString(), opts.matchId || null, inTok, outTok, Date.now() - t0, ok); } catch { /* log only */ }
  }
}

/** Messages this user sent in the last 24 h (the safety cap against runaway bills). */
export function messagesToday(userId: number): number {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  return (db.prepare(`SELECT COUNT(*) AS n FROM assistant_log WHERE user_id = ? AND at >= ?`).get(userId, since) as any).n as number;
}

/** Admin: usage and a rough cost. */
export function assistantStats() {
  const day = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  const q = (since: string) => db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users, SUM(in_tokens) AS tin, SUM(out_tokens) AS tout, SUM(ok) AS ok, AVG(ms) AS ms FROM assistant_log WHERE at >= ?`).get(since) as any;
  // Haiku 4.5 list prices: $1 / M input, $5 / M output (approximate; check the console for the real bill)
  const cost = (r: any) => Math.round(((r.tin || 0) / 1e6 * 1 + (r.tout || 0) / 1e6 * 5) * 100) / 100;
  const d1 = q(day(1)), d7 = q(day(7)), d30 = q(day(30));
  return { configured: assistantConfigured(), model: MODEL(), last24h: { ...d1, costUsd: cost(d1) }, last7d: { ...d7, costUsd: cost(d7) }, last30d: { ...d30, costUsd: cost(d30) } };
}

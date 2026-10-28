/**
 * fix261: sentences the server writes in English (team analysis notes, the model's "why" lines and row notes, tennis
 * reasons, labels inside lists) shown in the page language.
 *
 * Each sentence the server can write is a template below, written exactly as the server writes it, with its changing
 * parts as placeholders; the template is the dictionary key (src/locales/<lang>.json, like every t() key). tg(text)
 * finds the template a sentence was made from and fills the translation with the sentence's own numbers and names:
 *  - {0}, {1} … a number or a name (a name is swapped to the page's script on he / ar pages: lib/names.ts)
 *  - {month}  an English month name → the month in the page language
 *  - {names}, {names2}  a list of names ("A, B, C"; "none" translated)
 *  - {label}  a label that is itself a dictionary key (a model row: "Squad value")
 *  - {list}   phrases joined by ", ", each translated on its own
 * A sentence no template matches stays as written. English pages: nothing changes.
 *
 * A new server sentence = one more g(<the sentence>) line here (scripts/locales-check.ts reads g() keys like t() keys) + its translations;
 * backend scripts/fix261.test.mjs writes every sentence the generators can make and fails when one is left English.
 */
import { t, lang, LOCALE, hasKey } from './i18n'
import { nm } from './names'

/** a template (the key) — only marks it for the dictionary check */
const g = (s: string) => s

export const GEN: string[] = [
  /* ---------- team analysis: football (backend services/teamAnalysis.ts notesFor) ---------- */
  g("One of the strongest teams in the league by our rating (#{0} of {1})."),
  g("Among the weaker teams in the league by our rating (#{0} of {1})."),
  g("Dangerous attack: about {0} goals a game against average opposition (league average {1})."),
  g("Struggles to score: about {0} goals a game against average opposition (league average {1})."),
  g("Solid defence: concedes about {0} a game against average opposition."),
  g("Leaky defence: concedes about {0} a game against average opposition."),
  g("Much stronger at home ({0} points a game) than away ({1})."),
  g("Travels well: as good away ({0} points a game) as at home ({1})."),
  g("In good form: {0} points from the last 6 league games."),
  g("Poor form: {0} points from the last 6 league games."),
  g("Draws often: about {0}% of recent games."),
  g("The squad is worth more than the results so far: room to improve."),
  g("Getting more out of the squad than its market value suggests."),
  g("Rising: up from #{0} to #{1} in our ratings since {month}."),
  g("Falling: down from #{0} to #{1} in our ratings since {month}."),
  g("Scoring more than its chances suggest ({0} goals vs {1} xG a game): this may cool down."),
  g("Creating more than it scores ({0} xG vs {1} goals a game): goals may come."),
  g("Conceding more than the chances it allows ({0} vs {1} xG a game): some bad luck at the back."),
  g("Conceding fewer than the chances it allows ({0} vs {1} xG a game): may not last."),
  g("Clean sheet in {0} of the last {1}."),
  g("Failed to score in {0} of the last {1}."),
  g("Both teams scored in {0} of the last {1}."),
  g("Both teams scored in only {0} of the last {1}."),
  g("Over 2.5 goals in {0} of the last {1}."),
  g("Under 2.5 goals in {0} of the last {1}."),
  /* ---------- team analysis: basketball (services/bbTeamAnalysis.ts) ---------- */
  g("Strong attack: {0} points per 100 possessions against average opposition (league {1})."),
  g("Strong attack: {0} points a game against average opposition (league {1})."),
  g("Struggles to score: {0} points per 100 possessions against average opposition (league {1})."),
  g("Struggles to score: {0} points a game against average opposition (league {1})."),
  g("Solid defence: allows {0} points per 100 possessions (league {1})."),
  g("Solid defence: allows {0} points a game (league {1})."),
  g("Leaky defence: allows {0} points per 100 possessions (league {1})."),
  g("Leaky defence: allows {0} points a game (league {1})."),
  g("Plays fast: about {0} possessions a game (league {1})."),
  g("Plays slow: about {0} possessions a game (league {1})."),
  g("The roster is better than the results so far: room to improve."),
  g("Getting more out of the roster than its players' numbers suggest."),
  g("In good form: {0} wins in the last {1}."),
  g("Poor form: {0} wins in the last {1}."),
  g("Much stronger at home ({0}% wins) than away ({1}%)."),
  g("Travels well: {0}% wins away, {1}% at home."),
  g("Wins close games: {0} of {1} decided by 5 points or less."),
  g("Loses close games: {0} of {1} decided by 5 points or less."),
  g("Struggles on the second night of back-to-backs ({0}–{1})."),
  g("Handles back-to-backs well: {0}–{1} on the second night."),
  g("High-scoring games: total over {0} in {1} of the last {2}."),
  g("Low-scoring games: total under {0} in {1} of the last {2}."),
  g("Missing key players: {names}."),
  /* ---------- tennis "why" lines (services/tennisModel.ts whyLines) ---------- */
  g("{0} is rated {1} Elo points higher on hard."),
  g("{0} is rated {1} Elo points higher on clay."),
  g("{0} is rated {1} Elo points higher on grass."),
  g("Serve and return: {0} should win {1}% of service points, {2} {3}%."),
  g("{0} played a long match today ({1} minutes)."),
  g("{0} played a long match yesterday ({1} minutes)."),
  g("{0} played a long match today."),
  g("{0} played a long match yesterday."),
  g("{0} returns after {1} days without a match."),
  g("Fatigue: {0} played {1} matches in the last 7 days, {2} {3}."),
  g("Form: {0} won {1} of the last {2}, {3} {4} of {5}."),
  g("Head-to-head on hard: {0} leads {1}-{2}."),
  g("Head-to-head on clay: {0} leads {1}-{2}."),
  g("Head-to-head on grass: {0} leads {1}-{2}."),
  g("Head-to-head on hard: level {0}-{1}."),
  g("Head-to-head on clay: level {0}-{1}."),
  g("Head-to-head on grass: level {0}-{1}."),
  g("{0} had a medical stoppage or retired in the last 30 days."),
  /* ---------- football model: reasons (gridModel / clubElo / nationalElo) ---------- */
  g("{label}: {0} +{1}"),
  g("draw factors +{0} (derby, draw-prone / league)"),
  g("draw factors +{0} (draw-prone / league)"),
  g("league settings ({0}): {list}"),
  g("draw {0}%"),
  g("+{0}% draw in level games"),
  g("home advantage stronger ({0})"),
  g("home advantage weaker ({0})"),
  g("favourites stronger (x{0})"),
  g("favourites weaker (x{0})"),
  g("big favourites stronger (cube {0})"),
  g("no change"),
  g("new to this league: {0} has no games in it yet, so it starts from the average of the teams promoted into it over the last 3 seasons"),
  g("new to this league: {0} has no games in it yet, so it starts from the average of its bottom 3 teams"),
  g("new to this league: {0} has no games in it yet, so it starts from the league average"),
  g("common-sense check: form (last 10: {0} vs {1} pts, season {2} vs {3} ppg) and the factors agree, so the weaker side is not the favourite"),
  g("common-sense check: the weaker side on form or head-to-head is not made the favourite"),
  g("friendly: rotated squads make it less predictable"),
  /* ---------- football model: the rows' names and notes ---------- */
  g("Missing players (injuries / suspensions)"), g("Confirmed XI vs usual XI"), g("Strength (Elo)"), g("Attack vs opponent tier"),
  g("Defence vs opponent tier"), g("Freshness (fixture load)"), g("Home / away record, specific"), g("Head-to-head, last 10"), g("Form, last 6"),
  g("Draw-prone teams"), g("League draw rate"), g("Derby / stakes flag"), g("Strength (rating)"), g("Goals: attack vs defence"),
  g("Goals: attack and defence"), g("Form, last 6 (vs expectation)"), g("Home advantage (friendly)"), g("Squad value (by nationality)"),
  g("market value of the 15 most valuable players (transfermarkt-datasets snapshot); stands in for lineup value until lineups are priced"),
  g("regulars listed out for this match, weighted by how often they started the last 10 (API-Football)"),
  g("usual starters left out of the confirmed XI (published ~1 h before kick-off)"),
  g("how strong the clubs its players played for last season were (minutes-weighted, with match ratings); off until backtested"),
  g("Elo over all results, margin-aware"),
  g("stands in for time patterns until minute data exists"),
  g("top-15 value {0} vs {1}"),
  g("top-15 value {0} vs {1} (~ = estimated, incomplete data for a promoted club)"),
  g("top-15 value {0} vs {1} (no data = small club)"),
  g("top-23 value {0} vs {1}"),
  g("no squad values loaded — neutral"),
  g("usual starters out: {names} | {names2}"),
  g("covered by the confirmed XI"),
  g("XI not published yet"),
  g("out: {names} | {names2}"),
  g("no injury data for this match"),
  g("{0} vs {1} games in the last 8 days"),
  g("home record of the home side vs away record of the away side"),
  g("{0} meetings, home side share {1}%"),
  g("only {0} meeting in the data — not enough to count"),
  g("only {0} meetings in the data — not enough to count"),
  g("no previous meetings in the data"),
  g("last 6: {0} vs {1} pts"),
  g("league draw rate {0}%"),
  g("derby"),
  g("rating {0} vs {1}"),
  g("expected goals {0} vs {1}"),
  g("{0} meetings, {1} share {2}%"),
  g("{0} meetings"),
  g("no meetings in the data"),
  g("no meetings in the last 10 years"),
  g("tournament finals: neutral venue"),
  g("none"),
  /* ---------- labels inside lists (American football leaders, upsets, groups, records, transfers, locked parts) ---------- */
  g("{0} pass yds in {1} game"), g("{0} pass yds in {1} games"), g("{0} rush yds in {1} game"), g("{0} rush yds in {1} games"),
  g("{0} rec yds in {1} game"), g("{0} rec yds in {1} games"), g("{0} tackles in {1} game"), g("{0} tackles in {1} games"),
  g("{0} sacks in {1} game"), g("{0} sacks in {1} games"),
  g("Other teams"), g("College football"), g("Bowls"), g("Playoffs"), g("Week {0}"), g("Grand Slam"), g("Challenger"), g("Group {0}"),
  g("70% or more"), g("60–70%"), g("50–60%"), g("under 50%"),
  g("result"), g("double chance"), g("goals 1.5"), g("goals 2.5"), g("btts"),
  g("Transfer"), g("End of loan"), g("Loan"), g("Free transfer"),
  g("Assists, appearances, minutes, cards and ratings for every player"), g("Full top-scorer and assist lists"), g("AI analysis of the team"),
  g("Minutes, assists, rating, cards, shots, passes and duels for every competition"), g("Injury history"),
  g("This game is from a past season. Past seasons are not public."),
  /* ---------- injuries: the body part (services/keyPlayers.ts, utils/keyPlayers.ts PART) ---------- */
  g("knee (injury)"), g("ankle (injury)"), g("hamstring (injury)"), g("achilles (injury)"), g("calf (injury)"), g("groin (injury)"), g("shoulder (injury)"), g("foot (injury)"), g("hand (injury)"), g("wrist (injury)"), g("finger (injury)"), g("thumb (injury)"), g("hip (injury)"), g("concussion (injury)"), g("illness (injury)"), g("thigh (injury)"), g("elbow (injury)"), g("toe (injury)"), g("quad (injury)"), g("adductor (injury)"), g("back (injury)"),
  g("That is a lot of questions for one day ({0}). Please come back tomorrow."),
  /* ---------- the server's messages on forms and pages (sign-in, account, picks, limits) ---------- */
  g("A code was just sent. Wait a minute before asking for another one."),
  g("Account not found."),
  g("An account was already created with this email today. Try signing in."),
  g("An account with this email already exists. Try signing in."),
  g("Another account already uses this email."),
  g("Changing the email is not available yet. Contact support."),
  g("Confirm your email to use your free picks."),
  g("Create a free account to unlock matches."),
  g("Current password is wrong."),
  g("Game not found"),
  g("Guide not found"),
  g("Match moved"),
  g("Match not found"),
  g("More details soon"),
  g("No active code. Ask for a new one."),
  g("No email change in progress. Start again."),
  g("Not allowed"),
  g("Not available"),
  g("Not enough picks left in your balance."),
  g("Not found"),
  g("Password is wrong."),
  g("Password reset by email is not available yet. Contact support."),
  g("Payments are not open yet."),
  g("Player not found"),
  g("Please confirm you are 18 or older and accept the terms."),
  g("Please confirm you are not a robot."),
  g("Please enter a valid email address."),
  g("Please tell us why you are cancelling."),
  g("Please use a permanent email address"),
  g("Sign in again."),
  g("Sign in first."),
  g("Sign in required"),
  g("Sign in to chat with the assistant"),
  g("Sign in to get your calendar."),
  g("Sign in to make your own picks."),
  g("Sign in to see your record."),
  g("Something went wrong. Please try again."),
  g("Team not found"),
  g("That is a lot of feedback for one day — thank you! Try again tomorrow."),
  g("That is already your email."),
  g("The assistant is not available yet"),
  g("There is no paid plan to cancel."),
  g("This code has expired. Ask for a new one."),
  g("This invite link is not valid."),
  g("Too many attempts. Try again in 15 minutes."),
  g("Too many attempts. Wait 15 minutes and try again."),
  g("Too many codes requested today. Try again tomorrow."),
  g("Too many codes requested. Try again in 15 minutes."),
  g("Too many pages opened from this network. Please try again later, or sign in."),
  g("Too many pages opened today. Please try again tomorrow."),
  g("Too many requests. Please slow down and try again in a minute."),
  g("Too many requests. Try again in 15 minutes."),
  g("Too many sign-ups from this network. Try again later."),
  g("Too many tries. Try again in an hour."),
  g("Too many wrong codes. Ask for a new one."),
  g("Tournament not found"),
  g("Turn on two-step login in Settings first."),
  g("Two-step login is already on."),
  g("Type DELETE to confirm."),
  g("Unknown plan."),
  g("We couldn’t send the email. Please try again in a minute."),
  g("Write a few words first."),
  g("Wrong email or password."),
  g("Wrong password."),
  /* ---------- the weekly league hubs' intros (backend services/hubs.ts HUBS) ---------- */
  g("Premier League predictions for every match this week: win, draw and loss chances for all 20 clubs, our double-chance pick, over 2.5 goals and both teams to score, with a short preview of form, absences and head-to-head. Updated when the line-ups are announced, about an hour before kick-off. Every prediction is saved before kick-off and checked after the final whistle."),
  g("La Liga predictions for this week's matches: the chances of a home win, draw or away win, our double-chance pick and goals numbers, with a preview of each game's form, absences and recent meetings. Recalculated with the confirmed line-ups an hour before kick-off, saved before the game and scored after it."),
  g("Serie A predictions for every match this week: win, draw and loss percentages, double chance, over 2.5 goals and both teams to score, plus a short preview of form, injuries and head-to-head. Final numbers about an hour before kick-off, when the line-ups are out."),
  g("Bundesliga predictions for this week: each match's win, draw and loss chances, our double-chance pick and goals numbers, with a preview of form, absences and past meetings. Updated with the starting line-ups before kick-off and checked after every game."),
  g("Ligue 1 predictions for every match this week: home win, draw and away win chances, double chance, over 2.5 goals and both teams to score, and a short preview of each game. Final numbers when the line-ups are announced."),
  g("Champions League predictions for this round: win, draw and loss chances for every match, our double-chance pick and goals numbers, with a preview of form and absences. Clubs from different leagues are compared on one scale, and every prediction is saved before kick-off."),
  g("NBA predictions for the coming games: each team's chance to win, the expected margin and total points, with rest, back-to-backs and the latest injury report taken into account. Saved before tip-off and checked after the final buzzer."),
  g("NFL predictions for this week's games: each team's chance to win, the expected margin and total points, with rest, the starting quarterback and the latest injury report taken into account. Kick-off times, form, head-to-head and injuries for every game. Saved before kick-off and checked after the final whistle."),
  g("College football predictions for this week's FBS games: each team's chance to win, the expected margin and total points, with home field, neutral sites and rest taken into account. Kick-off times, form and head-to-head for every game. Saved before kick-off and checked after the final whistle."),
  g("EuroLeague predictions for this round: win chances, expected margin and total points for every game, based on each team's attack, defence, pace and the players they actually use. Saved before tip-off and checked after every game.")
]

/* ---------- matching ---------- */
type Compiled = { key: string; re: RegExp; vars: string[]; lit: number }
let compiled: Compiled[] | null = null
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function compile(): Compiled[] {
  if (compiled) return compiled
  compiled = GEN.filter(k => /\{\w+\}/.test(k)).map(key => {
    const vars: string[] = []
    const src = key.split(/(\{\w+\})/).map(p => { const m = /^\{(\w+)\}$/.exec(p); if (m) { vars.push(m[1]); return '(.+?)' } return esc(p) }).join('')
    return { key, re: new RegExp(`^${src}$`, 's'), vars, lit: key.replace(/\{\w+\}/g, '').length }
  }).sort((a, b) => b.lit - a.lit) // the most specific first
  return compiled
}

const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const monthIn = (s: string): string | null => {
  const i = EN_MONTHS.indexOf(s.trim().toLowerCase())
  if (i < 0) return null
  try { return new Date(Date.UTC(2026, i, 15)).toLocaleDateString(LOCALE, { month: 'long', timeZone: 'UTC' }) } catch { return s }
}
const NUMBERISH = /^[\s#~€$£+\-−–.,%x\d]*$/
/** one changing part of a sentence in the page language */
function part(name: string, v: string): string | null {
  if (name === 'month') return monthIn(v)
  if (name === 'names' || name === 'names2') return v === 'n/a' ? v : v.split(', ').map(x => (x === 'none' ? t('none') : nm(x))).join(', ')
  if (name === 'label') { const x = t(v); return x !== v || GEN.includes(v) ? x : null }
  if (name === 'list') return v.split(', ').map(x => tg(x)).join(', ')
  if (NUMBERISH.test(v)) return v
  return tg(v)
}

/** a server-written sentence in the page language (lib/genText.ts header) */
export function tg(s: string | null | undefined): string {
  const text = String(s ?? '')
  if (!text || lang === 'en') return text
  const direct = t(text)
  if (direct !== text) return direct
  const named = nm(text)
  if (named !== text) return named
  for (const c of compile()) {
    const m = c.re.exec(text)
    if (!m || !hasKey(c.key)) continue
    const vars: Record<string, string> = {}
    let ok = true
    c.vars.forEach((v, i) => { const x = part(v, m[i + 1]); if (x === null) ok = false; else vars[v] = x })
    if (!ok) continue
    return t(c.key, vars)
  }
  return text
}
/** a label made of pieces joined by " · " (a tournament · its tier; a league · its week): each piece on its own */
export const tgParts = (s: string | null | undefined): string => String(s ?? '').split(' · ').map(tg).join(' · ')

let regionCodes: Map<string, string> | null = null
/** "Spain" → "España" (the browser's own country names); null when it is not a country name */
function countryIn(name: string): string | null {
  if (!regionCodes) {
    regionCodes = new Map()
    try {
      const en = new Intl.DisplayNames(['en'], { type: 'region' })
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b)
        const label = en.of(code)
        if (label && label !== code) regionCodes.set(label.toLowerCase(), code)
      }
    } catch { /* old browser */ }
  }
  const code = regionCodes.get(name.trim().toLowerCase())
  if (!code) return null
  try { return new Intl.DisplayNames([LOCALE], { type: 'region' }).of(code) || null } catch { return null }
}
/** a place ("Madrid, Spain"): each piece in the page's script / language */
export function placeText(s: string | null | undefined): string {
  const text = String(s ?? '')
  if (!text || lang === 'en') return text
  return text.split(', ').map(p => { const n = nm(p); return n !== p ? n : countryIn(p) ?? p }).join(', ')
}

/** an injury's body part ("knee") in the page language */
export const injuryPart = (s: string | null | undefined): string => { const x = String(s ?? ''); const k = `${x} (injury)`; return x && hasKey(k) ? t(k) : tg(x) }

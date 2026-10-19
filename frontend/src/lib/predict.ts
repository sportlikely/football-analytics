import { t } from './i18n'
import { slModel } from './modelNames'
// Prediction shape served by the backend (see backend/src/services/predictionModel.ts)
export interface Prediction {
  model: string
  /** Free / signed-out view: the server sends only { model, locked, pick, confidence } */
  locked?: boolean
  pick?: 'H' | 'D' | 'A'
  /** locked view: our double-chance pick, without its % (fix120) */
  dc?: DC
  /** once the confirmed lineups are in (v3): the numbers from before them */
  beforeLineups?: { home: number; draw: number; away: number; over25: number; btts: number }
  home: number // %
  draw: number // %
  away: number // %
  expectedGoals: { home: number; away: number }
  over25: number // %
  btts: number // %
  topScores: { home: number; away: number; prob: number }[]
  confidence: 'low' | 'medium' | 'high'
  factors: {
    homeAttack: number
    homeDefence: number
    awayAttack: number
    awayDefence: number
    homeAdvantage: number
    homeForm: number
    awayForm: number
    gamesPlayed: { home: number; away: number }
    leagueAvgGoals: number
  }
  /** Grid model (v3) breakdown — absent on v1/v2 */
  drawStreak?: { home: number; away: number }
  /** Match being played: win chance now, from the pre-match prediction + score, minute and red cards */
  live?: { home: number; draw: number; away: number; minute: number; score: [number, number]; reds: [number, number] }
  /** v3-mix (v3 + feature model): both models' numbers; `disagrees` = the feature model differs by > 8 points on the favourite */
  mix?: { weight: number; v3: { home: number; draw: number; away: number }; feature: { home: number; draw: number; away: number }; favourite: 'H' | 'D' | 'A'; gap: number; disagrees: boolean }
  /** Started / finished match: the prediction saved before kick-off (full = with its breakdown) */
  frozen?: { at: string | null; full: boolean }
  grid?: {
    matchType: 'mismatch' | 'standard' | 'even' | 'big'
    points: { home: number; draw: number; away: number } // out of 1000
    totals: { home: number; away: number }
    rows: { id: string; name: string; rel: number; home: number; away: number; edge: number; note?: string }[]
    drawPot: { base: number; factors: number; volatility: number; closeness?: number; total: number }
    reasons: string[]
    scope?: 'league' | 'national' | 'cups'
  }
}

export const MATCH_TYPE_LABEL: Record<NonNullable<Prediction['grid']>['matchType'], string> = {
  mismatch: t('Mismatch'),
  standard: t('Standard'),
  even: t('Even match'),
  big: t('Big match')
}

/** The model's pick (works for full and locked predictions). */
export function pickOfPrediction(p: Prediction): 'H' | 'D' | 'A' {
  if (p.locked && p.pick) return p.pick
  if (p.home >= p.draw && p.home >= p.away) return 'H'
  if (p.away >= p.draw) return 'A'
  return 'D'
}

/**
 * Double chance (fix120, decided 17 Oct 2026): our recommended football pick = the two most likely results together,
 * with the sum of their chances. Ties go 1X, X2, 12. Keep in step with backend/src/utils/doubleChance.ts.
 * The 1X2 percentages stay as they are; the single most likely result is still tracked as the "hard call".
 */
export type DC = '1X' | 'X2' | '12'
export const DC_STRONG = 85
export const DC_SIDES: Record<DC, ('H' | 'D' | 'A')[]> = { '1X': ['H', 'D'], X2: ['D', 'A'], '12': ['H', 'A'] }

export function dcOf(h: number, d: number, a: number): { code: DC; pct: number } {
  const x = doubleChanceOf({ home: h, draw: d, away: a })
  return { code: x.k, pct: x.pct }
}

/** Our double-chance pick for a prediction: full ones carry the %, locked ones only the code (null when unknown). */
export function doubleChance(p: Prediction | null | undefined): { code: DC; pct: number | null; sides: ('H' | 'D' | 'A')[]; strong: boolean } | null {
  if (!p) return null
  if (p.locked || typeof p.home !== 'number') return p.dc ? { code: p.dc, pct: null, sides: DC_SIDES[p.dc], strong: false } : null
  const x = dcOf(p.home, p.draw, p.away)
  const pct = Math.round(x.pct)
  return { code: x.code, pct, sides: DC_SIDES[x.code], strong: pct >= DC_STRONG }
}

/** Our double chance in words (fix127): "No draw" / "Barça or draw" — never the code alone. Pass short names. */
export function dcLabel(code: DC, home: string, away: string) {
  return code === '1X' ? t("{0} or draw", { 0: home }) : code === 'X2' ? t("{0} or draw", { 0: away }) : t("No draw")
}

/** A team name short enough for a list row (fix127): the short name, else the 3-letter code, else the first word. */
export function shortTeam(team: { shortName?: string | null; tla?: string | null; name: string }) {
  const s = team.shortName || team.name
  if (s.length <= 10) return s
  if (team.tla) return team.tla
  return s.split(/\s+/)[0]
}

/** Fair (no-margin) decimal odds implied by a probability in %. */
export function fairOdds(pct: number) {
  if (!pct || pct <= 0) return '–'
  return (100 / pct).toFixed(2)
}

export const CONFIDENCE_LABEL: Record<Prediction['confidence'], string> = {
  low: t('Low confidence · few games played'),
  medium: t('Medium confidence'),
  high: t('High confidence')
}

/** Bookmaker market for a match (backend/src/services/odds.ts). Probabilities are margin-free, in %. */
export interface Market {
  msw: { homeWin: number; draw: number; awayWin: number }
  bookmaker: string
  books: number
  best: { homeWin: number | null; draw: number | null; awayWin: number | null }
  probs: { home: number; draw: number; away: number }
  overround: number
  fetchedAt: string
}

export const BOOK_LABEL: Record<string, string> = {
  pinnacle: 'Pinnacle',
  median: 'Market median'
}

export function bookLabel(m: Market) {
  return BOOK_LABEL[m.bookmaker] || m.bookmaker.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

/** Our league model: grid-v3, or v3-mix once it is the published one (both "SL Football 3.0" for visitors, fix191). */
export const isV3 = (model?: string) => model === 'grid-v3' || model === 'v3-mix'

/** Short and long labels for each model id. fix191: visitors see the public name (lib/modelNames), never the ids. */
const SLF = slModel('football')
export const MODEL_INFO: Record<string, { tag: string; name: string; desc: string }> = {
  'poisson-dc-v1': { tag: 'v1', name: t('Standings model'), desc: t('Poisson from the current league table') },
  'dc-history-v2': { tag: 'v2', name: t('History model'), desc: t('Dixon-Coles fitted on 3 seasons of results') },
  'grid-v3': { tag: SLF, name: t('Grid model'), desc: t('Scoring grid: value × relevance per parameter, 1000-point split') },
  // v3-mix is shown as SL Football 3.0 too (Yarin, Oct 2026): the grid averaged with our second model; no new public name
  'v3-mix': { tag: SLF, name: t('Grid model'), desc: t('Scoring grid: value × relevance per parameter, 1000-point split') },
  'elo-intl': { tag: SLF, name: t('{0} · national teams', { 0: SLF }), desc: t('Our national-team engine: rating from every senior international result since 2014, plus squad value') },
  'elo-euro': { tag: SLF, name: t('{0} · European cups', { 0: SLF }), desc: t('Our European-cup engine: cross-league club rating from domestic and UEFA cup results, plus squad value') }
}

export function modelInfo(model: string) {
  return MODEL_INFO[model] || { tag: model, name: model, desc: '' }
}

/**
 * Draw alert (backtested 2024-25 + 2025-26): market-anchored draw chance = market draw + 0.75 × (v3 draw − market draw);
 * flag when v3's draw ≥ 30%, anchored chance × best draw price − 1 ≥ 2%, and the league is not La Liga.
 * History: the draw price shortened toward v3 by kick-off 2 times in 3; ROI small positive in both seasons.
 */
// maxEdge: a bigger edge usually means v3 over-rates the draw in a one-sided match (weaker line movement in both seasons)
// maxStreak: skip games where both teams drew 32%+ of their last 20 (bookmakers already over-price those draws)
export const DRAW_ALERT = { k: 0.75, minEdge: 0.02, maxEdge: 0.2, minV3Draw: 30, maxStreak: 0.32, excluded: ['PD'] }
export function drawAlert(p: Prediction, m: Market | null | undefined, competitionCode?: string) {
  if (!m || p.locked || !isV3(p.model) || p.draw < DRAW_ALERT.minV3Draw) return null
  if (competitionCode && DRAW_ALERT.excluded.includes(competitionCode)) return null
  if (p.drawStreak && Math.min(p.drawStreak.home, p.drawStreak.away) >= DRAW_ALERT.maxStreak) return null
  const price = m.best?.draw || m.msw.draw
  if (!price) return null
  const mkt = m.probs.draw / 100
  const anchored = mkt + DRAW_ALERT.k * (p.draw / 100 - mkt)
  const edge = anchored * price - 1
  if (edge < DRAW_ALERT.minEdge || edge > DRAW_ALERT.maxEdge) return null
  return { anchored: Math.round(anchored * 1000) / 10, price, edge: Math.round(edge * 1000) / 10, market: m.probs.draw }
}

/** Double chance (fix118): the model's two most likely results together, e.g. 1X = home win or draw. */
export function doubleChanceOf(p: { home: number; draw: number; away: number }): { k: '1X' | 'X2' | '12'; pct: number } {
  const tot = p.home + p.draw + p.away || 100
  const c = [{ k: '1X' as const, v: p.home + p.draw }, { k: 'X2' as const, v: p.draw + p.away }, { k: '12' as const, v: p.home + p.away }].sort((a, b) => b.v - a.v)[0]
  return { k: c.k, pct: Math.round((100 * c.v) / tot) }
}

/** fix163: a factor score as shown (0–10). The model's value scale is open on purpose (about -2 to 13, gridModel CONV); the
 *  page never shows more than 10 — edges and labels keep the real values. */
export const score10 = (x: number) => Math.min(10, Math.max(0, x))

/**
 * fix282: "Why we think so" (Yarin, 29 Oct: "I don't like when the model writes Barça will win because they have a
 * better squad value, there are many other things") — every factor of one prediction, ranked by its share of the edge,
 * from the model's own sums for this game:
 *  - football: the grid rows' points (grid-v3; elo-euro / elo-intl write the same rows) + grid-v3's home term
 *  - basketball: the bb-v4 grid rows (points of the 1,000 split), else bb-v3's margin terms
 *  - American football: the Elo terms (rating gap, home field, rest, quarterbacks)
 *  - tennis: the model's logit terms (rating, serve and return, fatigue …)
 *  - the market anchor (basketball, American football): how far it moved the chance, in the same units; never a price
 * A factor's share = |its points| / the sum of every factor's |points|. No weight is made up here.
 * pts > 0 helps the home side (player 1), < 0 the away side.
 *
 * Two copies that must stay identical (test:fix282): backend/src/utils/whyFactors.ts = frontend/src/lib/whyFactors.ts.
 */

/** why a factor the model checked moved nothing for this game */
export type Idle = 'meetings' | 'missing' | 'lineups' | 'starters' | 'covered' | 'level' | 'nodata' | 'neutral' | 'rest'
export interface Factor { k: string; pts: number; idle?: Idle }
export interface WhyRowView { k: string; pts: number; share: number; side: 'H' | 'A'; forFav: boolean }
export interface WhyView {
  /** the factors the model used for this game (moving + no effect) */
  n: number
  /** the side the panel calls the favourite (the shown chances; else the sum of the points) */
  fav: 'H' | 'A' | null
  /** moving factors, biggest share first; shares are whole percents that sum to 100 */
  rows: WhyRowView[]
  /** factors with no effect, and why */
  idle: { k: string; idle: Idle }[]
  /** the top 2–3 factors helping the favourite, and the strongest one against it */
  lead: WhyRowView[]
  against: WhyRowView | null
}

export const MARKET = 'market'

/** whole percents for each |points|, summing to exactly 100 (largest remainder); all zero when nothing moves */
export function sharesOf(abs: number[]): number[] {
  const tot = abs.reduce((s, x) => s + Math.abs(x), 0)
  if (!(tot > 0)) return abs.map(() => 0)
  const raw = abs.map(x => (100 * Math.abs(x)) / tot)
  const out = raw.map(Math.floor)
  let left = 100 - out.reduce((s, x) => s + x, 0)
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || Math.abs(abs[b.i]) - Math.abs(abs[a.i]))
  for (let j = 0; left > 0 && j < order.length; j++, left--) out[order[j].i]++
  return out
}

/** the panel: shares, order, no-effect list, the favourite's lead factors and the strongest one against */
export function whyView(factors: Factor[], fav?: 'H' | 'A' | null): WhyView {
  // one entry per factor (a sport can send two parts of the same factor: home rest + away rest)
  const by = new Map<string, Factor>()
  for (const f of factors) {
    if (!f || !Number.isFinite(f.pts)) continue
    const x = by.get(f.k)
    if (x) by.set(f.k, { k: f.k, pts: x.pts + f.pts, idle: x.idle ?? f.idle })
    else by.set(f.k, { ...f })
  }
  const all = [...by.values()]
  const moving = all.filter(f => Math.abs(f.pts) > 1e-9)
  const idle = all.filter(f => Math.abs(f.pts) <= 1e-9).map(f => ({ k: f.k, idle: f.idle || ('level' as Idle) }))
  const sum = moving.reduce((s, f) => s + f.pts, 0)
  const side: 'H' | 'A' | null = fav ?? (sum > 0 ? 'H' : sum < 0 ? 'A' : null)
  const shares = sharesOf(moving.map(f => f.pts))
  const rows: WhyRowView[] = moving
    .map((f, i) => ({ k: f.k, pts: f.pts, share: shares[i], side: (f.pts > 0 ? 'H' : 'A') as 'H' | 'A', forFav: side !== null && (f.pts > 0 ? 'H' : 'A') === side }))
    .sort((a, b) => b.share - a.share || Math.abs(b.pts) - Math.abs(a.pts))
  const lead = rows.filter(r => r.forFav && r.k !== MARKET).slice(0, 3)
  const against = side ? rows.find(r => !r.forFav && r.k !== MARKET) || null : null
  return { n: rows.length + idle.length, fav: side, rows, idle, lead, against }
}

/* ---------- the edge side and the two numbers agree (the Barça–Villa bug, 3 Nov CL) ---------- */

/**
 * true when the side a row gives the edge to also has the better number: edge > 0 ⇒ home ≥ away, edge < 0 ⇒ away ≥ home
 * (lowerBetter: fewer is better). A row with no edge, or level numbers, always agrees.
 */
export function edgeAgrees(r: { home: number; away: number; edge: number }, lowerBetter = false): boolean {
  if (!r.edge || r.home === r.away) return true
  const homeBetter = lowerBetter ? r.home < r.away : r.home > r.away
  return r.edge > 0 ? homeBetter : !homeBetter
}

/**
 * fix282: weights of "more is better" factors are never fitted below 0 (elo-euro, elo-intl). A negative form or goals
 * weight made a team with the worse number the side the row helps (Barça 5.1 vs Villa 8.9 on form, "edge Barça"), which
 * breaks the model principle (a team with clearly worse form is not helped by its form). The cup fit already dropped a
 * negative head-to-head weight ("a negative H2H weight is noise, not a pattern").
 */
export const SAME_SIGN = new Set(['w_elo', 'w_squad', 'w_goals', 'w_form', 'w_rest', 'w_h2h'])
export const keepSign = (k: string, v: number) => (SAME_SIGN.has(k) ? Math.max(0, v) : v)

/**
 * A factor score as the page shows it (0–10). The models' value scale is open (football about −2 to 13): a hard cap made
 * two strong teams both "10.0" while one had the edge. Strictly increasing instead: 1–8.5 as it is, above 8.5 it bends
 * toward 10 (never reaching it), below 1 toward 0 — so the side with the higher value always shows the higher score.
 */
export function shownScore(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x > 8.5) return 10 - 1.5 * Math.exp(-(x - 8.5) / 1.5)
  if (x < 1) return Math.exp(x - 1)
  return x
}

/* ---------- each sport's factors from its model's own numbers ---------- */

type GridRow = { id: string; name: string; rel: number; home: number; away: number; edge: number; note?: string }
const DRAW_ROWS = new Set(['#15', '#30', '#16'])

/** football: the grid rows (draw rows aside) + grid-v3's league home advantage (`homeEdge`, same units as the rows) */
export function footballFactors(grid: { rows: GridRow[]; homeEdge?: number | null }): Factor[] {
  const out: Factor[] = []
  if (typeof grid.homeEdge === 'number') out.push({ k: 'home', pts: grid.homeEdge, idle: 'neutral' })
  for (const r of grid.rows || []) {
    if (DRAW_ROWS.has(r.id)) continue
    const k = r.name.startsWith('Home advantage') ? 'home' : r.name.startsWith('Rest days') ? 'rest' : r.name.startsWith('Goals') ? 'goals' : r.id
    // a row with no weight is shown to admins for information; the model did not use it
    if (!r.rel && !r.edge) continue
    out.push({ k, pts: r.edge || 0, ...(r.edge ? {} : { idle: idleOf(r) }) })
  }
  return out
}
function idleOf(r: GridRow): Idle {
  const n = r.note || ''
  if (r.id === '#7') return /^only|no previous meetings|no meetings/.test(n) ? 'meetings' : 'level'
  if (r.id === '#12') return /not published/.test(n) ? 'lineups' : /none \| none/.test(n) ? 'starters' : 'level'
  if (r.id === '#13') return /covered by/.test(n) ? 'covered' : /no injury data/.test(n) ? 'nodata' : /^out: (none|n\/a) \| (none|n\/a)$/.test(n) ? 'missing' : 'level'
  if (r.id === '#1' && /no squad values/.test(n)) return 'nodata'
  if (r.name.startsWith('Home advantage')) return 'neutral'
  return 'level'
}

/**
 * basketball bb-v4: the grid rows' points (each row's share of the 1,000 split, summing to home − 500) + the market
 * anchor's move in the same points (1,000 × (shown chance − the model's chance), 0–1 chances).
 */
export function bbGridFactors(grid: { rows: { key: string; edge: number }[] }, anchor?: { pModel: number; pHome: number } | null, missingKnown = true): Factor[] {
  const out: Factor[] = (grid.rows || []).map(r => ({ k: `bb.${r.key}`, pts: r.edge || 0, ...(r.edge ? {} : { idle: r.key === 'missing' ? (missingKnown ? 'missing' : 'nodata') : r.key === 'h2h' ? 'meetings' : r.key === 'home' ? 'neutral' : r.key === 'rest' ? 'rest' : 'level' } as { idle: Idle }) }))
  const m = anchorPts(anchor, 1000)
  if (m) out.push({ k: MARKET, pts: m })
  return out
}
/** basketball bb-v3 (leagues without the grid): its margin terms in points (strength, home court, rest, injuries, talent) */
export function bbV3Factors(why: { kind: string; side: 'H' | 'A'; points: number }[], anchor?: { pModel: number; pHome: number; sigma: number } | null): Factor[] {
  const out: Factor[] = []
  const sign = (s: 'H' | 'A') => (s === 'H' ? 1 : -1)
  for (const w of why) {
    if (w.kind === 'attack') continue // a part of the strength term, not a term of its own
    if (w.kind === 'b2bBoth') { out.push({ k: 'bb.rest', pts: 0, idle: 'rest' }); continue }
    const k = w.kind === 'strength' ? 'bb.team' : w.kind === 'home' ? 'bb.home' : w.kind === 'b2b' ? 'bb.rest' : w.kind === 'injuries' ? 'bb.missing' : w.kind === 'talent' ? 'bb.talent' : `bb.${w.kind}`
    out.push({ k, pts: sign(w.side) * Math.abs(w.points) })
  }
  if (!out.some(f => f.k === 'bb.missing')) out.push({ k: 'bb.missing', pts: 0, idle: 'missing' })
  if (!out.some(f => f.k === 'bb.rest')) out.push({ k: 'bb.rest', pts: 0, idle: 'rest' })
  if (anchor && anchor.sigma > 0) {
    const m = (probit(anchor.pHome) - probit(anchor.pModel)) * anchor.sigma
    if (Math.abs(m) >= 0.05) out.push({ k: MARKET, pts: Math.round(m * 10) / 10 })
  }
  return out
}

/** American football: the Elo terms of the margin (eloH − eloA + home field + rest + quarterbacks), in Elo points */
export function nflFactors(w: { eloGap: number; homeField: number; neutral: boolean; restAdj: [number, number]; qb: [{ adj: number } | null, { adj: number } | null] }, anchor?: { pModel: number; pHome: number } | null): Factor[] {
  const out: Factor[] = [
    { k: 'nfl.rating', pts: w.eloGap || 0 },
    { k: 'nfl.home', pts: w.neutral ? 0 : w.homeField || 0, idle: 'neutral' },
    { k: 'nfl.rest', pts: (w.restAdj?.[0] || 0) - (w.restAdj?.[1] || 0), idle: 'rest' },
    { k: 'nfl.qb', pts: (w.qb?.[0]?.adj || 0) - (w.qb?.[1]?.adj || 0), idle: 'missing' }
  ]
  // the anchor's move as Elo points (the logistic Elo scale: 400 points = ×10 in the odds)
  if (anchor) {
    const m = 400 * (Math.log10(odds(anchor.pHome)) - Math.log10(odds(anchor.pModel)))
    if (Math.abs(m) >= 0.5) out.push({ k: MARKET, pts: Math.round(m) })
  }
  return out.map(f => (f.pts ? { k: f.k, pts: f.pts } : f))
}

/** tennis: the model's logit terms, grouped (fatigue = its six parts) */
export const TENNIS_GROUP: Record<string, string> = {
  elo: 'tn.rating', point: 'tn.serve', m3: 'tn.fatigue', m7: 'tn.fatigue', m14: 'tn.fatigue', sets7: 'tn.fatigue', hours7: 'tn.fatigue', longYesterday: 'tn.fatigue',
  stoppage30: 'tn.stoppage', home: 'tn.home', surfaceSwitch: 'tn.surface', rankTrend: 'tn.rank'
}
export function tennisFactors(terms: Record<string, number>): Factor[] {
  const by = new Map<string, number>()
  for (const [name, v] of Object.entries(terms || {})) {
    const k = TENNIS_GROUP[name] || `tn.${name}`
    by.set(k, (by.get(k) || 0) + (Number.isFinite(v) ? v : 0))
  }
  return [...by.entries()].map(([k, v]) => {
    const pts = Math.round(v * 1000) / 1000
    return pts ? { k, pts } : { k, pts: 0, idle: (k === 'tn.fatigue' ? 'rest' : 'level') as Idle }
  })
}

function anchorPts(a: { pModel: number; pHome: number } | null | undefined, scale: number): number {
  if (!a || !Number.isFinite(a.pModel) || !Number.isFinite(a.pHome)) return 0
  return Math.round((a.pHome - a.pModel) * scale)
}
const odds = (p: number) => { const q = Math.min(0.999, Math.max(0.001, p)); return q / (1 - q) }
/** the standard normal quantile (Acklam's approximation, |error| < 1.2e-9) */
export function probit(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p))
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (q < lo) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  if (q > 1 - lo) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1) }
  const r = q - 0.5, s = r * r
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

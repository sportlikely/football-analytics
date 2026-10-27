/**
 * fix209 — the scorers line under the score in every sport's match header (and in a list row opened with its arrow).
 * Plain data, no imports (scripts/scorers-check.ts runs it with Node's type stripping, as part of `npm run parity`):
 *  - football: each team's goals in minute order ("Jackson 6', 60'"), own goals "(OG)" on the side that got the goal,
 *    penalties "(P)", red cards; a goal the provider has scored but not named yet is "Goal 52'" until the next update;
 *  - basketball: each team's top scorer ("Haliburton 28"), live and final, from the box score;
 *  - American football: the scoring plays ("TD Kelce 12' Q2").
 * Backend twin for the data-health check: backend/src/utils/scorers.ts (goalSides, the same rule).
 */

export type ScorerMark = 'pen' | 'og' | 'red' | 'pending' | 'pts'
export interface ScorerItem {
  /** player name ('' for a goal not named yet) */
  name: string
  /** player id (link to the player page), null when unknown */
  id?: number | null
  /** minutes, points or the time of the play ("6', 60'", "28", "12' Q2") */
  detail: string
  /** before the name (American football: the play, "TD") */
  pre?: string
  mark?: ScorerMark
  /** sort key (minute; quarter × 100 + minute in American football) */
  at: number
}
export interface ScorerLines { home: ScorerItem[]; away: ScorerItem[] }

/* ---------- football ---------- */

export interface FbGoal { minute: number; injuryTime?: number | null; type: string; team: { id: number }; scorer: { id: number; name: string }; score?: { home: number; away: number } | null }
export interface FbBooking { minute: number; team: { id: number }; player: { id: number; name: string }; card: string }
export interface FbMatch {
  homeTeam: { id: number }; awayTeam: { id: number }
  score: { fullTime: { home: number | null; away: number | null } }
  goals?: FbGoal[]; bookings?: FbBooking[]
}
type Side = 'home' | 'away'

const named = (n: string | null | undefined) => !!n && n.trim() !== '' && n.trim() !== '?'
const minuteOf = (minute: number, extra?: number | null) => `${minute}'${extra ? `+${extra}` : ''}`

/**
 * Which side each goal counts for. With the running score on the goals (Football-Data.org) the side whose score went
 * up; otherwise the goal's team, and for own goals whichever reading (the team = the player's team, or the team that
 * got the goal) makes the counts match the score — providers differ, the score never lies. Default: the player's team.
 */
export function goalSides(goals: FbGoal[], homeId: number, awayId: number, ft: { home: number | null; away: number | null }): (Side | null)[] {
  const order = goals.map((g, i) => ({ g, i })).sort((a, b) => a.g.minute - b.g.minute || (a.g.injuryTime || 0) - (b.g.injuryTime || 0))
  if (goals.length && goals.every(g => g.score && Number.isFinite(g.score.home) && Number.isFinite(g.score.away))) {
    const out: (Side | null)[] = goals.map(() => null)
    let prev = { home: 0, away: 0 }
    let ok = true
    for (const { g, i } of order) {
      const s = g.score!
      if (s.home === prev.home + 1 && s.away === prev.away) out[i] = 'home'
      else if (s.away === prev.away + 1 && s.home === prev.home) out[i] = 'away'
      else { ok = false; break }
      prev = { home: s.home, away: s.away }
    }
    if (ok) return out
  }
  const of = (id: number): Side | null => (id === homeId ? 'home' : id === awayId ? 'away' : null)
  const flip = (s: Side | null): Side | null => (s === 'home' ? 'away' : s === 'away' ? 'home' : null)
  const read = (ownIsPlayersTeam: boolean) => goals.map(g => (g.type === 'OWN' && ownIsPlayersTeam ? flip(of(g.team.id)) : of(g.team.id)))
  const a = read(true), b = read(false)
  if (!goals.some(g => g.type === 'OWN') || ft.home === null || ft.away === null) return a
  const fits = (r: (Side | null)[], exact: boolean) => {
    const h = r.filter(s => s === 'home').length, w = r.filter(s => s === 'away').length
    return exact ? h === ft.home && w === ft.away : h <= ft.home! && w <= ft.away!
  }
  if (fits(a, true)) return a
  if (fits(b, true)) return b
  if (fits(a, false)) return a
  return fits(b, false) ? b : a
}

/** Goals with a player's name, per side (own goals count for the side that got them). */
export function namedGoals(m: FbMatch): { home: number; away: number } {
  const goals = m.goals || []
  const sides = goalSides(goals, m.homeTeam.id, m.awayTeam.id, m.score.fullTime)
  const n = { home: 0, away: 0 }
  goals.forEach((g, i) => { const s = sides[i]; if (s && named(g.scorer?.name)) n[s]++ })
  return n
}

/**
 * The football line: per side, each scorer once with their minutes in order ("Jackson 6', 60'"), own goals and
 * penalties marked, red cards (straight or second yellow) with the player's name; sorted by the first minute.
 * `pending`: the minutes at which a goal not yet named was seen (the socket's score went up), oldest first.
 */
export function footballScorers(m: FbMatch, pending: { home: number[]; away: number[] } = { home: [], away: [] }): ScorerLines {
  const goals = m.goals || []
  const sides = goalSides(goals, m.homeTeam.id, m.awayTeam.id, m.score.fullTime)
  const out: ScorerLines = { home: [], away: [] }
  const by = new Map<string, ScorerItem & { mins: string[] }>()
  const inOrder = goals.map((g, i) => ({ g, i })).sort((a, b) => a.g.minute - b.g.minute || (a.g.injuryTime || 0) - (b.g.injuryTime || 0))
  inOrder.forEach(({ g, i }) => {
    const s = sides[i]
    if (!s || !named(g.scorer?.name)) return
    const kind = g.type === 'OWN' ? 'og' : null
    const key = `${s}|${g.scorer.id || g.scorer.name}|${kind || ''}`
    const min = minuteOf(g.minute, g.injuryTime) + (g.type === 'PENALTY' ? ' (P)' : '')
    const at = g.minute + (g.injuryTime || 0) / 100
    const cur = by.get(key)
    if (cur) { cur.mins.push(min); return }
    const item = { name: g.scorer.name, id: g.scorer.id || null, detail: '', at, mins: [min], ...(kind ? { mark: 'og' as const } : {}) }
    by.set(key, item)
    out[s].push(item)
  })
  for (const s of ['home', 'away'] as const) for (const it of out[s] as (ScorerItem & { mins?: string[] })[]) {
    it.detail = (it.mins || []).join(', ') + (it.mark === 'og' ? ' (OG)' : '')
    delete it.mins
  }
  // red cards (YELLOW_RED = second yellow) on the player's own side
  for (const b of m.bookings || []) {
    if (b.card !== 'RED' && b.card !== 'YELLOW_RED') continue
    const s: Side | null = b.team.id === m.homeTeam.id ? 'home' : b.team.id === m.awayTeam.id ? 'away' : null
    if (s && named(b.player?.name)) out[s].push({ name: b.player.name, id: b.player.id || null, detail: minuteOf(b.minute), mark: 'red', at: b.minute })
  }
  // the score has more goals than named events: "Goal 52'" until the name comes in
  const n = namedGoals(m)
  for (const s of ['home', 'away'] as const) {
    const score = m.score.fullTime[s] ?? 0
    const missing = Math.max(0, score - n[s])
    const mins = pending[s].slice(-missing)
    for (let k = 0; k < missing; k++) {
      const minute = mins[k]
      out[s].push({ name: '', detail: typeof minute === 'number' ? `${minute}'` : '', mark: 'pending', at: typeof minute === 'number' ? minute : 999 })
    }
  }
  for (const s of ['home', 'away'] as const) out[s].sort((a, b) => a.at - b.at)
  return out
}

/* ---------- basketball ---------- */

export interface BbTop { id: number; name: string; short?: string | null; points: number | null }
/** Each team's top scorer ("Haliburton 28"). */
export function basketballScorers(top: { home: BbTop | null; away: BbTop | null }): ScorerLines {
  const one = (p: BbTop | null): ScorerItem[] => (p && named(p.name) && (p.points ?? 0) > 0 ? [{ name: p.short || p.name, id: p.id, detail: String(p.points), mark: 'pts', at: 0 }] : [])
  return { home: one(top.home), away: one(top.away) }
}

/* ---------- American football ---------- */

export interface NflPlay { quarter: string | number | null; minute: string | null; team: number | null; player: string | null; playerId: number | null; type: string | null; comment?: string | null; score?: [number | null, number | null] | null }
const PLAY: Record<string, string> = { touchdown: 'TD', 'field goal': 'FG', safety: 'SAF', 'two point': '2PT', 'extra point': 'XP', 'pat': 'XP' }
/** "TD", "FG" … from the provider's play type (its own words when we don't know them). */
export function playCode(type: string | null | undefined): string {
  const t = String(type || '').toLowerCase()
  for (const [k, v] of Object.entries(PLAY)) if (t.includes(k)) return v
  return t ? t.toUpperCase().slice(0, 4) : ''
}
const quarterOf = (q: string | number | null) => {
  const s = String(q ?? '').toUpperCase()
  if (/^OT|OVER/.test(s)) return { label: 'OT', n: 5 }
  const n = parseInt(s.replace(/\D/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? { label: `Q${n}`, n } : { label: s, n: 9 }
}
/** The scoring plays, per side: "TD Kelce 12' Q2" (the play's team = the side that scored). */
export function nflScorers(plays: NflPlay[], homeId: number, awayId: number): ScorerLines {
  const out: ScorerLines = { home: [], away: [] }
  plays.forEach((e, i) => {
    const s: Side | null = e.team === homeId ? 'home' : e.team === awayId ? 'away' : null
    if (!s) return
    const q = quarterOf(e.quarter)
    const min = e.minute ? `${String(e.minute).replace(/'$/, '')}'` : ''
    const code = playCode(e.type)
    out[s].push({ name: named(e.player) ? e.player! : '', id: e.playerId, pre: code, detail: [min, q.label].filter(Boolean).join(' '), at: q.n * 100 + i / 100 })
  })
  return out
}

/** Does a header line exist for this game (the parity render check)? */
export const hasScorerLine = (l: ScorerLines | null | undefined) => !!l && (l.home.length > 0 || l.away.length > 0)

/** a list row's sport (the API key of its /scorers route) */
export type ScorerSport = 'football' | 'basketball' | 'nfl'
const SCORER_SPORT: Record<string, ScorerSport> = { football: 'football', basketball: 'basketball', 'american-football': 'nfl' }

/**
 * fix252 — which game a list row's link opens, for its scorers line: { sport, id } or null (no line). The link can be
 * null (fix243: a past season's game, or one not known yet, has no link — "Cannot read properties of null (reading
 * 'split')" on the homes and lists, 26–27 Oct), an old id address (/match/<id>, /basketball/game/<id>,
 * /american-football/(college/)game/<id>) or a slug address (/<lang?>/<sport>/match/<slug>[/<tab>]): its id from
 * `idOf` (lib/links knownId). Tennis has its set scores instead.
 */
export function scorersRoute(href: string | null | undefined, idOf: (sport: 'football' | 'basketball' | 'american-football', slug: string) => string | number | null = () => null): { sport: ScorerSport; id: string } | null {
  if (typeof href !== 'string' || !href) return null
  const path = href.split('#')[0].split('?')[0]
  let x = /^\/match\/(\d+)/.exec(path)
  if (x) return { sport: 'football', id: x[1] }
  x = /^\/basketball\/game\/(\d+)/.exec(path)
  if (x) return { sport: 'basketball', id: x[1] }
  x = /^\/american-football\/(?:college\/)?game\/(\d+)/.exec(path)
  if (x) return { sport: 'nfl', id: x[1] }
  x = /^(?:\/[a-z]{2})?\/(football|basketball|american-football)\/match\/([^/]+)/.exec(path)
  if (x) {
    const id = idOf(x[1] as 'football' | 'basketball' | 'american-football', x[2])
    return id == null || id === '' ? null : { sport: SCORER_SPORT[x[1]], id: String(id) }
  }
  return null
}

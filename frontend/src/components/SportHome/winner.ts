import { t as tt } from '../../lib/i18n'
import type { HCell, HPick, HPred, HRecordRow, HSpecialItem } from './types'

/**
 * Helpers for sports where the pick is the winner (basketball, NFL; tennis later): the two result cells, the pick line,
 * the "Our record" bars by confidence band and the "Upset watch" items. Used by those sports' adapters (fix141).
 */

/** Two cells (1 · 2) with the picked side highlighted, and "Our pick · {team} · %". `strongAt` = the sport's strong %. */
export function winnerPred(p: { locked?: boolean; pHome?: number | null; pAway?: number | null; pick?: 'H' | 'A' | null } | null | undefined, home: string, away: string, strongAt: number): HPred {
  if (!p) return { kind: 'none' }
  // fix160: a locked row still draws the 1 · 2 block (blurred); the pick in words when the server gives it (basketball)
  if (p.locked || typeof p.pHome !== 'number') return { kind: 'locked', heads: ['1', '2'], pick: p.pick ? { words: p.pick === 'H' ? home : away, pct: null, strong: false } : null }
  const pAway = typeof p.pAway === 'number' ? p.pAway : 100 - p.pHome
  const pick = p.pick || (p.pHome >= pAway ? 'H' : 'A')
  const pct = Math.round(pick === 'H' ? p.pHome : pAway)
  const cells: HCell[] = [
    { key: 'H', head: '1', label: home, pct: p.pHome, on: pick === 'H' },
    { key: 'A', head: '2', label: away, pct: pAway, on: pick === 'A' }
  ]
  const words: HPick = { words: pick === 'H' ? home : away, pct, strong: pct >= strongAt }
  return { kind: 'full', cells, pick: words }
}

/** "Our record" bars from the server's winner bands (all / 60 / 70 / 80%+ sure). */
export function winnerRecordRows(bands: { min: number; n: number; pct: number | null }[] | null | undefined): HRecordRow[] {
  return (bands || []).map(b => ({
    key: `w${b.min}`, n: b.n, pct: b.pct,
    label: b.min === 0 ? tt("Winner · all picks") : tt("Winner · {0}%+ sure", { 0: b.min })
  }))
}

/** Upset watch: the coming games where our model gives the underdog the best chance (30%+), most likely first. */
export function upsetItems<G>(games: G[], get: (g: G) => { id: number; href: string; league: string; date: string; home: string; away: string; pHome?: number | null; pAway?: number | null; locked?: boolean } | null, n = 2): HSpecialItem[] {
  return games.map(get).filter((x): x is NonNullable<typeof x> => !!x && !x.locked && typeof x.pHome === 'number')
    .map(x => {
      const pAway = typeof x.pAway === 'number' ? x.pAway : 100 - x.pHome!
      const homeDog = x.pHome! < pAway
      return { x, dog: homeDog ? x.home : x.away, fav: homeDog ? x.away : x.home, dogPct: Math.min(x.pHome!, pAway), favPct: Math.max(x.pHome!, pAway) }
    })
    .filter(u => u.dogPct >= 30 && u.dogPct < u.favPct) // a 50–50 game has no underdog
    .sort((a, b) => b.dogPct - a.dogPct || a.x.date.localeCompare(b.x.date))
    .slice(0, n)
    .map(u => ({
      id: u.x.id, href: u.x.href, league: u.x.league, date: u.x.date, title: `${u.x.home} – ${u.x.away}`,
      main: { label: tt("{0} to win", { 0: u.dog }), value: `${Math.round(u.dogPct)}%` },
      extra: { label: tt("Our pick"), value: `${u.fav} · ${Math.round(u.favPct)}%` }
    }))
}

/**
 * fix174: the first-visit stats tiles (football's introStats) for the winner sports, from the record bands of the last
 * 30 days: picks right, strong picks right, and what we cover (teams or leagues).
 */
export function winnerIntroStats(bands: { min: number; n: number; pct: number | null }[] | null | undefined, strongAt: number, cover: { value: number; label: string } | null) {
  const all = (bands || []).find(b => b.min === 0)
  if (!all || !all.n || all.pct === null) return undefined
  const strong = (bands || []).filter(b => b.min >= strongAt && b.n >= 5 && b.pct !== null).sort((a, b) => a.min - b.min)[0]
  return [
    { value: `${all.pct}%`, label: tt("right · winner picks"), sub: tt("{0} games, last {1} days", { 0: all.n, 1: 30 }) },
    ...(strong ? [{ value: `${strong.pct}%`, label: tt("when we're {0}%+ sure", { 0: strong.min }), sub: tt("{0} games", { 0: strong.n }) }] : []),
    ...(cover && cover.value > 0 ? [{ value: String(cover.value), label: cover.label, sub: tt("every game predicted") }] : [])
  ]
}

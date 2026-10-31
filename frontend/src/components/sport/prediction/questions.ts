import { t } from '../../../lib/i18n'
import { bandOf, BAND_ORDER } from '../../../lib/confidence'
import type { MoreData, MoreSport, MSet } from './more'

/**
 * fix281 — every public prediction of a game as a plain sentence (one dictionary per output) for "Most sure first",
 * and as question cards for "One topic at a time". Built from the main prediction (the page passes it) plus the
 * extras visitors may see (useMore: the server leaves out what is not public; admins get it with adminOnly).
 */
export type TopicId = 'result' | 'goals' | 'score' | 'half-time' | 'points' | 'halves' | 'sets' | 'games'
export interface Topic { id: TopicId; label: string }
/** the topics of each sport, in tab order; the first is the prediction tab itself (no sub-path) */
export const TOPIC_IDS: Record<MoreSport, TopicId[]> = {
  football: ['result', 'goals', 'score', 'half-time'],
  basketball: ['result', 'points', 'halves'],
  nfl: ['result', 'points', 'halves'],
  tennis: ['result', 'sets', 'games']
}
export const topicLabel = (id: TopicId) => ({
  result: t("Result"), goals: t("Goals"), score: t("Score"), 'half-time': t("Half-time"), points: t("Points"), halves: t("Halves"), sets: t("Sets"), games: t("Games")
} as Record<TopicId, string>)[id]
/** which topic each output belongs to */
export const OUTPUT_TOPIC: Record<MoreSport, Record<string, TopicId>> = {
  football: { win2Home: 'result', win2Away: 'result', goals: 'goals', over15: 'goals', over25: 'goals', over35: 'goals', btts: 'goals', scoreHome: 'goals', scoreAway: 'goals', cleanHome: 'goals', cleanAway: 'goals', homeGoals: 'goals', awayGoals: 'goals', score: 'score', ht: 'half-time', htft: 'half-time' },
  basketball: { margin: 'result', ot: 'points', total: 'points', totalLine: 'points', homePts: 'points', awayPts: 'points', half: 'halves', half2: 'halves' },
  nfl: { margin: 'result', ot: 'points', total: 'points', totalLine: 'points', homePts: 'points', awayPts: 'points', half: 'halves', half2: 'halves' },
  tennis: { sets: 'result', first: 'sets', set1: 'sets', set2: 'sets', tb: 'sets', games: 'games' }
}

/** what happened, once the game is checked */
export interface Hit { text: string; ok: boolean }
/** one row of "Most sure first" */
export interface SureItem { id: string; text: string; pct: number; admin?: boolean; hit?: Hit | null; main?: boolean }
export interface CardCell { key: 'H' | 'D' | 'A'; label: string; pct: number; on: boolean }
export type QCard =
  | { kind: 'split'; id: string; q: string; cells: CardCell[]; call: { words: string; pct: number }; admin?: boolean; hit?: Hit | null }
  | { kind: 'bars'; id: string; q: string; rows: { label: string; pct: number; top: boolean; was?: boolean }[]; note?: string; admin?: boolean; hit?: Hit | null }
  | { kind: 'scores'; id: string; q: string; tiles: { label: string; pct: number; was?: boolean }[]; note: string; grid6?: number[][] | null; admin?: boolean; hit?: Hit | null }
  | { kind: 'chart'; id: string; q: string; bars: { label: string; pct: number; top: boolean }[]; note?: string; admin?: boolean; hit?: Hit | null }

const dash = (s: string) => s.replace('-', '–')
const round = (v: number) => Math.round(v)

export interface Names { home: string; away: string }

/** the sentences and cards of the extras: one dictionary per output */
export function fromMore(sport: MoreSport, d: MoreData | null, n: Names): { items: SureItem[]; cards: QCard[]; topics: Set<TopicId> } {
  const items: SureItem[] = [], cards: QCard[] = [], topics = new Set<TopicId>()
  const p = d?.prediction
  if (!d || !p || p.locked || !p.sets) return { items, cards, topics }
  const sets = p.sets, admin = new Set(p.adminOnly || []), res = p.result
  const { home, away } = n
  const has = (k: string) => !!sets[k] && d.keys.includes(k)
  const side = (l: string) => (l === 'H' ? home : l === 'A' ? away : '')
  /** what happened in this output, in the card's words */
  const hitOf = (k: string, word: (s: MSet, i: number) => string): Hit | null => {
    const h = res?.hits?.[k]
    return h && sets[k] ? { text: word(sets[k], h.i), ok: h.hit } : null
  }
  const add = (k: string, item: Omit<SureItem, 'admin'> | null, card: QCard | null) => {
    topics.add(OUTPUT_TOPIC[sport][k] || 'result')
    if (item) items.push({ ...item, admin: admin.has(k) })
    if (card) cards.push({ ...card, admin: admin.has(k) } as QCard)
  }
  /** a yes / no output: the sentence of its likelier side, a yes / no card */
  const yn = (k: string, yes: string, no: string, q: string) => {
    if (!has(k)) return
    const s = sets[k], py = s.p[s.labels.indexOf('yes')] ?? s.p[0], pn = 100 - py
    const isYes = py >= pn
    const hit = hitOf(k, (x, i) => (x.labels[i] === 'yes' ? t("Yes") : t("No")))
    add(k, { id: k, text: isYes ? yes : no, pct: isYes ? py : pn, hit },
      { kind: 'split', id: k, q, cells: [{ key: 'H', label: t("Yes {0}%", { 0: round(py) }), pct: py, on: isYes }, { key: 'A', label: t("No {0}%", { 0: round(pn) }), pct: pn, on: !isYes }], call: { words: isYes ? t("Yes") : t("No"), pct: Math.max(py, pn) }, hit })
  }
  /** a three-way H / D / A output (half-time, a half of a game) */
  const hda = (k: string, sent: Record<'H' | 'D' | 'A', string>, q: string, level: string) => {
    if (!has(k)) return
    const s = sets[k]
    const v = (l: 'H' | 'D' | 'A') => s.p[s.labels.indexOf(l)] ?? 0
    const top = (['H', 'D', 'A'] as const).reduce((a, b) => (v(b) > v(a) ? b : a), 'H' as 'H' | 'D' | 'A')
    const word = (l: string) => (l === 'D' ? level : side(l))
    const hit = hitOf(k, (x, i) => word(x.labels[i]))
    add(k, { id: k, text: sent[top], pct: v(top), hit },
      { kind: 'split', id: k, q, cells: (['H', 'D', 'A'] as const).map(l => ({ key: l, label: `${word(l)} ${round(v(l))}%`, pct: v(l), on: l === top })), call: { words: word(top), pct: v(top) }, hit })
  }
  /** a set of bands: the top band as a sentence, every band as a bar */
  const bands = (k: string, q: string, word: (l: string) => string, sentence: ((l: string) => string) | null, note?: string) => {
    if (!has(k)) return
    const s = sets[k], h = res?.hits?.[k]
    const rows = s.labels.map((l, i) => ({ label: word(l), pct: s.p[i], top: i === s.top, was: !!h && h.i === i })).filter((_, i) => s.labels[i] !== 'other')
    add(k, sentence ? { id: k, text: sentence(s.labels[s.top]), pct: s.p[s.top], hit: h ? { text: word(s.labels[h.i]), ok: h.hit } : null } : null,
      { kind: 'bars', id: k, q, rows, note, hit: h ? { text: word(s.labels[h.i]), ok: h.hit } : null })
  }

  if (sport === 'football') {
    // Goals
    if (has('goals')) {
      const s = sets.goals, xg = p.info?.xg
      const exp = xg ? Math.round((xg[0] + xg[1]) * 10) / 10 : null
      add('goals', null, { kind: 'chart', id: 'goals', q: t("How many goals?"), bars: s.labels.map((l, i) => ({ label: l, pct: s.p[i], top: i === s.top })), note: exp !== null ? t("We expect about {0} goals.", { 0: exp }) : undefined, hit: hitOf('goals', (x, i) => x.labels[i]) })
    }
    yn('over25', t("3 or more goals"), t("2 goals or fewer"), t("0–2 goals or 3+?"))
    yn('over15', t("At least 2 goals in the game"), t("0 or 1 goal in the game"), t("At least 2 goals?"))
    yn('over35', t("4 or more goals"), t("3 goals or fewer"), t("4 or more goals?"))
    yn('btts', t("Both teams score"), t("At least one team fails to score"), t("Will both teams score?"))
    yn('scoreHome', t("{0} score at least once", { 0: home }), t("{0} fail to score", { 0: home }), t("Will {0} score?", { 0: home }))
    yn('scoreAway', t("{0} score at least once", { 0: away }), t("{0} fail to score", { 0: away }), t("Will {0} score?", { 0: away }))
    // a clean sheet is the other side not scoring: only when that one is not public
    if (!has('scoreAway')) yn('cleanHome', t("{0} keep a clean sheet", { 0: home }), t("{0} concede at least once", { 0: home }), t("Will {0} keep a clean sheet?", { 0: home }))
    if (!has('scoreHome')) yn('cleanAway', t("{0} keep a clean sheet", { 0: away }), t("{0} concede at least once", { 0: away }), t("Will {0} keep a clean sheet?", { 0: away }))
    bands('homeGoals', t("{0} goals", { 0: home }), l => l, null)
    bands('awayGoals', t("{0} goals", { 0: away }), l => l, null)
    // Result
    yn('win2Home', t("{0} win by 2+ goals", { 0: home }), t("{0} don't win by 2+ goals", { 0: home }), t("Will {0} win by 2+ goals?", { 0: home }))
    yn('win2Away', t("{0} win by 2+ goals", { 0: away }), t("{0} don't win by 2+ goals", { 0: away }), t("Will {0} win by 2+ goals?", { 0: away }))
    // Score
    if (has('score')) {
      const s = sets.score, h = res?.hits?.score
      const tiles = s.labels.map((l, i) => ({ l, pct: s.p[i], i })).filter(x => x.l !== 'other').sort((a, b) => b.pct - a.pct)
      const top = tiles[0]
      add('score', top ? { id: 'score', text: t("Exact score {0}", { 0: dash(top.l) }), pct: top.pct, hit: h ? { text: dash(s.labels[h.i]), ok: h.hit } : null } : null,
        { kind: 'scores', id: 'score', q: t("Most likely scores"), tiles: tiles.slice(0, 3).map(x => ({ label: dash(x.l), pct: x.pct, was: !!h && h.i === x.i })), grid6: p.info?.grid6 || null,
          note: t("Exact scores are hard: even the top one happens less than 1 time in 10."), hit: h ? { text: s.labels[h.i] === 'other' ? t("Other") : dash(s.labels[h.i]), ok: h.hit } : null })
    }
    // Half-time
    hda('ht', { H: t("{0} ahead at half-time", { 0: home }), D: t("Level at half-time"), A: t("{0} ahead at half-time", { 0: away }) }, t("Who leads at half-time?"), t("Level"))
    if (has('htft')) {
      const word = (l: string) => l.split('/').map(x => (x === 'D' ? t("Draw") : side(x))).join(' / ')
      const s = sets.htft
      const [a, b] = s.labels[s.top].split('/')
      bands('htft', t("Half-time / full-time"), word, () => (a === 'D' ? t("Level at half-time, {0} at full time", { 0: b === 'D' ? t("a draw") : t("{0} win", { 0: side(b) }) }) : t("{0} ahead at half-time, {1} at full time", { 0: side(a), 1: b === 'D' ? t("a draw") : t("{0} win", { 0: side(b) }) })))
      const c = cards.find(x => x.id === 'htft')
      if (c && c.kind === 'bars') c.rows = [...c.rows].sort((x, y) => y.pct - x.pct).slice(0, 3)
    }
  }

  if (sport === 'basketball' || sport === 'nfl') {
    const win = p.info?.side === 'A' ? away : home, lose = p.info?.side === 'A' ? home : away
    const exp = p.info?.expected
    bands('margin', t("By how much?"), l => (l === 'loser' ? t("{0} win instead", { 0: lose }) : t("{0} by {1}", { 0: win, 1: l })), l => (l === 'loser' ? t("{0} win", { 0: lose }) : t("{0} win by {1} points", { 0: win, 1: l })))
    const line = p.info?.line
    if (has('totalLine') && typeof line === 'number') {
      const s = sets.totalLine, po = s.p[s.labels.indexOf('over')] ?? 0, pu = 100 - po, over = po >= pu
      const L = line.toFixed(1)
      const hit = hitOf('totalLine', (x, i) => (x.labels[i] === 'over' ? t("Over") : t("Under")))
      add('totalLine', { id: 'totalLine', text: over ? t("More than {0} points in the game", { 0: L }) : t("Fewer than {0} points in the game", { 0: L }), pct: Math.max(po, pu), hit },
        { kind: 'split', id: 'totalLine', q: t("Over or under {0} points?", { 0: L }), cells: [{ key: 'H', label: t("Under {0}%", { 0: round(pu) }), pct: pu, on: !over }, { key: 'A', label: t("Over {0}%", { 0: round(po) }), pct: po, on: over }], call: { words: over ? t("Over") : t("Under"), pct: Math.max(po, pu) }, hit })
    }
    bands('total', t("How many points in total?"), l => l, l => t("{0} points in the game", { 0: l }), exp ? t("We expect about {0} points.", { 0: exp[0] + exp[1] }) : undefined)
    bands('homePts', t("{0} points", { 0: home }), l => l, l => t("{0} score {1} points", { 0: home, 1: l }))
    bands('awayPts', t("{0} points", { 0: away }), l => l, l => t("{0} score {1} points", { 0: away, 1: l }))
    yn('ot', t("The game goes to overtime"), t("No overtime"), t("Will it go to overtime?"))
    hda('half', { H: t("{0} ahead at half-time", { 0: home }), D: t("Level at half-time"), A: t("{0} ahead at half-time", { 0: away }) }, t("Who leads at half-time?"), t("Level"))
    hda('half2', { H: t("{0} win the second half", { 0: home }), D: t("Second half level"), A: t("{0} win the second half", { 0: away }) }, t("Who wins the second half?"), t("Level"))
  }

  if (sport === 'tennis') {
    const setWord = (l: string) => { const [a, b] = l.split('-').map(Number); return a > b ? `${home} ${a}–${b}` : `${away} ${b}–${a}` }
    bands('sets', t("Set score"), setWord, l => t("{0} wins {1}", { 0: Number(l.split('-')[0]) > Number(l.split('-')[1]) ? home : away, 1: (() => { const [a, b] = l.split('-').map(Number); return `${Math.max(a, b)}–${Math.min(a, b)}` })() }))
    if (has('first')) {
      const s = sets.first, p1 = s.p[s.labels.indexOf('1')] ?? s.p[0], p2 = 100 - p1, one = p1 >= p2
      const hit = hitOf('first', (x, i) => (x.labels[i] === '1' ? home : away))
      add('first', { id: 'first', text: t("{0} wins the first set", { 0: one ? home : away }), pct: Math.max(p1, p2), hit },
        { kind: 'split', id: 'first', q: t("Who wins the first set?"), cells: [{ key: 'H', label: `${home} ${round(p1)}%`, pct: p1, on: one }, { key: 'A', label: `${away} ${round(p2)}%`, pct: p2, on: !one }], call: { words: one ? home : away, pct: Math.max(p1, p2) }, hit })
    }
    yn('set1', t("{0} wins at least one set", { 0: home }), t("{0} wins no set", { 0: home }), t("Will {0} win a set?", { 0: home }))
    yn('set2', t("{0} wins at least one set", { 0: away }), t("{0} wins no set", { 0: away }), t("Will {0} win a set?", { 0: away }))
    yn('tb', t("At least one tie-break"), t("No tie-break"), t("At least one tie-break?"))
    const eg = p.info?.expGames
    bands('games', t("How many games?"), l => l, l => t("{0} games in the match", { 0: l }), typeof eg === 'number' ? t("We expect about {0} games.", { 0: eg }) : undefined)
  }
  return { items, cards, topics }
}

/**
 * "Most sure first" (fix284b, Yarin 30 Oct: "Alavés don't win by 2+ goals 97%" on top, then the same question twice more):
 *  - one line per question, the side we call (the main result's res-H / res-D / res-A and win-H / win-A → the likelier one);
 *  - no line whose other side is under 10% (the "no" side of a rare event), except the main pick;
 *  - the main pick (football: our double chance, else the result we call) first in its band, then highest first.
 */
const RARE = 10
const questionOf = (id: string) => (/^(res|win)-/.test(id) ? id.split('-')[0] : id)
export function sureLines(xs: SureItem[]): SureItem[] {
  const best = new Map<string, SureItem>()
  for (const x of xs) { const q = questionOf(x.id), b = best.get(q); if (!b || x.pct > b.pct) best.set(q, x) }
  const lines = [...best.values()]
  const main = lines.find(x => x.id === 'dc') ?? lines.find(x => /^(res|win)-/.test(x.id)) ?? null
  const band = (x: SureItem) => BAND_ORDER.indexOf(bandOf(x.pct))
  return lines
    .filter(x => x === main || 100 - x.pct >= RARE)
    .sort((a, b) => band(a) - band(b) || Number(b === main) - Number(a === main) || b.pct - a.pct || a.id.localeCompare(b.id))
    .map(x => (x === main ? { ...x, main: true } : x))
}

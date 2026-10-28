import { dcOf, type Prediction } from './predict'
import { t } from './i18n'
import { tg } from './genText'
import { nm } from './names'

/**
 * "Why this pick" — turns a v3 prediction (the grid rows every engine sends: leagues, national teams, European cups)
 * into a few plain sentences. No extra data or API calls: everything comes from the prediction itself.
 */
export interface Explanation {
  /** fix120: our pick, the double chance — "Barça or a draw: 82%" */
  dcHeadline: string
  headline: string
  /** reasons for the pick, strongest first */
  forPick: string[]
  /** the strongest thing pulling the other way, if any */
  against: string | null
  /** why the draw is (or isn't) a real option */
  draw: string[]
  caution: string | null
}

type Row = NonNullable<Prediction['grid']>['rows'][number]
type Side = 'H' | 'A'

const pctR = (x: number) => `${Math.round(x)}%`
/** fix261: names from a row note in the page's script */
const names_ = (s: string) => s.split(', ').map(nm).join(', ')

export function rowSentence(r: Row, side: Side, names: { H: string; A: string }): string {
  const tm = names[side], o = names[side === 'H' ? 'A' : 'H']
  // only notes that carry this match's numbers (not the row's general description)
  const note = r.note && /\d/.test(r.note) && !/^(n\/a|no |XI not|covered by|stands in|market value of|Elo over)/i.test(r.note) ? r.note : null
  switch (r.id) {
    case '#1':
    {
      // note is "home vs away"; put the favoured team's value first
      const m = note?.match(/(~?€[\d.]+m) vs (~?€[\d.]+m)/)
      return (m ? t("{0} have the more valuable squad ({1} vs {2}).", { 0: tm, 1: side === 'H' ? m[1] : m[2], 2: side === 'H' ? m[2] : m[1] }) : t("{0} have the more valuable squad.", { 0: tm })) + (m && (m[1] + m[2]).includes('~') ? ' ' + t("(~ = estimate: the data source is incomplete for newly promoted clubs.)") : '')
    }
    case '#1e':
      return note ? t("{0} are the stronger side on results over time ({1}).", { 0: tm, 1: tg(note) }) : t("{0} are the stronger side on results over time.", { 0: tm })
    case '#19':
      return r.name.startsWith('Goals')
        ? (note ? t("{0} score more and concede less ({1}).", { 0: tm, 1: tg(note) }) : t("{0} score more and concede less.", { 0: tm }))
        : t("{0}'s attack does better against teams of this level.", { 0: tm })
    case '#14':
      return t("{0}'s defence holds up better against teams of this level.", { 0: tm })
    case '#10':
      return r.name.startsWith('Rest') ? t("{0} have had more rest.", { 0: tm }) : note ? t("{0} are fresher ({1}).", { 0: tm, 1: tg(note) }) : t("{0} are fresher.", { 0: tm })
    case '#23':
      return r.name.startsWith('Home advantage') ? t("Home advantage for {0}.", { 0: names.H }) : side === 'H' ? t("{0} are strong at home compared with {1}'s away record.", { 0: tm, 1: o }) : t("{0}'s away record is better than {1}'s home record.", { 0: tm, 1: o })
    case '#7':
      return note ? t("{0} have had the better of recent meetings ({1}).", { 0: tm, 1: tg(note.replace(/, home side share \d+%/, '')) }) : t("{0} have had the better of recent meetings.", { 0: tm })
    case '#21':
      return note ? t("{0} are in better form ({1}).", { 0: tm, 1: tg(note) }) : t("{0} are in better form.", { 0: tm })
    case '#12': {
      const [h, a] = (note || '').replace(/^usual starters out: /, '').split(' | ')
      const who = side === 'H' ? a : h
      return who && who !== 'none' && who !== 'n/a' ? t("{0} are without usual starters ({1}).", { 0: o, 1: names_(who) }) : t("{0} are without usual starters.", { 0: o })
    }
    case '#13': {
      const [h, a] = (note || '').replace(/^out: /, '').split(' | ')
      const who = side === 'H' ? a : h
      return who && who !== 'none' && who !== 'n/a' ? t("{0} have key players missing ({1}).", { 0: o, 1: names_(who) }) : t("{0} have key players missing.", { 0: o })
    }
    default:
      return t("{0} favours {1}.", { 0: t(r.name), 1: tm })
  }
}

export function explainPrediction(p: Prediction, homeName: string, awayName: string, upcoming = true): Explanation | null {
  const g = p.grid
  if (!g || p.locked) return null
  const names = { H: homeName, A: awayName }
  const opts = [
    { k: 'H' as const, label: homeName, v: p.home },
    { k: 'D' as const, label: t('a draw'), v: p.draw },
    { k: 'A' as const, label: awayName, v: p.away }
  ].sort((x, y) => y.v - x.v)
  const top = opts[0], second = opts[1]

  // --- our pick first: the double chance (the two most likely results together)
  const dc = dcOf(p.home, p.draw, p.away)
  const dcHeadline = dc.code === '1X' ? t("{0} or a draw: {1}", { 0: homeName, 1: pctR(dc.pct) })
    : dc.code === 'X2' ? t("{0} or a draw: {1}", { 0: awayName, 1: pctR(dc.pct) })
    : t("{0} or {1}: {2}", { 0: homeName, 1: awayName, 2: pctR(dc.pct) })

  // --- headline
  let headline: string
  if (top.k === 'D') headline = t("We lean to a draw ({0}) — neither side has a clear edge.", { 0: pctR(top.v) })
  else if (top.v >= 60) headline = t("{0} are clear favourites ({1}).", { 0: top.label, 1: pctR(top.v) })
  else if (top.v >= 50) headline = t("{0} are favourites ({1}), but it is not one-sided.", { 0: top.label, 1: pctR(top.v) })
  else if (top.v - second.v <= 8)
    headline = t("Close game: {0} ({1}) or {2} ({3}) — both are real options.", { 0: top.label, 1: pctR(top.v), 2: second.label, 3: pctR(second.v) })
  else headline = t("{0} have the edge ({1}), with {2} next ({3}).", { 0: top.label, 1: pctR(top.v), 2: second.label, 3: pctR(second.v) })

  // --- team rows: which side each row favours, by size
  const team = g.rows.filter(r => r.edge !== 0 && !['#15', '#30', '#16'].includes(r.id))
  const maxEdge = Math.max(0, ...team.map(r => Math.abs(r.edge)))
  const meaningful = team.filter(r => Math.abs(r.edge) >= Math.min(3, Math.max(1, maxEdge * 0.15))).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))
  const favoured: Side = top.k === 'D' ? (p.home >= p.away ? 'H' : 'A') : top.k
  const pro = meaningful.filter(r => (r.edge > 0 ? 'H' : 'A') === favoured)
  const con = meaningful.filter(r => (r.edge > 0 ? 'H' : 'A') !== favoured)
  const forPick = top.k === 'D' ? [] : pro.slice(0, 3).map(r => rowSentence(r, favoured, names))
  const against = top.k === 'D' || !con.length ? null : rowSentence(con[0], favoured === 'H' ? 'A' : 'H', names)

  // --- draw
  const draw: string[] = []
  const drawReal = top.k === 'D' || (second.k === 'D' && p.draw >= 27) || p.draw >= 30
  if (drawReal) {
    if (g.matchType === 'even') draw.push(t('On results so far the two sides are closely matched, which makes a draw more likely.'))
    // only rows the model actually uses (a row with weight 0 is shown for information but carries no points)
    const derby = g.rows.find(r => r.id === '#16' && r.rel > 0)
    if (derby && derby.home >= 7) draw.push(t('It is a derby — these are often tight.'))
    const league = g.rows.find(r => r.id === '#30' && r.rel > 0)
    if (league && league.home >= 6) draw.push(league.note ? t("This league has a lot of draws ({0}).", { 0: league.note.replace('league draw rate', t('draw rate')) }) : t('This league has a lot of draws.'))
    const prone = g.rows.find(r => r.id === '#15' && r.rel > 0)
    if (prone && prone.home >= 6.5) draw.push(t('Both teams draw often.'))
    if (p.expectedGoals.home + p.expectedGoals.away < 2.3) draw.push(t("We expect few goals ({0} – {1}), and low-scoring games end level more often.", { 0: p.expectedGoals.home, 1: p.expectedGoals.away }))
    if (p.drawStreak && Math.min(p.drawStreak.home, p.drawStreak.away) >= 0.32)
      draw.push(t('Both teams drew a lot recently, but streaks like that rarely last, so we do not add extra weight for it.'))
    if (!draw.length) draw.push(t("A draw is a real option at {0}.", { 0: pctR(p.draw) }))
  } else if (g.matchType === 'mismatch') draw.push(t("A draw is unlikely ({0}): the gap between the teams is big.", { 0: pctR(p.draw) }))

  // --- caution
  let caution: string | null = null
  if (p.confidence === 'low') caution = t('Few games played yet for one of the teams, so treat this one with extra care.')
  else if (upcoming && g.rows.some(r => r.id === '#12' && r.note === 'XI not published yet'))
    caution = t('Lineups are not out yet — this can change about an hour before kick-off.')

  return { dcHeadline, headline, forPick, against, draw, caution }
}

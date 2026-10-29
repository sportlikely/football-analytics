import { t } from '../../../lib/i18n'
import { whyView, MARKET, type Factor, type Idle } from '../../../lib/whyFactors'

/**
 * fix282: "Why we think so" — one panel, every sport. fix282b: no count of factors anywhere a visitor sees (Yarin, 29 Oct: "I don't like when the model writes Barça will win
 * because they have a better squad value, there are many other things"). Every factor the model used for this game,
 * ranked by its share of the edge (its points / the sum of every factor's |points|, from the model's own sums:
 * lib/whyFactors.ts), a bar leaning to the side it helps (lime = the favourite's side, grey = the other), the factors
 * with no effect and why, and one closing line from the top factors and the strongest one against the favourite.
 */

/** the factors' names (keys from lib/whyFactors: football row ids, bb.* / nfl.* / tn.*, market) */
export function factorName(k: string): string {
  switch (k) {
    case '#1': return t('Squad value')
    case '#1e': return t('Overall strength')
    case '#1p': return t('Player quality')
    case '#12': return t('Confirmed lineups')
    case '#13': return t('Missing players')
    case '#19': return t('Attack')
    case '#14': return t('Defence')
    case 'goals': return t('Goals: attack and defence')
    case '#10': return t('Rest and fixture load')
    case 'rest': return t('Rest')
    case '#23': return t('Home and away record')
    case 'home': return t('Home advantage')
    case '#7': return t('Head-to-head')
    case '#21': return t('Recent form')
    case 'bb.impact': return t('Player impact')
    case 'bb.net100': return t('Net rating')
    case 'bb.team': return t('Team rating')
    case 'bb.missing': return t('Missing players')
    case 'bb.fourFactors': return t('Four factors')
    case 'bb.rest': return t('Rest')
    case 'bb.home': return t('Home court')
    case 'bb.carry': return t('Season carry-over')
    case 'bb.matchup': return t('Matchups')
    case 'bb.form': return t('Recent form')
    case 'bb.motivation': return t('Motivation')
    case 'bb.h2h': return t('Head-to-head')
    case 'bb.talent': return t('Player talent')
    case 'nfl.rating': return t('Team rating')
    case 'nfl.home': return t('Home field')
    case 'nfl.rest': return t('Rest')
    case 'nfl.qb': return t('Quarterbacks')
    case 'tn.rating': return t('Rating on this surface')
    case 'tn.serve': return t('Serve and return')
    case 'tn.fatigue': return t('Fatigue')
    case 'tn.stoppage': return t('Medical stoppage')
    case 'tn.home': return t('Home crowd')
    case 'tn.surface': return t('Surface switch')
    case 'tn.rank': return t('Ranking trend')
    case MARKET: return t('Where the market stands — used inside the model only')
    default: return t('Other')
  }
}

function idleText(i: Idle): string {
  switch (i) {
    case 'meetings': return t('not enough meetings')
    case 'missing': return t('no key player missing')
    case 'lineups': return t('line-ups not out yet: we check again 1 hour before kick-off')
    case 'starters': return t('every usual starter is in the line-up')
    case 'covered': return t('counted in the confirmed line-ups')
    case 'nodata': return t('no data for this game yet')
    case 'neutral': return t('neutral ground: no home side')
    case 'rest': return t('same rest for both sides')
    default: return t('level for both sides')
  }
}

export default function WhyPanel({ factors, fav, home, away, favPct, otherPct, className = '' }: {
  factors: Factor[]
  /** the favourite by the shown chances */
  fav: 'H' | 'A' | null
  home: string
  away: string
  /** the favourite's win chance, % (under 55 = too close to call) */
  favPct: number | null
  /** the other side's win chance, % */
  otherPct: number | null
  className?: string
}) {
  const v = whyView(factors, fav)
  if (!v.n) return null
  const name = (s: 'H' | 'A') => (s === 'H' ? home : away)
  const max = Math.max(1, ...v.rows.map(r => r.share))
  // fix282b (Yarin, 29 Oct): never say how many factors we use — the heading names the favourite, not a count
  const heading = v.fav && v.rows.length && favPct !== null && favPct >= 55
    ? t('{0} are the favourite. Here is what tips it, from the biggest push to the smallest.', { 0: name(v.fav) })
    : t('Too close to call. Here is what pushes each way.')
  const other: 'H' | 'A' | null = v.fav ? (v.fav === 'H' ? 'A' : 'H') : null
  const closing = v.fav ? [
    v.lead.length ? t('Biggest reasons for {0}: {1}.', { 0: name(v.fav), 1: v.lead.map(r => factorName(r.k)).join(', ') }) : '',
    v.against && other
      ? (otherPct !== null ? t('{0}: the edge goes to {1}, which keeps a win for {1} possible ({2}%).', { 0: factorName(v.against.k), 1: name(other), 2: Math.round(otherPct) }) : t('{0}: the edge goes to {1}.', { 0: factorName(v.against.k), 1: name(other) }))
      : t('Nothing in the numbers points the other way.')
  ].filter(Boolean).join(' ') : ''

  return (
    <div className={`rounded-2xl border border-line/60 bg-surface2/30 p-4 ${className}`} data-why-panel>
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-accent">{t('Why we think so')}</div>
      <p className="mt-1.5 text-sm font-semibold text-ink leading-snug">{heading}</p>
      {v.rows.length > 0 && (
        <>
          <div className="mt-3 flex items-baseline justify-between gap-2 text-[11px] text-faint">
            <span className="truncate">{home}</span>
            <span className="font-semibold">{t('share')}</span>
            <span className="truncate text-end">{away}</span>
          </div>
          <ul className="mt-1 divide-y divide-line/40">
            {v.rows.map(r => {
              const w = (r.share / max) * 50
              return (
                <li key={r.k} className="py-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={`text-sm ${r.k === MARKET ? 'text-muted' : 'font-semibold text-ink'}`}>{factorName(r.k)}</span>
                    <span className={`num text-xs font-bold whitespace-nowrap ${r.forFav ? 'text-accent' : 'text-muted'}`}>{r.share > 0 ? `${r.share}%` : '<1%'}</span>
                  </div>
                  <div className="mt-1 relative h-2 rounded-full bg-surface2" aria-hidden>
                    <span className="absolute start-1/2 top-[-3px] bottom-[-3px] w-px bg-line" />
                    <span
                      className={`absolute top-0 bottom-0 rounded-full ${r.forFav ? 'bg-accent' : 'bg-faint/50'} ${r.side === 'H' ? 'end-1/2' : 'start-1/2'}`}
                      style={{ width: `${Math.max(2, w)}%` }}
                    />
                  </div>
                  <div className="mt-0.5 text-[11px] text-faint">{t('helps {0}', { 0: name(r.side) })}</div>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {v.idle.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] font-semibold text-faint">{t('No effect in this game')}</div>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {v.idle.map(i => <li key={i.k}><span className="text-ink">{factorName(i.k)}</span> · {idleText(i.idle)}</li>)}
          </ul>
        </div>
      )}
      {closing && <p className="mt-3 text-sm text-muted leading-snug">{closing}</p>}
    </div>
  )
}

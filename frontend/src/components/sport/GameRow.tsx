import { Link } from 'react-router-dom'
import { t as tt, LOCALE } from '../../lib/i18n'
import { useReveal, justRevealed } from '../../lib/reveal'
import { useAuth } from '../../lib/auth'
import { Crest } from '../SportHome/parts'
import type { HPred } from '../SportHome/types'
import type { SGame } from './types'
import RowBody, { type RowPred, type RowTeam } from './prediction/RowBody'
import { ScorersToggle, RowScorersLine, scorersSource, useScorersOpen } from './RowScorers'

/**
 * fix152 — the one list row of every sport; fix281: time / live · both names left / right with the split bar under
 * them (our side in accent) and one "Our pick" line coloured by band (components/sport/prediction/RowBody). Covered →
 * grey bar + Reveal, locked → grey bar + lock, finished → ✓ / ✗. The whole row opens the game page.
 */

const time = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })

/** the row's prediction as the shared row body draws it */
export function rowPred(p: HPred, covered: boolean, reveal: () => void, roll = false): RowPred {
  if (p.kind === 'full' && covered) return { kind: 'covered', n: p.cells.length, onReveal: reveal }
  if (p.kind === 'full') return { kind: 'open', cells: p.cells.map(c => ({ key: c.key as 'H' | 'D' | 'A', pct: c.pct, on: c.on })), pick: p.pick ? { words: p.pick.words, pct: p.pick.pct, help: p.pick.help } : null, roll }
  if (p.kind === 'locked') return { kind: 'locked', n: (p.heads || ['1', '2']).length, pick: p.pick?.words || null }
  return { kind: 'none' }
}

export default function GameRow({ g, showComp = false, showDay = false }: { g: SGame; showComp?: boolean; showDay?: boolean }) {
  const isLive = g.state === 'live', done = g.state === 'done'
  const p = g.pred
  const { access } = useAuth()
  // fix160: admins always see the numbers in lists; members with "guess first" get the blurred block + Reveal
  const { hidden: covered, reveal } = useReveal(g.reveal?.id, g.reveal?.status, p.kind === 'full' && !!g.reveal && access !== 'admin')
  const roll = g.reveal ? justRevealed(g.reveal.id) : false
  const full = p.kind === 'full' && !covered ? p : null
  const onSide = (k: 'H' | 'A') => !!full?.cells.find(c => c.key === k)?.on
  const side = (k: 'H' | 'A'): RowTeam => {
    const t = k === 'H' ? g.home : g.away
    return {
      name: t.name, short: t.short, logo: <Crest team={t} size={15} />, score: g.live ? g.live.score[k === 'H' ? 0 : 1] : null, live: isLive, bold: onSide(k),
      extra: t.rank ? <span className="ms-1 text-[10px] font-semibold text-faint num">{t.rank}</span> : null
    }
  }
  // fix209: a live / finished row opens with its arrow to the scorers line (collapsed by default)
  const [scOpen, scToggle] = useScorersOpen()
  const scorable = (isLive || done) && !!scorersSource(g.href)
  return (
    <div>
    <Link to={g.href} state={g.linkState} className={`group relative flex items-center gap-2.5 px-3 sm:px-4 py-2 hover:bg-surface2/50 transition-colors ${isLive ? 'bg-live/[0.06]' : ''}`}>
      {isLive && <span className="absolute start-0 inset-y-0 w-0.5 bg-live" aria-hidden />}
      <div className="relative w-10 flex-shrink-0 text-center leading-tight">
        {g.favWhy.length > 0 && (
          <span className="absolute -start-2.5 sm:-start-3 top-1/2 -translate-y-1/2 text-accent" title={tt("Favorite: {0}", { 0: g.favWhy.join(', ') })}>
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
          </span>
        )}
        {isLive ? (
          <>
            <span className="block text-[11px] font-bold text-live">{g.live?.label || tt("LIVE")}</span>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />
          </>
        ) : done ? (
          <span className="block text-[11px] font-bold text-faint">{tt("Final")}</span>
        ) : (
          <>
            <span className="block num text-[12px] text-ink/90">{time(g.kickoff)}</span>
            {showDay && <span className="block text-[10px] text-faint">{new Date(g.kickoff).toLocaleDateString(LOCALE, { weekday: 'short' })}</span>}
          </>
        )}
      </div>

      <RowBody
        top={showComp ? (
          <div className="flex items-center gap-1 text-[10px] text-faint mb-0.5 truncate">
            {g.competition.emblem && <img src={g.competition.emblem} alt="" className="w-3 h-3 object-contain" />}
            <span className="truncate">{g.competition.name}</span>
          </div>
        ) : undefined}
        home={side('H')} away={side('A')} pred={rowPred(p, covered, reveal, roll)}
        note={g.note && !covered ? <span className={`block mt-0.5 text-[10px] font-bold truncate ${g.note.tone === 'live' ? 'text-live' : g.note.tone === 'muted' ? 'text-faint font-semibold' : 'text-loss'}`}>{g.note.text}</span> : undefined}
      />

      <div className="flex-shrink-0 flex items-center justify-end gap-1.5">
        {done && typeof g.hit === 'boolean' && (
          <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold ${g.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`} title={g.hit ? tt("Hit") : tt("Miss")}>{g.hit ? '✓' : '✗'}</span>
        )}
        {scorable && <ScorersToggle open={scOpen} onToggle={scToggle} />}
      </div>
    </Link>
      {scOpen && <RowScorersLine href={g.href} live={isLive} homeName={g.home.short} awayName={g.away.short} className="px-3 sm:px-4 pb-2 ps-[3.6rem] sm:ps-[4.1rem]" />}
    </div>
  )
}

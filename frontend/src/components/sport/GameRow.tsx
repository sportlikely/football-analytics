import { Link } from 'react-router-dom'
import { t as tt, LOCALE } from '../../lib/i18n'
import { useReveal, justRevealed } from '../../lib/reveal'
import { useAuth } from '../../lib/auth'
import CountUp from '../CountUp'
import { DcHelp, EvenChip, isEvenGame } from '../DcPick'
import { Crest, Lock } from '../SportHome/parts'
import type { HPred } from '../SportHome/types'
import type { SGame } from './types'
import { ScorersToggle, RowScorersLine, scorersSource, useScorersOpen } from './RowScorers'

/**
 * fix152 — the one list row of every sport (football's MatchRow, fix127): time / live · both teams · the result cells
 * with their % (our pick highlighted) and "Our pick · {words} · %" under them, then the sport's side chips on wide
 * screens (football: Over 2.5 / Both score; basketball + NFL: Margin / Total pts). Covered → Reveal, locked → lock,
 * finished → ✓ / ✗. The whole row opens the game page.
 */

const time = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })

/** The fix127 block: cells + "Our pick" line (+ Strong). */
export function PredBlock({ pred, roll = false }: { pred: Extract<HPred, { kind: 'full' }>; roll?: boolean }) {
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        {pred.cells.map((c, i) => (
          <span key={c.key} className={`w-9 h-7 rounded-md grid place-items-center leading-none border transition-colors ${c.on ? 'border-accent/70 bg-accent/15 text-ink' : 'border-transparent bg-surface2/40 text-faint'} ${roll ? 'pop-in' : ''}`}
            style={roll ? { animationDelay: `${i * 90}ms` } : undefined} title={c.label}>
            <span className={`text-[8px] font-bold ${c.on ? 'text-accent' : ''}`}>{c.head}</span>
            <CountUp value={Math.round(c.pct)} animate={roll} delay={i * 90} className="num text-[11px] font-bold" />
          </span>
        ))}
      </span>
      {pred.pick && (
        <span className="flex items-center gap-1 text-[10px] leading-none whitespace-nowrap">
          <span className="text-faint">{tt("Our pick")}</span>
          {pred.pick.help ? <DcHelp /> : <span aria-hidden className="text-faint">·</span>}
          {/* fix193b: a long name gives way on phones (never pushes the % off a narrow card) */}
          <span className="font-bold text-ink min-w-0 max-w-[7.5rem] sm:max-w-none truncate">{pred.pick.words}</span>
          {pred.pick.pct !== null && <><span aria-hidden className="text-faint">·</span><span className="num font-extrabold text-accent">{pred.pick.pct}%</span></>}
        </span>
      )}
      {pred.pick?.strong && <span className="rounded-full border border-accent/50 text-accent text-[9px] font-bold px-1.5 py-px leading-none whitespace-nowrap">{tt("Strong")}</span>}
      {/* fix179: home vs away within 3 points (first and last cell: 1 · X · 2 or 1 · 2) */}
      {pred.cells.length >= 2 && isEvenGame(pred.cells[0].pct, pred.cells[pred.cells.length - 1].pct) && <EvenChip />}
    </span>
  )
}

/**
 * fix160: the same block with the numbers hidden — covered by "guess first" (the real cells blurred, an eye control
 * under them) or locked for the plan (placeholder cells, a lock and the pick in words when it is free to see).
 * Never a bare button: every row of every sport keeps the fix127 shape.
 */
function HiddenBlock({ heads, onReveal, pick }: { heads: string[]; onReveal?: () => void; pick?: string | null }) {
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex items-center gap-1" aria-hidden>
        {heads.map(h => (
          <span key={h} className="w-9 h-7 rounded-md grid place-items-center leading-none border border-transparent bg-surface2/40 text-faint">
            <span className="text-[8px] font-bold">{h}</span>
            <span className="num text-[11px] font-bold blur-[3px] select-none">00</span>
          </span>
        ))}
      </span>
      {onReveal ? (
        <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); onReveal() }}
          className="inline-flex items-center gap-1 text-[10px] leading-none font-bold text-accent hover:underline whitespace-nowrap">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          {tt("Reveal")}
        </button>
      ) : (
        <span className="flex items-center gap-1 text-[10px] leading-none whitespace-nowrap text-faint">
          <Lock />
          {pick ? <><span>{tt("Our pick")}</span><span aria-hidden>·</span><span className="font-bold text-ink">{pick}</span></> : <span>{tt("Locked")}</span>}
        </span>
      )}
    </span>
  )
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
  // fix209: a live / finished row opens with its arrow to the scorers line (collapsed by default)
  const [scOpen, scToggle] = useScorersOpen()
  const scorable = (isLive || done) && !!scorersSource(g.href)
  return (
    <div>
    <Link to={`${g.href}${p.kind !== 'none' ? '#prediction' : ''}`} state={g.linkState} className={`group relative flex items-center gap-2.5 px-3 sm:px-4 py-1.5 hover:bg-surface2/50 transition-colors ${isLive ? 'bg-live/[0.06]' : ''}`}>
      {isLive && <span className="absolute left-0 inset-y-0 w-0.5 bg-live" aria-hidden />}
      <div className="relative w-10 flex-shrink-0 text-center leading-tight">
        {g.favWhy.length > 0 && (
          <span className="absolute -left-2.5 sm:-left-3 top-1/2 -translate-y-1/2 text-accent" title={tt("Favorite: {0}", { 0: g.favWhy.join(', ') })}>
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

      <div className="flex-1 min-w-0">
        {showComp && (
          <div className="flex items-center gap-1 text-[10px] text-faint mb-0.5 truncate">
            {g.competition.emblem && <img src={g.competition.emblem} alt="" className="w-3 h-3 object-contain" />}
            <span className="truncate">{g.competition.name}</span>
          </div>
        )}
        {(['H', 'A'] as const).map((side, i) => {
          const t = side === 'H' ? g.home : g.away
          const score = g.live ? g.live.score[i] : null
          return (
            <div key={side} className="flex items-center gap-2 min-w-0 h-5">
              <Crest team={t} size={15} />
              <span data-testid="team-name" className={`text-[13px] truncate ${onSide(side) ? 'font-bold text-ink' : 'text-ink/85'}`}>
                <span className="sm:hidden">{t.short}</span><span className="hidden sm:inline">{t.name}</span>
                {t.rank ? <span className="ml-1 text-[10px] font-semibold text-faint num">{t.rank}</span> : null}
              </span>
              {score !== null && <span className="ml-auto pl-2 num text-[13px] font-extrabold tabular-nums text-live">{score}</span>}
            </div>
          )
        })}
        {g.note && !covered && <span className={`block text-[10px] font-bold truncate ${g.note.tone === 'live' ? 'text-live' : g.note.tone === 'muted' ? 'text-faint font-semibold' : 'text-loss'}`}>{g.note.text}</span>}
        {full && g.chips.length > 0 && (
          <div className={`lg:hidden flex flex-wrap gap-x-3 text-[10px] text-muted ${roll ? 'pop-in' : ''}`}>
            {g.chips.map(c => <span key={c.key} className="whitespace-nowrap">{c.label} <span className={`num font-semibold ${c.strong ? 'text-accent' : 'text-ink'}`}>{c.value}</span></span>)}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center justify-end gap-1.5 min-w-[84px] sm:min-w-[150px]">
        {covered && p.kind === 'full' ? (
          <HiddenBlock heads={p.cells.map(c => c.head)} onReveal={reveal} />
        ) : full ? (
          <span className="flex items-center gap-1">
            <PredBlock pred={full} roll={roll} />
            {g.chips.length > 0 && (
              <>
                <span className="hidden lg:block w-px h-5 bg-line mx-1" aria-hidden />
                {g.chips.map((c, i) => (
                  <span key={c.key} title={c.title}
                    className={`hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border ${c.strong ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line/70 text-muted'} ${roll ? 'pop-in' : ''}`}
                    style={roll ? { animationDelay: `${300 + i * 90}ms` } : undefined}>
                    <span className="text-[8px] font-bold opacity-75 whitespace-nowrap">{c.label}</span>
                    <span className="num text-[11px] font-bold text-ink">{c.value}</span>
                  </span>
                ))}
              </>
            )}
          </span>
        ) : p.kind === 'locked' ? (
          <HiddenBlock heads={p.heads || ['1', '2']} pick={p.pick?.words || null} />
        ) : (
          <span className="text-xs text-faint">–</span>
        )}
        {done && typeof g.hit === 'boolean' && (
          <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold ${g.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`} title={g.hit ? tt("Hit") : tt("Miss")}>{g.hit ? '✓' : '✗'}</span>
        )}
        {scorable && <ScorersToggle open={scOpen} onToggle={scToggle} />}
      </div>
    </Link>
      {scOpen && <RowScorersLine href={g.href} live={isLive} homeName={g.home.short} awayName={g.away.short} className="px-3 sm:px-4 pb-2 pl-[3.6rem] sm:pl-[4.1rem]" />}
    </div>
  )
}

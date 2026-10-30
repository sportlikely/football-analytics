import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { t, LOCALE } from '../../../lib/i18n'
import { useTabPath } from '../../../lib/tabPath'
import StickyBar from '../../StickyBar'
import { useNews, NewsRows, type NewsItem } from '../../NewsList'
import { hasScorerLine, type ScorerLines } from '../../../lib/scorers'
import { HeaderScorers } from './ScoreLines'
import GameLayout, { useGameCols } from './GameLayout'

/**
 * The game page (football's match page, shared by every sport since fix152c): back link, the hero (competition ·
 * round · date, both teams, score or start time, status), the sport's lines under it, sticky tabs and the open tab.
 * The prediction tab (always the first) ends with a card per other tab. Each sport's page gives the data and the
 * tabs' content; the layout lives here. fix284: inside GameLayout — on PC the preview (left) and "Your picks" (right)
 * sit beside the game on every tab; on phones the preview is above the tabs and the page puts <GamePicksSlot /> after
 * its prediction block.
 */
export interface GameTab { id: string; label: string; short?: string; hint: string; live?: boolean; render: () => ReactNode }
export interface HeroSide { name: string; logo: ReactNode; href: string; title?: string; linkLabel: string; star?: ReactNode; sub?: string | null }
export interface GamePageProps {
  back: { to: string; label: string }
  /** next to the back link (NFL: the NFL | College switch) */
  top?: ReactNode
  srTitle?: string
  league: { name: string; href: string; logo?: string | null; star?: ReactNode; bits: string[]; badges?: ReactNode }
  date: string
  home: HeroSide
  away: HeroSide
  score: { home: number | null; away: number | null } | null
  time: string
  /** under the score (football: half-time) */
  scoreSub?: ReactNode
  /** fix209: under both teams, live and final (football: goals + red cards; basketball: top scorer; NFL: scoring
   *  plays). null / empty = no line (an upcoming game). Built with lib/scorers.ts; checked by npm run parity. */
  scorers?: { lines: ScorerLines; playerHref?: (id: number, name: string) => string | null } | null
  status: { kind: 'live' | 'done' | 'halted' | 'upcoming'; text: string }
  statusNote?: ReactNode
  /** colour of the pick's glow ('--home' / '--away' / '--draw') */
  pickVar?: string | null
  /** the hero's bottom line (football: venue · referee · attendance; basketball: score by quarter) */
  footer?: ReactNode
  /** between the hero and the tabs */
  afterHero?: ReactNode
  /** fix284: "Game preview" (GamePreview, English pages) and "Your picks" (YourPicks): GameLayout places them */
  preview?: ReactNode
  picks: ReactNode
  tabs: GameTab[]
  tab: string
  onTab: (id: string) => void
}

/** Football's hero date and time: "Saturday 18 October 2026", "20:45". */
export const fmtGameDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
export const fmtGameTime = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })

/** The open tab, kept in the address as a sub-path (fix235: …/match/<slug>/stats) so a link can open it; aliases map
 *  old #hashes. */
export const useGameTab = (ids: string[], aliases: Record<string, string> = {}) => useTabPath(ids, aliases)

export function Section({ title, note, id, action, children }: { title: string; note?: string; id?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="card p-5 sm:p-6 scroll-mt-32 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-base font-bold text-ink">{title}</h2>
        {action || (note && <span className="text-xs text-faint">{note}</span>)}
      </div>
      {children}
    </section>
  )
}

function TeamHero({ s, align }: { s: HeroSide; align: 'left' | 'right' }) {
  return (
    <Link to={s.href} title={s.title}
      className={`flex flex-col items-center text-center gap-2 sm:gap-4 min-w-0 hover:opacity-90 ${align === 'right' ? 'sm:flex-row-reverse sm:text-end' : 'sm:flex-row sm:text-start'}`}>
      {s.logo}
      <div className="min-w-0 w-full sm:w-auto">
        <div className="font-sans font-extrabold text-[15px] sm:font-display sm:text-2xl text-ink leading-tight break-words sm:truncate lg:text-xl lg:whitespace-normal lg:overflow-visible lg:text-clip">{s.name}</div>
        {s.sub && <div className="hidden sm:block text-xs text-faint mt-0.5 truncate">{s.sub}</div>}
        <div className={`flex items-center justify-center gap-1 mt-1 sm:mt-0.5 ${align === 'right' ? 'sm:justify-end' : 'sm:justify-start'}`}>
          {/* fix256: long words (ru "Страница команды →") wrap on phones instead of running out of the hero */}
          <span className="min-w-0 text-[11px] leading-tight text-accent font-semibold sm:whitespace-nowrap">{s.linkLabel}</span>
          {s.star}
        </div>
      </div>
    </Link>
  )
}

/** A team crest in the hero: the picture, or an empty circle. */
export function HeroLogo({ src }: { src: string | null | undefined }) {
  return src ? <img src={src} alt="" className="w-14 h-14 sm:w-[72px] sm:h-[72px] object-contain flex-shrink-0 drop-shadow" />
    : <span className="w-14 h-14 sm:w-[72px] sm:h-[72px] rounded-full bg-surface2 flex-shrink-0" />
}

/** Stories about either team, newest first (every sport's prediction tab). */
export function GameNews({ home, away, title }: { home: Record<string, string | number | undefined>; away: Record<string, string | number | undefined>; title?: string }) {
  const hn = useNews({ ...home, limit: 6 })
  const an = useNews({ ...away, limit: 6 })
  const news: NewsItem[] | null = hn && an ? [...new Map([...hn, ...an].map(n => [n.link, n])).values()].sort((a, b) => (b.published || '').localeCompare(a.published || '')).slice(0, 8) : null
  if (!news || !news.length) return null
  return (
    <Section title={title || t('News about both teams')}>
      <div className="-mx-2"><NewsRows items={news} /></div>
    </Section>
  )
}

export default function GamePage(p: GamePageProps) {
  const { status: st } = p
  const live = st.kind === 'live'
  const current = p.tabs.find(x => x.id === p.tab) || p.tabs[0]
  const cols = useGameCols()
  const tabBox = useKeepScroll()
  const wide = cols === 3 && !!p.preview ? 'max-w-[1672px]' : cols > 1 ? 'max-w-[1348px]' : 'max-w-5xl'
  return (
    <div className={`${wide} mx-auto px-4 sm:px-6 py-6 pb-28 xl:pb-10`}>
      {p.srTitle && <h1 className="sr-only">{p.srTitle}</h1>}
      <GameLayout preview={p.preview} picks={p.picks}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={p.back.to} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors">
          <span aria-hidden className="rtl-flip">←</span> {p.back.label}</Link>
        {p.top}
      </div>

      {/* ---------- Hero ---------- */}
      <div className={`mt-4 card relative overflow-hidden p-4 sm:p-8 ${live ? 'shadow-glow border-live/40' : ''}`}>
        {p.pickVar && (
          <div className="pointer-events-none absolute inset-0 opacity-[0.10]"
            style={{ background: `radial-gradient(700px 260px at 50% 120%, rgb(var(${p.pickVar})), transparent 70%)` }} />
        )}
        {/* competition · round · date — centred and stacked on phones, one line on wider screens */}
        <div className="relative mb-5 sm:mb-6 flex flex-col items-center gap-1 text-center sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:text-start text-sm text-muted">
          <div className="min-w-0 max-w-full flex flex-col items-center gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <span className="inline-flex items-center gap-2 max-w-full min-w-0">
              <Link to={p.league.href} className="inline-flex items-center gap-2 min-w-0 hover:text-ink">
                {p.league.logo && <img src={p.league.logo} alt="" className="w-5 h-5 object-contain shrink-0" />}
                <span className="font-semibold text-ink/90 hover:underline truncate">{p.league.name}</span>
              </Link>
              {p.league.star}
            </span>
            {p.league.bits.length > 0 && (
              <span className="text-xs sm:text-sm text-faint sm:whitespace-nowrap"><span className="hidden sm:inline">· </span>{p.league.bits.join(' · ')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs sm:text-sm">
            {p.league.badges}
            <span className="text-faint whitespace-nowrap">{p.date}</span>
          </div>
        </div>

        <div className="relative grid grid-cols-[1fr_auto_1fr] items-start sm:items-center gap-2 sm:gap-8">
          <TeamHero s={p.home} align="right" />
          <div className="text-center min-w-[96px] sm:min-w-[170px] self-center">
            {p.score ? (
              <div className="num text-5xl sm:text-6xl font-extrabold text-ink tracking-tight">
                {p.score.home ?? 0}<span className="text-faint mx-2 font-light">:</span>{p.score.away ?? 0}
              </div>
            ) : (
              <div className="num text-4xl sm:text-5xl font-extrabold text-ink tracking-tight">{p.time}</div>
            )}
            {p.scoreSub}
            <div className={`mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider px-3 py-1 rounded-full border ${
              live ? 'bg-live/10 text-live border-live/30' : st.kind === 'halted' ? 'bg-loss/10 text-loss border-loss/30' : st.kind === 'done' ? 'bg-surface2 text-muted border-line' : 'bg-accent/10 text-accent border-accent/30'}`}>
              {live && <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />}
              {st.text.toUpperCase()}
            </div>
            {p.statusNote}
          </div>
          <TeamHero s={p.away} align="left" />
        </div>
        {p.scorers && hasScorerLine(p.scorers.lines) && <HeaderScorers lines={p.scorers.lines} playerHref={p.scorers.playerHref} />}

        {p.footer && <div className="relative mt-6 pt-4 border-t border-line/60">{p.footer}</div>}
      </div>

      {p.afterHero}
      {cols === 1 && p.preview && <div className="mt-4">{p.preview}</div>}

      {/* ---------- Tabs ---------- */}
      <StickyBar className="top-16 sm:top-[72px] -mx-4 sm:mx-0 mt-6 px-4 sm:px-0 py-2">
        <nav className="flex gap-1 p-1 rounded-full bg-surface2/60 border border-line/60 overflow-x-auto no-scrollbar" aria-label={t('Game sections')} data-testid="game-tabs">
          {p.tabs.map(x => (
            <button key={x.id} type="button" onClick={() => p.onTab(x.id)} aria-current={current.id === x.id ? 'page' : undefined}
              className={`flex-1 min-w-max inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-4 py-2 rounded-full text-[13px] sm:text-sm font-semibold transition-colors ${current.id === x.id ? 'bg-accent text-bg shadow' : 'text-muted hover:text-ink'}`}>
              {x.short ? (<><span className="sm:hidden">{x.short}</span><span className="hidden sm:inline">{x.label}</span></>) : x.label}
              {x.live && <span className={`w-1.5 h-1.5 rounded-full animate-pulseDot ${current.id === x.id ? 'bg-bg' : 'bg-live'}`} />}
            </button>
          ))}
        </nav>
      </StickyBar>

      <div ref={tabBox} className="mt-4 space-y-6 min-w-0" data-game-tab>
        {current.render()}
        {current.id === p.tabs[0].id && p.tabs.length > 1 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {p.tabs.slice(1).map(x => (
              <button key={x.id} type="button" onClick={() => p.onTab(x.id)} className="card p-4 text-start hover:border-accent/50 transition-colors">
                <div className="font-display font-bold text-ink">{x.label} <span aria-hidden className="text-accent rtl-flip">→</span></div>
                <div className="text-xs text-muted mt-1">{x.hint}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      </GameLayout>
    </div>
  )
}

/**
 * fix284b: a move between the game's own sub-paths (a tab, a topic, back / forward) keeps the scroll position: the tab
 * area keeps at least the height it had (a shorter tab would make the browser pull the page up) and the position is put
 * back before the frame is painted. Another page is a new GamePage (App's PageGuard keys on the item).
 */
function useKeepScroll() {
  const box = useRef<HTMLDivElement>(null)
  const keep = useRef({ h: 0, y: 0, path: '' })
  const { pathname } = useLocation()
  useEffect(() => {
    const el = box.current
    const note = () => { keep.current.y = window.scrollY; if (el) keep.current.h = el.offsetHeight }
    note()
    window.addEventListener('scroll', note, { passive: true })
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (el) keep.current.h = el.offsetHeight }) : null
    if (el) ro?.observe(el)
    return () => { window.removeEventListener('scroll', note); ro?.disconnect() }
  }, [])
  useLayoutEffect(() => {
    const k = keep.current, el = box.current
    if (k.path && k.path !== pathname && el) {
      const y = k.y
      el.style.minHeight = `${k.h}px`
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y)
      k.y = y
    }
    k.path = pathname
  }, [pathname])
  return box
}

/** fix175: half-time score from quarter scores (basketball, NFL), shown under the score like football's "HT 1–0". */
export function halfTimeOf(q: { home: (number | null)[]; away: (number | null)[] } | null | undefined): { home: number; away: number } | null {
  if (!q || q.home.length < 2 || q.away.length < 2 || [q.home[0], q.home[1], q.away[0], q.away[1]].some(x => x === null || x === undefined)) return null
  // only once the third quarter has started (or the game is over): the caller passes the quarters it shows
  if (q.home[2] === null || q.home[2] === undefined) return null
  return { home: (q.home[0] as number) + (q.home[1] as number), away: (q.away[0] as number) + (q.away[1] as number) }
}

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { t, LOCALE } from '../../lib/i18n'
import { useReveal, justRevealed } from '../../lib/reveal'
import CountUp from '../../components/CountUp'
import { LeagueBar } from '../../components/LeagueSidebar'
import { BB_STATUS, BB_COUNTRY, liveLabel, bbRank, timeOf, useBbFavorites, type BbGame, type BbSide } from '../../lib/bb'
import { useStuck, stuckBg } from '../../lib/useStuck'
import { LiveChancePanel } from '../../components/sport/game/LiveChance'
import { ScorersToggle, RowScorersLine, useScorersOpen } from '../../components/sport/RowScorers'
import { leagueHref, matchHref } from '../../lib/links'

/** Shared pieces of the basketball pages — the same look as the football pages. */

/** Reveal ids for basketball games (negative, so they never clash with football match ids). */
export const rid = (g: { id: number }) => -g.id
/** Status the reveal helper understands: finished games are never covered. */
export const rstatus = (g: BbGame) => (g.state === 'done' ? 'FT' : g.status)

const PICK_COLOR = { H: 'text-home', A: 'text-away' } as const

export function Card({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          {title && <h2 className="font-display text-base sm:text-lg font-bold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Football-style section title over rails and lists. */
export function SectionTitle({ label, sub, count, sticky }: { label: string; sub?: string; count?: number; sticky?: boolean }) {
  const [ref, stuck] = useStuck<HTMLDivElement>()
  return (
    <div ref={sticky ? ref : undefined} className={`flex items-baseline gap-3 mb-3 ${sticky ? `sticky top-[113px] sm:top-16 z-30 py-2 -my-2 ${stuckBg(stuck)}` : ''}`}>
      <h2 className="font-display text-lg font-bold tracking-tight text-ink">{label}</h2>
      {count !== undefined && <span className="num text-xs text-faint">{t('{0} games', { 0: count })}</span>}
      {sub && <span className="text-xs text-faint">{sub}</span>}
    </div>
  )
}

export function TeamLogo({ team, size = 22 }: { team: BbSide | { name: string; logo: string | null }; size?: number }) {
  const [broken, setBroken] = useState(false)
  return team.logo && !broken ? (
    <img src={team.logo} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} className="object-contain flex-shrink-0 drop-shadow-sm" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-full bg-surface2 border border-line/60 grid place-items-center font-display font-bold text-muted flex-shrink-0 leading-none" style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.36)) }} title={team.name}>
      {initials(team.name)}
    </span>
  )
}

/** "Tokyo Sunrockers" → "TS", "Bayern" → "BAY". */
export const initials = (raw: string | null | undefined) => {
  const name = typeof raw === 'string' && raw.trim() ? raw : '?' // fix151: no name → "?"
  const w = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(x => x.length > 1 || /\d/.test(x))
  return (w.length >= 2 ? w.slice(0, 2).map(x => x[0]).join('') : (w[0] || name).slice(0, 3)).toUpperCase()
}

export function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/**
 * One game as a thin row, like football's: time · both teams · our pick (1 / 2 with the pick highlighted, then the
 * spread and total points on wide screens). Covered picks show a Reveal button; locked picks a lock. Finished games
 * show the score and whether we were right.
 */
export function GameRow({ g, showLeague = false, showDay = false, compact = false }: { g: BbGame; showLeague?: boolean; showDay?: boolean; compact?: boolean }) {
  const p = g.prediction
  const { hidden: covered, reveal } = useReveal(rid(g), rstatus(g), !!p && !p.locked)
  const isLive = g.state === 'live'
  const done = g.state === 'done'
  const pick = p && !covered ? p.pick : null
  const pct = p && pick && !p.locked && typeof p.pHome === 'number' ? Math.round(pick === 'H' ? p.pHome : p.pAway!) : null
  const pickName = pick === 'H' ? g.home.name : pick === 'A' ? g.away.name : null
  const roll = justRevealed(rid(g))
  const won = (side: 'H' | 'A') => done && g.score ? (side === 'H' ? g.score.home > g.score.away : g.score.away > g.score.home) : false
  const favWhy = useBbFavorites().reasons(g)
  // fix209: a live / finished row opens with its arrow to each team's top scorer
  const [scOpen, scToggle] = useScorersOpen()

  return (
    <div>
    <Link to={matchHref('basketball', g.id, { home: g.home.name, away: g.away.name, homeId: g.home.id, awayId: g.away.id, date: g.kickoff }) ?? ''} className={`group relative flex items-center gap-2.5 px-3 sm:px-4 py-1.5 hover:bg-surface2/50 transition-colors ${isLive ? 'bg-live/[0.06]' : ''}`}>
      {isLive && <span className="absolute start-0 inset-y-0 w-0.5 bg-live" aria-hidden />}
      {/* time / status */}
      <div className="relative w-10 flex-shrink-0 text-center leading-tight">
        {favWhy.length > 0 && (
          <span className="absolute -start-2.5 sm:-start-3 top-1/2 -translate-y-1/2 text-accent" title={t('Favorite: {0}', { 0: favWhy.map(f => f.name).join(', ') })}>
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
          </span>
        )}
        {isLive ? (
          <>
            <span className="block text-[11px] font-bold text-live">{BB_STATUS[g.status] || t('LIVE')}</span>
            {g.clock ? <span className="block text-[10px] font-bold text-live num whitespace-nowrap">{g.clock.left}'<span className="animate-pulseDot">·</span></span> : <span className="inline-block w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />}
          </>
        ) : done ? (
          <span className="block text-[11px] font-bold text-faint">{BB_STATUS[g.status] || t('Final')}</span>
        ) : g.state === 'off' ? (
          <span className="block text-[10px] font-bold text-loss">{BB_STATUS[g.status] || g.status}</span>
        ) : (
          <>
            <span className="block num text-[12px] text-ink/90">{timeOf(g.kickoff)}</span>
            {showDay && <span className="block text-[10px] text-faint">{new Date(g.kickoff).toLocaleDateString(LOCALE, { weekday: 'short' })}</span>}
          </>
        )}
      </div>

      {/* teams */}
      <div className="flex-1 min-w-0">
        {showLeague && <div className="text-[10px] text-faint mb-0.5 truncate">{g.league.name}</div>}
        {(['H', 'A'] as const).map(side => {
          const team = side === 'H' ? g.home : g.away
          const score = g.score && g.state !== 'upcoming' ? (side === 'H' ? g.score.home : g.score.away) : null
          return (
            <div key={side} className="flex items-center gap-2 min-w-0 h-5">
              <TeamLogo team={team} size={15} />
              <span className={`text-[13px] truncate ${pick === side || won(side) ? 'font-bold text-ink' : 'text-ink/85'}`}>{team.name}</span>
              {score !== null && <span className={`ms-auto ps-2 num text-[13px] font-extrabold tabular-nums ${isLive ? 'text-live' : done && !won(side) ? 'text-muted' : 'text-ink'}`}>{score}</span>}
            </div>
          )
        })}
      </div>

      {/* prediction */}
      {compact ? (
        <div className="flex-shrink-0 flex flex-col items-end gap-0.5 max-w-[96px]">
          {pickName && <span className={`text-[11px] font-semibold truncate max-w-full ${PICK_COLOR[pick!]}`}>{pickName}</span>}
          {done && p?.hit !== null && p?.hit !== undefined && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${p.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{p.hit ? t('Hit') : t('Miss')}</span>
          )}
        </div>
      ) : (
      <div className="flex-shrink-0 flex items-center justify-end min-w-[84px] sm:min-w-[150px] gap-1.5">
        {covered ? (
          <button
            type="button"
            onClick={e => { e.preventDefault(); e.stopPropagation(); reveal() }}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] font-bold bg-accent/10 text-accent border border-accent/30 hover:bg-accent/15"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {t('Reveal')}
          </button>
        ) : p && p.locked ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-faint">
            <LockIcon /> {pickName ? <span className={`font-semibold truncate max-w-[110px] ${PICK_COLOR[pick!]}`}>{pickName}</span> : t('Locked')}
          </span>
        ) : isLive && p?.live ? (
          <LiveRowPct g={g} />
        ) : p && pick && pct !== null ? (
          <>
            {/* fix132 (all screen sizes): the fix127 block — 1 · 2 cells (our pick lime, the other dimmed) and
                "Our pick · team · %" under them; spread and total next to it on wide screens */}
            <span className="flex items-center gap-1">
              <BbPickBlock p={p} pick={pick} home={bbShort(g.home.name, g.league.code)} away={bbShort(g.away.name, g.league.code)} roll={roll} />
              {typeof p.spread === 'number' && typeof p.total === 'number' && (
                <>
                  <span className="hidden lg:block w-px h-5 bg-line mx-1" aria-hidden />
                  <span className={`hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border border-line/70 text-muted ${roll ? 'pop-in' : ''}`} title={t('Point spread')}>
                    <span className="text-[8px] font-bold opacity-75">{t('Spread')}</span>
                    <span className="num text-[11px] font-bold text-ink">{p.spread >= 0 ? '1' : '2'} −{Math.abs(p.spread).toFixed(1)}</span>
                  </span>
                  <span className={`hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border border-line/70 text-muted ${roll ? 'pop-in' : ''}`} title={t('Total points')}>
                    <span className="text-[8px] font-bold opacity-75">{t('Total')}</span>
                    <span className="num text-[11px] font-bold text-ink">{p.total.toFixed(1)}</span>
                  </span>
                </>
              )}
            </span>
          </>
        ) : (
          <span className="text-xs text-faint">–</span>
        )}
        {done && p?.hit !== null && p?.hit !== undefined && (
          <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold ${p.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`} title={p.hit ? t('Hit') : t('Miss')}>{p.hit ? '✓' : '✗'}</span>
        )}
        {(isLive || done) && <ScorersToggle open={scOpen} onToggle={scToggle} />}
      </div>
      )}
    </Link>
      {scOpen && <RowScorersLine href={matchHref('basketball', g.id, { home: g.home.name, away: g.away.name, homeId: g.home.id, awayId: g.away.id, date: g.kickoff })!} live={isLive} homeName={g.home.name} awayName={g.away.name} className="px-3 sm:px-4 pb-2 ps-[3.6rem] sm:ps-[4.1rem]" />}
    </div>
  )
}

/** A day's games grouped by league (NBA first), each league in its own card with a header — like football. */
export function LeagueCards({ games, logos }: { games: BbGame[]; logos?: Record<string, string | null> }) {
  const by = new Map<string, BbGame[]>()
  for (const g of games) by.set(g.league.code, [...(by.get(g.league.code) || []), g])
  const order = [...by.keys()].sort((a, b) => bbRank(a) - bbRank(b))
  return (
    <div className="space-y-2">
      {order.map(code => {
        const list = by.get(code)!
        return (
          <div key={code} className="card overflow-hidden">
            <LeagueBar country={BB_COUNTRY[code] || 'world'} name={list[0].league.name} logo={logos?.[code]} to={leagueHref('basketball', code, list[0].league.name)!} count={list.length} />
            <div className="divide-y divide-line/40">{list.map(g => <GameRow key={g.id} g={g} />)}</div>
          </div>
        )
      })}
    </div>
  )
}

/** Games by day (sticky day titles), then by league. */
export function GamesByDay({ games, logos, empty }: { games: BbGame[]; logos?: Record<string, string | null>; empty: string }) {
  if (!games.length) return <div className="card p-12 text-center text-muted">{empty}</div>
  const days: { key: string; list: BbGame[] }[] = []
  for (const g of games) {
    const k = new Date(g.kickoff).toDateString()
    const last = days[days.length - 1]
    if (last && last.key === k) last.list.push(g)
    else days.push({ key: k, list: [g] })
  }
  return (
    <>
      {days.map(d => (
        <section key={d.key} className="mb-6">
          <SectionTitle label={dayTitle(d.list[0].kickoff)} count={d.list.length} sticky />
          <LeagueCards games={d.list} logos={logos} />
        </section>
      ))}
    </>
  )
}

export function dayTitle(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000)
  if (diff === 0) return t('Today')
  if (diff === 1) return t('Tomorrow')
  if (diff === -1) return t('Yesterday')
  return d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** Live game in a sidebar box (football's LiveRow). */
/** Live strip card (fix133): the same as football's — league, LIVE / quarter + clock, two teams, score; no win %
 *  (the live win chance stays on the game page). */
export function LiveRow({ g }: { g: BbGame }) {
  return (
    <Link to={matchHref('basketball', g.id, { home: g.home.name, away: g.away.name, homeId: g.home.id, awayId: g.away.id, date: g.kickoff })!} className="block rounded-xl px-2 py-2 hover:bg-surface2 transition-colors">
      <div className="flex items-center justify-between text-[10px] text-faint mb-1">
        <span className="truncate">{g.league.name}</span>
        <span className="font-bold text-live tracking-wider">{liveLabel(g, true)}</span>
      </div>
      {(['H', 'A'] as const).map(s => {
        const team = s === 'H' ? g.home : g.away
        return (
          <div key={s} className="flex items-center justify-between gap-2 py-0.5">
            <span className="flex items-center gap-2 min-w-0"><TeamLogo team={team} size={18} /><span className="text-sm font-medium text-ink truncate">{team.name}</span></span>
            <span className="num text-sm font-bold text-ink">{g.score ? (s === 'H' ? g.score.home : g.score.away) : 0}</span>
          </div>
        )
      })}
    </Link>
  )
}

/** The live win chance of a game the visitor may see (not covered by the free reveal), else null. */
export function useLiveChance(g: BbGame) {
  const p = g.prediction
  const { hidden } = useReveal(rid(g), rstatus(g), !!p && !p.locked)
  return g.state === 'live' && p && !p.locked && !hidden && p.live ? p.live : null
}

/** In a game row while the game is on: who is ahead on win chance now, and the projected final score. */
function LiveRowPct({ g }: { g: BbGame }) {
  const l = g.prediction!.live!
  const lead = l.pHome >= 50 ? 'H' : 'A'
  const name = lead === 'H' ? g.home.name : g.away.name
  const pct = Math.round(lead === 'H' ? l.pHome : l.pAway)
  return (
    <>
      <span className="sm:hidden text-end leading-tight" title={t('Live win chance')}>
        <span className="block text-[11px] font-bold truncate max-w-[84px] text-live">{name}</span>
        <span className="block num text-[11px] font-semibold text-ink/80">{pct}%</span>
      </span>
      <span className="hidden sm:flex items-center gap-1" title={t('Live win chance')}>
        {(['H', 'A'] as const).map(k => (
          <span key={k} className={`w-11 h-7 rounded-md grid place-items-center leading-none ${k === lead ? 'bg-live text-bg' : 'bg-surface2/70 text-muted'}`}>
            <span className="text-[8px] font-bold opacity-75">{k === 'H' ? '1' : '2'}</span>
            <span className="num text-[11px] font-bold">{Math.round(k === 'H' ? l.pHome : l.pAway)}%</span>
          </span>
        ))}
        <span className="hidden lg:block w-px h-5 bg-line mx-1" aria-hidden />
        <span className="hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border border-live/40 text-muted" title={t('Projected final score')}>
          <span className="text-[8px] font-bold opacity-75">{t('Projected')}</span>
          <span className="num text-[11px] font-bold text-ink">{l.score.home}-{l.score.away}</span>
        </span>
      </span>
    </>
  )
}

/** Game page, while the game is on: win chance now vs at tip-off, and the projected final score. */
export function LiveChanceBox({ g }: { g: BbGame }) {
  const l = useLiveChance(g)
  const p = g.prediction
  if (!l || !p || typeof p.pHome !== 'number') return null
  // fix174: the shared block (NFL + college use it too)
  return <LiveChancePanel home={g.home.name} away={g.away.name} now={l} before={{ pHome: p.pHome, pAway: p.pAway ?? 100 - p.pHome }} status={`${liveLabel(g, true)} · ${g.score?.home ?? 0}-${g.score?.away ?? 0}`} />
}

export function Skeleton({ rows = 4, h = 'h-12' }: { rows?: number; h?: string }) {
  return <div className="space-y-2">{Array.from({ length: rows }).map((_, i) => <div key={i} className={`${h} rounded-xl bg-surface2/60 animate-pulse`} />)}</div>
}

/** Premium nudge where numbers are hidden. */
export function LockedNote() {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink flex flex-wrap items-center justify-between gap-2">
      <span className="inline-flex items-center gap-2"><LockIcon /> {t('Win chances, point spread, total points and the predicted score are for Premium members.')}</span>
      <Link to="/premium" className="px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-extrabold">{t('Go Premium')}</Link>
    </div>
  )
}

/** Plain list (team / league pages): rows under day headings. */
export function GameList({ games, showLeague = false, empty }: { games: BbGame[]; showLeague?: boolean; empty: string }) {
  if (!games.length) return <p className="text-sm text-faint py-4">{empty}</p>
  const days: { key: string; list: BbGame[] }[] = []
  for (const g of games) {
    const k = new Date(g.kickoff).toDateString()
    const last = days[days.length - 1]
    if (last && last.key === k) last.list.push(g)
    else days.push({ key: k, list: [g] })
  }
  return (
    <div className="space-y-4 -mx-5 sm:-mx-6">
      {days.map(d => (
        <div key={d.key}>
          <div className="label pb-1 px-5 sm:px-6">{dayTitle(d.list[0].kickoff)}</div>
          <div className="divide-y divide-line/50">{d.list.map(g => <GameRow key={g.id} g={g} showLeague={showLeague} />)}</div>
        </div>
      ))}
    </div>
  )
}

/** A team name that fits a list row (fix132): the full name up to 14 characters, else the nickname (NBA: last word) or
 *  the first word — never cut with "…". */
export function bbShort(raw: string | null | undefined, code: string) {
  const name = raw || 'TBD'
  if (name.length <= 14) return name
  const w = name.split(/\s+/)
  return code === 'NBA' ? w[w.length - 1] : w[0]
}

/**
 * fix132 — basketball's version of football's fix127 row block (components/DcPick.tsx DcBlock): two 36 px cells
 * "1 · 2" with each team's win %, our pick outlined lime and the other dimmed, then "Our pick · Fenerbahce · 80%".
 * Also used by the NFL rows (fix139).
 */
export function BbPickBlock({ p, pick, home, away, roll }: { p: { pHome?: number | null; pAway?: number | null }; pick: 'H' | 'A'; home: string; away: string; roll: boolean }) {
  const pct = Math.round(pick === 'H' ? p.pHome! : p.pAway!)
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        {(['H', 'A'] as const).map((k, i) => {
          const on = k === pick
          return (
            <span key={k} className={`w-9 h-7 rounded-md grid place-items-center leading-none border transition-colors ${on ? 'border-accent/70 bg-accent/15 text-ink' : 'border-transparent bg-surface2/40 text-faint'} ${roll ? 'pop-in' : ''}`}
              style={roll ? { animationDelay: `${i * 90}ms` } : undefined}>
              <span className={`text-[8px] font-bold ${on ? 'text-accent' : ''}`}>{k === 'H' ? '1' : '2'}</span>
              <CountUp value={Math.round(k === 'H' ? p.pHome! : p.pAway!)} animate={roll} delay={i * 90} className="num text-[11px] font-bold" />
            </span>
          )
        })}
      </span>
      <span className="flex items-center gap-1 text-[10px] leading-none whitespace-nowrap">
        <span className="text-faint">{t('Our pick')}</span>
        <span aria-hidden className="text-faint">·</span>
        <span className="font-bold text-ink">{pick === 'H' ? home : away}</span>
        <span aria-hidden className="text-faint">·</span>
        <span className="num font-extrabold text-accent">{pct}%</span>
      </span>
      {pct >= 70 && <span className="rounded-full border border-accent/50 text-accent text-[9px] font-bold px-1.5 py-px leading-none whitespace-nowrap">{t('Strong')}</span>}
    </span>
  )
}

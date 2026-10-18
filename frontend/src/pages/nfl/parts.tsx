import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { useNflLeague, nflBase, type NflLeague } from '../../lib/nfl'
import { t, LOCALE } from '../../lib/i18n'
import { NFL_STATUS, timeOf, nick, record, useNflFavorites, nflRid, nflRstatus, type NflGame, type StandRow, type Standings } from '../../lib/nfl'
import { SectionTitle, TeamLogo, dayTitle, BbPickBlock, LockIcon } from '../bb/parts'
import { useReveal, justRevealed } from '../../lib/reveal'

/** Shared pieces of the NFL pages (fix137) — the same look as basketball's and football's. */

/** "Prediction coming soon" in the prediction slot of a row / card (no prediction saved for the game yet). */
/**
 * NFL | College switcher (fix142), on top of every American-football page. On a list page it opens the same page of the
 * other league (games → games); on a game / team / player page, the other league's home.
 */
export function LeagueSwitch({ className = '' }: { className?: string }) {
  const { league, sub } = useNflLeague()
  const to = (l: NflLeague) => nflBase(l) + (sub ? '/' + sub : '')
  const opt = (l: NflLeague, label: string) => (
    <Link key={l} to={to(l)} aria-current={league === l ? 'page' : undefined}
      className={`h-8 px-3.5 inline-flex items-center rounded-full text-xs font-bold transition-colors ${league === l ? 'bg-accent text-bg' : 'text-muted hover:text-ink'}`}>{label}</Link>
  )
  return (
    <nav aria-label={t('League')} className={`inline-flex items-center gap-0.5 p-0.5 rounded-full border border-line bg-surface2/60 ${className}`}>
      {opt(1, 'NFL')}{opt(2, t('College'))}
    </nav>
  )
}

export function SoonChip({ className = '' }: { className?: string }) {
  return <span className={`inline-flex items-center h-7 px-2.5 rounded-md text-[11px] font-semibold text-faint border border-dashed border-line/80 whitespace-nowrap ${className}`}>{t('Prediction coming soon')}</span>
}

/**
 * One game as a thin row (the fix127 layout): time / status · both teams with logos and the score · prediction slot
 * (fix139: the fix127 block — 1 · 2 cells with each team's win %, our pick lime, "Our pick · Chiefs · 64%", then the
 * expected margin and total points on wide screens; covered → Reveal, locked → lock, finished → ✓ / ✗).
 */
export function NflGameRow({ g, showDay = false }: { g: NflGame; showDay?: boolean }) {
  const isLive = g.state === 'live', done = g.state === 'done'
  const p = g.prediction || null
  const open = !!p && !p.locked && typeof p.pHome === 'number'
  const { hidden: covered, reveal } = useReveal(nflRid(g), nflRstatus(g), open)
  const pick = open && !covered ? p!.pick! : null
  const roll = justRevealed(nflRid(g))
  const won = (side: 'H' | 'A') => (done && g.score ? (side === 'H' ? g.score.home > g.score.away : g.score.away > g.score.home) : false)
  const favWhy = useNflFavorites().reasons(g)
  return (
    <Link to={`/american-football/game/${g.id}${p ? '#prediction' : ''}`} className={`group relative flex items-center gap-2.5 px-3 sm:px-4 py-1.5 hover:bg-surface2/50 transition-colors ${isLive ? 'bg-live/[0.06]' : ''}`}>
      {isLive && <span className="absolute left-0 inset-y-0 w-0.5 bg-live" aria-hidden />}
      <div className="relative w-10 flex-shrink-0 text-center leading-tight">
        {favWhy.length > 0 && (
          <span className="absolute -left-2.5 sm:-left-3 top-1/2 -translate-y-1/2 text-accent" title={t('Favorite: {0}', { 0: favWhy.map(f => f.name).join(', ') })}>
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
          </span>
        )}
        {isLive ? (
          <>
            <span className="block text-[11px] font-bold text-live">{NFL_STATUS[g.status] || t('LIVE')}</span>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />
          </>
        ) : done ? (
          <span className="block text-[11px] font-bold text-faint">{NFL_STATUS[g.status] || t('Final')}</span>
        ) : g.state === 'off' ? (
          <span className="block text-[10px] font-bold text-loss">{NFL_STATUS[g.status] || g.status}</span>
        ) : (
          <>
            <span className="block num text-[12px] text-ink/90">{timeOf(g.kickoff)}</span>
            {showDay && <span className="block text-[10px] text-faint">{new Date(g.kickoff).toLocaleDateString(LOCALE, { weekday: 'short' })}</span>}
          </>
        )}
      </div>
      <div className="flex-1 min-w-0">
        {(['H', 'A'] as const).map(side => {
          const team = side === 'H' ? g.home : g.away
          const score = g.score ? (side === 'H' ? g.score.home : g.score.away) : null
          return (
            <div key={side} className="flex items-center gap-2 min-w-0 h-5">
              <TeamLogo team={team} size={15} />
              <span className={`text-[13px] truncate ${pick === side || won(side) ? 'font-bold text-ink' : 'text-ink/85'}`}>
                <span className="sm:hidden">{nick(team.name, g.league)}</span><span className="hidden sm:inline">{team.name}</span>
              </span>
              {score !== null && <span className={`ml-auto pl-2 num text-[13px] font-extrabold tabular-nums ${isLive ? 'text-live' : done && !won(side) ? 'text-muted' : 'text-ink'}`}>{score}</span>}
            </div>
          )
        })}
      </div>
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
          <span className="inline-flex items-center gap-1.5 text-xs text-faint"><LockIcon /> {t('Locked')}</span>
        ) : pick ? (
          <span className="flex items-center gap-1">
            <BbPickBlock p={p!} pick={pick} home={nick(g.home.name, g.league)} away={nick(g.away.name, g.league)} roll={roll} />
            {typeof p!.margin === 'number' && typeof p!.total === 'number' && (
              <>
                <span className="hidden lg:block w-px h-5 bg-line mx-1" aria-hidden />
                <span className={`hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border border-line/70 text-muted ${roll ? 'pop-in' : ''}`} title={t('Expected margin')}>
                  <span className="text-[8px] font-bold opacity-75">{t('Margin')}</span>
                  <span className="num text-[11px] font-bold text-ink">{p!.margin! >= 0 ? '1' : '2'} +{Math.abs(p!.margin!).toFixed(1)}</span>
                </span>
                <span className={`hidden lg:grid w-[60px] h-7 rounded-md place-items-center leading-none border border-line/70 text-muted ${roll ? 'pop-in' : ''}`} title={t('Total points')}>
                  <span className="text-[8px] font-bold opacity-75">{t('Total')}</span>
                  <span className="num text-[11px] font-bold text-ink">{p!.total!.toFixed(1)}</span>
                </span>
              </>
            )}
          </span>
        ) : g.state === 'upcoming' ? <SoonChip /> : <span className="text-xs text-faint">{done ? '' : '–'}</span>}
        {done && p && typeof p.hit === 'boolean' && (
          <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold ${p.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`} title={p.hit ? t('Hit') : t('Miss')}>{p.hit ? '✓' : '✗'}</span>
        )}
      </div>
    </Link>
  )
}

/** Games grouped by day (sticky day titles), each day in one card. */
export function NflGamesByDay({ games, empty }: { games: NflGame[]; empty: string }) {
  if (!games.length) return <div className="card p-12 text-center text-muted">{empty}</div>
  const days: { key: string; list: NflGame[] }[] = []
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
          <div className="card overflow-hidden divide-y divide-line/40">{d.list.map(g => <NflGameRow key={g.id} g={g} />)}</div>
        </section>
      ))}
    </>
  )
}

/** Live game card (football-style): LIVE / quarter, both teams, score. Live games are shown only in the live strip. */
export function NflLiveCard({ g }: { g: NflGame }) {
  return (
    <Link to={`/american-football/game/${g.id}`} className="card card-hover snap-start flex-shrink-0 w-[248px] p-3.5 block">
      <div className="flex items-center justify-between text-[10px] text-faint mb-1.5">
        <span>{g.league === 2 ? t('College football') : 'NFL'}</span>
        <span className="inline-flex items-center gap-1 font-bold text-live tracking-wider"><span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />{NFL_STATUS[g.status] || t('LIVE')}</span>
      </div>
      {(['H', 'A'] as const).map(s => {
        const team = s === 'H' ? g.home : g.away
        return (
          <div key={s} className="flex items-center justify-between gap-2 py-0.5">
            <span className="flex items-center gap-2 min-w-0"><TeamLogo team={team} size={20} /><span className="text-sm font-semibold text-ink truncate">{team.name}</span></span>
            <span className="num text-base font-extrabold text-ink">{g.score ? (s === 'H' ? g.score.home : g.score.away) : 0}</span>
          </div>
        )
      })}
    </Link>
  )
}

/** Standings of one division (or a conference snapshot): W-L-T, PCT, PF, PA, diff, streak. */
export function StandTable({ title, rows, compact = false, highlight, league = 1 }: { title?: string; rows: StandRow[]; compact?: boolean; highlight?: number | number[]; league?: NflLeague }) {
  const marked = (id: number) => (Array.isArray(highlight) ? highlight.includes(id) : highlight === id)
  const conf = league === 2 && !compact // college: conference record first (the order of the table)
  return (
    <div>
      {title && <div className="label pb-1.5">{title}</div>}
      <div className="overflow-x-auto -mx-1">
        <table className={`w-full text-sm ${compact ? '' : 'sm:min-w-[420px]'}`}>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-faint">
              <th className="text-left font-semibold py-1.5 px-1">{t('Team')}</th>
              {conf && <th className="text-right font-semibold py-1.5 px-1" title={t('Conference games')}>{t('Conf')}</th>}
              <th className="text-right font-semibold py-1.5 px-1">{t('W-L-T')}</th>
              {!compact && <th className="hidden sm:table-cell text-right font-semibold py-1.5 px-1">{t('PCT')}</th>}
              {!compact && <th className="hidden sm:table-cell text-right font-semibold py-1.5 px-1">{t('PF')}</th>}
              {!compact && <th className="hidden sm:table-cell text-right font-semibold py-1.5 px-1">{t('PA')}</th>}
              <th className="text-right font-semibold py-1.5 px-1">{t('Diff')}</th>
              {!compact && <th className="text-right font-semibold py-1.5 px-1">{t('Streak')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.team.id} className={`border-t border-line/50 ${marked(r.team.id) ? 'bg-accent/10' : ''}`}>
                <td className="py-1.5 px-1">
                  <Link to={`/american-football/team/${r.team.id}`} className="flex items-center gap-2 min-w-0 hover:text-accent">
                    <TeamLogo team={r.team} size={18} />
                    <span className="truncate text-ink"><span className="sm:hidden">{nick(r.team.name, league)}</span><span className="hidden sm:inline">{r.team.name}</span></span>
                  </Link>
                </td>
                {conf && <td className="py-1.5 px-1 text-right num font-semibold text-ink">{r.confW ?? 0}-{r.confL ?? 0}</td>}
                <td className={`py-1.5 px-1 text-right num ${conf ? 'text-muted' : 'font-semibold text-ink'}`}>{record(r)}</td>
                {!compact && <td className="hidden sm:table-cell py-1.5 px-1 text-right num text-muted">{r.pct.toFixed(3).replace(/^0/, '')}</td>}
                {!compact && <td className="hidden sm:table-cell py-1.5 px-1 text-right num text-muted">{r.pf}</td>}
                {!compact && <td className="hidden sm:table-cell py-1.5 px-1 text-right num text-muted">{r.pa}</td>}
                <td className={`py-1.5 px-1 text-right num font-semibold ${r.diff > 0 ? 'text-win' : r.diff < 0 ? 'text-loss' : 'text-muted'}`}>{r.diff > 0 ? '+' : ''}{r.diff}</td>
                {!compact && <td className="py-1.5 px-1 text-right num text-muted">{r.streak || '–'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Every conference, division by division. */
export function StandingsBlock({ data, compact = false, highlight }: { data: Standings; compact?: boolean; highlight?: number }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {data.conferences.map(c => (
        <section key={c.name} className="space-y-4 min-w-0">
          <h3 className="font-display text-base font-bold text-ink flex items-center gap-2">{c.name}{c.level && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface2 text-faint">{c.level}</span>}</h3>
          {c.divisions.map(d => <StandTable key={d.name} title={d.name !== c.name ? d.name : undefined} rows={d.rows} compact={compact} highlight={highlight} league={data.league || 1} />)}
        </section>
      ))}
    </div>
  )
}

/** Two numbers side by side as bars (game page team stats). */
export function StatBars({ label, home, away, fmt = (v: number) => String(v), lowerBetter = false }: { label: string; home: number | null; away: number | null; fmt?: (v: number) => string; lowerBetter?: boolean }) {
  if (home === null && away === null) return null
  const h = home ?? 0, a = away ?? 0, tot = Math.abs(h) + Math.abs(a) || 1
  const hb = lowerBetter ? h < a : h > a, ab = lowerBetter ? a < h : a > h
  return (
    <div className="py-2">
      <div className="flex items-center justify-between text-sm mb-1">
        <span className={`num font-bold ${hb ? 'text-ink' : 'text-muted'}`}>{home === null ? '–' : fmt(home)}</span>
        <span className="text-xs text-muted">{label}</span>
        <span className={`num font-bold ${ab ? 'text-ink' : 'text-muted'}`}>{away === null ? '–' : fmt(away)}</span>
      </div>
      <div className="flex gap-1 h-1.5">
        <div className="flex-1 flex justify-end bg-surface2 rounded-full overflow-hidden"><div className={`h-full rounded-full ${hb ? 'bg-home' : 'bg-home/40'}`} style={{ width: `${(100 * Math.abs(h)) / tot}%` }} /></div>
        <div className="flex-1 bg-surface2 rounded-full overflow-hidden"><div className={`h-full rounded-full ${ab ? 'bg-away' : 'bg-away/40'}`} style={{ width: `${(100 * Math.abs(a)) / tot}%` }} /></div>
      </div>
    </div>
  )
}

/**
 * fix174: the "one chosen league" panel of the Games page (football's LeaguePanel, NFL + college data): the division /
 * conference tables (compact) and a link to the standings page.
 */
export function NflLeaguePanel({ league }: { league: NflLeague }) {
  const [d, setD] = useState<Standings | null | undefined>(undefined)
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/nfl/standings`, { params: { league } }).then(r => setD(r.data.data || null)).catch(() => setD(null))
  }, [league])
  return (
    <aside className="xl:sticky xl:top-20 space-y-4">
      <section className="card p-3 max-h-[70vh] overflow-y-auto overscroll-contain">
        {d === undefined ? <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-6 rounded-lg bg-surface2/60 animate-pulse" />)}</div>
          : !d || !d.conferences.length ? <p className="text-xs text-faint p-2">{t('Standings appear once the season has started.')}</p>
          : <div className="space-y-4">{d.conferences.flatMap(c => c.divisions.map(dv => <StandTable key={`${c.name}|${dv.name}`} title={dv.name !== c.name ? `${c.name} · ${dv.name}` : c.name} rows={dv.rows} compact league={league} />))}</div>}
      </section>
      <Link to={league === 2 ? '/american-football/college/league' : '/american-football/league'} className="block text-center text-xs font-bold text-accent">{t('Full table →')}</Link>
    </aside>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { t as tt, LOCALE } from '../../lib/i18n'
import { useRevealState } from '../../lib/reveal'
import LeagueSidebar, { MobileLeagueBar, LeagueBar } from '../LeagueSidebar'
import { Crest, ResultsCard } from '../SportHome/parts'
import GameRow from './GameRow'
import SectionTitle from './SectionTitle'
import type { GamesAdapter, SGame, SLeague } from './types'

/**
 * fix152a — the Matches / Games page of every sport, football's layout (was pages/Dashboard): left the Live box and
 * the league menu (All, My favorites, pinned leagues, My teams, countries); centre 3d / 7d / 14d / 30d, Your favorites,
 * Spotlight, then games by day → league; right Latest results ("x / y picks right") or the chosen league's panel.
 * Live games appear only in the Live box, never in the day lists. No season or week picker.
 */
const DAY_OPTIONS = [3, 7, 14, 30]

const dayKey = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
export function dayLabel(ts: number) {
  const diff = Math.round((ts - dayKey(new Date().toISOString())) / 86400000)
  if (diff === 0) return tt('Today')
  if (diff === 1) return tt('Tomorrow')
  return new Date(ts).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' })
}

/** The Live box row: league, clock, both teams and the score. */
export function LiveRow({ g }: { g: SGame }) {
  return (
    <Link to={g.href} state={g.linkState} className="block rounded-xl px-2 py-2 hover:bg-surface2 transition-colors">
      <div className="flex items-center justify-between text-[10px] text-faint mb-1">
        <span className="truncate">{g.competition.name}</span>
        <span className="font-bold text-live tracking-wider">{g.live?.label || tt("LIVE")}</span>
      </div>
      {(['H', 'A'] as const).map((s, i) => {
        const t = s === 'H' ? g.home : g.away
        return (
          <div key={s} className="flex items-center justify-between gap-2 py-0.5">
            <span className="flex items-center gap-2 min-w-0"><Crest team={t} size={18} /><span className="text-sm font-medium text-ink truncate">{t.short}</span></span>
            <span className="num text-sm font-bold text-ink">{g.live?.score[i] ?? 0}</span>
          </div>
        )
      })}
    </Link>
  )
}

/** A day's games grouped by league: leagues by rank, then name; games by kick-off. */
export function byLeague(list: SGame[]): [SLeague, SGame[]][] {
  const map = new Map<string, { l: SLeague; games: SGame[] }>()
  for (const g of list) { const x = map.get(g.league.code) || { l: g.league, games: [] }; x.games.push(g); map.set(g.league.code, x) }
  return [...map.values()].sort((a, b) => a.l.rank - b.l.rank || a.l.name.localeCompare(b.l.name)).map(x => [x.l, x.games.sort((a, b) => a.kickoff.localeCompare(b.kickoff))])
}

export default function Games({ a }: { a: GamesAdapter }) {
  const d = a.useData()
  useRevealState()
  const [params, setParams] = useSearchParams()
  const league = params.get('league') || 'ALL'
  // opened on one league (search, shared link): its whole month, so the list is never empty between rounds
  const [days, setDays] = useState(() => (params.get('league') ? 30 : 7))
  useEffect(() => { if (league !== 'ALL') setDays(30) }, [league])
  useEffect(() => { document.title = tt('{0} · SportLikely', { 0: a.title }) }, [a.title])
  const setLeague = (code: string) => setParams(code === 'ALL' ? {} : { league: code }, { replace: true })
  const favMode = league === 'FAV'

  const games = d.games
  const leagueOf = (g: SGame) => league === 'ALL' || (favMode ? g.favWhy.length > 0 : g.league.code === league)
  const cutoff = Date.now() + days * 86400000
  const upcoming = useMemo(() => games.filter(g => g.state === 'upcoming' && new Date(g.kickoff).getTime() <= cutoff && leagueOf(g)), [games, league, days])
  const favUpcoming = useMemo(() => (league !== 'ALL' ? [] : games.filter(g => g.state === 'upcoming' && g.favWhy.length > 0 && new Date(g.kickoff).getTime() <= cutoff).sort((x, y) => x.kickoff.localeCompare(y.kickoff)).slice(0, 8)), [games, league, days])
  const favCount = useMemo(() => games.filter(g => g.favWhy.length > 0).length, [games])
  // Live box: on a league page that league's live games; other leagues' only when it has none
  const liveAll = games.filter(g => g.state === 'live')
  const liveOwn = league === 'ALL' || favMode ? [] : liveAll.filter(g => g.league.code === league)
  const live = liveOwn.length ? liveOwn : liveAll
  const liveOther = league !== 'ALL' && !favMode && !liveOwn.length && liveAll.length > 0
  // Spotlight: the three biggest games of the next 4 days (never repeated in the day lists)
  const spotlight = useMemo(() => {
    if (favMode) return []
    const soon = Date.now() + 4 * 86400000
    return upcoming.filter(g => new Date(g.kickoff).getTime() <= soon && g.weight > 0).sort((x, y) => y.weight - x.weight).slice(0, 3)
  }, [upcoming, favMode])
  const spotIds = useMemo(() => new Set(spotlight.map(g => g.id)), [spotlight])
  const grouped = useMemo(() => {
    const m = new Map<number, SGame[]>()
    upcoming.filter(g => !spotIds.has(g.id)).forEach(g => { const k = dayKey(g.kickoff); m.set(k, [...(m.get(k) || []), g]) })
    return [...m.entries()].sort((x, y) => x[0] - y[0])
  }, [upcoming, spotIds])

  const side = {
    leagues: d.leagues.map(l => ({ code: l.code, name: l.name, short: l.short, logo: l.logo, country: l.country, count: games.filter(g => g.league.code === l.code).length, fav: l.fav })),
    selected: league,
    onSelect: setLeague,
    pinned: (() => { const mine = d.favLeagues.filter(c => d.leagues.some(l => l.code === c)); return mine.length ? mine : a.defaultPinned.filter(c => d.leagues.some(l => l.code === c)) })(),
    teams: d.favTeams,
    total: games.length,
    favCount: d.hasFavorites ? favCount : null,
    addTeamTo: a.favoritesHref
  }
  const chosen = d.leagues.find(l => l.code === league)
  const panel = league !== 'ALL' && !favMode && a.leaguePanel ? a.leaguePanel(league) : null
  // fix183b: a sport without a league list (American football) — no left column; the Live box sits above the games
  const noList = !!a.noLeagueList
  const liveBox = (wide: boolean) => (
    <section className="card p-4 shrink-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-ink flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${live.length ? 'bg-live animate-pulseDot' : 'bg-faint'}`} />
          {tt("Live")}</h2>
        <span className="num text-xs text-faint">{live.length}</span>
      </div>
      {live.length === 0 ? <p className="text-xs text-faint">{a.noLive}</p> : (
        <>
          {liveOther && <p className="text-[11px] text-faint mb-2">{tt("Nothing in play in this league. Live elsewhere:")}</p>}
          <ul className={wide ? 'grid sm:grid-cols-2 xl:grid-cols-3 gap-1' : 'space-y-1 max-h-60 overflow-y-auto'}>{live.map(g => <li key={g.id}><LiveRow g={g} /></li>)}</ul>
        </>
      )}
    </section>
  )
  const cols = noList
    ? (league === 'ALL' ? '2xl:grid-cols-[1fr_340px]' : panel ? 'xl:grid-cols-[1fr_320px]' : '')
    : league === 'ALL' ? 'lg:grid-cols-[250px_1fr] 2xl:grid-cols-[250px_1fr_340px]' : panel ? 'lg:grid-cols-[250px_1fr] xl:grid-cols-[250px_1fr_320px]' : 'lg:grid-cols-[250px_1fr]'

  return (
    <div className={`max-w-[1400px] mx-auto px-4 sm:px-6 py-6 lg:py-8 pb-28 xl:pb-10 ${league === 'ALL' ? '2xl:max-w-[1760px]' : ''}`}>
      <div className={`grid grid-cols-1 gap-6 lg:gap-8 items-start ${cols}`}>
        {!noList && (
        <aside className="hidden lg:flex lg:sticky lg:top-20 flex-col gap-6 lg:max-h-[calc(100vh-6.5rem)]">
          {liveBox(false)}
          <LeagueSidebar {...side} />
          {league === 'ALL' && <section className="hidden lg:block 2xl:hidden shrink-0"><ResultsCard r={{ ...d.results, rows: d.results.rows ? d.results.rows.slice(0, 6) : null }} /></section>}
        </aside>
        )}

        <div className="min-w-0">
          {a.top && <div className="mb-4">{a.top}</div>}
          {noList && <div className="hidden lg:block mb-6">{liveBox(true)}</div>}
          <MobileLeagueBar side={side} liveCount={live.length} live={live.map(g => <LiveRow key={g.id} g={g} />)} chips={!noList} />
          <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
            <div>
              <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{league === 'ALL' ? a.title : favMode ? tt("My favorites") : chosen?.name || a.title}</h1>
              <p className="mt-1 text-sm text-muted">
                {a.countLine(upcoming.length, days)}
                {league !== 'ALL' && !favMode && chosen?.href && <Link to={chosen.href} className="ml-3 font-bold text-accent">{tt("League page →")}</Link>}
              </p>
            </div>
            <div className="seg">
              {DAY_OPTIONS.map(n => <button key={n} onClick={() => setDays(n)} className={`seg-btn ${days === n ? 'seg-btn-active' : ''}`}>{n}d</button>)}
            </div>
          </div>

          {d.loading && <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="card h-44 animate-pulse bg-surface2/60" />)}</div>}
          {d.error && <div className="card p-5 border-loss/40 text-loss">{tt("Failed to load matches:")}{' '}{d.error}</div>}
          {!d.loading && !d.error && upcoming.length === 0 && (
            favMode && !d.hasFavorites ? (
              <div className="card p-10 text-center space-y-3">
                <p className="text-ink font-semibold">{tt("You have no favorites yet.")}</p>
                <p className="text-sm text-muted max-w-md mx-auto">{tt("Tap the star next to a league here, or on any team, league or player page. Their games then show up in this list.")}</p>
                <Link to={a.favoritesHref} className="inline-block text-sm font-bold text-accent">{tt("Manage favorites →")}</Link>
              </div>
            ) : <div className="card p-12 text-center text-muted">{favMode ? tt("None of your favorites play in this period.") : tt("No matches for this selection.")}</div>
          )}

          {!d.loading && favUpcoming.length > 0 && (
            <section className="mb-8">
              <SectionTitle label={tt("Your favorites")} sub={tt("their next games")} />
              <div className="card overflow-hidden border-accent/25 divide-y divide-line/50">{favUpcoming.map(g => <GameRow key={g.id} g={g} showComp showDay />)}</div>
              <button type="button" onClick={() => setLeague('FAV')} className="mt-2 text-xs font-bold text-accent">{tt("Show only my favorites →")}</button>
            </section>
          )}
          {!d.loading && spotlight.length > 0 && (
            <section className="mb-8">
              <SectionTitle label={tt("Spotlight")} sub={tt("the biggest games of the coming days")} />
              <div className="card overflow-hidden border-accent/25 divide-y divide-line/50">{spotlight.map(g => <GameRow key={g.id} g={g} showComp showDay />)}</div>
            </section>
          )}
          {!d.loading && grouped.map(([ts, list]) => (
            <section key={ts} className="mb-6">
              <SectionTitle label={dayLabel(ts)} count={list.length} sticky />
              <div className="space-y-2">
                {byLeague(list).map(([l, gs]) => (
                  <div key={l.code} className="card overflow-hidden">
                    <LeagueBar country={l.country} name={l.short || l.name} logo={l.logo} to={l.href || '#'} count={gs.length} />
                    <div className="divide-y divide-line/40">{gs.map(g => <GameRow key={g.id} g={g} />)}</div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {/* fix160: phones and tablets get Latest results under the games (the side column is desktop only) */}
          {!panel && !d.loading && <section className={`${noList ? '2xl:hidden' : 'lg:hidden'} mt-8`}><ResultsCard r={d.results} /></section>}
        </div>

        {panel}
        {league === 'ALL' && (
          <aside className="hidden 2xl:block 2xl:sticky 2xl:top-20"><ResultsCard r={d.results} /></aside>
        )}
      </div>
    </div>
  )
}

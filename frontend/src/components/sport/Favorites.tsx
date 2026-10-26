import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useFavorites, type Favorite, type FavKind } from '../../lib/favorites'
import SearchBox from '../SearchBox'
import { t, LOCALE } from '../../lib/i18n'
import { useRevealState } from '../../lib/reveal'
import GameRow from './GameRow'
import PlayerPhoto from './PlayerPhoto'
import SectionTitle from './SectionTitle'
import CalendarCard from '../CalendarCard'
import { dayLabel } from './Games'
import type { GamesAdapter, SGame } from './types'

/**
 * Favorites (football's page, shared by every sport since fix152b): your favorite leagues, teams (and players) of the
 * sport, the next game of each, then all their coming games with our predictions — live ones first, then by day.
 * The games come from the sport's Games adapter (favWhy says which favorite a game is for).
 */
export interface FavoritesAdapter {
  games: GamesAdapter
  /** the kinds of this sport, in the order of the cards */
  kinds: FavKind[]
  hrefOf: (f: Favorite) => string
  browse: { to: string; label: string }
  /** the "follow the teams …" text when nothing is starred */
  empty: string
  /** login link back to this page */
  self: string
}

const TITLE: Record<string, string> = { team: t('Teams'), 'bb-team': t('Teams'), 'nfl-team': t('Teams'), player: t('Players'), 'bb-player': t('Players'), 'nfl-player': t('Players'), league: t('Leagues'), 'bb-league': t('Leagues'), 'nfl-league': t('Leagues'), 'tennis-player': t('Players'), 'tennis-tournament': t('Tournaments') }
const dayKey = (iso: string) => { const d = new Date(iso); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

export default function Favorites({ a }: { a: FavoritesAdapter }) {
  const { user } = useAuth()
  const { list: all, remove, synced } = useFavorites()
  const d = a.games.useData()
  useRevealState()
  useEffect(() => { document.title = t('{0} · SportLikely', { 0: t('Favorites') }) }, [])
  const list = all.filter(f => a.kinds.includes(f.kind))
  const games = useMemo(() => d.games.filter(g => g.favWhy.length > 0).sort((x, y) => x.kickoff.localeCompare(y.kickoff)), [d.games])
  const live = games.filter(g => g.state === 'live')
  const byDay = useMemo(() => {
    const m = new Map<number, SGame[]>()
    for (const g of games) if (g.state !== 'live') m.set(dayKey(g.kickoff), [...(m.get(dayKey(g.kickoff)) || []), g])
    return [...m.entries()].sort((x, y) => x[0] - y[0])
  }, [games])
  const nextOf = (f: Favorite) => games.find(g => g.favWhy.includes(f.name))

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 lg:py-8 pb-28 xl:pb-10 space-y-8">
      {a.games.top}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink flex items-center gap-3">
            <svg viewBox="0 0 24 24" className="w-8 h-8 text-accent" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
            {t("Favorites")}</h1>
          <p className="mt-1 text-sm text-muted">
            {user ? (synced ? t("Saved to your account, on every device you sign in on.") : t("Saving to your account…")) : (
              <>{t("Saved in this browser.")}{' '}<Link to={`/login?next=${encodeURIComponent(a.self)}`} className="font-bold text-accent">{t("Sign in")}</Link> {t("to keep them on your phone and computer.")}</>
            )}
          </p>
        </div>
        <div className="w-full sm:w-80"><SearchBox /></div>
      </div>

      {list.length === 0 ? (
        <div className="card p-8 sm:p-10 text-center space-y-3">
          <p className="text-lg font-semibold text-ink">{t("Follow the teams, leagues and players you care about")}</p>
          <p className="text-sm text-muted max-w-lg mx-auto">{a.empty}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Link to={a.browse.to} className="h-10 px-4 rounded-xl bg-accent text-bg font-bold text-sm grid place-items-center">{a.browse.label}</Link>
          </div>
        </div>
      ) : (
        <div className={`grid gap-4 ${a.kinds.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
          {a.kinds.map(kind => {
            const items = list.filter(f => f.kind === kind)
            return (
              <section key={kind} className="card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-display font-bold text-ink">{TITLE[kind]}</h2>
                  <span className="num text-xs text-faint">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <p className="text-xs text-faint">{/player/.test(kind) ? t("Star a player on its page.") : kind === 'tennis-tournament' ? t("Star a tournament on its page or in the Matches list.") : /league/.test(kind) ? (a.browse.to === '/football/matches' ? t("Star a league on its page or in the Matches list.") : t("Star a league on its page or in the Games list.")) : t("Star a team on its page or on a game page.")}</p>
                ) : (
                  <ul className="space-y-1">
                    {items.map(f => {
                      const nx = nextOf(f)
                      return (
                        <li key={f.ref} className="group flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface2/60">
                          {/player/.test(f.kind) ? <PlayerPhoto src={f.img} name={f.name} size={32} /> /* fix241: official photo or initials */ : f.img ? <img src={f.img} alt="" className="w-8 h-8 flex-shrink-0 object-contain" /> : <span className="w-8 h-8 rounded-full bg-surface2 flex-shrink-0" />}
                          <Link to={a.hrefOf(f)} className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-ink truncate">{f.name}</span>
                            <span className="block text-[11px] text-faint truncate">
                              {nx ? t("Next: {0} – {1}, {2}", { 0: nx.home.short, 1: nx.away.short, 2: new Date(nx.kickoff).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) }) : /player/.test(f.kind) && f.teamName ? f.teamName : d.loading ? '' : t("No game in the next 30 days")}
                            </span>
                          </Link>
                          <button type="button" onClick={() => remove(f.kind, f.ref)} className="w-7 h-7 grid place-items-center rounded-lg text-faint hover:text-loss hover:bg-loss/10 flex-shrink-0"
                            title={t("Remove {0}", { 0: f.name })} aria-label={t("Remove {0} from favorites", { 0: f.name })}>×</button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}

      {list.length > 0 && (
        <div>
          <SectionTitle label={t("Their next games")} sub={t("next 30 days, with our predictions")} />
          {d.loading ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="card h-14 animate-pulse bg-surface2/60" />)}</div>
          ) : games.length === 0 ? (
            <div className="card p-8 text-center text-sm text-muted">{t("None of your favorites play in the next 30 days.")}</div>
          ) : (
            <div className="space-y-6">
              {live.length > 0 && (
                <section>
                  <SectionTitle label={t("Live now")} accent="live" />
                  <div className="card overflow-hidden divide-y divide-line/50">{live.map(g => <GameRow key={g.id} g={g} showComp />)}</div>
                </section>
              )}
              {byDay.map(([ts, gs]) => (
                <section key={ts}>
                  <SectionTitle label={dayLabel(ts)} count={gs.length} />
                  <div className="card overflow-hidden divide-y divide-line/50">
                    {gs.map(g => (
                      <div key={g.id}>
                        <GameRow g={g} showComp />
                        <div className="px-3 sm:px-4 -mt-1.5 pb-2 pl-[68px] sm:pl-[72px] text-[11px] text-accent/90 truncate">★ {g.favWhy.join(' · ')}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* fix205: the favorites of every sport in one calendar file */}
      <CalendarCard className="max-w-2xl" />
    </div>
  )
}

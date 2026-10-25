import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t as tt, LOCALE, lang } from '../../lib/i18n'

/*
 * Today's predictions (fix124; shared by every sport since fix152b): today's games grouped by league, one line of facts
 * each (form, last meeting, table or season record), linking to the game pages. Never the pick or a % here — the game
 * page shows the prediction. Each sport passes an adapter (the API sport, links and labels).
 */

export interface TodayAdapter {
  title: string
  /** /api/today parameters */
  params: Record<string, string | number>
  /** fix229: the game's slug link (lib/links.ts matchHref) */
  gameHref: (g: Game) => string
  leagueHref: (code: string | null, name?: string) => string | null
  all: { to: string; label: string }
  /** the switcher above the title (American football: NFL | College) */
  top?: ReactNode
}

export interface Game { id: number; kickoff: string; home: string; away: string; homeId?: number | null; awayId?: number | null; score: [number, number] | null; line: string }
interface Group { league: string; code: string | null; games: Game[] }

const localDay = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Today({ a }: { a: TodayAdapter }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [failed, setFailed] = useState(false)
  const key = JSON.stringify(a.params)

  useEffect(() => {
    document.title = tt('{0} · SportLikely', { 0: a.title })
    setGroups(null); setFailed(false)
    axios.get(`${API_URL}/today`, { params: { ...a.params, lang, day: localDay() } })
      .then(r => setGroups(r.data.data?.groups || []))
      .catch(() => setFailed(true))
  }, [key, a.title])

  const total = groups?.reduce((s, g) => s + g.games.length, 0) || 0

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      {a.top}
      <header className="space-y-1">
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight">{a.title}</h1>
        <p className="text-sm text-muted">
          {new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}
          {groups && total > 0 && <> · {tt("{0} games", { 0: total })}</>}
        </p>
        <p className="text-sm text-muted">{tt("Recent form and the last meeting for every game today. Open a game for our prediction.")}</p>
      </header>

      {failed && <div className="card p-6 text-center text-sm text-muted">{tt("Could not load today's games. Try again in a minute.")}</div>}
      {!failed && !groups && <div className="min-h-[40vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>}
      {groups && !groups.length && (
        <div className="card p-6 text-center space-y-3">
          <p className="text-sm text-muted">{tt("No games today.")}</p>
          <Link to={a.all.to} className="text-sm font-bold text-accent">{a.all.label}</Link>
        </div>
      )}

      {groups?.map(g => {
        const href = a.leagueHref(g.code, g.league)
        return (
          <section key={g.code || g.league} className="card p-3 sm:p-4 space-y-1">
            <h2 className="font-display text-base font-bold px-2 pt-1">{href ? <Link to={href} className="hover:text-accent">{g.league}</Link> : g.league}</h2>
            <ul className="divide-y divide-line/50">
              {g.games.map(x => (
                <li key={x.id}>
                  <Link to={a.gameHref(x)} className="flex items-start gap-3 px-2 py-2.5 rounded-xl hover:bg-surface2/60 transition-colors">
                    <span className="w-12 flex-shrink-0 text-xs font-bold text-ink pt-0.5 num">
                      {x.score ? `${x.score[0]}–${x.score[1]}` : new Date(x.kickoff).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink break-words">{x.home} vs {x.away}</span>
                      {x.line && <span className="block text-xs text-muted break-words">{x.line}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

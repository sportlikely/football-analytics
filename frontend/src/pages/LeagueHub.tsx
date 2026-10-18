import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import NameLink from '../components/sport/NameLink'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t as tt, LOCALE } from '../lib/i18n'
import { hubByOld } from '../lib/hubs'

/*
 * Weekly league hub (fix125): /predictions/<league> — intro, then this week's games with their preview text and a
 * link to each game page. Never the pick or a %: the game page shows the prediction. English text for now.
 */

interface HubGame { id: number; kickoff: string; home: string; away: string; score: [number, number] | null; preview: string | null; url: string; homeUrl?: string | null; awayUrl?: string | null }
interface Hub { slug: string; code: string; sport: 'football' | 'basketball' | 'american-football'; name: string; intro: string; from: string; to: string; games: HubGame[]; next: string | null }

const range = (from: string, to: string) => {
  const f = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${f(from)}–${f(to)}`
}

export default function LeagueHub() {
  const { league = '' } = useParams()
  const [hub, setHub] = useState<Hub | null>(null)
  const [missing, setMissing] = useState(false)
  // old address (fix134): /predictions/PL → /predictions/premier-league (the server answers it with a 301 too)
  const old = hubByOld(league)
  const moved = old && league !== old.slug ? old.slug : null

  useEffect(() => {
    if (moved) return
    setHub(null); setMissing(false)
    axios.get(`${API_URL}/hub/${encodeURIComponent(league)}`)
      .then(r => {
        const h: Hub = r.data.data
        setHub(h)
        document.title = `${h.name} ${h.sport === 'american-football' ? 'games' : 'predictions'} this week · ${range(h.from, h.to)} | SportLikely`
      })
      .catch(() => setMissing(true))
  }, [league, moved])

  if (moved) return <Navigate to={`/predictions/${moved}`} replace />

  if (missing) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{tt("Page not found.")}</div>
  if (!hub) return <div className="min-h-[50vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>
  const bb = hub.sport !== 'football' // basketball and NFL say "game"
  const leagueUrl = hub.sport === 'basketball' ? `/basketball/league/${hub.code}` : hub.sport === 'american-football' ? (hub.code === 'NCAA' ? '/american-football/college/league' : '/american-football/league') : `/league/${hub.code}`
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-10 space-y-5">
      <header className="space-y-2">
        <Link to={leagueUrl} className="text-sm text-muted hover:text-ink">← {hub.name}</Link>
        <h1 className="font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-ink">{hub.name} {hub.sport === 'american-football' ? 'games' : 'predictions'} this week</h1>
        <p className="text-sm font-semibold text-faint">{range(hub.from, hub.to)}</p>
        <p className="text-[15px] text-muted leading-relaxed">{hub.intro}</p>
      </header>

      {!hub.games.length && (
        <div className="card p-6 text-center space-y-1">
          <p className="font-semibold text-ink">{tt("No matches this week.")}</p>
          {hub.next && <p className="text-sm text-muted">{tt("Next match: {0}", { 0: new Date(hub.next).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }) })}</p>}
        </div>
      )}

      {hub.games.map(g => (
        <section key={g.id} className="card p-4 sm:p-5 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-ink min-w-0 break-words">
              <NameLink to={g.homeUrl}>{g.home}</NameLink> <Link to={g.url} className="text-faint hover:text-accent">vs</Link> <NameLink to={g.awayUrl}>{g.away}</NameLink>
            </h2>
            <span className="text-xs font-semibold text-faint whitespace-nowrap num">
              {g.score ? `${g.score[0]}–${g.score[1]}` : new Date(g.kickoff).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {g.preview && <p className="text-sm text-muted leading-relaxed">{g.preview}</p>}
          <Link to={g.url} className="inline-block text-sm font-bold text-accent">{bb ? tt("See the game →") : tt("See the match →")}</Link>
        </section>
      ))}
    </div>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { t } from '../../../lib/i18n'
import { FavStar, type Favorite } from '../../../lib/favorites'

/**
 * The league page (football's, shared by every sport since fix152d): the header card (emblem, country, name, this
 * week's predictions, favorite star, how often our picks were right), then the table and the leaders on the left,
 * live games, next games, news and results on the right. Each sport gives the data and the cards' content.
 */
export interface LeaguePageProps {
  /** above the header (NFL: the NFL | College switch) */
  top?: ReactNode
  logo: string | null
  country: { flag?: string | null; name: string }
  name: string
  /** a line under the name (season, conference note) */
  sub?: string | null
  hub?: { to: string; label: string } | null
  fav?: Favorite | null
  record?: { hitRate: number; n: number } | null
  left: ReactNode
  right: ReactNode
  /** fix215: the "Season forecast" tab (components/sport/forecast/SeasonForecast), full width; #forecast in the address */
  forecast?: ReactNode
}

export function LCard({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 sm:p-5 min-w-0 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export const Lines = ({ n = 5, h = 'h-8' }: { n?: number; h?: string }) => (
  <div className="space-y-2">{Array.from({ length: n }).map((_, i) => <div key={i} className={`${h} rounded-lg bg-surface2/60 animate-pulse`} />)}</div>
)

/** fix215: Overview | Season forecast, the tab kept in the address (#forecast) so a team page can link to it */
function useLeagueTab(): ['overview' | 'forecast', (x: 'overview' | 'forecast') => void] {
  const read = () => (typeof window !== 'undefined' && window.location.hash === '#forecast' ? 'forecast' : 'overview')
  const [tab, setTab] = useState<'overview' | 'forecast'>(read)
  useEffect(() => {
    const on = () => setTab(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const pick = (x: 'overview' | 'forecast') => {
    setTab(x)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${x === 'forecast' ? '#forecast' : ''}`)
  }
  return [tab, pick]
}

export default function LeaguePage(p: LeaguePageProps) {
  const [tab, setTab] = useLeagueTab()
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 pb-28 xl:pb-10">
      {p.top}
      <section className="card relative overflow-hidden p-5 sm:p-7">
        <div className="pointer-events-none absolute inset-0 opacity-[0.12]" style={{ background: 'radial-gradient(600px 220px at 10% 0%, rgb(var(--accent)), transparent 70%)' }} />
        <div className="relative flex flex-wrap items-center gap-5">
          <span className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white/90 grid place-items-center flex-shrink-0 p-2">
            {p.logo ? <img src={p.logo} alt="" className="w-full h-full object-contain" /> : <span className="text-2xl">🏆</span>}
          </span>
          {/* fix193b: the name keeps at least 12rem on phones; the record box wraps under it instead */}
          <div className="min-w-[12rem] flex-1">
            <div className="flex items-center gap-2 text-xs text-faint">
              {p.country.flag && <img src={p.country.flag} alt="" className="w-4 h-3 object-cover rounded-[2px]" />}
              <span>{p.country.name}</span>
            </div>
            <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink [overflow-wrap:anywhere]">{p.name}</h1>
            {p.sub && <p className="text-sm text-muted">{p.sub}</p>}
            {p.hub && <Link to={p.hub.to} className="mt-1 inline-block text-sm font-bold text-accent">{p.hub.label}</Link>}
            {p.fav && <div><FavStar label className="mt-2" fav={p.fav} /></div>}
          </div>
          {p.record && p.record.n > 0 && (
            <div className="flex gap-3">
              <div className="glass px-4 py-3 text-center">
                <div className="text-[11px] text-faint">{t("Our picks right")}</div>
                <div className="font-display text-2xl font-extrabold text-accent num">{Math.round(p.record.hitRate)}%</div>
                <div className="text-[10px] text-faint num">{p.record.n} {t("games · 12 months")}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {p.forecast && <nav className="flex gap-2 overflow-x-auto no-scrollbar" aria-label={t("League sections")}>
        {([['overview', t("Overview")], ['forecast', t("Season forecast")]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}
            className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap border ${tab === id ? 'bg-accent text-bg border-accent' : 'border-line text-muted hover:text-ink'}`}>{label}</button>
        ))}
      </nav>}

      {tab === 'forecast' && p.forecast ? <div className="min-w-0">{p.forecast}</div> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start">
          <div className="space-y-6 min-w-0">{p.left}</div>
          <div className="space-y-6 min-w-0">{p.right}</div>
        </div>
      )}
    </div>
  )
}

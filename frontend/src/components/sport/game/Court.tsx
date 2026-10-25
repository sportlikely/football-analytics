import { Link } from 'react-router-dom'
import { t } from '../../../lib/i18n'

/**
 * fix174: basketball's line-ups — football's pitch in basketball's way: both probable starting fives on a court (home
 * left, away right), each player with his points a game; the bench and the players out below.
 */
export interface CourtPlayer { id: number | null; name: string; min?: number | null; pts?: number | null; status?: string | null }
export interface CourtSide { name: string; starters: CourtPlayer[]; bench: CourtPlayer[]; out: CourtPlayer[] }

const SPOTS = [[13, 50], [24, 20], [24, 80], [37, 33], [37, 67]] // guard, wings, bigs (share of the court)
const last = (s: string) => { const w = s.trim().split(/\s+/); return w.length > 1 ? w[w.length - 1] : s }

function Token({ p, side, href }: { p: CourtPlayer; side: 'home' | 'away'; href: string | null }) {
  const name = <span className="block max-w-[64px] sm:max-w-[84px] truncate rounded-md bg-black/55 px-1.5 py-[2px] text-[10px] sm:text-[11px] font-semibold leading-tight text-white">{last(p.name)}</span>
  return (
    <div className="flex flex-col items-center gap-1 w-[66px] sm:w-[84px]" title={`${p.name}${p.pts != null ? ` · ${t('{0} pts a game', { 0: p.pts })}` : ''}${p.status ? ` · ${p.status}` : ''}`}>
      <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-full grid place-items-center shadow-[0_2px_6px_rgba(0,0,0,0.45)] ring-2 ${p.status ? 'ring-draw' : 'ring-white/85'} ${side === 'home' ? 'bg-home' : 'bg-away'}`}>
        <span className="num text-[11px] sm:text-sm font-extrabold text-white">{p.pts != null ? Math.round(p.pts) : ''}</span>
      </div>
      {href ? <Link to={href} className="hover:underline">{name}</Link> : name}
    </div>
  )
}

export default function Court({ home, away, playerHref }: { home: CourtSide; away: CourtSide; playerHref: (id: number, name: string) => string | null }) {
  const dots = [
    ...home.starters.slice(0, 5).map((p, i) => ({ p, side: 'home' as const, x: SPOTS[i][0], y: SPOTS[i][1] })),
    ...away.starters.slice(0, 5).map((p, i) => ({ p, side: 'away' as const, x: 100 - SPOTS[i][0], y: 100 - SPOTS[i][1] }))
  ]
  const list = (s: CourtSide, side: 'home' | 'away') => (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-2"><span className={`w-2.5 h-2.5 rounded-full ${side === 'home' ? 'bg-home' : 'bg-away'}`} /><span className="font-display font-bold text-ink truncate">{s.name}</span></div>
      {s.bench.length > 0 && (
        <>
          <div className="label pb-1">{t('Bench')}</div>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs mb-3">
            {s.bench.map(p => (
              <li key={`${p.id}${p.name}`} className="flex items-center gap-1.5 min-w-0">
                {p.id ? <Link to={playerHref(p.id, p.name) || '#'} className="truncate text-muted hover:text-ink hover:underline">{p.name}</Link> : <span className="truncate text-muted">{p.name}</span>}
                {p.min != null && <span className="ml-auto num text-faint shrink-0">{Math.round(p.min)}′</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.out.length > 0 && (
        <>
          <div className="label pb-1 text-loss">{t('Out')}</div>
          <ul className="space-y-1 text-xs">
            {s.out.map(p => (
              <li key={`${p.id}${p.name}`} className="flex items-center gap-1.5 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-loss shrink-0" />
                {p.id ? <Link to={playerHref(p.id, p.name) || '#'} className="truncate text-ink hover:underline">{p.name}</Link> : <span className="truncate text-ink">{p.name}</span>}
                {p.status && <span className="ml-auto text-loss font-semibold shrink-0">{p.status}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
  return (
    <div>
      <div className="relative w-full aspect-[2/1] rounded-2xl overflow-hidden bg-[#c98a4b] dark:bg-[#7a4f27] border border-line/60">
        <svg viewBox="0 0 200 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
          <g fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.6">
            <rect x="2" y="2" width="196" height="96" />
            <line x1="100" y1="2" x2="100" y2="98" />
            <circle cx="100" cy="50" r="12" />
            <rect x="2" y="33" width="38" height="34" /><rect x="160" y="33" width="38" height="34" />
            <path d="M2 8 H16 A42 42 0 0 1 16 92 H2" /><path d="M198 8 H184 A42 42 0 0 0 184 92 H198" />
            <circle cx="40" cy="50" r="11" /><circle cx="160" cy="50" r="11" />
          </g>
          <circle cx="8" cy="50" r="1.6" fill="none" stroke="#ff6b2b" strokeWidth="0.8" /><circle cx="192" cy="50" r="1.6" fill="none" stroke="#ff6b2b" strokeWidth="0.8" />
        </svg>
        {dots.map(d => (
          <div key={`${d.side}${d.p.id}${d.p.name}`} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${d.x}%`, top: `${d.y}%` }}>
            <Token p={d.p} side={d.side} href={d.p.id ? playerHref(d.p.id, d.p.name) : null} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-center text-[11px] text-faint">{t('Probable starters: the last game’s starting five, without the players listed as out. The number = points a game (last 10 games).')}</p>
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {list(home, 'home')}
        {list(away, 'away')}
      </div>
    </div>
  )
}

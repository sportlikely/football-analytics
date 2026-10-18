import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { FavStar, type Favorite } from '../../../lib/favorites'

/**
 * The team page (football's, shared by every sport since fix152d): the banner (crest, league · country, name and
 * favorite star, a facts line, form), then two columns: the team analysis and the squad on the left; season numbers,
 * our record on the team, games and news on the right. Each sport gives the data and the cards.
 */
export interface TeamPageProps {
  /** above the banner (NFL: the NFL | College switch) */
  top?: ReactNode
  logo: string | null
  /** league · country (fix174: the league part can be a link) */
  kicker: ReactNode
  name: string
  fav: Favorite
  facts: ReactNode[]
  note?: ReactNode
  /** latest result last */
  form?: ('W' | 'D' | 'L' | 'T')[]
  left: ReactNode
  right: ReactNode
}

const FORM_BG: Record<string, string> = { W: 'bg-win', D: 'bg-draw', T: 'bg-draw', L: 'bg-loss' }

export function TCard({ title, action, children, className = '', id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`card p-5 sm:p-6 min-w-0 scroll-mt-24 ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          {title && <h2 className="font-display text-lg font-bold text-ink">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export default function TeamPage(p: TeamPageProps) {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-5 pb-28 xl:pb-10">
      {p.top}
      <section className="relative overflow-hidden rounded-[28px] border border-line/70 p-6 sm:p-9 bg-[radial-gradient(640px_320px_at_90%_0%,rgb(var(--home)/0.25),transparent_65%),linear-gradient(150deg,#13203D,#0A0E16)] text-[#EEF1F6] flex flex-col sm:flex-row sm:items-center gap-6">
        {p.logo ? <img src={p.logo} alt="" className="w-20 h-20 sm:w-28 sm:h-28 object-contain drop-shadow-lg" />
          : <span className="w-20 h-20 sm:w-28 sm:h-28 rounded-full bg-white/10 grid place-items-center font-display text-2xl font-extrabold">{p.name.slice(0, 2).toUpperCase()}</span>}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#9AA3B2]">{p.kicker}</div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight break-words">{p.name}</h1>
            <FavStar label tone="dark" fav={p.fav} />
          </div>
          {p.facts.length > 0 && <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-[#C9D0DB]">{p.facts.map((f, i) => <span key={i}>{f}</span>)}</div>}
          {p.note && <div className="text-[11px] text-[#9AA3B2]">{p.note}</div>}
        </div>
        {p.form && p.form.length > 0 && (
          <div className="flex flex-col sm:items-end gap-2">
            <span className="text-xs font-bold text-[#9AA3B2]">{t("Form, last")}{' '}{p.form.length}</span>
            <div className="flex gap-1.5">
              {p.form.map((r, i) => (
                <span key={i} className={`w-8 h-8 rounded-lg grid place-items-center font-display text-xs font-extrabold text-[#07090D] ${FORM_BG[r]}`}>{r}</span>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr] items-start">
        <div className="space-y-5 min-w-0">{p.left}</div>
        <div className="space-y-5 min-w-0">{p.right}</div>
      </div>
    </div>
  )
}

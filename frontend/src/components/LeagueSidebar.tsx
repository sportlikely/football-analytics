import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { t, LOCALE } from '../lib/i18n'
import { FavStar, type Favorite } from '../lib/favorites'

/**
 * League menu in the Flashscore style (Oct 2026), shared by football and basketball:
 *   All / My favorites · Pinned leagues (your starred leagues, or the big ones until you star some) ·
 *   My teams · International (cups, national teams) · Countries A–Z, each opening to its leagues.
 */

export interface SideLeague {
  code: string
  name: string
  /** name under its country ("Serie A" instead of "Serie A (Brazil)") */
  short?: string
  logo: string | null
  /** ISO 3166 code for the flag ("de", "gb-eng"); "eu" / "world" = international */
  country: string
  count: number
  fav: Favorite
  /** shown after the name (e.g. "testing") */
  note?: string
}
export interface SideTeam { key: string; name: string; logo: string | null; to: string }

const INTL = new Set(['eu', 'world', 'int'])
const SPECIAL: Record<string, string> = { 'gb-eng': 'England', 'gb-sct': 'Scotland', 'gb-wls': 'Wales', 'gb-nir': 'Northern Ireland', eu: 'Europe', world: 'World', int: 'International' }
let regionNames: Intl.DisplayNames | null = null
/** Country name in the visitor's language. */
export function countryName(code: string) {
  if (SPECIAL[code]) return t(SPECIAL[code])
  try {
    regionNames ||= new Intl.DisplayNames([LOCALE], { type: 'region' })
    return regionNames.of(code.toUpperCase()) || code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}

export function Flag({ code, size = 18 }: { code: string; size?: number }) {
  if (INTL.has(code)) {
    return (
      <span className="grid place-items-center rounded-[3px] bg-accent/15 text-accent shrink-0" style={{ width: size, height: Math.round(size * 0.72) }} aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
      </span>
    )
  }
  return <img src={`https://media.api-sports.io/flags/${code}.svg`} alt="" loading="lazy" className="object-cover rounded-[3px] shrink-0 shadow-sm" style={{ width: size, height: Math.round(size * 0.72) }} />
}

const STORE = 'sl-side-countries'
function readOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STORE) || '[]') as string[]) } catch { return new Set() }
}

export default function LeagueSidebar({
  leagues, selected, onSelect, pinned, teams, total, favCount, addTeamTo, sportLabel
}: {
  leagues: SideLeague[]
  selected: string
  onSelect: (code: string) => void
  /** league codes to pin: the user's starred leagues, or the page's default list when none are starred */
  pinned: string[]
  teams: SideTeam[]
  total: number
  favCount: number | null
  addTeamTo: string
  sportLabel?: ReactNode
}) {
  const [open, setOpen] = useState<Set<string>>(readOpen)
  const toggle = (c: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c); else next.add(c)
    try { localStorage.setItem(STORE, JSON.stringify([...next])) } catch { /* storage unavailable */ }
    return next
  })
  const byCode = new Map(leagues.map(l => [l.code, l]))
  const pins = pinned.map(c => byCode.get(c)).filter(Boolean) as SideLeague[]
  // a pinned league shows only once, at the top (not again under International / its country)
  const pinnedSet = new Set(pins.map(l => l.code))
  const rest = leagues.filter(l => !pinnedSet.has(l.code))
  const intl = rest.filter(l => INTL.has(l.country))
  const countries = new Map<string, SideLeague[]>()
  for (const l of rest) if (!INTL.has(l.country)) { if (!countries.has(l.country)) countries.set(l.country, []); countries.get(l.country)!.push(l) }
  const countryList = [...countries.entries()].sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0]), LOCALE))

  const Row = ({ l, indent }: { l: SideLeague; indent?: boolean }) => (
    <li className="relative">
      <button onClick={() => onSelect(l.code)} className={`side-item pr-9 ${indent ? 'pl-7' : ''} ${selected === l.code ? 'side-item-active' : ''}`}>
        {l.logo ? <img src={l.logo} alt="" className="w-5 h-5 object-contain shrink-0" /> : <Flag code={l.country} />}
        <span className="truncate">{indent ? l.short || l.name : l.name}</span>
        {l.note && <span className="shrink-0 text-[9px] font-bold uppercase text-faint">{l.note}</span>}
        <span className="ml-auto num text-xs text-faint">{l.count || ''}</span>
      </button>
      <span className="absolute right-1.5 top-1/2 -translate-y-1/2"><FavStar size="sm" fav={l.fav} /></span>
    </li>
  )
  const Head = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
    <div className="flex items-center gap-2 px-2.5 pt-4 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-faint">{icon}{children}</div>
  )

  return (
    <section className="card p-2 lg:flex-1 lg:min-h-[180px] lg:overflow-y-auto overscroll-contain">
      {sportLabel}
      <ul className="space-y-0.5">
        <li>
          <button onClick={() => onSelect('ALL')} className={`side-item ${selected === 'ALL' ? 'side-item-active' : ''}`}>
            <span className="w-5 h-5 rounded-md bg-surface2 grid place-items-center text-[10px] font-bold text-muted">∞</span>
            {t('All leagues')}<span className="ml-auto num text-xs text-faint">{total}</span>
          </button>
        </li>
        <li>
          <button onClick={() => onSelect('FAV')} className={`side-item ${selected === 'FAV' ? 'side-item-active' : ''}`}>
            <span className="w-5 h-5 rounded-md bg-accent/15 grid place-items-center text-accent">
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
            </span>
            {t('My favorites')}<span className="ml-auto num text-xs text-faint">{favCount ?? ''}</span>
          </button>
        </li>
      </ul>

      {/* pinned leagues */}
      <Head icon={<svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" /></svg>}>{t('Pinned leagues')}</Head>
      <ul className="space-y-0.5">{pins.map(l => <Row key={`p${l.code}`} l={l} />)}</ul>

      {/* my teams */}
      <Head icon={<svg viewBox="0 0 24 24" className="w-3 h-3" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>}>{t('My teams')}</Head>
      <ul className="space-y-0.5">
        {teams.map(tm => (
          <li key={tm.key}>
            <Link to={tm.to} className="side-item">
              {tm.logo ? <img src={tm.logo} alt="" className="w-5 h-5 object-contain shrink-0" /> : <span className="w-5 h-5 rounded-full bg-surface2 shrink-0" />}
              <span className="truncate">{tm.name}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link to={addTeamTo} className="side-item text-accent font-bold hover:text-accent">
            <span className="w-5 h-5 grid place-items-center text-lg leading-none">+</span>{t('Add a team')}
          </Link>
        </li>
      </ul>

      {/* international */}
      {intl.length > 0 && <>
        <Head icon={null}>{t('International')}</Head>
        <ul className="space-y-0.5">{intl.map(l => <Row key={`i${l.code}`} l={l} />)}</ul>
      </>}

      {/* countries */}
      {countryList.length > 0 && <Head icon={null}>{t('Countries')}</Head>}
      <ul className="space-y-0.5 pb-1">
        {countryList.map(([c, list]) => {
          const isOpen = open.has(c) || list.some(l => l.code === selected)
          const n = list.reduce((s, l) => s + l.count, 0)
          return (
            <li key={c}>
              <button onClick={() => toggle(c)} className="side-item" aria-expanded={isOpen}>
                <Flag code={c} />
                <span className="truncate">{countryName(c)}</span>
                <span className="ml-auto num text-xs text-faint">{n || ''}</span>
                <span className={`text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
              </button>
              {isOpen && <ul className="space-y-0.5">{list.map(l => <Row key={l.code} l={l} indent />)}</ul>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

type SidebarProps = Parameters<typeof LeagueSidebar>[0]

/**
 * Phones and small tablets (below lg): the games come first. A live strip (when games are on), a row of chips
 * (all, favorites, pinned leagues) and a "Leagues" button that opens the full menu as a bottom sheet.
 */
export function MobileLeagueBar({ side, live, liveCount, chips = true }: { side: SidebarProps; live?: ReactNode[]; liveCount?: number; chips?: boolean }) {
  const [sheet, setSheet] = useState(false)
  const byCode = new Map(side.leagues.map(l => [l.code, l]))
  const pins = side.pinned.map(c => byCode.get(c)).filter(Boolean) as SideLeague[]
  const current = side.selected !== 'ALL' && side.selected !== 'FAV' && !side.pinned.includes(side.selected) ? byCode.get(side.selected) : null
  const chip = (active: boolean) => `shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-sm font-semibold border transition-colors ${active ? 'bg-accent text-bg border-accent' : 'bg-surface2/70 text-ink border-line/70 hover:border-accent/50'}`
  const pick = (c: string) => { side.onSelect(c); setSheet(false) }
  return (
    <div className="lg:hidden -mx-4 sm:-mx-6 mb-5">
      {!!liveCount && live && live.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-2 px-4 sm:px-6 mb-2">
            <span className="w-2 h-2 rounded-full bg-live animate-pulseDot" />
            <span className="font-display font-bold text-ink">{t('Live')}</span>
            <span className="num text-xs text-faint">{liveCount}</span>
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 sm:px-6 pb-1">
            {live.map((n, i) => <div key={i} className="shrink-0 w-56 card p-1.5">{n}</div>)}
          </div>
        </div>
      )}
      {chips && <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 sm:px-6 pb-1">
        <button type="button" onClick={() => setSheet(true)} className={chip(false) + ' !border-accent/50'} aria-haspopup="dialog">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h10" /></svg>
          {t('Leagues')}
        </button>
        <button type="button" onClick={() => pick('ALL')} className={chip(side.selected === 'ALL')}>{t('All')}<span className="num text-[11px] opacity-70">{side.total || ''}</span></button>
        <button type="button" onClick={() => pick('FAV')} className={chip(side.selected === 'FAV')}>
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="currentColor" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" /></svg>
          {t('Favorites')}
        </button>
        {current && (
          <button type="button" onClick={() => pick(current.code)} className={chip(true)}>
            {current.logo ? <img src={current.logo} alt="" className="w-4 h-4 object-contain" /> : <Flag code={current.country} size={16} />}{current.short || current.name}
          </button>
        )}
        {pins.map(l => (
          <button key={l.code} type="button" onClick={() => pick(l.code)} className={chip(side.selected === l.code)}>
            {l.logo ? <img src={l.logo} alt="" className="w-4 h-4 object-contain" /> : <Flag code={l.country} size={16} />}
            <span className="max-w-[140px] truncate">{l.name}</span>
          </button>
        ))}
      </div>}

      {sheet && (
        <div className="fixed inset-0 z-[70] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={t('Leagues')}>
          <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSheet(false)} aria-label={t('Close')} />
          <div className="relative max-h-[85vh] overflow-y-auto overscroll-contain rounded-t-3xl bg-bg border-t border-line shadow-2xl pb-[env(safe-area-inset-bottom)]">
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 bg-surface border-b border-line/60">
              <span className="mx-auto absolute left-1/2 -translate-x-1/2 top-1.5 w-10 h-1 rounded-full bg-line" aria-hidden />
              <span className="font-display text-lg font-bold text-ink">{t('Leagues')}</span>
              <button type="button" onClick={() => setSheet(false)} className="h-9 px-3 rounded-full text-sm font-semibold text-muted hover:text-ink">{t('Close')}</button>
            </div>
            <div className="p-3">
              <LeagueSidebar {...side} onSelect={pick} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Flashscore-style thin league bar over a block of games: flag · COUNTRY: League · count. */
export function LeagueBar({ country, name, logo, to, count }: { country: string; name: string; logo?: string | null; to: string; count: number }) {
  return (
    <Link to={to} className="flex items-center gap-2 h-8 px-3 sm:px-4 bg-surface2/60 border-b border-line/60 hover:bg-surface2 transition-colors min-w-0">
      <Flag code={country} size={16} />
      <span className="min-w-0 truncate text-[11px] leading-none">
        <span className="uppercase tracking-wide font-semibold text-faint">{countryName(country)}: </span>
        <span className="font-bold text-ink">{name}</span>
      </span>
      {logo && <img src={logo} alt="" className="w-3.5 h-3.5 object-contain opacity-80 shrink-0" />}
      <span className="ml-auto text-[10px] font-semibold text-faint num shrink-0">{count}</span>
    </Link>
  )
}

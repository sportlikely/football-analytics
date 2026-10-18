import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { sportOfPath } from '../lib/sports'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t as tt, LOCALE } from '../lib/i18n'

interface TeamHit { id: number; name: string; logo: string; national: boolean }
interface CompHit { code: string; name: string; emblem: string | null; country: string | null }
interface PlayerHit { id: number; name: string; position: string | null; team: string | null; teamLogo: string; country?: string | null }
interface BbHits {
  teams: { id: number; name: string; logo: string | null; league: string }[]
  players: { id: number; name: string; team: string; teamLogo: string | null; league: string; position: string | null }[]
  leagues: { code: string; name: string; country: string; logo: string | null }[]
  games: { id: number; kickoff: string; status: string | null; league: string; home: string; away: string }[]
}
interface MatchHit { id: number; utcDate: string; status: string; competition: string; home: string; away: string; homeCrest?: string; awayCrest?: string }

/** Search leagues, teams (every club and national team we track), players and upcoming / live matches. "/" focuses it. */
export default function SearchBox({ compact = false, onDone }: { compact?: boolean; onDone?: () => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [teams, setTeams] = useState<TeamHit[]>([])
  const [matches, setMatches] = useState<MatchHit[]>([])
  const [comps, setComps] = useState<CompHit[]>([])
  const [players, setPlayers] = useState<PlayerHit[]>([])
  const [bb, setBb] = useState<BbHits | null>(null)
  const [af, setAf] = useState<BbHits | null>(null)
  const openSport = sportOfPath(useLocation().pathname).id
  const onBasketball = openSport === 'basketball', onNfl = openSport === 'american-football'
  const [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  // fix170: the header box picks a placeholder that fits its width (never a cut-off word); the "/" hint from 300 px
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = box.current
    if (compact || !el) return
    const ro = new ResizeObserver(() => setWidth(Math.round(el.getBoundingClientRect().width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [compact])
  const full = compact || width === 0 || width >= 380
  const placeholder = full ? tt("Search leagues, teams, players") : width >= 300 ? tt("Search teams, players…") : tt("Search")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName)) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    const onClick = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick) }
  }, [])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setTeams([]); setMatches([]); setComps([]); setPlayers([]); setBb(null); setAf(null); return }
    setLoading(true)
    const t = setTimeout(() => {
      axios.get(`${API_URL}/search`, { params: { q: term } })
        .then(r => { setTeams(r.data.data.teams || []); setMatches(r.data.data.matches || []); setComps(r.data.data.competitions || []); setPlayers(r.data.data.players || []); setBb(r.data.data.basketball || null); setAf(r.data.data.americanFootball || null) })
        .catch(() => { setTeams([]); setMatches([]); setComps([]); setPlayers([]); setBb(null); setAf(null) })
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  const done = () => { setOpen(false); setQ(''); onDone?.() }
  const show = open && q.trim().length >= 2
  const has = (h: BbHits | null) => !!h && (h.teams.length + h.players.length + h.leagues.length + h.games.length) > 0
  const bbAny = has(bb), afAny = has(af)
  const fbAny = teams.length + matches.length + comps.length + players.length > 0
  const any = fbAny || bbAny || afAny
  // basketball / American football results: their own block (same look), first on that sport's pages, after football elsewhere
  const sportBlock = (hits: BbHits | null, label: string, base: string) => has(hits) && hits ? (
    <div className="py-1">
      <div className="flex items-center gap-2 px-3 pt-1 pb-1">
        <span className="text-[11px] font-extrabold uppercase tracking-wider text-accent">{label}</span>
        <span className="h-px flex-1 bg-line/60" />
      </div>
      {hits.leagues.map(l => (
        <Link key={`bl${l.code}`} to={`${base}/league/${l.code}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
          {l.logo ? <img src={l.logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" /> : <span className="w-6 h-6 rounded-full bg-surface2" />}
          <span className="text-sm font-semibold text-ink">{l.name}</span>
          <span className="ml-auto text-[11px] text-faint">{l.country}</span>
        </Link>
      ))}
      {hits.teams.length > 0 && <div className="label px-3 pt-2 pb-1">{tt("Teams")}</div>}
      {hits.teams.map(x => (
        <Link key={`bt${x.id}`} to={`${base}/team/${x.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
          {x.logo ? <img src={x.logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" /> : <span className="w-6 h-6 rounded-full bg-surface2" />}
          <span className="text-sm font-semibold text-ink">{x.name}</span>
          <span className="ml-auto text-[11px] text-faint">{x.league}</span>
        </Link>
      ))}
      {hits.players.length > 0 && <div className="label px-3 pt-2 pb-1">{tt("Players")}</div>}
      {hits.players.map(p => (
        <Link key={`bp${p.id}`} to={`${base}/player/${p.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
          <span className="w-6 h-6 rounded-full bg-surface2 grid place-items-center text-[10px] font-bold text-muted flex-shrink-0">{p.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</span>
          <span className="text-sm font-semibold text-ink truncate">{p.name}</span>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint min-w-0">
            {p.teamLogo && <img src={p.teamLogo} alt="" width={14} height={14} className="w-3.5 h-3.5 object-contain flex-shrink-0" />}
            <span className="truncate">{[p.team, p.position].filter(Boolean).join(' · ')}</span>
          </span>
        </Link>
      ))}
      {hits.games.length > 0 && <div className="label px-3 pt-2 pb-1">{tt("Games")}</div>}
      {hits.games.map(g => (
        <Link key={`bg${g.id}`} to={`${base}/game/${g.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
          <span className="text-sm text-ink font-medium truncate">{g.home} – {g.away}</span>
          <span className="ml-auto text-[11px] text-faint whitespace-nowrap">{['Q1', 'Q2', 'Q3', 'Q4', 'OT', 'BT', 'HT'].includes(g.status || '') ? tt("Live") : new Date(g.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
        </Link>
      ))}
    </div>
  ) : null
  const bbBlock = sportBlock(bb, tt("Basketball"), '/basketball')
  const afBlock = sportBlock(af, tt("American football"), '/american-football')

  return (
    <div ref={box} className="relative w-full">
      <label className="flex items-center gap-2.5 h-11 px-4 rounded-2xl bg-surface2/70 border border-line/80 focus-within:border-accent/60 transition-colors">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-muted flex-shrink-0" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <span className="sr-only">{tt("Search")}</span>
        <input
          ref={input}
          type="search"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Escape') setOpen(false)
            if (e.key === 'Enter') {
              // fix144: the open sport's first team / player
              const own = onNfl ? af : onBasketball ? bb : null, base = onNfl ? '/american-football' : '/basketball'
              if (own?.teams[0]) { nav(`${base}/team/${own.teams[0].id}`); done(); return }
              if (own?.players[0]) { nav(`${base}/player/${own.players[0].id}`); done(); return }
              const bbFirst = onBasketball || (!teams.length && !players.length && !comps.length)
              if (bbFirst && bb?.leagues[0] && !bb.teams[0]) { nav(`/basketball/league/${bb.leagues[0].code}`); done(); return }
              if (bbFirst && bb?.teams[0]) { nav(`/basketball/team/${bb.teams[0].id}`); done(); return }
              if (bbFirst && bb?.players[0]) { nav(`/basketball/player/${bb.players[0].id}`); done(); return }
              if (comps[0] && !teams[0]) { nav(`/league/${comps[0].code}`); done() }
              else if (teams[0]) { nav(`/team/${teams[0].id}`); done() }
              else if (players[0]) { nav(`/player/${players[0].id}`); done() }
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm text-ink placeholder:text-faint"
        />
        {!compact && width >= 300 && <kbd className="hidden md:inline text-[11px] text-faint border border-line rounded-md px-1.5 py-0.5">/</kbd>}
      </label>

      {show && (
        <div className="absolute left-0 right-0 mt-2 z-[60] menu-panel p-2 max-h-[70vh] overflow-y-auto">
          {loading && !any && <div className="px-3 py-3 text-sm text-faint">{tt("Searching…")}</div>}
          {!loading && !any && <div className="px-3 py-3 text-sm text-faint">{tt("Nothing found for \"")}{q.trim()}".</div>}
          {onBasketball && bbBlock}
          {onNfl && afBlock}
          {(onBasketball && bbAny || onNfl && afAny) && fbAny && (
            <div className="flex items-center gap-2 px-3 pt-3 pb-1"><span className="text-[11px] font-extrabold uppercase tracking-wider text-accent">{tt("Football")}</span><span className="h-px flex-1 bg-line/60" /></div>
          )}
          {comps.length > 0 && (
            <div className="py-1">
              <div className="label px-3 pb-1">{tt("Leagues and competitions")}</div>
              {comps.map(c => (
                <Link key={c.code} to={`/league/${c.code}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
                  {c.emblem ? <img src={c.emblem} alt="" width={24} height={24} className="w-6 h-6 object-contain" /> : <span className="w-6 h-6 rounded-full bg-surface2" />}
                  <span className="text-sm font-semibold text-ink">{c.name}</span>
                  {c.country && <span className="ml-auto text-[11px] text-faint">{c.country}</span>}
                </Link>
              ))}
            </div>
          )}
          {teams.length > 0 && (
            <div className={`py-1 ${comps.length ? 'border-t border-line/60 mt-1' : ''}`}>
              <div className="label px-3 pb-1">{tt("Teams")}</div>
              {teams.map(t => (
                <Link key={t.id} to={`/team/${t.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
                  <img src={t.logo} alt="" width={24} height={24} className="w-6 h-6 object-contain" />
                  <span className="text-sm font-semibold text-ink">{t.name}</span>
                  {t.national && <span className="ml-auto text-[11px] text-faint">{tt("National team")}</span>}
                </Link>
              ))}
            </div>
          )}
          {players.length > 0 && (
            <div className={`py-1 ${comps.length || teams.length ? 'border-t border-line/60 mt-1' : ''}`}>
              <div className="label px-3 pb-1">{tt("Players")}</div>
              {players.map(p => (
                <Link key={p.id} to={`/player/${p.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
                  <span className="photo-duo w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
                  <img
                    src={`https://media.api-sports.io/football/players/${p.id}.png`}
                    alt=""
                    width={24}
                    height={24}
                    loading="lazy"
                    className="w-full h-full object-cover"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                  />
                  </span>
                  <span className="text-sm font-semibold text-ink truncate">{p.name}</span>
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] text-faint min-w-0">
                    {p.team && <img src={p.teamLogo} alt="" width={14} height={14} className="w-3.5 h-3.5 object-contain flex-shrink-0" />}
                    <span className="truncate">{[p.team || p.country, p.position].filter(Boolean).join(' · ')}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
          {matches.length > 0 && (
            <div className="py-1 border-t border-line/60 mt-1">
              <div className="label px-3 pt-2 pb-1">{tt("Matches")}</div>
              {matches.map(m => (
                <Link key={m.id} to={`/match/${m.id}`} onClick={done} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-surface2">
                  <span className="text-sm text-ink font-medium truncate">{m.home} – {m.away}</span>
                  <span className="ml-auto text-[11px] text-faint whitespace-nowrap">
                    {['IN_PLAY', 'PAUSED'].includes(m.status) ? tt("Live") : new Date(m.utcDate).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}
                  </span>
                </Link>
              ))}
            </div>
          )}
          {!onBasketball && bbBlock && <div className={teams.length + matches.length + comps.length + players.length > 0 ? 'border-t border-line/60 mt-1 pt-1' : ''}>{bbBlock}</div>}
          {!onNfl && afBlock && <div className={fbAny || bbAny ? 'border-t border-line/60 mt-1 pt-1' : ''}>{afBlock}</div>}
        </div>
      )}
    </div>
  )
}

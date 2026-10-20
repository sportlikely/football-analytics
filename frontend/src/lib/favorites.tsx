import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import axios from 'axios'
import { API_URL } from './socket'
import { useAuth } from './auth'
import { t as tt } from './i18n'

/**
 * Favorite leagues, teams and players.
 * Everyone can star things: visitors keep them in this browser; signed-in users keep them in their account
 * (the browser list is merged into the account on sign-in, so favorites follow them to every device).
 */

/** bb-league / bb-team: basketball (Oct 2026); ref = league code / API-Basketball team id.
 *  bb-player / nfl-player (fix153): ref = the provider's player id, teamName / teamIds = their team (games are matched per sport) */
export type FavKind = 'league' | 'team' | 'player' | 'bb-league' | 'bb-team' | 'bb-player' | 'nfl-team' | 'nfl-league' | 'nfl-player' | 'tennis-player' | 'tennis-tournament'
export interface Favorite {
  kind: FavKind
  /** league: competition code · team: name key (same club across data sources) · player: player id */
  ref: string
  name: string
  img?: string | null
  code?: string | null
  /** team ids we have seen for this team (Football-Data and API-Football ids differ) */
  ids?: number[]
  /** players: the club they play for, so their games can be found */
  teamName?: string | null
  teamImg?: string | null
  teamIds?: number[]
  addedAt?: string
}

const KEY = 'b2b-favorites'
const MERGED_KEY = 'b2b-favorites-merged'

function readLocal(): Favorite[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter(f => f && f.kind && f.ref && f.name) : []
  } catch {
    return []
  }
}
function writeLocal(list: Favorite[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode: favorites last for this visit */
  }
}

/** Same club whatever the data source calls it: "Arsenal FC" = "Arsenal", "Bayern München" = "Bayern Munchen". */
export function nameKey(s: string | null | undefined) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && !['fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ssc', 'sv', 'club', 'cp', 'calcio', 'football'].includes(w))
    .join(' ')
}

const same = (a: Favorite, b: { kind: FavKind; ref: string }) => a.kind === b.kind && a.ref === b.ref

interface MatchLike {
  competition?: { code?: string; name?: string } | null
  homeTeam: { id: number; name: string; shortName?: string }
  awayTeam: { id: number; name: string; shortName?: string }
}

interface FavState {
  list: Favorite[]
  has: (kind: FavKind, ref: string) => boolean
  toggle: (f: Favorite) => void
  remove: (kind: FavKind, ref: string) => void
  /** why a match is a favorite ("Premier League", "Arsenal", "Saka"), or [] */
  reasons: (m: MatchLike) => Favorite[]
  synced: boolean
}

const Ctx = createContext<FavState | null>(null)

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const [list, setList] = useState<Favorite[]>(() => readLocal())
  const [synced, setSynced] = useState(false)
  const userId = useRef<number | null>(null)

  const apply = (next: Favorite[]) => {
    setList(next)
    writeLocal(next)
  }

  // Signed in: load the account's favorites, adding anything starred in this browser first (once per account)
  useEffect(() => {
    if (loading) return
    if (!user) {
      // signed out (after being signed in): the account's favorites leave this browser
      if (userId.current !== null) {
        apply([])
        try {
          localStorage.removeItem(MERGED_KEY)
        } catch {
          /* ignore */
        }
      }
      userId.current = null
      setSynced(false)
      return
    }
    if (userId.current === user.id) return
    userId.current = user.id
    let cancelled = false
    let done = false
    ;(async () => {
      try {
        let merged = false
        try {
          merged = localStorage.getItem(MERGED_KEY) === String(user.id)
        } catch {
          /* ignore */
        }
        const local = readLocal()
        const r = merged || !local.length
          ? await axios.get(`${API_URL}/favorites`)
          : await axios.post(`${API_URL}/favorites`, { items: local })
        if (cancelled) return
        try {
          localStorage.setItem(MERGED_KEY, String(user.id))
        } catch {
          /* ignore */
        }
        apply(r.data.data || [])
        setSynced(true)
        done = true
      } catch {
        /* offline: keep the browser list */
      }
    })()
    return () => {
      cancelled = true
      // fix152b: the account check refreshed mid-load: let the next run load again instead of skipping this account
      if (!done) userId.current = null
    }
  }, [user, loading])

  const has = useCallback((kind: FavKind, ref: string) => list.some(f => same(f, { kind, ref })), [list])

  const remove = useCallback(
    (kind: FavKind, ref: string) => {
      apply(list.filter(f => !same(f, { kind, ref })))
      if (user) axios.post(`${API_URL}/favorites/remove`, { kind, ref }).catch(() => undefined)
    },
    [list, user]
  )

  const toggle = useCallback(
    (f: Favorite) => {
      if (list.some(x => same(x, f))) return remove(f.kind, f.ref)
      const item = { ...f, addedAt: new Date().toISOString() }
      apply([...list, item])
      if (user) axios.post(`${API_URL}/favorites`, { items: [item] }).catch(() => undefined)
    },
    [list, user, remove]
  )

  // lookups for matching games quickly
  const index = useMemo(() => {
    const leagues = new Map<string, Favorite>()
    const teamIds = new Map<number, Favorite>()
    const teamNames = new Map<string, Favorite>()
    for (const f of list) {
      if (f.kind === 'league' && f.code) leagues.set(f.code, f)
      if (f.kind === 'team') {
        teamNames.set(f.ref, f)
        for (const id of f.ids || []) teamIds.set(id, f)
      }
    }
    return { leagues, teamIds, teamNames }
  }, [list])

  const reasons = useCallback(
    (m: MatchLike) => {
      const out: Favorite[] = []
      const add = (f?: Favorite) => f && !out.includes(f) && out.push(f)
      if (m.competition?.code) add(index.leagues.get(m.competition.code))
      for (const t of [m.homeTeam, m.awayTeam]) {
        if (!t) continue
        add(index.teamIds.get(t.id))
        add(index.teamNames.get(nameKey(t.name)))
        if (t.shortName) add(index.teamNames.get(nameKey(t.shortName)))
      }
      // favorite players: their club's games (football only; bb-player / nfl-player match in useBbFavorites / useNflFavorites)
      for (const f of list) {
        if (f.kind !== 'player' || out.includes(f)) continue
        const k = nameKey(f.teamName)
        if (k && [m.homeTeam, m.awayTeam].some(t => t && (nameKey(t.name) === k || nameKey(t.shortName) === k || (f.teamIds || []).includes(t.id)))) out.push(f)
      }
      return out
    },
    [index, list]
  )

  return <Ctx.Provider value={{ list, has, toggle, remove, reasons, synced }}>{children}</Ctx.Provider>
}

export function useFavorites(): FavState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFavorites outside FavoritesProvider')
  return ctx
}

/** Star button: adds or removes one favorite. */
export function FavStar({ fav, size = 'md', label = false, tone, className = '' }: { fav: Favorite; size?: 'sm' | 'md'; label?: boolean; tone?: 'dark'; className?: string }) {
  const { has, toggle } = useFavorites()
  const on = has(fav.kind, fav.ref)
  const title = on ? tt("Remove {0} from favorites", { 0: fav.name }) : tt("Add {0} to favorites", { 0: fav.name })
  const px = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
  return (
    <button
      type="button"
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        toggle(fav)
      }}
      aria-pressed={on}
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-full transition-colors ${
        label ? `px-3 py-1.5 text-xs font-semibold border ${on ? 'bg-accent/15 border-accent/50 text-accent' : tone === 'dark' ? 'border-white/25 text-[#C9D0DB] hover:text-white hover:border-white/50' : 'border-line text-muted hover:text-ink hover:border-ink/30'}` : `p-1 ${on ? 'text-accent' : 'text-faint hover:text-ink'}`
      } ${className}`}
    >
      <svg viewBox="0 0 24 24" className={px} fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path strokeLinejoin="round" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z" />
      </svg>
      {label && (on ? tt('Favorite') : fav.kind === 'league' || fav.kind === 'bb-league' || fav.kind === 'nfl-league' ? tt('Add league to favorites') : fav.kind === 'team' || fav.kind === 'bb-team' || fav.kind === 'nfl-team' ? tt('Add team to favorites') : tt('Add player to favorites'))}
    </button>
  )
}

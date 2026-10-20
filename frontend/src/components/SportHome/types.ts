/**
 * The one home page of every sport (fix141): components/SportHome renders the football layout; each sport only adds an
 * adapter (lib data + labels, no layout). Football, basketball and NFL use it; tennis will only add an adapter.
 */

/** A team (or player) as the home page shows it. */
export interface HTeam {
  id: number | string; name: string; short: string; logo: string | null; tla?: string | null; href: string
  /** fix193: individual sports (tennis) — the player's flag (emoji) instead of a crest, and the world ranking */
  flag?: string | null; rank?: number | null
}

/** One result cell of a prediction: "1 · 54%" (football 1 / X / 2, basketball and NFL 1 / 2, tennis the two players). */
export interface HCell { key: string; head: string; label: string; pct: number; on: boolean }

/** "Our pick · {words} · %" — help = the "?" that opens the double-chance guide (football). */
export interface HPick { words: string; tag?: string | null; pct: number | null; strong: boolean; help?: boolean }

export type HPred =
  | { kind: 'full'; cells: HCell[]; pick: HPick | null }
  /** heads = the cells a locked row draws blurred (fix160: football 1 · X · 2, winner sports 1 · 2) */
  | { kind: 'locked'; pick?: HPick | null; heads?: string[] }
  | { kind: 'none' }

export interface HGame {
  id: number
  href: string
  /** router state for the game page (football passes the match so the page opens at once) */
  linkState?: unknown
  /** "guess first" cover (lib/reveal): the id and status the reveal helper uses; null = never covered */
  reveal: { id: number; status: string } | null
  kickoff: string
  /** fix174: href = the competition's page (league / standings) */
  competition: { name: string; emblem?: string | null; href?: string | null }
  home: HTeam
  away: HTeam
  /** live games: the clock label ("67'", "Q3") and the score */
  live?: { label: string; score: [number, number] } | null
  pred: HPred
}

export interface HNews { title: string; link: string; source: string; published: string | null; summary?: string; image?: string | null; imageKind?: 'photo' | 'logo'; leagues?: { code: string; name: string }[] }

/** "Our record" bars: label, hit rate and games (rows under 30 games are not shown; at most 6, high → low). */
export interface HRecordRow { key: string; label: string; pct: number | null; n: number }
export interface HRecord {
  /** null = still loading */
  rows: HRecordRow[] | null
  aside?: string | null
  note: string
  link: { to: string; label: string } | null
  /** shown when no row has 30+ games yet */
  empty: { title?: string; text: string }
}

/** The sport's special card: football "Draw picks", basketball / NFL "Upset watch". */
export interface HSpecialItem { id: number; href: string; league: string; date: string; title: string; main: { label: string; value: string }; extra?: { label: string; value: string } | null }
export interface HSpecial {
  title: string
  tone: 'draw' | 'loss'
  /** the viewer may see the picks (Pro); otherwise the locked teaser */
  open: boolean
  items: HSpecialItem[]
  empty: string
  locked: { title: string; text: string }
  link: { to: string; label: string }
}

/** "Latest results": finished games with our pick and ✓ / ✗ ("x / y picks right"). */
export interface HResult { id: number; href: string; competition: string; date: string; home: { name: string; logo: string | null; score: number | string; won: boolean }; away: { name: string; logo: string | null; score: number | string; won: boolean }; pick: HPick | null; hit: boolean | null }
export interface HResults { rows: HResult[] | null; days: number; link?: { to: string; label: string } | null }

export interface SportHomeData {
  loaded: boolean
  /** featured carousel (1 = a single hero) */
  featured: HGame[]
  live: HGame[]
  /** "Next kick-offs" beside the hero (5) */
  soonest: HGame[]
  favorites: HGame[]
  next: HGame[]
  news: HNews[]
  record: HRecord
  special: HSpecial
  results: HResults
  /** first-visit stat tiles (signed-out visitors) */
  introStats?: { value: string; label: string; sub: string }[]
  /** viewer sees every prediction (Pro / admin): no Premium card */
  full: boolean
}

export interface SportAdapter {
  /** the playing surface drawn under the hero */
  field: 'pitch' | 'court' | 'gridiron' | 'tennis'
  /** an admin preview line on top while the sport is not public */
  banner?: string | null
  /** fix142: a league toggle on top (American football: NFL | College) */
  switcher?: { value: string; options: { key: string; label: string; to: string }[] } | null
  labels: {
    featured: string
    modelPrediction: string
    nextList: string
    nextSection: string
    all: { to: string; label: string }
    today: { to: string; label: string }
    favorites: string
    liveDetail: string
    emptyHero: [string, string, string]
    newsLoading: string
    premiumText: string
  }
  intro: { title: string; text: string; bullets: [string, string][]; cta: { to: string; label: string }; second: { to: string; label: string; record?: boolean } }
  useData: () => SportHomeData
}

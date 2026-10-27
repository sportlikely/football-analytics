import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { BrowserRouter as Router, Routes, Route, Link, NavLink, Navigate, matchPath, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import SearchBox from './components/SearchBox'
import PremiumGate from './components/PremiumGate'
import { AuthProvider, useAuth } from './lib/auth'
import { FavoritesProvider } from './lib/favorites'
import Assistant from './components/Assistant'
import AccessibilityMenu, { initA11y } from './components/Accessibility'
import FeedbackButton from './components/FeedbackButton'
import ConsoleGate from './components/ConsoleGate'
import PageSkeleton from './components/PageSkeleton'
import UpdatingPill from './components/UpdatingPill'
import SportSwitch from './components/SportSwitch'
import { useBbConfig } from './lib/bb'
import { useNflConfig, useNflLeague } from './lib/nfl'
import { useTennisConfig } from './lib/tennis'
import { sportNav, PAST_OF } from './lib/sportNav'
import { sportOfPath } from './lib/sports'
import { socket } from './lib/socket'
import { useTheme } from './lib/theme'
import { useUnlocks, resetDay } from './lib/unlocks'
import { reportError } from './lib/report'
import { isChunkError, isReloading, reloadForNewVersion, moduleDefault } from './lib/chunkReload'
import { HUBS, hubHref } from './lib/hubs'
import { howPath } from './lib/howItWorks'
import { SOCIAL, type SocialId } from './lib/social'
import { t as tt, basename, applyHeadLang, LANGS, lang, setLang, type Lang } from './lib/i18n'
import { SlugRoute, OldLink, MovedPage } from './components/SlugRoute'
import { useSlugVersion } from './lib/links'

/**
 * Speed (Oct 2026): every page is its own small file, loaded when it is first opened, so the home page no longer
 * downloads the whole site (admin, CRM, basketball…) before showing anything. The most visited pages are fetched
 * quietly in the background a moment after the first page is up.
 * After a new version is deployed, the old page files no longer exist: a tab that was open from before reloads once
 * and gets the new version (instead of a blank page). fix167: at most once a minute (lib/chunkReload.ts), so a page
 * that really can't load shows its error instead of looping, and a later deploy in the same tab reloads again.
 */
function page<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  const never = () => new Promise<{ default: T }>(() => undefined) // the page is reloading: keep showing the loader
  return lazy(() =>
    load().then(
      m => {
        if (m?.default) return m
        // Vite's loader returns nothing when its vite:preloadError was handled (lib/chunkReload.ts reloads); fix252: a
        // module without its default export is a failed load too (one hard reload, else the page's error box)
        if (isReloading() || reloadForNewVersion()) return never()
        return { default: moduleDefault(m) }
      },
      err => {
        if (isReloading() || (isChunkError(err) && reloadForNewVersion())) return never()
        throw err
      }
    )
  )
}
const loadDashboard = () => import('./pages/Dashboard')
const loadMatch = () => import('./pages/MatchDetail')
const loadLeague = () => import('./pages/League')
const Dashboard = page(loadDashboard)
const MatchDetail = page(loadMatch)
const League = page(loadLeague)
const Team = page(() => import('./pages/Team'))
const Player = page(() => import('./pages/Player'))
const Search = page(() => import('./pages/Search'))
const AccuracySimple = page(() => import('./pages/AccuracySimple'))
const Past = page(() => import('./pages/Past'))
const DrawAlerts = page(() => import('./pages/DrawAlerts'))
const UpsetWatch = page(() => import('./pages/UpsetWatch'))
const Login = page(() => import('./pages/Login'))
const Account = page(() => import('./pages/Account'))
const Premium = page(() => import('./pages/Premium'))
const Admin = page(() => import('./pages/Admin'))
const AdminAction = page(() => import('./pages/AdminAction'))
const Verify = page(() => import('./pages/Verify'))
const Forgot = page(() => import('./pages/Forgot'))
const Favorites = page(() => import('./pages/Favorites'))
const MyPicks = page(() => import('./pages/MyPicks'))
const NflAccuracy = page(() => import('./pages/nfl/NflAccuracy'))
const NflPast = page(() => import('./pages/nfl/NflPast'))
const Accessibility = page(() => import('./pages/Accessibility'))
const Contact = page(() => import('./pages/Contact'))
const Join = page(() => import('./pages/Join'))
const Crm = page(() => import('./pages/Crm'))
const SportSoon = page(() => import('./pages/SportSoon'))
const Today = page(() => import('./pages/Today'))
const Guide = page(() => import('./pages/Guide'))
const LeagueHub = page(() => import('./pages/LeagueHub'))
const HowItWorks = page(() => import('./components/sport/HowItWorks'))
const Changelog = page(() => import('./pages/Changelog'))
const GuideIndex = page(() => import('./pages/Guide').then(m => ({ default: m.GuideIndex })))
const BbHome = page(() => import('./pages/bb/BbHome'))
const BbGames = page(() => import('./pages/bb/BbGames'))
const BbGame = page(() => import('./pages/bb/BbGame'))
const BbLeague = page(() => import('./pages/bb/BbLeague'))
const BbTeam = page(() => import('./pages/bb/BbTeam'))
const BbPlayer = page(() => import('./pages/bb/BbPlayer'))
const BbAccuracy = page(() => import('./pages/bb/BbAccuracy'))
const BbPast = page(() => import('./pages/bb/BbPast'))
const BbFavorites = page(() => import('./pages/bb/BbFavorites'))
const NflHome = page(() => import('./pages/nfl/NflHome'))
const NflGames = page(() => import('./pages/nfl/NflGames'))
const NflGame = page(() => import('./pages/nfl/NflGame'))
const NflLeague = page(() => import('./pages/nfl/NflLeague'))
const NflTeam = page(() => import('./pages/nfl/NflTeam'))
const NflPlayer = page(() => import('./pages/nfl/NflPlayer'))
const NflFavorites = page(() => import('./pages/nfl/NflFavorites'))
// fix193: tennis (admin only until TENNIS_PUBLIC=1)
const TennisHome = page(() => import('./pages/tennis/TennisHome'))
const TennisMatches = page(() => import('./pages/tennis/TennisMatches'))
const TennisMatch = page(() => import('./pages/tennis/TennisMatch'))
const TennisPlayer = page(() => import('./pages/tennis/TennisPlayer'))
const TennisTournament = page(() => import('./pages/tennis/TennisTournament'))
const TennisRankings = page(() => import('./pages/tennis/TennisRankings'))
const TennisFavorites = page(() => import('./pages/tennis/TennisFavorites'))
const TennisAccuracy = page(() => import('./pages/tennis/TennisAccuracy'))
const TennisPast = page(() => import('./pages/tennis/TennisPast'))
const Terms = page(() => import('./pages/Legal').then(m => ({ default: m.Terms })))
const Privacy = page(() => import('./pages/Legal').then(m => ({ default: m.Privacy })))
const NotFound = page(() => import('./pages/Legal').then(m => ({ default: m.NotFound })))

/**
 * Safety net (Oct 2026): if something on a page breaks, only that page shows a short message (with "try again"),
 * instead of the whole site going blank. Reset when the visitor goes to another page.
 */
class PageBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: unknown) { console.error('page error', err); reportError(err, 'page') }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="min-h-[60vh] grid place-items-center px-4">
        <div className="card p-8 text-center space-y-3 max-w-md">
          <div className="font-display text-lg font-bold text-ink">{tt("Something went wrong on this page")}</div>
          <p className="text-sm text-muted">{tt("The rest of the site works. Try again, or go back to the home page.")}</p>
          <div className="flex justify-center gap-2 pt-1">
            <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-xl bg-accent text-bg font-semibold text-sm">{tt("Try again")}</button>
            <a href={basename + '/'} className="px-4 py-2 rounded-xl border border-line text-ink font-semibold text-sm">{tt("Home")}</a>
          </div>
        </div>
      </div>
    )
  }
}
function PageGuard({ children }: { children: ReactNode }) {
  const loc = useLocation()
  return <PageBoundary key={loc.pathname}>{children}</PageBoundary>
}

// fix250: the shape of a page while its code loads (never an empty screen under the header)
const PageLoading = PageSkeleton

export function LogoMark({ size = 36 }: { size?: number }) {
  return <img src="/logo-mark.png" width={size} height={size} alt="" aria-hidden className="flex-shrink-0 rounded-[10px]" />
}

/** Pages only the admin sees; everyone else gets "not found". */
/** Record pages are admin-only for now (fix118, 14 Oct 2026, until redesigned): everyone else goes to the sport's home. */
function RecordGate({ home, children }: { home: string; children: ReactNode }) {
  const { access, loading } = useAuth()
  if (loading) return null
  return access === 'admin' ? <>{children}</> : <Navigate to={home} replace />
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { access, loading, user, logout } = useAuth()
  const loc = useLocation()
  if (loading) return null
  if (access === 'admin') return <>{children}</>
  // fix239: a link from an admin email opened without a session: sign in first, then back to the same address
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />
  // an admin whose session did not pass two-step login: sign in again with the code
  if (user?.isAdmin)
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-3">
        <h1 className="font-display text-2xl font-extrabold text-ink">Two-step login needed</h1>
        <p className="text-sm text-muted">
          {user.twoFactor
            ? 'This device signed in without the two-step code. Sign out and sign in again with your password and the code from your app.'
            : 'Admin access needs two-step login. Set it up on your account page, then come back.'}
        </p>
        {user.twoFactor ? (
          <button type="button" onClick={() => logout()} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">Sign out</button>
        ) : (
          <Link to="/account" className="inline-block rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">Go to account</Link>
        )}
      </div>
    )
  return <NotFound />
}

/** Model & data pages (past seasons): admin, or staff whose role has the 'Model & data' permission. */
function ModelOnly({ children }: { children: ReactNode }) {
  const { access, loading, can } = useAuth()
  if (loading) return null
  return access === 'admin' || can('model') ? <>{children}</> : <NotFound />
}

/** fix145: the logo opens the home of the sport on screen (the router's basename keeps /de, /es …). */
function Logo() {
  const home = sportOfPath(useLocation().pathname).path
  return (
    <Link to={home} className="flex items-center gap-2.5 group shrink-0 whitespace-nowrap" aria-label={tt("SportLikely home")}>
      <LogoMark />
      {/* fix213: the wordmark from 430 px (at 390 px it pushed "Sign in" off a phone screen) */}
      <span className="hidden min-[430px]:inline-flex lg:hidden 2xl:inline-flex items-center" aria-hidden>
        <img src="/wordmark-dark.png" alt="" className="hidden dark:block h-[22px] w-auto" />
        <img src="/wordmark-light.png" alt="" className="block dark:hidden h-[22px] w-auto" />
      </span>
    </Link>
  )
}

function ThemeToggle({ theme, onToggle }: { theme: 'dark' | 'light'; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-9 h-9 grid place-items-center rounded-xl border border-line/80 bg-surface text-muted hover:text-ink hover:border-faint transition-colors"
      title={theme === 'dark' ? tt("Switch to light") : tt("Switch to dark")}
      aria-label={tt("Toggle theme")}
    >
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  )
}

/** Language: a small select in the header; changing it opens the same page under the other prefix. */
function LangSwitch({ compact = false }: { compact?: boolean }) {
  // Header: globe + short code ("EN"), the full names are in the list. Footer: the full name.
  return (
    <label
      className={`relative inline-flex items-center gap-1.5 ${compact ? '' : 'h-9 px-2.5 rounded-xl border border-line/80 bg-surface hover:border-faint'} text-muted cursor-pointer`}
      title={tt('Language')}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
      </svg>
      {compact ? (
        <span className="text-sm font-semibold text-ink">{LANGS[lang].name}</span>
      ) : (
        <span className="text-sm font-bold text-ink uppercase">{lang}</span>
      )}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      <select
        value={lang}
        onChange={e => setLang(e.target.value as Lang)}
        aria-label={tt('Language')}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
      >
        {(Object.keys(LANGS) as Lang[]).map(l => (
          <option key={l} value={l} className="text-ink bg-surface">{LANGS[l].name}</option>
        ))}
      </select>
    </label>
  )
}

function UserMenu() {
  const { user, access, staff, can, loading, logout } = useAuth()
  const unl = useUnlocks(!!user && (access === 'free' || access === 'premium')) // fix147: pick balance
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setOpen(false), [loc.pathname, loc.search])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (loading) return <div className="w-9 h-9" />
  if (!user)
    return (
      <Link
        to={['/login', '/signup', '/verify', '/forgot'].includes(loc.pathname) ? '/login' : `/login?next=${encodeURIComponent(loc.pathname)}`}
        className="px-3.5 py-2 rounded-xl bg-accent text-bg text-sm font-semibold whitespace-nowrap">
        {tt("Sign in")}</Link>
    )
  const badge = access === 'admin' ? 'Founder' : access === 'pro' ? 'Pro' : access === 'premium' ? 'Premium' : 'Free'
  const pastTo = PAST_OF[sportOfPath(loc.pathname).id] // fix144: each sport's past seasons
  const roleName = access === 'admin' ? 'Founder' : staff ? staff.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''
  const item = 'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-ink hover:bg-surface2'
  const icon = (d: string) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0" aria-hidden><path d={d} /></svg>
  )
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl border border-line/80 bg-surface hover:border-faint transition-colors"
        title={user.email}
      >
        <span className="w-7 h-7 rounded-lg bg-accent/15 text-accent grid place-items-center text-xs font-bold uppercase">
          {(user.name || user.email).charAt(0)}
        </span>
        <span className={`text-[11px] font-semibold ${access === 'free' ? 'text-muted' : 'text-accent'}`}>{badge}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-60 z-[60] menu-panel p-1.5">
          <div className="px-3 py-2 border-b border-line/60 mb-1">
            <div className="text-sm font-semibold text-ink truncate">{user.name || user.email.split('@')[0]}</div>
            <div className="text-[11px] text-faint truncate">{user.email}</div>
          </div>
          {(access === 'free' || access === 'premium') && (
            <Link to="/premium/packs" role="menuitem" className={item}>{icon('M4 7h16v12H4zM8 7V5h8v2M4 11h16')}<span className="flex-1">{tt("Pick packs")}</span><span className="num text-xs font-bold text-accent">{unl?.credits ?? 0}</span></Link>
          )}
          <Link to="/football/my-picks" role="menuitem" className={item}>{icon('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9')}{tt("My picks")}</Link>
          <Link to="/account" role="menuitem" className={item}>{icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z')}{tt("Settings")}</Link>
          {(staff || can('model')) && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Staff{roleName ? ` · ${roleName}` : ''}</div>
              {staff && <Link to="/crm" role="menuitem" className={item}>{icon('M4 4h16v12H5.2L4 17.2V4zM8 9h8M8 12h5')}CRM</Link>}
              {access === 'admin' && (
                <Link to="/admin" role="menuitem" className={item}>{icon('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8')}Users</Link>
              )}
              {(access === 'admin' || can('model')) && (
                <Link to={pastTo} role="menuitem" className={item}>{icon('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2')}Past seasons</Link>
              )}
            </>
          )}
          <div className="border-t border-line/60 mt-1 pt-1">
            <button type="button" role="menuitem" onClick={() => { setOpen(false); logout() }} className={`${item} w-full text-left text-muted`}>
              {icon('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9')}{tt("Sign out")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Reminder for signed-in users who haven't confirmed their email yet. */
/** Premium: a nudge when the monthly unlocks run low (10 or fewer left). */
function UnlocksBanner() {
  const { access } = useAuth()
  const u = useUnlocks(access === 'premium')
  if (access !== 'premium' || !u || u.left === null || u.left > 10) return null
  return (
    <div className="border-b border-accent/30 bg-accent/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-ink">
          {u.left === 0 ? (
            <>{tt("You've used all {0} unlocks this month. They renew on {1}.", { 0: u.allowance, 1: resetDay(u.resetsAt) })}</>
          ) : (
            <><b className="num">{u.left}</b> {tt("{n, plural, one {unlock} other {unlocks}} left this month. You're using SportLikely a lot.", { n: u.left })}</>
          )}
        </span>
        <Link to="/premium" className="px-3 py-1 rounded-lg bg-accent text-bg text-xs font-extrabold">
          {tt("Pro is unlimited →")}</Link>
      </div>
    </div>
  )
}

function VerifyBanner() {
  const { needsVerification } = useAuth()
  const loc = useLocation()
  if (!needsVerification || loc.pathname === '/verify') return null
  return (
    <div className="bg-draw/15 border-b border-draw/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 text-sm text-ink flex flex-wrap items-center justify-between gap-2">
        <span>{tt("Confirm your email to finish creating your account.")}</span>
        <Link to={`/verify?next=${encodeURIComponent(loc.pathname)}`} className="font-semibold text-draw">
          {tt("Enter code →")}</Link>
      </div>
    </div>
  )
}

/** Basketball menu (Oct 2026): Home · Games · Favorites · Accuracy · Past seasons (admin). */

/** The open sport's basketball section is live for this visitor (admins before launch, everyone after). */
function useBbOpen() {
  const loc = useLocation()
  const cfg = useBbConfig()
  // while the config loads on a basketball page, show the basketball menus (no flash of the football ones)
  return sportOfPath(loc.pathname).id === 'basketball' && (cfg === null ? true : !!cfg.open)
}

/** Footer (fix125): this week's predictions for the big leagues (basketball ones once basketball is open). */
function FooterHubs() {
  const cfg = useBbConfig()
  const nfl = useNflConfig()
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span>{tt("Predictions this week:")}</span>
      {HUBS.filter(h => h.sport === 'football' || (h.sport === 'basketball' ? !!cfg?.open : !!nfl?.open)).map(h => (
        <Link key={h.slug} to={hubHref(h.slug)} className="hover:text-ink">{h.name}</Link>
      ))}
    </div>
  )
}

/** Footer (fix134): small icons to our social accounts (lib/social.ts); accounts without a URL yet are hidden. */
const SOCIAL_ICON: Record<SocialId, string> = {
  instagram: 'M12 2.2c3.2 0 3.6 0 4.8.1 1.2.1 1.8.2 2.2.4.6.2 1 .5 1.4.9.4.4.7.8.9 1.4.2.4.4 1 .4 2.2.1 1.3.1 1.6.1 4.8s0 3.6-.1 4.8c-.1 1.2-.2 1.8-.4 2.2-.2.6-.5 1-.9 1.4-.4.4-.8.7-1.4.9-.4.2-1 .4-2.2.4-1.3.1-1.6.1-4.8.1s-3.6 0-4.8-.1c-1.2-.1-1.8-.2-2.2-.4-.6-.2-1-.5-1.4-.9-.4-.4-.7-.8-.9-1.4-.2-.4-.4-1-.4-2.2C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.8c.1-1.2.2-1.8.4-2.2.2-.6.5-1 .9-1.4.4-.4.8-.7 1.4-.9.4-.2 1-.4 2.2-.4C8.4 2.2 8.8 2.2 12 2.2zm0 3.1a6.7 6.7 0 1 0 0 13.4 6.7 6.7 0 0 0 0-13.4zm0 2.2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm6.9-2.4a1.6 1.6 0 1 0 0 3.1 1.6 1.6 0 0 0 0-3.1z',
  x: 'M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.3l4.4 5.9L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z',
  tiktok: 'M16.6 2c.3 2.4 1.7 4 4.1 4.2v3.1c-1.5.1-2.8-.4-4.1-1.2v5.9c0 7.4-8.1 9.7-11.3 4.4-2.1-3.4-.8-9.3 6-9.5v3.3c-.5.1-1.1.2-1.6.4-1.5.5-2.4 1.5-2.1 3.2.5 3.2 6.4 4.1 5.9-2.1V2h3.1z'
}
function FooterSocial() {
  return (
    <div className="flex items-center gap-1">
      {SOCIAL.filter(s => s.url).map(s => (
        <a key={s.id} href={s.url!} target="_blank" rel="me noopener" aria-label={tt("SportLikely on {0}", { 0: s.name })} title={tt("SportLikely on {0}", { 0: s.name })}
          className="grid place-items-center w-8 h-8 rounded-full text-muted hover:text-ink hover:bg-surface2/70 transition-colors">
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden><path d={SOCIAL_ICON[s.id]} /></svg>
        </a>
      ))}
    </div>
  )
}


/** The NFL section is live for this visitor (admins before launch, everyone once NFL_PUBLIC=1). */
/** fix193: the tennis section is live for this visitor (admins before launch, everyone once TENNIS_PUBLIC=1). */
function useTennisOpen() {
  const loc = useLocation()
  const cfg = useTennisConfig()
  return sportOfPath(loc.pathname).id === 'tennis' && (cfg === null ? true : !!cfg.open)
}

function useNflOpen() {
  const loc = useLocation()
  const cfg = useNflConfig()
  return sportOfPath(loc.pathname).id === 'american-football' && (cfg === null ? true : !!cfg.open)
}

/** Footer (fix137): American football link once the NFL site is open for this visitor. */
/** fix206: "How it works" opens the how-it-works page of the sport on screen (football's elsewhere). */
function FooterHow() {
  const sport = sportOfPath(useLocation().pathname).id
  return <Link to={howPath(sport) || '/how-it-works'} className="hover:text-ink">{tt("How it works")}</Link>
}

function FooterNfl() {
  const cfg = useNflConfig()
  if (!cfg?.open) return null
  return <Link to="/american-football" className="hover:text-ink">{tt("American football")}</Link>
}

/** Footer data line for the sport on screen. */
function DataLine() {
  const sport = sportOfPath(useLocation().pathname).id
  if (sport === 'american-football') return <p>{tt("Data: API-American-Football.")}</p>
  if (sport === 'tennis') return <p>{tt("Data: Live Tennis API.")}</p>
  const bb = sport === 'basketball'
  return <p>{bb ? tt("Data: API-Basketball, balldontlie (NBA players and injuries).") : tt("Data: Football-Data.org, API-Football, football-data.co.uk, Transfermarkt (squad values).")}</p>
}

/** The menu of the sport on screen (fix144: one config for every sport, lib/sportNav.ts), then Premium / Go Pro. */
/** Desktop tabs (xl+). fix157: the header never makes the page wider than the window. fix170: the search box keeps
 *  260 px (grows to 420 px): when the row lacks room the tabs move into a "More" menu first — admin-only tabs before
 *  any public tab, then public tabs from the end. Only when even every tab in "More" doesn't fit does the search go
 *  down to 200 px (never below). The search width is set on the row as --search-min. */
function HeaderNav({ cls }: { cls: (a: { isActive: boolean }) => string }) {
  const { access } = useAuth()
  const bb = useBbOpen()
  const nfl = useNflOpen()
  const tennis = useTennisOpen()
  const { base } = useNflLeague()
  const loc = useLocation()
  const items: { key: string; to: string; end: boolean; label: string; admin: boolean }[] = sportNav(tennis ? 'tennis' : nfl ? 'american-football' : bb ? 'basketball' : 'football', base)
    .filter(i => !i.admin || access === 'admin').map(i => ({ key: i.key, to: i.to, end: !!i.end, label: tt(i.label), admin: !!i.admin }))
  // Oct 2026: Past seasons, Users and CRM live in the account menu (top right), staff only
  if (access !== 'pro' && access !== 'admin') items.push({ key: 'premium', to: '/premium', end: false, label: access === 'premium' ? tt("Go Pro") : tt("Premium"), admin: false })
  const names = items.map(i => i.label).join('|')
  const nav = useRef<HTMLElement>(null)
  const probe = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState('') // keys in "More", "|"-joined
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [loc.pathname, loc.search])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  useLayoutEffect(() => {
    const el = nav.current, row = el?.parentElement, pr = probe.current
    if (!el || !row || !pr) return
    const calc = () => {
      if (getComputedStyle(el).display === 'none') return
      const rs = getComputedStyle(row)
      const gap = parseFloat(rs.columnGap) || 0
      // room for the tabs = row minus the other header parts (search at 260 px), the gaps and the pill's padding
      let room = row.clientWidth - parseFloat(rs.paddingLeft) - parseFloat(rs.paddingRight) - 10
      for (const c of Array.from(row.children) as HTMLElement[]) {
        if (c === el || getComputedStyle(c).display === 'none') continue
        room -= (c.dataset.grow ? 260 : c.getBoundingClientRect().width) + gap
      }
      const w = (Array.from(pr.children) as HTMLElement[]).map(c => c.getBoundingClientRect().width + 2)
      const more = w.pop() ?? 0
      // which tab leaves first: admin-only tabs (from the end), then public tabs from the end
      const order = [...items.keys()].filter(i => items[i].admin).reverse().concat([...items.keys()].filter(i => !items[i].admin).reverse())
      const out = new Set<number>()
      let used = w.reduce((a, b) => a + b, 0)
      if (used > room) {
        used += more
        for (const i of order) { if (used <= room) break; out.add(i); used -= w[i] }
      }
      // every tab in "More" and still no room for a 260 px search: the search may go down to 200 px
      row.style.setProperty('--search-min', used > room ? '200px' : '260px')
      setHidden(items.filter((_, i) => out.has(i)).map(i => i.key).join('|'))
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(row)
    ro.observe(pr)
    for (const c of Array.from(row.children)) if (c !== el) ro.observe(c)
    return () => ro.disconnect()
  }, [names])
  const out = hidden ? hidden.split('|') : []
  const shown = items.filter(i => !out.includes(i.key)), rest = items.filter(i => out.includes(i.key))
  const restActive = rest.some(i => matchPath({ path: i.to, end: i.end }, loc.pathname))
  const moreLabel = (
    <>
      {tt("More")}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`inline ml-1 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
    </>
  )
  return (
    <nav ref={nav} className="relative hidden xl:flex shrink-0 items-center gap-0.5 p-1 rounded-full bg-surface2/60 border border-line/60">
      {shown.map(i => <NavLink key={i.key} to={i.to} end={i.end} className={cls}>{i.label}</NavLink>)}
      {rest.length > 0 && (
        <div ref={box} className="relative">
          <button type="button" onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} className={cls({ isActive: restActive })}>
            {moreLabel}
          </button>
          {open && (
            <div role="menu" className="absolute right-0 mt-2 w-52 z-[60] menu-panel p-1.5">
              {rest.map(i => (
                <NavLink key={i.key} to={i.to} end={i.end} role="menuitem"
                  className={({ isActive }) => `block px-3 py-2 rounded-lg text-sm hover:bg-surface2 ${isActive ? 'text-ink font-bold' : 'text-ink'}`}>
                  {i.label}
                </NavLink>
              ))}
            </div>
          )}
        </div>
      )}
      {/* invisible copy of every tab + "More", used to measure what fits */}
      <div aria-hidden className="absolute left-0 top-0 w-0 h-0 overflow-hidden invisible pointer-events-none">
        <div ref={probe} className="flex w-max">
          {items.map(i => <span key={i.key} className={cls({ isActive: true })}>{i.label}</span>)}
          <span className={cls({ isActive: true })}>{moreLabel}</span>
        </div>
      </div>
    </nav>
  )
}

const TAB_ICONS: Record<string, string> = {
  Home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  Matches: 'M4 5h16v14H4zM4 10h16M9 5v14',
  Alerts: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0',
  Draws: 'M5 12h14M5 7h14M5 17h14',
  Accuracy: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  Favorites: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5z',
  Search: 'M11 18a7 7 0 1 0 0-14a7 7 0 0 0 0 14M20 20l-3.5-3.5',
  Games: 'M4 5h16v14H4zM4 10h16M9 5v14',
  Today: 'M7 3v3M17 3v3M4 8h16M5 5h14v15H5zM9 13h2v2H9z',
  Football: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M12 7l3.5 2.5-1.3 4h-4.4l-1.3-4z',
  Premium: 'M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  Upsets: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  Rankings: 'M4 20h4v-8H4zM10 20h4V4h-4zM16 20h4v-12h-4z'
}

/** Phone: app-style tab bar at the bottom, with a search sheet. */
function BottomTabs() {
  const bb = useBbOpen()
  const nfl = useNflOpen()
  const tennis = useTennisOpen()
  const nflBaseNow = useNflLeague().base
  const { access } = useAuth()
  const admin = access === 'admin' // the Accuracy tab is admin-only for now (fix118)
  // fix144: the phone tabs of the sport on screen come from the same config as the desktop menu
  const tabs = sportNav(tennis ? 'tennis' : nfl ? 'american-football' : bb ? 'basketball' : 'football', nflBaseNow).filter(i => i.tab && (!i.admin || admin))
  const [searching, setSearching] = useState(false)
  const loc = useLocation()
  useEffect(() => setSearching(false), [loc.pathname])
  const tab = (to: string, label: string, end = false) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `h-14 flex flex-col items-center justify-center gap-1 rounded-2xl transition-colors ${isActive ? 'bg-accent text-bg' : 'text-muted'}`
      }
    >
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={TAB_ICONS[label]} />
      </svg>
      <span className="text-[10px] font-bold">{tt(label)}</span>
    </NavLink>
  )
  return (
    <>
      {searching && (
        <div className="xl:hidden fixed inset-0 z-50 bg-bg/95 backdrop-blur-md p-4 pt-6">
          <div className="flex items-center gap-2">
            <div className="flex-1"><SearchBox compact onDone={() => setSearching(false)} /></div>
            <button onClick={() => setSearching(false)} className="h-11 px-3 text-sm font-semibold text-muted">{tt("Close")}</button>
          </div>
        </div>
      )}
      <nav aria-label={tt("Tabs")} className={`xl:hidden fixed left-3 right-3 bottom-3 z-40 grid ${tabs.length >= 5 ? 'grid-cols-6' : 'grid-cols-5'} gap-1 p-1.5 rounded-3xl bg-surface/85 backdrop-blur-xl border border-line/80 shadow-lift sm:max-w-lg sm:mx-auto`}>
        {tabs.map(i => <span key={i.key} className="contents">{tab(i.to, i.tab!, !!i.end)}</span>)}
        <button onClick={() => setSearching(true)} className="h-14 flex flex-col items-center justify-center gap-1 rounded-2xl text-muted" aria-label={tt("Search")}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={TAB_ICONS.Search} />
          </svg>
          <span className="text-[10px] font-bold">{tt("Search")}</span>
        </button>
      </nav>
    </>
  )
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, tt('Home')],
  [/^\/football\/matches/, tt('Matches')],
  [/^\/football\/today/, tt('Football predictions today')],
  [/^\/football\/favorites/, tt('Favorites')],
  [/^\/(football\/)?team\//, tt('Team')],
  [/^\/(football\/)?league\//, tt('League')],
  [/^\/(football\/)?player\//, tt('Player')],
  [/^\/(football\/)?match\//, tt('Match')],
  [/^\/football\/accuracy/, tt('Accuracy')],
  [/^\/changelog/, tt('Changelog')],
  [/^\/football\/draw-alerts/, tt('Draw picks')],
  [/^\/football\/upset-watch/, tt('Upset watch')],
  [/^\/football\/past/, tt('Past seasons')],
  [/^\/premium/, tt('Premium')],
  [/^\/login/, tt('Sign in')],
  [/^\/signup/, tt('Create account')],
  [/^\/account/, tt('Account')],
  [/^\/terms/, tt('Terms of use')],
  [/^\/privacy/, tt('Privacy policy')],
  [/^\/accessibility/, tt('Accessibility statement')],
  [/^\/contact/, tt('Contact us')],
  [/^\/admin/, 'Users']
]
/** Browser tab title per page (the match page sets its own once the teams are loaded). */
function PageTitle() {
  const loc = useLocation()
  useEffect(() => {
    applyHeadLang(loc.pathname)
    const t = TITLES.find(([re]) => re.test(loc.pathname))?.[1]
    document.title = t && t !== 'Home' ? tt("{0} · SportLikely", { 0: t }) : tt("SportLikely · Sports predictions, tested in public")
  }, [loc.pathname])
  return null
}

initA11y()

function App() {
  return (
    <AuthProvider>
      <FavoritesProvider>
        <Shell />
      </FavoritesProvider>
    </AuthProvider>
  )
}

function Shell() {
  useSlugVersion() // fix229: links are drawn again when a sport's slug exceptions arrive
  const [connected, setConnected] = useState(socket.connected)
  const { theme, toggle } = useTheme()

  useEffect(() => {
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    if (!socket.connected) socket.connect()
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [])

  // fetch the most visited pages in the background once the first page is up (instant when clicked)
  useEffect(() => {
    const t = setTimeout(() => { loadDashboard().catch(() => undefined); loadMatch().catch(() => undefined); loadLeague().catch(() => undefined) }, 3000)
    return () => clearTimeout(t)
  }, [])

  const navCls = ({ isActive }: { isActive: boolean }) =>
    `px-2.5 2xl:px-3 py-1.5 rounded-full text-[13px] transition-colors whitespace-nowrap ${isActive ? 'bg-ink text-bg font-bold' : 'text-muted font-medium hover:text-ink'}`

  return (
    <Router basename={basename}>
      <div className="min-h-screen">
        <div className="stage" aria-hidden />
        <a href="#main" className="skip-link">{tt("Skip to content")}</a>
        <header className="sticky top-0 z-40 backdrop-blur-xl bg-bg/70 border-b border-line/50">
          <div className="max-w-7xl 2xl:max-w-[1440px] mx-auto px-4 sm:px-6 h-16 sm:h-[72px] flex items-center gap-2 sm:gap-3">
            <SportSwitch />
            <Logo />
            <HeaderNav cls={navCls} />
            <div data-grow className="hidden lg:block flex-[1_1_320px] min-w-[var(--search-min,260px)] max-w-[420px] ml-auto">
              <SearchBox />
            </div>
            <div className="flex shrink-0 items-center gap-2 ml-auto lg:ml-0">
              <div
                className={`hidden md:inline-flex items-center gap-2 px-2.5 2xl:px-3 py-1.5 h-9 rounded-full text-xs font-bold ${
                  connected ? 'text-live bg-live/10' : 'text-faint bg-surface2'
                }`}
                title={connected ? tt("Live updates connected") : tt("Reconnecting…")}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-live animate-pulseDot' : 'bg-faint'}`} />
                {/* fix170: dot only (the label is the tooltip), so wide windows keep their tabs */}
                <span className="sr-only">{connected ? tt("Live") : tt("Offline")}</span>
              </div>
              <div className="hidden md:block"><LangSwitch /></div>
              <ThemeToggle theme={theme} onToggle={toggle} />
              <UserMenu />
            </div>
          </div>
        </header>

        <PageTitle />
        <VerifyBanner />
        <UnlocksBanner />
        <UpdatingPill />
        <main id="main" tabIndex={-1}>
          <PageGuard>
          <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            {/* fix206: how our models work (every sport) + the changelog */}
            <Route path="/how-it-works" element={<HowItWorks sport="football" />} />
            <Route path="/changelog" element={<Changelog />} />
            <Route path="/credits" element={<Navigate to="/" replace />} /> {/* fix241: photo credits gone (official photos only) */}
            <Route path="/guides" element={<GuideIndex />} />
            <Route path="/guides/:slug" element={<Guide />} />
            {/* fix229: clean links — /football/<kind>/<slug>; the old id addresses move to them (the server 301s them on load) */}
            {/* fix235: every football page is under /football (same page names in every sport); a tab is a sub-path */}
            <Route path="/football" element={<Home />} />
            <Route path="/football/matches" element={<Dashboard />} />
            <Route path="/football/today" element={<Today sport="football" />} />
            <Route path="/football/predictions/:league" element={<LeagueHub />} />
            <Route path="/football/favorites" element={<Favorites />} />
            <Route path="/football/my-picks" element={<MyPicks />} />
            <Route path="/football/accuracy" element={<RecordGate home="/football"><AccuracySimple /></RecordGate>} />
            <Route path="/football/upset-watch" element={<PremiumGate title="Upset watch" pro text={tt("Upset watch: the coming games where our model gives the underdog the best chance. Part of Pro, together with unlimited predictions.")}><UpsetWatch /></PremiumGate>} />
            <Route path="/football/draw-alerts" element={<PremiumGate title="Draw picks" pro><DrawAlerts /></PremiumGate>} />
            <Route path="/football/past" element={<ModelOnly><Past /></ModelOnly>} />
            <Route path="/football/team/:slug" element={<SlugRoute sport="football" kind="team"><Team /></SlugRoute>} />
            <Route path="/football/league/:slug/*" element={<SlugRoute sport="football" kind="league"><League /></SlugRoute>} />
            <Route path="/football/player/:slug" element={<SlugRoute sport="football" kind="player"><Player /></SlugRoute>} />
            <Route path="/football/match/:slug/*" element={<SlugRoute sport="football" kind="match"><MatchDetail /></SlugRoute>} />
            <Route path="/team/:id" element={<OldLink sport="football" kind="team" />} />
            <Route path="/league/:code" element={<OldLink sport="football" kind="league" />} />
            <Route path="/player/find" element={<Player />} />
            <Route path="/player/:id" element={<OldLink sport="football" kind="player" />} />
            <Route path="/match/:id" element={<OldLink sport="football" kind="match" />} />
            <Route path="/matches" element={<MovedPage />} />
            <Route path="/predictions/today" element={<MovedPage />} />
            <Route path="/predictions/:league" element={<MovedPage />} />
            <Route path="/favorites" element={<MovedPage />} />
            <Route path="/my-picks" element={<MovedPage />} />
            <Route path="/accuracy" element={<MovedPage />} />
            <Route path="/upset-watch" element={<MovedPage />} />
            <Route path="/draw-alerts" element={<MovedPage />} />
            <Route path="/past" element={<MovedPage />} />
            <Route path="/search" element={<Search />} />
            <Route path="/login" element={<Login mode="login" />} />
            <Route path="/signup" element={<Login mode="signup" />} />
            <Route path="/account" element={<Account />} />
            <Route path="/account/emails" element={<Account />} />
            <Route path="/account/alerts" element={<Account />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="/forgot" element={<Forgot />} />
            <Route path="/premium" element={<Premium />} />
            <Route path="/premium/packs" element={<Premium />} />
            <Route path="/admin" element={<AdminOnly><ConsoleGate><Admin /></ConsoleGate></AdminOnly>} />
            <Route path="/admin/:tab" element={<AdminOnly><ConsoleGate><Admin /></ConsoleGate></AdminOnly>} />
            <Route path="/admin/act/:token" element={<AdminOnly><ConsoleGate><AdminAction /></ConsoleGate></AdminOnly>} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/accessibility" element={<Accessibility />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/join/:code" element={<Join />} />
            <Route path="/crm" element={<ConsoleGate><Crm /></ConsoleGate>} />
            <Route path="/basketball/*" element={<BbRoutes />} />
            <Route path="/tennis/*" element={<TennisRoutes />} />
            <Route path="/baseball/*" element={<SportSoon sport="baseball" />} />
            <Route path="/american-football/*" element={<NflRoutes />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </PageGuard>
        </main>

        <footer className="max-w-7xl mx-auto px-4 sm:px-6 pt-10 pb-28 xl:pb-10 text-xs text-faint space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <FooterHow />
            <Link to="/changelog" className="hover:text-ink">{tt("Changelog")}</Link>
            <Link to="/guides/double-chance" className="hover:text-ink">{tt("What is double chance?")}</Link>
            <Link to="/terms" className="hover:text-ink">{tt("Terms")}</Link>
            <Link to="/privacy" className="hover:text-ink">{tt("Privacy")}</Link>
            <Link to="/accessibility" className="hover:text-ink">{tt("Accessibility")}</Link>
            <Link to="/premium" className="hover:text-ink">{tt("Premium")}</Link>
            <Link to="/contact" className="hover:text-ink">{tt("Contact us")}</Link>
            <FooterNfl />
            <span className="ml-auto flex items-center gap-3"><FooterSocial /><LangSwitch compact /></span>
          </div>
          <FooterHubs />
          <p>
            {tt("SportLikely · predictions are probabilities, not promises. Information only, not betting advice. 18+. If gambling stops being fun, stop and")}{' '}
            <a href="https://www.begambleaware.org" target="_blank" rel="noreferrer" className="underline hover:text-ink">{tt("get help")}</a>.
          </p>
          <DataLine />
        </footer>
        <BottomTabs />
        <Assistant />
        <FeedbackButton />
        <AccessibilityMenu />
      </div>
    </Router>
  )
}

export default App

/** Tennis section (fix193): the full site for admins before launch, everyone once TENNIS_PUBLIC=1; else "coming soon". */
function TennisRoutes() {
  const cfg = useTennisConfig()
  if (!cfg) return <div className="min-h-[80vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>
  if (!cfg.open) return <SportSoon sport="tennis" />
  return (
    <Routes>
      <Route index element={<TennisHome />} />
      <Route path="matches" element={<TennisMatches />} />
      <Route path="today" element={<TennisMatches today />} />
      <Route path="match/:slug/*" element={<SlugRoute sport="tennis" kind="match"><TennisMatch /></SlugRoute>} />
      <Route path="player/:slug" element={<SlugRoute sport="tennis" kind="player"><TennisPlayer /></SlugRoute>} />
      <Route path="league/:slug/*" element={<SlugRoute sport="tennis" kind="league"><TennisTournament /></SlugRoute>} />
      <Route path="tournament/:key" element={<OldLink sport="tennis" kind="league" />} />
      <Route path="predictions/:key" element={<OldLink sport="tennis" kind="league" />} />
      <Route path="rankings" element={<TennisRankings />} />
      <Route path="favorites" element={<TennisFavorites />} />
      <Route path="accuracy" element={<RecordGate home="/tennis"><TennisAccuracy /></RecordGate>} />
      <Route path="how-it-works" element={<HowItWorks sport="tennis" />} />
      <Route path="past" element={<ModelOnly><TennisPast /></ModelOnly>} />
      <Route path="upset-watch" element={<PremiumGate title="Upset watch" pro text={tt("Upset watch: the coming matches where our model gives the underdog the best chance. Part of Pro, together with unlimited predictions.")}><UpsetWatch sport="tennis" /></PremiumGate>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/** NFL section (fix137): the full site for admins before launch, everyone once NFL_PUBLIC=1; else "coming soon". */
function NflRoutes() {
  const cfg = useNflConfig()
  if (!cfg) return <div className="min-h-[80vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>
  if (!cfg.open) return <SportSoon sport="american-football" />
  return (
    <Routes>
      <Route index element={<NflHome />} />
      <Route path="matches" element={<NflGames />} />
      <Route path="games" element={<MovedPage />} />
      <Route path="predictions/:league" element={<LeagueHub />} />
      <Route path="today" element={<NflGames today />} />
      {/* fix185: one sport — the old college list pages are the same pages filtered to college; the college
          standings stay a page of their own (games / teams / players by id are shared) */}
      <Route path="college" element={<Navigate to="/american-football?league=college" replace />} />
      <Route path="college/games" element={<Navigate to="/american-football/matches?league=college" replace />} />
      <Route path="college/today" element={<Navigate to="/american-football/today?league=college" replace />} />
      <Route path="college/league" element={<OldLink sport="american-football" kind="league" id="2" />} />
      <Route path="league" element={<OldLink sport="american-football" kind="league" id="1" />} />
      <Route path="game/:id" element={<OldLink sport="american-football" kind="match" />} />
      <Route path="match/:slug/*" element={<SlugRoute sport="american-football" kind="match"><NflGame /></SlugRoute>} />
      <Route path="league/:slug/*" element={<SlugRoute sport="american-football" kind="league"><NflLeague /></SlugRoute>} />
      <Route path="team/:slug" element={<SlugRoute sport="american-football" kind="team"><NflTeam /></SlugRoute>} />
      <Route path="player/:slug" element={<SlugRoute sport="american-football" kind="player"><NflPlayer /></SlugRoute>} />
      <Route path="favorites" element={<NflFavorites />} />
      {/* fix144: the same pages as football */}
      <Route path="my-picks" element={<MyPicks initial="nfl" />} />
      <Route path="upset-watch" element={<PremiumGate title="Upset watch" pro text={tt("Upset watch: the coming games where our model gives the underdog the best chance. Part of Pro, together with unlimited predictions.")}><UpsetWatch sport="american-football" /></PremiumGate>} />
      <Route path="accuracy" element={<RecordGate home="/american-football"><NflAccuracy /></RecordGate>} />
      <Route path="how-it-works" element={<HowItWorks sport="american-football" />} />
      <Route path="past" element={<ModelOnly><NflPast /></ModelOnly>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

/** Basketball section: the full site for admins (before launch) and everyone once BASKETBALL_PUBLIC is on. */
function BbRoutes() {
  const cfg = useBbConfig()
  // keep the page's height while the config loads (no footer jumping up into an empty page)
  if (!cfg) return <div className="min-h-[80vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>
  if (!cfg.open) return <SportSoon sport="basketball" />
  return (
    <Routes>
      <Route index element={<BbHome />} />
      <Route path="matches" element={<BbGames />} />
      <Route path="today" element={<Today sport="basketball" />} />
      <Route path="predictions/:league" element={<LeagueHub />} />
      <Route path="games" element={<MovedPage />} />
      <Route path="predictions/today" element={<MovedPage />} />
      <Route path="game/:id" element={<OldLink sport="basketball" kind="match" />} />
      <Route path="match/:slug/*" element={<SlugRoute sport="basketball" kind="match"><BbGame /></SlugRoute>} />
      <Route path="league/:slug/*" element={<SlugRoute sport="basketball" kind="league"><BbLeague /></SlugRoute>} />
      <Route path="team/:slug" element={<SlugRoute sport="basketball" kind="team"><BbTeam /></SlugRoute>} />
      <Route path="player/:slug" element={<SlugRoute sport="basketball" kind="player"><BbPlayer /></SlugRoute>} />
      <Route path="favorites" element={<BbFavorites />} />
      {/* fix144: the same pages as football */}
      <Route path="my-picks" element={<MyPicks initial="bb" />} />
      <Route path="upset-watch" element={<PremiumGate title="Upset watch" pro text={tt("Upset watch: the coming games where our model gives the underdog the best chance. Part of Pro, together with unlimited predictions.")}><UpsetWatch sport="basketball" /></PremiumGate>} />
      <Route path="accuracy" element={<RecordGate home="/basketball"><BbAccuracy /></RecordGate>} />
      <Route path="how-it-works" element={<HowItWorks sport="basketball" />} />
      <Route path="past" element={<ModelOnly><BbPast /></ModelOnly>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

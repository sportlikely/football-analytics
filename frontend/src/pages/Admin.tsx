import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth, type User } from '../lib/auth'
import SeasonForecastAdminCard from '../components/SeasonForecastAdminCard'
import VisitorsCard from '../components/VisitorsCard'
import LeaguesCard from '../components/LeaguesCard'
import EmailsAdminCard from '../components/EmailsAdminCard'
import PushAdminCard from '../components/PushAdminCard'
import NbaModelCheckCard from '../components/NbaModelCheckCard'
import NewsInjuriesCard from '../components/NewsInjuriesCard'
import GameExtrasAdminCard from '../components/GameExtrasAdminCard'
import NamesAdminCard from '../components/NamesAdminCard'
import BbGridCard from '../components/BbGridCard'
import DiffViewCard from '../components/DiffViewCard'
import LeagueFixCard from '../components/LeagueFixCard'
import { ChecksCard, DoneForYouCard, Explained, ForClaudeCard, NeedsYouCard, ResultsToCheck, SpeedCard, TabChecks, Tiles, type Ctx, type TileDef } from '../components/admin/AdminParts'
import CopyForClaude from '../components/admin/CopyForClaude'
import { tabReq, type ForClaudeReq } from '../lib/forClaude'
import { ADMIN_TABS, adminPath, adminTabOf, healthTab, waitingCount, type AdminSummary, type AdminTab, type HealthCheck } from '../lib/adminTabs'
import { PARITY_REPORT } from '../lib/sportParity.report'
import { slAdmin } from '../lib/modelNames'
import { matchHref } from '../lib/links'

type Row = User & { lastLoginAt: string | null }
type Stats = { total: number; premium: number; verified: number; optIn: number }

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '–'
}

/**
 * Admin panel (fix237): seven tabs on their own sub-paths (/admin/needs-you, /admin/users, /admin/models, /admin/data,
 * /admin/site, /admin/messages, /admin/security; /admin opens Needs you). Each tab loads only its own cards; the summary
 * tiles and the stored data-health report are read once for the page. Every card sits in an Explained frame (lib/adminTabs.ts).
 */
export default function Admin() {
  const { access, loading } = useAuth()
  const { tab: tabParam } = useParams()
  const [params] = useSearchParams()
  const [summary, setSummary] = useState<AdminSummary | null>(null)
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  // fix260: a locked console (423) is said in words with a way out — never a page waiting for ever
  const [locked, setLocked] = useState<string | null>(null)
  const loadSummary = useCallback(() => axios.get(`${API_URL}/admin/summary`).then(r => { setSummary(r.data.data); setLocked(null) })
    .catch(e => { if (e?.response?.status === 423) setLocked(e.response.data?.error || 'Sign in to the staff console first.') }), [])
  const loadChecks = useCallback(() => axios.get(`${API_URL}/data-health`).then(r => { setChecks(r.data.data?.checks || []); setCheckedAt(r.data.data?.at || null) }).catch(() => setChecks([])), [])
  const reload = useCallback(() => { loadSummary(); loadChecks() }, [loadSummary, loadChecks])
  useEffect(() => {
    if (access !== 'admin') return
    reload()
    const t = setInterval(reload, 60 * 1000)
    return () => clearInterval(t)
  }, [access, reload])

  if (loading) return null
  if (access !== 'admin') return <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 text-sm text-muted">Admins only.</div>
  // the old ?tab=users address, and an unknown tab → /admin
  if (!tabParam && params.get('tab') === 'users') return <Navigate to={adminPath('users')} replace />
  if (tabParam && !adminTabOf(tabParam)) return <Navigate to="/admin" replace />
  const tab: AdminTab = adminTabOf(tabParam) || 'needs-you'
  if (locked) return (
    <div className="max-w-md mx-auto px-4 py-16 text-center" data-console-locked="">
      <h1 className="font-display text-2xl font-bold text-ink mb-2">Staff console locked</h1>
      <p className="text-sm text-muted mb-4">{locked}</p>
      <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-xl bg-accent text-bg font-semibold text-sm">Sign in to the console</button>
    </div>
  )

  const ctx: Ctx = { summary, checks }
  const red = (checks || []).filter(c => c.level === 'fail')
  const inTab = (t: AdminTab) => (checks || []).filter(c => healthTab(c.id) === t)
  // fix253: Needs you counts only customer messages and payment issues; red checks show in their own tabs
  const badge = (t: AdminTab) => (t === 'needs-you' ? waitingCount(summary) : inTab(t).filter(c => c.level === 'fail').length)
  const checkTiles = (t: AdminTab): TileDef[] => {
    const l = inTab(t)
    return [
      { label: 'Checks with a problem', value: checks ? l.filter(c => c.level === 'fail').length : null, level: l.some(c => c.level === 'fail') ? 'fail' : 'ok' },
      { label: 'Checks to look at', value: checks ? l.filter(c => c.level === 'warn').length : null, level: l.some(c => c.level === 'warn') ? 'warn' : 'ok' },
      { label: 'Checks OK', value: checks ? l.filter(c => c.level === 'ok').length : null }
    ]
  }
  const s = summary
  const waiting = s ? waitingCount(s) : null
  const TILES: Record<AdminTab, TileDef[]> = {
    'needs-you': [
      { label: 'Waiting for you', value: waiting, level: waiting ? 'warn' : 'ok' },
      { label: 'Done for you (24 h)', value: s?.done24h ?? null },
      { label: 'Checks with a problem', value: checks ? red.length : null, level: red.length ? 'fail' : 'ok', hint: 'in their own tabs' },
      { label: 'Visitors today', value: s?.visitorsToday ?? null, to: adminPath('users') }
    ],
    users: [
      { label: 'Visitors today', value: s?.visitorsToday ?? null },
      { label: 'Sign-ups today', value: s?.signupsToday ?? null },
      { label: 'Accounts', value: s?.accounts ?? null },
      { label: 'Premium / Pro', value: s?.paying ?? null }
    ],
    models: checkTiles('models'),
    data: [
      ...checkTiles('data').slice(0, 2),
      { label: 'Results being settled', value: s?.bbResultsToCheck ?? null, hint: 'by the site' }
    ],
    site: [
      { label: 'Site errors today', value: s?.siteErrors24h ?? null, level: s?.siteErrors24h ? 'warn' : 'ok', hint: 'times a page broke' },
      { label: 'Open site errors', value: s?.siteErrorsOpen ?? null, hint: 'on the list for Claude', to: adminPath('needs-you') },
      { label: 'Backup', value: !s ? null : s.backupOk === null ? '–' : s.backupOk ? 'OK' : 'Late', level: s?.backupOk === false ? 'fail' : 'ok', hint: s?.lastBackupAt ? `last ${fmt(s.lastBackupAt)}` : undefined },
      checkTiles('site')[0]
    ],
    messages: [...checkTiles('messages'), { label: 'Messages to answer', value: s?.contactOpen ?? null, level: s?.contactOpen ? 'warn' : 'ok', to: adminPath('users') }],
    security: [
      { label: 'Failed sign-ins (24 h)', value: s?.failedSignIns24h ?? null, level: !s ? undefined : s.failedSignIns24h > 20 ? 'fail' : s.failedSignIns24h > 5 ? 'warn' : 'ok' },
      { label: 'Accounts', value: s?.accounts ?? null },
      { label: 'Checks with a problem', value: checks ? red.length : null, level: red.length ? 'fail' : 'ok', to: '/admin' }
    ]
  }
  const runPlayers = () => axios.get(`${API_URL}/data-audit/run`, { params: { bg: 1, email: 0 } }).then(() => window.alert('Player check started: it takes a few minutes.')).catch(e => window.alert(errorText(e)))

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">Admin</h1>
        {checkedAt && <span className="text-xs text-faint">Checked {new Date(checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · updates every minute</span>}
      </div>
      <nav className="-mx-4 px-4 sm:mx-0 sm:px-0 mb-6 overflow-x-auto" aria-label="Admin sections">
        <div className="flex gap-1 rounded-full border border-line/60 bg-surface p-1 w-max">
          {ADMIN_TABS.map(t => {
            const n = badge(t.key)
            return (
              <Link key={t.key} to={adminPath(t.key)} aria-current={tab === t.key ? 'page' : undefined}
                className={`px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${tab === t.key ? 'bg-accent text-bg' : 'text-muted hover:text-ink'}`}>
                {t.label}{n > 0 && <span className={`ms-1.5 num text-[11px] font-bold px-1.5 rounded-full ${tab === t.key ? 'bg-bg/20' : t.key === 'needs-you' ? 'bg-draw/20 text-draw' : 'bg-loss/15 text-loss'}`}>{n}</span>}
              </Link>
            )
          })}
        </div>
      </nav>

      {/* fix259: the whole tab for Claude */}
      <div className="flex justify-end -mt-1 mb-3">
        <CopyForClaude label="Copy everything red/yellow on this page for Claude" req={() => tabReq(tab, summary, checks)} />
      </div>
      <Tiles tiles={TILES[tab]} />

      {tab === 'needs-you' && (
        <>
          <Explained ctx={ctx} id="needs-you"><NeedsYouCard ctx={ctx} reload={reload} /></Explained>
          <Explained ctx={ctx} id="for-claude"><ForClaudeCard ctx={ctx} /></Explained>
          <Explained ctx={ctx} id="done-for-you"><DoneForYouCard reload={reload} /></Explained>
        </>
      )}

      {tab === 'users' && (
        <>
          <Explained ctx={ctx} id="visitors"><VisitorsCard /></Explained>
          <UsersSection ctx={ctx} />
          <Explained ctx={ctx} id="leave"><LeaveCard /></Explained>
          <Explained ctx={ctx} id="contact"><ContactCard /></Explained>
        </>
      )}

      {tab === 'models' && (
        <>
          <Explained ctx={ctx} id="model-daily"><ModelDailyCard /></Explained>
          <Explained ctx={ctx} id="bb-engine"><BbGridCard /></Explained>
          <Explained ctx={ctx} id="nba-check"><NbaModelCheckCard /></Explained>
          <Explained ctx={ctx} id="league-fix"><LeagueFixCard /></Explained>
          <Explained ctx={ctx} id="diff-view"><DiffViewCard /></Explained>
          <Explained ctx={ctx} id="season-forecast"><SeasonForecastAdminCard /></Explained>
          <Explained ctx={ctx} id="calibration"><ChecksCard id="calibration" ctx={ctx} title="Do our percentages come true? (football, basketball)" /></Explained>
          <Explained ctx={ctx} id="backtest"><ChecksCard id="backtest" ctx={ctx} title="Leagues vs past seasons (basketball)" /></Explained>
          <Explained ctx={ctx} id="other-models">
            <ChecksCard id="other-models" ctx={ctx} title="American football and tennis models">
              <p className="mt-3 text-xs text-muted">Past seasons and model tests: <Link to="/american-football/past" className="text-accent font-semibold">American football</Link> · <Link to="/tennis/past" className="text-accent font-semibold">Tennis</Link></p>
            </ChecksCard>
          </Explained>
          <TabChecks tab="models" ctx={ctx} reload={reload} />
        </>
      )}

      {tab === 'data' && (
        <>
          <Explained ctx={ctx} id="af-usage"><AfUsageCard /></Explained>
          <Explained ctx={ctx} id="nfl-data"><NflCard /></Explained>
          <Explained ctx={ctx} id="leagues-football"><LeaguesCard /></Explained>
          <Explained ctx={ctx} id="leagues-basketball"><LeaguesCard sport="basketball" /></Explained>
          <Explained ctx={ctx} id="game-extras"><GameExtrasAdminCard /></Explained>
          <Explained ctx={ctx} id="names-local"><NamesAdminCard /></Explained>
          <Explained ctx={ctx} id="news-injuries"><NewsInjuriesCard /></Explained>
          <Explained ctx={ctx} id="bb-results"><BbResultsCard /></Explained>
          <TabChecks tab="data" ctx={ctx} reload={reload} extra={<button type="button" onClick={runPlayers} className="font-bold text-muted hover:text-ink">Run player check</button>} />
        </>
      )}

      {tab === 'site' && (
        <>
          <Explained ctx={ctx} id="speed"><SpeedCard /></Explained>
          <Explained ctx={ctx} id="deploy-errors"><ChecksCard id="deploy-errors" ctx={ctx} title="Errors during the last deploy" /></Explained>
          <Explained ctx={ctx} id="site-errors"><SiteErrorsCard /></Explained>
          <Explained ctx={ctx} id="link-check"><LinkCheckCard /></Explained>
          <Explained ctx={ctx} id="backups"><BackupsCard /></Explained>
          <Explained ctx={ctx} id="parity"><SportParityCard /></Explained>
          <TabChecks tab="site" ctx={ctx} reload={reload} />
        </>
      )}

      {tab === 'messages' && (
        <>
          <Explained ctx={ctx} id="emails"><EmailsAdminCard /></Explained>
          <Explained ctx={ctx} id="push"><PushAdminCard /></Explained>
          <TabChecks tab="messages" ctx={ctx} reload={reload} />
        </>
      )}

      {tab === 'security' && (
        <>
          <Explained ctx={ctx} id="security"><SecurityCard /></Explained>
          <Explained ctx={ctx} id="staff">
            <section className="card p-5 sm:p-6">
              <h2 className="font-display text-lg font-bold text-ink mb-1">Staff and roles</h2>
              <p className="text-sm text-muted">Roles, permissions and the team list are kept in the CRM. <Link to="/crm?tab=team" className="text-accent font-semibold">Open CRM → Team & roles</Link></p>
            </section>
          </Explained>
        </>
      )}
    </div>
  )
}

/** Visitors & users: the Accounts tiles and the users list (plan changes, password reset, CSV) */
function UsersSection({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<Row[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const load = () =>
    axios
      .get(`${API_URL}/admin/users`)
      .then(r => {
        setRows(r.data.data)
        setStats(r.data.stats)
        setError(null)
      })
      .catch(e => setError(errorText(e)))
  useEffect(() => { load() }, [])

  const setPlan = async (u: Row, plan: 'free' | 'premium' | 'pro') => {
    let until: string | null = null
    if (plan !== 'free') {
      const days = window.prompt(`${plan === 'pro' ? 'Pro' : 'Premium'} for ${u.email}: number of days (empty = no end date)`, '30')
      if (days === null) return
      const n = parseInt(days, 10)
      if (n > 0) until = new Date(Date.now() + n * 86400000).toISOString()
    }
    try {
      await axios.post(`${API_URL}/admin/users/${u.id}/plan`, { plan, until })
      load()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const resetPw = async (u: Row) => {
    const pw = window.prompt(`New temporary password for ${u.email} (min 8 characters)`)
    if (!pw) return
    try {
      await axios.post(`${API_URL}/admin/users/${u.id}/password`, { password: pw })
      setError(null)
      window.alert('Password changed. Send it to the user privately and ask them to change it in Account.')
    } catch (e) {
      setError(errorText(e))
    }
  }

  const shown = rows.filter(r => !q || r.email.includes(q.toLowerCase()) || (r.name || '').toLowerCase().includes(q.toLowerCase()))
  const tile = (label: string, value: number | undefined) => (
    <div className="rounded-xl border border-line/60 bg-surface2/50 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="num text-2xl font-extrabold text-ink leading-none mt-1.5">{value ?? '–'}</div>
    </div>
  )

  return (
    <>
      <Explained id="accounts" ctx={ctx}>
        <section className="card p-5 sm:p-6">
          <h2 className="font-display text-lg font-bold text-ink mb-4">Accounts</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {tile('Accounts', stats?.total)}
            {tile('Confirmed email', stats?.verified)}
            {tile('Premium / Pro', stats?.premium)}
            {tile('Want updates', stats?.optIn)}
          </div>
        </section>
      </Explained>
      <Explained id="users" ctx={ctx}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Users</h2>
        <div className="flex items-center gap-2">
        <a href={`${API_URL}/admin/users.csv`} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-faint whitespace-nowrap">
          Export CSV
        </a>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search email or name"
          className="rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent w-64 max-w-full"
        />
        </div>
      </div>
      {error && <div className="mb-4 rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-faint text-xs border-b border-line">
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Updates</th>
              <th className="px-4 py-3 font-medium">Joined</th>
              <th className="px-4 py-3 font-medium">Last sign-in</th>
              <th className="px-4 py-3 font-medium text-end">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(u => (
              <tr key={u.id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3">
                  <div className="text-ink">{u.email}</div>
                  {u.name && <div className="text-xs text-faint">{u.name}</div>}
                </td>
                <td className="px-4 py-3">
                  {u.isAdmin ? (
                    <span className="text-xs font-semibold text-accent">Admin</span>
                  ) : u.plan !== 'free' ? (
                    <span className="text-xs font-semibold text-accent">
                      {u.plan === 'pro' ? 'Pro' : 'Premium'}{u.premiumUntil ? <span className="text-faint font-normal"> · until {fmt(u.premiumUntil)}</span> : null}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Free</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">{u.emailVerified ? <span className="text-win">Confirmed</span> : <span className="text-draw">Pending</span>}</td>
                <td className="px-4 py-3 text-xs">{u.marketingOptIn ? <span className="text-win">Yes</span> : <span className="text-faint">No</span>}</td>
                <td className="px-4 py-3 num text-muted">{fmt(u.createdAt)}</td>
                <td className="px-4 py-3 num text-muted">{fmt(u.lastLoginAt)}</td>
                <td className="px-4 py-3 text-end whitespace-nowrap">
                  {!u.isAdmin &&
                    <>
                      {u.plan !== 'premium' && (
                        <button onClick={() => setPlan(u, 'premium')} className="text-xs font-semibold text-accent me-3">
                          Premium
                        </button>
                      )}
                      {u.plan !== 'pro' && (
                        <button onClick={() => setPlan(u, 'pro')} className="text-xs font-semibold text-accent me-3">
                          Pro
                        </button>
                      )}
                      {u.plan !== 'free' && (
                        <button onClick={() => setPlan(u, 'free')} className="text-xs text-muted hover:text-loss me-3">
                          Free
                        </button>
                      )}
                    </>}
                  {u.role && <Link to="/crm?tab=team" className="text-xs text-draw font-semibold me-3" title="Staff role — change it in CRM → Team & roles">{u.role.replace(/_/g, ' ')}</Link>}
                  <button onClick={() => resetPw(u)} className="text-xs text-muted hover:text-ink">
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-faint">
                  No accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </Explained>
    </>
  )
}

const REASON_LABEL: Record<string, string> = {
  too_expensive: 'Too expensive', not_accurate: 'Predictions not accurate enough', not_using: 'Not using it enough',
  missing_feature: 'Missing feature / sport', other_service: 'Found another service', technical: 'Technical problems', other: 'Something else'
}
interface Leave {
  total: number; cancels: number; deletes: number; cancelledStillActive: number
  counts: Record<string, { cancel: number; delete: number }>
  recent: { kind: 'cancel' | 'delete'; plan: string | null; reason: string; details: string | null; memberDays: number | null; at: string }[]
}

/** Why people cancel or delete (last 12 months). */
// fix199: a scraper line of a data-centre / proxy network is one row per network and day, its addresses inside
interface SecAddr { ip: string; ua: string | null; requests: number; refused: number; firstAt: string; lastAt: string }
interface SecRow { id: number; at: string; userId: number | null; email: string | null; event: string; ip: string | null; ua: string | null; detail: string | null; grp?: string; addresses?: SecAddr[] }
const EVENT_LABEL: Record<string, string> = {
  login_ok: 'Signed in', login_ok_recovery_code: 'Signed in with a recovery code', login_password_ok: 'Password OK, waiting for code',
  login_fail: 'Wrong email or password', '2fa_fail': 'Wrong two-step code', '2fa_on': 'Two-step login turned on', '2fa_off': 'Two-step login turned off',
  '2fa_recovery_new': 'New recovery codes', password_reset: 'Password reset by email', password_change: 'Password changed',
  admin_set_password: 'Admin set a user password', role_changed: 'Staff role changed', role_created: 'Role created', role_updated: 'Role permissions changed', role_deleted: 'Role deleted', staff_plan_change: 'Staff changed a plan', staff_sent_reset: 'Staff sent a password reset', staff_signed_out_user: 'Staff signed a customer out', campaign_sent: 'Email campaign sent', '2fa_device_added': 'Two-step: another device added',
  email_change_started: 'Email change started', email_changed: 'Email changed', scraper: 'Scraper'
}
const BAD = new Set(['role_changed', 'role_updated', 'role_created', 'role_deleted', 'login_fail', '2fa_fail', '2fa_off', 'login_ok_recovery_code', 'admin_set_password', 'email_changed', '2fa_device_added'])
function browserOf(ua: string | null) {
  if (!ua) return ''
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return [b, os].filter(Boolean).join(' · ')
}

/** Sign-ins and account security events with IP (kept 90 days). */
interface BackupRow { at: string; ok: number; trigger: string; file: string | null; dbBytes: number | null; gzBytes: number | null; ms: number; remote: string | null; error: string | null }
interface BackupData {
  running: boolean; healthy: boolean; lastOkAt: string | null; lastError: string | null; schedule: string; localKeep: number
  remote: { configured: boolean; encrypted: boolean; ready: boolean; keepDays: number; copies?: number; bytes?: number; latest?: { key: string; at: string } | null; listError?: string }
  local: { name: string; size: number; at: string }[]; history: BackupRow[]
  disk?: { dbBytes: number; volume: { free: number; total: number } | null; temp: { free: number; total: number } | null }
}
const mb = (n: number | null | undefined) => (n == null ? '–' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`)
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–')

/** Daily database backups: status, copies on the server and off-site, "Back up now", download (needs a two-step code). */
function BackupsCard() {
  const [d, setD] = useState<BackupData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<string | null>(null) // file waiting for the two-step code
  const [code, setCode] = useState('')
  const load = () => axios.get(`${API_URL}/admin/backups`).then(r => { setD(r.data.data); setErr(null) }).catch(e => setErr(errorText(e)))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!d?.running) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [d?.running])

  const runNow = async () => {
    setBusy(true)
    try { await axios.post(`${API_URL}/admin/backups/run`); await load() } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }
  const download = async (name: string) => {
    setBusy(true); setErr(null)
    try {
      const r = await axios.get(`${API_URL}/admin/backups/download/${encodeURIComponent(name)}`, { responseType: 'blob' })
      const url = URL.createObjectURL(r.data)
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch (e: any) {
      if (e?.response?.status === 401) setAsk(name)
      else setErr('Download failed.')
    } finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true); setErr(null)
    try {
      await axios.post(`${API_URL}/crm/team/sudo`, { code })
      const name = ask!; setAsk(null); setCode('')
      setBusy(false); await download(name)
    } catch (e) { setErr(errorText(e)); setCode('') } finally { setBusy(false) }
  }

  if (!d) return err ? <section className="card p-5 sm:p-6 mb-8 text-sm text-loss">Backups: {err}</section> : null
  const last = d.history[0]
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="font-display text-lg font-bold text-ink">Database backups</h2>
        <button type="button" disabled={busy || d.running} onClick={runNow} className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-faint disabled:opacity-60">
          {d.running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <div className={`rounded-xl border px-4 py-3 ${d.healthy ? 'border-win/40 bg-win/10' : 'border-loss/40 bg-loss/10'}`}>
          <div className={`text-sm font-bold ${d.healthy ? 'text-win' : 'text-loss'}`}>{d.healthy ? 'Backed up' : d.lastOkAt ? 'Backup is late' : 'No backup yet'}</div>
          <div className="text-[11px] text-muted mt-0.5">Last good: {when(d.lastOkAt)} · {d.schedule}</div>
        </div>
        <div className="rounded-xl border border-line px-4 py-3">
          <div className="text-sm font-bold text-ink">On the server</div>
          <div className="text-[11px] text-muted mt-0.5">{d.local.length} of {d.localKeep} copies · database {mb(last?.dbBytes)} → {mb(last?.gzBytes)} zipped</div>
        </div>
        <div className={`rounded-xl border px-4 py-3 ${d.remote.ready && !d.remote.listError ? 'border-line' : 'border-draw/40 bg-draw/10'}`}>
          <div className={`text-sm font-bold ${d.remote.ready && !d.remote.listError ? 'text-ink' : 'text-draw'}`}>Off-site copy</div>
          <div className="text-[11px] text-muted mt-0.5">
            {!d.remote.configured ? 'Not set up yet (Cloudflare R2) — a server copy alone is lost if the volume is lost.'
              : !d.remote.encrypted ? 'Storage is set, but BACKUP_KEY is missing — nothing is uploaded.'
              : d.remote.listError ? `Storage error: ${d.remote.listError}`
              : `${d.remote.copies ?? 0} encrypted copies (${mb(d.remote.bytes)}), kept ${d.remote.keepDays} days`}
          </div>
        </div>
      </div>

      {d.disk && (() => {
        const v = d.disk.volume
        const low = !!v && (v.free < 500e6 || v.free / v.total < 0.1)
        return (
          <div className={`rounded-xl border px-3 py-2 text-xs mb-3 ${low ? 'border-loss/40 bg-loss/10 text-loss' : 'border-line text-muted'}`}>
            <b className={low ? '' : 'text-ink'}>Disk:</b> database {mb(d.disk.dbBytes)} · volume {v ? `${mb(v.free)} free of ${mb(v.total)}` : 'unknown'} · temp disk {d.disk.temp ? `${mb(d.disk.temp.free)} free` : 'unknown'}
            {low && <> — <b>the volume is almost full.</b> The site saves everything there: make the volume bigger in Railway (service → Settings → Volume).</>}
          </div>
        )
      })()}
      {d.lastError && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss mb-3">Last attempt: {d.lastError}</div>}
      {err && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss mb-3">{err}</div>}

      {ask && (
        <form onSubmit={e => { e.preventDefault(); confirm() }} className="rounded-xl border border-accent/40 p-4 mb-4 space-y-2">
          <div className="text-sm font-semibold text-ink">Confirm the download with two-step login</div>
          <p className="text-xs text-muted">The file holds every account (emails, password hashes). Keep it somewhere safe and delete it when you're done.</p>
          <div className="flex flex-wrap gap-2">
            <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus aria-label="6-digit code"
              className="w-[160px] rounded-xl border border-line bg-surface2/60 px-3 py-2 text-center num text-xl tracking-[0.35em] text-ink outline-none focus:border-accent" />
            <button type="submit" disabled={busy || code.length !== 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">Confirm</button>
            <button type="button" onClick={() => { setAsk(null); setCode('') }} className="rounded-xl px-3 py-2 text-sm text-muted">Cancel</button>
          </div>
        </form>
      )}

      {d.local.length > 0 && (
        <ul className="divide-y divide-line/50 text-sm">
          {d.local.map(f => (
            <li key={f.name} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-32 shrink-0 text-[11px] text-faint num">{when(f.at)}</span>
              <span className="text-ink truncate num text-xs">{f.name}</span>
              <span className="text-[11px] text-faint num">{mb(f.size)}</span>
              <button type="button" disabled={busy} onClick={() => download(f.name)} className="ms-auto text-xs font-semibold text-accent disabled:opacity-60">Download</button>
            </li>
          ))}
        </ul>
      )}
      {d.history.some(h => !h.ok) && (
        <p className="mt-3 text-[11px] text-faint">Failed in the last {d.history.length} attempts: {d.history.filter(h => !h.ok).length}. A failure also emails you.</p>
      )}
    </section>
  )
}

/** Basketball results the provider may have wrong (swapped / quarters don't add up), and recent corrections. */
type SiteError = { sig: string; message: string; where: string | null; pageKind: string; kind: string; count: number; firstAt: string; lastAt: string; pages: string[]; browsers: string[]; version: string | null; resolvedAt: string | null }
/** Pages that broke in visitors' browsers (sent by the site itself). "Mark fixed" after a fix is deployed: it reopens if it happens again. */
interface DailyCand {
  id: string; label: string; kind: string; n: { W: number; Wp: number }; W: { logLoss: number; hitRate: number }; Wp: { logLoss: number }
  dW: number; dWp: number; pass: boolean; why: string; gap: string | null; close: number; boot: { pBetter: number } | null
}
interface DailyDay {
  date: string; ranAt: string | null; decision: string | null; reason: string | null; rollback: boolean; ms: number | null; report: string | null; reportSentAt: string | null
  challengers?: { candidates?: DailyCand[]; games?: { W: number; Wp: number }; stale?: number; reference?: { market?: { W?: { n: number; logLoss: number } }; championOnOddsGames?: { n: number; logLoss: number } } } | null
}
interface DailyLog {
  champion: { mixWeight: number; groupW?: { big: number; rest: number } | null; anchor?: number; featModelId?: number | null; featCutoff: string | null; since: string; label: string }
  mixLive: boolean; mixMode: string; running: boolean; days: DailyDay[]
  learning?: {
    lastPromotion: { date: string; reason: string } | null; daysSince: number | null; firstRun: string | null
    best: { label: string; dW: number; dWp: number; pBetter: number | null; pass: boolean; why: string; gap: string | null } | null
  }
  feature: { active: { id: number; trained_at: string; cutoff: string; train_games: number } | null }
}

/** Football model: v3-mix and the daily champion / challenger job (04:00 UTC), with the 07:00 morning report. */
function ModelDailyCard() {
  const [d, setD] = useState<DailyLog | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/admin/model-daily`).then(r => setD(r.data.data)).catch(() => setD(null))
  useEffect(() => { load() }, [])
  if (!d) return null
  const act = (q: string, note: string) => axios.get(`${API_URL}/admin/${q}`).then(r => { setMsg(note); if (r.data.data?.text) setPreview(r.data.data.text); load() }).catch(e => setMsg(errorText(e)))
  const latest = d.days.find(x => x.report) || null
  const ran = d.days.find(x => x.challengers?.candidates?.length) || null
  const cands = (ran?.challengers?.candidates || []).filter(c => c.id !== 'champion').sort((a, b) => a.close - b.close)
  const L = d.learning
  const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`
  const tone = (x: string | null) => (x === 'promote' ? 'text-win' : x === 'rollback' || x === 'error' ? 'text-loss' : 'text-muted')
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Model: daily self-learning</h2>
        <span className="text-xs text-faint">job 04:00 UTC · report 07:00 Israel time{d.running ? ' · running now' : ''}</span>
      </div>
      <p className="text-sm text-muted">
        Published league model: <b className="text-ink">{d.mixLive ? slAdmin('v3-mix') : `${slAdmin('grid-v3')}, v3-mix in shadow`}</b> · switch {d.mixMode} ·
        feature weight {d.champion.groupW ? `${d.champion.groupW.big} big leagues / ${d.champion.groupW.rest} rest` : d.champion.mixWeight}
        {d.champion.anchor ? ` · market anchor ${d.champion.anchor}` : ''} · feature fit {d.feature.active ? `${d.feature.active.cutoff} (#${d.feature.active.id}, ${d.feature.active.train_games} games)` : 'not fitted yet'} ·
        champion since {d.champion.since}
      </p>
      {L && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
          <div className="rounded-xl bg-surface2/60 p-3">
            <div className="text-xs text-faint">Last promotion</div>
            <div className="font-semibold text-ink">{L.lastPromotion ? L.lastPromotion.date : 'none yet'}</div>
            {L.lastPromotion && <div className="text-xs text-muted break-words">{L.lastPromotion.reason}</div>}
          </div>
          <div className="rounded-xl bg-surface2/60 p-3">
            <div className="text-xs text-faint">Days since</div>
            <div className={`font-semibold num ${(L.daysSince ?? 0) >= 30 ? 'text-loss' : 'text-ink'}`}>{L.daysSince ?? '—'}</div>
            {!L.lastPromotion && L.firstRun && <div className="text-xs text-muted">first run {L.firstRun}</div>}
          </div>
          <div className="rounded-xl bg-surface2/60 p-3">
            <div className="text-xs text-faint">Today’s best candidate</div>
            {L.best ? (
              <>
                <div className={`font-semibold break-words ${L.best.pass ? 'text-win' : 'text-ink'}`}>{L.best.label}</div>
                <div className="text-xs text-muted num">last 60 days {sg(L.best.dW)} · previous 60 {sg(L.best.dWp)}{L.best.pBetter != null ? ` · better in ${Math.round(L.best.pBetter * 100)}% of resamples` : ''}</div>
                <div className="text-xs text-muted break-words">{L.best.pass ? 'passed' : `to pass: ${L.best.gap || L.best.why}`}</div>
              </>
            ) : <div className="text-faint">not scored yet</div>}
          </div>
        </div>
      )}
      {cands.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-faint text-start">
              <tr><th className="py-1 pe-2 font-normal">Candidate ({ran!.date}, {ran!.challengers?.games?.W ?? 0} / {ran!.challengers?.games?.Wp ?? 0} games)</th><th className="py-1 pe-2 font-normal text-end">last 60</th><th className="py-1 pe-2 font-normal text-end">prev 60</th><th className="py-1 pe-2 font-normal text-end">sure</th><th className="py-1 font-normal">verdict</th></tr>
            </thead>
            <tbody className="divide-y divide-line/40">
              {cands.slice(0, 12).map(c => (
                <tr key={c.id}>
                  <td className="py-1 pe-2 text-ink">{c.label}</td>
                  <td className={`py-1 pe-2 num text-end ${c.dW < 0 ? 'text-win' : 'text-muted'}`}>{sg(c.dW)}</td>
                  <td className={`py-1 pe-2 num text-end ${c.dWp < 0 ? 'text-win' : 'text-muted'}`}>{sg(c.dWp)}</td>
                  <td className="py-1 pe-2 num text-end text-muted">{c.boot ? `${Math.round(c.boot.pBetter * 100)}%` : '—'}</td>
                  <td className={`py-1 ${c.pass ? 'text-win font-semibold' : 'text-muted'}`}>{c.pass ? 'passes' : c.gap || c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-faint">Log loss against the champion per game (below 0 = better). Promoted when better in both windows, better in 90% of 2,000 resamples and the hit rate not down by more than 0.5 points.</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => act('model-daily?run=1', 'Daily job started (a few minutes).')}>Run today’s job</button>
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => act('model-daily?preview=1', 'Report preview below.')}>Preview report</button>
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => act('model-daily?report=1', 'Report sent.')}>Send report now</button>
        {(['auto', 'on', 'off'] as const).map(m => (
          <button key={m} type="button" onClick={() => act(`v3-mix?mode=${m}`, `v3-mix switch: ${m}.`)}
            className={`px-3 py-1.5 rounded-full border ${d.mixMode === m ? 'border-accent text-accent' : 'border-line text-muted'}`}>v3-mix {m}</button>
        ))}
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => act('v3-mix?backtest=1', 'Backtest done — see the network response or /api/admin/v3-mix?backtest=1.')}>Backtest v3-mix (this season)</button>
      </div>
      {msg && <p className="mt-2 text-xs text-accent">{msg}</p>}
      {(preview || latest?.report) && (
        <pre className="mt-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded-xl bg-surface2/60 p-3 text-ink/90">{preview || latest!.report}</pre>
      )}
      <ul className="mt-3 divide-y divide-line/50 text-sm">
        {d.days.slice(0, 14).map(x => (
          <li key={x.date} className="py-2 flex flex-wrap gap-x-3 gap-y-1">
            <span className="num text-faint w-24">{x.date}</span>
            <span className={`font-semibold ${tone(x.decision)}`}>{x.decision || '—'}{x.rollback ? ' ⚠' : ''}</span>
            <span className="text-xs text-muted flex-1 min-w-0 break-words">{x.reason || (x.ranAt ? '' : 'job not run')}</span>
          </li>
        ))}
        {d.days.length === 0 && <li className="py-2 text-sm text-faint">No runs yet — the first one is at 04:00 UTC.</li>}
      </ul>
    </section>
  )
}

/** fix164: team links that would open "We couldn't find this team" (matches of the last and next 7 days, every sport). */
type LinkCheck = { at: string; ms: number; checked: Record<string, number>; failures: { sport: string; teamId: number; name: string; competition: string; link: string }[] }
function LinkCheckCard() {
  const [d, setD] = useState<LinkCheck | null>(null)
  const [busy, setBusy] = useState(false)
  // fix260: no check stored yet (a fresh start) answers { running: true } (fix234) — read as "running", asked again, never
  // read as a check (its missing failures list crashed Admin → Site health, 28 Oct)
  const [running, setRunning] = useState(false)
  const load = useCallback((run = false) => {
    setBusy(run)
    return axios.get(`${API_URL}/admin/link-check`, { params: run ? { run: 1 } : {} }).then(r => {
      const x = r.data?.data
      const ok = !!x && Array.isArray(x.failures) && !!x.checked
      if (ok) setD(x)
      setRunning(!ok || !!r.data?.job?.running)
    }).catch(() => undefined).finally(() => setBusy(false))
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (!running) return; const t = setInterval(() => load(), 3000); return () => clearInterval(t) }, [running, load])
  if (!d) return running ? <section className="card p-5 sm:p-6 mb-8 text-sm text-faint">Broken team links: the first check is running…</section> : null
  const n = d.failures.length, total = Object.values(d.checked).reduce((a, b) => a + b, 0)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Broken team links: <span className={n ? 'text-loss' : 'text-win'}>{n}</span></h2>
        <span className="text-xs text-faint">{total} teams of the last and next 7 days · checked {new Date(d.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · daily after the 04:00 jobs
          <button type="button" disabled={busy} onClick={() => load(true)} className="ms-3 font-semibold text-accent hover:underline disabled:opacity-50">{busy ? 'Checking…' : 'Check now'}</button>
        </span>
      </div>
      {n === 0 ? <p className="text-sm text-faint">Every team link opens a team page.</p> : (
        <ul className="divide-y divide-line/50 text-sm max-h-80 overflow-y-auto">
          {d.failures.map(f => (
            <li key={`${f.sport}${f.teamId}${f.competition}`} className="py-2 flex flex-wrap gap-x-3 gap-y-1">
              <span className="font-semibold text-ink">{f.name}</span>
              <span className="text-xs text-faint">{f.sport} · {f.competition} · id {f.teamId}</span>
              <a href={f.link} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline break-all">{f.link}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SiteErrorsCard() {
  const [d, setD] = useState<{ rows: SiteError[]; open: number; last24h: number } | null>(null)
  const [showFixed, setShowFixed] = useState(false)
  const load = () => axios.get(`${API_URL}/admin/client-errors`).then(r => setD(r.data.data)).catch(() => setD(null))
  useEffect(() => { load() }, [])
  if (!d) return null
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const mark = (sig: string, resolved: boolean) => axios.post(`${API_URL}/admin/client-errors/${sig}`, { resolved }).then(load).catch(() => undefined)
  const rows = d.rows.filter(r => showFixed || !r.resolvedAt)
  const fixed = d.rows.length - d.open
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Site errors</h2>
        <span className={`text-xs ${d.open ? 'text-loss font-semibold' : 'text-faint'}`}>
          {d.open ? `${d.open} open problem${d.open === 1 ? '' : 's'} · ${d.last24h} time${d.last24h === 1 ? '' : 's'} in the last 24 h` : 'No open problems'} · pages that broke for visitors · kept 30 days
        </span>
      </div>
      {rows.length === 0 ? <p className="text-sm text-faint">Nothing broke. 🎉</p> : (
        <ul className="divide-y divide-line/50 text-sm">
          {rows.map(r => (
            <li key={r.sig} className={`py-3 ${r.resolvedAt ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-ink">{r.pageKind}</span>
                <span className="text-[11px] num text-loss font-bold">{r.count}×</span>
                <span className="text-[11px] text-faint">last {when(r.lastAt)} · first {when(r.firstAt)}{r.browsers.length ? ` · ${r.browsers.join(', ')}` : ''}</span>
                {/* fix259: one site error, with the newest others */}
                {!r.resolvedAt && <CopyForClaude size="sm" className="ms-auto" req={() => ({ place: 'Admin → Site health → Site errors', scope: 'site-error', sig: r.sig })} />}
                <button type="button" onClick={() => mark(r.sig, !r.resolvedAt)} className={`${r.resolvedAt ? 'ms-auto ' : ''}text-xs font-semibold text-accent hover:underline`}>
                  {r.resolvedAt ? 'Reopen' : 'Mark fixed'}
                </button>
              </div>
              <div className="mt-1 text-xs text-muted break-words">{r.message}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {r.pages.slice(0, 6).map(p => <a key={p} href={p} target="_blank" rel="noreferrer" className="text-accent hover:underline">{p}</a>)}
                {r.pages.length > 6 && <span className="text-faint">+{r.pages.length - 6} more</span>}
              </div>
              {r.where && (
                <details className="mt-1 text-[11px] text-faint">
                  <summary className="cursor-pointer">Code location (for Claude)</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all">{r.where}{r.version ? `\nsite version ${r.version}` : ''}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {fixed > 0 && (
        <button type="button" onClick={() => setShowFixed(v => !v)} className="mt-3 text-xs text-muted hover:text-ink underline">
          {showFixed ? 'Hide fixed' : `Show fixed (${fixed})`}
        </button>
      )}
    </section>
  )
}

/** Sport parity (fix175): football is the template — every block fed by every sport, or an approved 'na' (lib/sportParity.ts). */
function SportParityCard() {
  const r = PARITY_REPORT
  const green = r.ok && !r.todo.length
  const [open, setOpen] = useState(false)
  const SPORT: Record<string, string> = { football: 'Football', basketball: 'Basketball', nfl: 'NFL', tennis: 'Tennis' }
  return (
    <section className={`card p-5 sm:p-6 mb-8 border ${green ? 'border-win/40' : 'border-loss/40'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="font-display text-lg font-bold text-ink">Sport parity</h2>
        <span className={`text-xs font-bold ${green ? 'text-win' : 'text-loss'}`}>{green ? `All ${r.keys} blocks fed by every sport` : !r.ok ? `${r.gaps.length + r.propGaps.length + r.problems.length} unexplained gaps` : `${r.todo.length} gaps to build`}</span>
      </div>
      <p className="text-xs text-muted">Football is the template. Built from lib/sportParity.ts by npm run parity (this view is from the last check before the deploy).</p>
      {!r.ok && (
        <ul className="mt-3 space-y-1 text-sm">
          {r.gaps.map(g => <li key={g.key} className="text-ink"><b>{g.key}</b> <span className="text-muted">— {g.label}</span>{g.missing.length > 0 && <span className="text-loss"> · missing in {g.missing.map(s => SPORT[s] || s).join(', ')}</span>}{g.note ? <span className="text-faint"> · {g.note}</span> : null}</li>)}
          {r.propGaps.map(p => <li key={`${p.comp}.${p.prop}`} className="text-ink"><b>{p.comp}.{p.prop}</b> <span className="text-loss">· football only</span></li>)}
          {r.problems.map(p => <li key={p} className="text-loss">{p}</li>)}
        </ul>
      )}
      {r.todo.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {r.todo.map(x => <li key={`${x.key}-${x.sport}`} className="text-ink"><b>{x.key}</b> <span className="text-loss">· missing in {SPORT[x.sport] || x.sport}</span> <span className="text-muted">— {x.reason}</span></li>)}
        </ul>
      )}
      {r.na.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setOpen(o => !o)} className="text-xs font-bold text-accent">{open ? 'Hide' : 'Show'} {r.na.length} blocks marked not applicable</button>
          {open && (
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {r.na.map(n => <li key={`${n.key}-${n.sport}`}><b className="text-ink">{n.key}</b> · {SPORT[n.sport] || n.sport}: {n.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/** API-Football today (fix140): quota used / limit, calls by schedulers vs page views, the page budget, top user-agents. */
function AfUsageCard() {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/admin/af-usage`).then(r => setD(r.data.data)).catch(e => setErr(errorText(e, 'API-Football usage failed')))
  useEffect(() => { load(); const iv = setInterval(load, 60000); return () => clearInterval(iv) }, [])
  const n = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toLocaleString('en-GB'))
  const q = d?.quota
  const pct = q && q.used !== null && q.limitDay ? Math.min(100, (q.used / q.limitDay) * 100) : null
  const total = d ? d.calls.scheduler + d.calls.pages + d.calls.admin : 0
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">API-Football today</h2>
        {d && <span className="text-xs text-faint">{d.day} (UTC){q?.blocked ? ' · daily limit reached' : ''}</span>}
      </div>
      {err && <p className="text-sm text-loss">{err}</p>}
      {!d && !err && <p className="text-sm text-faint">Loading…</p>}
      {d && (
        <div className="space-y-3 text-sm">
          <div>
            <div className="flex items-baseline justify-between gap-2"><span className="text-muted">Used</span><span className="num text-ink font-semibold">{n(q?.used)} / {n(q?.limitDay)}</span></div>
            <div className="mt-1 h-2 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${pct !== null && pct > 85 ? 'bg-loss' : 'bg-accent'}`} style={{ width: `${pct ?? 0}%` }} /></div>
          </div>
          {/* fix166: page views split into visitors / crawlers (API calls, and requests underneath) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            {([
              ['Schedulers', d.calls.scheduler, null],
              ['Page views · visitors', d.pages ? d.pages.visitors.calls : d.calls.pages, d.pages?.visitors.requests ?? null],
              ['Page views · crawlers', d.pages ? d.pages.crawlers.calls : null, d.pages?.crawlers.requests ?? null],
              ['Admin', d.calls.admin, null]
            ] as [string, number | null, number | null][]).map(([l, v, req]) => (
              <div key={l} className="rounded-xl bg-surface2/50 border border-line/60 px-2 py-2">
                <div className="text-[11px] text-faint">{l}</div>
                <div className="num font-extrabold text-ink">{n(v)}</div>
                <div className="text-[10px] text-faint">{total && v !== null ? Math.round((v / total) * 100) : 0}%{req !== null ? ` · ${n(req)} requests` : ''}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">
            Page budget: <b className="text-ink num">{n(d.pageBudget.thisHour)}</b> / {n(d.pageBudget.perHour)} this hour · <b className="text-ink num">{n(d.calls.pages)}</b> / {n(d.pageBudget.perDay)} today
            {d.pageBudget.refused ? <> · <span className="text-loss">{n(d.pageBudget.refused)} page calls refused (stored copy shown)</span></> : null}
            {' '}· split by source from fix140 on
          </p>
          {d.topAgents.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[520px]">
                <thead><tr className="text-faint text-start">{['User-agent', 'Requests', 'API calls', 'Blocked'].map(h => <th key={h} className="font-semibold py-1 pe-2">{h}</th>)}</tr></thead>
                <tbody>
                  {d.topAgents.map((a: any) => (
                    <tr key={a.ua} className="border-t border-line/50">
                      <td className="py-1 pe-2 text-muted max-w-[320px] truncate" title={a.ua}>{a.ua}</td>
                      <td className="py-1 pe-2 num">{n(a.requests)}</td>
                      <td className="py-1 pe-2 num">{n(a.afCalls)}</td>
                      <td className={`py-1 pe-2 num ${a.blocked ? 'text-loss' : ''}`}>{n(a.blocked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** NFL data check (fix136): what API-American-Football gives us on our plan. Admin only; nothing public yet. */
function NflCard() {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = (refresh = false) => {
    setBusy(true); setErr(null)
    axios.get(`${API_URL}/admin/nfl-probe`, { params: refresh ? { refresh: 1 } : {} })
      .then(r => setD(r.data.data)).catch(e => setErr(errorText(e, 'NFL probe failed'))).finally(() => setBusy(false))
  }
  useEffect(() => load(), [])
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '–')
  const cov = (c: any) => (c ? Object.entries(c).filter(([, v]) => v === true || (v && typeof v === 'object' && Object.values(v as any).some(x => x === true || (x && typeof x === 'object')))).map(([k]) => k).join(', ') || 'none' : '–')
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">NFL data</h2>
        <span className="flex items-center gap-3 text-xs text-faint">
          {d && <span>{d.cached ? 'cached · ' : ''}checked {new Date(d.checkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
          <button type="button" disabled={busy} onClick={() => load(true)} className="font-bold text-accent disabled:opacity-50">{busy ? 'Checking…' : 'Check again (~10 calls)'}</button>
        </span>
      </div>
      {err && <p className="text-sm text-loss">{err}</p>}
      {!d && !err && <p className="text-sm text-faint">Loading…</p>}
      {d && (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Plan <b className="text-ink">{d.status?.plan ?? '–'}</b>{d.status?.active === false ? ' (inactive)' : ''} · requests today <b className="text-ink num">{d.status?.requestsToday ?? '–'}</b> / <span className="num">{d.status?.limitDay ?? '–'}</span>
            {' '}· key {d.keyFrom ?? 'missing'} · current season <b className="text-ink">{d.currentSeason ?? '–'}</b>
            {' '}· stored <b className="text-ink num">{d.stored.games}</b> games, <span className="num">{d.stored.finished}</span> with scores
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
              <thead><tr className="text-faint text-start">{['Season', 'Coverage', 'Games', 'Scores', 'Regular', 'Playoffs', 'First', 'Last'].map(h => <th key={h} className="font-semibold py-1 pe-2">{h}</th>)}</tr></thead>
              <tbody>
                {d.seasons.map((s: any) => (
                  <tr key={s.season} className="border-t border-line/50">
                    <td className="py-1 pe-2 font-semibold text-ink">{s.season}{s.current ? ' ·now' : ''}</td>
                    <td className="py-1 pe-2 text-muted">{cov(s.coverage)}</td>
                    <td className="py-1 pe-2 num">{s.stored?.games ?? '–'}</td>
                    <td className="py-1 pe-2 num">{s.stored?.finished ?? '–'}</td>
                    <td className="py-1 pe-2 num">{s.stored?.regular ?? '–'}</td>
                    <td className="py-1 pe-2 num">{s.stored?.playoffs ?? '–'}</td>
                    <td className="py-1 pe-2">{day(s.stored?.first ?? null)}</td>
                    <td className="py-1 pe-2">{day(s.stored?.last ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.samples.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Sample games: team stats {d.samples[0].teamStats ? `${d.samples[0].teamStats.stats.length} fields` : 'none'}, player groups {d.samples[0].playerStats?.groups?.join(', ') || 'none'}</summary>
              {d.samples.map((x: any) => (
                <div key={x.id} className="mt-2">
                  <div className="font-semibold text-ink">{x.game} · {day(x.date)}</div>
                  <div>Team stats: {x.teamStats ? x.teamStats.stats.join(', ') || x.teamStats.fields.join(', ') : 'none'}</div>
                  <div>Player stats: {x.playerStats ? x.playerStats.stats.join(', ') || x.playerStats.fields.join(', ') : 'none'}</div>
                </div>
              ))}
            </details>
          )}
          <p className="text-xs text-muted">
            Injuries: {d.injuries.length ? d.injuries.map((i: any) => `${i.team} ${i.count ?? '–'}`).join(' · ') : '–'}{d.injuries[0]?.fields?.length ? ` (fields: ${d.injuries[0].fields.join(', ')})` : ''}
            {' '}· Standings {d.standings ? `${d.standings.season}: ${d.standings.rows} rows` : '–'}
            {d.lastSync ? ` · last sync ${day(d.lastSync.at)}` : ''}
          </p>
          {Object.keys(d.errors || {}).length > 0 && <p className="text-xs text-loss">{Object.entries(d.errors).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
        </div>
      )}
    </section>
  )
}

function BbResultsCard() {
  const [d, setD] = useState<{ open: any[]; fixes: any[] } | null>(null)
  useEffect(() => { axios.get(`${API_URL}/admin/bb/result-checks`).then(r => setD(r.data.data)).catch(() => setD(null)) }, [])
  if (!d) return null
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Results being settled</h2>
        <span className="text-xs text-faint">Checked every 30 min · two sources agree → fixed · still unsure after 72 h → void (football: 7 days) · the buttons only decide one earlier</span>
      </div>
      <ResultsToCheck done={() => undefined} />
      {d.fixes.length > 0 && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Corrections ({d.fixes.length})</summary>
          <ul className="mt-2 space-y-1">
            {d.fixes.map(f => <li key={f.game_id}>{day(f.kickoff)} · <Link to={matchHref('basketball', f.game_id, { home: f.home_name, away: f.away_name, date: f.kickoff })!} className="underline">{f.home_name} – {f.away_name}</Link>: {f.provider_hs}–{f.provider_as} → <b className="text-ink">{f.hs}–{f.as_}</b> ({f.source}{f.by_user ? `, ${f.by_user}` : ''})</li>)}
          </ul>
        </details>
      )}
    </section>
  )
}

/** fix259: one security-log row for Claude (the person by account id, never the email) */
const secReq = (r: SecRow): ForClaudeReq => ({
  place: 'Admin → Security → Security log', scope: 'item',
  shown: [{
    title: `Security log: ${EVENT_LABEL[r.event] || r.event}`,
    text: [`${fmt(r.at)} (${r.at}) · event ${r.event}${r.userId ? ` · account #${r.userId}` : ''}${r.detail ? ` · ${r.detail}` : ''}${r.ip ? ` · from ${r.ip}` : ''}${r.ua ? ` · ${browserOf(r.ua)}` : ''}`,
      ...(r.addresses || []).slice(0, 20).map(a => `address ${a.ip}: ${a.requests} requests${a.refused ? `, ${a.refused} refused` : ''}, ${a.firstAt} → ${a.lastAt}${a.ua ? `, ${browserOf(a.ua)}` : ''}`)].join('\n')
  }]
})

function SecurityCard() {
  const [d, setD] = useState<{ failed24h: number; rows: SecRow[] } | null>(null)
  const [all, setAll] = useState(false)
  useEffect(() => { axios.get(`${API_URL}/admin/security-log`).then(r => setD(r.data.data)).catch(() => setD(null)) }, [])
  if (!d) return null
  const rows = all ? d.rows : d.rows.slice(0, 12)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-lg font-bold text-ink">Security log</h2>
        <span className={`text-xs ${d.failed24h > 5 ? 'text-loss font-semibold' : 'text-faint'}`}>{d.failed24h} failed sign-ins in the last 24 h · IPs kept 90 days</span>
      </div>
      {d.rows.length === 0 ? <p className="text-sm text-faint">Nothing logged yet.</p> : (
        <>
          <ul className="divide-y divide-line/50 text-sm">
            {rows.map(r => r.grp ? (
              <li key={r.id} className="py-2">
                <details>
                  <summary className="cursor-pointer flex flex-wrap items-baseline gap-x-3 gap-y-0.5 list-none">
                    <span className="w-32 shrink-0 text-[11px] text-faint num">{fmt(r.at)}</span>
                    <span className="font-semibold text-loss">▸ {EVENT_LABEL[r.event] || r.event}</span>
                    <span className="text-muted min-w-0 break-words">{r.detail}</span>
                    <span className="ms-auto" onClick={e => e.preventDefault()}><CopyForClaude size="sm" req={() => secReq(r)} /></span>
                  </summary>
                  <ul className="mt-2 ms-2 sm:ms-36 space-y-0.5 text-[11px] text-faint num">
                    {(r.addresses || []).length === 0 && <li>No address written yet (written every 30 s per address).</li>}
                    {(r.addresses || []).map(a => (
                      <li key={a.ip} className="flex flex-wrap gap-x-3">
                        <span className="text-ink">{a.ip}</span>
                        <span>{a.requests.toLocaleString('en-US')} requests{a.refused ? ` · ${a.refused} refused` : ''}</span>
                        <span>{fmt(a.firstAt)} → {fmt(a.lastAt)}</span>
                        {a.ua && <span className="truncate max-w-full" title={a.ua}>{browserOf(a.ua)}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ) : (
              <li key={r.id} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="w-32 shrink-0 text-[11px] text-faint num">{fmt(r.at)}</span>
                <span className={`font-semibold ${BAD.has(r.event) ? 'text-loss' : 'text-ink'}`}>{EVENT_LABEL[r.event] || r.event}</span>
                <span className="text-muted truncate">{r.email || (r.event === 'scraper' && r.detail) || '—'}</span>
                <span className="ms-auto text-[11px] text-faint num">{r.ip || ''}{r.ua ? ` · ${browserOf(r.ua)}` : ''}</span>
                {BAD.has(r.event) && <CopyForClaude size="sm" req={() => secReq(r)} />}
              </li>
            ))}
          </ul>
          {d.rows.length > 12 && (
            <button type="button" onClick={() => setAll(v => !v)} className="mt-3 text-xs font-semibold text-accent">{all ? 'Show less' : `Show all ${d.rows.length}`}</button>
          )}
        </>
      )}
    </section>
  )
}

interface ContactMsg { id: number; at: string; userId: number | null; name: string | null; email: string; topic: string; message: string; page: string | null; sent: boolean; handled: boolean }
const TOPIC_LABEL: Record<string, string> = {
  question: 'Question', account: 'Account / sign-in', billing: 'Billing / plan', privacy: 'Privacy / my data',
  bug: 'Something is broken', idea: 'Idea / feedback', business: 'Business / partnership', other: 'Other'
}

/** Messages from the contact form (they also arrive in support@ by email; reply from there). */
function ContactCard() {
  const [d, setD] = useState<{ open: number; rows: ContactMsg[] } | null>(null)
  const [all, setAll] = useState(false)
  const load = () => axios.get(`${API_URL}/admin/contact`).then(r => setD(r.data.data)).catch(() => setD(null))
  useEffect(() => { load() }, [])
  if (!d) return null
  const mark = async (id: number, handled: boolean) => {
    setD(prev => prev && { open: prev.open + (handled ? -1 : 1), rows: prev.rows.map(r => (r.id === id ? { ...r, handled } : r)) })
    await axios.post(`${API_URL}/admin/contact/${id}`, { handled }).catch(load)
  }
  const rows = d.rows.filter(r => all || !r.handled)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-lg font-bold text-ink">Contact messages <Link to="/crm" className="ms-2 text-xs font-semibold text-accent">Open CRM inbox →</Link></h2>
        <span className="text-xs text-faint">
          {d.open} open · {d.rows.length} total ·{' '}
          <button type="button" onClick={() => setAll(v => !v)} className="text-accent font-semibold">{all ? 'Open only' : 'Show all'}</button>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-faint">{d.rows.length ? 'Nothing open. All answered.' : 'No messages yet.'}</p>
      ) : (
        <ul className="divide-y divide-line/50 text-sm">
          {rows.slice(0, 30).map(r => (
            <li key={r.id} className={`py-3 ${r.handled ? 'opacity-55' : ''}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
                <span className="px-1.5 py-0.5 rounded bg-surface2 text-ink font-semibold">{TOPIC_LABEL[r.topic] || r.topic}</span>
                <span>#{r.id} · {fmt(r.at)}</span>
                <span className="text-ink">{r.name || '—'}</span>
                <a href={`mailto:${r.email}?subject=${encodeURIComponent(`Re: your message to SportLikely (#${r.id})`)}`} className="text-accent">{r.email}</a>
                {r.userId && <span>account #{r.userId}</span>}
                {!r.sent && <span className="text-loss font-semibold">email not delivered — reply from here</span>}
                <button type="button" onClick={() => mark(r.id, !r.handled)} className="ms-auto text-xs font-semibold text-accent">{r.handled ? 'Reopen' : 'Mark answered'}</button>
              </div>
              <p className="text-ink mt-1 whitespace-pre-wrap break-words">{r.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function LeaveCard() {
  const [d, setD] = useState<Leave | null>(null)
  useEffect(() => { axios.get(`${API_URL}/admin/leave-feedback`).then(r => setD(r.data.data)).catch(() => setD(null)) }, [])
  if (!d) return null
  const rows = Object.entries(d.counts).sort((a, b) => b[1].cancel + b[1].delete - (a[1].cancel + a[1].delete))
  const max = Math.max(1, ...rows.map(([, c]) => c.cancel + c.delete))
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-lg font-bold text-ink">Why people leave</h2>
        <span className="text-xs text-faint">last 12 months · {d.cancels} cancelled · {d.deletes} deleted · {d.cancelledStillActive} cancelled but still active</span>
      </div>
      {d.total === 0 ? <p className="text-sm text-faint">Nobody has cancelled or deleted an account yet.</p> : (
        <>
          <ul className="space-y-2 mb-5">
            {rows.map(([k, c]) => (
              <li key={k} className="text-sm">
                <div className="flex justify-between gap-3"><span className="text-ink">{REASON_LABEL[k] || k}</span><span className="num text-muted">{c.cancel} cancel · {c.delete} delete</span></div>
                <div className="mt-1 h-2 rounded-full bg-surface2 overflow-hidden flex">
                  <div className="h-full bg-draw" style={{ width: `${(c.cancel / max) * 100}%` }} />
                  <div className="h-full bg-loss" style={{ width: `${(c.delete / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <div className="label pb-2">Latest comments</div>
          <ul className="divide-y divide-line/50 text-sm">
            {d.recent.filter(r => r.details).slice(0, 15).map((r, i) => (
              <li key={i} className="py-2">
                <div className="text-[11px] text-faint">{fmt(r.at)} · {r.kind === 'cancel' ? 'cancelled' : 'deleted'} · {r.plan || 'free'} · {REASON_LABEL[r.reason] || r.reason}{r.memberDays !== null ? ` · member ${r.memberDays} days` : ''}</div>
                <div className="text-ink mt-0.5">{r.details}</div>
              </li>
            ))}
            {!d.recent.some(r => r.details) && <li className="py-2 text-faint">No written comments yet.</li>}
          </ul>
        </>
      )}
    </section>
  )
}

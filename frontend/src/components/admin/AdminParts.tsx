import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { errorText } from '../../lib/auth'
import { matchHref, playerHref } from '../../lib/links'
import {
  adminPath, byLevel, cardChecks, cardDef, cardLevel, healthRule, healthTab, worst,
  type AdminSummary, type AdminTab, type HealthCheck, type Level
} from '../../lib/adminTabs'

/**
 * fix237: the parts of the tabbed admin page — the status dot, the "What this is / What to do" frame around every card,
 * the data-health checks of one tab (red → yellow → green, green folded), the Needs you list, Speed, summary tiles.
 * Admin pages are English only.
 */

export const DOT: Record<Level, string> = { ok: 'bg-win', warn: 'bg-draw', fail: 'bg-loss' }
const WORD: Record<Level, string> = { ok: 'OK', warn: 'Look', fail: 'Problem' }
export const Dot = ({ level, className = '' }: { level: Level; className?: string }) => (
  <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${DOT[level]} ${className}`} aria-label={WORD[level]} />
)

export interface Ctx { summary: AdminSummary | null; checks: HealthCheck[] | null }

/** every card sits in this frame: dot + title, "What this is", and "What to do" when it is not green */
export function Explained({ id, ctx, children }: { id: string; ctx: Ctx; children: ReactNode }) {
  const c = cardDef(id)
  const level = cardLevel(c, ctx.summary, ctx.checks)
  return (
    <div className="mb-8" data-admin-card={id}>
      <div className="flex items-start gap-2 mb-2 px-1">
        <Dot level={level} className="mt-1" />
        <p className="text-xs text-muted min-w-0">
          <b className="text-ink">{c.title}</b> — {c.what}
          {level !== 'ok' && <span className={`block mt-0.5 ${level === 'fail' ? 'text-loss' : 'text-draw'}`}><b>What to do:</b> {c.todo}</span>}
        </p>
      </div>
      <div className="[&>section]:mb-0">{children}</div>
    </div>
  )
}

/** one data-health check with its plain title and explanation */
function CheckRow({ c }: { c: HealthCheck }) {
  const [open, setOpen] = useState(false)
  const r = healthRule(c.id)
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3">
        <Dot level={c.level} className="mt-1.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink">{r?.title || c.label}</div>
          {r && <div className="text-xs text-muted">{r.what}</div>}
          <div className="text-[11px] text-faint break-words mt-0.5">{c.detail}</div>
          {c.level !== 'ok' && <div className={`text-xs mt-0.5 ${c.level === 'fail' ? 'text-loss' : 'text-draw'}`}><b>What to do:</b> {r?.todo || 'Tell Claude.'}</div>}
          {open && !!c.items?.length && (
            <ul className="mt-2 space-y-1 text-xs text-muted list-disc pl-4 break-words">{c.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
          )}
        </div>
        {!!c.items?.length && (
          <button type="button" onClick={() => setOpen(o => !o)} className="text-[11px] text-accent font-bold whitespace-nowrap">
            {open ? 'Hide' : `${c.items.length} item${c.items.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </li>
  )
}

/** a list of checks, red → yellow → green; the green ones folded into "N checks OK" */
export function CheckList({ checks }: { checks: HealthCheck[] }) {
  const [showOk, setShowOk] = useState(false)
  const sorted = byLevel(checks)
  const bad = sorted.filter(c => c.level !== 'ok'), ok = sorted.filter(c => c.level === 'ok')
  return (
    <>
      {bad.length > 0 && <ul className="divide-y divide-line/50">{bad.map(c => <CheckRow key={c.id} c={c} />)}</ul>}
      {ok.length > 0 && (
        <div className={bad.length ? 'mt-2 pt-2 border-t border-line/50' : ''}>
          <button type="button" onClick={() => setShowOk(v => !v)} className="flex items-center gap-2 text-sm text-muted hover:text-ink">
            <Dot level="ok" /> {ok.length} check{ok.length === 1 ? '' : 's'} OK <span className="text-[11px] text-accent font-bold">{showOk ? 'Hide' : 'Show'}</span>
          </button>
          {showOk && <ul className="divide-y divide-line/50 mt-1">{ok.map(c => <CheckRow key={c.id} c={c} />)}</ul>}
        </div>
      )}
      {!checks.length && <p className="text-sm text-faint">No checks yet.</p>}
    </>
  )
}

/** the data-health checks that belong to a tab */
export function TabChecks({ tab, ctx, reload, extra }: { tab: AdminTab; ctx: Ctx; reload: () => void; extra?: ReactNode }) {
  const list = (ctx.checks || []).filter(c => healthTab(c.id) === tab)
  if (ctx.checks && !list.length) return null
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-display text-lg font-bold text-ink flex items-center gap-2"><Dot level={worst(list.map(c => c.level))} /> Automatic checks</h2>
        <span className="flex items-center gap-3 text-xs">{extra}<button type="button" onClick={reload} className="font-bold text-accent">Check now</button></span>
      </div>
      <p className="text-xs text-muted mb-3">The site checks itself every 5 minutes; these are the checks for this tab. A problem that lasts 30 minutes also emails you.</p>
      {ctx.checks ? <CheckList checks={list} /> : <p className="text-sm text-faint">Checking…</p>}
    </section>
  )
}

/** a card made only of a card's checks (calibration, leagues vs past seasons, deploy errors …) */
export function ChecksCard({ id, ctx, title, children }: { id: string; ctx: Ctx; title: string; children?: ReactNode }) {
  const list = cardChecks(cardDef(id), ctx.checks)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <h2 className="font-display text-lg font-bold text-ink mb-3">{title}</h2>
      {ctx.checks ? <CheckList checks={list} /> : <p className="text-sm text-faint">Checking…</p>}
      {children}
    </section>
  )
}

/** 3–4 numbers at the top of a tab */
export interface TileDef { label: string; value: string | number | null; level?: Level; hint?: string; to?: string }
export function Tiles({ tiles }: { tiles: TileDef[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      {tiles.map(t => {
        const body = (
          <>
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">{t.level && <Dot level={t.level} className="!w-2 !h-2" />}{t.label}</div>
            <div className="num text-2xl font-extrabold text-ink leading-none mt-1.5">{t.value ?? '–'}</div>
            {t.hint && <div className="text-[11px] text-faint mt-1">{t.hint}</div>}
          </>
        )
        const cls = 'block text-left rounded-xl border border-line/60 bg-surface2/50 px-4 py-3'
        return t.to ? <Link key={t.label} to={t.to} className={`${cls} hover:border-accent/40 transition-colors`}>{body}</Link> : <div key={t.label} className={cls}>{body}</div>
      })}
    </div>
  )
}

/* ---------------- Needs you ---------------- */

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

function Group({ title, n, to, children }: { title: string; n: number; to?: AdminTab; children: ReactNode }) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h3 className="font-semibold text-ink flex items-center gap-2"><span className="num rounded-full bg-draw/15 text-draw text-xs font-bold px-2 py-0.5">{n}</span>{title}</h3>
        {to && <Link to={adminPath(to)} className="text-xs font-semibold text-accent">See all →</Link>}
      </div>
      {children}
    </div>
  )
}

function PhotosToReview({ done }: { done: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => axios.get(`${API_URL}/admin/player-photos`).then(r => setRows(r.data.data.review)).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  const act = (r: any, action: 'approve' | 'reject') => { setBusy(true); axios.post(`${API_URL}/admin/player-photos/${r.sport}/${r.id}/${action}`, { reason: '' }).then(() => { load(); done() }).finally(() => setBusy(false)) }
  if (!rows) return <p className="text-sm text-faint">Loading…</p>
  return (
    <ul className="divide-y divide-line/50 text-sm">
      {rows.slice(0, 10).map(r => (
        <li key={`${r.sport}${r.id}`} className="py-2 flex items-center gap-3">
          {r.url ? <img src={r.url} alt={r.name} width={48} height={48} className="w-12 h-12 rounded-xl object-cover bg-surface2 shrink-0" /> : <span className="w-12 h-12 rounded-xl bg-surface2 shrink-0" />}
          <div className="min-w-0 flex-1">
            <a href={playerHref(r.sport === 'tennis' ? 'tennis' : 'basketball', r.id, r.name)!} target="_blank" rel="noreferrer" className="font-semibold text-ink hover:text-accent">{r.name}</a>
            <div className="text-xs text-muted">{r.sport} · {r.reason}</div>
          </div>
          <div className="flex flex-col sm:flex-row gap-1 shrink-0">
            <button type="button" disabled={busy} onClick={() => act(r, 'approve')} className="h-8 px-3 rounded-lg text-xs font-semibold bg-win/15 text-win hover:bg-win/25">Approve</button>
            <button type="button" disabled={busy} onClick={() => act(r, 'reject')} className="h-8 px-3 rounded-lg text-xs font-semibold bg-loss/15 text-loss hover:bg-loss/25">Wrong person</button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function InjuriesToReview({ done }: { done: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => axios.get(`${API_URL}/admin/bb/news-injuries`).then(r => setRows((r.data.data as any[]).filter(x => x.state === 'active' && !x.reviewed))).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  const act = (id: number, action: 'ok' | 'dismiss') => { setBusy(true); axios.post(`${API_URL}/admin/bb/news-injuries/${id}/${action}`, {}).then(() => { load(); done() }).finally(() => setBusy(false)) }
  if (!rows) return <p className="text-sm text-faint">Loading…</p>
  return (
    <ul className="divide-y divide-line/50 text-sm">
      {rows.slice(0, 10).map(x => (
        <li key={x.id} className="py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={playerHref('basketball', x.playerId, x.name)!} className="font-semibold text-ink hover:underline">{x.name}</Link>
            <span className="text-xs text-faint">{x.team || x.teamId} · {x.code} · {x.status} until {String(x.until).slice(0, 10)}</span>
            <span className="ml-auto flex gap-1">
              <button type="button" disabled={busy} onClick={() => act(x.id, 'ok')} className="h-8 px-3 rounded-lg text-xs font-semibold bg-win/15 text-win hover:bg-win/25">OK</button>
              <button type="button" disabled={busy} onClick={() => act(x.id, 'dismiss')} className="h-8 px-3 rounded-lg text-xs font-semibold bg-loss/15 text-loss hover:bg-loss/25">Dismiss</button>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">“{x.sentence}” — <a href={x.link} target="_blank" rel="noopener noreferrer nofollow" className="underline">{x.source || 'story'}</a></p>
        </li>
      ))}
    </ul>
  )
}

/** fix239: each result with its buttons — Swap scores / Keep as is (basketball, American football; tennis: give the win to the other player) */
function ResultsToCheck({ done }: { done: () => void }) {
  const [d, setD] = useState<{ open: any[]; other: any[] } | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const load = () => axios.get(`${API_URL}/admin/bb/result-checks`).then(r => setD({ open: r.data.data.open || [], other: r.data.data.other || [] })).catch(() => setD({ open: [], other: [] }))
  useEffect(() => { load() }, [])
  const act = (key: string, url: string, action: string) => {
    setBusy(key); setErr('')
    axios.post(url, { action }).then(() => { load(); done() }).catch(e => setErr(errorText(e))).finally(() => setBusy(''))
  }
  if (!d) return <p className="text-sm text-faint">Loading…</p>
  const btn = 'h-8 px-3 rounded-lg text-xs font-semibold disabled:opacity-50'
  const rows = [
    ...d.open.map(x => ({
      key: `bb${x.game_id}`, when: x.kickoff, label: `${x.home_name} ${x.hs}–${x.as_} ${x.away_name}`, meta: `Basketball · ${x.code} · ${x.detail}`,
      href: matchHref('basketball', x.game_id, { home: x.home_name, away: x.away_name, date: x.kickoff }), url: `${API_URL}/admin/bb/game/${x.game_id}/result`,
      swap: x.issue === 'swapped?' ? `Swap scores (${x.as_}–${x.hs})` : null
    })),
    ...d.other.map(x => ({
      key: `${x.sport}${x.id}`, when: x.when, label: x.name || `#${x.id}`, meta: `${x.sport === 'tennis' ? 'Tennis' : 'American football'} · ${x.detail}`,
      href: matchHref(x.sport === 'tennis' ? 'tennis' : 'american-football', x.id, { home: x.home, away: x.away, date: x.when }), url: `${API_URL}/admin/result-review/${x.sport}/${x.id}`,
      swap: x.sport === 'tennis' ? 'Give the win to the other player' : 'Swap scores'
    }))
  ]
  return (
    <>
      {err && <p className="text-xs text-loss mb-1">{err}</p>}
      <ul className="divide-y divide-line/50 text-sm">
        {rows.slice(0, 12).map(x => (
          <li key={x.key} className="py-2">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="w-14 text-[11px] text-faint num">{x.when ? day(x.when) : ''}</span>
              {x.href ? <Link to={x.href} className="font-semibold text-draw hover:underline">{x.label}</Link> : <span className="font-semibold text-ink">{x.label}</span>}
              <span className="text-[11px] text-muted">{x.meta}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2 sm:pl-[68px]">
              {x.swap && <button type="button" disabled={!!busy} onClick={() => act(x.key, x.url, 'swap')} className={`${btn} bg-accent text-bg`}>{x.swap}</button>}
              <button type="button" disabled={!!busy} onClick={() => act(x.key, x.url, 'confirm')} className={`${btn} bg-surface2 border border-line text-ink`}>Keep as is</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

function ContactOpen({ done }: { done: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const load = () => axios.get(`${API_URL}/admin/contact`).then(r => setRows((r.data.data.rows as any[]).filter(x => !x.handled))).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  const mark = (id: number) => axios.post(`${API_URL}/admin/contact/${id}`, { handled: true }).then(() => { load(); done() })
  if (!rows) return <p className="text-sm text-faint">Loading…</p>
  return (
    <ul className="divide-y divide-line/50 text-sm">
      {rows.slice(0, 10).map(r => (
        <li key={r.id} className="py-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
            <span>#{r.id} · {day(r.at)}</span>
            <span className="text-ink">{r.name || '—'}</span>
            <a href={`mailto:${r.email}?subject=${encodeURIComponent(`Re: your message to SportLikely (#${r.id})`)}`} className="text-accent">{r.email}</a>
            <button type="button" onClick={() => mark(r.id)} className="ml-auto h-8 px-3 rounded-lg text-xs font-semibold bg-win/15 text-win hover:bg-win/25">Mark answered</button>
          </div>
          <p className="text-ink mt-1 whitespace-pre-wrap break-words line-clamp-3">{r.message}</p>
        </li>
      ))}
    </ul>
  )
}

/** Needs you: only what a person must do — each kind with its count and its buttons; red checks with what to do */
export function NeedsYouCard({ ctx, reload }: { ctx: Ctx; reload: () => void }) {
  const s = ctx.summary
  const red = (ctx.checks || []).filter(c => c.level === 'fail')
  if (!s || !ctx.checks) return <section className="card p-5 sm:p-6 mb-8 text-sm text-faint">Loading…</section>
  const none = !s.photosToReview && !s.injuriesToReview && !s.bbResultsToCheck && !s.contactOpen && !red.length
  return (
    <section className="card p-5 sm:p-6 mb-8">
      {none ? (
        <p className="text-base font-semibold text-win py-4 text-center">Nothing needs you right now ✓</p>
      ) : (
        <div className="divide-y divide-line/50">
          {s.photosToReview > 0 && <Group title="Player photos to review" n={s.photosToReview} to="data"><PhotosToReview done={reload} /></Group>}
          {s.injuriesToReview > 0 && <Group title="Injury news to review (basketball)" n={s.injuriesToReview} to="data"><InjuriesToReview done={reload} /></Group>}
          {s.bbResultsToCheck > 0 && <Group title="Results to check" n={s.bbResultsToCheck} to="data"><p className="text-xs text-muted mb-1">The data may have these scores wrong and our checks disagree (clear cases are fixed automatically). Compare with the league’s own site, then swap or keep.</p><ResultsToCheck done={reload} /></Group>}
          {s.contactOpen > 0 && <Group title="Contact messages to answer" n={s.contactOpen} to="users"><ContactOpen done={reload} /></Group>}
          {red.length > 0 && (
            <Group title="Checks with a problem" n={red.length}>
              <CheckList checks={red} />
              <p className="mt-2 text-[11px] text-faint">Each one also shows in its own tab: {[...new Set(red.map(c => healthTab(c.id)))].map((t, i) => <span key={t}>{i ? ' · ' : ''}<Link to={adminPath(t)} className="text-accent">{t.replace('-', ' ')}</Link></span>)}</p>
            </Group>
          )}
        </div>
      )}
    </section>
  )
}

/* ---------------- Speed (/api/perf summary) ---------------- */

export function SpeedCard() {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { axios.get(`${API_URL}/perf`).then(r => setD(r.data.data)).catch(e => setErr(errorText(e))) }, [])
  if (err) return <section className="card p-5 sm:p-6 mb-8 text-sm text-loss">Speed: {err}</section>
  if (!d) return <section className="card p-5 sm:p-6 mb-8 text-sm text-faint">Loading…</section>
  const w = d.worker || {}, web = d.web || {}
  const row = (label: string, value: ReactNode, meaning: string) => (
    <li className="py-2 flex flex-wrap items-baseline gap-x-3"><span className="w-44 shrink-0 text-muted">{label}</span><b className="num text-ink">{value}</b><span className="text-[11px] text-faint">{meaning}</span></li>
  )
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <h2 className="font-display text-lg font-bold text-ink mb-2">Speed</h2>
      <ul className="divide-y divide-line/50 text-sm">
        {row('Website freezes', `${web.stallsLastHour ?? '–'} · worst ${web.worstLastHour ?? '–'} ms`, 'last hour; under 300 ms nobody notices')}
        {row('Website running for', `${web.uptimeMin ?? '–'} min`, 'since the last deploy or restart')}
        {row('Background freezes', `${w.stallsLastHour ?? '–'} · worst ${w.worstLastHour ?? '–'} ms`, 'last hour; visitors never wait for these')}
        {row('Background memory', `${w.heapMb ?? '–'} of ${w.heapLimitMb ?? '–'} MB`, 'lower is better; a warning over 85%')}
        {row('Background restarts', `${w.restarts24h ?? w.restarts ?? 0}`, 'last 24 hours; 0 is normal')}
      </ul>
    </section>
  )
}

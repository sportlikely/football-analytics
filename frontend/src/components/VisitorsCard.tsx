import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'

interface Visitors {
  onlineNow: number; onlineSignedIn: number; onlineWindowMin: number; onlineAll?: number
  today: number; last7: number; last30: number; returning30: number
  // fix183: people only; what was filtered, and the old number (every API caller) kept for a week to compare
  todayBots?: number; todayAll?: number; last7All?: number; last30All?: number; botReasons?: { reason: string; n: number }[]
  peopleSince?: string; datacentre?: { loaded: boolean; status: string }
  daily: { day: string; visitors: number; signedIn: number; hits: number; bots?: number; allCallers?: number }[]
  countingSince: string | null
  countries?: { last7: CountryRow[]; last30: CountryRow[]; since: string | null; geo: { loaded: boolean; status: string; source: string } }
  who?: Who
}
// fix199: who is calling today — the top user-agents and data-centre / proxy networks
type Mark = 'search-engine' | 'seo-tool' | 'data-centre' | 'script' | 'browser'
interface Who {
  day: string; otherRequests: number; limits: { addressHour: number; addressDay: number; networkHour: number }
  agents: { ua: string; requests: number; mark: Mark }[]
  networks: { name: string; asn: number; cc: string | null; requests: number; addresses: number; refused: number; logged: boolean; mark: Mark }[]
}
interface CountryRow { country: string; visitors: number; signedIn: number; bots?: number }
const REASON: Record<string, string> = { 'no-signs': 'no signs of a person', ua: 'bot user-agent', crawler: 'search-engine crawlers', 'fake-crawler': 'fake crawlers', datacentre: 'data-centre networks', headless: 'headless browsers' }
// the old "all API callers" number is shown for a week after the switch to people only, then goes
const showOld = (since?: string) => !!since && Date.now() - Date.parse(since) < 8 * 86400000
const flagOf = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐')
let regionNames: Intl.DisplayNames | null = null
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }) } catch { /* old browser */ }
const nameOf = (cc: string) => (cc === '??' ? 'Unknown' : (() => { try { return regionNames?.of(cc) || cc } catch { return cc } })())

/** Visitors by country (from the IP at the moment of the visit; only the country is kept). */
function Countries({ c }: { c: NonNullable<Visitors['countries']> }) {
  const [range, setRange] = useState<'last7' | 'last30'>('last30')
  const [all, setAll] = useState(false)
  const rows = c[range]
  const total = rows.reduce((a, r) => a + r.visitors, 0)
  const shown = all ? rows : rows.slice(0, 10)
  const max = Math.max(1, ...rows.map(r => r.visitors))
  return (
    <div className="mt-6 pt-5 border-t border-line/60">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-display font-bold text-ink">Visitors by country</h3>
        <div className="seg">
          <button type="button" onClick={() => setRange('last7')} className={`seg-btn ${range === 'last7' ? 'seg-btn-active' : ''}`}>7 days</button>
          <button type="button" onClick={() => setRange('last30')} className={`seg-btn ${range === 'last30' ? 'seg-btn-active' : ''}`}>30 days</button>
        </div>
      </div>
      {!c.geo.loaded && <p className="text-xs text-draw mb-2">Country data not loaded yet ({c.geo.status}). It downloads by itself a minute after the server starts.</p>}
      {rows.length === 0 ? <p className="text-sm text-faint">No visits yet.</p> : (
        <ul className="space-y-1.5">
          {shown.map(r => (
            <li key={r.country} className="flex items-center gap-3 text-sm">
              <span className="w-6 text-center text-base leading-none" aria-hidden>{flagOf(r.country)}</span>
              <span className="w-40 truncate text-ink">{nameOf(r.country)}</span>
              <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden"><span className="block h-full rounded-full bg-accent/70" style={{ width: `${(r.visitors / max) * 100}%` }} /></span>
              <span className="w-10 text-right num text-ink">{r.visitors}</span>
              <span className="w-14 text-right num text-[11px] text-faint" title="bots / scripts filtered">{r.bots ? `+${r.bots} bots` : ''}</span>
              <span className="w-12 text-right num text-[11px] text-faint">{total ? Math.round((r.visitors / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 10 && <button type="button" onClick={() => setAll(v => !v)} className="mt-2 text-xs font-semibold text-accent">{all ? 'Show top 10' : `Show all ${rows.length} countries`}</button>}
      <p className="mt-3 text-[10px] text-faint">
        People only (bots / scripts filtered shown apart) · only the country is kept, never the IP{c.since ? ` · countries since ${new Date(c.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''} · "Unknown" = visits before countries were counted or unlisted addresses · IP data by <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="underline">DB-IP</a> (CC BY 4.0)
      </p>
    </div>
  )
}

const MARK: Record<Mark, [string, string]> = {
  'search-engine': ['verified search engine', 'text-win'], 'seo-tool': ['SEO tool', 'text-draw'], 'data-centre': ['data-centre', 'text-loss'],
  script: ['unknown script', 'text-loss'], browser: ['browser', 'text-faint']
}
const n0 = (x: number) => x.toLocaleString('en-US')

/** fix199: today's top 20 user-agents and networks, each marked (search engines are verified by DNS). */
function WhoCard({ w }: { w: Who }) {
  const [tab, setTab] = useState<'agents' | 'networks'>('networks')
  const mark = (m: Mark) => <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${MARK[m][1]}`}>{MARK[m][0]}</span>
  return (
    <div className="mt-6 pt-5 border-t border-line/60">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-display font-bold text-ink">Who is calling today</h3>
        <div className="seg">
          <button type="button" onClick={() => setTab('networks')} className={`seg-btn ${tab === 'networks' ? 'seg-btn-active' : ''}`}>Networks</button>
          <button type="button" onClick={() => setTab('agents')} className={`seg-btn ${tab === 'agents' ? 'seg-btn-active' : ''}`}>User-agents</button>
        </div>
      </div>
      {tab === 'networks' ? (
        w.networks.length === 0 ? <p className="text-sm text-faint">No data-centre or proxy network today.</p> : (
          <ul className="space-y-1.5 text-sm">
            {w.networks.map(n => (
              <li key={n.asn} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="min-w-0 flex-1 truncate text-ink">{n.name} <span className="text-faint text-[11px]">AS{n.asn}{n.cc ? `, ${n.cc}` : ''}</span></span>
                {mark(n.mark)}
                <span className="text-right num text-[11px] text-faint">{n0(n.addresses)} addr · {n0(n.requests)} req{n.refused ? ` · ${n0(n.refused)} refused` : ''}{n.logged ? ' · in the security log' : ''}</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <ul className="space-y-1.5 text-sm">
          {w.agents.map(a => (
            <li key={a.ua} className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate text-ink text-xs" title={a.ua}>{a.ua}</span>
              {mark(a.mark)}
              <span className="w-14 text-right num text-[11px] text-faint">{n0(a.requests)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-faint">
        API requests today (UTC) · other networks (homes, mobiles): {n0(w.otherRequests)} requests · data-centre / proxy addresses get stored data only, {w.limits.addressHour} reads an hour and {w.limits.addressDay} a day per address, {w.limits.networkHour} an hour per network, and no prediction when signed out
      </p>
    </div>
  )
}

/** Admin: people on the site now, and unique visitors (one per IP) today / 7 / 30 days, with a 30-day bar chart. */
export default function VisitorsCard() {
  const [v, setV] = useState<Visitors | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let off = false
    const load = () => axios.get(`${API_URL}/admin/visitors`).then(r => { if (!off) { setV(r.data.data); setErr(false) } }).catch(() => !off && setErr(true))
    load()
    const iv = setInterval(load, 30000)
    return () => { off = true; clearInterval(iv) }
  }, [])
  if (err && !v) return null

  // the last 30 days, missing days as 0
  const days: { day: string; visitors: number; signedIn: number; bots: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    const r = v?.daily.find(x => x.day === d)
    days.push({ day: d, visitors: r?.visitors || 0, signedIn: r?.signedIn || 0, bots: r?.bots || 0 })
  }
  const old = showOld(v?.peopleSince)
  const max = Math.max(1, ...days.map(d => d.visitors))
  const tile = (label: string, value: number | string | undefined, sub?: string, live = false) => (
    <div className={`rounded-xl border px-4 py-3 ${live ? 'border-live/40 bg-live/[0.07]' : 'border-line/60 bg-surface2/50'}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
        {live && <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />}{label}
      </div>
      <div className={`num text-2xl font-extrabold leading-none mt-1.5 ${live ? 'text-live' : 'text-ink'}`}>{value ?? '–'}</div>
      {sub && <div className="text-[11px] text-faint mt-1">{sub}</div>}
    </div>
  )
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-lg font-bold text-ink">Visitors</h2>
        <span className="text-xs text-faint">one visitor = one person (the page was open 5+ s and used, or signed in) · admins, bots, crawlers, data-centre networks and headless browsers not counted{v?.peopleSince ? ` · people only since ${new Date(v.peopleSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}{v?.countingSince ? ` · counting since ${new Date(v.countingSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile('Online now', v?.onlineNow, v ? `people · ${v.onlineSignedIn} signed in · last ${v.onlineWindowMin} min` : undefined, true)}
        <div className="rounded-xl border border-line/60 bg-surface2/50 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Visitors today</div>
          <div className="flex items-baseline gap-2 mt-1.5 flex-wrap">
            <span className="num text-2xl font-extrabold leading-none text-ink">{v?.today ?? '–'}</span>
            <span className="text-xs text-ink font-semibold">people</span>
            {v?.todayBots != null && <span className="text-[11px] text-faint num" title={(v.botReasons || []).map(r => `${r.n} ${REASON[r.reason] || r.reason}`).join(' · ')}>{v.todayBots} bots / scripts filtered</span>}
          </div>
          {old && v?.todayAll != null && <div className="text-[10px] text-faint mt-1 num">old count: {v.todayAll} all API callers</div>}
        </div>
        {tile('Last 7 days', v?.last7, old && v?.last7All != null ? `people · old count ${v.last7All} callers` : 'people')}
        {tile('Last 30 days', v?.last30, v ? `${v.returning30} came back on another day${old && v.last30All != null ? ` · old count ${v.last30All}` : ''}` : undefined)}
      </div>
      {v?.botReasons && v.botReasons.length > 0 && (
        <p className="mt-2 text-[11px] text-faint">Filtered today: {v.botReasons.map(r => `${r.n} ${REASON[r.reason] || r.reason}`).join(' · ')}{v.datacentre && !v.datacentre.loaded ? ` · data-centre list: ${v.datacentre.status}` : ''}{old && v.onlineAll != null ? ` · online now, all callers: ${v.onlineAll}` : ''}</p>
      )}
      <div className="mt-5">
        <div className="flex items-end gap-[3px] h-28">
          {days.map(d => (
            <div key={d.day} className="group relative flex-1 h-full flex flex-col justify-end" title={`${d.day}: ${d.visitors} people, ${d.signedIn} signed in, ${d.bots} bots / scripts filtered`}>
              <div className="w-full rounded-t-[3px] bg-accent/70 group-hover:bg-accent transition-colors flex flex-col justify-end overflow-hidden" style={{ height: `${(d.visitors / max) * 100}%`, minHeight: d.visitors ? 2 : 0 }}>
                <div className="w-full bg-home/80" style={{ height: d.visitors ? `${(d.signedIn / d.visitors) * 100}%` : 0 }} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-faint mt-1.5 num">
          <span>{new Date(days[0].day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-accent/70" />people per day</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-home/80" />signed in</span>
          </span>
          <span>Today</span>
        </div>
      </div>
      {v?.countries && <Countries c={v.countries} />}
      {v?.who && <WhoCard w={v.who} />}
    </section>
  )
}

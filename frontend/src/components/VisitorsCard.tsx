import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import CopyForClaude from './admin/CopyForClaude'
import { elText } from '../lib/forClaude'
import { poll } from '../lib/poll'

type Geo = { loaded: boolean; status: string; source: string }
interface Visitors {
  onlineNow: number; onlineSignedIn: number; onlineWindowMin: number; onlineAll?: number
  today: number; last7: number; last30: number; returning30: number
  // fix183: people only; what was filtered, and the old number (every API caller) kept for a week to compare
  todayBots?: number; todayAll?: number; last7All?: number; last30All?: number; last7Bots?: number; last30Bots?: number; dayZone?: string; botReasons?: { reason: string; n: number }[]
  peopleSince?: string; datacentre?: { loaded: boolean; status: string }
  daily: { day: string; visitors: number; signedIn: number; hits: number; bots?: number; allCallers?: number; kinds?: Kinds }[]
  // fix285: each caller once — people / search engines / link previews / blocked bots / other bots (they add up to all callers)
  kinds?: { today: Kinds; last7: Kinds; last30: Kinds }
  goodBots?: GoodBotRow[]
  countingSince: string | null
  countries?: { last7: CountryRow[]; last30: CountryRow[]; since: string | null; geo?: Geo }
  // fix273: the stored summary's time (the worker builds it every 5 min); the country list in use (live); not built yet
  builtAt?: string; geo?: Geo; pending?: boolean
  who?: Who
  crawlers?: Crawlers
  // fix277: scraper swarms (live, from the web process) and the admin's switches; the day's bots split
  swarms?: SwarmRow[]; swarmOverrides?: SwarmOverride[]
  botSplit?: { crawlers: number; swarms: number; other: number }
}
interface SwarmRow {
  ua: string; text: string; state: 'challenged' | 'watching'; why: 'hour' | 'day' | 'always' | null; override: 'trust' | 'challenge' | null
  countries: { cc: string; addresses: number }[]; networks: { name: string; addresses: number }[]; otherNetworks: number
  addressesHour: number; addresses: number; requests: number; views: number; human: number; humanShare: number; headless: number
  refused: number; refused24h: number; wrong: number; groupsHeld: number; since: string | null; until: string | null
}
type Kind = 'people' | 'search' | 'previews' | 'blocked' | 'other'
type Kinds = Record<Kind, number>
const KINDS: { k: Kind; label: string; cls: string }[] = [
  { k: 'people', label: 'People', cls: 'bg-accent/80' }, { k: 'search', label: 'Search engines', cls: 'bg-home/80' },
  { k: 'previews', label: 'Link previews', cls: 'bg-draw/80' }, { k: 'blocked', label: 'Blocked bots', cls: 'bg-loss/70' }, { k: 'other', label: 'Other bots', cls: 'bg-faint/50' }
]
// fix285: link previews and AI crawlers that name themselves (live counts today; AI bots carry Yarin's Trust / Challenge switch)
interface GoodBotRow {
  id: string; name: string; kind: 'preview' | 'ai'; owner: string; checked: 'ranges' | 'dns' | 'card' | 'name'; mode: 'trust' | 'challenge' | null; modeBy: string | null
  requests: number; pages: number; addresses: number; verified: number; card: number; fake: number; challenged: number
}
interface SwarmOverride { ua: string; mode: 'trust' | 'challenge'; text: string | null; by: string | null; at: string }
// fix245: search engines today — verified by their published address lists or DNS, refused (429 / 503), the day's DNS sample
type EngineDay = { requests: number; verified: number; byList: number; byDns: number; refused: number; s429: number; s503: number; api: number }
interface CrawlerDay {
  day: string; engines: Record<'google' | 'bing' | 'apple', EngineDay>; googleRanges: { requests: number; refused: number; s429: number; s503: number }
  refusedRecent: string[]; sample: { at: string; ip: string; system: string; publicDns: string; forward: string; ok: boolean } | null
  uaLog?: UaSample[]
  // fix262b: Googlebot / Bingbot / Applebot user-agents from a data-centre network, not verified (refused, not the engine)
  fakes?: { requests: number; byNetwork: Record<string, number> }
}
// fix254: 20 Googlebot-UA requests a day as they reached us (socket, X-Forwarded-For chain, req.ip, network, Google's list)
interface UaSample { at: string; path: string; socket: string; xff: string; realIp: string; reqIp: string; client: string; asn: string; inGoogle: boolean; googleHop: string | null; hops?: string; why?: string }
interface Crawlers { today: CrawlerDay | null; yesterday: CrawlerDay | null; lists: { status: string; ranges: number; at: string | null } }
// fix199: who is calling today — the top user-agents and data-centre / proxy networks
type Mark = 'search-engine' | 'seo-tool' | 'data-centre' | 'script' | 'browser'
interface Who {
  day: string; otherRequests: number; limits: { addressHour: number; addressDay: number; networkHour: number; passHour?: number }
  agents: { ua: string; requests: number; mark: Mark }[]
  // fix244: passed = browsers that passed the Quick check today; passRefused = how many of them were refused after it
  networks: { name: string; asn: number; cc: string | null; requests: number; addresses: number; refused: number; logged: boolean; mark: Mark; passed?: number; passedRequests?: number; passRefused?: number }[]
}
interface CountryRow { country: string; visitors: number; signedIn: number; bots?: number }
const REASON: Record<string, string> = { 'no-signs': 'no signs of a person', ua: 'bot user-agent', crawler: 'search-engine crawlers', 'fake-crawler': 'fake crawlers', datacentre: 'data-centre networks', headless: 'headless browsers', swarm: 'scraper swarms' }
// the old "all API callers" number is shown for a week after the switch to people only, then goes
const showOld = (since?: string) => !!since && Date.now() - Date.parse(since) < 8 * 86400000
// fix274: the server's days are Israel-time days ('YYYY-MM-DD'); i days before today
const ilDayAgo = (i: number) => {
  let t: string
  try { t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) } catch { t = new Date().toISOString().slice(0, 10) }
  const [y, m, d] = t.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10)
}
const flagOf = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '🌐')
let regionNames: Intl.DisplayNames | null = null
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }) } catch { /* old browser */ }
const nameOf = (cc: string) => (cc === '??' ? 'Unknown' : (() => { try { return regionNames?.of(cc) || cc } catch { return cc } })())

/** Visitors by country (from the IP at the moment of the visit; only the country is kept). */
function Countries({ c, geo }: { c: NonNullable<Visitors['countries']>; geo?: Geo }) {
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
      {geo && !geo.loaded && <p className="text-xs text-draw mb-2">Country data not loaded yet ({geo.status}). It downloads by itself a minute after the server starts.</p>}
      {rows.length === 0 ? <p className="text-sm text-faint">No visits yet.</p> : (
        <ul className="space-y-1.5">
          {shown.map(r => (
            <li key={r.country} className="flex items-center gap-3 text-sm">
              <span className="w-6 text-center text-base leading-none" aria-hidden>{flagOf(r.country)}</span>
              <span className="w-40 truncate text-ink">{nameOf(r.country)}</span>
              <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden"><span className="block h-full rounded-full bg-accent/70" style={{ width: `${(r.visitors / max) * 100}%` }} /></span>
              <span className="w-10 text-end num text-ink">{r.visitors}</span>
              <span className="w-14 text-end num text-[11px] text-faint" title="bots / scripts filtered">{r.bots ? `+${r.bots} bots` : ''}</span>
              <span className="w-12 text-end num text-[11px] text-faint">{total ? Math.round((r.visitors / total) * 100) : 0}%</span>
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

/** fix245: Google / Bing / Apple today and yesterday — verified, refused, how; the DNS sample of a Google address. */
function CrawlersCard({ c }: { c: Crawlers }) {
  const ENGINES = [['google', 'Google'], ['bing', 'Bing'], ['apple', 'Apple']] as const
  const day = (d: CrawlerDay | null, label: string) => !d ? null : (
    <div className="mb-3">
      <p className="text-xs font-semibold text-ink mb-1">{label}</p>
      <ul className="space-y-1 text-sm">
        {ENGINES.map(([k, name]) => { const e = d.engines[k]; return (
          <li key={k} className="flex flex-wrap items-baseline gap-x-3">
            <span className="min-w-0 flex-1 text-ink">{name}</span>
            <span className={`num text-[11px] ${e.refused ? 'text-loss font-semibold' : 'text-faint'}`}>{n0(e.requests)} req · {n0(e.verified)} verified ({n0(e.byList)} list, {n0(e.byDns)} DNS) · {n0(e.refused)} refused</span>
          </li>) })}
        <li className="flex flex-wrap items-baseline gap-x-3">
          <span className="min-w-0 flex-1 text-ink">From Google’s addresses</span>
          <span className={`num text-[11px] ${d.googleRanges.refused ? 'text-loss font-semibold' : 'text-faint'}`}>{n0(d.googleRanges.requests)} req · {n0(d.googleRanges.s429)} × 429 · {n0(d.googleRanges.s503)} × 503</span>
        </li>
      </ul>
      {d.fakes && d.fakes.requests > 0 && <p className="mt-1 text-[11px] text-faint break-words">Fake crawlers (search-engine user-agent from a data-centre network, not verified; refused): <span className="num text-ink">{n0(d.fakes.requests)}</span> — {Object.entries(d.fakes.byNetwork).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${n0(v)}`).join(', ')}</p>}
      {d.refusedRecent.length > 0 && <ul className="mt-1 text-[11px] text-loss space-y-0.5">{d.refusedRecent.slice(-5).map((x, i) => <li key={i} className="truncate" title={x}>{x}</li>)}</ul>}
      {d.uaLog && d.uaLog.length > 0 && (
        <details className="mt-1">
          <summary className="text-[11px] text-ink cursor-pointer">Googlebot user-agent log ({d.uaLog.length}) · in Google’s list: {d.uaLog.filter(x => x.inGoogle).length}</summary>
          <ul className="mt-1 space-y-1 text-[11px] text-faint">
            {d.uaLog.map((x, i) => (
              <li key={i} className="break-words">
                <span className="num">{x.at.slice(11, 16)}</span> {x.path} · socket {x.socket || '—'} · X-Forwarded-For {x.xff || '—'}{x.realIp ? ` · X-Real-IP ${x.realIp}` : ''} · req.ip <span className="text-ink">{x.reqIp}</span>{x.client !== x.reqIp ? ` (client would be ${x.client})` : ''} · {x.asn} · <span className={x.inGoogle ? 'text-win' : 'text-loss'}>{x.inGoogle ? 'in Google’s list' : 'not in Google’s list'}</span>{x.googleHop && !x.inGoogle ? ` (Google address in the chain: ${x.googleHop})` : ''}{x.hops ? <span className="block">hops: {x.hops}{x.why ? ` — ${x.why}` : ''}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
      {d.sample && <p className="mt-1 text-[11px] text-faint break-words">DNS sample {d.sample.at.slice(11, 16)} UTC, {d.sample.ip}: system resolver {d.sample.system} · public resolver {d.sample.publicDns} · {d.sample.forward} → {d.sample.ok ? 'verified' : 'not verified'}</p>}
    </div>
  )
  return (
    <div className="mt-6 pt-5 border-t border-line/60" data-copy-block="search-engines">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-display font-bold text-ink">Search engines</h3>
        {/* fix259 */}
        <CopyForClaude size="sm" req={() => ({ place: 'Admin → Visitors & users → Visitors → Search engines', scope: 'item', checks: [{ id: 'crawlers-verified' }], shown: [{ title: 'Search engines', text: elText(document.querySelector<HTMLElement>('[data-copy-block="search-engines"]')) }] })} />
      </div>
      {day(c.today, 'Today (UTC)')}
      {day(c.yesterday, 'Yesterday')}
      <p className="text-[10px] text-faint">Verified = the address is in the engine’s published list, or reverse + forward DNS points back to it. A verified search engine is never limited or refused. Lists: {c.lists.status}</p>
    </div>
  )
}

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
                <span className="text-end num text-[11px] text-faint">{n0(n.addresses)} addr · {n0(n.requests)} req{n.refused ? ` · ${n0(n.refused)} refused` : ''}{n.passed ? ` · ${n0(n.passed)} passed the check` : ''}{n.passRefused ? ` · ${n0(n.passRefused)} refused after it` : ''}{n.logged ? ' · in the security log' : ''}</span>
                {/* fix259: a network that was refused or looks like a script */}
                {(n.refused > 0 || n.mark === 'script' || n.mark === 'data-centre') && <CopyForClaude size="sm" req={() => ({
                  place: 'Admin → Visitors & users → Visitors → Who is calling today', scope: 'item',
                  shown: [{ title: `Network ${n.name} (AS${n.asn})`, text: `${n.name} · AS${n.asn}${n.cc ? ` · ${n.cc}` : ''} · marked ${n.mark} · ${n.addresses} addresses · ${n.requests} requests today · ${n.refused} refused${n.passed ? ` · ${n.passed} passed the check (${n.passedRequests ?? 0} requests)` : ''}${n.passRefused ? ` · ${n.passRefused} refused after it` : ''} · in the security log: ${n.logged ? 'yes' : 'no'}\nLimits: ${w.limits.addressHour} page views an hour and ${w.limits.addressDay} a day per address, ${w.limits.networkHour} API reads an hour per network` }]
                })} />}
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
              <span className="w-14 text-end num text-[11px] text-faint">{n0(a.requests)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-faint">
        API requests today (UTC) · other networks (homes, mobiles): {n0(w.otherRequests)} requests · data-centre / proxy addresses get stored data only, {w.limits.addressHour} page views an hour and {w.limits.addressDay} a day per address, {w.limits.networkHour} API reads an hour per network, and no prediction when signed out · over a limit a browser gets the Quick check (Turnstile): passed = no address or network limit for 24 h{w.limits.passHour ? ` (${w.limits.passHour} page views an hour)` : ''}
      </p>
    </div>
  )
}

const WHY: Record<string, string> = { hour: '40+ addresses in an hour, under 5% people', day: '300+ addresses today, under 5% people', always: 'always challenged (your switch)' }
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–')
const swarmText = (r: SwarmRow) => `${r.text}\nState: ${r.override === 'trust' ? 'trusted (your switch)' : r.state}${r.why ? ` — ${WHY[r.why]}` : ''}${r.since ? ` · since ${r.since}` : ''}${r.until ? ` · until ${r.until}` : ''}\nCountries: ${r.countries.map(c => `${c.cc} ${c.addresses}`).join(', ') || '–'} · networks: ${r.networks.map(n => `${n.name} ${n.addresses}`).join(', ') || 'none listed'}${r.otherNetworks ? ` + ${r.otherNetworks} home / mobile networks` : ''}\nAddresses: ${r.addressesHour} this hour, ${r.addresses} today · ${r.requests} requests, ${r.views} page loads · people ${r.human} (${r.humanShare}%) · headless ${r.headless} · challenged ${r.refused} today, ${r.refused24h} in 24 h${r.wrong ? ` · WRONG challenges: ${r.wrong}` : ''}`

/** fix277: groups of many addresses that act like one script — challenged with the Quick check; a switch per user-agent */
function SwarmsCard({ rows, overrides, reload }: { rows: SwarmRow[]; overrides: SwarmOverride[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const set = (ua: string, mode: 'trust' | 'challenge' | null) => {
    setBusy(ua)
    axios.post(`${API_URL}/admin/swarms/${ua}`, { mode }).then(reload).catch(() => {}).finally(() => setBusy(null))
  }
  const modeOf = (ua: string) => overrides.find(o => o.ua === ua)?.mode || null
  const idle = overrides.filter(o => !rows.some(r => r.ua === o.ua))
  const sw = (ua: string) => {
    const m = modeOf(ua)
    const b = (mode: 'trust' | 'challenge' | null, label: string) => (
      <button type="button" disabled={busy === ua} onClick={() => set(ua, mode)} className={`seg-btn ${m === mode ? 'seg-btn-active' : ''}`}>{label}</button>
    )
    return <div className="seg text-[11px]">{b(null, 'Rules')}{b('challenge', 'Always challenge')}{b('trust', 'Trust')}</div>
  }
  return (
    <div className="mt-6 pt-5 border-t border-line/60" data-copy-block="swarms">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-display font-bold text-ink">Swarms</h3>
        <CopyForClaude size="sm" req={() => ({ place: 'Admin → Visitors & users → Visitors → Swarms', scope: 'item', checks: [{ id: 'scraper-swarms' }], shown: [{ title: 'Swarms', text: rows.map(swarmText).join('\n\n') || 'No swarm today' }] })} />
      </div>
      {rows.length === 0 ? <p className="text-sm text-faint">No group of addresses acting like one script today.</p> : (
        <ul className="space-y-3 text-sm">
          {rows.map(r => {
            const trusted = r.override === 'trust'
            return (
              <li key={r.ua} className="rounded-xl border border-line/60 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 truncate text-xs text-ink" title={r.text}>{r.text}</span>
                  <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${trusted ? 'text-win' : r.state === 'challenged' ? 'text-loss' : 'text-faint'}`}>{trusted ? 'trusted' : r.state}</span>
                </div>
                <p className="mt-1 text-[11px] text-faint num">
                  {r.countries.map(c => `${flagOf(c.cc)} ${c.cc} ${n0(c.addresses)}`).join(' · ') || '–'}
                  {' · '}{r.networks.map(n => `${n.name} ${n0(n.addresses)}`).join(', ') || 'no listed network'}{r.otherNetworks ? ` + ${n0(r.otherNetworks)} home / mobile networks` : ''}
                </p>
                <p className="text-[11px] text-faint num">
                  {n0(r.addressesHour)} addresses this hour · {n0(r.addresses)} today · {n0(r.requests)} requests · {r.humanShare}% people · {n0(r.refused)} challenged
                  {r.state === 'challenged' && !trusted ? ` · since ${hm(r.since)}${r.why ? ` (${WHY[r.why]})` : ''}` : ''}{r.wrong ? ` · ${n0(r.wrong)} wrong challenges` : ''}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sw(r.ua)}
                  <CopyForClaude size="sm" req={() => ({ place: 'Admin → Visitors & users → Visitors → Swarms', scope: 'item', checks: [{ id: 'scraper-swarms' }], shown: [{ title: 'Swarm', text: swarmText(r) }] })} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {idle.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[11px] text-faint">
          {idle.map(o => (
            <li key={o.ua} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={o.text || o.ua}>{o.mode === 'trust' ? 'Trusted' : 'Always challenged'}: {o.text || o.ua} (no traffic today)</span>
              {sw(o.ua)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[10px] text-faint">
        A group = one browser name + country + network. It is challenged when 40+ of its addresses in an hour (or 300+ of one browser name in a day) show almost no person (under 5% scrolled or clicked), and stays so for 6 hours. Admins, real search engines, signed-in accounts with a confirmed email and browsers that passed the Quick check are never challenged; its other visitors get the Quick check instead of pages and are not counted as visitors. Trust stops it at once.
      </p>
    </div>
  )
}

const CHECKED: Record<GoodBotRow['checked'], string> = { ranges: 'published addresses', dns: 'reverse DNS', card: 'nothing published: Open Graph card only', name: 'name only (nothing published)' }
const botText = (r: GoodBotRow) => `${r.name} (${r.owner}) · ${r.kind === 'ai' ? `AI crawler, ${r.mode === 'trust' ? 'trusted' : 'challenged'}` : 'link preview, never challenged'} · checked by ${CHECKED[r.checked]} · today ${r.requests} requests, ${r.pages} pages, ${r.addresses} addresses, ${r.verified} verified${r.card ? `, ${r.card} card only` : ''}${r.fake ? `, ${r.fake} fakes (treated as unknown callers)` : ''}${r.challenged ? `, ${r.challenged} challenged` : ''}`

/** fix285: link previews (never challenged when verified) and AI crawlers that name themselves (a switch each) */
function GoodBotsCard({ rows, reload }: { rows: GoodBotRow[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const set = (id: string, mode: 'trust' | 'challenge') => {
    setBusy(id)
    axios.post(`${API_URL}/admin/good-bots/${id}`, { mode }).then(reload).catch(() => {}).finally(() => setBusy(null))
  }
  const ai = rows.filter(r => r.kind === 'ai'), previews = rows.filter(r => r.kind === 'preview')
  const line = (r: GoodBotRow) => (
    <p className="text-[11px] text-faint num">
      {n0(r.requests)} requests · {n0(r.pages)} pages · {n0(r.addresses)} addresses today · {n0(r.verified)} verified{r.card ? ` · ${n0(r.card)} card only` : ''}{r.fake ? ` · ${n0(r.fake)} fakes` : ''}{r.challenged ? ` · ${n0(r.challenged)} challenged` : ''} · {CHECKED[r.checked]}
    </p>
  )
  return (
    <div className="mt-6 pt-5 border-t border-line/60" data-copy-block="good-bots">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="font-display font-bold text-ink">AI crawlers and link previews</h3>
        <CopyForClaude size="sm" req={() => ({ place: 'Admin → Visitors & users → Visitors → AI crawlers and link previews', scope: 'item', shown: [{ title: 'AI crawlers and link previews', text: rows.map(botText).join('\n') }] })} />
      </div>
      <ul className="space-y-2 text-sm">
        {ai.map(r => (
          <li key={r.id} className="rounded-xl border border-line/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-ink">{r.name} <span className="text-faint">· {r.owner}</span></span>
              <div className="seg text-[11px]">
                {(['trust', 'challenge'] as const).map(m => (
                  <button key={m} type="button" disabled={busy === r.id} onClick={() => set(r.id, m)} className={`seg-btn ${r.mode === m ? 'seg-btn-active' : ''}`}>{m === 'trust' ? 'Trust' : 'Challenge'}</button>
                ))}
              </div>
            </div>
            {line(r)}
          </li>
        ))}
      </ul>
      <ul className="mt-3 space-y-1.5">
        {previews.map(r => (
          <li key={r.id} className="text-xs text-ink">
            {r.name} <span className="text-faint">· {r.owner} · never challenged</span>
            {line(r)}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[10px] text-faint">
        Link previews are checked by the addresses their company publishes (or reverse DNS): a real one gets the stored page with its title and picture, never the Quick check; one made on a phone or a server that publishes nothing gets the title and picture only. A copy of a known name from another network is treated like any unknown caller. AI crawlers: Trust = like a search engine (stored pages only); Challenge = the Quick check on every page. Their pages never count as visits.
      </p>
    </div>
  )
}

/** Admin: people on the site now, and unique visitors (one per IP) today / 7 / 30 days, with a 30-day bar chart. */
export default function VisitorsCard() {
  const [v, setV] = useState<Visitors | null>(null)
  const [err, setErr] = useState(false)
  const reloadRef = useRef<() => void>(() => {})
  useEffect(() => {
    let off = false
    const load = () => axios.get(`${API_URL}/admin/visitors`).then(r => { if (!off) { setV(r.data.data); setErr(false) } }).catch(() => !off && setErr(true))
    load()
    reloadRef.current = load
    const stop = poll(load) // fix273: every 5 min, paused while the tab is hidden (the summary is rebuilt every 5 min)
    return () => { off = true; stop() }
  }, [])
  if (err && !v) return null

  // the last 30 days, missing days as 0 (fix274: Israel-time days, as the server counts them)
  const days: { day: string; visitors: number; signedIn: number; bots: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const d = ilDayAgo(i)
    const r = v?.daily?.find(x => x.day === d)
    days.push({ day: d, visitors: r?.visitors || 0, signedIn: r?.signedIn || 0, bots: r?.bots || 0 })
  }
  const old = showOld(v?.peopleSince)
  const split = (k: Kinds) => KINDS.map(x => `${x.label} ${n0(k[x.k])}`).join(' · ')
  const kindDays = days.map(d => ({ day: d.day, k: v?.daily?.find(x => x.day === d.day)?.kinds }))
  const maxAll = Math.max(1, ...kindDays.map(d => (d.k ? KINDS.reduce((t, x) => t + d.k![x.k], 0) : 0)))
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
        <span className="text-xs text-faint">one visitor = one person (the page was open 5+ s and used, or signed in) · admins, bots, crawlers, data-centre networks and headless browsers not counted · days in Israel time{v?.peopleSince ? ` · people only since ${new Date(v.peopleSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}{v?.countingSince ? ` · counting since ${new Date(v.countingSince).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}{v?.builtAt ? ` · numbers of ${new Date(v.builtAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (every 5 min)` : v?.pending ? ' · first numbers within 5 min of a restart' : ''}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tile('Online now', v?.onlineNow, v ? `people · ${v.onlineSignedIn} signed in · last ${v.onlineWindowMin} min` : undefined, true)}
        <div className="rounded-xl border border-line/60 bg-surface2/50 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">Visitors today</div>
          <div className="flex items-baseline gap-2 mt-1.5 flex-wrap">
            <span className="num text-2xl font-extrabold leading-none text-ink">{v?.today ?? '–'}</span>
            <span className="text-xs text-ink font-semibold">people</span>
            {v?.todayBots != null && <span className="text-[11px] text-faint num" title={(v.botReasons || []).map(r => `${r.n} ${REASON[r.reason] || r.reason}`).join(' · ')}>{v.todayBots} bots / scripts filtered{v.todayAll != null ? ` · ${v.todayAll} callers in all` : ''}</span>}
          </div>
          {old && v?.todayAll != null && <div className="text-[10px] text-faint mt-1 num">old count: {v.todayAll} all API callers (people + bots)</div>}
        </div>
        {tile('Last 7 days', v?.last7, old && v?.last7All != null ? `people · old count ${v.last7All} callers` : 'people')}
        {tile('Last 30 days', v?.last30, v?.returning30 != null ? `${v.returning30} came back on another day${old && v.last30All != null ? ` · old count ${v.last30All}` : ''}` : undefined)}
      </div>
      {v?.kinds && (
        <p className="mt-3 text-sm text-ink num" data-copy-block="visitor-split">
          <span className="font-semibold">Today:</span> {split(v.kinds.today)}
          <span className="block text-[11px] text-faint">7 days: {split(v.kinds.last7)} · 30 days: {split(v.kinds.last30)} — each caller counted once</span>
        </p>
      )}
      {v?.botReasons && v.botReasons.length > 0 && (
        <p className="mt-2 text-[11px] text-faint">{v.botSplit ? `Bots today: ${n0(v.botSplit.crawlers)} crawlers (verified) · ${n0(v.botSplit.swarms)} swarms · ${n0(v.botSplit.other)} other — ` : ''}Filtered today: {v.botReasons.map(r => `${r.n} ${REASON[r.reason] || r.reason}`).join(' · ')}{v.datacentre && !v.datacentre.loaded ? ` · data-centre list: ${v.datacentre.status}` : ''}{old && v.onlineAll != null ? ` · online now, all callers: ${v.onlineAll}` : ''}</p>
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
      {kindDays.some(d => d.k) && (
        <div className="mt-5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-faint mb-1.5">All callers per day</div>
          <div className="flex items-end gap-[3px] h-20">
            {kindDays.map(d => {
              const tot = d.k ? KINDS.reduce((t, x) => t + d.k![x.k], 0) : 0
              return (
                <div key={d.day} className="flex-1 h-full flex flex-col justify-end" title={d.k ? `${d.day}: ${split(d.k)}` : `${d.day}: –`}>
                  <div className="w-full rounded-t-[3px] overflow-hidden flex flex-col-reverse" style={{ height: `${(tot / maxAll) * 100}%`, minHeight: tot ? 2 : 0 }}>
                    {d.k && KINDS.map(x => <div key={x.k} className={x.cls} style={{ height: tot ? `${(d.k![x.k] / tot) * 100}%` : 0 }} />)}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-3 text-[10px] text-faint mt-1.5">
            {KINDS.map(x => <span key={x.k} className="flex items-center gap-1"><span className={`w-2 h-2 rounded-sm ${x.cls}`} />{x.label}</span>)}
          </div>
        </div>
      )}
      {v?.countries && <Countries c={v.countries} geo={v.geo ?? v.countries.geo} />}
      {v?.crawlers && <CrawlersCard c={v.crawlers} />}
      {v?.swarms && <SwarmsCard rows={v.swarms} overrides={v.swarmOverrides || []} reload={() => reloadRef.current()} />}
      {v?.goodBots && <GoodBotsCard rows={v.goodBots} reload={() => reloadRef.current()} />}
      {v?.who && <WhoCard w={v.who} />}
    </section>
  )
}

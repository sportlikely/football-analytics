import { useEffect, useState, type ReactNode } from 'react'
import { useEntityId } from '../components/SlugRoute'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { FavStar } from '../lib/favorites'
import { t as tt, LOCALE } from '../lib/i18n'
import PlayerHeader, { Chip } from '../components/sport/page/PlayerHeader'
import NameLink, { href } from '../components/sport/NameLink'
import { tNodes } from '../lib/tNodes'
import { teamHref as footballTeamOf, playerHref, leagueHref } from '../lib/links'
import { tg } from '../lib/genText'
import CareerTable, { type CareerData, type CareerRow } from '../components/sport/CareerTable'

/**
 * Player page: /player/<API-Football id>. /player/find?name=&team=&c=&n= looks a scorer up first (Football-Data ids).
 */

interface SiteTeam { id: number; name: string; logo: string }
interface Row {
  league: { id?: number; code: string | null; name: string; logo?: string; country?: string; flag?: string }
  team: SiteTeam | null
  position?: string | null
  apps: number
  goals: number
  starts?: number
  minutes?: number
  assists?: number
  rating?: number | null
  yellow?: number
  red?: number
  shots?: number | null
  shotsOn?: number | null
  keyPasses?: number | null
  passAcc?: number | null
  tackles?: number | null
  interceptions?: number | null
  dribbles?: number | null
  duelsWon?: number | null
  duels?: number | null
  saves?: number | null
  conceded?: number | null
  penScored?: number | null
}
interface Season { season: number; label: string; rows: Row[]; totals: { apps: number; goals: number; starts?: number; minutes?: number; assists?: number; yellow?: number; red?: number; rating?: number | null } }
interface PlayerData {
  player: { id: number; name: string; firstname?: string; lastname?: string; age: number | null; birth?: { date?: string; place?: string; country?: string } | null; nationality: string | null; height: string | null; weight: string | null; photo: string }
  team: SiteTeam | null
  position: string | null
  number: number | null
  status: { out: boolean; type?: string; since?: string | null; until?: string | null }
  seasons: Season[]
  sidelined: { type: string; start: string; end: string | null }[]
  international?: (Row & { from: string | null; to: string | null })[]
  internationalTotals?: { team: SiteTeam | null; apps: number; goals: number; assists?: number }[]
  career?: { apps: number; goals: number; assists?: number; minutes?: number; seasons: number; from: string | null } | null
  careerPartial?: boolean
  transfers: { date: string; type: string; from: SiteTeam; to: SiteTeam }[]
  premium: boolean
  locked?: string[]
  stale?: boolean
}

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

function Card({ title, action, children, className = '' }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-surface2/50 border border-line/60 px-3 py-3 text-center">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={`font-display text-2xl font-extrabold num ${accent ? 'text-accent' : 'text-ink'}`}>{value}</div>
    </div>
  )
}

function Lock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

const mon = (d: string) => new Date(d).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' })
const span = (a: string | null, b: string | null) => (a && b ? (mon(a) === mon(b) ? mon(a) : `${mon(a)} – ${mon(b)}`) : '')

const teamHref = (t: SiteTeam) => footballTeamOf('football', t.id, t.name)!

/** fix267: the club career in the shared career table's shape (every sport's player page renders CareerTable) */
function footballCareer(data: PlayerData, full: boolean): CareerData {
  const rows: CareerRow[] = data.seasons.map(s => {
    const clubs = [...new Map(s.rows.filter(r => r.team).map(r => [r.team!.id, r.team!])).values()].map(c => ({ id: c.id, name: c.name, logo: c.logo }))
    return { season: s.label, order: s.season, kind: 'regular', league: null, team: clubs[0] || null, also: clubs.slice(1), gp: null,
      stats: { apps: s.totals.apps, goals: s.totals.goals, assists: s.totals.assists ?? 0, minutes: s.totals.minutes ?? 0 } }
  })
  const best = rows.filter(r => (r.stats.goals as number) > 0).sort((a, b) => (b.stats.goals as number) - (a.stats.goals as number))[0]
  return {
    sport: 'football', group: null,
    columns: [{ key: 'apps', kind: 'int' }, { key: 'goals', kind: 'int', accent: true }, ...(full ? [{ key: 'assists', kind: 'int' as const }, { key: 'minutes', kind: 'int' as const }] : [])],
    parts: ['regular'], rows,
    totals: data.career ? { regular: { gp: 0, stats: { apps: data.career.apps, goals: data.career.goals, assists: data.career.assists ?? 0, minutes: data.career.minutes ?? 0 } } } : {},
    highs: best ? [{ key: 'goals', value: best.stats.goals as number, season: best.season }] : [],
    seasons: data.career?.seasons ?? rows.length, from: data.career?.from ?? null,
    partial: !!data.careerPartial, partialWhy: data.careerPartial ? 'loading' : null, sources: ['API-Football']
  }
}

export default function Player() {
  const id = useEntityId() || ''
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [data, setData] = useState<PlayerData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [si, setSi] = useState(0)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    setSi(0)
    setSlow(false)
    const slowTimer = setTimeout(() => !cancelled && setSlow(true), 3500)
    if (id === 'find') {
      axios
        .get(`${API_URL}/player-page/find`, { params: Object.fromEntries(params.entries()) })
        .then(r => !cancelled && (r.data.pending ? setError(tt("More details soon. This page is being prepared — please check back a little later.")) : nav(playerHref('football', r.data.data.id, params.get('name'))!, { replace: true })))
        .catch(() => !cancelled && setError(tt("We couldn't find {0}'s page yet.", { 0: params.get('name') || 'this player' })))
    } else {
      axios
        .get(`${API_URL}/player-page/${id}`)
        .then(r => !cancelled && (r.data.pending ? setError(tt("More details soon. This page is being prepared — please check back a little later.")) : setData(r.data.data)))
        .catch(e => !cancelled && setError(errorText(e)))
    }
    return () => {
      cancelled = true
      clearTimeout(slowTimer)
    }
  }, [id, params, nav])

  useEffect(() => {
    if (data?.player.name) document.title = tt("{0} · SportLikely", { 0: data.player.name })
  }, [data])

  if (error)
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-muted">{error}</p>
        <Link to="/" className="inline-block mt-4 text-sm font-bold text-accent">{tt("Back to home →")}</Link>
      </div>
    )
  if (!data)
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {slow && (
          <div className="card p-4 text-sm text-muted flex items-center gap-3" role="status">
            <span className="w-4 h-4 rounded-full border-2 border-accent border-t-transparent animate-spin flex-shrink-0" aria-hidden />
            <span>{tt("Putting together his full career, every season and every competition. The first time takes up to a minute; after that it opens instantly.")}</span>
          </div>
        )}
        <div className="card h-44 animate-pulse bg-surface2/60" />
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="card h-20 animate-pulse bg-surface2/60" />)}</div>
      </div>
    )

  const p = data.player
  const season = data.seasons[si]
  const full = data.premium
  const t = season?.totals
  const main = season?.rows[0]
  const gk = /goal/i.test(data.position || '')

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      {/* ---------- header ---------- */}
      <PlayerHeader
        name={p.name}
        photo={p.photo || null}
        teamBadge={data.team ? <img src={data.team.logo} alt={data.team.name} title={data.team.name} className="w-7 h-7 object-contain" /> : undefined}
        chips={[
          data.position ? <Chip>{data.position}</Chip> : null,
          data.number ? <span className="num">#{data.number}</span> : null,
          data.status.out
            ? <Chip tone="out">{tt("Out · {0}", { 0: data.status.type })}{data.status.until ? tt(" until {0}", { 0: fmt(data.status.until) }) : ''}</Chip>
            : <Chip tone="ok">{tt("Available")}</Chip>
        ].filter(Boolean)}
        star={<FavStar label fav={{ kind: 'player', ref: String(p.id), name: p.name, img: p.photo || null, teamName: data.team?.name || null, teamImg: data.team?.logo || null, teamIds: data.team ? [data.team.id] : [] }} />}
        team={data.team ? { name: data.team.name, logo: <img src={data.team.logo} alt="" className="w-5 h-5 object-contain" />, href: teamHref(data.team) } : null}
        facts={([
          p.age !== null ? [tt("Age"), <span className="num">{p.age}</span>] : null,
          p.nationality ? [tt("Nationality"), p.nationality] : null,
          p.height ? [tt("Height"), p.height] : null,
          p.birth?.date ? [tt("Born"), fmt(p.birth.date)] : null
        ] as ([string, ReactNode] | null)[]).filter((x): x is [string, ReactNode] => !!x)}
      />

      {data.stale && <p className="text-xs text-faint">{tt("Showing the last saved copy; live data is paused for today.")}</p>}

      {/* ---------- season stats ---------- */}
      {season ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl font-bold text-ink">{tt("Season")}{' '}{season.label}</h2>
            {data.seasons.length > 1 && (
              <div className="seg max-w-full overflow-x-auto no-scrollbar">
                {data.seasons.map((s, i) => (
                  <button key={s.season} onClick={() => setSi(i)} className={`seg-btn whitespace-nowrap ${si === i ? 'seg-btn-active' : ''}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={tt("Apps")} value={t.apps} />
            <Stat label={tt("Goals")} value={t.goals} accent />
            <Stat label={tt("Assists")} value={full ? t.assists ?? 0 : <span className="text-faint text-base inline-flex items-center gap-1"><Lock /> Pro</span>} />
            <Stat label={tt("Minutes")} value={full ? (t.minutes ?? 0).toLocaleString(LOCALE) : <span className="text-faint text-base inline-flex items-center gap-1"><Lock /> Pro</span>} />
            <Stat label={tt("Rating")} value={full ? t.rating ?? '–' : <span className="text-faint text-base inline-flex items-center gap-1"><Lock /> Pro</span>} />
            <Stat label={tt("Cards")} value={full ? <span><span className="text-draw">{t.yellow ?? 0}</span><span className="text-faint text-base"> / </span><span className="text-loss">{t.red ?? 0}</span></span> : <span className="text-faint text-base inline-flex items-center gap-1"><Lock /> Pro</span>} />
          </div>

          <Card title={tt("By competition")}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-[11px] text-faint">
                    <th className="text-start font-medium py-1.5 ps-2">{tt("Competition")}</th>
                    <th className="text-start font-medium py-1.5">{tt("Team")}</th>
                    <th className="text-end font-medium py-1.5 num w-12">{tt("Apps")}</th>
                    {full && <th className="text-end font-medium py-1.5 num w-14">{tt("Min")}</th>}
                    <th className="text-end font-medium py-1.5 num w-12">{tt("Goals")}</th>
                    {full && <th className="text-end font-medium py-1.5 num w-12">{tt("Ast")}</th>}
                    {full && <th className="text-end font-medium py-1.5 num w-14 pe-2">{tt("Rating")}</th>}
                  </tr>
                </thead>
                <tbody>
                  {season.rows.map((r, i) => (
                    <tr key={i} className="border-t border-line/50">
                      <td className="py-2 ps-2">
                        <span className="flex items-center gap-2 min-w-0">
                          {r.league.logo && <img src={r.league.logo} alt="" className="w-5 h-5 object-contain bg-white/90 rounded p-0.5" />}
                          {r.league.code ? (
                            <Link to={leagueHref('football', r.league.code, r.league.name)!} className="truncate text-ink hover:text-accent">{r.league.name}</Link>
                          ) : (
                            <span className="truncate text-ink">{r.league.name}</span>
                          )}
                        </span>
                      </td>
                      <td className="py-2">
                        {r.team && (
                          <Link to={teamHref(r.team)} className="flex items-center gap-2 min-w-0 text-muted hover:text-ink">
                            <img src={r.team.logo} alt="" className="w-4 h-4 object-contain" />
                            <span className="truncate">{r.team.name}</span>
                          </Link>
                        )}
                      </td>
                      <td className="py-2 text-end num text-muted">{r.apps}</td>
                      {full && <td className="py-2 text-end num text-muted">{r.minutes}</td>}
                      <td className="py-2 text-end num font-bold text-ink">{r.goals}</td>
                      {full && <td className="py-2 text-end num text-muted">{r.assists}</td>}
                      {full && (
                        <td className={`py-2 pe-2 text-end num font-bold ${r.rating ? (r.rating >= 7.3 ? 'text-win' : r.rating >= 6.9 ? 'text-accent' : 'text-draw') : 'text-faint'}`}>{r.rating ?? '–'}</td>
                      )}
                    </tr>
                  ))}
                  {season.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-4 text-center text-faint">{tt("No games this season yet.")}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {full && main && (
            <Card title={tNodes("Detail · {0}", { 0: <NameLink to={href.league(main.league.code || main.league.id, main.league.name)}>{main.league.name}</NameLink> })}>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                {gk ? (
                  <>
                    <Stat label={tt("Saves")} value={main.saves ?? '–'} />
                    <Stat label={tt("Conceded")} value={main.conceded ?? '–'} />
                    <Stat label={tt("Pass accuracy")} value={main.passAcc != null ? `${main.passAcc}%` : '–'} />
                    <Stat label={tt("Duels won")} value={main.duels ? `${main.duelsWon ?? 0}/${main.duels}` : '–'} />
                  </>
                ) : (
                  <>
                    <Stat label={tt("Shots (on target)")} value={main.shots != null ? `${main.shots} (${main.shotsOn ?? 0})` : '–'} />
                    <Stat label={tt("Key passes")} value={main.keyPasses ?? '–'} />
                    <Stat label={tt("Tackles + interceptions")} value={main.tackles != null || main.interceptions != null ? (main.tackles || 0) + (main.interceptions || 0) : '–'} />
                    <Stat label={tt("Duels won")} value={main.duels ? `${main.duelsWon ?? 0}/${main.duels}` : '–'} />
                  </>
                )}
              </div>
            </Card>
          )}
        </>
      ) : (
        <div className="card p-6 text-sm text-muted">{tt("No season data for this player yet.")}</div>
      )}

      {data.seasons.length > 0 && (
        <Card
          title={tt("Club career")}
          action={data.career ? <span className="text-[11px] text-faint">{tt("{n, plural, one {# season} other {# seasons}}", { n: data.career.seasons })}{data.career.from ? tt(" since {0}", { 0: data.career.from }) : ''}</span> : undefined}
        >
          {/* fix267: the shared career table of every sport (tap a season to see it in detail) */}
          <CareerTable data={footballCareer(data, full)} teamHref={x => teamHref({ id: x.id!, name: x.name, logo: x.logo || '' })}
            onRow={(_r, i) => { setSi(i); window.scrollTo({ top: 0, behavior: 'smooth' }) }} active={si} wide={360}
            note={tt("Official club games in every competition (friendlies left out). Tap a season to see it in detail.")} />
        </Card>
      )}

      {data.international && data.international.length > 0 && (
        <Card title={tt("National team")}>
          {data.internationalTotals && data.internationalTotals.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {data.internationalTotals.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-2 rounded-xl bg-surface2/60 border border-line/60 px-3 py-2 text-sm">
                  {t.team && <img src={t.team.logo} alt="" className="w-5 h-5 object-contain" />}
                  {t.team ? <NameLink to={teamHref(t.team)} className="font-semibold text-ink">{t.team.name}</NameLink> : <span className="font-semibold text-ink">{tt("National team")}</span>}
                  <span className="text-muted num">{tt("{0} caps · {1} goals", { 0: t.apps, 1: t.goals })}{full && t.assists !== undefined ? tt(" · {0} assists", { 0: t.assists }) : ''}</span>
                </span>
              ))}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-[11px] text-faint">
                  <th className="text-start font-medium py-1.5 ps-2">{tt("Competition")}</th>
                  <th className="text-start font-medium py-1.5">{tt("Played")}</th>
                  <th className="text-end font-medium py-1.5 num w-12">{tt("Apps")}</th>
                  <th className="text-end font-medium py-1.5 num w-12">{tt("Goals")}</th>
                  {full && <th className="text-end font-medium py-1.5 num w-12 pe-2">{tt("Ast")}</th>}
                </tr>
              </thead>
              <tbody>
                {data.international.map((r, i) => (
                  <tr key={i} className="border-t border-line/50">
                    <td className="py-2 ps-2">
                      <span className="flex items-center gap-2 min-w-0">
                        {r.team && <img src={r.team.logo} alt="" className="w-4 h-4 object-contain" />}
                        <NameLink to={href.league(r.league.code || r.league.id, r.league.name)} className="truncate text-ink">{r.league.name}</NameLink>
                        {r.team && <span className="text-[11px] text-faint truncate">· <NameLink to={teamHref(r.team)}>{r.team.name}</NameLink></span>}
                      </span>
                    </td>
                    <td className="py-2 text-[11px] text-faint whitespace-nowrap">{span(r.from, r.to)}</td>
                    <td className="py-2 text-end num text-muted">{r.apps}</td>
                    <td className="py-2 text-end num font-bold text-ink">{r.goals}</td>
                    {full && <td className="py-2 pe-2 text-end num text-muted">{r.assists}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-faint">{tt("His whole international career by tournament, friendlies included. Not counted in the club seasons.")}</p>
        </Card>
      )}

      {!full && data.locked && (
        <div className="rounded-3xl p-6 border border-home/40 bg-[linear-gradient(150deg,#1B2A55_0%,#101624_70%)] text-[#EEF1F6] flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="font-display text-lg font-bold">{tt("Every stat with Premium")}</div>
            <p className="text-sm text-[#C9D0DB]">{data.locked.map(tg).join(' · ')}</p>
          </div>
          <Link to="/premium" className="h-11 px-6 rounded-2xl bg-[#C8FF3D] text-[#07090D] font-extrabold grid place-items-center">{tt("Go Premium")}</Link>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 items-start">
        {data.transfers.length > 0 && (
          <Card title={tt("Career moves")}>
            <ul className="space-y-1">
              {data.transfers.map((tr, i) => (
                <li key={i} className="flex items-center gap-3 py-2 border-b border-line/50 last:border-0 text-sm">
                  <span className="w-16 sm:w-20 flex-shrink-0 text-[11px] text-faint">{fmt(tr.date)}</span>
                  <Link to={teamHref(tr.from)} className="flex items-center gap-1.5 min-w-0 text-muted hover:text-ink">
                    <img src={tr.from.logo} alt="" className="w-4 h-4 object-contain flex-shrink-0" />
                    <span className="truncate">{tr.from.name}</span>
                  </Link>
                  <span aria-hidden className="text-faint flex-shrink-0 rtl-flip">→</span>
                  <Link to={teamHref(tr.to)} className="flex items-center gap-1.5 min-w-0 font-semibold text-ink hover:text-accent">
                    <img src={tr.to.logo} alt="" className="w-4 h-4 object-contain flex-shrink-0" />
                    <span className="truncate">{tr.to.name}</span>
                  </Link>
                  <span className="ms-auto text-[11px] text-faint whitespace-nowrap">{tg(tr.type)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {full && data.sidelined.length > 0 && (
          <Card title={tt("Injuries & suspensions")}>
            <ul className="space-y-1">
              {data.sidelined.map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2 border-b border-line/50 last:border-0 text-sm">
                  <span className="text-ink truncate">{tg(s.type)}</span>
                  <span className="text-[11px] text-faint whitespace-nowrap">
                    {fmt(s.start)} – {s.end ? fmt(s.end) : tt("now")}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  )
}

import LeaguePage, { LCard } from '../components/sport/page/LeaguePage'
import { useEntityId } from '../components/SlugRoute'
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { doubleChance, shortTeam, type Prediction } from '../lib/predict'
import { DcBlock, DcLine } from '../components/DcPick'
import { isCovered, revealMatch, useRevealState } from '../lib/reveal'
import RecentResults from '../components/RecentResults'
import { t as tt, LOCALE } from '../lib/i18n'
import { hubFor, hubHref } from '../lib/hubs'
import { footballTeamHref } from '../lib/teamLink'
import NameLink, { href } from '../components/sport/NameLink'
import SeasonForecast from '../components/sport/forecast/SeasonForecast'
import { NewsPic } from '../components/NewsList'
import { playerHref, leagueHref, matchHref } from '../lib/links'

/**
 * League page: /league/<code> (football-data codes like PL, API-Football codes like AF140).
 * Table, upcoming fixtures with our picks, latest results with hit/miss, top scorers & assists, and v3's record here.
 * Everything comes from endpoints the site already has, so it costs almost no extra API calls.
 */

interface Team { id: number; name: string; shortName?: string; tla?: string; crest?: string }
interface Comp { code: string; name: string; emblem?: string; area?: { name?: string; flag?: string } }
interface Match {
  id: number
  utcDate: string
  status: string
  competition: Comp
  homeTeam: Team
  awayTeam: Team
  prediction?: Prediction | null
  predictions?: Prediction[]
}
interface StandingRow {
  position: number
  team: Team
  playedGames: number
  won: number
  draw: number
  lost: number
  goalsFor?: number
  goalsAgainst?: number
  goalDifference: number
  points: number
  form?: string | null
}
interface Scorer {
  player: { id: number; name: string; nationality?: string }
  team: Team
  goals: number | null
  assists: number | null
  penalties: number | null
  playedMatches?: number | null
}
interface Edition {
  competition: Comp | null
  season: number | null
  winner: Team | null
  matches: (Match & { round?: string | null; score?: { fullTime: { home: number | null; away: number | null } }; penalties?: { home: number; away: number } | null })[]
}
interface Record_ { n: number; hitRate: number | null }

const MAIN = ['v3-mix', 'grid-v3', 'elo-intl', 'elo-euro']
const LIVE = new Set(['IN_PLAY', 'PAUSED', 'LIVE'])
const tn = (t: Team) => t.shortName || t.name
interface NewsItem { title: string; link: string; source: string; published: string | null; image?: string | null }
const ago = (iso: string | null) => {
  if (!iso) return ''
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return m < 60 ? tt("{0} min ago", { 0: m }) : m < 1440 ? tt("{0} h ago", { 0: Math.round(m / 60) }) : tt("{0} d ago", { 0: Math.round(m / 1440) })
}
const mainPred = (m: Match) => m.predictions?.find(p => MAIN.includes(p.model)) || m.prediction || null
// the years the games were played in ("2026", or "2024–25"), not the provider's season number
const editionYears = (e: Edition) => {
  const ys = e.matches.map(m => new Date(m.utcDate).getFullYear()).filter(Boolean)
  if (!ys.length) return e.season ? String(e.season) : ''
  const a = Math.min(...ys), b = Math.max(...ys)
  return a === b ? String(a) : `${a}–${String(b).slice(2)}`
}
const hasPct = (p: Prediction | null): p is Prediction => !!p && !p.locked && typeof p.home === 'number'
// fix229: an API-Football player opens his page; a Football-Data.org scorer (no page id) opens the search with his name
const scorerHref = (s: Scorer, code: string) =>
  code.startsWith('AF') || s.player.id >= 1_000_000_000
    ? playerHref('football', s.player.id, s.player.name)!
    : `/search?q=${encodeURIComponent(s.player.name)}`
const teamLink = (t: Team, code: string) => footballTeamHref(t.id, t.name, code)

const Card = LCard

function Crest({ team, size = 20 }: { team: Team; size?: number }) {
  return team.crest ? (
    <img src={team.crest} alt="" width={size} height={size} className="object-contain flex-shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-full bg-surface2 flex-shrink-0 grid place-items-center text-[9px] text-faint" style={{ width: size, height: size }}>
      {team.tla || tn(team).slice(0, 2).toUpperCase()}
    </span>
  )
}

const FORM_BG: Record<string, string> = { W: 'bg-win', D: 'bg-draw', L: 'bg-loss' }

// Leagues we get from Football-Data.org (fixtures, predictions and results are filed under these codes): the
// API-Football code of the same league (from player pages) opens the main page instead
// fix176: Brazil Série A lives under AF71 (it carries the predictions): BSA opens AF71, never the other way round
const FD_OF: Record<string, string> = { AF39: 'PL', AF40: 'ELC', AF140: 'PD', AF135: 'SA', AF78: 'BL1', AF61: 'FL1', AF88: 'DED', AF94: 'PPL', AF2: 'CL', BSA: 'AF71' }

export default function LeagueRoute() {
  const code = useEntityId() || ''
  const fd = FD_OF[code.toUpperCase()]
  if (fd) return <Navigate to={leagueHref('football', fd)!} replace />
  return <League key={code.toUpperCase()} />
}

function League() {
  const raw = useEntityId() || ''
  const code = raw.toUpperCase()
  const [comp, setComp] = useState<Comp | null>(null)
  const [tables, setTables] = useState<{ type: string; group?: string | null; table: StandingRow[] }[] | null>(null)
  const [scorers, setScorers] = useState<Scorer[] | null>(null)
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [record, setRecord] = useState<Record_ | null>(null)
  const [edition, setEdition] = useState<Edition | null>(null)
  const [leaders, setLeaders] = useState<'goals' | 'assists'>('goals')
  const [news, setNews] = useState<NewsItem[] | null>(null)
  useRevealState()

  useEffect(() => {
    let cancelled = false
    setComp(null)
    setTables(null)
    setScorers(null)
    setMatches(null)
    setRecord(null)
    setEdition(null)
    setNews(null)
    axios
      .get(`${API_URL}/news`, { params: { league: code, limit: 12 } })
      .then(r => !cancelled && setNews(r.data.data || []))
      .catch(() => !cancelled && setNews([]))
    // competitions from our second data source: the latest played edition (a cup between editions is never empty)
    // fix176: EC / WC between editions — the latest edition from the second source
    if (/^AF\d+$/.test(code) || code === 'EC' || code === 'WC') {
      axios
        .get(`${API_URL}/leagues/${code}/results`)
        .then(r => {
          if (cancelled) return
          const d: Edition | null = r.data.data
          setEdition(d)
          const c = d?.competition
          if (c?.name) setComp(prev => (prev ? { ...prev, area: prev.area || c.area } : { ...c, code }))
        })
        .catch(() => undefined)
    }
    axios
      .get(`${API_URL}/leagues/${code}/standings`)
      .then(r => {
        if (cancelled) return
        setTables(r.data.data?.standings || [])
        const c = r.data.data?.competition
        if (c?.name) setComp(prev => (prev ? { ...prev, area: prev.area || r.data.data?.area } : { code, name: c.name, emblem: c.emblem, area: r.data.data?.area }))
      })
      .catch(() => !cancelled && setTables([]))
    axios
      .get(`${API_URL}/leagues/${code}/scorers`, { params: { limit: 40 } })
      .then(r => !cancelled && setScorers(r.data.data?.scorers || []))
      .catch(() => !cancelled && setScorers([]))
    axios
      .get(`${API_URL}/matches/upcoming`, { params: { days: 30 } })
      .then(r => {
        if (cancelled) return
        const list = ((r.data.data || []) as Match[]).filter(m => m.competition.code === code)
        setMatches(list)
        if (list[0]) setComp(prev => ({ ...list[0].competition, area: list[0].competition.area || prev?.area }))
      })
      .catch(() => !cancelled && setMatches([]))
    axios
      .get(`${API_URL}/public/results`, { params: { days: 365, competition: code, limit: 1 } })
      .then(r => !cancelled && setRecord(r.data.data?.record || null))
      .catch(() => undefined)
    // name and emblem for competitions with no table and no fixtures right now
    axios
      .get(`${API_URL}/leagues`)
      .then(r => {
        if (cancelled) return
        const c = (r.data.data || []).find((x: any) => String(x.code).toUpperCase() === code)
        if (c) setComp(prev => (prev ? { ...prev, area: prev.area || c.area } : { code, name: c.name, emblem: c.emblem, area: c.area }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [code])

  useEffect(() => {
    if (comp?.name) document.title = tt("{0} · SportLikely", { 0: comp.name })
  }, [comp])

  const totals = useMemo(() => {
    if (!tables) return []
    const t = tables.filter(x => x.type === 'TOTAL')
    return t.length ? t : tables
  }, [tables])

  const top = useMemo(() => {
    if (!scorers) return []
    const key = leaders === 'goals' ? 'goals' : 'assists'
    const other = leaders === 'goals' ? 'assists' : 'goals'
    return [...scorers].filter(s => (s[key] || 0) > 0).sort((a, b) => (b[key] || 0) - (a[key] || 0) || (b[other] || 0) - (a[other] || 0)).slice(0, 15)
  }, [scorers, leaders])

  const hasForm = totals.some(t => t.table.some(r => r.form))
  const upcoming = (matches || []).filter(m => !LIVE.has(m.status) && !['FINISHED', 'AWARDED', 'CANCELLED'].includes(m.status)).slice(0, 12)
  const live = (matches || []).filter(m => LIVE.has(m.status))

  const hub = code ? hubFor('football', code) : null
  return (
    <LeaguePage
      logo={comp?.emblem || null}
      country={{ flag: comp?.area?.flag || null, name: comp?.area?.name || tt("League") }}
      name={comp?.name || code}
      hub={hub ? { to: hubHref(hub.slug), label: tt("This week's predictions →") } : null}
      fav={comp?.name && code ? { kind: 'league', ref: code, code, name: comp.name, img: comp.emblem || null } : null}
      record={record && record.hitRate !== null && record.n > 0 ? { hitRate: record.hitRate, n: record.n } : null}
      forecast={code ? <SeasonForecast sport="football" code={code} teamHref={(id, name) => href.team(Number(id), code, name) || '/football'} /> : null}
      left={<>
          <Card title={tt("Table")}>
            {!tables ? (
              <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-7 rounded-lg bg-surface2/60 animate-pulse" />)}</div>
            ) : totals.length === 0 ? (
              <p className="text-sm text-faint">{tt("No league table here: it's a knockout cup, friendlies, or a tournament that isn't on right now.")}</p>
            ) : (
              <div className="space-y-5">
                {totals.map((t, i) => (
                  <div key={i} className="overflow-x-auto">
                    {t.group && totals.length > 1 && <div className="label pb-2">{t.group.replace(/_/g, ' ')}</div>}
                    <table className="w-full text-sm min-w-[520px]">
                      <thead>
                        <tr className="text-[11px] text-faint">
                          <th className="text-left font-medium py-1.5 pl-2 w-8">#</th>
                          <th className="text-left font-medium py-1.5">{tt("Team")}</th>
                          <th className="text-right font-medium py-1.5 num w-9">P</th>
                          <th className="text-right font-medium py-1.5 num w-9">W</th>
                          <th className="text-right font-medium py-1.5 num w-9">D</th>
                          <th className="text-right font-medium py-1.5 num w-9">L</th>
                          <th className="text-right font-medium py-1.5 num w-16 hidden sm:table-cell">{tt("Goals")}</th>
                          <th className="text-right font-medium py-1.5 num w-10">{tt("GD")}</th>
                          <th className="text-right font-medium py-1.5 num w-10 pr-2">{tt("Pts")}</th>
                          {hasForm && <th className="text-center font-medium py-1.5 w-[104px] hidden md:table-cell" title={tt("Last 5 league games, latest on the right")}>{tt("Form")}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {t.table.map(r => (
                          <tr key={r.team.id} className="border-t border-line/50 hover:bg-surface2/40">
                            <td className="py-2 pl-2 num text-faint">{r.position}</td>
                            <td className="py-2">
                              <Link to={teamLink(r.team, code)} className="flex items-center gap-2 min-w-0 hover:text-accent">
                                <Crest team={r.team} />
                                <span className="truncate font-medium text-ink">{tn(r.team)}</span>
                              </Link>
                            </td>
                            <td className="py-2 text-right num text-muted">{r.playedGames}</td>
                            <td className="py-2 text-right num text-muted">{r.won}</td>
                            <td className="py-2 text-right num text-muted">{r.draw}</td>
                            <td className="py-2 text-right num text-muted">{r.lost}</td>
                            <td className="py-2 text-right num text-muted hidden sm:table-cell">{r.goalsFor ?? '–'}:{r.goalsAgainst ?? '–'}</td>
                            <td className={`py-2 text-right num ${r.goalDifference > 0 ? 'text-win' : r.goalDifference < 0 ? 'text-loss' : 'text-muted'}`}>
                              {r.goalDifference > 0 ? '+' : ''}
                              {r.goalDifference}
                            </td>
                            <td className="py-2 pr-2 text-right num font-bold text-ink">{r.points}</td>
                            {hasForm && <td className="py-2 hidden md:table-cell">
                              <span className="flex justify-center gap-1">
                                {String(r.form || '')
                                  .split(/[,\s]*/)
                                  .filter(x => FORM_BG[x])
                                  // both providers list the newest result first: show the last 5 with the newest on the right
                                  .slice(0, 5)
                                  .reverse()
                                  .map((x, j) => (
                                    <span key={j} className={`w-4 h-4 rounded-[4px] grid place-items-center text-[9px] font-extrabold text-bg ${FORM_BG[x]}`}>{x}</span>
                                  ))}
                              </span>
                            </td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* fix176: no player stats for this league (provider): no empty scorers card */}
          {!(scorers && scorers.length === 0) && (
          <Card
            title={leaders === 'goals' ? tt("Top scorers") : tt("Top assists")}
            action={
              <div className="seg">
                {(['goals', 'assists'] as const).map(k => (
                  <button key={k} onClick={() => setLeaders(k)} className={`seg-btn ${leaders === k ? 'seg-btn-active' : ''}`}>
                    {k === 'goals' ? 'Goals' : 'Assists'}
                  </button>
                ))}
              </div>
            }
          >
            {!scorers ? (
              <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-8 rounded-lg bg-surface2/60 animate-pulse" />)}</div>
            ) : top.length === 0 ? (
              <p className="text-sm text-faint">{tt("No data yet this season.")}</p>
            ) : (
              <ol className="space-y-1">
                {top.map((s, i) => {
                  const v = leaders === 'goals' ? s.goals || 0 : s.assists || 0
                  const max = leaders === 'goals' ? top[0].goals || 1 : top[0].assists || 1
                  return (
                    <li key={s.player.id} className="flex items-center gap-3 py-1.5">
                      <span className="w-5 text-xs num text-faint text-right">{i + 1}</span>
                      <Crest team={s.team} size={22} />
                      <span className="min-w-0 flex-1">
                        <Link to={scorerHref(s, code)} className="block text-sm font-semibold text-ink truncate hover:text-accent">{s.player.name}</Link>
                        <span className="block h-1.5 mt-1 rounded-full bg-surface2">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${(v / max) * 100}%` }} />
                        </span>
                      </span>
                      <NameLink to={teamLink(s.team, code)} className="text-[11px] text-faint w-28 truncate text-right hidden sm:block">{tn(s.team)}</NameLink>
                      <span className="font-display font-bold text-ink num w-6 text-right">{v}</span>
                    </li>
                  )
                })}
                {leaders === 'assists' && <li className="text-[10px] text-faint pt-1">{tt("Assists among the league's top-40 scorers list.")}</li>}
              </ol>
            )}
          </Card>
          )}
      </>}
      right={<>
          {live.length > 0 && (
            <Card title={tt("Live now")}>
              <ul className="space-y-1">
                {live.map(m => (
                  <li key={m.id}>
                    <Link to={matchHref('football', m.id, { home: m.homeTeam.name || m.homeTeam.shortName, away: m.awayTeam.name || m.awayTeam.shortName, homeId: m.homeTeam.id, awayId: m.awayTeam.id, date: m.utcDate })!} state={{ match: m }} className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-surface2/60 text-sm">
                      <span className="w-2 h-2 rounded-full bg-live animate-pulseDot" />
                      <span className="truncate flex-1 font-semibold">{tn(m.homeTeam)} – {tn(m.awayTeam)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title={tt("Next fixtures")} action={<Link to={`/football/matches?league=${code}`} className="text-xs font-bold text-accent">All →</Link>}>
            {!matches ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 rounded-xl bg-surface2/60 animate-pulse" />)}</div>
            ) : upcoming.length === 0 ? (
              <p className="text-sm text-faint">{tt("No fixtures in the next 30 days.")}</p>
            ) : (
              <ul className="max-h-[430px] overflow-y-auto overscroll-contain pr-1 space-y-1">
                {upcoming.map(m => (
                  <li key={m.id}>
                    <FixtureRow m={m} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {(news === null || news === undefined || news.length > 0) && (
          <Card title={tt("{0} news", { 0: comp?.name || tt("League") })}>
            {!news ? (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-16 rounded-xl bg-surface2/60 animate-pulse" />)}</div>
            ) : news.length === 0 ? (
              <p className="text-sm text-faint">{tt("No news about this league in the last two weeks.")}</p>
            ) : (
              <ul className="max-h-[520px] overflow-y-auto overscroll-contain pr-1 space-y-1">
                {news.map(n => (
                  <li key={n.link}>
                    <a href={n.link} target="_blank" rel="noreferrer" className="flex gap-3 p-2 rounded-xl hover:bg-surface2/60 transition-colors">
                      <span className="w-20 h-14 rounded-lg overflow-hidden bg-surface2 flex-shrink-0 grid place-items-center">
                        <NewsPic n={n} />
                      </span>
                      <span className="min-w-0 flex flex-col gap-1">
                        <span className="text-[13px] font-bold leading-snug text-ink break-words">{n.title}</span>
                        <span className="text-[11px] text-faint">{n.source}{n.published ? ` · ${ago(n.published)}` : ''}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          )}

          {/* fix176: between editions — where the next one is being decided */}
          {(code === 'EC' || code === 'WC') && (
            <Card title={tt("Next edition")}>
              <Link to={leagueHref('football', code === 'EC' ? 'AF960' : 'AF32')!} className="text-sm font-bold text-accent">{code === 'EC' ? tt("European Championship qualifiers →") : tt("World Cup qualifiers →")}</Link>
            </Card>
          )}
          {edition && edition.matches.length > 0 && (
            <Card
              title={tt("Latest edition{0}", { 0: editionYears(edition) ? ` · ${editionYears(edition)}` : '' })}
              action={edition.winner ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
                  <span aria-hidden>🏆</span>
                  {edition.winner.crest && <img src={edition.winner.crest} alt="" className="w-4 h-4 object-contain" />}
                  {tn(edition.winner)}
                </span>
              ) : undefined}
            >
              <ul className="max-h-[430px] overflow-y-auto overscroll-contain pr-1 divide-y divide-line/50">
                {edition.matches.map(m => {
                  const ft = m.score?.fullTime
                  return (
                    <li key={m.id}>
                      <Link to={matchHref('football', m.id, { home: m.homeTeam.name || m.homeTeam.shortName, away: m.awayTeam.name || m.awayTeam.shortName, homeId: m.homeTeam.id, awayId: m.awayTeam.id, date: m.utcDate })!} state={{ match: m }} className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-surface2/60 text-sm">
                        <span className="w-14 text-[11px] text-faint">{new Date(m.utcDate).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">
                            <span className="text-ink font-semibold">{tn(m.homeTeam)}</span> <span className="num font-bold text-ink">{ft?.home ?? '–'}–{ft?.away ?? '–'}</span> <span className="text-ink font-semibold">{tn(m.awayTeam)}</span>
                          </span>
                          <span className="block text-[11px] text-faint truncate">{m.round}{m.penalties ? tt(" · pens {0}–{1}", { 0: m.penalties.home, 1: m.penalties.away }) : ''}</span>
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          <section className="card p-3">
            <RecentResults code={code} limit={50} days={120} compact large listClass="max-h-[430px] overflow-y-auto overscroll-contain pr-1" />
          </section>
      </>}
    />
  )
}

function FixtureRow({ m }: { m: Match }) {
  const p = mainPred(m)
  const pct = hasPct(p)
  const covered = pct && isCovered(m.id, m.status, true)
  const k = p ? p.pick || (pct ? (p.home >= p.draw && p.home >= p.away ? 'H' : p.away >= p.draw ? 'A' : 'D') : null) : null
  const name = k === 'H' ? tn(m.homeTeam) : k === 'A' ? tn(m.awayTeam) : k === 'D' ? 'Draw' : null
  const color = k === 'H' ? 'text-home' : k === 'A' ? 'text-away' : 'text-draw'
  const val = pct && k ? (k === 'H' ? p.home : k === 'A' ? p.away : p.draw) : null
  // fix120: our pick is the double chance
  const dc = doubleChance(p)
  return (
    <Link to={matchHref('football', m.id, { home: m.homeTeam.name || m.homeTeam.shortName, away: m.awayTeam.name || m.awayTeam.shortName, homeId: m.homeTeam.id, awayId: m.awayTeam.id, date: m.utcDate }) ?? ''} state={{ match: m }} className="flex items-center gap-2 sm:gap-3 px-1 sm:px-2 py-2 rounded-xl hover:bg-surface2/60 transition-colors">
      <span className="w-10 sm:w-12 flex-shrink-0 text-center">
        <span className="block text-[10px] text-faint">{new Date(m.utcDate).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric' })}</span>
        <span className="block text-xs font-bold text-ink num">{new Date(m.utcDate).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center gap-1.5 text-[13px] sm:text-sm"><Crest team={m.homeTeam} size={16} /><span className="truncate text-ink">{tn(m.homeTeam)}</span></span>
        <span className="flex items-center gap-1.5 text-[13px] sm:text-sm"><Crest team={m.awayTeam} size={16} /><span className="truncate text-ink">{tn(m.awayTeam)}</span></span>
      </span>
      <span className="flex-shrink-0 text-right flex flex-col items-end">
        {covered ? (
          <button
            onClick={e => {
              e.preventDefault()
              revealMatch(m.id)
            }}
            className="text-[11px] font-bold text-bg bg-accent px-2.5 py-1 rounded-full"
          >
            {tt("Reveal")}</button>
        ) : dc ? (
          <>
            {/* fix127: 1 · X · 2 + our double chance in words; locked: the words only */}
            {pct && dc.pct !== null ? <DcBlock p={p} home={shortTeam(m.homeTeam)} away={shortTeam(m.awayTeam)} /> : <DcLine code={dc.code} pct={null} home={shortTeam(m.homeTeam)} away={shortTeam(m.awayTeam)} />}
          </>
        ) : name ? (
          <>
            <span className="block text-[10px] text-faint">{tt("Pick")}</span>
            <span className={`block text-xs font-bold truncate ${color}`}>
              {name}
              {val !== null && <span className="num"> {Math.round(val)}%</span>}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-faint">–</span>
        )}
      </span>
    </Link>
  )
}

import TeamPage, { TCard } from '../components/sport/page/TeamPage'
import { useEntityId } from '../components/SlugRoute'
import { useEffect, useMemo, useState } from 'react'
import { useNews, NewsRows } from '../components/NewsList'
import { Link, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { TeamAnalysisCard, TeamRecordCard, type Analysis } from '../components/TeamAnalysis'
import { nameKey } from '../lib/favorites'
import { t, LOCALE } from '../lib/i18n'
import { slModel } from '../lib/modelNames'
import NameLink, { href } from '../components/sport/NameLink'
import TeamForecast from '../components/sport/forecast/TeamForecast'
import { teamHref, playerHref, matchHref } from '../lib/links'
import { TeamDifficulty } from '../components/sport/game/GameExtras'
import PlayerPhoto from '../components/sport/PlayerPhoto'
import { officialPhoto } from '../lib/photoSources'
import { MaybeLink } from '../components/MaybeLink'

interface Side { id: number; name: string; logo: string }
interface Fixture { matchId: number | null; date: string; status: string; comp: string; compCode?: string | null; home: Side; away: Side; hg: number | null; ag: number | null }
interface Player {
  id: number; name: string; number: number | null; pos: string; age: number | null; photo: string | null
  apps?: number | null; minutes?: number | null; goals?: number | null; assists?: number | null; yellow?: number | null; red?: number | null; rating?: number | null
  /** fix176: national teams — the player's club this season (our stored club stats) */
  club?: { id: number; name: string | null; season: number; apps: number | null; goals: number | null; assists: number | null }
  /** fix177: the provider has no page for this player (no link) */
  noPage?: boolean
}
interface Row { rank: number; id: number; name: string; logo: string; played: number; gd: number; points: number; me: boolean }
interface TeamData {
  team: { id: number; name: string; logo: string; country: string; founded: number | null; national: boolean }
  venue: { name: string; city: string; capacity: number } | null
  league: { id?: number; name: string; logo: string; season: number } | null
  standing: { rank: number; points: number; played: number; won: number; drawn: number; lost: number; gf: number; ga: number; rows: Row[] } | null
  form: ('W' | 'D' | 'L')[]
  last: Fixture[]
  next: Fixture[]
  squad: Player[]
  scorers: Leader[]
  assists: Leader[]
  premium: boolean
  locked?: string[]
  builtAt?: string
  stale?: boolean
  analysis?: Analysis | null
}

interface Leader { id?: number; name: string; value: number; detail?: string }

const FORM_BG = { W: 'bg-win', D: 'bg-draw', L: 'bg-loss' }
const POS_LABEL: Record<string, string> = { Goalkeeper: t('Goalkeepers'), Defender: t('Defenders'), Midfielder: t('Midfielders'), Attacker: t('Forwards') }
const DONE = new Set(['FT', 'AET', 'PEN'])

const Card = TCard

function Pro() {
  return <span className="text-[10px] font-extrabold text-bg bg-accent px-1.5 py-0.5 rounded-full">{t("PRO")}</span>
}

function FixtureRow({ f, teamId }: { f: Fixture; teamId: number }) {
  const done = DONE.has(f.status) && f.hg !== null
  const mine = f.home.id === teamId ? (f.hg ?? 0) - (f.ag ?? 0) : (f.ag ?? 0) - (f.hg ?? 0)
  const res = !done ? null : mine > 0 ? 'W' : mine < 0 ? 'L' : 'D'
  const body = (
    <div className="flex items-center gap-3 py-2.5 border-b border-line/50 last:border-0">
      <span className="w-14 text-[11px] text-faint">{new Date(f.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm"><img src={f.home.logo} alt="" className="w-4 h-4 object-contain" /><span className={`truncate ${f.home.id === teamId ? 'font-bold text-ink' : 'text-muted'}`}>{f.home.name}</span></span>
        <span className="flex items-center gap-2 text-sm"><img src={f.away.logo} alt="" className="w-4 h-4 object-contain" /><span className={`truncate ${f.away.id === teamId ? 'font-bold text-ink' : 'text-muted'}`}>{f.away.name}</span></span>
      </span>
      <span className="text-[11px] text-faint hidden sm:block w-40 truncate text-right">{f.compCode && !f.matchId ? <NameLink to={href.league(f.compCode)}>{f.comp}</NameLink> : f.comp}</span>
      {done ? (
        <span className="flex items-center gap-2">
          <span className="font-display font-bold text-sm num">{f.hg}–{f.ag}</span>
          <span className={`w-6 h-6 rounded-md grid place-items-center text-[11px] font-extrabold text-bg ${FORM_BG[res!]}`}>{res}</span>
        </span>
      ) : (
        <span className="text-xs text-muted whitespace-nowrap">{new Date(f.date).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
      )}
    </div>
  )
  return f.matchId ? <MaybeLink to={matchHref('football', f.matchId, { home: f.home.name, away: f.away.name, homeId: f.home.id, awayId: f.away.id, date: f.date })} className="block hover:bg-surface2/40 rounded-lg">{body}</MaybeLink> : body
}

function Leaders({ items, label, squad }: { items: Leader[]; label: string; squad: Player[] }) {
  const max = Math.max(1, ...items.map(i => i.value))
  if (!items.length) return <p className="text-sm text-faint">{t("No")}{' '}{label} {t("yet this season.")}</p>
  return (
    <div className="space-y-2.5">
      {items.map((s, i) => (
        <div key={s.name} className="flex items-center gap-3">
          <span className="w-5 font-display text-sm font-bold text-faint">{i + 1}</span>
          <span className="flex-1 min-w-0">
            <NameLink to={href.player(s.id ?? squad.find(p => p.name === s.name)?.id, s.name)} className="block truncate text-sm font-semibold">{s.name}</NameLink>
            {s.detail && <span className="block truncate text-[11px] text-faint">{s.detail}</span>}
          </span>
          <span className="w-24 sm:w-32 h-2 rounded-full bg-surface2"><span className="block h-full rounded-full bg-accent" style={{ width: `${(s.value / max) * 100}%` }} /></span>
          <span className="w-6 text-right font-display font-extrabold text-sm">{s.value}</span>
        </div>
      ))}
    </div>
  )
}

export default function Team() {
  const id = useEntityId()
  const [sp] = useSearchParams()
  const { access } = useAuth()
  const [data, setData] = useState<TeamData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    axios
      .get(`${API_URL}/team-page/${id}`, { params: { c: sp.get('c') || undefined, n: sp.get('n') || undefined } })
      // fix140: over the page data budget and nothing stored yet
      .then(r => (r.data.pending ? setError(t("More details soon. This page is being prepared — please check back a little later.")) : setData(r.data.data)))
      .catch(e => setError(
        e?.response?.status === 404 ? t("We couldn't find this team yet.")
          : /budget/i.test(e?.response?.data?.message || '') ? t("This team page isn't available right now — our data provider's daily limit has been reached. It comes back automatically after 03:00 (Israel time).")
          : errorText(e)))
  }, [id, sp, access])

  useEffect(() => {
    if (data) document.title = t("{0} · SportLikely", { 0: data.team.name })
  }, [data])

  const groups = useMemo(() => {
    const g: Record<string, Player[]> = {}
    for (const p of data?.squad || []) (g[p.pos] ||= []).push(p)
    return Object.entries(g)
  }, [data])

  // the team's news (stories that name it) — national teams too
  const news = useNews({ team: data?.team.name, short: sp.get('n') || undefined, limit: 8 }, !!data)

  if (error) return <div className="max-w-5xl mx-auto px-4 py-16 text-center text-muted">{error}</div>
  if (!data)
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <div className="card h-48 animate-pulse" />
        <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]"><div className="card h-96 animate-pulse" /><div className="card h-96 animate-pulse" /></div>
      </div>
    )

  const { team, standing } = data
  const full = data.premium
  // fix176: leagues where the provider has no player stats (Scottish Championship): no goals / assists / rating
  // columns and no scorer cards instead of zeros and empty lists; appearances stay when there are any
  const hasStats = data.squad.some(p => (p.goals ?? 0) > 0 || (p.assists ?? 0) > 0 || p.rating != null) || data.scorers.length > 0
  const hasApps = data.squad.some(p => (p.apps ?? 0) > 0)
  // fix177: national teams — the club column only when we know some clubs (small nations: name only, no grid of dashes)
  const hasClubs = team.national && data.squad.some(p => p.club?.name)
  const nextMatch = data.next[0]
  const rows = standing ? (() => {
    const i = standing.rows.findIndex(r => r.me)
    const from = Math.max(0, Math.min(i - 3, standing.rows.length - 7))
    return standing.rows.slice(from, from + 7)
  })() : []

  return (
    <TeamPage
      logo={team.logo || null}
      kicker={team.national ? t("National team") : data.league ? <><NameLink to={href.league(data.league.id)}>{data.league.name}</NameLink>{team.country ? ` · ${team.country}` : ''}</> : team.country}
      name={team.name}
      fav={{ kind: 'team', ref: nameKey(team.name), name: team.name, img: team.logo, ids: [...new Set([team.id, Number(id)].filter(n => Number.isFinite(n) && n > 0))] }}
      facts={[
        standing ? t("#{0} in the table · {1} pts", { 0: standing.rank, 1: standing.points }) : null,
        data.venue ? `${data.venue.name}${data.venue.capacity ? ` · ${data.venue.capacity.toLocaleString(LOCALE)}` : ''}` : null,
        team.founded ? `${t("Founded")} ${team.founded}` : null
      ].filter(Boolean)}
      note={data.builtAt ? (
        <>
          {(() => {
            const m = Math.max(1, Math.round((Date.now() - new Date(data.builtAt!).getTime()) / 60000))
            return `Updated ${m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`} ago`
          })()}
          {data.stale ? t(" · live data paused (daily data limit reached), refreshes after 03:00") : t(" · results and table refresh every 15 minutes")}
        </>
      ) : undefined}
      form={[...data.form].reverse() as ('W' | 'D' | 'L')[]}
      left={<>
          {/* Team analysis: model's view, form & trends, strengths & weaknesses (paid); locked preview for free */}
          <TeamAnalysisCard a={data.analysis} full={full} />
          {/* fix215: the season forecast of the team's league (chances, average place, how they moved) */}
          <TeamForecast sport="football" id={Number(id)} leagueHref={c => href.league(c) || '/football'} />
          {/* fix231: the next 5 games coloured by our win chance */}
          <TeamDifficulty sport="football" id={Number(id)} />

          {nextMatch && (
            <Card title={t("Next match")} action={<NameLink to={href.league(nextMatch.compCode)} className="text-xs text-faint">{nextMatch.comp}</NameLink>}>
              <div className="flex items-center gap-4">
                <div className="flex-1 flex items-center gap-3 min-w-0"><img src={nextMatch.home.logo} alt="" className="w-9 h-9 object-contain" /><NameLink to={nextMatch.home.id === team.id ? null : href.team(nextMatch.home.id)} className="font-bold truncate">{nextMatch.home.name}</NameLink></div>
                <div className="text-center">
                  <div className="font-display font-bold text-sm">{new Date(nextMatch.date).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                  <div className="text-xs text-faint">{new Date(nextMatch.date).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
                <div className="flex-1 flex items-center justify-end gap-3 min-w-0"><NameLink to={nextMatch.away.id === team.id ? null : href.team(nextMatch.away.id)} className="font-bold truncate text-right">{nextMatch.away.name}</NameLink><img src={nextMatch.away.logo} alt="" className="w-9 h-9 object-contain" /></div>
              </div>
              {nextMatch.matchId && <Link to={matchHref('football', nextMatch.matchId, { home: nextMatch.home.name, away: nextMatch.away.name, homeId: nextMatch.home.id, awayId: nextMatch.away.id, date: nextMatch.date })!} className="mt-4 inline-block text-sm font-bold text-accent">{t("{0} prediction and analysis →", { 0: slModel('football') })}</Link>}
            </Card>
          )}

          {/* squad */}
          <Card title={t("Squad")} action={<span className="text-xs text-faint">{data.league ? `${data.league.season}-${String(data.league.season + 1).slice(2)} · official games, friendlies excluded` : ''}</span>}>
            {groups.length === 0 && <p className="text-sm text-faint">{t("No squad list available.")}</p>}
            <div className="space-y-5">
              {groups.map(([pos, players]) => (
                <div key={pos}>
                  <div className="label mb-2">{POS_LABEL[pos] || pos}</div>
                  <div className="overflow-x-auto -mx-2">
                    <table className={`w-full text-sm ${team.national ? 'min-w-[680px]' : 'min-w-[520px]'}`}>
                      <thead>
                        <tr className="text-[11px] text-faint text-left">
                          <th className="font-medium px-2 py-1 w-10">#</th>
                          <th className="font-medium px-2 py-1">{t("Player")}</th>
                          {hasClubs && <th className="font-medium px-2 py-1">{t("Club this season")}</th>}
                          <th className="font-medium px-2 py-1 text-right w-12">{t("Age")}</th>
                          {(hasStats || hasApps) && <th className="font-medium px-2 py-1 text-right w-14">{full ? t("Apps") : <Pro />}</th>}
                          {hasStats && <th className="font-medium px-2 py-1 text-right w-14">{t("Goals")}</th>}
                          {hasStats && <th className="font-medium px-2 py-1 text-right w-14">{full ? t("Assists") : <Pro />}</th>}
                          {hasStats && <th className="font-medium px-2 py-1 text-right w-14">{full ? t("Rating") : <Pro />}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {players.map(p => (
                          <tr key={p.id} className="border-t border-line/40">
                            <td className="px-2 py-2 font-display text-xs font-bold text-faint">{p.number ?? ''}</td>
                            <td className="px-2 py-2">
                              <span className="flex items-center gap-2.5">
                                {officialPhoto(p.photo) ? <span className="photo-duo w-7 h-7 rounded-full overflow-hidden flex-shrink-0"><img src={p.photo!} alt="" className="w-full h-full object-cover" loading="lazy" /></span> : <PlayerPhoto src={null} name={p.name} size={28} />}
                                {p.noPage ? <span className="font-semibold text-ink truncate">{p.name}</span> : <Link to={playerHref('football', p.id, p.name)!} className="font-semibold text-ink truncate hover:text-accent">{p.name}</Link>}
                              </span>
                            </td>
                            {hasClubs && (
                              <td className="px-2 py-2 text-xs">
                                {p.club?.name ? <><NameLink to={href.team(p.club.id)} className="text-ink">{p.club.name}</NameLink>{(p.club.apps ?? 0) > 0 && <span className="block text-faint num">{t("{0} games · {1} goals", { 0: p.club.apps ?? 0, 1: p.club.goals ?? 0 })}</span>}</> : <span className="text-faint">–</span>}
                              </td>
                            )}
                            <td className="px-2 py-2 text-right text-muted num">{p.age ?? ''}</td>
                            {(hasStats || hasApps) && <td className="px-2 py-2 text-right num">{full ? p.apps ?? '–' : <span className="text-faint">·</span>}</td>}
                            {hasStats && <td className="px-2 py-2 text-right num font-semibold">{p.goals ?? '–'}</td>}
                            {hasStats && <td className="px-2 py-2 text-right num">{full ? p.assists ?? '–' : <span className="text-faint">·</span>}</td>}
                            {hasStats && <td className={`px-2 py-2 text-right num font-bold ${full && p.rating ? (p.rating >= 7.3 ? 'text-win' : p.rating >= 6.9 ? 'text-accent' : 'text-draw') : 'text-faint'}`}>{full ? p.rating ?? '–' : '·'}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
            {!full && data.locked && (
              <div className="mt-5 rounded-2xl bg-surface2/60 p-4 text-sm text-muted">
                <span className="font-semibold text-ink">{t("Premium adds:")}</span> {data.locked.join(' · ')}. <Link to="/premium" className="font-bold text-accent">{t("Go Premium →")}</Link>
              </div>
            )}
          </Card>
      </>}
      right={<>
          {standing && (
            <Card title={t("Season in numbers")}>
              <div className="grid grid-cols-2 gap-3">
                {[
                  [t('Played'), standing.played],
                  [t('Points per game'), standing.played ? (standing.points / standing.played).toFixed(2) : '–'],
                  [t('Goals scored'), standing.gf],
                  [t('Goals conceded'), standing.ga],
                  [t('Won · drawn · lost'), `${standing.won} · ${standing.drawn} · ${standing.lost}`],
                  [t('Goal difference'), standing.gf - standing.ga > 0 ? `+${standing.gf - standing.ga}` : standing.gf - standing.ga]
                ].map(([k, v]) => (
                  <div key={String(k)} className="rounded-2xl bg-surface2/60 p-3.5">
                    <div className="text-[11px] text-faint">{k}</div>
                    <div className="font-display font-extrabold text-xl mt-1">{v}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <TeamRecordCard rec={data.analysis?.record} teamName={team.name} />

          {hasStats && (
            <Card title={t("Top scorers")} action={!full ? <span className="text-[11px] text-faint">Top 3 · <Link to="/premium" className="text-accent font-bold">all</Link></span> : undefined}>
              <Leaders items={data.scorers} label={t("goals")} squad={data.squad} />
            </Card>
          )}

          {hasStats && (
            <Card title={t("Top assists")} action={!full ? <Pro /> : undefined}>
              {full ? <Leaders items={data.assists} label={t("assists")} squad={data.squad} /> : <p className="text-sm text-muted"><Link to="/premium" className="font-bold text-accent">{t("Assists for every player are part of Premium.")}</Link></p>}
            </Card>
          )}

          {rows.length > 0 && data.league && (
            <Card title={<NameLink to={href.league(data.league.id)}>{data.league.name}</NameLink>} action={<img src={data.league.logo} alt="" className="w-6 h-6 object-contain" />}>
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] text-faint"><th className="text-left font-medium py-1 w-8">#</th><th className="text-left font-medium py-1">{t("Team")}</th><th className="text-right font-medium py-1 w-10">P</th><th className="text-right font-medium py-1 w-12">{t("GD")}</th><th className="text-right font-medium py-1 w-12">{t("Pts")}</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className={`border-t border-line/40 ${r.me ? 'bg-accent/10' : ''}`}>
                      <td className="py-2 pl-1 font-display text-xs font-bold text-faint">{r.rank}</td>
                      <td className="py-2"><Link to={teamHref('football', r.id, r.name)!} className="flex items-center gap-2 min-w-0"><img src={r.logo} alt="" className="w-5 h-5 object-contain" /><span className={`truncate ${r.me ? 'font-bold text-ink' : 'text-muted hover:text-ink'}`}>{r.name}</span></Link></td>
                      <td className="py-2 text-right num text-muted">{r.played}</td>
                      <td className="py-2 text-right num text-muted">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                      <td className="py-2 pr-1 text-right num font-bold">{r.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title={t("Results and fixtures")}>
            {data.next.slice(0, 3).map(f => <FixtureRow key={`n${f.date}`} f={f} teamId={team.id} />)}
            {data.last.slice(0, 8).map(f => <FixtureRow key={`l${f.date}`} f={f} teamId={team.id} />)}
          </Card>

          {(news === null || news === undefined || news.length > 0) && (
          <Card title={t("{0} news", { 0: team.name })}>
            {news === null ? <div className="h-24 rounded-xl bg-surface2/60 animate-pulse" /> : news.length ? <div className="-mx-2"><NewsRows items={news} showLeague /></div> : <p className="text-sm text-faint">{t("No news about this team in the last month.")}</p>}
          </Card>
          )}
      </>}
    />
  )
}

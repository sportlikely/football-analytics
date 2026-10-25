import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { useBbConfig, bbTeamFav, type BbGame } from '../../lib/bb'
import { useNews, NewsRows } from '../../components/NewsList'
import { GameList, Skeleton } from './parts'
import { StandingsTable, type Standings } from './BbLeague'
import { teamPlace } from '../../lib/bbTable'
import TeamPage, { TCard as Card } from '../../components/sport/page/TeamPage'
import TeamForecast from '../../components/sport/forecast/TeamForecast'
import { BbTeamAnalysisCard, TeamRecordCard, type BbAnalysis } from '../../components/TeamAnalysis'

interface Profile { games: number; fgPct: number | null; threePct: number | null; threeAttempts: number | null; ftPct: number | null; rebounds: number | null; assists: number | null; turnovers: number | null; steals: number | null; blocks: number | null }
interface Analysis {
  season: string; previousSeason: boolean
  splits: { won: number; lost: number; homeWon: number; homeLost: number; awayWon: number; awayLost: number; b2bWon: number; b2bLost: number; marginHome: number | null; marginAway: number | null; closeWon: number; closeLost: number; games: number }
  streak: { kind: 'W' | 'L'; n: number } | null
  ranks: { attack: number; defence: number; overall: number; of: number } | null
  profile: { team: Profile | null; league: Profile | null }
  last20: { id: number; kickoff: string; home: boolean; opponent: string; for: number; against: number; margin: number }[]
}
interface TeamData {
  team: { id: number; name: string; logo: string | null; league: string }
  rating: { attack: number; defence: number; net: number; games: number } | null
  averages: { games: number; won: number; lost: number; pointsFor: number; pointsAgainst: number; form: ('W' | 'L')[] } | null
  analysis: Analysis | null
  /** fix126: the Team analysis card (full for paid plans; record + locked preview otherwise) */
  teamAnalysis?: BbAnalysis | null
  squad?: SquadPlayer[]
  recent: BbGame[]
  next: BbGame[]
  /** fix177: a team of a newly added league, no game stored yet (page from the league table) */
  noGamesYet?: boolean
  standing?: { position: number; played: number; won: number; lost: number; group: string | null }
}

interface SquadPlayer { id: number; name: string; number: string | null; position: string | null; country: string | null; age: number | null; injury: string | null; statsFrom: 'current' | { season: string; league: string | null } | null; gp: number; starts: number; min: number | null; pts: number | null; reb: number | null; ast: number | null; fgPct: number | null; tpPct: number | null; pie: number | null; usg: number | null; net: number | null }

/** A team: strengths and weaknesses, form chart, splits, news, next games and results. */
export default function BbTeam() {
  const { id = '' } = useParams()
  const cfg = useBbConfig()
  const [d, setD] = useState<TeamData | null | undefined>(undefined)
  const news = useNews({ sport: 'basketball', teamId: id, limit: 8 })
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/basketball/team/${id}`).then(r => setD(r.data.data)).catch(() => setD(null))
  }, [id])
  useEffect(() => { if (d) document.title = t('{0} · SportLikely', { 0: d.team.name }) }, [d?.team.id])
  // "Team analysis →" links from game pages open at the card
  useEffect(() => {
    if (d && window.location.hash === '#analysis') requestAnimationFrame(() => document.getElementById('analysis')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [d?.team.id])

  if (d === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><Skeleton rows={6} /></div>
  if (!d) return <div className="max-w-6xl mx-auto px-4 py-10 text-muted">{t('Team not found')}</div>
  const league = cfg?.leagues.find(l => l.code === d.team.league)
  const an = d.analysis
  const s = an?.splits

  const form = (d.averages?.form || []).slice(0, 5).reverse()
  return (
    <TeamPage
      logo={d.team.logo}
      kicker={<><NameLink to={href.bbLeague(league?.code ?? d.team.league)}>{league?.name}</NameLink>{an?.season ? `${league?.name ? ' · ' : ''}${an.season}` : ''}</>}
      name={d.team.name}
      fav={bbTeamFav(d.team, d.team.league)}
      facts={s && s.games > 0 ? [
        `${an!.previousSeason ? t('Last season') : t('Record')} ${s.won}–${s.lost}`,
        `${t('Home')} ${s.homeWon}–${s.homeLost}`,
        `${t('Away')} ${s.awayWon}–${s.awayLost}`
      ] : []}
      note={<>{league ? <Link to={`/basketball/league/${league.code}`} className="hover:text-white">{t('{0} table →', { 0: league.name })}</Link> : null}{d.noGamesYet && <span className="block">{d.standing ? t('#{0} in the table · {1}–{2}', { 0: d.standing.position, 1: d.standing.won, 2: d.standing.lost }) + ' · ' : ''}{t("Games appear here once the league's schedule is loaded.")}</span>}</>}
      form={form}
      left={<>
        {/* fix126: Team analysis, like football (strengths & weaknesses, model rating, 1–10 scores, rank over time) */}
        <div id="analysis" className="scroll-mt-24"><BbTeamAnalysisCard a={d.teamAnalysis} full={!!d.teamAnalysis && !d.teamAnalysis.locked} /></div>
        <TeamForecast sport="basketball" id={id} leagueHref={c => `/basketball/league/${c}`} />
        {an && (
          <>
              <Card title={t('Compared with the league')}>
                {an.profile.team && an.profile.league ? (
                  <ul className="space-y-3">
                    {PROFILE_ROWS.map(r => {
                      const v = an.profile.team![r.k], lg = an.profile.league![r.k]
                      if (v === null || lg === null || v === undefined || lg === undefined) return null
                      const diff = (v as number) - (lg as number)
                      const good = r.lowerBetter ? diff < 0 : diff > 0
                      const rel = Math.max(-1, Math.min(1, diff / (r.scale || 1)))
                      return (
                        <li key={r.k}>
                          <div className="flex items-baseline justify-between text-sm">
                            <span className="text-muted">{r.label}</span>
                            <span><b className="num text-ink">{v}{r.pct ? '%' : ''}</b> <span className="text-[11px] text-faint">{t('league {0}', { 0: `${lg}${r.pct ? '%' : ''}` })}</span></span>
                          </div>
                          <div className="relative h-2 mt-1 rounded-full bg-surface2">
                            <span className="absolute left-1/2 top-0 bottom-0 w-px bg-line" />
                            <span className={`absolute top-0 bottom-0 rounded-full ${Math.abs(diff) < (r.scale || 1) * 0.15 ? 'bg-faint' : good ? 'bg-win' : 'bg-loss'}`}
                              style={rel >= 0 ? { left: '50%', width: `${rel * 50}%` } : { right: '50%', width: `${-rel * 50}%` }} />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-faint">{t('Shooting and other stats appear once box scores are in for this season.')}</p>
                )}
              </Card>
              {an.last20.length > 0 && (
                <Card title={t('Last {0} games', { 0: an.last20.length })} action={an.streak && an.streak.n >= 2 ? <span className={`text-xs font-bold ${an.streak.kind === 'W' ? 'text-win' : 'text-loss'}`}>{an.streak.kind === 'W' ? t('{0} wins in a row', { 0: an.streak.n }) : t('{0} losses in a row', { 0: an.streak.n })}</span> : undefined}>
                  <MarginChart games={an.last20} />
                  <p className="mt-2 text-[11px] text-faint">{t('Bars: points won or lost by. Green = win, red = loss. Tap a bar for the game.')}</p>
                </Card>
              )}
          </>
        )}
        {d.squad && d.squad.length > 0 && <SquadCard players={d.squad} />}
      </>}
      right={<>
        {an && (
          <>
              {s && s.games > 0 && (
                <Card title={an.previousSeason ? t('Last season in numbers') : t('Season in numbers')}>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted">{t('Home record')}</dt><dd className="text-right num text-ink">{s.homeWon}–{s.homeLost}{s.marginHome !== null ? ` (${s.marginHome > 0 ? '+' : ''}${s.marginHome})` : ''}</dd>
                    <dt className="text-muted">{t('Away record')}</dt><dd className="text-right num text-ink">{s.awayWon}–{s.awayLost}{s.marginAway !== null ? ` (${s.marginAway > 0 ? '+' : ''}${s.marginAway})` : ''}</dd>
                    <dt className="text-muted">{t('Back-to-backs (2nd night)')}</dt><dd className="text-right num text-ink">{s.b2bWon}–{s.b2bLost}</dd>
                    <dt className="text-muted">{t('Close games (5 points or less)')}</dt><dd className="text-right num text-ink">{s.closeWon}–{s.closeLost}</dd>
                    {d.averages && <><dt className="text-muted">{t('Points scored / allowed (last 10)')}</dt><dd className="text-right num text-ink">{d.averages.pointsFor} / {d.averages.pointsAgainst}</dd></>}
                  </dl>
                  <p className="mt-3 text-[11px] text-faint">{t('In brackets: average points won or lost by.')}</p>
                </Card>
              )}
          </>
        )}
        {d.teamAnalysis && <TeamRecordCard rec={d.teamAnalysis.record} teamName={d.team.name} sport="basketball" />}
        <MiniTable code={league?.code ?? d.team.league} teamId={d.team.id} name={league?.name ?? d.team.league} />
        <Card title={t('Next games')}><GameList games={d.next} empty={t('No games scheduled.')} /></Card>
        <Card title={t('Latest results')}><GameList games={d.recent.filter(g => g.state === 'done')} empty={t('No results yet.')} /></Card>
        {(news === null || news === undefined || news.length > 0) && (
        <Card title={t('{0} news', { 0: d.team.name })}>
          {news === null ? <Skeleton rows={3} h="h-14" /> : news.length ? <div className="-mx-2"><NewsRows items={news} /></div> : <p className="text-sm text-faint">{t('No news about this team in the last month.')}</p>}
        </Card>
        )}
      </>}
    />
  )
}

const PROFILE_ROWS: { k: keyof Profile; label: string; pct?: boolean; lowerBetter?: boolean; scale?: number }[] = [
  { k: 'fgPct', label: t('Field goal %'), pct: true, scale: 4 },
  { k: 'threePct', label: t('3-point %'), pct: true, scale: 4 },
  { k: 'threeAttempts', label: t('3-point attempts'), scale: 8 },
  { k: 'ftPct', label: t('Free throw %'), pct: true, scale: 6 },
  { k: 'rebounds', label: t('Rebounds'), scale: 5 },
  { k: 'assists', label: t('Assists'), scale: 5 },
  { k: 'turnovers', label: t('Turnovers'), lowerBetter: true, scale: 3 },
  { k: 'steals', label: t('Steals'), scale: 2 },
  { k: 'blocks', label: t('Blocks'), scale: 2 }
]

/** Win/loss margin per game as bars (oldest left). */
function MarginChart({ games }: { games: Analysis['last20'] }) {
  const max = Math.max(10, ...games.map(g => Math.abs(g.margin)))
  const w = 100 / games.length
  return (
    <div className="relative h-40">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" aria-hidden>
        <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" className="text-line" strokeWidth="0.4" />
      </svg>
      <div className="absolute inset-0 flex">
        {games.map(g => {
          const h = (Math.abs(g.margin) / max) * 50
          return (
            <Link key={g.id} to={`/basketball/game/${g.id}`} className="relative h-full group" style={{ width: `${w}%` }}
              title={`${new Date(g.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })} · ${g.home ? t('H') : t('A')} ${g.opponent} · ${g.for}–${g.against}`}>
              <span className={`absolute left-[15%] right-[15%] rounded-sm ${g.margin > 0 ? 'bg-win' : 'bg-loss'} group-hover:opacity-80`}
                style={g.margin > 0 ? { bottom: '50%', height: `${h}%` } : { top: '50%', height: `${h}%` }} />
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/** Who plays: minutes and production over the last 15 games; NBA adds PIE, usage and net rating for the season. */
function SquadCard({ players }: { players: SquadPlayer[] }) {
  const adv = players.some(p => p.pie !== null)
  const n = (x: number | null, suf = '') => (x === null ? '–' : `${x}${suf}`)
  return (
    <Card title={t('Squad')} action={<span className="text-xs text-faint">{t('averages per game this season')}</span>}>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-xs num">
          <thead>
            <tr className="text-faint">
              <th className="text-left font-semibold py-1 px-2 w-7">#</th>
              <th className="text-left font-semibold py-1 pr-2">{t('Player')}</th>
              <th className="text-right font-semibold px-1">{t('GP')}</th>
              <th className="text-right font-semibold px-1">{t('MIN')}</th>
              <th className="text-right font-semibold px-1">{t('PTS')}</th>
              <th className="text-right font-semibold px-1">{t('REB')}</th>
              <th className="text-right font-semibold px-1">{t('AST')}</th>
              <th className="text-right font-semibold px-1">{t('FG%')}</th>
              <th className="text-right font-semibold px-1">{t('3P%')}</th>
              {adv && <><th className="text-right font-semibold px-1" title={t('Player impact estimate: share of everything that happened on the court')}>PIE</th><th className="text-right font-semibold px-1">{t('USG%')}</th><th className="text-right font-semibold px-2">{t('Net')}</th></>}
            </tr>
          </thead>
          <tbody>
            {players.map(p => (
              <tr key={p.id} className="border-t border-line/40 hover:bg-surface2/40">
                <td className="py-1.5 px-2 text-faint">{p.number ?? ''}</td>
                <td className="py-1.5 pr-2 font-sans whitespace-nowrap">
                  <Link to={`/basketball/player/${p.id}`} className="text-ink font-semibold hover:text-accent">{p.name}</Link>
                  {p.position && <span className="ml-1.5 text-[10px] text-faint">{p.position}</span>}
                  {p.injury && <span className="ml-1.5 rounded px-1 text-[9px] font-bold bg-loss/15 text-loss">{p.injury}</span>}
                  {p.statsFrom && p.statsFrom !== 'current' && <span className="ml-1.5 rounded px-1 text-[9px] font-semibold bg-surface2 text-faint" title={t('No games this season yet: his last season in our leagues')}>{p.statsFrom.league ? `${p.statsFrom.league} ` : ''}{p.statsFrom.season}</span>}
                </td>
                <td className="text-right px-1 text-muted">{p.gp || '–'}</td>
                <td className="text-right px-1 text-muted">{n(p.min)}</td>
                <td className="text-right px-1 text-ink font-bold">{n(p.pts)}</td>
                <td className="text-right px-1 text-muted">{n(p.reb)}</td>
                <td className="text-right px-1 text-muted">{n(p.ast)}</td>
                <td className="text-right px-1 text-muted">{n(p.fgPct)}</td>
                <td className="text-right px-1 text-muted">{n(p.tpPct)}</td>
                {adv && <>
                  <td className="text-right px-1 text-muted">{n(p.pie)}</td>
                  <td className="text-right px-1 text-muted">{n(p.usg)}</td>
                  <td className={`text-right px-2 ${p.net === null ? 'text-faint' : p.net > 0 ? 'text-win' : p.net < 0 ? 'text-loss' : 'text-muted'}`}>{p.net === null ? '–' : p.net > 0 ? `+${p.net}` : p.net}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-faint">{t('Grey tag: no games this season yet, so the numbers are from his last season in our leagues. Tap a player for his page.')}{adv ? ' ' + t('PIE, usage and net rating: season figures from the NBA (last season until the new one starts).') : ''}</p>
    </Card>
  )
}

/** fix178: the team's place in its league table (football's mini table): the group holding it, a few rows around. */
function MiniTable({ code, teamId, name }: { code: string; teamId: number; name: string }) {
  const [data, setData] = useState<Standings | null>(null)
  useEffect(() => {
    let off = false
    setData(null)
    axios.get(`${API_URL}/basketball/standings/${code}`).then(r => { if (!off) setData(r.data.data || null) }).catch(() => undefined)
    return () => { off = true }
  }, [code])
  // fix201: the team's own table (conference / group), the same one the game page uses
  const gr = teamPlace(data, teamId)?.group
  if (!gr) return null
  const i = gr.rows.findIndex(r => r.team.id === teamId)
  const from = Math.max(0, Math.min(i - 3, gr.rows.length - 7))
  return (
    <Card title={<NameLink to={href.bbLeague(code)}>{gr.name && gr.name !== name ? `${name} · ${gr.name}` : name}</NameLink>} action={<Link to={`/basketball/league/${code}`} className="text-xs font-bold text-accent">{t('Full table →')}</Link>}>
      <StandingsTable data={{ season: data!.season, groups: [{ ...gr, rows: gr.rows.slice(from, from + 7) }] }} mark={[teamId]} />
    </Card>
  )
}

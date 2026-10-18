import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t } from '../../lib/i18n'
import { record, nflTeamFav, setNflLeague, nflLeagueName, type NflGame, type StandRow, type NflLeague } from '../../lib/nfl'
import { Skeleton, LockIcon } from '../bb/parts'
import TeamPage, { TCard as Card } from '../../components/sport/page/TeamPage'
import { NflGameRow, LeagueSwitch, StandTable } from './parts'
import RecordLink from '../../components/RecordLink'
import { useNews, NewsRows } from '../../components/NewsList'

interface Measure { id: string; label: string; better: 'high' | 'low'; value: number | null; text: string | null; rank: number | null; of: number | null; score: number | null }
interface Analysis { season: number; measures: Measure[]; strengths: Measure[]; weaknesses: Measure[]; rankByWeek: { week: number; rank: number; of: number }[]; locked?: boolean; notesCount?: number }
interface Player { id: number; name: string; position: string | null; grp: string | null; number: number | null; age: number | null; image: string | null }
interface Data {
  team: { id: number; name: string; code: string | null; city: string | null; logo: string | null; conference: string | null; division: string | null; coach: string | null; stadium: string | null; league?: NflLeague; level?: string | null }
  season: number; standing: StandRow | null; schedule: NflGame[]; results: NflGame[]
  roster: { group: string; players: Player[] }[]; injuries: { id: number; name: string; status: string | null; description: string | null }[]; analysis: Analysis | null
  /** fix139: nfl-v1 ratings (paid plans; null + modelLocked for the rest); record = our picks on this team (admins) */
  model?: Model | null; modelLocked?: boolean; record?: { games: number; right: number; strong: number; strongRight: number } | null
  /** fix174: the team's division (NFL) or conference (college) table */
  division?: { conference: string; name: string; rows: StandRow[] } | null
  /** fix177: no roster from the provider (FCS): the team's season leaders from our box scores */
  leaders?: { id: number; name: string; position: string; line: string | null; status: string | null; out: boolean }[] | null
}
interface Model {
  elo: number; rank: number; teams: number; qb: { id: number; name: string; value: number; league: number } | null
  offense: number; defense: number; leaguePoints: number; offRank: number; defRank: number
}

/** Strength / weakness sentences (fixed rules, fix137): what the measure says, the value and the league rank. */
const SENTENCE: Record<string, { good: string; bad: string }> = {
  pf: { good: 'Scores a lot: {0} points a game (#{1} of {2}).', bad: 'Struggles to score: {0} points a game (#{1} of {2}).' },
  pa: { good: 'Hard to score against: {0} points allowed a game (#{1} of {2}).', bad: 'Gives up a lot of points: {0} a game (#{1} of {2}).' },
  ypp: { good: 'Moves the ball well: {0} yards per play (#{1} of {2}).', bad: 'Little gain per play: {0} yards (#{1} of {2}).' },
  to: { good: 'Wins the turnover battle: {0} a game (#{1} of {2}).', bad: 'Loses the turnover battle: {0} a game (#{1} of {2}).' },
  third: { good: 'Strong on third down: {0} converted (#{1} of {2}).', bad: 'Weak on third down: {0} converted (#{1} of {2}).' },
  rz: { good: 'Finishes drives: {0} of red-zone trips scored (#{1} of {2}).', bad: 'Stalls near the end zone: {0} of red-zone trips scored (#{1} of {2}).' },
  sacks: { good: 'Pressures the quarterback: {0} sacks a game (#{1} of {2}).', bad: 'Little pass rush: {0} sacks a game (#{1} of {2}).' }
}

/** NFL team page (fix137): record, team analysis (rule-based), roster by position, schedule, results, injuries. */
export default function NflTeam() {
  const { id } = useParams()
  const [d, setD] = useState<Data | null>(null)
  const [missing, setMissing] = useState(false)
  const news = useNews({ sport: 'american-football', teamId: id, limit: 8 })
  useEffect(() => {
    setD(null); setMissing(false)
    axios.get(`${API_URL}/nfl/team/${id}`).then(r => {
      const lg: NflLeague = r.data.data.team.league || 1
      setD(r.data.data); setNflLeague(lg)
      document.title = `${r.data.data.team.name} · ${lg === 2 ? 'College football' : 'NFL'} | SportLikely`
    }).catch(() => setMissing(true))
  }, [id])
  if (missing) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{t('Team not found.')}</div>
  if (!d) return <div className="max-w-5xl mx-auto px-4 py-8"><Skeleton rows={8} /></div>
  const tm = d.team
  // form: the last five results, latest last
  const form = d.results.filter(g => g.score).slice(0, 5).reverse().map(g => {
    const mine = g.home.id === tm.id ? g.score!.home : g.score!.away, theirs = g.home.id === tm.id ? g.score!.away : g.score!.home
    return (mine > theirs ? 'W' : mine < theirs ? 'L' : 'T') as 'W' | 'L' | 'T'
  })
  return (
    <TeamPage
      top={<LeagueSwitch />}
      logo={tm.logo}
      kicker={<NameLink to={href.nflStandings(tm.league || 1)}>{[tm.level, tm.conference, tm.division !== tm.conference ? tm.division : null].filter(Boolean).join(' · ') || nflLeagueName(tm.league || 1)}</NameLink>}
      name={tm.name}
      fav={nflTeamFav({ id: tm.id, name: tm.name, logo: tm.logo })}
      facts={[
        d.standing ? record(d.standing) : null,
        // fix176: the team's place in its division / conference table (college tables are built from the games)
        (() => { const i = d.division ? d.division.rows.findIndex(r => r.team.id === tm.id) : -1; return i >= 0 ? t('#{0} in {1}', { 0: i + 1, 1: d.division!.name }) : null })(),
        d.standing ? t('PF {0} · PA {1}', { 0: d.standing.pf, 1: d.standing.pa }) : null,
        tm.coach ? t('Coach: {0}', { 0: tm.coach }) : null,
        tm.stadium || null
      ].filter(Boolean)}
      form={form}
      left={<>
        {d.analysis && <TeamAnalysis a={d.analysis} d={d} />}
        {d.roster.length === 0 && d.leaders && d.leaders.length > 0 && (
          <Card title={t('Season leaders')} action={<span className="text-xs text-faint">{t('From the box scores')}</span>}>
            <ul className="divide-y divide-line/50">
              {d.leaders.map(p => (
                <li key={`${p.position}${p.id}`} className="flex items-center gap-3 py-1.5 text-sm min-w-0">
                  <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-wide text-faint">{t(p.position)}</span>
                  <Link to={`/american-football/player/${p.id}`} className="min-w-0 flex-1 truncate font-semibold text-ink hover:text-accent">{p.name}</Link>
                  {p.line && <span className="shrink-0 text-[11px] text-faint">{p.line}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {d.roster.length > 0 && (
          <Card title={t('Roster')}>
            <div className="space-y-5">
              {d.roster.map(gr => (
                <div key={gr.group}>
                  <div className="label pb-1.5">{t(gr.group)}</div>
                  <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                    {gr.players.map(p => (
                      <li key={p.id}>
                        <Link to={`/american-football/player/${p.id}`} className="flex items-center gap-2 text-sm hover:text-accent">
                          <span className="w-7 text-right num text-faint">{p.number ?? ''}</span>
                          <span className="w-9 text-[11px] font-bold text-muted">{p.position || ''}</span>
                          <span className="truncate text-ink">{p.name}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        )}
      </>}
      right={<>
        <RecordCard d={d} />
        {d.division && d.division.rows.length > 0 && (
          <Card title={<NameLink to={href.nflStandings(tm.league || 1)}>{d.division.name !== d.division.conference ? `${d.division.conference} · ${d.division.name}` : d.division.name}</NameLink>} action={<Link to={href.nflStandings(tm.league || 1)} className="text-xs font-bold text-accent">{t('Full table →')}</Link>}>
            <StandTable rows={d.division.rows} compact highlight={tm.id} league={tm.league || 1} />
          </Card>
        )}
        {d.injuries.length > 0 && (
          <Card title={t('Injuries')}>
            <ul className="divide-y divide-line/50">
              {d.injuries.map(i => (
                <li key={i.id} className="py-1.5 text-sm flex items-baseline justify-between gap-2">
                  <Link to={`/american-football/player/${i.id}`} className="text-ink hover:text-accent truncate">{i.name}</Link>
                  <span className="text-xs text-faint truncate">{[i.status, i.description].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {d.schedule.length > 0 && (
          <Card title={t('Next games')}><div className="-mx-5 sm:-mx-6 divide-y divide-line/50">{d.schedule.slice(0, 8).map(g => <NflGameRow key={g.id} g={g} showDay />)}</div></Card>
        )}
        <Card title={t('Latest results')}>
          {d.results.length === 0 ? <p className="text-sm text-faint">{t('No games played yet this season.')}</p> : (
            <div className="-mx-5 sm:-mx-6 divide-y divide-line/50">{d.results.map(g => <NflGameRow key={g.id} g={g} showDay />)}</div>
          )}
        </Card>
        {(news === null || news === undefined || news.length > 0) && (
        <Card title={t('{0} news', { 0: tm.name })}>
          {news === null ? <Skeleton rows={3} h="h-14" /> : news.length ? <div className="-mx-2"><NewsRows items={news} /></div> : <p className="text-sm text-faint">{t('No news about this team in the last month.')}</p>}
        </Card>
        )}
      </>}
    />
  )
}

/** Team analysis (rule-based, fix137): 1–10 league scores, strengths and weaknesses, rank over the season; then the
 *  nfl-v1 model tiles (fix139, paid plans): Elo and rank, starting QB, points for / against ratings, next game. */
function TeamAnalysis({ a, d }: { a: Analysis; d: Data }) {
  if (a.locked) return <LockedAnalysis a={a} d={d} />
  const line = (m: Measure, good: boolean) => t((good ? SENTENCE[m.id]?.good : SENTENCE[m.id]?.bad) || '{0}', { 0: m.text ?? '–', 1: m.rank ?? '–', 2: m.of ?? '–' })
  const ranks = a.rankByWeek
  const of = ranks[0]?.of || 32
  return (
    <Card title={t('Team analysis')} action={<span className="text-xs text-faint">{t('{0} season · 1 = league worst, 10 = league best', { 0: a.season })}</span>}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2.5">
          {a.measures.map(m => (
            <div key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-muted truncate">{t(m.label)}</span><span className="num text-ink font-semibold">{m.text ?? '–'}</span></div>
                <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${m.score === null ? '' : m.score >= 8 ? 'bg-win' : m.score <= 3 ? 'bg-loss' : 'bg-accent'}`} style={{ width: `${(m.score ?? 0) * 10}%` }} /></div>
              </div>
              <span className="w-8 text-right num font-display font-extrabold text-ink">{m.score ?? '–'}</span>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <div>
            <div className="label pb-1 text-win">{t('Strengths')}</div>
            {a.strengths.length ? <ul className="space-y-1 text-sm text-ink">{a.strengths.map(m => <li key={m.id} className="flex gap-2"><span className="text-win">+</span>{line(m, true)}</li>)}</ul> : <p className="text-sm text-faint">{t('Nothing stands out yet.')}</p>}
          </div>
          <div>
            <div className="label pb-1 text-loss">{t('Weaknesses')}</div>
            {a.weaknesses.length ? <ul className="space-y-1 text-sm text-ink">{a.weaknesses.map(m => <li key={m.id} className="flex gap-2"><span className="text-loss">−</span>{line(m, false)}</li>)}</ul> : <p className="text-sm text-faint">{t('Nothing stands out yet.')}</p>}
          </div>
          {ranks.length > 1 && (
            <div>
              <div className="label pb-1">{t('League rank by week (point difference per game)')}</div>
              <svg viewBox={`0 0 ${Math.max(1, ranks.length - 1) * 20 + 20} 80`} className="w-full h-24" role="img" aria-label={t('Rank by week')}>
                <polyline fill="none" stroke="rgb(var(--accent))" strokeWidth="2" points={ranks.map((r, i) => `${10 + i * 20},${8 + ((r.rank - 1) / Math.max(1, of - 1)) * 64}`).join(' ')} />
                {ranks.map((r, i) => <circle key={r.week} cx={10 + i * 20} cy={8 + ((r.rank - 1) / Math.max(1, of - 1)) * 64} r="2.5" fill="rgb(var(--accent))"><title>{t('Week {0}: #{1}', { 0: r.week, 1: r.rank })}</title></circle>)}
              </svg>
              <div className="flex justify-between text-[10px] text-faint num"><span>{t('Week {0}', { 0: ranks[0].week })}</span><span>#{ranks[ranks.length - 1].rank} {t('now')}</span></div>
            </div>
          )}
        </div>
      </div>
      <ModelTiles d={d} />
    </Card>
  )
}

/** Model tiles (fix139): what nfl-v1 thinks of the team. Locked for free / signed-out visitors. */
function ModelTiles({ d }: { d: Data }) {
  const m = d.model
  const next = d.schedule.find(g => g.state === 'upcoming')
  const np = next?.prediction
  const home = next ? next.home.id === d.team.id : false
  const nextPct = np && !np.locked && typeof np.pHome === 'number' ? (home ? np.pHome : np.pAway!) : null
  if (d.modelLocked) {
    return (
      <div className="mt-5 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2"><LockIcon /> {t('Model ratings, quarterback value and win chances are for Premium members.')}</span>
        <Link to="/premium" className="px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-extrabold">{t('Go Premium')}</Link>
      </div>
    )
  }
  if (!m) return null
  const tiles: { label: string; value: ReactNode; sub: ReactNode }[] = [
    { label: t('Elo rating'), value: String(m.elo), sub: t('#{0} of {1}', { 0: m.rank, 1: m.teams }) },
    { label: t('Quarterback'), value: m.qb ? <NameLink to={href.nflPlayer(m.qb.id)}>{m.qb.name}</NameLink> : '–', sub: m.qb ? t('{0} net yards per pass attempt (league {1})', { 0: m.qb.value.toFixed(1), 1: m.qb.league.toFixed(1) }) : '' },
    { label: t('Attack rating'), value: t('{0} pts', { 0: m.offense.toFixed(1) }), sub: t('#{0} of {1} · league {2}', { 0: m.offRank, 1: m.teams, 2: m.leaguePoints.toFixed(1) }) },
    { label: t('Defence rating'), value: t('{0} pts', { 0: m.defense.toFixed(1) }), sub: t('#{0} of {1} · allowed per game', { 0: m.defRank, 1: m.teams }) }
  ]
  if (next && nextPct !== null) tiles.push({ label: t('Win chance next game'), value: `${Math.round(nextPct)}%`, sub: <>{home ? t('vs') : '@'} <NameLink to={href.nflTeam((home ? next.away : next.home).id)}>{(home ? next.away : next.home).name}</NameLink></> })
  return (
    <div className="mt-5 grid gap-3 grid-cols-2 lg:grid-cols-3">
      {tiles.map(x => (
        <div key={String(x.label)} className="rounded-xl border border-line/70 bg-surface2/40 px-4 py-3 min-w-0">
          <div className="text-xs text-muted">{x.label}</div>
          <div className="font-display text-lg font-extrabold text-ink leading-tight break-words">{x.value}</div>
          {x.sub && <div className="text-[11px] text-faint mt-0.5">{x.sub}</div>}
        </div>
      ))}
    </div>
  )
}

/** fix174: free / signed-out view of the team analysis (like football and basketball): the rank over the season and
 *  how many strengths and weaknesses we found; the scores and sentences are part of Premium. */
function LockedAnalysis({ a, d }: { a: Analysis; d: Data }) {
  const ranks = a.rankByWeek
  return (
    <Card title={t('Team analysis')} action={<span className="text-xs text-faint">{t('{0} season', { 0: a.season })}</span>}>
      <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4 text-sm text-ink space-y-3">
        <p className="flex items-start gap-2"><LockIcon /> <span>{t('1–10 league scores for scoring, defence, yards per play, turnovers, third downs, red zone and pass rush')}{a.notesCount ? t(', and {0} strengths and weaknesses we found in the numbers', { 0: a.notesCount }) : ''}.</span></p>
        <Link to="/premium" className="inline-block px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-extrabold">{t('Go Premium')}</Link>
      </div>
      {ranks.length > 1 && (
        <div className="mt-5">
          <div className="label pb-1">{t('League rank by week (point difference per game)')}</div>
          <div className="flex justify-between text-sm"><span className="text-muted">{t('Week {0}', { 0: ranks[0].week })}: <b className="text-ink num">#{ranks[0].rank}</b></span><span className="text-muted">{t('now')}: <b className="text-ink num">#{ranks[ranks.length - 1].rank}</b> <span className="text-faint">/ {ranks[ranks.length - 1].of}</span></span></div>
        </div>
      )}
      <ModelTiles d={d} />
    </Card>
  )
}

/** fix174: our record on the team (public, like football and basketball): picks saved before kick-off, finished games. */
function RecordCard({ d }: { d: Data }) {
  const r = d.record
  if (!r) return null
  return (
    <Card title={t('Our record on {0}', { 0: d.team.name })} action={<RecordLink to="/american-football/accuracy" className="text-xs font-bold text-accent">{t('Full record →')}</RecordLink>}>
      {!r.games ? <p className="text-sm text-faint">{t('No finished games with a saved prediction yet.')}</p> : (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl bg-surface2/60 p-3.5">
            <div className="text-[11px] text-faint">{t('Winner, {0} games', { 0: r.games })}</div>
            <div className="font-display font-extrabold text-xl mt-1">{Math.round((r.right / r.games) * 100)}%</div>
            <div className="text-[11px] text-muted">{t('{0} right', { 0: r.right })}</div>
          </div>
          {r.strong > 0 && (
            <div className="rounded-2xl bg-surface2/60 p-3.5">
              <div className="text-[11px] text-faint">{t('Strong picks')}</div>
              <div className="font-display font-extrabold text-xl mt-1">{Math.round((r.strongRight / r.strong) * 100)}%</div>
              <div className="text-[11px] text-muted">{t('{0} games', { 0: r.strong })}</div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

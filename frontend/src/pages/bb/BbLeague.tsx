import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t } from '../../lib/i18n'
import { hubFor } from '../../lib/hubs'
import { useBbConfig, bbLeagueFav, type BbGame } from '../../lib/bb'
import { GameList, Skeleton, TeamLogo, LiveRow } from './parts'
import LeaguePage, { LCard as Card } from '../../components/sport/page/LeaguePage'
import { useNews, NewsRows } from '../../components/NewsList'

export interface StandRow { position: number; team: { id: number; name: string; logo: string | null }; played: number; won: number; lost: number; pct: number | null; pointsFor: number | null; pointsAgainst: number | null }
export interface Standings { season: string; groups: { name: string | null; stage: string | null; rows: StandRow[] }[] }

/** Standings table(s); the teams of a game are marked (in the home / away colours when given). */
export function StandingsTable({ data, mark = [], colors }: { data: Standings; mark?: number[]; colors?: Record<number, 'H' | 'A'> }) {
  return (
    <div className="space-y-5">
      {data.groups.map((g, i) => (
        <div key={i}>
          {data.groups.length > 1 && g.name && <div className="label pb-2">{g.name}</div>}
          <table className="w-full table-fixed text-xs sm:text-sm">
            <thead>
              <tr className="text-faint text-[10px] uppercase tracking-wide">
                <th className="text-left font-semibold py-1.5 w-9">#</th>
                <th className="text-left font-semibold py-1.5">{t('Team')}</th>
                <th className="text-right font-semibold py-1.5 w-8 sm:w-10">{t('P')}</th>
                <th className="text-right font-semibold py-1.5 w-8 sm:w-10">{t('W')}</th>
                <th className="text-right font-semibold py-1.5 w-8 sm:w-10">{t('L')}</th>
                <th className="text-right font-semibold py-1.5 w-14 sm:w-32">%</th>
                <th className="text-right font-semibold py-1.5 w-16 hidden sm:table-cell">{t('+/−')}</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map(r => {
                const c = colors?.[r.team.id]
                const on = mark.includes(r.team.id)
                const diff = r.pointsFor !== null && r.pointsAgainst !== null && r.played ? (r.pointsFor - r.pointsAgainst) / r.played : null
                return (
                  <tr key={r.team.id} className={`border-t border-line/40 ${c === 'H' ? 'bg-home/10' : c === 'A' ? 'bg-away/10' : on ? 'bg-accent/10' : 'hover:bg-surface2/40'}`}>
                    <td className="py-1.5 relative">
                      {(c || on) && <span className={`absolute left-0 inset-y-1 w-[3px] rounded-full ${c === 'H' ? 'bg-home' : c === 'A' ? 'bg-away' : 'bg-accent'}`} />}
                      <span className={`ml-1.5 inline-grid place-items-center w-5 h-5 rounded-md num text-[10px] font-bold ${r.position <= 3 ? 'bg-accent/15 text-accent' : 'text-faint'}`}>{r.position}</span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <Link to={`/basketball/team/${r.team.id}`} className={`flex items-center gap-2 hover:text-accent ${on ? 'font-bold text-ink' : 'text-ink'}`}>
                        <TeamLogo team={r.team} size={18} /><span className="truncate">{r.team.name}</span>
                      </Link>
                    </td>
                    <td className="py-1.5 text-right num text-muted">{r.played}</td>
                    <td className="py-1.5 text-right num text-ink font-semibold">{r.won}</td>
                    <td className="py-1.5 text-right num text-muted">{r.lost}</td>
                    <td className="py-1.5 text-right num text-muted">
                      <span className="inline-flex items-center justify-end gap-2">
                        {r.pct !== null && <span className="hidden sm:block w-12 h-1.5 rounded-full bg-surface2 overflow-hidden"><span className="block h-full rounded-full bg-win/70" style={{ width: `${r.pct * 100}%` }} /></span>}
                        {r.pct !== null ? r.pct.toFixed(3).replace(/^0/, '') : '–'}
                      </span>
                    </td>
                    <td className={`py-1.5 text-right num hidden sm:table-cell font-semibold ${diff === null ? 'text-muted' : diff > 0 ? 'text-win' : diff < 0 ? 'text-loss' : 'text-muted'}`}>
                      {diff !== null ? (diff > 0 ? '+' : '') + diff.toFixed(1) : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

/** A league: standings, next games, latest results. */
export default function BbLeague() {
  const { code = '' } = useParams()
  const cfg = useBbConfig()
  const league = cfg?.leagues.find(l => l.code === code.toUpperCase())
  const [table, setTable] = useState<Standings | null | undefined>(undefined)
  const [next, setNext] = useState<BbGame[] | null>(null)
  const [results, setResults] = useState<BbGame[] | null>(null)
  const news = useNews({ sport: 'basketball', league: code.toUpperCase(), limit: 10 })
  const [leaders, setLeaders] = useState<Leaders | null>(null)
  // our record in this league, last 12 months (the header tile, like football)
  const [record, setRecord] = useState<{ hitRate: number; n: number } | null>(null)
  useEffect(() => {
    setRecord(null)
    axios.get(API_URL + '/basketball/record', { params: { league: code.toUpperCase(), days: 365 } })
      .then(r => { const x = r.data.data?.total; setRecord(x && x.n > 0 && x.hitRate !== null ? { hitRate: x.hitRate, n: x.n } : null) }).catch(() => undefined)
  }, [code])
  useEffect(() => {
    setLeaders(null)
    // fix174: every league with player stats (none: the card stays hidden)
    axios.get(`${API_URL}/basketball/leaders`, { params: { league: code.toUpperCase() } }).then(r => setLeaders(r.data.data || null)).catch(() => undefined)
  }, [code])

  useEffect(() => {
    const c = code.toUpperCase()
    setTable(undefined); setNext(null); setResults(null)
    axios.get(`${API_URL}/basketball/standings/${c}`).then(r => setTable(r.data.data || null)).catch(() => setTable(null))
    axios.get(`${API_URL}/basketball/games`, { params: { league: c, days: 10 } }).then(r => setNext((r.data.data || []).filter((g: BbGame) => g.state !== 'done'))).catch(() => setNext([]))
    axios.get(`${API_URL}/basketball/games`, { params: { league: c, days: 21, results: 1 } }).then(r => setResults((r.data.data || []).filter((g: BbGame) => g.state === 'done'))).catch(() => setResults([]))
  }, [code])
  const live = (next || []).filter(g => g.state === 'live')
  // live box: refresh the league's games every minute while one is on (score, clock, live win chance)
  useEffect(() => {
    if (!live.length) return
    const c = code.toUpperCase()
    const iv = setInterval(() => {
      axios.get(`${API_URL}/basketball/games`, { params: { league: c, days: 10 } }).then(r => setNext((r.data.data || []).filter((g: BbGame) => g.state !== 'done'))).catch(() => undefined)
    }, 60000)
    return () => clearInterval(iv)
  }, [code, live.length > 0])
  useEffect(() => { if (league) document.title = t('{0} · SportLikely', { 0: league.name }) }, [league])

  const hub = hubFor('basketball', code)
  // fix152d: football's league page (components/sport/page/LeaguePage): table + leaders left; live, next, news, results right
  return (
    <LeaguePage
      logo={league?.logo || null}
      country={{ name: league ? t(league.country) : t('League') }}
      name={league?.name || code.toUpperCase()}
      sub={table?.season || null}
      hub={hub ? { to: `/predictions/${hub.slug}`, label: t("This week's predictions →") } : null}
      fav={league ? bbLeagueFav(league) : null}
      record={record}
      left={<>
        <Card title={t('Table')}>
          {table === undefined ? <Skeleton rows={10} h="h-7" /> : table ? <StandingsTable data={table} /> : <p className="text-sm text-faint">{t('No table yet.')}</p>}
        </Card>
        {leaders && leaders.lists.length > 0 && <LeadersCard data={leaders} />}
      </>}
      right={<>
        {live.length > 0 && (
          <Card title={t('Live now')} action={<span className="inline-flex items-center gap-1.5 text-xs font-bold text-live"><span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />{t('{0} live', { 0: live.length })}</span>}>
            <ul className="space-y-1">{live.map(g => <li key={g.id}><LiveRow g={g} /></li>)}</ul>
          </Card>
        )}
        <Card title={t('Next games')} action={<Link to="/basketball/games" className="text-xs font-bold text-accent">{t('All →')}</Link>}>
          {!next ? <Skeleton rows={5} /> : <div className="max-h-[430px] overflow-y-auto overscroll-contain pr-1"><GameList games={next.filter(g => g.state !== 'live')} empty={t('No games in the next 10 days.')} /></div>}
        </Card>
        {(news === null || news === undefined || news.length > 0) && (
        <Card title={t('{0} news', { 0: league?.name || code.toUpperCase() })}>
          {news === null ? <Skeleton rows={3} h="h-14" /> : news.length ? <div className="-mx-2 max-h-[520px] overflow-y-auto overscroll-contain"><NewsRows items={news} /></div> : <p className="text-sm text-faint">{t('No news about this league in the last two weeks.')}</p>}
        </Card>
        )}
        <Card title={t('Latest results')}>
          {!results ? <Skeleton rows={5} /> : <div className="max-h-[430px] overflow-y-auto overscroll-contain pr-1"><GameList games={results} empty={t('No results in the last three weeks.')} /></div>}
        </Card>
      </>}
    />
  )
}

interface Leaders { season: string; lists: { stat: string; top: { id: number | null; name: string; value: number; games: number; rank: number }[] }[] }
const STAT_LABEL: Record<string, string> = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', stl: 'Steals', blk: 'Blocks' }

/** League leaders per game (NBA: balldontlie; other leagues: our box scores, fix174). */
export function LeadersCard({ data }: { data: Leaders }) {
  const [stat, setStat] = useState(data.lists[0].stat)
  const list = data.lists.find(l => l.stat === stat) || data.lists[0]
  return (
    <Card title={t('League leaders')} action={<span className="text-xs text-faint">{data.season}</span>}>
      <div className="seg mb-3 flex-wrap">
        {data.lists.map(l => <button key={l.stat} onClick={() => setStat(l.stat)} className={`seg-btn ${l.stat === stat ? 'seg-btn-active' : ''}`}>{t(STAT_LABEL[l.stat] || l.stat)}</button>)}
      </div>
      <ol className="divide-y divide-line/50">
        {list.top.map(x => (
          <li key={x.name} className="flex items-center gap-3 py-2 text-sm">
            <span className="w-5 num text-faint">{x.rank}</span>
            {x.id ? <Link to={`/basketball/player/${x.id}`} className="text-ink font-semibold hover:text-accent truncate">{x.name}</Link> : <span className="text-ink font-semibold truncate">{x.name}</span>}
            <span className="ml-auto num font-bold text-ink">{x.value}</span>
            <span className="text-[10px] text-faint w-12 text-right">{t('{0} GP', { 0: x.games })}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-faint">{t('Per game, regular season.')}</p>
    </Card>
  )
}

/**
 * fix174: the "one chosen league" panel of the Games page (football's LeaguePanel, basketball's data): the table and
 * the league leaders, with a link to the league page.
 */
export function BbLeaguePanel({ code }: { code: string }) {
  const [tab, setTab] = useState<'table' | 'leaders'>('table')
  const [table, setTable] = useState<Standings | null | undefined>(undefined)
  const [leaders, setLeaders] = useState<Leaders | null>(null)
  useEffect(() => {
    setTable(undefined); setLeaders(null)
    axios.get(`${API_URL}/basketball/standings/${code}`).then(r => setTable(r.data.data || null)).catch(() => setTable(null))
    axios.get(`${API_URL}/basketball/leaders`, { params: { league: code } }).then(r => setLeaders(r.data.data || null)).catch(() => undefined)
  }, [code])
  const hasLeaders = !!leaders && leaders.lists.length > 0
  return (
    <aside className="xl:sticky xl:top-20 space-y-4">
      {hasLeaders && (
        <div className="seg w-full">
          {(['table', 'leaders'] as const).map(x => <button key={x} onClick={() => setTab(x)} className={`seg-btn flex-1 ${tab === x ? 'seg-btn-active' : ''}`}>{x === 'table' ? t('Table') : t('Leaders')}</button>)}
        </div>
      )}
      {tab === 'leaders' && hasLeaders ? <LeadersCard data={leaders!} /> : (
        <section className="card p-3">
          {table === undefined ? <Skeleton rows={8} h="h-6" /> : table ? <StandingsTable data={table} /> : <p className="text-xs text-faint p-2">{t('No table for this league yet.')}</p>}
        </section>
      )}
      <Link to={`/basketball/league/${code}`} className="block text-center text-xs font-bold text-accent">{t('League page →')}</Link>
    </aside>
  )
}

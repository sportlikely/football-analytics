import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t } from '../../lib/i18n'
import { useNflLeague, type Standings, type LeaderCat, type NflGame } from '../../lib/nfl'
import type { Favorite } from '../../lib/favorites'
import { Skeleton, TeamLogo } from '../bb/parts'
import NameLink, { href } from '../../components/sport/NameLink'
import { useNews, NewsRows } from '../../components/NewsList'
import SeasonForecast from '../../components/sport/forecast/SeasonForecast'
import LeaguePage, { LCard as Card } from '../../components/sport/page/LeaguePage'
import { StandingsBlock, LeagueSwitch, NflGameRow } from './parts'
import { teamHref, playerHref } from '../../lib/links'

/**
 * NFL + college league page: football's league page (fix152d) — the header with our record, standings and leaders on
 * the left; live games, next games, news and results on the right.
 */
export default function NflLeague() {
  const { league } = useNflLeague()
  const name = league === 2 ? t('College football') : 'NFL'
  const [d, setD] = useState<(Standings & { leaders: LeaderCat[] }) | null | undefined>(undefined)
  const [games, setGames] = useState<NflGame[] | null>(null)
  const [record, setRecord] = useState<{ hitRate: number; n: number } | null>(null)
  const news = useNews({ sport: 'american-football', league: league === 2 ? 'NCAA' : 'NFL', limit: 10 })
  useEffect(() => {
    document.title = t('{0} · SportLikely', { 0: league === 2 ? t('College football standings') : t('NFL standings') })
    setD(undefined); setGames(null); setRecord(null)
    axios.get(`${API_URL}/nfl/standings`, { params: { league } }).then(r => setD(r.data.data)).catch(() => setD(null))
    const now = Date.now()
    axios.get(`${API_URL}/nfl/games`, { params: { from: new Date(now - 21 * 86400e3).toISOString(), to: new Date(now + 14 * 86400e3).toISOString(), league } })
      .then(r => setGames(r.data.data?.games || [])).catch(() => setGames([]))
    // fix174: our record in this league, last 12 months — public like football and basketball (picks saved before kick-off)
    axios.get(`${API_URL}/nfl/record`, { params: { days: 365, league } })
      .then(r => { const all = (r.data.data?.bands || []).find((b: any) => b.min === 0); setRecord(all && all.n > 0 && all.pct !== null ? { hitRate: all.pct, n: all.n } : null) })
      .catch(() => undefined)
  }, [league])
  // fix174: the favorite star and the weekly hub, like every league page (no league mark: the provider's NFL and
  // college league images are its "image not available" placeholder)
  const code = league === 2 ? 'NCAA' : 'NFL'
  const fav: Favorite = { kind: 'nfl-league', ref: code, code, name, img: null }

  const live = (games || []).filter(g => g.state === 'live')
  const next = (games || []).filter(g => g.state === 'upcoming').sort((a, b) => a.kickoff.localeCompare(b.kickoff)).slice(0, 12)
  const results = (games || []).filter(g => g.state === 'done').sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, 16)
  const rows = (list: NflGame[]) => <div className="-mx-4 sm:-mx-5 divide-y divide-line/50">{list.map(g => <NflGameRow key={g.id} g={g} showDay />)}</div>

  return (
    <LeaguePage
      top={<LeagueSwitch />}
      logo={null}
      country={{ name: league === 2 ? t('USA · college') : t('USA') }}
      name={name}
      sub={d ? (league === 2 ? t('{0} season · by conference, FBS first', { 0: d.season }) : t('{0} season · regular season', { 0: d.season })) : null}
      record={record}
      forecast={<SeasonForecast sport="nfl" code={league === 2 ? 'NCAA' : 'NFL'} teamHref={(id, name) => teamHref('american-football', id, name)!} />}
      // fix175 (parity) + fix174: favorite star and the weekly hub, like football and basketball
      fav={fav}
      hub={{ to: `/predictions/${league === 2 ? 'college-football' : 'nfl'}`, label: t("This week's predictions →") }}
      left={<>
        <Card title={t('Table')}>
          {d === undefined ? <Skeleton rows={10} h="h-7" /> : !d || !d.conferences.length ? <p className="text-sm text-faint">{t('Standings appear once the season has started.')}</p> : <StandingsBlock data={d} />}
        </Card>
        {d && d.leaders.length > 0 && (
          <section id="leaders">
            <Card title={t('League leaders')}>
              <div className="grid gap-5 sm:grid-cols-2">
                {d.leaders.map(c => (
                  <div key={c.id} className="min-w-0">
                    <div className="label pb-1">{t(c.label)}</div>
                    <ol className="space-y-1">
                      {c.rows.map((r, i) => (
                        <li key={r.id} className="flex items-center gap-2 text-sm min-w-0">
                          <span className="w-4 text-faint num">{i + 1}</span>
                          {r.team && <TeamLogo team={r.team} size={16} />}
                          <Link to={playerHref('american-football', r.id, r.name)!} className="flex-1 truncate text-ink hover:text-accent">{r.name}</Link>
                          {r.team && <NameLink to={href.nflTeam(r.team.id, r.team.name)} className="hidden sm:block max-w-[7rem] truncate text-[11px] text-faint">{r.team.name}</NameLink>}
                          <span className="num font-bold text-ink">{r.value}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        )}
      </>}
      right={<>
        {live.length > 0 && <Card title={t('Live now')}>{rows(live)}</Card>}
        <Card title={t('Next games')} action={<Link to={`/american-football/games?league=${league === 2 ? 'college' : 'nfl'}`} className="text-xs font-bold text-accent">{t('All →')}</Link>}>
          {!games ? <Skeleton rows={5} /> : next.length ? <div className="max-h-[430px] overflow-y-auto overscroll-contain">{rows(next)}</div> : <p className="text-sm text-faint">{t('No games in the next two weeks.')}</p>}
        </Card>
        {(news === null || news === undefined || news.length > 0) && (
        <Card title={t('{0} news', { 0: name })}>
          {news === null ? <Skeleton rows={3} h="h-14" /> : news.length ? <div className="-mx-2 max-h-[520px] overflow-y-auto overscroll-contain"><NewsRows items={news} /></div> : <p className="text-sm text-faint">{t('No news about this league in the last two weeks.')}</p>}
        </Card>
        )}
        <Card title={t('Latest results')}>
          {!games ? <Skeleton rows={5} /> : results.length ? <div className="max-h-[430px] overflow-y-auto overscroll-contain">{rows(results)}</div> : <p className="text-sm text-faint">{t('No results in the last three weeks.')}</p>}
        </Card>
      </>}
    />
  )
}

import { useEffect, useState } from 'react'
import { useEntityId } from '../../components/SlugRoute'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { setNflLeague, nflPlayerFav, type NflGame } from '../../lib/nfl'
import { FavStar } from '../../lib/favorites'
import { LeagueSwitch } from './parts'
import { Card, Skeleton, TeamLogo } from '../bb/parts'
import PlayerHeader, { Chip } from '../../components/sport/page/PlayerHeader'
import NameLink, { href } from '../../components/sport/NameLink'
import { teamHref, matchHref } from '../../lib/links'
import { MaybeLink } from '../../components/MaybeLink'

interface Data {
  player: { id: number; name: string; position: string | null; group: string | null; number: number | null; age: number | null; height: string | null; weight: string | null; college: string | null; experience: number | null; image: string | null }
  team: { id: number; name: string; logo: string | null } | null
  season: number; games: number
  totals: Record<string, Record<string, string>>
  log: { game: NflGame; teamId: number; groups: Record<string, Record<string, string>> }[]
  // fix174
  career?: { season: number; league: number; team: { id: number; name: string; logo: string | null } | null; games: number; stats: Record<string, number> }[]
  injury?: { status: string | null; description: string | null; date: string | null } | null
}
const CAREER_COLS: { key: string; label: string }[] = [
  { key: 'passYds', label: 'Pass yds' }, { key: 'passTd', label: 'Pass TD' }, { key: 'rushYds', label: 'Rush yds' }, { key: 'rushTd', label: 'Rush TD' },
  { key: 'rec', label: 'Rec' }, { key: 'recYds', label: 'Rec yds' }, { key: 'recTd', label: 'Rec TD' }, { key: 'tackles', label: 'Tackles' }, { key: 'sacks', label: 'Sacks' }, { key: 'ints', label: 'INT' }
]

/** NFL player page (fix137): bio, season totals by group, game log. Pictures from API-Sports only. */
export default function NflPlayer() {
  const id = useEntityId()
  const [d, setD] = useState<Data | null>(null)
  const [missing, setMissing] = useState(false)
  const [imgBroken, setImgBroken] = useState(false)
  useEffect(() => {
    setD(null); setMissing(false); setImgBroken(false)
    axios.get(`${API_URL}/nfl/player/${id}`).then(r => {
      const lg = r.data.data.team?.league === 2 ? 2 : 1
      setD(r.data.data); setNflLeague(lg)
      document.title = `${r.data.data.player.name} · ${lg === 2 ? 'College football' : 'NFL'} | SportLikely`
    }).catch(() => setMissing(true))
  }, [id])
  if (missing) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{t('Player not found.')}</div>
  if (!d) return <div className="max-w-5xl mx-auto px-4 py-8"><Skeleton rows={6} /></div>
  const p = d.player
  const bio = [
    p.position && [t('Position'), p.position], p.number != null && [t('Number'), String(p.number)], p.age != null && [t('Age'), String(p.age)],
    p.height && [t('Height'), p.height], p.weight && [t('Weight'), p.weight], p.college && [t('College'), p.college], p.experience != null && [t('Seasons in the NFL'), String(p.experience)]
  ].filter(Boolean) as [string, string][]
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 pb-28 xl:pb-10">
      <LeagueSwitch />
      <PlayerHeader
        name={p.name}
        photo={p.image && !imgBroken ? p.image : null}
        noPhoto={p.number != null ? <span className="font-display text-4xl font-extrabold text-ink num">{p.number}</span> : undefined}
        teamBadge={d.team ? <TeamLogo team={d.team} size={28} /> : undefined}
        star={<FavStar label fav={nflPlayerFav(p, d.team)} />}
        chips={[
          p.position ? <Chip>{p.position}</Chip> : null,
          p.number != null ? <span className="num">#{p.number}</span> : null
        ].filter(Boolean)}
        team={d.team ? { name: d.team.name, logo: <TeamLogo team={d.team} size={20} />, href: teamHref('american-football', d.team.id, d.team.name)! } : null}
        facts={bio.filter(([k]) => k !== t('Position') && k !== t('Number'))}
      />
      {p.image && !imgBroken && <img src={p.image} alt="" onError={() => setImgBroken(true)} className="hidden" />}
      {d.injury && d.injury.status && (
        <div className={`rounded-2xl border px-4 py-3 text-sm ${/out|ir|reserve/i.test(d.injury.status) ? 'border-loss/40 bg-loss/10' : 'border-draw/40 bg-draw/10'}`}>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`font-bold ${/out|ir|reserve/i.test(d.injury.status) ? 'text-loss' : 'text-draw'}`}>{t('Injury report')}: {d.injury.status}</span>
            {d.injury.date && <span className="text-xs text-faint">{new Date(d.injury.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>}
          </div>
          {d.injury.description && <p className="text-muted mt-0.5">{d.injury.description}</p>}
        </div>
      )}
      <Card title={t('{0} season · {1} games', { 0: d.season, 1: d.games })}>
        {Object.keys(d.totals).length === 0 ? <p className="text-sm text-faint">{t('No game statistics yet this season.')}</p> : (
          <div className="space-y-4">
            {Object.entries(d.totals).map(([g, st]) => (
              <div key={g}>
                <div className="label pb-1">{t(g)}</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(st).map(([k, v]) => <span key={k} className="rounded-lg bg-surface2/70 px-2.5 py-1.5 text-xs"><span className="text-faint">{k}</span> <b className="num text-ink">{v}</b></span>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {d.career && d.career.length > 0 && (() => {
        const cols = CAREER_COLS.filter(c => d.career!.some(s => s.stats[c.key]))
        return (
          <Card title={t('Career by season')}>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm min-w-[480px]">
                <thead><tr className="text-[10px] uppercase tracking-wide text-faint"><th className="text-left font-semibold py-1 px-1">{t('Season')}</th><th className="text-left font-semibold py-1 px-1">{t('Team')}</th><th className="text-right font-semibold py-1 px-1">{t('GP')}</th>{cols.map(c => <th key={c.key} className="text-right font-semibold py-1 px-1">{t(c.label)}</th>)}</tr></thead>
                <tbody>
                  {d.career!.map(s => (
                    <tr key={`${s.season}${s.team?.id}`} className="border-t border-line/50">
                      <td className="py-1.5 px-1 num text-muted">{s.season}</td>
                      <td className="py-1.5 px-1">{s.team ? <span className="flex items-center gap-1.5 min-w-0"><TeamLogo team={s.team} size={14} /><NameLink to={href.nflTeam(s.team.id, s.team.name)} className="truncate text-ink">{s.team.name}</NameLink></span> : '–'}</td>
                      <td className="py-1.5 px-1 text-right num text-muted">{s.games}</td>
                      {cols.map(c => <td key={c.key} className="py-1.5 px-1 text-right num text-ink">{s.stats[c.key] ?? '–'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      })()}
      {d.log.length > 0 && (
        <Card title={t('Game log')}>
          <ul className="divide-y divide-line/50">
            {d.log.map(l => {
              const g = l.game, home = g.home.id === l.teamId, opp = home ? g.away : g.home
              return (
                <li key={g.id} className="py-2 text-sm">
                  <MaybeLink to={matchHref('american-football', g.id, { home: g.home.name, away: g.away.name, homeId: g.home.id, awayId: g.away.id, date: g.kickoff })} className="flex flex-wrap items-center gap-x-3 gap-y-1 hover:text-accent">
                    <span className="w-16 text-xs text-faint">{new Date(g.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                    <span className="flex items-center gap-1.5 min-w-0"><span className="text-xs text-faint">{home ? t('vs') : '@'}</span><TeamLogo team={opp} size={16} /><span className="truncate text-ink">{opp.name}</span></span>
                    {g.score && <span className="num text-muted">{home ? `${g.score.home}–${g.score.away}` : `${g.score.away}–${g.score.home}`}</span>}
                    <span className="basis-full sm:basis-auto sm:ml-auto text-xs text-muted truncate">
                      {Object.entries(l.groups).map(([gn, st]) => `${gn}: ${Object.entries(st).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}`).join(' · ')}
                    </span>
                  </MaybeLink>
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}

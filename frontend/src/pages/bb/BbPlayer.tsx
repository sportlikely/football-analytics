import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { Card, Skeleton, TeamLogo } from './parts'
import PlayerHeader, { Chip } from '../../components/sport/page/PlayerHeader'
import { FavStar } from '../../lib/favorites'
import { bbPlayerFav } from '../../lib/bb'
import type { PhotoCreditT } from '../../components/sport/PlayerPhoto'

interface Side { id: number; name: string; logo: string | null }
interface SeasonRow { code: string; league: string; season: string; team: Side; gp: number; starts: number; min: number | null; pts: number | null; reb: number | null; ast: number | null; fgPct: number | null; tpPct: number | null; ftPct: number | null; tpm: number | null }
interface LogRow {
  gameId: number; kickoff: string; league: string; home: boolean; opponent: string; opponentId: number; opponentLogo: string | null
  result: { for: number; against: number; win: boolean } | null; starter: boolean; min: number | null; pts: number | null; reb: number | null; ast: number | null
  fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null
  stl: number | null; blk: number | null; tov: number | null; plusMinus: number | null; pie: number | null; usg: number | null; net: number | null; ts: number | null
}
interface NbaLine {
  label: string; gp: number | null; min: number | null; pts: number | null; reb: number | null; ast: number | null; stl: number | null; blk: number | null; tov: number | null
  fgPct: number | null; tpPct: number | null; ftPct: number | null; plusMinus: number | null; pie: number | null; usg: number | null; ts: number | null
  ortg: number | null; drtg: number | null; net: number | null; astPct: number | null; rebPct: number | null
  ranks: Record<string, number | null>
}
interface PlayerData {
  player: { id: number; name: string; team: Side; league: { code: string; name: string }; photo?: string | null; photoCredit?: PhotoCreditT | null }
  bio?: { number: string | null; country: string | null; position: string | null; age: number | null } | null
  current: SeasonRow | null
  seasons: SeasonRow[]
  form: { gameId: number; kickoff: string; pts: number; min: number | null }[]
  log: LogRow[]
  nba: {
    bio: { position: string | null; height: string | null; weight: string | null; jersey: string | null; college: string | null; country: string | null; draft: { year: number; round: number | null; pick: number | null } | null }
    season: NbaLine | null
    lastSeason: NbaLine | null
    injury: { status: string; comment: string | null; reported: string | null } | null
    contract: { season: number | null; team: string | null; teamId?: number | null; amount: number | null; type: string | null; status: string | null }[] | null
  } | null
}

const v = (x: number | null | undefined, suf = '') => (x === null || x === undefined ? '–' : `${x}${suf}`)
const signed = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x > 0 ? `+${x}` : `${x}`)
const money = (x: number | null) => (x === null ? '–' : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1000)}K`)

/** A basketball player: season numbers, form, game log; NBA players also bio, advanced stats, ranks, injury and contract. */
export default function BbPlayer() {
  const { id = '' } = useParams()
  const [d, setD] = useState<PlayerData | null | undefined>(undefined)
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/basketball/player/${id}`).then(r => setD(r.data.data)).catch(() => setD(null))
  }, [id])
  useEffect(() => { if (d) document.title = t('{0} · SportLikely', { 0: d.player.name }) }, [d?.player.id])

  if (d === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><Skeleton rows={6} /></div>
  if (!d) return <div className="max-w-6xl mx-auto px-4 py-10 text-muted">{t('Player not found')}</div>
  const nba = d.nba
  const line = nba?.season || nba?.lastSeason || null
  const cur = d.current
  const bio = nba?.bio
  const rb = d.bio || null
  const jersey = bio?.jersey || rb?.number || null

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 pb-28 xl:pb-10">
      {/* header: football's player header (fix152d) */}
      <PlayerHeader
        name={d.player.name}
        photo={d.player.photo || null}
        credit={d.player.photoCredit}
        noPhoto={jersey ? <span className="font-display text-4xl font-extrabold text-ink num">{jersey}</span> : <TeamLogo team={d.player.team} size={56} />}
        teamBadge={<TeamLogo team={d.player.team} size={28} />}
        star={<FavStar label fav={bbPlayerFav(d.player, d.player.team)} />}
        chips={[
          (bio?.position || rb?.position) ? <Chip>{bio?.position || rb?.position}</Chip> : null,
          jersey ? <span className="num">#{jersey}</span> : null,
          nba?.injury ? <Chip tone="out">{nba.injury.status}</Chip> : nba ? <Chip tone="ok">{t('Available')}</Chip> : null
        ].filter(Boolean)}
        team={{ name: d.player.team.name, logo: <TeamLogo team={d.player.team} size={20} />, href: `/basketball/team/${d.player.team.id}` }}
        facts={([
          rb?.age ? [t('Age'), <span className="num">{rb.age}</span>] : null,
          (!bio && rb?.country) ? [t('Nationality'), rb.country] : null,
          [t('League'), <Link to={`/basketball/league/${d.player.league.code}`} className="hover:text-accent">{d.player.league.name}</Link>]
        ] as ([string, ReactNode] | null)[]).filter((x): x is [string, ReactNode] => !!x)}
        note={<>
        {nba?.injury && (
          <div className="mt-3 inline-flex items-start gap-2 rounded-xl bg-loss/10 border border-loss/25 px-3 py-2 text-sm max-w-xl">
            <span className="mt-1.5 w-2 h-2 rounded-full bg-loss shrink-0" />
            <span><b className="text-loss">{nba.injury.status}</b>{nba.injury.reported ? <span className="text-faint"> · {nba.injury.reported}</span> : null}{nba.injury.comment && <span className="block text-xs text-muted line-clamp-3 mt-0.5">{nba.injury.comment}</span>}</span>
          </div>
        )}
        </>}
        aside={<>
        {(line || cur) && (
          <div className="w-full lg:w-[340px] shrink-0">
          <div className="mb-1 text-right text-[11px] text-faint">{t('Per game')} · {line?.label || (cur ? `${cur.code} ${cur.season}` : '')}</div>
          <div className="grid grid-cols-3 gap-2">
            <Big label={t('Points')} value={v(line?.pts ?? cur?.pts)} />
            <Big label={t('Rebounds')} value={v(line?.reb ?? cur?.reb)} />
            <Big label={t('Assists')} value={v(line?.ast ?? cur?.ast)} />
          </div>
          </div>
        )}
        </>}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
        <div className="space-y-6 min-w-0">
          {/* NBA season with ranks */}
          {line && (
            <Card title={t('{0} season', { 0: line.label })} action={<span className="text-xs text-faint">{t('rank among NBA players')}</span>}>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                <RankTile label={t('Points')} value={v(line.pts)} rank={line.ranks.pts} />
                <RankTile label={t('Rebounds')} value={v(line.reb)} rank={line.ranks.reb} />
                <RankTile label={t('Assists')} value={v(line.ast)} rank={line.ranks.ast} />
                <RankTile label={t('Steals')} value={v(line.stl)} rank={line.ranks.stl} />
                <RankTile label={t('Blocks')} value={v(line.blk)} rank={line.ranks.blk} />
              </div>
              <h3 className="mt-6 mb-2 label">{t('Advanced')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <RankTile label="PIE" hint={t('Player impact estimate: share of everything that happened on the court')} value={v(line.pie, '%')} rank={line.ranks.pie} />
                <RankTile label={t('Net rating')} hint={t('Points per 100 possessions: team scored minus allowed with him on the court')} value={signed(line.net)} rank={line.ranks.net} />
                <RankTile label={t('True shooting')} hint={t('Shooting efficiency counting 3-pointers and free throws')} value={v(line.ts, '%')} rank={line.ranks.ts} />
                <RankTile label={t('Usage')} hint={t('Share of team plays he finishes while on the court')} value={v(line.usg, '%')} rank={line.ranks.usg} />
              </div>
              <dl className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
                <Stat k={t('Games')} val={v(line.gp)} />
                <Stat k={t('Minutes')} val={v(line.min)} />
                <Stat k={t('Plus-minus')} val={signed(line.plusMinus)} />
                <Stat k={t('FG%')} val={v(line.fgPct, '%')} />
                <Stat k={t('3P%')} val={v(line.tpPct, '%')} />
                <Stat k={t('FT%')} val={v(line.ftPct, '%')} />
                <Stat k={t('Offensive rating')} val={v(line.ortg)} />
                <Stat k={t('Defensive rating')} val={v(line.drtg)} />
                <Stat k={t('Turnovers')} val={v(line.tov)} />
              </dl>
              {!nba?.season && <p className="mt-3 text-[11px] text-faint">{t('Last season. This season\'s numbers appear after the first games.')}</p>}
            </Card>
          )}

          {/* form */}
          {d.form.length > 1 && (
            <Card title={t('Points, last {0} games', { 0: d.form.length })}>
              <PointsChart form={d.form} />
            </Card>
          )}

          {/* game log */}
          {d.log.length > 0 && <GameLog log={d.log} />}
          {!line && d.seasons.length === 0 && <Card><p className="text-sm text-muted">{t('No games in our leagues yet. His numbers appear here after his first game.')}</p></Card>}
        </div>

        <div className="space-y-6 min-w-0">
          {bio && (
            <Card title={t('Profile')}>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {bio.position && <Stat k={t('Position')} val={bio.position} />}
                {bio.height && <Stat k={t('Height')} val={bio.height.replace('-', "'") + '"'} />}
                {bio.weight && <Stat k={t('Weight')} val={`${bio.weight} lb`} />}
                {bio.country && <Stat k={t('Country')} val={bio.country} />}
                {bio.college && <Stat k={t('College / club')} val={bio.college} />}
                <Stat k={t('Draft')} val={bio.draft ? t('{0}, round {1}, pick {2}', { 0: bio.draft.year, 1: bio.draft.round ?? '–', 2: bio.draft.pick ?? '–' }) : t('Undrafted')} />
              </dl>
            </Card>
          )}

          {nba?.contract && nba.contract.length > 0 && (
            <Card title={t('Contract')}>
              <ul className="divide-y divide-line/50 text-sm">
                {nba.contract.map((c, i) => (
                  <li key={i} className="flex items-center gap-2 py-2">
                    <span className="num text-muted w-16">{c.season ?? '–'}</span>
                    <NameLink to={href.bbTeam(c.teamId)} className="truncate text-muted">{c.team ?? ''}</NameLink>
                    <span className="ml-auto num font-bold text-ink">{money(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* seasons in our data */}
          {d.seasons.length > 0 && (
            <Card title={t('Seasons')}>
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-xs num">
                  <thead>
                    <tr className="text-faint">
                      <th className="text-left font-semibold py-1 px-2">{t('Season')}</th>
                      <th className="text-right font-semibold px-1">{t('GP')}</th>
                      <th className="text-right font-semibold px-1">{t('MIN')}</th>
                      <th className="text-right font-semibold px-1">{t('PTS')}</th>
                      <th className="text-right font-semibold px-1">{t('REB')}</th>
                      <th className="text-right font-semibold px-2">{t('AST')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.seasons.map(s => (
                      <tr key={`${s.code}${s.season}`} className="border-t border-line/40">
                        <td className="py-1.5 px-2 font-sans whitespace-nowrap">
                          <span className="text-ink">{s.season}</span>
                          <span className="ml-1.5 text-[10px] text-faint"><NameLink to={href.bbLeague(s.code)}>{s.code}</NameLink> · <NameLink to={href.bbTeam(s.team.id)}>{s.team.name}</NameLink></span>
                        </td>
                        <td className="text-right px-1 text-muted">{s.gp}</td>
                        <td className="text-right px-1 text-muted">{v(s.min)}</td>
                        <td className="text-right px-1 text-ink font-bold">{v(s.pts)}</td>
                        <td className="text-right px-1 text-muted">{v(s.reb)}</td>
                        <td className="text-right px-2 text-muted">{v(s.ast)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-faint">{t('Games in our leagues, pre-season not counted.')}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface2/70 px-3 py-2 text-center">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="font-display num text-xl font-extrabold text-ink">{value}</div>
    </div>
  )
}

function RankTile({ label, value, rank, hint }: { label: string; value: string; rank: number | null | undefined; hint?: string }) {
  const tone = rank == null ? 'text-faint' : rank <= 10 ? 'text-win' : rank <= 50 ? 'text-accent' : 'text-muted'
  return (
    <div className="rounded-xl bg-surface2/60 px-3 py-2.5" title={hint}>
      <div className="text-[11px] text-faint truncate">{label}</div>
      <div className="font-display num text-xl font-extrabold text-ink">{value}</div>
      <div className={`text-[11px] font-semibold ${tone}`}>{rank == null ? ' ' : t('#{0} in the NBA', { 0: rank })}</div>
    </div>
  )
}

function Stat({ k, val }: { k: string; val: string }) {
  return (
    <div className="rounded-lg bg-surface2/40 px-3 py-2 min-w-0">
      <dt className="text-[11px] text-faint truncate">{k}</dt>
      <dd className="num text-ink font-semibold truncate">{val}</dd>
    </div>
  )
}

function PointsChart({ form }: { form: PlayerData['form'] }) {
  const max = Math.max(10, ...form.map(f => f.pts))
  const avg = form.reduce((a, f) => a + f.pts, 0) / form.length
  return (
    <div>
      <div className="relative flex items-end gap-1.5 h-36">
        <span className="absolute left-0 right-0 border-t border-dashed border-line" style={{ bottom: `${(avg / max) * 100}%` }} />
        {form.map(f => (
          <Link key={f.gameId} to={`/basketball/game/${f.gameId}`} className="group relative flex-1 h-full flex items-end" title={`${new Date(f.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}: ${f.pts} pts, ${f.min ?? '–'} min`}>
            <span className={`w-full rounded-t-md ${f.pts >= avg ? 'bg-accent' : 'bg-accent/40'} group-hover:opacity-80`} style={{ height: `${Math.max(3, (f.pts / max) * 100)}%` }} />
            <span className="absolute -top-4 left-0 right-0 text-center text-[10px] num text-muted">{f.pts}</span>
          </Link>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-faint">{t('Dashed line: his average over these games ({0}). Tap a bar for the game.', { 0: Math.round(avg * 10) / 10 })}</p>
    </div>
  )
}

function GameLog({ log }: { log: LogRow[] }) {
  const more = log.some(r => r.plusMinus !== null)
  return (
    <Card title={t('Game log')}>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-xs num">
          <thead>
            <tr className="text-faint">
              <th className="text-left font-semibold py-1 px-2">{t('Game')}</th>
              <th className="text-right font-semibold px-1">{t('MIN')}</th>
              <th className="text-right font-semibold px-1">{t('PTS')}</th>
              <th className="text-right font-semibold px-1">{t('REB')}</th>
              <th className="text-right font-semibold px-1">{t('AST')}</th>
              <th className="text-right font-semibold px-1">{t('FG')}</th>
              <th className="text-right font-semibold px-1">{t('3PT')}</th>
              {more && <><th className="text-right font-semibold px-1">{t('STL')}</th><th className="text-right font-semibold px-1">{t('BLK')}</th><th className="text-right font-semibold px-1">{t('TO')}</th><th className="text-right font-semibold px-1">+/−</th><th className="text-right font-semibold px-2">PIE</th></>}
            </tr>
          </thead>
          <tbody>
            {log.map(r => (
              <tr key={r.gameId} className="border-t border-line/40 hover:bg-surface2/40">
                <td className="py-1.5 px-2 font-sans whitespace-nowrap">
                  <Link to={`/basketball/game/${r.gameId}`} className="flex items-center gap-1.5">
                    <span className="text-faint w-12 num">{new Date(r.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                    <span className="text-faint">{r.home ? t('vs') : '@'}</span>
                    <TeamLogo team={{ name: r.opponent, logo: r.opponentLogo }} size={14} />
                    <span className="text-ink truncate max-w-[110px]">{r.opponent}</span>
                    {r.result && <span className={`ml-1 font-bold ${r.result.win ? 'text-win' : 'text-loss'}`}>{r.result.win ? t('W') : t('L')} {r.result.for}–{r.result.against}</span>}
                  </Link>
                </td>
                <td className="text-right px-1 text-muted">{r.min !== null ? Math.round(r.min) : '–'}</td>
                <td className="text-right px-1 text-ink font-bold">{v(r.pts)}</td>
                <td className="text-right px-1 text-muted">{v(r.reb)}</td>
                <td className="text-right px-1 text-muted">{v(r.ast)}</td>
                <td className="text-right px-1 text-muted">{r.fgm ?? 0}/{r.fga ?? 0}</td>
                <td className="text-right px-1 text-muted">{r.tpm ?? 0}/{r.tpa ?? 0}</td>
                {more && <>
                  <td className="text-right px-1 text-muted">{v(r.stl)}</td>
                  <td className="text-right px-1 text-muted">{v(r.blk)}</td>
                  <td className="text-right px-1 text-muted">{v(r.tov)}</td>
                  <td className={`text-right px-1 ${r.plusMinus == null ? 'text-faint' : r.plusMinus > 0 ? 'text-win' : r.plusMinus < 0 ? 'text-loss' : 'text-muted'}`}>{signed(r.plusMinus)}</td>
                  <td className="text-right px-2 text-muted">{v(r.pie)}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

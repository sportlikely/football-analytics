import { useEffect, useState, type ReactNode } from 'react'
import { useEntityId } from '../../components/SlugRoute'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { FavStar } from '../../lib/favorites'
import { tennisPlayerFav, tennisHref, flagOf, surfaceName, countryName, type TMatch } from '../../lib/tennis'
import { Skeleton, LockIcon } from '../bb/parts'
import PlayerHeader, { Chip } from '../../components/sport/page/PlayerHeader'
import { TCard as Card } from '../../components/sport/page/TeamPage'
import GameRow from '../../components/sport/GameRow'
import RecordLink from '../../components/RecordLink'
import { useNews, NewsRows } from '../../components/NewsList'
import { tennisSGame } from '../../components/sport/games/tennis'
import { FormList, type Played } from './parts'
import { TeamDifficulty } from '../../components/sport/game/GameExtras'

interface Measure { id: string; label: string; value: number | null; text: string | null; rank: number | null; of: number | null; score: number | null }
interface Analysis { matches: number; measures: Measure[]; strengths: Measure[]; weaknesses: Measure[]; locked?: boolean; notesCount?: number }
interface Model { elo: number; rank: number; of: number; surfaces: { surface: string; elo: number; matches: number }[]; serve: number; ret: number; tourServe: number; form: { won: number; played: number }; matches: number }
interface Data {
  player: { id: number; name: string; country: string | null; hand: string | null; age: number | null; height: number | null; tour: 'atp' | 'wta'; women: boolean; rank: number | null; points: number | null
    photo?: string | null }
  rankTrend: { date: string; rank: number }[]
  season: { year: number; won: number; lost: number }
  form: ('W' | 'L')[]
  model: Model | null; modelLocked: boolean
  analysis: Analysis | null
  recent: Played[]; upcoming: TMatch[]
  stoppages: { kind: 'medical' | 'retired' | 'other'; at: string; matchId: number; tournament: string | null; link: string }[]
  record: { games: number; right: number; strong: number; strongRight: number }
  /** fix193c: the ranking around the player (the team page's mini table) and the titles in our data (career) */
  around: { tour: 'atp' | 'wta'; date: string; rows: { rank: number; id: number | null; name: string; country: string | null; points: number | null; me: boolean }[] } | null
  titles: { matchId: number; year: number; tournament: string; key: string; tier: string; surface: string | null }[]
}

/** Strength / weakness sentences (fixed rules): what the number says, the value and the rank on the tour (52 weeks). */
const SENTENCE: Record<string, { good: string; bad: string }> = {
  win: { good: 'Wins a lot: {0} of matches in the last 52 weeks (#{1} of {2}).', bad: 'Loses more than most: wins {0} of matches (#{1} of {2}).' },
  svc: { good: 'Strong serve: wins {0} of service points (#{1} of {2}).', bad: 'Weak serve: wins only {0} of service points (#{1} of {2}).' },
  ret: { good: 'Strong returner: wins {0} of return points (#{1} of {2}).', bad: 'Struggles on return: wins {0} of return points (#{1} of {2}).' },
  hold: { good: 'Rarely broken: holds {0} of service games (#{1} of {2}).', bad: 'Broken often: holds only {0} of service games (#{1} of {2}).' },
  brk: { good: 'Breaks often: wins {0} of return games (#{1} of {2}).', bad: 'Rarely breaks: wins {0} of return games (#{1} of {2}).' },
  bps: { good: 'Calm under pressure: saves {0} of break points (#{1} of {2}).', bad: 'Loses the big points on serve: saves {0} of break points (#{1} of {2}).' },
  bpc: { good: 'Takes the chances: converts {0} of break points (#{1} of {2}).', bad: 'Wastes chances: converts {0} of break points (#{1} of {2}).' },
  tb: { good: 'Good in tiebreaks: wins {0} of them (#{1} of {2}).', bad: 'Weak in tiebreaks: wins {0} of them (#{1} of {2}).' }
}
const HAND: Record<string, string> = { R: 'Right-handed', L: 'Left-handed' }
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()

/**
 * Tennis player page (fix193b): football's player header, then the team page's two columns — how our model rates them,
 * the 1–10 scores with strengths and weaknesses (paid; a locked preview for the rest) and the recent results on the
 * left; our record on the player, the next match, the ranking over 12 months, stoppages and news on the right.
 */
export default function TennisPlayer() {
  const id = useEntityId()
  const [d, setD] = useState<Data | null | undefined>(undefined)
  const news = useNews({ sport: 'tennis', playerId: id, limit: 8 })
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/tennis/player/${id}`).then(r => {
      setD(r.data.data)
      document.title = t('{0} · SportLikely', { 0: r.data.data.player.name })
    }).catch(() => setD(null))
  }, [id])
  if (d === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><Skeleton rows={6} /></div>
  if (!d) return <div className="max-w-6xl mx-auto px-4 py-10 text-muted">{t('Player not found')}</div>
  const p = d.player
  const flag = flagOf(p.country)
  const tour = p.women ? 'WTA' : 'ATP'
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 pb-28 xl:pb-10">
      <PlayerHeader
        name={p.name}
        photo={p.photo || null}
        noPhoto={<span className="font-display text-3xl font-extrabold text-ink">{initials(p.name)}</span>}
        teamBadge={flag ? <span className="text-xl" aria-hidden>{flag}</span> : undefined}
        star={<FavStar label fav={tennisPlayerFav(p)} />}
        chips={[
          <Chip>{tour}</Chip>,
          p.rank ? <span className="num font-semibold text-muted">{t('No. {0}', { 0: p.rank })}</span> : null,
          p.hand && HAND[p.hand] ? <Chip>{t(HAND[p.hand])}</Chip> : null
        ].filter(Boolean)}
        facts={([
          p.age ? [t('Age'), <span className="num">{p.age}</span>] : null,
          // fix195: the country's name ("Peru"), never the code
          p.country ? [t('Country'), <span>{flag} {countryName(p.country)}</span>] : null,
          p.points ? [t('Ranking points'), <span className="num">{p.points.toLocaleString(LOCALE)}</span>] : null,
          [t('{0} season', { 0: d.season.year }), <span className="num">{t('{0} won · {1} lost', { 0: d.season.won, 1: d.season.lost })}</span>],
          p.height ? [t('Height'), <span className="num">{p.height} cm</span>] : null
        ] as ([string, ReactNode] | null)[]).filter((x): x is [string, ReactNode] => !!x)}
        note={d.form.length > 0 ? (
          <div className="flex items-center gap-1.5 pt-1" aria-label={t('Form, last')}>
            {d.form.map((r, i) => <span key={i} className={`w-6 h-6 rounded-md grid place-items-center font-display text-[10px] font-extrabold text-[#07090D] ${r === 'W' ? 'bg-win' : 'bg-loss'}`}>{r === 'W' ? t('W') : t('L')}</span>)}
          </div>
        ) : undefined}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
        <div className="space-y-6 min-w-0">
          <ModelCard d={d} />
          {d.analysis && <AnalysisCard a={d.analysis} />}
          <Card title={t('Recent results')}><FormList list={d.recent} empty={t('No finished matches yet.')} /></Card>
          {d.titles.length > 0 && (
            <Card title={t('Titles')} action={<span className="text-xs text-faint">{t('in our data')}</span>}>
              <ul className="divide-y divide-line/50">
                {d.titles.map(x => (
                  <li key={x.matchId} className="flex items-center gap-3 py-1.5 text-sm min-w-0">
                    <span className="w-10 num text-faint shrink-0">{x.year}</span>
                    <Link to={tennisHref.tournament(x.key)} className="min-w-0 truncate font-semibold text-ink hover:text-accent">{x.tournament}</Link>
                    <span className="ml-auto shrink-0 text-xs text-muted">{[x.tier, surfaceName(x.surface)].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-6 min-w-0">
          <RecordCard d={d} />
          {/* fix231: the next matches coloured by our win chance */}
          <TeamDifficulty sport="tennis" id={d.player.id} />
          {d.upcoming.length > 0 && (
            <Card title={t('Next match')}>
              <div className="-mx-5 sm:-mx-6 divide-y divide-line/50">{d.upcoming.map(m => <GameRow key={m.id} g={tennisSGame(m)} showComp showDay />)}</div>
            </Card>
          )}
          {d.around && d.around.rows.length > 1 && (
            <Card title={t('{0} ranking', { 0: d.around.tour.toUpperCase() })} action={<Link to={`/tennis/rankings${d.around.tour === 'wta' ? '?tour=wta' : ''}`} className="text-xs font-bold text-accent">{t('Full rankings →')}</Link>}>
              <ul className="divide-y divide-line/50">
                {d.around.rows.map(r => (
                  <li key={r.rank} className={`flex items-center gap-2 py-1.5 text-sm min-w-0 ${r.me ? 'bg-accent/10 -mx-2 px-2 rounded-lg' : ''}`}>
                    <span className="w-8 num text-faint shrink-0">{r.rank}</span>
                    {r.id && !r.me ? <Link to={tennisHref.player(r.id, r.name)!} className="min-w-0 truncate text-ink hover:text-accent">{flagOf(r.country)} {r.name}</Link> : <span className={`min-w-0 truncate ${r.me ? 'font-bold text-ink' : 'text-ink'}`}>{flagOf(r.country)} {r.name}</span>}
                    <span className="ml-auto num text-xs text-muted shrink-0">{r.points !== null ? r.points.toLocaleString(LOCALE) : ''}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.rankTrend.length > 1 && <RankCard d={d} />}
          <Card title={t('Stoppages')} action={<span className="text-xs text-faint">{t('last 12 months')}</span>}>
            {!d.stoppages.length ? <p className="text-sm text-faint">{t('No medical timeouts or retirements in the last 12 months.')}</p> : (
              <ul className="divide-y divide-line/50">
                {d.stoppages.map(s => (
                  <li key={`${s.matchId}${s.kind}${s.at}`} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className={s.kind === 'retired' ? 'text-loss font-semibold' : 'text-ink'}>{s.kind === 'medical' ? t('Medical timeout') : s.kind === 'retired' ? t('Retired') : t('Stoppage')}</span>
                    <Link to={s.link} className="min-w-0 truncate text-xs text-muted hover:text-accent">{[s.tournament, new Date(s.at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })].filter(Boolean).join(' · ')}</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {(news === null || news === undefined || news.length > 0) && (
            <Card title={t('{0} news', { 0: p.name })}>
              {news === null ? <Skeleton rows={3} h="h-14" /> : news && news.length ? <div className="-mx-2"><NewsRows items={news} /></div> : null}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/** "How our model rates them": overall and surface ratings, serve, return, form (paid plans; a lock for the rest) */
function ModelCard({ d }: { d: Data }) {
  const m = d.model
  if (d.modelLocked) {
    return (
      <Card title={t('How our model rates them')}>
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-ink flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2"><LockIcon /> {t('Model ratings on every surface, serve and return strength and win chances are for Premium members.')}</span>
          <Link to="/premium" className="px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-extrabold">{t('Go Premium')}</Link>
        </div>
      </Card>
    )
  }
  if (!m) return null
  const next = d.upcoming.find(x => x.state === 'upcoming')
  const np = next?.prediction
  const me = next ? (next.home.id === d.player.id ? 'home' : 'away') : null
  const nextPct = np && !np.locked && typeof np.pHome === 'number' && me ? (me === 'home' ? np.pHome : np.pAway!) : null
  const tiles: { label: string; value: ReactNode; sub: ReactNode }[] = [
    { label: t('Overall rating'), value: String(m.elo), sub: t('#{0} of {1} on the tour', { 0: m.rank, 1: m.of }) },
    ...m.surfaces.map(s => ({ label: surfaceName(s.surface), value: s.matches > 0 ? String(s.elo) : '–', sub: t('{n, plural, one {# match} other {# matches}}', { n: s.matches }) })),
    { label: t('Serve'), value: `${m.serve}%`, sub: t('service points won · tour {0}%', { 0: m.tourServe }) },
    { label: t('Return'), value: `${m.ret}%`, sub: t('return points won · tour {0}%', { 0: Math.round((100 - m.tourServe) * 10) / 10 }) },
    { label: t('Form'), value: t('{0} of {1}', { 0: m.form.won, 1: m.form.played }), sub: t('won, last 10') }
  ]
  if (next && nextPct !== null) {
    const opp = me === 'home' ? next.away : next.home
    tiles.push({ label: t('Win chance next match'), value: `${Math.round(nextPct)}%`, sub: <>{t('vs')} {opp.id ? <Link to={tennisHref.player(opp.id, opp.name)!} className="hover:text-accent">{opp.name}</Link> : opp.name}</> })
  }
  return (
    <Card title={t('How our model rates them')} action={<span className="text-xs text-faint">{t('1500 is a typical tour player')}</span>}>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
        {tiles.map(x => (
          <div key={String(x.label)} className="rounded-xl border border-line/70 bg-surface2/40 px-4 py-3 min-w-0">
            <div className="text-xs text-muted">{x.label}</div>
            <div className="font-display text-lg font-extrabold text-ink leading-tight break-words num">{x.value}</div>
            {x.sub && <div className="text-[11px] text-faint mt-0.5">{x.sub}</div>}
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Player analysis (fixed rules): 1–10 scores against the tour, strengths and weaknesses — paid; the rest a preview */
function AnalysisCard({ a }: { a: Analysis }) {
  if (a.locked) {
    return (
      <Card title={t('Player analysis')} action={<span className="text-xs text-faint">{t('last 52 weeks')}</span>}>
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4 text-sm text-ink space-y-3">
          <p className="flex items-start gap-2"><LockIcon /> <span>{t('1–10 tour scores for serve, return, holds, breaks, break points and tiebreaks')}{a.notesCount ? t(', and {0} strengths and weaknesses we found in the numbers', { 0: a.notesCount }) : ''}.</span></p>
          <Link to="/premium" className="inline-block px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-extrabold">{t('Go Premium')}</Link>
        </div>
      </Card>
    )
  }
  const line = (m: Measure, good: boolean) => t((good ? SENTENCE[m.id]?.good : SENTENCE[m.id]?.bad) || '{0}', { 0: m.text ?? '–', 1: m.rank ?? '–', 2: m.of ?? '–' })
  return (
    <Card title={t('Player analysis')} action={<span className="text-xs text-faint">{t('last 52 weeks · 1 = tour worst, 10 = tour best')}</span>}>
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
          <p className="text-[11px] text-faint">{t('From {n, plural, one {# match} other {# matches}} with full stats.', { n: a.matches })}</p>
        </div>
      </div>
    </Card>
  )
}

/** the ranking over the last 12 months (one point per rankings table; 1 at the top) */
function RankCard({ d }: { d: Data }) {
  const r = d.rankTrend
  const lo = Math.min(...r.map(x => x.rank)), hi = Math.max(...r.map(x => x.rank))
  const W = 300, H = 90
  const x = (i: number) => 8 + (i / Math.max(1, r.length - 1)) * (W - 16)
  const y = (k: number) => 8 + (hi === lo ? 0.5 : (k - lo) / (hi - lo)) * (H - 16)
  const first = r[0], last = r[r.length - 1]
  const move = first.rank - last.rank
  return (
    <Card title={t('Ranking, last 12 months')} action={<span className={`text-xs font-bold num ${move > 0 ? 'text-win' : move < 0 ? 'text-loss' : 'text-faint'}`}>{move > 0 ? `▲ ${move}` : move < 0 ? `▼ ${-move}` : '='}</span>}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" role="img" aria-label={t('Ranking, last 12 months')}>
        <polyline fill="none" stroke="rgb(var(--accent))" strokeWidth="2" points={r.map((p, i) => `${x(i)},${y(p.rank)}`).join(' ')} />
        {r.map((p, i) => <circle key={p.date} cx={x(i)} cy={y(p.rank)} r="2.5" fill="rgb(var(--accent))"><title>{`${new Date(p.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}: #${p.rank}`}</title></circle>)}
      </svg>
      <div className="flex justify-between text-[11px] text-faint num">
        <span>{new Date(first.date).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' })}: #{first.rank}</span>
        <span>{t('now')}: <b className="text-ink">#{last.rank}</b></span>
      </div>
    </Card>
  )
}

/** our record on the player (public, like the team pages): predictions saved before the start, finished matches */
function RecordCard({ d }: { d: Data }) {
  const r = d.record
  return (
    <Card title={t('Our record on {0}', { 0: d.player.name })} action={<RecordLink to="/tennis/accuracy" className="text-xs font-bold text-accent">{t('Full record →')}</RecordLink>}>
      {!r.games ? <p className="text-sm text-faint">{t('No finished matches with a saved prediction yet.')}</p> : (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl bg-surface2/60 p-3.5">
            <div className="text-[11px] text-faint">{t('Winner, {n, plural, one {# match} other {# matches}}', { n: r.games })}</div>
            <div className="font-display font-extrabold text-xl mt-1">{Math.round((r.right / r.games) * 100)}%</div>
            <div className="text-[11px] text-muted">{t('{0} right', { 0: r.right })}</div>
          </div>
          {r.strong > 0 && (
            <div className="rounded-2xl bg-surface2/60 p-3.5">
              <div className="text-[11px] text-faint">{t('Strong picks')}</div>
              <div className="font-display font-extrabold text-xl mt-1">{Math.round((r.strongRight / r.strong) * 100)}%</div>
              <div className="text-[11px] text-muted">{t('{n, plural, one {# match} other {# matches}}', { n: r.strong })}</div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

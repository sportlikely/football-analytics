import { Link } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import { t, ltr } from '../../lib/i18n'
import type { BbGame as Game } from '../../lib/bb'
import { Card, TeamLogo } from './parts'
import ModelParts from '../../components/sport/game/ModelParts'
import { teamHref, playerHref } from '../../lib/links'

/** Extra sections of the basketball game page (Oct 2026): points markets, team comparison, players, model table. */

export interface Markets {
  bands: { lo: number; hi: number; home: number; away: number }[]
  overtime: number
  spreads: { line: number; home: number; away: number }[]
  totals: { line: number; over: number }[]
  teamTotals: { home: { line: number; over: number }[]; away: { line: number; over: number }[] }
  firstHalf: { home: number; away: number; margin: number; total: number }
  sigma: number
  sigmaTotal: number
}
export interface ModelInfo { version: string; avgPoints: number; homeEdge: number; b2b: number; gamesRated: number }
export interface GamePlayer {
  id: number; name: string; number: string | null; position: string | null; injury: string | null
  statsFrom: 'current' | { season: string; league: string | null } | null
  gp: number; min: number | null; pts: number | null; reb: number | null; ast: number | null; fgPct: number | null; tpPct: number | null
  pie: number | null; usg: number | null; net: number | null
}
interface StandRow { position: number; team: { id: number }; won: number; lost: number }
interface Side {
  splits: { won: number; lost: number; homeWon: number; homeLost: number; awayWon: number; awayLost: number; games: number; closeWon: number; closeLost: number }
  streak: { kind: 'W' | 'L'; n: number } | null
  last10: { won: number; lost: number }
  pointsFor: number | null; pointsAgainst: number | null
  ranks: { attack: number; defence: number; overall: number; of: number } | null
  previousSeason: boolean; season: string
}

const pctTxt = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)}%`

/** Bar split between the two sides (home colour left, away colour right). */
function Split({ h, a }: { h: number; a: number }) {
  const s = h + a || 1
  return (
    <div className="flex h-1.5 gap-[2px] mt-1">
      <div className="rounded-full bg-home" style={{ width: `${(h / s) * 100}%` }} />
      <div className="rounded-full bg-away" style={{ width: `${(a / s) * 100}%` }} />
    </div>
  )
}

/** Points markets: margin bands, spreads, totals, team points, overtime and the first half. */
export function MarketsCard({ g, m }: { g: Game; m: Markets }) {
  const H = g.home.name, A = g.away.name
  return (
    <Card title={t('Points markets')} action={<span className="text-xs text-faint">{t('from our prediction')}</span>}>
      <div className="grid gap-6 md:grid-cols-2">
        {/* winning margin */}
        <div>
          <div className="label mb-3">{t('Winning margin')}</div>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-x-3 text-[11px] font-bold mb-1.5"><span className="truncate text-home">{H}</span><span /><span className="truncate text-end text-away">{A}</span></div>
          <ul className="space-y-2">
            {m.bands.map(b => (
              <li key={b.lo} className="grid grid-cols-[1fr_auto_1fr] gap-x-3 items-center text-sm">
                <span className="num text-ink font-semibold">{pctTxt(b.home)}</span>
                <span className="text-[11px] text-faint text-center w-24">{b.hi >= 99 ? t('by {0}+', { 0: b.lo }) : t('by {0}–{1}', { 0: b.lo, 1: b.hi })}</span>
                <span className="num text-end text-ink font-semibold">{pctTxt(b.away)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between text-sm rounded-xl bg-surface2/50 px-3 py-2">
            <span className="text-muted">{t('Overtime')}</span><b className="num text-ink">{pctTxt(m.overtime)}</b>
          </div>
        </div>

        {/* spreads */}
        <div>
          <div className="label mb-3">{t('Wins by more than…')}</div>
          <ul className="space-y-2.5">
            {m.spreads.map(s => (
              <li key={s.line} className="text-sm">
                <div className="grid grid-cols-[1fr_auto_1fr] gap-x-3 items-center">
                  <span className="num text-ink font-semibold">{pctTxt(s.home)}</span>
                  <span className="text-[11px] text-faint text-center w-24">{s.line} {t('pts')}</span>
                  <span className="num text-end text-ink font-semibold">{pctTxt(s.away)}</span>
                </div>
                <Split h={s.home} a={s.away} />
              </li>
            ))}
          </ul>
        </div>

        {/* total points */}
        <div>
          <div className="label mb-3">{t('Total points')}</div>
          <ul className="space-y-2">
            {m.totals.map(x => (
              <li key={x.line} className="text-sm">
                <div className="flex items-center justify-between"><span className="text-muted">{t('Over')} <span className="num">{x.line}</span></span><b className="num text-ink">{pctTxt(x.over)}</b></div>
                <div className="h-1.5 mt-1 rounded-full bg-surface2 overflow-hidden"><div className="h-full rounded-full bg-accent" style={{ width: `${x.over}%` }} /></div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-faint">{t('Under = 100% minus over.')}</p>
        </div>

        {/* team points + first half */}
        <div className="space-y-5">
          <div>
            <div className="label mb-3">{t('Points per team')}</div>
            {(['home', 'away'] as const).map(s => (
              <div key={s} className="mb-3 last:mb-0">
                <div className={`text-xs font-bold mb-1 ${s === 'home' ? 'text-home' : 'text-away'}`}>{s === 'home' ? H : A}</div>
                <div className="grid grid-cols-3 gap-2">
                  {m.teamTotals[s].map(x => (
                    <div key={x.line} className="rounded-lg bg-surface2/60 border border-line/50 px-2 py-1.5 text-center">
                      <div className="text-[10px] text-faint">{t('Over')} {x.line}</div>
                      <div className="num text-sm font-bold text-ink">{pctTxt(x.over)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="label mb-2">{t('First half')}</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-surface2/60 border border-line/50 px-2 py-1.5"><div className="text-[10px] text-faint truncate">{H}</div><div className="num text-sm font-bold text-home">{pctTxt(m.firstHalf.home)}</div></div>
              <div className="rounded-lg bg-surface2/60 border border-line/50 px-2 py-1.5"><div className="text-[10px] text-faint">{t('Total')}</div><div className="num text-sm font-bold text-ink">{m.firstHalf.total}</div></div>
              <div className="rounded-lg bg-surface2/60 border border-line/50 px-2 py-1.5"><div className="text-[10px] text-faint truncate">{A}</div><div className="num text-sm font-bold text-away">{pctTxt(m.firstHalf.away)}</div></div>
            </div>
            <p className="mt-2 text-[11px] text-faint">{t('Leading at half-time; a tie at the break is the rest.')}</p>
          </div>
        </div>
      </div>
      <p className="mt-5 text-[11px] text-faint">{t('All from the same model as the win chance: margin and total follow a bell curve around our prediction (typical miss: {0} points on the margin, {1} on the total).', { 0: m.sigma, 1: m.sigmaTotal })}</p>
    </Card>
  )
}

/** Head-to-head in numbers: table, record, form, venue record, points and ranks. */
export function CompareCard({ g, home, away, table, form }: {
  g: Game; home: Side; away: Side; table: StandRow[] | null; form: { home: ('W' | 'L')[]; away: ('W' | 'L')[] } | null
}) {
  const rowOf = (id: number) => table?.find(r => r.team.id === id) || null
  const th = rowOf(g.home.id), ta = rowOf(g.away.id)
  type R = { label: string; h: string; a: string; hv?: number; av?: number; lower?: boolean }
  const rows: R[] = []
  if (th && ta) rows.push({ label: t('League position'), h: `${th.position}.`, a: `${ta.position}.`, hv: th.position, av: ta.position, lower: true })
  const s = (x: Side) => x.splits
  if (s(home).games || s(away).games) {
    rows.push({ label: home.previousSeason || away.previousSeason ? t('Record (last season)') : t('Record'), h: `${s(home).won}–${s(home).lost}`, a: `${s(away).won}–${s(away).lost}`, hv: s(home).won / Math.max(1, s(home).games), av: s(away).won / Math.max(1, s(away).games) })
    rows.push({ label: t('At home / on the road'), h: `${s(home).homeWon}–${s(home).homeLost}`, a: `${s(away).awayWon}–${s(away).awayLost}`, hv: s(home).homeWon / Math.max(1, s(home).homeWon + s(home).homeLost), av: s(away).awayWon / Math.max(1, s(away).awayWon + s(away).awayLost) })
    rows.push({ label: t('Last 10'), h: `${home.last10.won}–${home.last10.lost}`, a: `${away.last10.won}–${away.last10.lost}`, hv: home.last10.won, av: away.last10.won })
    rows.push({ label: t('Close games (5 points or less)'), h: `${s(home).closeWon}–${s(home).closeLost}`, a: `${s(away).closeWon}–${s(away).closeLost}` })
  }
  if (home.pointsFor !== null && away.pointsFor !== null) rows.push({ label: t('Points scored per game'), h: String(home.pointsFor), a: String(away.pointsFor), hv: home.pointsFor, av: away.pointsFor })
  if (home.pointsAgainst !== null && away.pointsAgainst !== null) rows.push({ label: t('Points allowed per game'), h: String(home.pointsAgainst), a: String(away.pointsAgainst), hv: home.pointsAgainst, av: away.pointsAgainst, lower: true })
  if (home.ranks && away.ranks) {
    rows.push({ label: t('Attack rank'), h: `${home.ranks.attack}`, a: `${away.ranks.attack}`, hv: home.ranks.attack, av: away.ranks.attack, lower: true })
    rows.push({ label: t('Defence rank'), h: `${home.ranks.defence}`, a: `${away.ranks.defence}`, hv: home.ranks.defence, av: away.ranks.defence, lower: true })
    rows.push({ label: t('Overall rank'), h: `${home.ranks.overall}`, a: `${away.ranks.overall}`, hv: home.ranks.overall, av: away.ranks.overall, lower: true })
  }
  const streak = (x: Side) => (x.streak && x.streak.n >= 2 ? `${x.streak.kind === 'W' ? t('W') : t('L')}${x.streak.n}` : '–')
  rows.push({ label: t('Streak'), h: streak(home), a: streak(away) })
  if (rows.length < 3) return null
  return (
    <Card title={t('Team comparison')} action={<span className="text-xs text-faint">{home.season}</span>}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 mb-4">
        {(['H', 'A'] as const).map((sd, i) => {
          const team = sd === 'H' ? g.home : g.away
          const f = form ? (sd === 'H' ? form.home : form.away) : []
          return (
            <div key={sd} className={`flex flex-col sm:flex-row items-center gap-2 sm:gap-3 min-w-0 text-center ${i === 1 ? 'order-3 sm:flex-row-reverse sm:text-end' : 'sm:text-start'}`}>
              <span className="w-11 h-11 rounded-2xl bg-surface2/80 border border-line/60 grid place-items-center shrink-0"><TeamLogo team={team} size={28} /></span>
              <span className="min-w-0 max-w-full">
                <NameLink to={href.bbTeam(team.id, team.name)} className="block text-sm font-bold text-ink leading-tight line-clamp-2">{team.name}</NameLink>
                {f.length > 0 && <span className={`mt-1 flex justify-center ${i === 1 ? 'sm:justify-end' : 'sm:justify-start'}`}><FormDots f={f} /></span>}
              </span>
            </div>
          )
        })}
        <span className="order-2 self-center text-[10px] font-extrabold tracking-widest text-faint">VS</span>
      </div>
      <ul className="divide-y divide-line/40">
        {rows.map(r => {
          const better = r.hv === undefined || r.av === undefined || r.hv === r.av ? 0 : (r.hv > r.av) !== !!r.lower ? -1 : 1
          return (
            <li key={r.label} className="grid grid-cols-[1fr_auto_1fr] gap-x-3 items-center py-2 text-sm">
              <span className={`num ${better === -1 ? 'text-ink font-bold' : 'text-muted'}`}>{r.h}</span>
              <span className="text-[11px] leading-tight text-faint text-center w-28 sm:w-40">{r.label}</span>
              <span className={`num text-end ${better === 1 ? 'text-ink font-bold' : 'text-muted'}`}>{r.a}</span>
            </li>
          )
        })}
      </ul>
      {home.ranks && <p className="mt-3 text-[11px] text-faint">{t('Ranks from our ratings, out of {0} teams (1 = best).', { 0: home.ranks.of })}</p>}
    </Card>
  )
}

function FormDots({ f }: { f: ('W' | 'L')[] }) {
  return <div className="flex gap-[3px] sm:gap-1">{f.map((r, i) => <span key={i} className={`w-4 h-4 sm:w-5 sm:h-5 rounded text-[9px] sm:text-[10px] font-bold grid place-items-center ${r === 'W' ? 'bg-win text-bg' : 'bg-loss text-bg'}`}>{r === 'W' ? t('W') : t('L')}</span>)}</div>
}

/** Each team's key players (season averages): the top scorer up front, then everyone with a points bar; injury flags; links to the player pages. */
export function PlayersCard({ g, home, away, limit, title }: { g: Game; home: GamePlayer[]; away: GamePlayer[]; limit: number; title: string }) {
  if (!home.length && !away.length) return null
  const adv = [...home, ...away].some(p => p.pie !== null)
  const side = (s: 'H' | 'A', team: Game['home'], list: GamePlayer[]) => {
    const rows = list.slice(0, limit)
    const top = rows.reduce<GamePlayer | null>((m, p) => (p.pts !== null && (!m || (m.pts ?? -1) < p.pts) ? p : m), null)
    const max = Math.max(1, ...rows.map(p => p.pts ?? 0))
    const tone = s === 'H' ? { text: 'text-home', bg: 'bg-home', soft: 'from-home/20' } : { text: 'text-away', bg: 'bg-away', soft: 'from-away/20' }
    const tag = (p: GamePlayer) => (
      <>
        {p.injury && <span className="ms-1.5 rounded px-1 py-px text-[9px] font-bold bg-loss/15 text-loss align-middle">{p.injury}</span>}
        {p.statsFrom && p.statsFrom !== 'current' && <span className="ms-1.5 rounded px-1 py-px text-[9px] text-faint bg-surface2 align-middle">{p.statsFrom.season}</span>}
      </>
    )
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-1 h-6 rounded-full ${tone.bg}`} />
          <TeamLogo team={team} size={22} />
          <Link to={teamHref('basketball', team.id, team.name)!} className="font-display font-bold text-ink hover:text-accent truncate">{team.name}</Link>
        </div>
        {rows.length === 0 ? <p className="text-sm text-faint">{t('No player stats yet.')}</p> : (
          <>
            {top && (
              <Link to={playerHref('basketball', top.id, top.name)!} className={`group flex items-center gap-3 rounded-2xl border border-line/60 bg-gradient-to-r rtl:bg-gradient-to-l ${tone.soft} to-transparent p-3 mb-3 hover:border-accent/40 transition-colors`}>
                <span className={`w-12 h-12 rounded-xl grid place-items-center font-display text-lg font-extrabold text-bg shrink-0 ${tone.bg}`}>{top.number ?? '★'}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-faint">{t('Top scorer')}{top.position ? ` · ${top.position}` : ''}</span>
                  <span className="block font-bold text-ink truncate group-hover:text-accent">{top.name}{tag(top)}</span>
                </span>
                <span className="flex gap-3 text-center shrink-0">
                  {([['PTS', top.pts], ['REB', top.reb], ['AST', top.ast]] as const).map(([k, v], i) => (
                    <span key={k}>
                      <span className={`block num leading-none ${i === 0 ? `text-xl font-extrabold ${tone.text}` : 'text-sm font-bold text-ink mt-1'}`}>{v ?? '–'}</span>
                      <span className="block text-[9px] font-semibold text-faint mt-1">{t(k)}</span>
                    </span>
                  ))}
                </span>
              </Link>
            )}
            <div className="grid grid-cols-[1fr_2.5rem_2rem_2rem] sm:grid-cols-[1fr_6.5rem_2.25rem_2.25rem_2.5rem] gap-x-2 text-[10px] font-semibold uppercase tracking-wide text-faint px-1 pb-1">
              <span>{t('Player')}</span><span className="text-end sm:text-start">{t('PTS')}</span><span className="text-end">{t('REB')}</span><span className="text-end">{t('AST')}</span><span className="text-end hidden sm:block">{adv ? 'PIE' : t('MIN')}</span>
            </div>
            <ul className="divide-y divide-line/40">
              {rows.map(p => (
                <li key={p.id}>
                  <Link to={playerHref('basketball', p.id, p.name)!} className="grid grid-cols-[1fr_2.5rem_2rem_2rem] sm:grid-cols-[1fr_6.5rem_2.25rem_2.25rem_2.5rem] gap-x-2 items-center px-1 py-1.5 rounded-lg hover:bg-surface2/50 text-xs">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-6 h-6 rounded-md bg-surface2 grid place-items-center num text-[10px] font-bold text-muted shrink-0">{p.number ?? '–'}</span>
                      <span className="min-w-0 truncate">
                        <span className="font-semibold text-ink">{p.name}</span>
                        {p.position && <span className="hidden sm:inline ms-1.5 text-[10px] text-faint">{p.position}</span>}
                        {tag(p)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="hidden sm:block flex-1 h-1.5 rounded-full bg-surface2 overflow-hidden"><span className={`block h-full rounded-full ${tone.bg} opacity-80`} style={{ width: `${((p.pts ?? 0) / max) * 100}%` }} /></span>
                      <span className="num font-bold text-ink w-full sm:w-7 text-end">{p.pts ?? '–'}</span>
                    </span>
                    <span className="num text-end text-muted">{p.reb ?? '–'}</span>
                    <span className="num text-end text-muted">{p.ast ?? '–'}</span>
                    <span className="num text-end text-muted hidden sm:block">{adv ? (p.pie ?? '–') : (p.min ?? '–')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    )
  }
  return (
    <Card title={title} action={<span className="text-xs text-faint">{t('per game, this season')}</span>}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
        {side('H', g.home, home)}
        {side('A', g.away, away)}
      </div>
    </Card>
  )
}

/** "How this was calculated": the parts of each side's predicted points. */
export function ModelTable({ g, model, ratings }: {
  g: Game
  model: ModelInfo
  ratings: { home: { attack: number; defence: number } | null; away: { attack: number; defence: number } | null } | null
}) {
  const p = g.prediction!
  const r = ratings
  const f = (x: number) => ltr(`${x > 0 ? '+' : ''}${x.toFixed(1)}`)
  const half = model.homeEdge / 2
  const rows: { label: string; h: string; a: string }[] = [
    { label: t('League average (points per team)'), h: model.avgPoints.toFixed(1), a: model.avgPoints.toFixed(1) }
  ]
  if (r?.home && r?.away) {
    rows.push({ label: t('Attack (own rating)'), h: f(r.home.attack), a: f(r.away.attack) })
    rows.push({ label: t('Opponent defence'), h: f(-r.away.defence), a: f(-r.home.defence) })
  }
  rows.push({ label: t('Home court'), h: f(half), a: f(-half) })
  if (p.b2bHome || p.b2bAway) rows.push({ label: t('Back-to-back'), h: p.b2bHome ? f(-model.b2b / 2) : '0.0', a: p.b2bAway ? f(-model.b2b / 2) : '0.0' })
  if (p.injHome || p.injAway) rows.push({ label: t('Injuries'), h: f(-(p.injHome || 0)), a: f(-(p.injAway || 0)) })
  // fix174: the shared parts table (NFL + college use it too)
  return (
    <ModelParts
      home={<NameLink to={href.bbTeam(g.home.id, g.home.name)}>{g.home.name}</NameLink>} away={<NameLink to={href.bbTeam(g.away.id, g.away.name)}>{g.away.name}</NameLink>}
      rows={rows} total={p.score ? { label: t('Predicted points'), h: String(p.score.home), a: String(p.score.away) } : null}
      note={t('Ratings are points per game compared with an average team. Model {0}, {1} games rated; possession ratings and pace adjust the final numbers slightly.', { 0: model.version, 1: model.gamesRated })}
    />
  )
}

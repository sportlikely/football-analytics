import { Link } from 'react-router-dom'
import type { MoreSport } from '../game/MorePredictions'
import { t, LOCALE } from '../../../lib/i18n'
import { TeamLogo } from '../../../pages/bb/parts'
import { Card, Tick, pct, type AccuracyAdapter, type AccData } from '../Accuracy'
import type { ModelSport } from '../../../lib/modelNames'

/**
 * Accuracy adapter of the sports where our pick is the winner (basketball, NFL + college; it was WinnerAccuracy until
 * fix152b): the record from /basketball/record or /nfl/accuracy turned into the shared page's shape.
 */
interface Rec { n: number; hits: number; hitRate: number | null; strongN: number; strongHits: number; strongHitRate: number | null; marginOff?: number | null; totalOff?: number | null }
interface Row { gameId: number; code: string; kickoff: string; home: string; away: string; homeLogo: string | null; awayLogo: string | null; score: [number, number]; pick: 'H' | 'A'; pHome: number; hit: boolean }
interface Pending { gameId: number; code: string; kickoff: string; home: string; away: string; homeLogo: string | null; awayLogo: string | null; status: string | null; live: boolean; score: [number, number] | null; pick: 'H' | 'A'; preseason: boolean }
interface WinnerRecord {
  preseason?: { n: number; hits: number; hitRate: number | null; recent: Row[] }
  pending?: Pending[]
  since: string | null
  total: Rec
  bands?: { min: number; n: number; hits: number; pct: number | null }[]
  leagues: (Rec & { code: string })[]
  recent: Row[]
  calibration?: AccData['calibration']
  byConfidence?: AccData['byConfidence']
  /** fix174: how far the expected margin and total were off */
  scores?: { marginOff: number | null; totalOff: number | null; scoreN: number }
}

export interface WinnerOpts {
  title: string
  model: ModelSport
  /** fix204: the sport's More predictions record */
  more: MoreSport
  intro: string
  url: string
  /** fix229: the game's slug link (lib/links.ts matchHref) */
  gameHref: (r: { gameId: number; kickoff: string; home: string; away: string }) => string
  leagueName: (code: string) => string
  leagueHref?: (code: string) => string | null
  strongLabel: string
  /** "picks saved before tip-off" / "… kick-off" */
  savedNote: string
  /** footnote under the waiting list */
  waitingNote: string
  footnote: string
  /** fix193c: tennis — the two extra columns and the score card say "set score right" / "games off" instead of points */
  scoreWords?: { cols: [string, string]; title: string; text: (n: number) => string; a: string; aUnit: string; b: string; bUnit: string; aFmt?: (v: number) => string; bFmt?: (v: number) => string }
}

export function winnerAccuracy(o: WinnerOpts): AccuracyAdapter {
  const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  const line = (r: Row | Pending, mid: string, end: JSX.Element) => (
    <li key={r.gameId}>
      <Link to={o.gameHref(r)} className="flex items-center gap-2 py-2 text-sm hover:bg-surface2/50 rounded-lg px-1 min-w-0">
        {mid === '' ? null : <span className="w-16 shrink-0 text-xs text-faint">{mid}</span>}
        <TeamLogo team={{ name: r.home, logo: r.homeLogo }} size={16} />
        <span className={`truncate ${r.pick === 'H' ? 'font-bold text-ink' : 'text-muted'}`}>{r.home}</span>
        <span className="num font-bold text-ink px-1 shrink-0">{r.score ? `${r.score[0]}–${r.score[1]}` : '–'}</span>
        <span className={`truncate ${r.pick === 'A' ? 'font-bold text-ink' : 'text-muted'}`}>{r.away}</span>
        <TeamLogo team={{ name: r.away, logo: r.awayLogo }} size={16} />
        {end}
      </Link>
    </li>
  )
  const hitChip = (hit: boolean) => <span className={`ml-auto shrink-0 rounded-full px-2 text-[10px] font-bold ${hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{hit ? t('Hit') : t('Miss')}</span>

  return {
    title: o.title,
    model: o.model,
    more: o.more,
    intro: o.intro,
    url: o.url,
    calibrationText: t("Every chance we gave, for both teams of every game, grouped by the number we said. If our numbers are honest, the dots sit on the dashed line."),
    confidenceLabel: t("Winner picks, by how sure we were"),
    leagueCols: { main: t("Our pick"), cols: [t("Strong picks"), ...(o.scoreWords ? o.scoreWords.cols : [t("Margin off"), t("Total off")])] },
    leagueNote: t("Under 20 games is too few to judge a league: pick a longer period for a fairer picture."),
    recentCols: [t("Our pick")],
    footnote: o.footnote,
    toData: (d: WinnerRecord): AccData => ({
      headline: {
        label: t("Our picks · winner"),
        value: d.total.hitRate,
        text: d.total.n ? t("{0} of {1} right. Our pick is the team we rate more likely to win.", { 0: d.total.hits, 1: d.total.n }) : t("No finished games yet."),
        bands: (d.bands || []).filter(b => b.min > 0).map(b => ({ label: `${b.min}%+`, pct: b.pct, n: b.n })),
        strong: { label: o.strongLabel, hitRate: d.total.strongHitRate, hits: d.total.strongHits, n: d.total.strongN }
      },
      // fix174: football's extra cards, for a points sport: how far our score numbers were off
      extra: d.scores && d.scores.scoreN ? (
        <Card>
          <h2 className="font-display text-xl font-bold text-ink">{o.scoreWords ? o.scoreWords.title : t('Score predictions')}</h2>
          <p className="text-sm text-muted mt-1 mb-4">{o.scoreWords ? o.scoreWords.text(d.scores.scoreN) : t('How far our expected margin and total points were from the final score, on average, over {0} games.', { 0: d.scores.scoreN })}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-surface2/60 p-4"><div className="text-[11px] text-faint">{o.scoreWords ? o.scoreWords.a : t('Margin off by')}</div><div className="num text-3xl font-extrabold text-ink mt-1">{d.scores.marginOff == null ? '–' : o.scoreWords?.aFmt ? o.scoreWords.aFmt(d.scores.marginOff) : d.scores.marginOff}</div><div className="text-[11px] text-muted">{o.scoreWords ? o.scoreWords.aUnit : t('points a game')}</div></div>
            <div className="rounded-2xl bg-surface2/60 p-4"><div className="text-[11px] text-faint">{o.scoreWords ? o.scoreWords.b : t('Total off by')}</div><div className="num text-3xl font-extrabold text-ink mt-1">{d.scores.totalOff == null ? '–' : o.scoreWords?.bFmt ? o.scoreWords.bFmt(d.scores.totalOff) : d.scores.totalOff}</div><div className="text-[11px] text-muted">{o.scoreWords ? o.scoreWords.bUnit : t('points a game')}</div></div>
          </div>
        </Card>
      ) : undefined,
      calibration: d.calibration,
      byConfidence: d.byConfidence,
      leagues: d.leagues.map(l => ({
        key: l.code, name: o.leagueName(l.code), href: o.leagueHref?.(l.code) || null, n: l.n, main: l.hitRate,
        cols: [l.strongHitRate ?? null, l.marginOff != null ? (o.scoreWords?.aFmt ? o.scoreWords.aFmt(l.marginOff) : `±${l.marginOff}`) : null, l.totalOff != null ? (o.scoreWords?.bFmt ? o.scoreWords.bFmt(l.totalOff) : `±${l.totalOff}`) : null],
      })),
      recent: d.recent.map(r => ({
        id: r.gameId, href: o.gameHref(r), date: r.kickoff, comp: o.leagueName(r.code), compHref: o.leagueHref?.(r.code) || null, home: r.home, away: r.away, score: `${r.score[0]}–${r.score[1]}`,
        cells: [<span className="inline-flex items-center gap-1.5"><Tick hit={r.hit} /> <span className="text-ink truncate">{r.pick === 'H' ? r.home : r.away}</span> <span className="num text-faint">{pct(Math.round(100 * (r.pick === 'H' ? r.pHome : 1 - r.pHome)))}</span></span>]
      })),
      after: (
        <>
          {d.pending && d.pending.length > 0 && (
            <Card>
              <div className="flex items-baseline justify-between gap-2 mb-3">
                <h2 className="font-display text-xl font-bold text-ink">{t('Waiting for the result')}</h2>
                <span className="text-xs text-faint">{o.savedNote}</span>
              </div>
              <ul className="divide-y divide-line/50">
                {d.pending.map(r => line(r, '', (
                  <span className="ml-auto shrink-0 text-[10px] text-faint">
                    {r.live ? <span className="inline-flex items-center gap-1 font-bold text-live"><span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />{t('Live')}</span>
                      : r.preseason ? t('Pre-season') : `${new Date(r.kickoff).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })} · ${o.leagueName(r.code)}`}
                  </span>
                )))}
              </ul>
              <p className="mt-2 text-[11px] text-faint">{o.waitingNote}</p>
            </Card>
          )}
          {d.preseason && d.preseason.n > 0 && (
            <Card>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <h2 className="font-display text-xl font-bold text-ink">{t('Pre-season (not counted)')}</h2>
                <span className="text-xs text-muted">{t('{0} of {1} right', { 0: d.preseason.hits, 1: d.preseason.n })}{d.preseason.hitRate !== null ? ` · ${d.preseason.hitRate}%` : ''}</span>
              </div>
              <p className="text-xs text-faint mb-3">{t('In pre-season teams rest their stars and try young players, so these games are shown but kept out of the official record.')}</p>
              <ul className="divide-y divide-line/50">{d.preseason.recent.map(r => line(r, day(r.kickoff), hitChip(r.hit)))}</ul>
            </Card>
          )}
        </>
      )
    })
  }
}

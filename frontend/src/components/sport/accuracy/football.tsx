import { t } from '../../../lib/i18n'
import { Flag } from '../../LeagueSidebar'
import { footballCountry, leagueShortName } from '../../../lib/leagueCountry'
import { dcLabel } from '../../../lib/predict'
import { DcTag } from '../../DcPick'
import AccuracyDetailed from '../../../pages/Accuracy'
import { Card, Bar, Tick, pct, StatCard, SectionHead, type AccuracyAdapter, type AccData } from '../Accuracy'

/** Football's Accuracy adapter (/public/record): the double chance up top, then the hard and the safer calls. */
type Outcome = 'H' | 'D' | 'A'
interface Recent {
  matchId: number
  date: string
  competition: string | null
  home: string
  away: string
  score: string
  outcome: Outcome
  result: { pick: Outcome; hit: boolean }
  btts: { pick: boolean; hit: boolean } | null
  over25: { pick: boolean; hit: boolean } | null
  dc?: { pick: '1X' | 'X2' | '12'; p?: number; hit: boolean }
  over15?: { pick: boolean; hit: boolean } | null
}
interface Record_ {
  result: { n: number; v3: number | null; v3Hits: number }
  btts: { n: number; hitRate: number | null; hits: number }
  over25: { n: number; hitRate: number | null; hits: number }
  doubleChance?: { n: number; v3: number | null; v3Hits: number; bands?: { id: string; n: number; pct: number | null }[]; strong?: { n: number; hits: number; hitRate: number | null } }
  over15?: { n: number; hitRate: number | null; hits: number }
  safest?: { n: number; hitRate: number | null; hits: number; byMarket: { market: string; n: number; hitRate: number | null }[] }
  byCompetition: { code: string; name: string; n: number; v3: number | null; dc?: number | null; btts?: number | null; over25?: number | null }[]
  calibration?: AccData['calibration']
  byConfidence?: AccData['byConfidence']
  recent: Recent[]
}

const none = t("No finished games yet.")
const ou = (x: { pick: boolean; hit: boolean } | null | undefined) =>
  x ? <span className="inline-flex items-center gap-1.5"><Tick hit={x.hit} /> <span className="text-muted">{x.pick ? t("Over") : t("Under")}</span></span> : <span className="text-faint">–</span>

export const footballAccuracy: AccuracyAdapter = {
  title: t("Our record"),
  intro: t("Every prediction is saved before kick-off and checked after the final whistle. Wins and losses stay here, nothing is edited."),
  url: '/public/record',
  calibrationText: t("Every chance we gave, for every result of every match (home win, draw and away win), grouped by the number we said. If our numbers are honest, the dots sit on the dashed line."),
  confidenceLabel: t("Hard calls (1X2), by how sure we were"),
  leagueCols: { main: t("Match result"), cols: [t("Our pick"), t("BTTS"), t("Goals 2.5")] },
  leagueNote: t("Competitions with at least 5 finished games in this period. Under 20 games is too few to judge a competition: pick a longer period for a fairer picture."),
  recentCols: [t("Our pick"), t("Hard call (1X2)"), t("BTTS"), t("Goals 2.5"), t("Goals 1.5")],
  footnote: t("Match result: our most likely result, counted on every finished game. Every tracked competition: leagues, national teams and European cups. Predictions are probabilities, not promises."),
  detailed: () => <AccuracyDetailed />,
  toData: (rec: Record_): AccData => {
    const r = rec.result
    const name = (x: Recent, o: Outcome) => (o === 'H' ? x.home : o === 'A' ? x.away : 'Draw')
    return {
      headline: {
        label: t("Our picks · double chance"),
        value: rec.doubleChance?.v3 ?? null,
        text: rec.doubleChance?.n ? t("{0} of {1} right. Our pick is the two results we rate highest (1X, X2 or 12): right when the game ends in one of them.", { 0: rec.doubleChance.v3Hits, 1: rec.doubleChance.n }) : none,
        bands: (rec.doubleChance?.bands || []).map(x => ({ label: x.id === '90+' ? '90%+' : x.id === '80-90' ? '80–90%' : '70–80%', pct: x.pct, n: x.n })),
        strong: rec.doubleChance?.strong ? { label: t("Strong picks (85%+)"), ...rec.doubleChance.strong } : null
      },
      extra: (
        <>
          <SectionHead title={t("The hard calls")} sub={t("Close to a coin flip in most games. This is where a model shows what it is worth.")} />
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard accent label={t("Match result")} value={r?.v3} bar="bg-accent" text={r?.n ? t("{0} of {1} right. Our most likely result: home win, draw or away win.", { 0: r.v3Hits, 1: r.n }) : none} />
            <StatCard label={t("Both teams to score")} value={rec.btts.hitRate} bar="bg-home" text={rec.btts.n ? t("{0} of {1} right. Yes when we give it 50%+, else No.", { 0: rec.btts.hits, 1: rec.btts.n }) : none} />
            <StatCard label={t("Over / under 2.5 goals")} value={rec.over25.hitRate} bar="bg-draw" text={rec.over25.n ? t("{0} of {1} right. Over when we give it 50%+, else Under.", { 0: rec.over25.hits, 1: rec.over25.n }) : none} />
          </div>
          <SectionHead title={t("The safer calls")} sub={t("Calls that come in more often. Each one is counted and shown on its own.")} />
          <div className="grid gap-4 md:grid-cols-2">
            <StatCard label={t("Over / under 1.5 goals")} value={rec.over15?.hitRate} bar="bg-home" text={rec.over15?.n ? t("{0} of {1} right. Over when we give it 50%+, else Under.", { 0: rec.over15.hits, 1: rec.over15.n }) : none} />
            <Card>
              <div className="label">{t("Our safest pick of each match")}</div>
              <div className="num text-5xl font-extrabold text-ink mt-4">{pct(rec.safest?.hitRate)}</div>
              <div className="mt-3"><Bar v={rec.safest?.hitRate ?? null} cls="bg-draw" /></div>
              <p className="text-xs text-muted mt-4">
                {rec.safest?.n ? t("{0} of {1} right. For every match, the one pick we were most sure about.", { 0: rec.safest.hits, 1: rec.safest.n }) : none}
              </p>
              {rec.safest && rec.safest.byMarket.length > 0 && (
                <p className="text-[11px] text-faint mt-2">{rec.safest.byMarket.map(b => `${b.market} ${b.n}× (${pct(b.hitRate)})`).join(' · ')}</p>
              )}
            </Card>
          </div>
        </>
      ),
      calibration: rec.calibration,
      byConfidence: rec.byConfidence,
      leagues: rec.byCompetition.map(c => ({
        key: c.code || c.name,
        name: <span className="inline-flex items-center gap-2 min-w-0"><Flag code={footballCountry({ code: c.code, name: c.name })} size={16} /><span className="truncate">{leagueShortName(c.name)}</span></span>,
        href: c.code ? `/league/${c.code}` : null,
        n: c.n, main: c.v3, cols: [c.dc ?? null, c.btts ?? null, c.over25 ?? null]
      })),
      recent: rec.recent.map(x => ({
        id: x.matchId, href: `/match/${x.matchId}`, date: x.date, comp: x.competition, compHref: (() => { const c = rec.byCompetition.find(b => b.name === x.competition)?.code; return c ? `/league/${c}` : null })(), home: x.home, away: x.away, score: x.score,
        cells: [
          x.dc ? <span className="inline-flex items-center gap-1.5"><Tick hit={x.dc.hit} /> <DcTag code={x.dc.pick} /> <span className="text-ink truncate">{dcLabel(x.dc.pick, x.home, x.away)}</span></span> : <span className="text-faint">–</span>,
          <span className="inline-flex items-center gap-1.5"><Tick hit={x.result.hit} /> <span className="text-muted truncate">{name(x, x.result.pick)}</span></span>,
          x.btts ? <span className="inline-flex items-center gap-1.5"><Tick hit={x.btts.hit} /> <span className="text-muted">{x.btts.pick ? t("Yes") : t("No")}</span></span> : <span className="text-faint">–</span>,
          ou(x.over25),
          ou(x.over15)
        ]
      }))
    }
  }
}

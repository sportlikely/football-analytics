import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'
import { slAdmin } from '../lib/modelNames'

type Outcome = 'H' | 'D' | 'A'

interface Metrics {
  settled: number
  model: { hitRate: number; brier: number; logLoss: number } | null
  market: { n: number; hitRate: number; brier: number; logLoss: number } | null
  betting: {
    edgeThreshold: number
    edge: { bets: number; wins: number; profit: number; roi: number }
    favourite: { bets: number; wins: number; profit: number; roi: number }
  } | null
  outcomes: Record<Outcome, number>
  picks: Record<Outcome, number>
  calibration: { range: string; n: number; predicted: number; actual: number }[]
  strongPicks?: { min: number; n: number; share: number; hitRate: number | null; roi: number | null; market: { n: number; hitRate: number } | null }[]
  twoOptions?: { n: number; hitRate: number | null; closeGames: { n: number; hitRate: number | null }; roi: number | null }
  drawAlerts?: { n: number; wins: number; hitRate: number | null; roi: number | null }
  byCompetition: { code: string; name: string; n: number; hitRate: number; brier: number; marketBrier: number | null; bets: number; profit: number }[]
}

interface Summary extends Metrics {
  days: number
  competition: string | null
  modelName: string | null
  models: string[]
  pending: number
}

interface BacktestData extends Metrics {
  season: string
  group: string | null
  runs: { id: number; season: string; grp: string; matches: number; finished_at: string | null }[]
  progress: { season: string; group: string; done: number; total: number } | null
  sample: {
    division: string
    date: string
    home: string
    away: string
    hg: number
    ag: number
    outcome: Outcome
    p_home: number
    p_draw: number
    p_away: number
    odds_home: number | null
    odds_draw: number | null
    odds_away: number | null
  }[]
}

interface HistoryStatus {
  history: { total: number; mapped: number }
  model: { lastFitAt: string | null; groups: Record<string, { teams: number; homeAdv: number; rho: number; avgGoals: number }>; teamMap: Record<string, { mapped: number; unmatched: string[] }> }
  groups: Record<string, { divisions: string[]; competitions: string[] }>
}

interface Settled {
  matchId: number
  date: string
  competition: string | null
  code: string | null
  home: string
  away: string
  score: string
  outcome: Outcome
  pick: Outcome
  hit: boolean
  p: Record<Outcome, number>
  odds: Record<Outcome, number> | null
  confidence: string | null
  model: string
}

interface Status {
  total: number
  open: number
  locked: number
  settled: number
  withOdds: number
}

const DAY_OPTIONS = [7, 30, 90, 365]
const OUTCOME_LABEL: Record<Outcome, string> = { H: 'Home', D: 'Draw', A: 'Away' }
const MODEL_LABEL: Record<string, string> = {
  'poisson-dc-v1': 'v1 · standings',
  'dc-history-v2': 'v2 · history (Dixon-Coles)',
  'grid-v3': `${slAdmin('grid-v3')} · scoring grid`,
  'v3-mix': `${slAdmin('v3-mix')} · grid + feature model`,
  'feat-v1': 'feature model (logit + trees)'
}
// Last complete season (football-data.co.uk code: 2526 = 2025/26)
const BACKTEST_SEASON = '2526'

function Accuracy() {
  const [tab, setTab] = useState<'live' | 'backtest'>('live')
  const [days, setDays] = useState(90)
  const [competition, setCompetition] = useState<string>('ALL')
  const [model, setModel] = useState<string>('dc-history-v2') // v1 stays tracked in the background as a baseline
  const [summary, setSummary] = useState<Summary | null>(null)
  const [recent, setRecent] = useState<Settled[]>([])
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'live') return
    const params: Record<string, string | number> = { days }
    if (competition !== 'ALL') params.competition = competition
    if (model !== 'ALL') params.model = model
    Promise.all([
      axios.get(`${API_URL}/accuracy`, { params }),
      axios.get(`${API_URL}/accuracy/recent`, { params: { ...params, limit: 200 } }),
      axios.get(`${API_URL}/accuracy/status`)
    ])
      .then(([s, r, st]) => {
        setSummary(s.data.data)
        setRecent(r.data.data)
        setStatus(st.data.data)
        setError(null)
      })
      .catch(err => setError(errorText(err)))
  }, [tab, days, competition, model])

  const comps = summary?.byCompetition || []

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 lg:gap-8 items-start">
      <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Accuracy")}</h1>
          <p className="text-sm text-muted">
            {tab === 'live' ? status ? tt("{0} settled · {1} in play or awaiting result · {2} upcoming · {3} with market odds", { 0: status.settled, 1: status.locked, 2: status.open, 3: status.withOdds }) : '…' : tt("Walk-forward test on a past season: every week the model is fitted only on matches before that week.")}
          </p>
        </div>
        <div className="seg">
          <button
            onClick={() => setTab('live')}
            className={`seg-btn ${tab === 'live' ? 'seg-btn-active' : ''}`}
          >
            {tt("Live tracking")}</button>
          <button
            onClick={() => setTab('backtest')}
            className={`seg-btn ${tab === 'backtest' ? 'seg-btn-active' : ''}`}
          >
            {tt("Backtest 2025–26")}</button>
        </div>
      </div>

      {tab === 'backtest' && <Backtest />}

      {tab === 'live' && (
        <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="seg">
          {DAY_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`seg-btn ${days === d ? 'seg-btn-active' : ''}`}
            >
              {d}d
            </button>
          ))}
        </div>
        {summary && summary.models.filter(m => m !== 'poisson-dc-v1').length > 1 && (
          <div className="seg">
            {summary.models
              .filter(m => m !== 'poisson-dc-v1')
              .map(m => (
                <button key={m} onClick={() => setModel(m)} className={`seg-btn ${model === m ? 'seg-btn-active' : ''}`}>
                  {MODEL_LABEL[m] || m}
                </button>
              ))}
          </div>
        )}
      </div>

      {model === 'grid-v3' && (
        <p className="text-xs text-faint -mt-3 mb-5">
          {tt("v3 went live on 24 Sep 2026. Its earlier matches here were scored retroactively, each from the data available before that kick-off (walk-forward, same market odds as v2) — a like-for-like comparison, not live predictions.")}</p>
      )}

      {comps.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <Chip active={competition === 'ALL'} onClick={() => setCompetition('ALL')}>{tt("All leagues")}</Chip>
          {comps.map(c => (
            <Chip key={c.code} active={competition === c.code} onClick={() => setCompetition(c.code)}>
              {c.name} <span className="opacity-60">· {c.n}</span>
            </Chip>
          ))}
        </div>
      )}

      {error && <div className="card border-loss/40 text-loss rounded-lg p-4 mb-5">{error}</div>}

      {summary && summary.settled === 0 && (
        <div className="card p-12 text-center text-muted">
          <p className="font-display text-lg font-bold text-ink mb-1">{tt("No settled predictions yet")}</p>
          <p className="text-sm">
            {tt("Predictions are saved for every upcoming match and frozen at kick-off. Once matches finish, they are scored here automatically.")}{' '}{summary.pending > 0 && tt("{n, plural, one {# prediction} other {# predictions}} waiting.", { n: summary.pending })}
          </p>
        </div>
      )}

      {tab === 'live' && <ClvPanel days={days} />}

      {summary && summary.settled > 0 && summary.model && (
        <>
          <MetricsView m={summary} />

          {/* Settled list */}
          <Section title={tt("Settled predictions · {0}", { 0: recent.length })}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="label">
                  <tr>
                    <th className="text-left font-medium py-1">{tt("Date")}</th>
                    <th className="text-left font-medium">{tt("Match")}</th>
                    <th className="text-center font-medium">{tt("Score")}</th>
                    <th className="text-center font-medium">1</th>
                    <th className="text-center font-medium">X</th>
                    <th className="text-center font-medium">2</th>
                    <th className="text-center font-medium">{tt("Pick")}</th>
                    <th className="text-center font-medium">{tt("Result")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(r => (
                    <tr key={`${r.matchId}-${r.model}`} className="border-t border-line/50 hover:bg-surface2/60 transition-colors">
                      <td className="py-1.5 text-muted whitespace-nowrap">
                        {new Date(r.date).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short' })}
                      </td>
                      <td>
                        <Link to={`/match/${r.matchId}`} className="hover:underline">
                          {r.home} – {r.away}
                        </Link>
                        <span className="text-xs text-faint ml-2 hidden md:inline">{r.competition}</span>
                        {model === 'ALL' && (
                          <span className="text-[10px] text-faint ml-2">{r.model === 'grid-v3' ? 'v3' : r.model === 'v3-mix' ? 'v3-mix' : r.model === 'feat-v1' ? 'feat' : r.model === 'dc-history-v2' ? 'v2' : 'v1'}</span>
                        )}
                      </td>
                      <td className="text-center font-semibold num">{r.score}</td>
                      {(['H', 'D', 'A'] as Outcome[]).map(o => (
                        <td
                          key={o}
                          className={`text-center num ${
                            r.outcome === o ? 'font-bold text-ink' : 'text-muted'
                          } ${r.pick === o ? 'underline decoration-2 underline-offset-2' : ''}`}
                        >
                          {Math.round(r.p[o])}%
                          {r.odds && <div className="text-[10px] text-faint">{r.odds[o]}</div>}
                        </td>
                      ))}
                      <td className="text-center">{OUTCOME_LABEL[r.pick]}</td>
                      <td className="text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-bold tracking-wider ${
                            r.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'
                          }`}
                        >
                          {r.hit ? tt("HIT") : tt("MISS")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
        </>
      )}
      </div>
      <Guide tab={tab} settled={tab === 'live' ? summary?.settled ?? 0 : undefined} />
      </div>
    </div>
  )
}

/* ---------- guide: how to read this page ---------- */

function Guide({ tab, settled }: { tab: 'live' | 'backtest'; settled?: number }) {
  const small = tab === 'live' && settled !== undefined && settled < 200
  return (
    <aside className="lg:sticky lg:top-20 space-y-4">
      {small && (
        <div className="card p-4 border-draw/40 bg-draw/5">
          <div className="flex items-center gap-2 font-semibold text-draw text-sm mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-draw" /> {tt("Small sample")}</div>
          <p className="text-xs text-muted">
            {tt("Only {0} matches have been scored so far. Below ~200 the numbers swing a lot from week to week; below ~500 differences of a few points mean nothing. Treat this as a live log, not a verdict — the Backtest tab has 2,359 matches.", { 0: settled })}</p>
        </div>
      )}

      <div className="card p-5">
        <h3 className="font-display text-base font-bold text-ink mb-1">{tt("How to read this page")}</h3>
        <p className="text-xs text-muted mb-4">
          {tt("Every prediction is saved, frozen at kick-off, and scored against the result. Nothing here is edited after the fact.")}</p>

        <dl className="space-y-4 text-xs">
          <GuideItem term="Hit rate">
            {tt("How often the model's pick (the most likely outcome) was right. Intuitive, but the weakest measure: home teams win ~45% of matches, so a model that always says \"home\" scores 45% knowing nothing. Experts live around 50–55%.")}</GuideItem>
          <GuideItem term="Brier score · Log loss">
            {tt("Measure the quality of the probabilities, not just the pick. Saying 90% and being wrong is punished far more than saying 52% and being wrong. Lower is better. Brier 0.667 and log loss 1.099 are what \"always 1/3 each\" gets.")}</GuideItem>
          <GuideItem term="Market">
            {tt("The same score computed from the bookmaker's odds (Pinnacle, margin removed). The benchmark. Green means we beat it, red means the market knew more.")}</GuideItem>
          <GuideItem term="Calibration">
            {tt("The most important chart. Of all matches where the model said 60–70%, how many actually went that way? A calibrated model's bars end at the black line — its 70% really means 70%, so the number can be trusted as a number.")}</GuideItem>
          <GuideItem term="Betting simulation">
            {tt("What a flat 1-unit bet on every qualifying selection would have returned at the bookmaker's price. \"Value bets\" only fire when the model sees an edge over the odds. This is the line between a nice model and a profitable one — and we show it whether it is positive or negative.")}</GuideItem>
          <GuideItem term="Live tracking vs Backtest">
            {tt("Live is the real record since the system went online, filling in match by match. Backtest replays a whole past season week by week, fitting only on matches that had already happened — a fast, honest answer while the live log grows.")}</GuideItem>
        </dl>
      </div>
    </aside>
  )
}

function GuideItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-semibold text-ink mb-0.5">{term}</dt>
      <dd className="text-muted leading-relaxed">{children}</dd>
    </div>
  )
}

/* ---------- shared metrics view ---------- */

function MetricsView({ m, groupLabel = 'League' }: { m: Metrics; groupLabel?: string }) {
  if (!m.model) return null
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Tile label={tt("Matches scored")} value={m.settled} />
        <Tile
          label={tt("Hit rate (model pick)")}
          value={`${m.model.hitRate}%`}
          sub={m.market ? tt("market {0}%", { 0: m.market.hitRate }) : undefined}
          good={m.market ? m.model.hitRate >= m.market.hitRate : undefined}
        />
        <Tile
          label={tt("Brier score")}
          value={m.model.brier}
          sub={m.market ? tt("market {0}", { 0: m.market.brier }) : tt("lower is better")}
          good={m.market ? m.model.brier <= m.market.brier : undefined}
          hint={tt("0 = perfect, 0.667 = always 1/3 each")}
        />
        <Tile
          label={tt("Log loss")}
          value={m.model.logLoss}
          sub={m.market ? tt("market {0}", { 0: m.market.logLoss }) : tt("lower is better")}
          good={m.market ? m.model.logLoss <= m.market.logLoss : undefined}
          hint={tt("1.099 = always 1/3 each")}
        />
      </div>

      {m.strongPicks && m.strongPicks.length > 0 && (
        <Section title={tt("Strong picks · how often the pick wins when the model is confident")}>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-line/70 bg-surface/60 p-4">
              <div className="label mb-1">{tt("All picks")}</div>
              <div className="num text-2xl font-bold text-ink">{m.model.hitRate}%</div>
              <div className="text-xs text-faint mt-1">
                {tt("{0} matches", { 0: m.settled })}{m.market ? tt(" · market {0}%", { 0: m.market.hitRate }) : ''}
              </div>
            </div>
            {m.strongPicks.map(t => (
              <div key={t.min} className="rounded-xl border border-line/70 bg-surface/60 p-4">
                <div className="label mb-1">{tt("Model ≥ {0}%", { 0: t.min })}</div>
                <div className={`num text-2xl font-bold ${t.hitRate !== null && t.hitRate >= 55 ? 'text-accent' : 'text-ink'}`}>
                  {t.hitRate !== null ? `${t.hitRate}%` : '–'}
                </div>
                <div className="text-xs text-faint mt-1">
                  {tt("{0} matches ({1}% of all)", { 0: t.n, 1: t.share })}{t.market ? tt(" · market ≥{0}%: {1}% of {2}", { 0: t.min, 1: t.market.hitRate, 2: t.market.n }) : ''}
                </div>
                {t.roi !== null && (
                  <div className={`text-xs mt-1 num ${t.roi >= 0 ? 'text-win' : 'text-loss'}`}>{tt("ROI at market odds")}{' '}{t.roi > 0 ? '+' : ''}{t.roi}%</div>
                )}
              </div>
            ))}
          </div>
          {m.twoOptions && m.twoOptions.n > 0 && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-xl border border-line/70 bg-surface/60 p-4">
                <div className="label mb-1">{tt("Two options · the two most likely results")}</div>
                <div className="num text-2xl font-bold text-ink">{m.twoOptions.hitRate}%</div>
                <div className="text-xs text-faint mt-1">
                  {tt("{0} matches", { 0: m.twoOptions.n })}{m.twoOptions.roi !== null ? tt(" · ROI as a double-chance bet {0}{1}%", { 0: m.twoOptions.roi > 0 ? '+' : '', 1: m.twoOptions.roi }) : ''}
                </div>
              </div>
              <div className="rounded-xl border border-line/70 bg-surface/60 p-4">
                <div className="label mb-1">{tt("Two options · close games only (no result ≥ 50%)")}</div>
                <div className="num text-2xl font-bold text-ink">{m.twoOptions.closeGames.hitRate ?? '–'}{m.twoOptions.closeGames.hitRate !== null ? '%' : ''}</div>
                <div className="text-xs text-faint mt-1">{tt("{0} matches", { 0: m.twoOptions.closeGames.n })}</div>
              </div>
            </div>
          )}
          {m.drawAlerts && m.drawAlerts.n > 0 && (
            <div className="mt-3 rounded-xl border border-draw/40 bg-draw/10 p-4">
              <div className="label mb-1">{tt("Draw alerts (v3) · draws the market underrates")}</div>
              <div className="num text-2xl font-bold text-ink">
                {m.drawAlerts.wins} / {m.drawAlerts.n} <span className="text-base text-muted">({m.drawAlerts.hitRate}%)</span>
              </div>
              <div className={`text-xs mt-1 num ${m.drawAlerts.roi !== null && m.drawAlerts.roi >= 0 ? 'text-win' : 'text-loss'}`}>
                {tt("ROI at market odds")}{' '}{m.drawAlerts.roi !== null && m.drawAlerts.roi > 0 ? '+' : ''}{m.drawAlerts.roi}%
              </div>
              <div className="text-xs text-faint mt-1">{tt("A draw alert wins about 1 time in 3–4 at odds around 3.5 — judge it over many matches, not a weekend.")}</div>
            </div>
          )}
          <p className="text-xs text-faint mt-3">
            {tt("A confident pick wins more often, but also pays less. Hit rate shows reliability; the ROI line shows whether it would have paid at the bookmaker's price.")}</p>
        </Section>
      )}

      {m.betting && (
        <Section title={tt("Betting at market odds · flat 1-unit stakes · {0} matches with odds", { 0: m.market?.n })}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Strategy title={tt("Value bets (model edge ≥ {0}%)", { 0: Math.round(m.betting.edgeThreshold * 100) })} s={m.betting.edge} />
            <Strategy title={tt("Always back the model's pick")} s={m.betting.favourite} />
          </div>
          <p className="text-xs text-faint mt-3">
            {tt("Profit is what a 1-unit bet on each qualifying selection would have returned at the bookmaker's pre-match price. This is the number that matters.")}</p>
        </Section>
      )}

      <Section title={tt("Calibration · when the model says X%, how often does it happen?")}>
        {m.calibration.length === 0 ? (
          <p className="text-sm text-faint">{tt("Not enough data yet.")}</p>
        ) : (
          <div className="space-y-2">
            {m.calibration.map(b => (
              <div key={b.range} className="grid grid-cols-[90px_1fr_120px] items-center gap-3 text-sm">
                <span className="text-muted num">{b.range}</span>
                <div className="relative h-3 bg-surface2 rounded-full overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-accent/80 rounded-full" style={{ width: `${b.actual}%` }} />
                  <div className="absolute -inset-y-1 w-0.5 bg-ink" style={{ left: `${b.predicted}%` }} title={tt("predicted {0}%", { 0: b.predicted })} />
                </div>
                <span className="num text-ink/80">
                  {b.actual}% <span className="text-faint">{tt("of {0}", { 0: b.n })}</span>
                </span>
              </div>
            ))}
            <p className="text-xs text-faint pt-1">
              {tt("Bar = actual hit rate of the model's pick in that confidence band; black line = what the model predicted. A well-calibrated model has the bar ending at the line.")}</p>
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
        <Section title={tt("Picks vs actual outcomes")} flat>
          <table className="w-full text-sm">
            <thead className="label">
              <tr>
                <th className="text-left font-medium py-1">{tt("Outcome")}</th>
                <th className="text-right font-medium">{tt("Model picked")}</th>
                <th className="text-right font-medium">{tt("Actually happened")}</th>
              </tr>
            </thead>
            <tbody>
              {(['H', 'D', 'A'] as Outcome[]).map(o => (
                <tr key={o} className="border-t border-line/50">
                  <td className="py-1.5">{OUTCOME_LABEL[o]}</td>
                  <td className="text-right num">{m.picks[o]}</td>
                  <td className="text-right num">{m.outcomes[o]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title={`By ${groupLabel.toLowerCase()}`} flat>
          <table className="w-full text-sm">
            <thead className="label">
              <tr>
                <th className="text-left font-medium py-1">{groupLabel}</th>
                <th className="text-right font-medium">{tt("Matches")}</th>
                <th className="text-right font-medium">{tt("Hit")}</th>
                <th className="text-right font-medium">{tt("Brier")}</th>
                <th className="text-right font-medium">{tt("Market")}</th>
                <th className="text-right font-medium">P/L</th>
              </tr>
            </thead>
            <tbody>
              {m.byCompetition.map(c => (
                <tr key={c.code} className="border-t border-line/50">
                  <td className="py-1.5">{c.name}</td>
                  <td className="text-right num">{c.n}</td>
                  <td className="text-right num">{c.hitRate}%</td>
                  <td className="text-right num">{c.brier}</td>
                  <td className="text-right num text-muted">{c.marketBrier ?? '–'}</td>
                  <td className={`text-right num ${c.profit > 0 ? 'text-win' : c.profit < 0 ? 'text-live' : ''}`}>
                    {c.bets ? `${c.profit > 0 ? '+' : ''}${c.profit.toFixed(1)}u` : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  )
}

/* ---------- backtest tab ---------- */

const DIVISION_NAME: Record<string, string> = {
  E0: 'Premier League', E1: 'Championship', SP1: 'La Liga', SP2: 'Segunda', I1: 'Serie A', I2: 'Serie B',
  D1: 'Bundesliga', D2: '2. Bundesliga', F1: 'Ligue 1', F2: 'Ligue 2', N1: 'Eredivisie', P1: 'Primeira Liga',
  B1: tt("Belgian Pro League"), T1: 'Süper Lig', SC0: tt("Scottish Premiership"), SC1: tt("Scottish Championship"), G1: tt("Greek Super League")
}
const GROUP_NAME: Record<string, string> = {
  E: 'England', SP: 'Spain', I: 'Italy', D: 'Germany', F: 'France', N: 'Netherlands', P: 'Portugal',
  B: 'Belgium', T: 'Turkey', SC: 'Scotland', G: 'Greece'
}

function Backtest() {
  const isAdmin = useAuth().access === 'admin'
  const [group, setGroup] = useState<string>('ALL')
  const [btModel, setBtModel] = useState<'dc-history-v2' | 'grid-v3'>('dc-history-v2')
  const [oddsKind, setOddsKind] = useState<'close' | 'early'>('close')
  const [edge, setEdge] = useState<number>(0.05)
  const [data, setData] = useState<BacktestData | null>(null)
  const [hist, setHist] = useState<HistoryStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const load = () => {
    const params: Record<string, string | number> = { season: BACKTEST_SEASON, odds: oddsKind, edge, model: btModel }
    if (group !== 'ALL') params.group = group
    Promise.all([axios.get(`${API_URL}/backtest`, { params }), axios.get(`${API_URL}/history/status`)])
      .then(([b, h]) => {
        setData(b.data.data)
        setHist(h.data.data)
        setError(null)
      })
      .catch(err => setError(errorText(err)))
  }

  useEffect(load, [group, oddsKind, edge, btModel])

  // poll while a run is in progress
  useEffect(() => {
    if (!data?.progress) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [data?.progress?.done, data?.progress?.group])

  const start = () => {
    setStarting(true)
    axios
      .post(`${API_URL}/backtest/run`, null, { params: { season: BACKTEST_SEASON, model: btModel } })
      .then(() => setTimeout(load, 1500))
      .catch(err => setError(errorText(err)))
      .finally(() => setStarting(false))
  }

  const groups = hist ? Object.keys(hist.groups) : []
  const named = { ...data, byCompetition: (data?.byCompetition || []).map(c => ({ ...c, name: DIVISION_NAME[c.code] || c.code })) } as BacktestData

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          <Chip active={group === 'ALL'} onClick={() => setGroup('ALL')}>{tt("All leagues")}</Chip>
          {groups.map(g => (
            <Chip key={g} active={group === g} onClick={() => setGroup(g)}>
              {GROUP_NAME[g] || g}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" title={tt("Which model to score")}>
            {(['dc-history-v2', 'grid-v3'] as const).map(k => (
              <button key={k} onClick={() => setBtModel(k)} className={`seg-btn ${btModel === k ? 'seg-btn-active' : ''}`}>
                {k === 'grid-v3' ? tt("v3 grid") : tt("v2 history")}
              </button>
            ))}
          </div>
          <div className="seg" title={tt("Which bookmaker price to score against")}>
            {(['close', 'early'] as const).map(k => (
              <button
                key={k}
                onClick={() => setOddsKind(k)}
                className={`seg-btn ${oddsKind === k ? 'seg-btn-active' : ''}`}
              >
                {k === 'close' ? tt("Closing odds") : tt("Early odds (1–3 days before)")}
              </button>
            ))}
          </div>
          <div className="seg" title={tt("Minimum model edge to place a value bet")}>
            {[0.03, 0.05, 0.1, 0.15].map(e => (
              <button
                key={e}
                onClick={() => setEdge(e)}
                className={`seg-btn ${edge === e ? 'seg-btn-active' : ''}`}
              >
                {tt("edge ≥ {0}%", { 0: Math.round(e * 100) })}
              </button>
            ))}
          </div>
        {isAdmin && (
        <button
          onClick={start}
          disabled={starting || !!data?.progress}
          className="px-4 py-2 text-sm font-semibold rounded-xl bg-accent text-bg hover:opacity-90 disabled:opacity-40 transition"
        >
          {data?.progress ? tt("Running {0} · {1}/{2}", { 0: GROUP_NAME[data.progress.group] || data.progress.group, 1: data.progress.done, 2: data.progress.total }) : tt("Run {0} backtest 2025–26", { 0: btModel === 'grid-v3' ? 'v3' : 'v2' })}
        </button>
        )}
        </div>
      </div>

      {hist && (
        <p className="text-xs text-muted mb-4">
          {tt("History: {0} matches loaded · model v2 fitted for {1} countries", { 0: hist.history.total.toLocaleString(LOCALE), 1: Object.keys(hist.model.groups).length })}{hist.model.lastFitAt && ` (${new Date(hist.model.lastFitAt).toLocaleString(LOCALE)})`}
          {Object.entries(hist.model.teamMap || {}).some(([, r]) => r.unmatched.length > 0) && (
            <span className="text-draw">
              {' '}{tt("· unmatched teams:")}{' '}
              {Object.entries(hist.model.teamMap)
                .filter(([, r]) => r.unmatched.length)
                .map(([g, r]) => `${g}: ${r.unmatched.join(', ')}`)
                .join(' | ')}
            </span>
          )}
        </p>
      )}

      {error && <div className="card border-loss/40 text-loss rounded-lg p-4 mb-5">{error}</div>}

      {data && data.settled === 0 && !data.progress && (
        <div className="card p-12 text-center text-muted">
          <p className="font-display text-lg font-bold text-ink mb-1">{tt("No backtest yet")}</p>
          <p className="text-sm">{isAdmin ? tt("Click \"Run backtest\" — it takes about a minute for all leagues.") : tt("Results will appear here soon.")}</p>
        </div>
      )}

      {data && data.settled > 0 && (
        <>
          <MetricsView m={named} groupLabel="Division" />
          <Section title={tt("Sample · latest {0} predictions", { 0: data.sample.length })}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="label">
                  <tr>
                    <th className="text-left font-medium py-1">{tt("Date")}</th>
                    <th className="text-left font-medium">{tt("Match")}</th>
                    <th className="text-center font-medium">{tt("Score")}</th>
                    <th className="text-center font-medium">1</th>
                    <th className="text-center font-medium">X</th>
                    <th className="text-center font-medium">2</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sample.map((r, i) => {
                    const pick: Outcome = r.p_home >= r.p_draw && r.p_home >= r.p_away ? 'H' : r.p_away >= r.p_draw ? 'A' : 'D'
                    return (
                      <tr key={i} className="border-t border-line/50">
                        <td className="py-1.5 text-muted whitespace-nowrap">{r.date}</td>
                        <td>
                          {r.home} – {r.away} <span className="text-xs text-faint ml-1">{DIVISION_NAME[r.division] || r.division}</span>
                        </td>
                        <td className="text-center font-semibold num">{r.hg}–{r.ag}</td>
                        {(['H', 'D', 'A'] as Outcome[]).map(o => {
                          const p = o === 'H' ? r.p_home : o === 'D' ? r.p_draw : r.p_away
                          const odds = o === 'H' ? r.odds_home : o === 'D' ? r.odds_draw : r.odds_away
                          return (
                            <td key={o} className={`text-center num ${r.outcome === o ? 'font-bold text-ink' : 'text-muted'} ${pick === o ? 'underline decoration-2 underline-offset-2' : ''}`}>
                              {Math.round(p)}%
                              {odds && <div className="text-[10px] text-faint">{odds}</div>}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`chip ${active ? 'chip-active' : ''}`}
    >
      {children}
    </button>
  )
}

function Tile({
  label,
  value,
  sub,
  good,
  hint
}: {
  label: string
  value: string | number
  sub?: string
  good?: boolean
  hint?: string
}) {
  return (
    <div className="card p-4" title={hint}>
      <div className="label mb-1.5">{label}</div>
      <div className="num text-3xl font-extrabold text-ink tracking-tight">{value}</div>
      {sub && (
        <div className={`text-xs mt-0.5 ${good === undefined ? 'text-faint' : good ? 'text-win' : 'text-loss'}`}>
          {sub}
        </div>
      )}
    </div>
  )
}

function Strategy({ title, s }: { title: string; s: { bets: number; wins: number; profit: number; roi: number } }) {
  const pos = s.profit >= 0
  return (
    <div className="rounded-xl bg-surface2/60 border border-line/50 p-4">
      <div className="text-sm font-medium text-muted mb-2">{title}</div>
      <div className="flex items-baseline gap-4">
        <div>
          <div className={`text-2xl font-bold num ${pos ? 'text-win' : 'text-live'}`}>
            {pos ? '+' : ''}
            {s.profit.toFixed(2)}u
          </div>
          <div className="text-xs text-muted">{tt("profit")}</div>
        </div>
        <div>
          <div className={`text-lg font-semibold num ${pos ? 'text-win' : 'text-live'}`}>
            {pos ? '+' : ''}
            {s.roi}%
          </div>
          <div className="text-xs text-muted">{tt("ROI")}</div>
        </div>
        <div className="text-sm text-muted num">
          {tt("{0} bets · {1} won", { 0: s.bets, 1: s.wins })}</div>
      </div>
    </div>
  )
}

/* ---------- live closing-line value ---------- */

interface ClvData {
  tracked: number
  withClose: number
  settled: number
  distanceToClose: { openPrice: number | null; openPlus25pctV3: number | null; openPlus50pctV3: number | null }
  brier: { v3AtOpen: number | null; marketOpen: number | null; marketClose: number | null } | null
  value: { edge: number; bets: number; avgClv: number | null; clvPositive: number | null; lineMovedOurWay: number | null; settled: number; wins: number; roi: number | null }[]
  recent: { kickoff: string; match: string; book: string; selection: 'H' | 'D' | 'A'; v3: number; openOdds: number; closeOdds: number; edge: number; clv: number; outcome: string | null }[]
}

function ClvPanel({ days }: { days: number }) {
  const [d, setD] = useState<ClvData | null>(null)
  useEffect(() => {
    axios
      .get(`${API_URL}/clv`, { params: { days } })
      .then(r => setD(r.data.data))
      .catch(() => setD(null))
  }, [days])
  if (!d) return null
  const v5 = d.value.find(v => v.edge === 0.05)
  const closer =
    d.distanceToClose.openPrice !== null && d.distanceToClose.openPlus25pctV3 !== null
      ? d.distanceToClose.openPlus25pctV3 < d.distanceToClose.openPrice
      : null
  return (
    <Section title={tt("Beat the market · live closing-line value (v3)")}>
      {d.withClose === 0 ? (
        <p className="text-sm text-muted">
          {tt("Tracking starts with the next matchday: for every top-league match v3's prediction and the bookmaker price are stored 48 h before kick-off, and the price again just before kick-off.")}{' '}{d.tracked > 0 && tt("{0} matches opened so far.", { 0: d.tracked })}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label={tt("Matches tracked")} value={d.withClose} sub={tt("{0} finished", { 0: d.settled })} />
            <Tile
              label={tt("Line moved toward v3")}
              value={v5?.lineMovedOurWay !== null && v5?.lineMovedOurWay !== undefined ? `${v5.lineMovedOurWay}%` : '–'}
              sub={tt("{0} value picks (edge ≥ 5%) · 50% = coin flip", { 0: v5?.bets || 0 })}
              good={v5?.lineMovedOurWay != null ? v5.lineMovedOurWay > 50 : undefined}
            />
            <Tile
              label={tt("Average CLV")}
              value={v5?.avgClv !== null && v5?.avgClv !== undefined ? `${v5.avgClv > 0 ? '+' : ''}${v5.avgClv}%` : '–'}
              sub={tt("open price vs fair closing price")}
              good={v5?.avgClv != null ? v5.avgClv > 0 : undefined}
              hint={tt("Above 0 = we got a better price than the market's final one")}
            />
            <Tile
              label={tt("v3 pulls toward the close")}
              value={closer === null ? '–' : closer ? 'Yes' : 'No'}
              sub={
                d.distanceToClose.openPrice !== null ? tt("open {0} → with 25% v3 {1}", { 0: d.distanceToClose.openPrice, 1: d.distanceToClose.openPlus25pctV3 }) : undefined
              }
              good={closer ?? undefined}
              hint={tt("Does mixing v3 into the early price land closer to where the market ends? Yes = v3 knows something early.")}
            />
          </div>
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead className="label">
                <tr className="text-left">
                  <th className="py-2 pr-3">{tt("Edge ≥")}</th>
                  <th className="py-2 pr-3 text-right">{tt("Picks")}</th>
                  <th className="py-2 pr-3 text-right">{tt("Moved our way")}</th>
                  <th className="py-2 pr-3 text-right">{tt("CLV > 0")}</th>
                  <th className="py-2 pr-3 text-right">{tt("Avg CLV")}</th>
                  <th className="py-2 pr-3 text-right">{tt("Settled")}</th>
                  <th className="py-2 text-right">{tt("ROI at open price")}</th>
                </tr>
              </thead>
              <tbody>
                {d.value.map(v => (
                  <tr key={v.edge} className="border-t border-line/50">
                    <td className="py-2 pr-3 num">{Math.round(v.edge * 100)}%</td>
                    <td className="py-2 pr-3 text-right num">{v.bets}</td>
                    <td className="py-2 pr-3 text-right num">{v.lineMovedOurWay ?? '–'}{v.lineMovedOurWay !== null ? '%' : ''}</td>
                    <td className="py-2 pr-3 text-right num">{v.clvPositive ?? '–'}{v.clvPositive !== null ? '%' : ''}</td>
                    <td className={`py-2 pr-3 text-right num ${v.avgClv !== null && v.avgClv > 0 ? 'text-win' : ''}`}>
                      {v.avgClv !== null ? `${v.avgClv > 0 ? '+' : ''}${v.avgClv}%` : '–'}
                    </td>
                    <td className="py-2 pr-3 text-right num">{v.settled}</td>
                    <td className={`py-2 text-right num ${v.roi !== null ? (v.roi >= 0 ? 'text-win' : 'text-loss') : ''}`}>
                      {v.roi !== null ? `${v.roi > 0 ? '+' : ''}${v.roi}%` : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.brier && (
            <p className="text-xs text-muted mt-3">
              {tt("Brier on finished matches: v3 at open")} <span className="num text-ink">{d.brier.v3AtOpen}</span> {tt("· market at open")} <span className="num text-ink">{d.brier.marketOpen}</span> {tt("· market at close")} <span className="num text-ink">{d.brier.marketClose}</span>
            </p>
          )}
          {d.recent.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">{tt("Latest tracked matches")}</summary>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <tbody>
                    {d.recent.map((r, i) => (
                      <tr key={i} className="border-t border-line/40">
                        <td className="py-1.5 pr-3 text-faint num">{new Date(r.kickoff).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short' })}</td>
                        <td className="py-1.5 pr-3 text-ink">{r.match}</td>
                        <td className="py-1.5 pr-3 text-muted">
                          {r.selection === 'H' ? tt("Home") : r.selection === 'D' ? tt("Draw") : tt("Away")} · v3 {r.v3}%
                        </td>
                        <td className="py-1.5 pr-3 num text-muted">{r.openOdds} → {r.closeOdds}</td>
                        <td className={`py-1.5 pr-3 num ${r.clv > 0 ? 'text-win' : 'text-loss'}`}>{tt("CLV")}{' '}{r.clv > 0 ? '+' : ''}{r.clv}%</td>
                        <td className="py-1.5 text-faint">{r.outcome ?? tt("pending")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <p className="text-xs text-faint mt-3">
            {tt("How professionals measure an edge: take v3's view and the price 48 h before kick-off, then compare with the price just before kick-off. If the market keeps moving toward v3 (above 50%) and the average CLV is positive, the edge is real — regardless of short-run wins and losses. Prices:")}{' '}{d.recent[0]?.book || 'Pinnacle / Bet365'} {tt("via API-Football.")}</p>
        </>
      )}
    </Section>
  )
}

function Section({ title, children, flat }: { title: string; children: ReactNode; flat?: boolean }) {
  return (
    <section className={`card p-5 sm:p-6 ${flat ? '' : 'mt-5'}`}>
      <h3 className="font-display text-base font-bold text-ink mb-4">{title}</h3>
      {children}
    </section>
  )
}

export default Accuracy

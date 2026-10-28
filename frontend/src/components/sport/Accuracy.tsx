import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import NameLink from './NameLink'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { errorText, useAuth } from '../../lib/auth'
import { t, LOCALE } from '../../lib/i18n'
import { ModelName } from './game/ModelName'
import type { ModelSport } from '../../lib/modelNames'
import MoreRecord from './accuracy/MoreRecord'
import type { MoreSport } from './game/MorePredictions'

/**
 * Accuracy / "Our record" (football's record page, shared by every sport since fix152b): period chips, the headline
 * card (our pick, bands by how sure we were, strong picks), the sport's own extra cards, calibration + picks by how
 * sure we were, the record by league (admins), the latest games. The adapter loads the sport's record and turns it
 * into this shape; the layout is the same in every sport.
 */
export interface AccBin { lo: number; hi: number; n: number; said: number; happened: number | null }
export interface AccConf { id: string; label: string; n: number; hitRate: number | null; said: number | null }
/** cols: a number is a % (football's markets); a string is shown as it is (fix174: winner sports' "± points") */
export interface AccLeague { key: string; name: ReactNode; href?: string | null; n: number; main: number | null; cols: (number | string | null)[]; note?: ReactNode }
export interface AccRecent { id: number | string; href: string; date: string; comp: string | null; compHref?: string | null; home: string; away: string; score: string; cells: ReactNode[] }
export interface AccData {
  headline: {
    label: string
    value: number | null
    text: string
    bands: { label: string; pct: number | null; n: number }[]
    strong?: { label: string; hitRate: number | null; hits: number; n: number } | null
  }
  /** the sport's own cards between the headline and the calibration (football: the hard and the safer calls) */
  extra?: ReactNode
  calibration?: AccBin[]
  byConfidence?: AccConf[]
  leagues: AccLeague[]
  recent: AccRecent[]
  /** under the latest games (basketball: games waiting for the result, pre-season games) */
  after?: ReactNode
}
export interface AccuracyAdapter {
  title: string
  /** fix191: whose record this is (the public model name under the intro) */
  model: ModelSport
  intro: string
  /** API path under API_URL; gets ?days= */
  url: string
  toData: (raw: any) => AccData
  /** "every chance we gave …" under the calibration title */
  calibrationText: string
  /** label over the by-confidence bars */
  confidenceLabel: string
  /** columns of the by-league table after "Games" and the main (bar) column */
  leagueCols: { main: string; cols: string[] }
  leagueNote: string
  /** columns of the latest games table after Match / Score */
  recentCols: string[]
  footnote: string
  /** fix204: the sport's "More predictions" record */
  more: MoreSport
  /** admins: the detailed statistics page (football) */
  detailed?: () => ReactNode
}

const PERIODS = [
  { days: 7, label: t("7 days") },
  { days: 30, label: t("30 days") },
  { days: 90, label: t("3 months") },
  { days: 365, label: t("1 year") }
]

export const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x * 10) / 10}%`)

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 sm:p-6 ${className}`}>{children}</div>
}

export function Bar({ v, cls }: { v: number | null; cls: string }) {
  return (
    <div className="h-3 rounded-full bg-surface2 overflow-hidden">
      <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(100, v ?? 0)}%` }} />
    </div>
  )
}

export function Tick({ hit }: { hit: boolean | null | undefined }) {
  if (hit === null || hit === undefined) return <span className="text-faint">–</span>
  return hit ? <span className="text-win font-bold" aria-label={t("right")}>✓</span> : <span className="text-loss font-bold" aria-label={t("wrong")}>✗</span>
}

/** A stat card of football's "hard calls" row: label, big number, bar, one line. */
export function StatCard({ label, value, text, bar, accent = false }: { label: string; value: number | null | undefined; text: string; bar: string; accent?: boolean }) {
  return (
    <Card className={accent ? 'border-accent/40' : ''}>
      <div className={`label ${accent ? 'text-accent' : ''}`}>{label}</div>
      <div className={`num text-5xl font-extrabold mt-4 ${accent ? 'text-accent' : 'text-ink'}`}>{pct(value)}</div>
      <div className="mt-3"><Bar v={value ?? null} cls={bar} /></div>
      <p className="text-xs text-muted mt-4">{text}</p>
    </Card>
  )
}

export function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="pt-2">
      <h2 className="font-display text-xl font-bold text-ink">{title}</h2>
      <p className="text-sm text-muted">{sub}</p>
    </div>
  )
}

export default function Accuracy({ a }: { a: AccuracyAdapter }) {
  const { access } = useAuth()
  const [days, setDays] = useState(30)
  const [raw, setRaw] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailed, setDetailed] = useState(false)

  useEffect(() => { document.title = t('{0} · SportLikely', { 0: a.title }) }, [a.title])
  useEffect(() => {
    if (detailed) return
    let cancelled = false
    setLoading(true)
    axios
      .get(`${API_URL}${a.url}`, { params: { days } })
      .then(r => !cancelled && (setRaw(r.data.data), setError(null)))
      .catch(e => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [days, detailed, a.url])

  if (detailed && a.detailed)
    return (
      <div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
          <button onClick={() => setDetailed(false)} className="text-sm text-muted hover:text-ink">
            {t("← Back to the public record")}</button>
        </div>
        {a.detailed()}
      </div>
    )

  const rec = raw ? a.toData(raw) : null
  // fix203: every competition with 5+ settled games, most games first (nothing filtered by size or tier)
  const leagueRows = rec ? rec.leagues.filter(c => c.n >= 5).sort((x, y) => y.n - x.n) : []
  const h = rec?.headline

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-28 xl:pb-10 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{a.title}</h1>
          <p className="text-sm text-muted mt-1 max-w-xl">{a.intro}</p>
          <ModelName sport={a.model} className="mt-2" />
        </div>
        <div className="seg">
          {PERIODS.map(p => (
            <button key={p.days} onClick={() => setDays(p.days)} className={`seg-btn ${days === p.days ? 'seg-btn-active' : ''}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Card className="text-loss text-sm">{error}</Card>}
      {loading && !rec && <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="card h-56 animate-pulse bg-surface2/60" />)}</div>}

      {rec && h && (
        <>
          <Card className="border-accent/40">
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="min-w-0">
                <div className="label text-accent">{h.label}</div>
                <div className="num text-5xl sm:text-6xl font-extrabold text-accent mt-3">{pct(h.value)}</div>
                <div className="mt-3"><Bar v={h.value} cls="bg-accent" /></div>
                <p className="text-xs text-muted mt-4">{h.text}</p>
                {h.bands.some(x => x.n > 0) && (
                  <ul className="mt-3 space-y-1 text-xs max-w-sm">
                    {h.bands.filter(x => x.n > 0).map(x => (
                      <li key={x.label} className="flex justify-between gap-2">
                        <span className="text-muted">{t("When we were {0} sure", { 0: x.label })}</span>
                        <span className="num font-semibold text-ink">{pct(x.pct)} <span className="text-faint font-normal">({x.n})</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {h.strong && h.strong.n > 0 && (
                <div className="rounded-2xl bg-surface2/60 px-4 py-3 sm:min-w-[180px]">
                  <div className="text-[11px] font-bold text-muted">{h.strong.label}</div>
                  <div className="num text-3xl font-extrabold text-win mt-1">{pct(h.strong.hitRate)}</div>
                  <div className="text-[11px] text-faint num">{t("{0} of {1} right", { 0: h.strong.hits, 1: h.strong.n })}</div>
                </div>
              )}
            </div>
          </Card>

          {rec.extra}

          {((rec.calibration && rec.calibration.some(b => b.n >= 10)) || (rec.byConfidence && rec.byConfidence.some(b => b.n > 0))) && (
            <Card>
              <h2 className="font-display text-xl font-bold text-ink">{t("When we say 70%, does it happen 70% of the time?")}</h2>
              <p className="text-sm text-muted mt-1 mb-5 max-w-3xl">{a.calibrationText}</p>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr] items-start">
                {rec.calibration && <CalibrationChart bins={rec.calibration.filter(b => b.n >= 10)} />}
                {rec.byConfidence && rec.byConfidence.some(b => b.n > 0) && (
                  <div>
                    <div className="label pb-2">{a.confidenceLabel}</div>
                    <div className="space-y-3">
                      {rec.byConfidence.filter(b => b.n > 0).map(b => (
                        <div key={b.id} className="grid grid-cols-[110px_1fr_auto] sm:grid-cols-[140px_1fr_auto] items-center gap-3">
                          <div>
                            <div className="text-sm font-semibold text-ink">{t("We said")}{' '}{b.label}</div>
                            <div className="text-[11px] text-faint num">{b.n} {t("games · average")}{' '}{b.said}%</div>
                          </div>
                          <div className="relative h-3 rounded-full bg-surface2 overflow-hidden">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, b.hitRate ?? 0)}%` }} />
                            {b.said !== null && <div className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-ink/70" style={{ insetInlineStart: `${b.said}%` }} title={t("We said {0}%", { 0: b.said })} />}
                          </div>
                          <div className="text-end min-w-[92px]">
                            <div className="num text-sm font-extrabold text-ink">{pct(b.hitRate)} {t("right")}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-faint mt-3">{t("The thin line on each bar is the chance we gave; the bar is how often it happened.")}</p>
                  </div>
                )}
              </div>
            </Card>
          )}

          {access === 'admin' && leagueRows.length > 0 && (
            <Card>
              <h2 className="font-display text-xl font-bold text-ink">{t("Our record by competition")} <span className="ms-2 text-[11px] font-semibold uppercase tracking-wide text-faint">admin only</span></h2>
              <p className="text-sm text-muted mt-1 mb-4">{t("How often each call was right, league by league, in the period you picked.")}</p>
              <div className="overflow-x-auto -mx-1">
                <table className={`w-full text-sm ${a.leagueCols.cols.length > 1 ? 'min-w-[600px]' : 'min-w-[420px]'}`}>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-faint">
                      <th className="text-start font-semibold py-2 px-1">{t("Competition")}</th>
                      <th className="text-end font-semibold py-2 px-1 w-14">{t("Games")}</th>
                      {a.leagueCols.cols.length > 0 && <th className="text-end font-semibold py-2 px-1 w-20">{a.leagueCols.cols[0]}</th>}
                      <th className="text-start font-semibold py-2 px-2 w-44">{a.leagueCols.main}</th>
                      {a.leagueCols.cols.slice(1).map(c => <th key={c} className="text-end font-semibold py-2 px-1 w-20">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {leagueRows.map(c => {
                      const few = c.n < 20
                      return (
                        <tr key={c.key} className="border-t border-line/50">
                          <td className="py-2 px-1">
                            <span className="flex items-center gap-2 min-w-0">
                              {c.href ? <Link to={c.href} className="text-ink hover:text-accent truncate">{c.name}</Link> : <span className="text-ink truncate">{c.name}</span>}
                              {c.note}
                              {few && <span className="shrink-0 rounded px-1 text-[9px] font-semibold text-faint bg-surface2" title={t("Under 20 games: too few to judge yet")}>{t("few games")}</span>}
                            </span>
                          </td>
                          <td className="py-2 px-1 text-end num text-muted">{c.n}</td>
                          {c.cols.length > 0 && <td className="py-2 px-1 text-end num font-bold text-ink">{typeof c.cols[0] === 'string' ? c.cols[0] : pct(c.cols[0])}</td>}
                          <td className="py-2 px-2">
                            <span className="flex items-center gap-2">
                              <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden"><span className={`block h-full rounded-full ${few ? 'bg-accent/50' : 'bg-accent'}`} style={{ width: `${Math.min(100, c.main ?? 0)}%` }} /></span>
                              <span className={`num font-bold w-11 text-end ${few ? 'text-muted' : 'text-accent'}`}>{pct(c.main)}</span>
                            </span>
                          </td>
                          {c.cols.slice(1).map((v, i) => <td key={i} className="py-2 px-1 text-end num text-muted">{typeof v === 'string' ? v : pct(v)}</td>)}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-faint mt-2">{a.leagueNote}</p>
            </Card>
          )}

          <Card>
            <h2 className="font-display text-xl font-bold text-ink mb-3">{t("Latest games")}</h2>
            {rec.recent.length === 0 ? (
              <p className="text-sm text-muted">{t("No finished games in this period yet.")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className={`w-full text-sm ${a.recentCols.length > 2 ? 'min-w-[800px]' : 'min-w-[480px]'}`}>
                  <thead>
                    <tr className="text-xs text-faint">
                      <th className="text-start font-medium py-2">{t("Match")}</th>
                      <th className="text-center font-medium py-2">{t("Score")}</th>
                      {a.recentCols.map(c => <th key={c} className="text-start font-medium py-2">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rec.recent.map(x => (
                      <tr key={x.id} className="border-t border-line/50">
                        <td className="py-2 pe-2">
                          <Link to={x.href} className="text-ink hover:text-accent">{x.home} – {x.away}</Link>
                          <div className="text-[11px] text-faint">
                            {new Date(x.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}{x.comp ? <> · <NameLink to={x.compHref}>{x.comp}</NameLink></> : ''}
                          </div>
                        </td>
                        <td className="py-2 text-center num font-bold text-ink">{x.score}</td>
                        {x.cells.map((c, i) => <td key={i} className="py-2">{c}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {rec.after}

          <MoreRecord sport={a.more} />

          <p className="text-xs text-faint">{a.footnote}</p>
        </>
      )}

      {access === 'admin' && a.detailed && (
        <div className="text-center">
          <button onClick={() => setDetailed(true)} className="text-sm text-muted hover:text-ink underline underline-offset-4">
            {t("Admin: detailed statistics (calibration, backtests, all models)")}</button>
        </div>
      )}
    </div>
  )
}

/** Reliability chart: what we said (x) against how often it happened (y); the dashed diagonal is perfect. */
function CalibrationChart({ bins }: { bins: AccBin[] }) {
  if (!bins.length) return null
  const W = 320, H = 320, P = 44
  const x = (v: number) => P + (v / 100) * (W - P - 10)
  const y = (v: number) => H - P - (v / 100) * (H - P - 10)
  const maxN = Math.max(...bins.map(b => b.n))
  const pts = bins.filter(b => b.happened !== null)
  return (
    <div className="rounded-2xl border border-line/60 bg-surface2/30 p-3 w-full max-w-[420px] mx-auto lg:mx-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={t('Calibration chart')}>
        {[0, 20, 40, 60, 80, 100].map(v => (
          <g key={v}>
            <line x1={x(0)} x2={x(100)} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeOpacity="0.5" />
            <text x={P - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="rgb(var(--faint))">{v}%</text>
            <text x={x(v)} y={H - P + 14} textAnchor="middle" fontSize="9" fill="rgb(var(--faint))">{v}%</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke="rgb(var(--ink))" strokeOpacity="0.35" strokeDasharray="4 4" />
        <polyline fill="none" stroke="rgb(var(--accent))" strokeWidth="2" points={pts.map(b => `${x(b.said)},${y(b.happened!)}`).join(' ')} />
        {pts.map(b => (
          <g key={b.lo}>
            <circle cx={x(b.said)} cy={y(b.happened!)} r={3 + 6 * Math.sqrt(b.n / maxN)} fill="rgb(var(--accent))" fillOpacity="0.85" stroke="rgb(var(--bg))" strokeWidth="1.5">
              <title>{t('We said {0}%, it happened {1}% of the time ({2} results)', { 0: b.said, 1: b.happened, 2: b.n })}</title>
            </circle>
          </g>
        ))}
        <text x={(x(0) + x(100)) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="rgb(var(--muted))">{t('The chance we gave')}</text>
        <text x={9} y={(y(0) + y(100)) / 2} textAnchor="middle" fontSize="10" fill="rgb(var(--muted))" transform={`rotate(-90 9 ${(y(0) + y(100)) / 2})`}>{t('How often it happened')}</text>
      </svg>
      <p className="text-[11px] text-faint px-1">{t('Bigger dots = more results. Hover a dot for the numbers.')}</p>
    </div>
  )
}

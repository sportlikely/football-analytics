import { useMemo, useState, type ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { bandOf, bandWord, bandGroup, BAND_TEXT, BAND_FILL, BAND_ORDER, BAND_RANGE } from '../../../lib/confidence'
import UnlockPrompt from '../../UnlockPrompt'
import { SplitBar, PickLine, type BarCell, type BarPick } from './SplitBar'
import { useMore, type MoreSport } from './more'
import { fromMore, sureLines, topicLabel, TOPIC_IDS, OUTPUT_TOPIC, type QCard, type SureItem, type TopicId, type Names, type Hit } from './questions'

/**
 * fix281 — the prediction tab of every sport (Yarin, 29 Oct: "B split bar", "Every prediction as a question", "Most
 * sure first", "One topic at a time"). Drawn once the page's own gates (locked / guess first / reveal) are open:
 *  a. the split bar, big, with "Our pick" + % + band word;
 *  b. "Most sure first": every public prediction of the game as a sentence + bar + %, highest first (one line per
 *     question, no near-certain "no" side, our pick first in its band: sureLines, fix284b), grouped Very
 *     likely 80%+ / Likely 60–79% / Possible under 60%; 8 shown, "Show all" opens the rest;
 *  c. "One topic at a time": the topics as sub-paths (football Result · Goals · Score · Half-time …), question cards
 *     inside; a topic without a public output is not shown (admins: shown with the admin badge);
 *  d. "Why we think so" behind one button.
 * Phones: one column; from 1024 px the list and the topics side by side.
 */
export interface PanelMain {
  /** the big bar (football: 1 · X · 2 with our double chance on; winner sports: 1 · 2) */
  cells: BarCell[]
  pick: BarPick
  /** the main prediction's own sentences (who wins, our double chance …) */
  items: SureItem[]
  /** "Who wins?" — the first card of the Result topic */
  card: QCard
}
export interface PredictionPanelProps {
  sport: MoreSport
  /** the id the extras are stored under, and the unlock id / status for the lock prompt */
  moreId: number
  rid: number
  status: string
  names: Names
  main: PanelMain
  topic: string
  onTopic: (id: TopicId) => void
  /** under the bar: model name, saved before the start, live chance … */
  under?: ReactNode
  /** "Why we think so" (fix282 builds the new one): opened by the button under the list */
  why?: ReactNode
  /** fix284b: "Hide prediction again" (guess first, before the start) — drawn under the "Our pick" line */
  onHide?: () => void
}

export const SURE_SHOWN = 8

function HitLine({ hit }: { hit?: Hit | null }) {
  if (!hit) return null
  return <div className="mt-1.5 text-xs text-faint">{t("What happened: {0}", { 0: hit.text })} <span className={hit.ok ? 'text-win font-bold' : 'text-loss font-bold'}>{hit.ok ? '✓' : '✗'}</span></div>
}
function AdminBadge() {
  return <span className="text-[10px] font-bold uppercase tracking-wide text-draw">{t("admin only")}</span>
}

/** one sentence with its bar and % (the bar and % in the band's colour) */
function SureRow({ x }: { x: SureItem }) {
  const b = bandOf(x.pct)
  return (
    <li data-testid="sure-row" data-id={x.id} data-pct={Math.round(x.pct)} data-band={b} data-main={x.main ? '1' : undefined} className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink leading-snug min-w-0">{x.text}{x.admin && <span className="ms-2"><AdminBadge /></span>}</span>
        <span className={`num text-sm font-extrabold whitespace-nowrap ${BAND_TEXT[b]}`}>{Math.round(x.pct)}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden" aria-hidden><div className={`h-full rounded-full ${BAND_FILL[b]}`} style={{ width: `${Math.min(100, x.pct)}%` }} /></div>
      {x.hit && <div className="mt-1 text-[11px] text-faint">{t("What happened: {0}", { 0: x.hit.text })} <span className={x.hit.ok ? 'text-win font-bold' : 'text-loss font-bold'}>{x.hit.ok ? '✓' : '✗'}</span></div>}
    </li>
  )
}

export function SureList({ items }: { items: SureItem[] }) {
  const [all, setAll] = useState(false)
  const sorted = sureLines(items)
  const shown = all ? sorted : sorted.slice(0, SURE_SHOWN)
  return (
    <div data-testid="sure-list">
      <h3 className="font-display text-sm font-bold text-ink">{t("Most sure first")}</h3>
      <p className="text-xs text-faint mt-0.5">{t("Every prediction for this game, the surest on top.")}</p>
      {BAND_ORDER.map(b => {
        const list = shown.filter(x => bandOf(x.pct) === b)
        if (!list.length) return null
        return (
          <div key={b} data-testid="sure-group" data-band={b} className="mt-3">
            <div className={`text-[11px] font-extrabold uppercase tracking-wide ${BAND_TEXT[b]}`}>{bandGroup(b)} <span className="num font-bold opacity-80" dir="ltr">{BAND_RANGE[b]}</span></div>
            <ul className="divide-y divide-line/50">{list.map(x => <SureRow key={x.id} x={x} />)}</ul>
          </div>
        )
      })}
      {sorted.length > SURE_SHOWN && (
        <button type="button" onClick={() => setAll(v => !v)} className="mt-3 text-sm font-semibold text-accent hover:underline">
          {all ? t("Show fewer") : t("Show all ({0})", { 0: sorted.length })}
        </button>
      )}
    </div>
  )
}

export function QuestionCard({ c }: { c: QCard }) {
  const [grid, setGrid] = useState(false)
  return (
    <div data-testid="q-card" data-card={c.id} className="rounded-2xl border border-line/70 bg-surface2/30 p-4 min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h4 className="text-sm font-bold text-ink">{c.q}</h4>
        {c.admin && <AdminBadge />}
      </div>
      {c.kind === 'split' && (
        <>
          <SplitBar cells={c.cells} labels={c.cells.map(x => x.label)} />
          <div className="mt-2.5 flex items-center gap-1.5 text-sm" data-testid="our-call" data-band={bandOf(c.call.pct)}>
            <span className="text-faint">{t("Our call")}</span>
            <span className="font-bold text-ink truncate">{c.call.words}</span>
            <span className={`num font-extrabold ${BAND_TEXT[bandOf(c.call.pct)]}`}>{Math.round(c.call.pct)}%</span>
            <span className={`text-xs font-semibold ${BAND_TEXT[bandOf(c.call.pct)]}`}>{bandWord(bandOf(c.call.pct))}</span>
          </div>
        </>
      )}
      {c.kind === 'bars' && (
        <div className="space-y-1.5">
          {c.rows.map(r => (
            <div key={r.label} className="flex items-center gap-2 text-[13px]">
              <span className={`w-28 sm:w-36 shrink-0 truncate ${r.top ? 'font-bold text-ink' : 'text-muted'}`} title={r.label}>{r.label}</span>
              <div className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${r.top ? 'bg-accent' : 'bg-muted/40'}`} style={{ width: `${Math.min(100, r.pct)}%` }} /></div>
              <span className={`num w-10 text-end ${r.top ? 'font-bold text-accent' : 'text-ink'}`}>{Math.round(r.pct)}%</span>
              <span className="w-3 text-center text-win" aria-hidden>{r.was ? '●' : ''}</span>
            </div>
          ))}
          {c.note && <p className="pt-1 text-xs text-muted">{c.note}</p>}
        </div>
      )}
      {c.kind === 'chart' && (
        <>
          <div className="flex items-end gap-2 h-28" dir="ltr">
            {c.bars.map(b => {
              const max = Math.max(...c.bars.map(x => x.pct)) || 1
              return (
                <div key={b.label} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
                  <span className={`num text-[11px] ${b.top ? 'font-bold text-accent' : 'text-muted'}`}>{Math.round(b.pct)}%</span>
                  <div className={`w-full rounded-t-md ${b.top ? 'bg-accent' : 'bg-muted/40'}`} style={{ height: `${Math.max(4, (b.pct / max) * 80)}%` }} />
                  <span className="num text-xs font-semibold text-ink">{b.label}</span>
                </div>
              )
            })}
          </div>
          {c.note && <p className="mt-2 text-sm text-ink">{c.note}</p>}
        </>
      )}
      {c.kind === 'scores' && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {c.tiles.map((x, i) => (
              <div key={x.label} className={`rounded-xl px-2 py-2.5 text-center ${i === 0 ? 'bg-accent/15 border border-accent/40' : 'bg-surface2/70 border border-transparent'} ${x.was ? 'ring-2 ring-win/60' : ''}`}>
                <div className={`num font-display text-lg font-extrabold ${i === 0 ? 'text-accent' : 'text-ink'}`} dir="ltr">{x.label}</div>
                <div className="num text-[11px] text-muted">{x.pct.toFixed(1)}%</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">{c.note}</p>
          {c.grid6 && (
            <>
              <button type="button" onClick={() => setGrid(v => !v)} className="mt-2 text-xs font-semibold text-accent hover:underline">{grid ? t("Hide the grid") : t("Every score")}</button>
              {grid && (
                <div className="mt-2 overflow-x-auto">
                  <table className="text-xs num border-separate border-spacing-0.5 mx-auto" dir="ltr">
                    <tbody>
                      {c.grid6.map((row, i) => (
                        <tr key={i}><th className="px-1 text-faint font-semibold text-end">{i}</th>
                          {row.map((v, j) => {
                            const max = Math.max(...c.grid6!.flat()) || 1
                            return <td key={j} title={`${i}–${j}: ${v}%`} className="w-9 h-7 text-center rounded" style={{ background: `rgb(var(--accent) / ${Math.min(0.85, (v / max) * 0.85)})`, color: v / max > 0.55 ? 'rgb(var(--bg))' : undefined }}>{v.toFixed(1)}</td>
                          })}
                        </tr>
                      ))}
                      <tr><th />{c.grid6[0].map((_, j) => <th key={j} className="px-1 text-faint font-semibold">{j}</th>)}</tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
      <HitLine hit={c.hit} />
    </div>
  )
}

export default function PredictionPanel(x: PredictionPanelProps) {
  const d = useMore(x.sport, x.moreId)
  const [why, setWhy] = useState(false)
  const more = useMemo(() => fromMore(x.sport, d, x.names), [x.sport, d, x.names.home, x.names.away])
  const items = useMemo(() => [...x.main.items, ...more.items], [x.main.items, more.items])
  const locked = !!d?.prediction.locked
  const topics = TOPIC_IDS[x.sport].filter(id => id === 'result' || more.topics.has(id))
  const topic: TopicId = (topics as string[]).includes(x.topic) ? (x.topic as TopicId) : 'result'
  const cardsOf = (id: TopicId) => [...(id === 'result' ? [x.main.card] : []), ...more.cards.filter(c => (OUTPUT_TOPIC[x.sport][c.id] || 'result') === id)]
  const adminTopic = (id: TopicId) => id !== 'result' && cardsOf(id).every(c => c.admin)
  const cards = cardsOf(topic)
  return (
    <div data-testid="prediction-panel" data-topic={topic}>
      {/* a. the split bar, big */}
      <div className="grid grid-cols-2 items-end gap-3 mb-2">
        <span className="font-display font-bold text-ink truncate">{x.names.home}</span>
        <span className="font-display font-bold text-ink truncate text-end">{x.names.away}</span>
      </div>
      <SplitBar cells={x.main.cells} size="lg" />
      <div className="mt-3"><PickLine pick={x.main.pick} size="lg" /></div>
      {x.onHide && (
        <button type="button" onClick={x.onHide} data-testid="hide-again" className="mt-1 text-xs text-faint hover:text-ink underline underline-offset-4">{t("Hide prediction again")}</button>
      )}
      {x.under}

      <div className="mt-6 grid gap-6 lg:grid-cols-2 lg:gap-8 min-w-0">
        {/* b. most sure first */}
        <div className="min-w-0">
          <SureList items={items} />
          {locked && <div className="mt-4"><UnlockPrompt rid={x.rid} status={x.status} what={t("Likely scores, totals, half-time and more, each with its chance — saved before the start and checked after.")} /></div>}
          {x.why && (
            <div className="mt-5">
              <button type="button" onClick={() => setWhy(v => !v)} aria-expanded={why} data-testid="why-button"
                className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink hover:border-accent/60 transition-colors">
                {why ? t("Hide why") : t("Why we think so")}
              </button>
              {why && <div className="mt-3">{x.why}</div>}
            </div>
          )}
        </div>
        {/* c. one topic at a time (sub-paths) */}
        <div className="min-w-0">
          <nav className="flex gap-1 p-1 rounded-full bg-surface2/60 border border-line/60 overflow-x-auto no-scrollbar" aria-label={t("Prediction topics")}>
            {topics.map(id => (
              <button key={id} type="button" data-testid="topic-tab" data-topic={id} onClick={() => x.onTopic(id)} aria-current={topic === id ? 'page' : undefined}
                className={`flex-1 min-w-max inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${topic === id ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}>
                {topicLabel(id)}
                {adminTopic(id) && <span className="text-[9px] font-bold uppercase text-draw">{t("admin")}</span>}
              </button>
            ))}
          </nav>
          <div className="mt-3 space-y-3">
            {cards.map(c => <QuestionCard key={c.id} c={c} />)}
            {topic !== 'result' && !cards.length && <p className="text-sm text-faint">{t("Nothing to show for this game yet.")}</p>}
          </div>
          {d?.prediction.void && <p className="mt-3 text-xs text-faint">{t("This game did not finish normally, so these are not checked.")}</p>}
        </div>
      </div>
      <p className="mt-5 text-xs text-faint">{t("Probabilities, not promises. 18+.")}</p>
    </div>
  )
}

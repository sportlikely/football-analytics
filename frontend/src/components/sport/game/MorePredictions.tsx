import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import UnlockPrompt, { GAME_RELOAD } from '../../UnlockPrompt'
import { Section } from './GamePage'

/**
 * "More predictions" (fix204): one block under the main prediction on every sport's game page, from the model we
 * already have — football's score grid (likely scores, goals, clean sheets, win by 2+, half-time, HT/FT), basketball's
 * and American football's predicted points (margin, total, each side's points, first half, overtime), tennis's point
 * chain (set score, first set, games, tie-break). Locked like the prediction: free users see the outputs blurred with
 * the usual unlock prompt; everyone sees the numbers once the game is over, with what happened next to each.
 */
export type MoreSport = 'football' | 'basketball' | 'nfl' | 'tennis'
interface MSet { labels: string[]; p: number[]; cuts?: number[]; top: number }
interface MoreData {
  sport: MoreSport; state: 'upcoming' | 'live' | 'done'; keys: string[]
  prediction: {
    model: string; locked: boolean; madeAt?: string; savedBeforeStart?: boolean
    sets?: Record<string, MSet>; info?: { grid6?: number[][]; expected?: [number, number]; side?: 'H' | 'A'; bo?: number }
    adminOnly?: string[]; result?: { actual: Record<string, string | number | null>; hits: Record<string, { hit: boolean; i: number }> } | null; void?: boolean
  }
}

const dash = (s: string) => s.replace('-', '–')

export default function MorePredictions({ sport, id, rid, status, home, away }: { sport: MoreSport; id: number; rid: number; status: string; home: string; away: string }) {
  const { access } = useAuth()
  const [d, setD] = useState<MoreData | null>(null)
  const [grid, setGrid] = useState(false)
  useEffect(() => {
    let off = false
    const load = () => axios.get(`${API_URL}/more/${sport}/${id}`).then(r => { if (!off) setD(r.data.data || null) }).catch(() => undefined)
    load()
    const iv = setInterval(load, 120000)
    window.addEventListener(GAME_RELOAD, load)
    return () => { off = true; clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [sport, id, access])
  if (!d || !d.keys.length) return null
  const p = d.prediction
  const winner = p.info?.side === 'A' ? away : home, loser = p.info?.side === 'A' ? home : away
  const title: Record<string, string> = {
    score: t('Likely scores'), goals: t('Total goals'), homeGoals: t('{0} goals', { 0: home }), awayGoals: t('{0} goals', { 0: away }),
    cleanHome: t('{0} keeps a clean sheet', { 0: home }), cleanAway: t('{0} keeps a clean sheet', { 0: away }),
    win2Home: t('{0} wins by 2+ goals', { 0: home }), win2Away: t('{0} wins by 2+ goals', { 0: away }),
    ht: t('Half-time result'), htft: t('Half-time / full-time'),
    margin: t('Winning margin: {0}', { 0: winner }), total: t('Total points'), homePts: t('{0} points', { 0: home }), awayPts: t('{0} points', { 0: away }),
    half: sport === 'nfl' ? t('Halftime leader') : t('First-half winner'), ot: t('Overtime'),
    sets: t('Set score'), first: t('First set'), games: t('Total games'), tb: t('At least one tie-break')
  }
  const label = (k: string, l: string) => {
    if (l === 'yes') return t('Yes')
    if (l === 'no') return t('No')
    // the stored key stays 'loser'; on screen it is the other team winning (its own string: '{0} wins' is a count of wins)
    if (k === 'margin') return l === 'loser' ? t('{0} wins instead', { 0: loser }) : t('by {0}', { 0: l })
    if (k === 'ht' || k === 'half') return l === 'H' ? home : l === 'A' ? away : sport === 'football' ? t('Draw') : t('Level')
    if (k === 'htft') return l.split('/').map(x => (x === 'H' ? home : x === 'A' ? away : t('Draw'))).join(' / ')
    if (k === 'first') return l === '1' ? home : away
    if (k === 'score') return l === 'other' ? t('Other') : dash(l)
    if (k === 'sets') return dash(l)
    return l
  }
  const actualText = (k: string) => {
    const r = p.result
    if (!r || !(k in r.hits)) return null
    const s = p.sets?.[k]
    return s ? label(k, s.labels[r.hits[k].i]) : null
  }

  const note = [p.locked ? null : p.savedBeforeStart ? (sport === 'tennis' ? t('Saved before the first serve') : t('Saved before kick-off')) : null, d.state === 'done' && p.result ? t('Checked against the result') : null].filter(Boolean).join(' · ') || undefined

  if (p.locked) {
    return (
      <Section id="more" title={t('More predictions')} note={note}>
        <div className="relative">
          <div className="grid sm:grid-cols-2 gap-4 select-none blur-[5px] opacity-60" aria-hidden>
            {d.keys.slice(0, 4).map((k, i) => (
              <div key={k}>
                <div className="text-xs font-semibold text-muted mb-2">{title[k]}</div>
                {[48, 30, 14].map((w, j) => <div key={j} className="h-3 rounded-full bg-surface2 mb-1.5"><div className="h-3 rounded-full bg-accent/50" style={{ width: `${(w + i * 7) % 70 + 10}%` }} /></div>)}
              </div>
            ))}
          </div>
          <div className="mt-4">
            <UnlockPrompt rid={rid} status={status} what={t('Likely scores, totals, half-time and more, each with its chance — saved before the start and checked after.')} />
          </div>
        </div>
      </Section>
    )
  }
  const sets = p.sets || {}
  const Bars = ({ k }: { k: string }) => {
    const s = sets[k]
    if (!s) return null
    const hit = p.result?.hits[k]
    const yesNo = s.labels.length === 2 && s.labels[0] === 'yes'
    const rows = s.labels.map((l, i) => ({ l, i, v: s.p[i] })).filter(r => !(k === 'score' && r.l === 'other') && (k !== 'htft' || r.v >= 1 || r.i === s.top))
    const shown = k === 'htft' ? [...rows].sort((a, b) => b.v - a.v).slice(0, 3) : k === 'margin' ? [...rows.slice(1), rows[0]] : rows
    return (
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-muted truncate">{title[k]}</div>
          {p.adminOnly?.includes(k) && <span className="text-[10px] font-bold uppercase tracking-wide text-draw">{t('admin only')}</span>}
        </div>
        {yesNo ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2.5 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${s.top === 0 ? 'bg-accent' : 'bg-muted/40'}`} style={{ width: `${s.p[0]}%` }} /></div>
            <span className={`num text-sm font-bold w-14 text-end ${s.top === 0 ? 'text-accent' : 'text-ink'}`}>{s.p[0].toFixed(0)}%</span>
          </div>
        ) : (
          <div className="space-y-1">
            {shown.map(r => {
              const top = r.i === s.top, was = hit && hit.i === r.i
              return (
                <div key={r.l} className="flex items-center gap-2 text-[13px]">
                  <span className={`w-32 sm:w-40 shrink-0 truncate ${top ? 'font-bold text-ink' : 'text-muted'}`} title={label(k, r.l)}>{label(k, r.l)}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${top ? 'bg-accent' : 'bg-muted/40'}`} style={{ width: `${Math.min(100, r.v)}%` }} /></div>
                  <span className={`num w-12 text-end ${top ? 'font-bold text-accent' : 'text-ink'}`}>{r.v.toFixed(0)}%</span>
                  <span className="w-4 text-center" aria-hidden>{was ? (hit!.hit ? <span className="text-win">✓</span> : <span className="text-loss">●</span>) : ''}</span>
                </div>
              )
            })}
          </div>
        )}
        {hit && (
          <div className="mt-1.5 text-xs text-faint">
            {t('What happened: {0}', { 0: actualText(k) || '–' })} <span className={hit.hit ? 'text-win font-bold' : 'text-loss font-bold'}>{hit.hit ? '✓' : '✗'}</span>
          </div>
        )}
      </div>
    )
  }
  const g6 = p.info?.grid6
  const scoreTop = sets.score ? sets.score.labels.map((l, i) => ({ l, v: sets.score.p[i], i })).filter(x => x.l !== 'other').sort((a, b) => b.v - a.v).slice(0, 5) : []
  const scoreHit = p.result?.hits.score
  return (
    <Section id="more" title={t('More predictions')} note={note}>
      {p.void && <p className="text-xs text-faint mb-3">{t('This game did not finish normally, so these are not checked.')}</p>}
      {sets.score && (
        <div className="mb-5">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="text-xs font-semibold text-muted">{title.score}</div>
            {g6 && <button type="button" onClick={() => setGrid(v => !v)} className="text-xs font-semibold text-accent hover:underline">{grid ? t('Hide the grid') : t('Every score')}</button>}
          </div>
          <div className="flex flex-wrap gap-2">
            {scoreTop.map((x, j) => (
              <span key={x.l} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ${j === 0 ? 'border-accent/50 bg-accent/10 text-ink font-bold' : 'border-line text-ink'} ${scoreHit && scoreHit.i === x.i ? 'ring-2 ring-win/60' : ''}`}>
                <span className="num">{dash(x.l)}</span><span className="num text-xs text-muted">{x.v.toFixed(1)}%</span>
              </span>
            ))}
          </div>
          {scoreHit && <div className="mt-1.5 text-xs text-faint">{t('What happened: {0}', { 0: actualText('score') || '–' })} <span className={scoreHit.hit ? 'text-win font-bold' : 'text-loss font-bold'}>{scoreHit.hit ? '✓' : '✗'}</span></div>}
          {grid && g6 && (
            <div className="mt-3 overflow-x-auto">
              <table className="text-xs num border-separate border-spacing-0.5 mx-auto">
                <thead><tr><th className="px-1 text-faint font-normal text-start">{home} ↓ · {away} <span aria-hidden className="rtl-flip">→</span></th>{g6[0].map((_, j) => <th key={j} className="px-1 text-faint font-semibold">{j}</th>)}</tr></thead>
                <tbody>
                  {g6.map((row, i) => (
                    <tr key={i}><th className="px-1 text-faint font-semibold text-end">{i}</th>
                      {row.map((v, j) => {
                        const max = Math.max(...g6.flat())
                        return <td key={j} title={`${i}–${j}: ${v}%`} className="w-10 h-8 text-center rounded" style={{ background: `rgb(var(--accent) / ${Math.min(0.85, (v / max) * 0.85)})`, color: v / max > 0.55 ? 'rgb(var(--bg))' : undefined }}>{v.toFixed(1)}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {p.info?.expected && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-surface2/60 px-4 py-3">
          <span className="text-sm text-muted">{t('Expected score')}</span>
          <span className="num font-display text-xl font-extrabold text-ink">{p.info.expected[0]}–{p.info.expected[1]}</span>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5">
        {d.keys.filter(k => k !== 'score' && sets[k]).map(k => <Bars key={k} k={k} />)}
      </div>
      <p className="mt-4 text-xs text-faint">{t('Chances from the same model as the main prediction. Probabilities, not promises.')}</p>
    </Section>
  )
}

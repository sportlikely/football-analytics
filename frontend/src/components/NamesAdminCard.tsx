import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix283: the 300 most opened names; per spelling its source, what visitors see (letter rules, a flagged spelling and an
 * unsure AI spelling are never shown: the page keeps the Latin name), the checks' flags and "Approve"; counts per shown
 * source; the AI's spend today against its cap.
 *
 * fix261 (admin): Data & feeds → "Names in Hebrew / Arabic" — the 200 most opened names (team / player page opens, then
 * how often they play) with their Hebrew and Arabic spelling and where it came from (admin > press > Wikidata > letter
 * rules). Type a better spelling and save it: it wins over everything and the pages use it within a minute; an empty
 * box gives the automatic one back. English only (admin console).
 */
type Src = 'admin' | 'press' | 'wikidata' | 'ai' | 'translit'
interface Cell { name: string; source: Src; shown: Src | 'latin'; conf: number | null; flags: string[]; approved: boolean }
interface Row { sport: string; kind: string; latin: string; display: string | null; id: string | null; country: string | null; views: number; weight: number; qid: string | null; names: Record<string, Cell> }
interface Data {
  langs: string[]
  rows: Row[]
  counts: { byLang: Record<string, Record<string, Record<string, number>>>; items: Record<string, number>; shown: Record<string, Record<string, number>>; flagged: Record<string, number> }
  top: Record<string, Record<string, number>>
  ai: { configured: boolean; model: string; capUsd: number; today: { calls: number; usd: number; names: number; errors: number }; last30d: { calls: number; usd: number; names: number }; asked: number }
  flagText: Record<string, string>
  lastRun: { at: string | null; items: number; written: number; wdTried: number; wdFound: number; error: string | null }
  mapSize: Record<string, number>
}
const KINDS = ['', 'team', 'league', 'player', 'country', 'city']
const SRC_TONE: Record<string, string> = { admin: 'text-accent', press: 'text-win', wikidata: 'text-ink', ai: 'text-ink', translit: 'text-draw', latin: 'text-faint' }
const SRC_LABEL: Record<string, string> = { admin: 'admin', press: 'press', wikidata: 'Wikidata', ai: 'AI', translit: 'rules', latin: 'Latin' }
const ORDER = ['admin', 'press', 'wikidata', 'ai', 'translit', 'latin']
const when = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function NamesAdminCard() {
  const [d, setD] = useState<Data | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<Record<string, string>>({})
  const load = (run = false) => {
    setBusy(run); setNote(null)
    axios.get(`${API_URL}/admin/names`, { params: { q: q || undefined, kind: kind || undefined, flagged: flagged ? 1 : undefined, run: run ? 1 : undefined } })
      .then(r => setD(r.data.data)).catch(e => setNote(errorText(e))).finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [kind, flagged]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (r: Row, lang: string) => {
    const k = `${r.sport}|${r.kind}|${r.latin}|${lang}`
    axios.post(`${API_URL}/admin/names`, { sport: r.sport, kind: r.kind, latin: r.latin, lang, name: edit[k] ?? '' })
      .then(() => { setEdit(e => { const n = { ...e }; delete n[k]; return n }); load() }).catch(e => setNote(errorText(e)))
  }
  const approve = (r: Row, lang: string) => {
    axios.post(`${API_URL}/admin/names`, { sport: r.sport, kind: r.kind, latin: r.latin, lang, approve: true }).then(() => load()).catch(e => setNote(errorText(e)))
  }
  const counts = (by: Record<string, number> | undefined) => ORDER.filter(k => by?.[k]).map(k => `${SRC_LABEL[k]} ${by![k]}`).join(' · ') || '–'
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Names in Hebrew / Arabic</h2>
        <button onClick={() => load(true)} disabled={busy} className="text-xs font-bold text-accent disabled:opacity-50">{busy ? 'Running…' : 'Run now'}</button>
      </div>
      <p className="text-xs text-muted mb-3">
        Team, league, country, city and player names on the he / ar pages. Order of trust: <b className="text-accent">admin</b> (typed here) &gt; <b className="text-win">press</b> spelling &gt; <b>Wikidata</b> (matched by the providers' ids) &gt; <b>AI</b> (shown only when sure) &gt; <b className="text-draw">letter rules</b> (never shown). A spelling a check flags (⚑) is not shown either: the page keeps the Latin name until you correct or approve it. Links stay Latin.
      </p>
      {note && <p className="text-sm text-loss mb-2">{note}</p>}
      {d && (
        <div className="text-xs text-faint mb-3 space-y-0.5">
          {d.langs.map(l => (
            <div key={l}>{l}: {d.mapSize[l] ?? 0} names in the map · shown by source: {counts(d.counts.shown?.[l])} · flagged {d.counts.flagged?.[l] ?? 0} · this list: {counts(d.top?.[l])}</div>
          ))}
          <div>AI spelling: {d.ai.configured ? `on (${d.ai.model}) · today $${d.ai.today.usd.toFixed(2)} of $${d.ai.capUsd} · ${d.ai.today.calls} calls, ${d.ai.today.names} names${d.ai.today.errors ? `, ${d.ai.today.errors} errors` : ''} · 30 days $${d.ai.last30d.usd.toFixed(2)} · ${d.ai.asked} names asked` : 'off — add ANTHROPIC_API_KEY in Railway to turn it on'}</div>
          <div>Names collected: {Object.entries(d.counts.items).map(([k, n]) => `${k} ${n}`).join(', ') || '–'}</div>
          <div>Last run {d.lastRun.at ? when(d.lastRun.at) : 'not yet'}: {d.lastRun.written} written · Wikidata tried {d.lastRun.wdTried}, found {d.lastRun.wdFound}{d.lastRun.error ? ` · error: ${d.lastRun.error}` : ''}</div>
        </div>
      )}
      <form className="flex flex-wrap gap-2 mb-3" onSubmit={e => { e.preventDefault(); load() }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search (Latin or local script)" className="flex-1 min-w-40 rounded-lg bg-surface2 px-3 py-1.5 text-sm" />
        <select value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg bg-surface2 px-2 py-1.5 text-sm">
          {KINDS.map(k => <option key={k} value={k}>{k || 'all kinds'}</option>)}
        </select>
        <label className="flex items-center gap-1 text-sm text-muted"><input type="checkbox" checked={flagged} onChange={e => setFlagged(e.target.checked)} /> flagged only</label>
        <button className="rounded-lg bg-surface2 px-3 py-1.5 text-sm font-bold">Find</button>
      </form>
      <div className="overflow-x-auto max-h-[520px]">
        <table className="w-full text-xs">
          <thead className="text-faint">
            <tr><th className="text-start py-1">Name (provider)</th><th className="text-end">Opens</th>{d?.langs.map(l => <th key={l} className="text-start ps-3">{l}</th>)}</tr>
          </thead>
          <tbody>
            {d?.rows.map(r => (
              <tr key={`${r.sport}|${r.kind}|${r.latin}`} className="border-t border-line/40 align-top">
                <td className="py-1.5 pe-2"><span className="text-ink font-semibold">{r.latin}</span>{r.display ? <span className="text-muted"> ({r.display})</span> : null} <span className="text-faint">{r.sport || '–'} {r.kind}{r.country && r.country !== '*' ? ` · ${r.country}` : ''}{r.qid ? ` · ${r.qid}` : ''}</span></td>
                <td className="text-end num text-muted">{r.views}</td>
                {d.langs.map(l => {
                  const k = `${r.sport}|${r.kind}|${r.latin}|${l}`, cur = r.names[l]
                  return (
                    <td key={l} className="ps-3 py-1">
                      <div className="flex items-center gap-1">
                        <input dir="rtl" value={edit[k] ?? cur?.name ?? ''} onChange={e => setEdit(x => ({ ...x, [k]: e.target.value }))} className="w-40 rounded bg-surface2 px-2 py-1" />
                        {edit[k] !== undefined && <button type="button" onClick={() => save(r, l)} className="font-bold text-accent">Save</button>}
                      </div>
                      {cur && (
                        <div className="text-[10px] flex flex-wrap items-center gap-x-1.5">
                          <span className={SRC_TONE[cur.shown]}>{cur.shown === 'latin' ? `Latin shown (${SRC_LABEL[cur.source]}${cur.conf != null ? ` ${Math.round(cur.conf * 100)}%` : ''})` : `${SRC_LABEL[cur.source]}${cur.conf != null ? ` ${Math.round(cur.conf * 100)}%` : ''}`}</span>
                          {cur.approved && <span className="text-win">approved</span>}
                          {cur.flags.map(f => <span key={f} className="text-loss" title={d.flagText[f] || f}>⚑ {d.flagText[f] || f}</span>)}
                          {cur.source !== 'admin' && !cur.approved && cur.shown === 'latin' && <button type="button" onClick={() => approve(r, l)} className="font-bold text-accent">Approve</button>}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

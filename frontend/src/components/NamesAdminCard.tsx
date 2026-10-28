import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix261 (admin): Data & feeds → "Names in Hebrew / Arabic" — the 200 most opened names (team / player page opens, then
 * how often they play) with their Hebrew and Arabic spelling and where it came from (admin > press > Wikidata > letter
 * rules). Type a better spelling and save it: it wins over everything and the pages use it within a minute; an empty
 * box gives the automatic one back. English only (admin console).
 */
type Src = 'admin' | 'press' | 'wikidata' | 'translit'
interface Row { sport: string; kind: string; latin: string; id: string | null; country: string | null; views: number; weight: number; qid: string | null; names: Record<string, { name: string; source: Src }> }
interface Data {
  langs: string[]
  rows: Row[]
  counts: { byLang: Record<string, Record<string, Record<string, number>>>; items: Record<string, number> }
  lastRun: { at: string | null; items: number; written: number; wdTried: number; wdFound: number; error: string | null }
  mapSize: Record<string, number>
}
const KINDS = ['', 'team', 'league', 'player', 'country', 'city']
const SRC_TONE: Record<Src, string> = { admin: 'text-accent', press: 'text-win', wikidata: 'text-ink', translit: 'text-draw' }
const when = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function NamesAdminCard() {
  const [d, setD] = useState<Data | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<Record<string, string>>({})
  const load = (run = false) => {
    setBusy(run); setNote(null)
    axios.get(`${API_URL}/admin/names`, { params: { q: q || undefined, kind: kind || undefined, run: run ? 1 : undefined } })
      .then(r => setD(r.data.data)).catch(e => setNote(errorText(e))).finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (r: Row, lang: string) => {
    const k = `${r.sport}|${r.kind}|${r.latin}|${lang}`
    axios.post(`${API_URL}/admin/names`, { sport: r.sport, kind: r.kind, latin: r.latin, lang, name: edit[k] ?? '' })
      .then(() => { setEdit(e => { const n = { ...e }; delete n[k]; return n }); load() }).catch(e => setNote(errorText(e)))
  }
  const total = (lang: string, src: string) => Object.values(d?.counts.byLang[lang] || {}).reduce((a, x) => a + (x[src] || 0), 0)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Names in Hebrew / Arabic</h2>
        <button onClick={() => load(true)} disabled={busy} className="text-xs font-bold text-accent disabled:opacity-50">{busy ? 'Running…' : 'Run now'}</button>
      </div>
      <p className="text-xs text-muted mb-3">
        Team, league, country, city and player names on the he / ar pages. Order of trust: <b className="text-accent">admin</b> (typed here) &gt; <b className="text-win">press</b> spelling &gt; <b>Wikidata</b> label &gt; <b className="text-draw">letter rules</b>. Links stay Latin.
      </p>
      {note && <p className="text-sm text-loss mb-2">{note}</p>}
      {d && (
        <div className="text-xs text-faint mb-3 space-y-0.5">
          {d.langs.map(l => (
            <div key={l}>{l}: {d.mapSize[l] ?? 0} names in the map · press {total(l, 'press')} · Wikidata {total(l, 'wikidata')} · rules {total(l, 'translit')} · admin {total(l, 'admin')}</div>
          ))}
          <div>Names collected: {Object.entries(d.counts.items).map(([k, n]) => `${k} ${n}`).join(', ') || '–'}</div>
          <div>Last run {d.lastRun.at ? when(d.lastRun.at) : 'not yet'}: {d.lastRun.written} written · Wikidata tried {d.lastRun.wdTried}, found {d.lastRun.wdFound}{d.lastRun.error ? ` · error: ${d.lastRun.error}` : ''}</div>
        </div>
      )}
      <form className="flex flex-wrap gap-2 mb-3" onSubmit={e => { e.preventDefault(); load() }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search (Latin or local script)" className="flex-1 min-w-40 rounded-lg bg-surface2 px-3 py-1.5 text-sm" />
        <select value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg bg-surface2 px-2 py-1.5 text-sm">
          {KINDS.map(k => <option key={k} value={k}>{k || 'all kinds'}</option>)}
        </select>
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
                <td className="py-1.5 pe-2"><span className="text-ink font-semibold">{r.latin}</span> <span className="text-faint">{r.sport || '–'} {r.kind}{r.country && r.country !== '*' ? ` · ${r.country}` : ''}{r.qid ? ` · ${r.qid}` : ''}</span></td>
                <td className="text-end num text-muted">{r.views}</td>
                {d.langs.map(l => {
                  const k = `${r.sport}|${r.kind}|${r.latin}|${l}`, cur = r.names[l]
                  return (
                    <td key={l} className="ps-3 py-1">
                      <div className="flex items-center gap-1">
                        <input dir="rtl" value={edit[k] ?? cur?.name ?? ''} onChange={e => setEdit(x => ({ ...x, [k]: e.target.value }))} className="w-40 rounded bg-surface2 px-2 py-1" />
                        {edit[k] !== undefined && <button type="button" onClick={() => save(r, l)} className="font-bold text-accent">Save</button>}
                      </div>
                      {cur && <span className={`text-[10px] ${SRC_TONE[cur.source]}`}>{cur.source}</span>}
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

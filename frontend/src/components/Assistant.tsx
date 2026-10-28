import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { useAuth, errorText } from '../lib/auth'
import { t } from '../lib/i18n'

/**
 * AI chat (signed-in users): a floating button that opens a small panel. On a match page the assistant gets that
 * match's data; elsewhere it answers about the site and football in general. The conversation lives for the visit.
 */

interface Msg { role: 'user' | 'assistant'; content: string }

const KEY = 'b2b-assistant'
const SUGGEST_MATCH = [t("Why this pick?"), t("Is this a safe pick?"), t("How are the two teams doing lately?"), t("Who is missing?")]
const SUGGEST_SITE = [t("How do your predictions work?"), t("What does Premium include?"), t("How is your record counted?"), t("How do favorites work?")]

function readSaved(): Msg[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.slice(-30) : []
  } catch {
    return []
  }
}

/** Minimal formatting: paragraphs, **bold**, "- " lists. */
function Text({ text }: { text: string }) {
  const lines = text.split('\n')
  const render = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i} className="font-semibold text-ink">{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>
    )
  const out: JSX.Element[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`} className="list-disc ps-4 space-y-0.5">{list.map((x, i) => <li key={i}>{render(x)}</li>)}</ul>)
    list = []
  }
  lines.forEach((ln, i) => {
    const m = ln.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/)
    if (m) list.push(m[1])
    else {
      flush()
      if (ln.trim()) out.push(<p key={i}>{render(ln)}</p>)
    }
  })
  flush()
  return <div className="space-y-1.5">{out}</div>
}

export default function Assistant() {
  const { user, loading } = useAuth()
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>(() => readSaved())
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const matchId = (() => {
    const m = loc.pathname.match(/^\/match\/(\d+)/)
    return m ? Number(m[1]) : null
  })()

  useEffect(() => {
    axios.get(`${API_URL}/assistant/status`).then(r => setAvailable(!!r.data.data?.available)).catch(() => setAvailable(false))
  }, [])

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-30)))
    } catch {
      /* ignore */
    }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [msgs, open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  // hidden on sign-in pages and while the assistant is not set up
  if (available === false || loading) return null
  if (['/login', '/signup', '/verify', '/forgot'].includes(loc.pathname)) return null

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const next: Msg[] = [...msgs, { role: 'user', content: q }]
    setMsgs(next)
    setInput('')
    setError(null)
    setBusy(true)
    try {
      const r = await axios.post(`${API_URL}/assistant/chat`, { messages: next.slice(-12), matchId, page: loc.pathname }, { timeout: 60000 })
      setMsgs([...next, { role: 'assistant', content: r.data.data.reply }])
    } catch (e) {
      setError(errorText(e, t("The assistant could not answer right now.")))
    } finally {
      setBusy(false)
    }
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    send(input)
  }

  const suggestions = matchId ? SUGGEST_MATCH : SUGGEST_SITE

  return (
    <>
      {/* launcher */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? t("Close the assistant") : t("Ask the assistant")}
        className={`fixed z-40 end-4 bottom-24 lg:bottom-6 lg:end-6 h-12 px-4 rounded-full shadow-lift border border-accent/40 bg-accent text-bg font-bold text-sm inline-flex items-center gap-2 transition-transform hover:scale-[1.03] ${open ? 'hidden lg:inline-flex' : ''}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />
        </svg>
        {t("Ask")}</button>

      {open && (
        <div
          role="dialog"
          aria-label={t("Assistant")}
          className="fixed z-50 inset-x-0 bottom-0 top-14 sm:top-auto sm:inset-x-auto sm:end-4 sm:bottom-24 lg:end-6 lg:bottom-6 sm:w-[380px] sm:h-[560px] sm:max-h-[calc(100vh-7rem)] flex flex-col rounded-t-3xl sm:rounded-3xl border border-line bg-surface shadow-lift overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-line/70 bg-surface2/50">
            <span className="w-8 h-8 rounded-full bg-accent text-bg grid place-items-center font-display font-extrabold">B</span>
            <div className="min-w-0 flex-1">
              <div className="font-display font-bold text-ink leading-tight">{t("Ask SportLikely")}</div>
              <div className="text-[11px] text-faint truncate">{matchId ? t("Knows this match: our prediction, form, line-ups, H2H") : t("About our predictions, the site and football")}</div>
            </div>
            {msgs.length > 0 && (
              <button type="button" onClick={() => setMsgs([])} className="text-xs text-faint hover:text-ink" title={t("Start a new conversation")}>{t("Clear")}</button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface2" aria-label={t("Close")}>×</button>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
            {!user ? (
              <div className="h-full grid place-items-center text-center">
                <div className="space-y-3">
                  <p className="text-muted">{t("Sign in to ask about any match, our picks or the site.")}</p>
                  <Link to={`/login?next=${encodeURIComponent(loc.pathname)}`} className="inline-block h-10 px-4 rounded-xl bg-accent text-bg font-bold grid place-items-center">{t("Sign in")}</Link>
                </div>
              </div>
            ) : (
              <>
                {msgs.length === 0 && (
                  <div className="space-y-3">
                    <div className="rounded-2xl rounded-ss-md bg-surface2/70 px-3.5 py-2.5 text-muted">
                      {t("Hi")}{user.name ? ` ${user.name.split(' ')[0]}` : ''}{t("! Ask me why we picked a team, what the numbers mean, or anything about football.")}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestions.map(s => (
                        <button key={s} type="button" onClick={() => send(s)} className="px-3 py-1.5 rounded-full border border-line text-xs text-ink hover:border-accent/60 hover:text-accent">{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {msgs.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl ${m.role === 'user' ? 'bg-accent text-bg rounded-se-md' : 'bg-surface2/70 text-ink rounded-ss-md'}`}>
                      {m.role === 'user' ? m.content : <Text text={m.content} />}
                    </div>
                  </div>
                ))}
                {busy && (
                  <div className="flex justify-start">
                    <div className="px-3.5 py-2.5 rounded-2xl rounded-ss-md bg-surface2/70 text-faint">
                      <span className="inline-flex gap-1"><span className="animate-pulseDot">·</span><span className="animate-pulseDot [animation-delay:150ms]">·</span><span className="animate-pulseDot [animation-delay:300ms]">·</span></span>
                    </div>
                  </div>
                )}
                {error && <div className="text-xs text-loss">{error}</div>}
                {msgs.length > 0 && !busy && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {suggestions.filter(s => !msgs.some(m => m.content === s)).slice(0, 2).map(s => (
                      <button key={s} type="button" onClick={() => send(s)} className="px-2.5 py-1 rounded-full border border-line/70 text-[11px] text-muted hover:border-accent/60 hover:text-accent">{s}</button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {user && (
            <form onSubmit={onSubmit} className="p-3 border-t border-line/70 flex items-center gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder={matchId ? t("Ask about this match…") : t("Ask anything about football…")}
                maxLength={1000}
                className="flex-1 h-11 px-3.5 rounded-xl bg-surface2/70 border border-line/70 text-sm text-ink placeholder:text-faint focus:outline-none focus:border-accent/60"
              />
              <button type="submit" disabled={busy || !input.trim()} className="h-11 px-4 rounded-xl bg-accent text-bg font-bold text-sm disabled:opacity-40">{t("Send")}</button>
            </form>
          )}
          <div className="px-4 pb-2 text-[10px] text-faint">{t("Probabilities, not promises. No betting advice. 18+.")}</div>
        </div>
      )}
    </>
  )
}

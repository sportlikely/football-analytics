import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { t as tt, LOCALE } from '../../lib/i18n'
import { isCovered, revealMatch, justRevealed } from '../../lib/reveal'
import CountUp from '../CountUp'
import { RevealChip } from '../Reveal'
import { DcHelp } from '../DcPick'
import RecordLink from '../RecordLink'
import { NewsPic, isPhoto } from '../NewsList'
import type { HGame, HTeam, HPick, HNews, HRecord, HSpecial, HResults, SportAdapter } from './types'
import { ScorersToggle, RowScorersLine, scorersSource, useScorersOpen } from '../sport/RowScorers'

/** Shared pieces of the sport home page (fix141) — the football home's look, for every sport. */

export const ago = (iso: string | null) => {
  if (!iso) return ''
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return m < 60 ? tt("{0} min ago", { 0: m }) : m < 1440 ? tt("{0} h ago", { 0: Math.round(m / 60) }) : tt("{0} d ago", { 0: Math.round(m / 1440) })
}
const when = (iso: string) => new Date(iso).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
/** "BBC Sport · Premier League": the outlet and the first league the story is filed under */
const srcLine = (n: HNews) => [n.source, n.leagues?.[0]?.name].filter(Boolean).join(' · ')
const initials = (raw: string | null | undefined) => {
  const s = typeof raw === 'string' && raw.trim() ? raw : '?' // fix151: no name → "?"
  const w = s.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(x => x.length > 1 || /\d/.test(x))
  return (w.length >= 2 ? w.slice(0, 2).map(x => x[0]).join('') : (w[0] || s).slice(0, 3)).toUpperCase()
}

export function Crest({ team, size = 28 }: { team: { name: string; logo: string | null; tla?: string | null; flag?: string | null }; size?: number }) {
  const [broken, setBroken] = useState(false)
  // fix193: an individual sport (tennis) shows the player's flag where a team shows its crest
  if (!team.logo && team.flag) return <span className="grid place-items-center flex-shrink-0 leading-none" style={{ width: size, height: size, fontSize: Math.round(size * 0.8) }} aria-hidden>{team.flag}</span>
  return team.logo && !broken ? (
    <img src={team.logo} alt="" width={size} height={size} onError={() => setBroken(true)} className="object-contain flex-shrink-0" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-full bg-surface2 grid place-items-center text-[10px] font-display font-bold text-muted flex-shrink-0" style={{ width: size, height: size }}>
      {(team.tla || initials(team.name)).slice(0, 3).toUpperCase()}
    </span>
  )
}

export function Lock() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg sm:text-xl font-bold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

const covered = (g: HGame) => !!g.reveal && g.pred.kind === 'full' && isCovered(g.reveal.id, g.reveal.status, true)
const rolling = (g: HGame) => !!g.reveal && justRevealed(g.reveal.id)

/* ---------- first visit (signed-out visitors) ---------- */

export function FirstVisit({ a, stats }: { a: SportAdapter['intro']; stats?: { value: string; label: string; sub: string }[] }) {
  return (
    <section className="rounded-3xl border border-line/40 bg-[linear-gradient(135deg,rgb(var(--accent)/0.10),rgb(var(--surface)/0.6)_60%)] p-5 sm:p-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0 space-y-4">
        <div className="space-y-2">
          <h1 className="font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-ink leading-tight">{a.title}</h1>
          <p className="text-sm sm:text-base text-muted max-w-2xl">{a.text}</p>
        </div>
        <ul className="grid gap-2.5 sm:grid-cols-3 max-w-3xl">
          {a.bullets.map(([h, d]) => (
            <li key={h} className="flex gap-2.5 rounded-2xl bg-surface/60 border border-line/60 px-3.5 py-3">
              <span className="mt-0.5 w-5 h-5 rounded-full bg-accent text-bg grid place-items-center shrink-0" aria-hidden>
                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-ink">{h}</span>
                <span className="block text-xs text-muted leading-snug mt-0.5">{d}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col sm:flex-row gap-2">
          <Link to={a.cta.to} className="h-11 px-6 rounded-2xl bg-accent text-bg font-extrabold grid place-items-center">{a.cta.label}</Link>
          {a.second.record
            ? <RecordLink to={a.second.to} className="h-11 px-5 rounded-2xl border border-line text-ink font-semibold grid place-items-center hover:border-faint">{a.second.label}</RecordLink>
            : <Link to={a.second.to} className="h-11 px-5 rounded-2xl border border-line text-ink font-semibold grid place-items-center hover:border-faint">{a.second.label}</Link>}
        </div>
      </div>
      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-1 gap-3 lg:w-56">
          {stats.map(s => (
            <div key={s.label} className="rounded-2xl bg-surface/70 border border-line px-4 py-3">
              <div className="font-display text-3xl font-extrabold text-accent num leading-none">{s.value}</div>
              <div className="text-xs text-ink font-semibold mt-1.5">{s.label}</div>
              <div className="text-[11px] text-faint">{s.sub}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ---------- hero ---------- */

/** The playing surface in perspective under the hero: football pitch, basketball court or American-football field. */
function Field({ kind }: { kind: SportAdapter['field'] }) {
  return (
    <svg aria-hidden viewBox="0 0 1000 400" preserveAspectRatio="none" className="absolute -z-10 left-[-10%] w-[120%] bottom-0 h-[55%] opacity-30" style={{ transform: 'perspective(600px) rotateX(55deg)', transformOrigin: 'bottom' }}>
      <g fill="none" stroke="#C8FF3D" strokeWidth="2">
        {kind === 'pitch' ? (
          <>
            <rect x="20" y="10" width="960" height="380" />
            <line x1="500" y1="10" x2="500" y2="390" />
            <circle cx="500" cy="200" r="70" />
            <rect x="20" y="110" width="140" height="180" />
            <rect x="840" y="110" width="140" height="180" />
          </>
        ) : kind === 'tennis' ? (
          <>
            {/* fix193: a tennis court — doubles and singles lines, the net, service boxes */}
            <rect x="20" y="10" width="960" height="380" />
            <line x1="20" y1="58" x2="980" y2="58" />
            <line x1="20" y1="342" x2="980" y2="342" />
            <line x1="500" y1="0" x2="500" y2="400" strokeWidth="4" />
            <line x1="276" y1="58" x2="276" y2="342" />
            <line x1="724" y1="58" x2="724" y2="342" />
            <line x1="276" y1="200" x2="724" y2="200" />
            <line x1="20" y1="200" x2="34" y2="200" />
            <line x1="966" y1="200" x2="980" y2="200" />
          </>
        ) : kind === 'court' ? (
          <>
            <rect x="20" y="10" width="960" height="380" />
            <line x1="500" y1="10" x2="500" y2="390" />
            <circle cx="500" cy="200" r="60" />
            <rect x="20" y="140" width="190" height="120" />
            <rect x="790" y="140" width="190" height="120" />
            <circle cx="210" cy="200" r="60" />
            <circle cx="790" cy="200" r="60" />
            <path d="M20 40 H90 A220 220 0 0 1 90 360 H20" />
            <path d="M980 40 H910 A220 220 0 0 0 910 360 H980" />
          </>
        ) : (
          <>
            <rect x="20" y="10" width="960" height="380" />
            <rect x="20" y="10" width="80" height="380" fill="#C8FF3D" fillOpacity="0.08" />
            <rect x="900" y="10" width="80" height="380" fill="#C8FF3D" fillOpacity="0.08" />
            {Array.from({ length: 9 }, (_, i) => 180 + i * 80).map((x, i) => <line key={x} x1={x} y1="10" x2={x} y2="390" strokeWidth={i === 4 ? 3 : 1.5} />)}
            <line x1="100" y1="10" x2="100" y2="390" strokeWidth="3" />
            <line x1="900" y1="10" x2="900" y2="390" strokeWidth="3" />
            {Array.from({ length: 39 }, (_, i) => 120 + i * 20).map(x => <g key={x} strokeWidth="1"><line x1={x} y1="150" x2={x} y2="160" /><line x1={x} y1="240" x2={x} y2="250" /></g>)}
            <path d="M20 170 H6 M20 230 H6 M6 170 V230" strokeWidth="3" />
            <path d="M980 170 H994 M980 230 H994 M994 170 V230" strokeWidth="3" />
          </>
        )}
      </g>
    </svg>
  )
}

/** The lime "Our pick" chip of the hero: "Our pick (?) Barça or draw · 82%" (+ "Strong pick"). */
function HeroPick({ pick }: { pick: HPick }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 min-w-0">
      <span className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-full font-extrabold text-xs sm:text-[13px] px-2.5 py-1 bg-[#C8FF3D] text-[#07090D]">
        <span className="whitespace-nowrap">{tt("Our pick")}</span>
        {pick.help && <DcHelp onAccent />}
        <span className="truncate">{pick.words}</span>
        {pick.pct !== null && <><span aria-hidden>·</span><span className="num whitespace-nowrap">{pick.pct}%</span></>}
      </span>
      {pick.strong && <span className="inline-block rounded-full border font-bold whitespace-nowrap text-[11px] px-2 py-0.5 border-[#C8FF3D]/60 text-[#C8FF3D]">{tt("Strong pick")}</span>}
    </span>
  )
}

/** Big featured game: the two crests, blown up and blurred, paint the background in the teams' own colours. */
export function FeaturedHero({ g, a, label }: { g: HGame | null; a: SportAdapter; label?: string }) {
  if (!g)
    return (
      <div className="relative overflow-hidden rounded-[32px] border border-white/10 min-h-[360px] sm:min-h-[460px] bg-[linear-gradient(160deg,#0F1A2B_0%,#0A0F17_60%,#07090D_100%)] p-10 flex flex-col justify-center gap-3 text-[#EEF1F6]">
        <div className="font-display text-3xl sm:text-5xl font-extrabold tracking-tight leading-[1.05]">{a.labels.emptyHero[0]}<br />{a.labels.emptyHero[1]}</div>
        <p className="text-[#C9D0DB] max-w-lg">{a.labels.emptyHero[2]}</p>
      </div>
    )
  const roll = rolling(g)
  const longestWord = (s: string | null | undefined) => Math.max(0, ...String(s || '').split(/\s+/).map(w => w.length))
  const side = (t: HTeam) => (
    <Link to={t.href} className="group flex flex-col items-center gap-3 sm:gap-4 min-w-0">
      <span className="relative grid place-items-center w-24 h-24 sm:w-36 sm:h-36 rounded-full bg-white/[0.06] border border-white/10 backdrop-blur-md shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] transition-transform group-hover:scale-[1.04]">
        <Crest team={t} size={72} />
      </span>
      {/* phones: a long word (8+ letters, "Kentucky", "Cardinals") one size smaller, 11+ two sizes, so it never breaks inside the word */}
      <span className={`font-display font-extrabold ${longestWord(t.short) >= 11 ? 'text-xs' : longestWord(t.short) >= 8 ? 'text-sm' : 'text-base'} sm:text-3xl tracking-tight text-center leading-tight max-w-full break-words`}>
        {t.short !== t.name ? <><span className="sm:hidden">{t.short}</span><span className="hidden sm:inline">{t.name}</span></> : t.name}
      </span>
    </Link>
  )
  const p = g.pred
  return (
    <div className="relative overflow-hidden rounded-[32px] border border-white/10 min-h-[420px] sm:min-h-[480px] bg-[#0A0E15] text-[#EEF1F6] isolate">
      {g.home.logo && <img src={g.home.logo} alt="" aria-hidden className="absolute -z-10 -left-24 top-1/2 -translate-y-1/2 w-[560px] h-[560px] object-contain blur-[80px] opacity-50 saturate-150" />}
      {g.away.logo && <img src={g.away.logo} alt="" aria-hidden className="absolute -z-10 -right-24 top-1/2 -translate-y-1/2 w-[560px] h-[560px] object-contain blur-[80px] opacity-50 saturate-150" />}
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(600px_260px_at_50%_-60px,rgba(255,255,255,0.16),transparent_70%),linear-gradient(to_bottom,rgba(7,9,13,0.1),rgba(7,9,13,0.75))]" />
      <Field kind={a.field} />

      <div className="relative h-full p-5 sm:p-9 flex flex-col gap-6 sm:gap-8">
        <div className="flex flex-wrap items-center justify-center sm:justify-between gap-2">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#07090D] bg-[#C8FF3D] px-3 py-1.5 rounded-full">{label || a.labels.featured}</span>
          {(() => {
            const pill = <>
              {g.competition.emblem && <img src={g.competition.emblem} alt="" width={16} height={16} className="w-4 h-4 object-contain" />}
              {g.competition.name}
            </>
            const cls = 'glass !rounded-full inline-flex items-center gap-2 px-3 py-1.5 text-xs sm:text-sm text-[#C9D0DB]'
            return g.competition.href ? <Link to={g.competition.href} className={`${cls} hover:text-white hover:underline underline-offset-2`}>{pill}</Link> : <span className={cls}>{pill}</span>
          })()}
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6 flex-1">
          {side(g.home)}
          <div className="flex flex-col items-center gap-2">
            <span className="font-display font-extrabold text-3xl sm:text-6xl text-white/90 tracking-tight">{tt("VS")}</span>
            <span className="text-xs sm:text-sm font-bold text-white">{new Date(g.kickoff).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="text-[11px] sm:text-xs text-[#9AA3B2]">{new Date(g.kickoff).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          </div>
          {side(g.away)}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-4 sm:gap-6">
          <div className="flex-1 space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#9AA3B2] text-center sm:text-left">{a.labels.modelPrediction}</div>
            {p.kind === 'full' && covered(g) ? (
              <RevealChip dark onReveal={() => revealMatch(g.reveal!.id)} />
            ) : p.kind === 'full' ? (
              <div className="space-y-2.5">
                <div className={`grid ${p.cells.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-2 sm:gap-3`}>
                  {p.cells.map((c, i) => (
                    <div key={c.key} className={`glass px-3 py-2.5 sm:px-4 text-center ${c.on ? 'ring-2 ring-[#C8FF3D]/70' : ''} ${roll && c.on ? 'animate-pop' : ''}`}>
                      <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-[0.08em] text-[#9AA3B2] truncate">{c.label}</div>
                      <div className={`font-display font-extrabold text-xl sm:text-2xl ${c.on ? 'text-[#C8FF3D]' : 'text-white'}`}>{c.pct < 0.5 ? '<1%' : <CountUp value={c.pct} suffix="%" animate={roll} delay={i * 120} />}</div>
                    </div>
                  ))}
                </div>
                {p.pick && <div className="flex justify-center sm:justify-start"><HeroPick pick={p.pick} /></div>}
              </div>
            ) : p.kind === 'locked' ? (
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3 text-sm">
                <span className="glass !rounded-full px-4 py-2 font-semibold inline-flex items-center gap-2"><Lock /> {tt("Prediction locked")}</span>
                <Link to={g.href} state={g.linkState} className="inline-flex items-center gap-1.5 text-[#C8FF3D] font-semibold">{tt("Unlock it →")}</Link>
              </div>
            ) : (
              <div className="flex justify-center sm:justify-start"><span className="glass !rounded-full px-4 py-2 text-sm font-semibold text-[#C9D0DB]">{tt("Prediction coming soon")}</span></div>
            )}
          </div>
          <Link to={g.href} state={g.linkState} className="h-12 px-7 inline-flex items-center justify-center rounded-2xl bg-[#C8FF3D] text-[#07090D] font-extrabold shadow-[0_10px_30px_-10px_rgba(200,255,61,0.6)] hover:brightness-105">
            {tt("Full analysis")}</Link>
        </div>
      </div>
    </div>
  )
}

/*
 * Several big games: the featured card becomes a swipeable row. Swipe / arrows / dots; it moves on by itself every 8 s
 * until the visitor touches it (never with reduced motion). The next card peeks in on phones.
 */
export function FeaturedCarousel({ games, a }: { games: HGame[]; a: SportAdapter }) {
  const track = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(0)
  const [held, setHeld] = useState(false)
  const go = useCallback((i: number) => {
    const el = track.current
    if (!el) return
    const n = (i + games.length) % games.length
    const slide = el.children[n] as HTMLElement | undefined
    if (slide) el.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' })
  }, [games.length])
  const onScroll = () => {
    const el = track.current
    if (!el) return
    const kids = [...el.children] as HTMLElement[]
    let best = 0, dist = Infinity
    kids.forEach((k, i) => { const d = Math.abs(k.offsetLeft - el.scrollLeft); if (d < dist) { dist = d; best = i } })
    setAt(best)
  }
  useEffect(() => {
    if (held || games.length < 2) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setTimeout(() => go(at + 1), 8000)
    return () => window.clearTimeout(id)
  }, [at, held, go, games.length])
  const hold = () => setHeld(true)
  const arrow = (dir: -1 | 1) => (
    <button type="button" onClick={() => { hold(); go(at + dir) }} aria-label={dir < 0 ? tt('Previous match') : tt('Next match')}
      className={`hidden sm:grid absolute top-1/2 -translate-y-1/2 ${dir < 0 ? 'left-3' : 'right-3'} z-10 w-10 h-10 place-items-center rounded-full bg-black/40 border border-white/15 text-white backdrop-blur-md hover:bg-black/60 transition-colors`}>
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{dir < 0 ? <path d="M15 5l-7 7 7 7" /> : <path d="M9 5l7 7-7 7" />}</svg>
    </button>
  )
  return (
    <section className="relative min-w-0" aria-roledescription="carousel" aria-label={tt('Featured matches')} onMouseEnter={hold} onTouchStart={hold} onFocus={hold}>
      <div ref={track} onScroll={onScroll} className="relative flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar scroll-smooth">
        {games.map((g, i) => (
          <div key={g.id} className="shrink-0 basis-[90%] sm:basis-full snap-start min-w-0 [&>*]:h-full" aria-roledescription="slide" aria-label={`${i + 1} / ${games.length}`}>
            <FeaturedHero g={g} a={a} label={`${a.labels.featured} · ${i + 1}/${games.length}`} />
          </div>
        ))}
      </div>
      {arrow(-1)}
      {arrow(1)}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {games.map((g, i) => (
          <button key={g.id} type="button" onClick={() => { hold(); go(i) }} aria-label={`${g.home.short} – ${g.away.short}`} aria-current={i === at ? 'true' : undefined}
            className={`h-1.5 rounded-full transition-all ${i === at ? 'w-6 bg-accent' : 'w-1.5 bg-faint/50 hover:bg-faint'}`} />
        ))}
      </div>
    </section>
  )
}

/* ---------- live / next kick-offs beside the hero ---------- */

export function SideCard({ d, a }: { d: { live: HGame[]; soonest: HGame[] }; a: SportAdapter }) {
  const { live, soonest } = d
  const liveMain = live[0]
  return (
    <div className="card p-5 sm:p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-bold">{live.length ? tt("Live now") : a.labels.nextList}</h2>
        <span className={`inline-flex items-center gap-2 text-xs font-bold px-3 py-1 rounded-full ${live.length ? 'text-live bg-live/10' : 'text-faint bg-surface2/70'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${live.length ? 'bg-live animate-pulseDot' : 'bg-faint'}`} />
          {live.length ? tt("{0} live", { 0: live.length }) : tt("No live games")}
        </span>
      </div>
      {liveMain ? (
        <>
          <Link to={liveMain.href} state={liveMain.linkState} className="glass p-4 space-y-3 hover:bg-white/10 transition-colors">
            <div className="text-xs text-faint text-center truncate">{liveMain.competition.name}</div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="flex flex-col items-center gap-2 min-w-0"><Crest team={liveMain.home} size={52} /><span className="text-sm font-bold truncate max-w-full">{liveMain.home.short}</span></div>
              <div className="flex flex-col items-center gap-1.5">
                <span className="font-display font-extrabold text-4xl">{liveMain.live?.score[0] ?? 0} – {liveMain.live?.score[1] ?? 0}</span>
                <span className="text-xs font-extrabold text-bg bg-win px-2.5 py-0.5 rounded-full">{liveMain.live?.label || tt("Live")}</span>
              </div>
              <div className="flex flex-col items-center gap-2 min-w-0"><Crest team={liveMain.away} size={52} /><span className="text-sm font-bold truncate max-w-full">{liveMain.away.short}</span></div>
            </div>
            <div className="text-center text-xs text-muted">{a.labels.liveDetail}</div>
          </Link>
          <div className="space-y-1">
            {live.slice(1, 6).map(g => (
              <Link key={g.id} to={g.href} state={g.linkState} className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-surface2/60 text-sm">
                <span className="text-[11px] font-bold text-win w-8 whitespace-nowrap">{g.live?.label || tt("Live")}</span>
                <span className="truncate flex-1">{g.home.short} – {g.away.short}</span>
                <b className="font-display">{g.live?.score[0] ?? 0}–{g.live?.score[1] ?? 0}</b>
              </Link>
            ))}
            {live.length > 6 && <Link to={a.labels.all.to} className="block px-2 pt-1 text-sm font-semibold text-accent">{tt("All")}{' '}{live.length} {tt("live games →")}</Link>}
          </div>
        </>
      ) : soonest.length ? (
        <div className="flex flex-col gap-1.5">
          {soonest.map(g => (
            <Link key={g.id} to={g.href} state={g.linkState} className="flex items-center gap-3 p-2.5 rounded-2xl hover:bg-surface2/60 transition-colors">
              <div className="flex -space-x-2 flex-shrink-0">
                <span className="rounded-full bg-surface2 p-1 ring-2 ring-surface"><Crest team={g.home} size={24} /></span>
                <span className="rounded-full bg-surface2 p-1 ring-2 ring-surface"><Crest team={g.away} size={24} /></span>
              </div>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold truncate">{g.home.short} – {g.away.short}</span>
                <span className="block text-[11px] text-faint truncate">{g.competition.name}</span>
              </span>
              <span className="text-right flex-shrink-0">
                <span className="block text-xs font-bold text-ink">{new Date(g.kickoff).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="block text-[11px] text-faint">{new Date(g.kickoff).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              </span>
            </Link>
          ))}
          <span className="mt-1 px-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link to={a.labels.all.to} className="text-sm font-bold text-accent">{a.labels.all.label}</Link>
            <Link to={a.labels.today.to} className="text-sm font-bold text-accent">{a.labels.today.label}</Link>
          </span>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center text-center text-sm text-muted py-6">
          <span className="space-y-2">
            <span className="block">{tt("No games scheduled yet.")}</span>
            <Link to={a.labels.today.to} className="block font-bold text-accent">{a.labels.today.label}</Link>
          </span>
        </div>
      )}
    </div>
  )
}

/* ---------- cards of the favorites / next rails ---------- */

/** "Our pick (?) · Barça or draw · 82%" under the cells (fix127). */
function PickLine({ pick }: { pick: HPick }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex items-center gap-1 text-[11px] leading-none whitespace-nowrap min-w-0">
        <span className="text-faint">{tt("Our pick")}</span>
        {pick.help && <DcHelp />}
        <span className="font-bold text-ink truncate">{pick.words}</span>
        {pick.pct !== null && <><span aria-hidden className="text-faint">·</span><span className="num font-extrabold text-accent">{pick.pct}%</span></>}
      </span>
      {pick.strong && <span className="rounded-full border border-accent/50 text-accent text-[10px] font-bold px-1.5 py-px">{tt("Strong")}</span>}
    </span>
  )
}

export function GameCard({ g }: { g: HGame }) {
  const p = g.pred
  const roll = rolling(g)
  return (
    <Link to={g.href} state={g.linkState} className="card card-hover snap-start flex-shrink-0 w-[272px] p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0 text-[11px] text-faint">
          {g.competition.emblem && <img src={g.competition.emblem} alt="" width={14} height={14} className="w-3.5 h-3.5 object-contain" />}
          <span className="truncate">{g.competition.name}</span>
        </span>
        <span className="text-[11px] font-bold text-ink bg-surface2/80 px-2 py-0.5 rounded-full whitespace-nowrap">
          {new Date(g.kickoff).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center gap-3"><Crest team={g.home} size={32} /><span className="font-bold truncate">{g.home.short}</span></div>
        <div className="flex items-center gap-3"><Crest team={g.away} size={32} /><span className="font-bold truncate">{g.away.short}</span></div>
      </div>
      {p.kind === 'full' && covered(g) ? (
        <RevealChip onReveal={() => revealMatch(g.reveal!.id)} />
      ) : p.kind === 'full' ? (
        <div className="space-y-2">
          <div className={`grid ${p.cells.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-1.5 text-center`}>
            {p.cells.map((c, i) => (
              <span key={c.key} className={`rounded-xl py-1.5 text-xs font-bold num border ${c.on ? 'border-accent/70 bg-accent/15 text-ink' : 'border-transparent bg-surface2/40 text-faint'}`}>
                <span className={`block text-[10px] font-semibold ${c.on ? 'text-accent' : ''}`}>{c.head}</span>
                <CountUp value={c.pct} suffix="%" animate={roll} delay={i * 100} />
              </span>
            ))}
          </div>
          {p.pick && <PickLine pick={p.pick} />}
        </div>
      ) : p.kind === 'locked' ? (
        <div className="flex items-center justify-between text-xs rounded-xl bg-surface2/70 px-3 py-2">
          <span className="text-muted inline-flex items-center gap-1.5"><Lock /> {tt("Prediction locked")}</span>
          <span className="text-accent font-semibold">{tt("Unlock")}</span>
        </div>
      ) : (
        <div className="text-xs text-faint">{tt("No prediction yet")}</div>
      )}
    </Link>
  )
}

export function Rail({ games }: { games: HGame[] }) {
  return <div className="rail flex gap-3.5 overflow-x-auto pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">{games.map(g => <GameCard key={g.id} g={g} />)}</div>
}

/* ---------- bottom row: record · special · latest results ---------- */

export function RecordCard({ r }: { r: HRecord }) {
  const rows = (r.rows || []).filter(x => x.n >= 30 && x.pct !== null).sort((x, y) => (y.pct as number) - (x.pct as number)).slice(0, 6)
  return (
    <div className="rounded-3xl p-6 border border-line/40 bg-[linear-gradient(160deg,rgb(var(--accent)/0.10),rgb(var(--surface)/0.6))] flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">{tt("Our record")}</h2>
        {r.aside && <span className="text-xs text-muted">{r.aside}</span>}
      </div>
      {!r.rows ? (
        <div className="text-sm text-muted">{tt("Loading the record…")}</div>
      ) : rows.length ? (
        <div className="space-y-3">
          {rows.map((x, i) => (
            <div key={x.key} className="space-y-1.5">
              <div className="flex justify-between items-start gap-3">
                <span className={`font-bold ${i === 0 ? 'text-ink' : 'text-muted text-sm'}`}>{x.label}</span>
                <span className="text-right leading-none flex-shrink-0">
                  <span className={`block font-display num ${i === 0 ? 'text-2xl text-accent' : 'text-base text-ink'}`}>{x.pct}%</span>
                  <span className="block text-[10px] text-faint mt-1">{tt("{0} games", { 0: x.n })}</span>
                </span>
              </div>
              <div className={`${i === 0 ? 'h-3' : 'h-2'} rounded-full bg-surface2`}><div className={`h-full rounded-full ${i === 0 ? 'bg-accent' : 'bg-win/80'}`} style={{ width: `${x.pct}%` }} /></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {r.empty.title && <div className="font-display text-xl font-bold text-ink">{r.empty.title}</div>}
          <div className="text-sm text-muted">{r.empty.text}</div>
        </div>
      )}
      <p className="text-sm text-muted leading-relaxed">{r.note}</p>
      {r.link && <RecordLink to={r.link.to} className="mt-auto text-sm font-bold text-accent">{r.link.label}</RecordLink>}
    </div>
  )
}

export function SpecialCard({ s }: { s: HSpecial }) {
  const tone = s.tone === 'draw' ? { box: 'bg-draw/10 border-draw/25 hover:bg-draw/15', text: 'text-draw' } : { box: 'bg-loss/10 border-loss/25 hover:bg-loss/15', text: 'text-loss' }
  return (
    <div className="card p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">{s.title}</h2>
      </div>
      {s.open ? (
        s.items.length ? (
          s.items.slice(0, 3).map(x => (
            <Link key={x.id} to={x.href} className={`rounded-2xl p-4 border space-y-2 transition-colors ${tone.box}`}>
              <div className="flex justify-between text-[11px] text-faint"><span>{x.league}</span><span>{when(x.date)}</span></div>
              <div className="font-extrabold">{x.title}</div>
              <div className="text-xs text-muted">{x.main.label}{' '}<b className={tone.text}>{x.main.value}</b>{x.extra && <> · {x.extra.label}{' '}<b className="text-ink">{x.extra.value}</b></>}</div>
            </Link>
          ))
        ) : (
          <p className="text-sm text-muted">{s.empty}</p>
        )
      ) : (
        <div className="rounded-2xl p-4 bg-surface2/60 space-y-2">
          <div className="flex items-center gap-2 font-bold"><Lock /> {s.locked.title}</div>
          <p className="text-sm text-muted">{s.locked.text}</p>
        </div>
      )}
      <Link to={s.link.to} className="mt-auto text-sm font-bold text-accent">{s.link.label}</Link>
    </div>
  )
}

export function ResultsCard({ r }: { r: HResults }) {
  const rows = r.rows
  const hits = rows?.filter(x => x.hit).length || 0
  const counted = rows?.filter(x => x.hit !== null).length || 0
  const side = (s: HResult['home']) => (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex items-center gap-2 min-w-0">
        <Crest team={{ name: s.name, logo: s.logo }} size={18} />
        <span className={`text-sm truncate ${s.won ? 'font-semibold text-ink' : 'text-muted'}`}>{s.name}</span>
      </span>
      <span className={`num text-sm ${s.won ? 'font-bold text-ink' : 'text-muted'}`}>{s.score}</span>
    </div>
  )
  return (
    <div className="card p-3 flex flex-col">
      <div className="flex items-baseline justify-between gap-2 px-3 pt-3 pb-3">
        <h2 className="font-display font-bold text-ink text-lg">{tt("Latest results")}</h2>
        {rows && counted > 0 && <span className="text-[11px] text-faint"><span className="num font-semibold text-ink">{hits}</span>/<span className="num">{counted}</span> {tt("picks right")}</span>}
      </div>
      {!rows ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-surface2/60 animate-pulse" />)}</div>
      ) : rows.length === 0 ? (
        <p className="px-1 text-xs text-faint">{tt("No finished games in the last {0} days.", { 0: r.days })}</p>
      ) : (
        <ul className="space-y-1 max-h-[340px] overflow-y-auto overscroll-contain pr-1">
          {rows.map(x => <ResultItem key={x.id} x={x} side={side} />)}
        </ul>
      )}
      {r.link && rows && rows.length > 0 && <RecordLink to={r.link.to} className="block px-1 pt-2 text-[11px] font-semibold text-muted hover:text-ink">{r.link.label}</RecordLink>}
    </div>
  )
}
type HResult = NonNullable<HResults['rows']>[number]

/** One finished game of "Latest results"; fix209: its arrow opens the scorers line. */
function ResultItem({ x, side }: { x: HResult; side: (s: HResult['home']) => ReactNode }) {
  const [scOpen, scToggle] = useScorersOpen()
  const scorable = !!scorersSource(x.href)
  return (
            <li>
              <Link to={x.href} className="block rounded-xl px-2 py-2 hover:bg-surface2 transition-colors">
                <div className="flex items-center justify-between gap-2 text-[10px] text-faint mb-1">
                  <span className="truncate">{x.competition}</span>
                  <span className="flex-shrink-0">{new Date(x.date).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                </div>
                {side(x.home)}
                {side(x.away)}
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                  {x.pick ? (
                    <span className="flex items-center gap-1.5 min-w-0 text-faint">
                      <span className="whitespace-nowrap">{tt("Our pick")}</span>
                      {x.pick.tag && <span className="inline-grid place-items-center h-4 px-1 rounded text-[9px] font-extrabold leading-none tracking-wide bg-accent text-bg num">{x.pick.tag}</span>}
                      <span className="font-semibold text-ink/85 truncate">{x.pick.words}</span>
                    </span>
                  ) : <span />}
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    {x.hit !== null && <span className={`font-extrabold ${x.hit ? 'text-win' : 'text-loss'}`} aria-label={x.hit ? tt("Right") : tt("Wrong")}>{x.hit ? '✓' : '✗'}</span>}
                    {scorable && <ScorersToggle open={scOpen} onToggle={scToggle} />}
                  </span>
                </div>
              </Link>
              {scOpen && <RowScorersLine href={x.href} live={false} homeName={x.home.name} awayName={x.away.name} className="px-2 pb-2" />}
            </li>
  )
}

/* ---------- news ---------- */

export function NewsBlock({ news, full, loading }: { news: HNews[]; full: boolean; loading: string }) {
  return (
    <Section title={tt("Around the world")}>
      {news.length ? (
        <div className="grid gap-4 md:grid-cols-[1.25fr_1fr]">
          {(() => {
            const lead = news.find(isPhoto) || news[0]
            const rest = news.filter(n => n !== lead).slice(0, full ? 6 : 5)
            return (
              <>
                <a href={lead.link} target="_blank" rel="noreferrer" className="card card-hover overflow-hidden flex flex-col">
                  {isPhoto(lead) && (
                    <span className="relative block aspect-[16/9] bg-surface2 overflow-hidden">
                      <img src={lead.image || ''} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
                      <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                      <span className="absolute left-4 bottom-3 text-[11px] font-extrabold uppercase tracking-wide text-[#C8FF3D]">{lead.source}</span>
                    </span>
                  )}
                  <span className="p-5 flex flex-col gap-2 flex-1">
                    {!isPhoto(lead) && <span className="text-[11px] font-extrabold uppercase tracking-wide text-accent">{lead.source}</span>}
                    <span className="font-display text-lg sm:text-xl font-bold leading-snug text-ink break-words">{lead.title}</span>
                    {lead.summary && <span className="text-sm text-muted break-words">{lead.summary}</span>}
                    <span className="mt-auto pt-2 text-[11px] text-faint">{lead.published ? `${ago(lead.published)} · ` : ''}{tt("opens {0}", { 0: lead.source })}</span>
                  </span>
                </a>
                <div className="card p-2 flex flex-col">
                  {rest.map(n => (
                    <a key={n.link} href={n.link} target="_blank" rel="noreferrer" className="flex gap-3 p-2.5 rounded-2xl hover:bg-surface2/60 transition-colors">
                      <span className="w-24 h-16 sm:w-28 sm:h-[72px] rounded-xl overflow-hidden bg-surface2 flex-shrink-0 grid place-items-center">
                        <NewsPic n={n} />
                      </span>
                      <span className="min-w-0 flex flex-col gap-1">
                        <span className="text-sm font-bold leading-snug text-ink break-words">{n.title}</span>
                        <span className="text-[11px] text-faint">{srcLine(n)}{n.published ? ` · ${ago(n.published)}` : ''}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </>
            )
          })()}
        </div>
      ) : (
        <div className="card p-6 text-sm text-muted">{loading}</div>
      )}
    </Section>
  )
}

/** The news column on wide screens (third column of the first row). */
export function NewsRail({ news, loading }: { news: HNews[]; loading: string }) {
  const lead = news.find(isPhoto) || news[0]
  const rest = lead ? news.filter(n => n !== lead).slice(0, 8) : []
  return (
    <section className="card p-3 max-h-[calc(100vh-6.5rem)] overflow-y-auto flex flex-col gap-2">
      <h2 className="shrink-0 font-display text-lg font-bold px-2 pt-1">{tt("Around the world")}</h2>
      {!lead ? (
        <p className="shrink-0 px-2 pb-2 text-sm text-muted">{loading}</p>
      ) : (
        <>
          <a href={lead.link} target="_blank" rel="noreferrer" className="shrink-0 rounded-2xl overflow-hidden bg-surface2/40 hover:bg-surface2/70 transition-colors flex flex-col">
            {isPhoto(lead) && (
              <span className="relative block aspect-[16/9] bg-surface2 overflow-hidden">
                <img src={lead.image || ''} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }} />
                <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                <span className="absolute left-3 bottom-2 text-[10px] font-extrabold uppercase tracking-wide text-[#C8FF3D]">{lead.source}</span>
              </span>
            )}
            <span className="p-3 flex flex-col gap-1.5 flex-1 min-w-0">
              {!isPhoto(lead) && <span className="text-[10px] font-extrabold uppercase tracking-wide text-accent">{lead.source}</span>}
              <span className="font-display font-bold leading-snug text-ink break-words">{lead.title}</span>
              {lead.summary && <span className="text-xs text-muted break-words">{lead.summary}</span>}
              <span className="text-[11px] text-faint">{lead.published ? ago(lead.published) : lead.source}</span>
            </span>
          </a>
          {rest.map(n => (
            <a key={n.link} href={n.link} target="_blank" rel="noreferrer" className="shrink-0 flex gap-3 p-2 rounded-2xl hover:bg-surface2/60 transition-colors">
              <span className="w-20 h-14 rounded-xl overflow-hidden bg-surface2 flex-shrink-0 grid place-items-center">
                <NewsPic n={n} />
              </span>
              <span className="min-w-0 flex flex-col gap-1">
                <span className="text-[13px] font-bold leading-snug text-ink break-words">{n.title}</span>
                <span className="text-[11px] text-faint">{srcLine(n)}{n.published ? ` · ${ago(n.published)}` : ''}</span>
              </span>
            </a>
          ))}
        </>
      )}
    </section>
  )
}

export function PremiumCard({ text }: { text: string }) {
  return (
    <div className="rounded-3xl p-7 border border-home/40 bg-[linear-gradient(150deg,#1B2A55_0%,#101624_70%)] text-[#EEF1F6] flex flex-col gap-4 self-start">
      <span className="self-start text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#07090D] bg-[#C8FF3D] px-3 py-1 rounded-full">{tt("Premium")}</span>
      <h2 className="font-display text-2xl font-bold leading-tight">{tt("See the numbers behind every pick")}</h2>
      <p className="text-sm text-[#C9D0DB] leading-relaxed">{text}</p>
      <Link to="/premium" className="h-12 rounded-2xl bg-[#C8FF3D] text-[#07090D] font-extrabold grid place-items-center">{tt("Go Premium")}</Link>
    </div>
  )
}

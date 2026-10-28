import { t, isRtl } from '../../../lib/i18n'

/**
 * fix174: the live win chance block every winner sport shows (basketball's since fix110, NFL + college now): each
 * side's chance now against before the game, the bar, the projected final score; and the swing chart — the home
 * team's win chance through the game (live and after full time).
 */
export interface LiveNow { pHome: number; pAway: number; score: { home: number; away: number }; total: number }

/** fix193: `words` = the projection line's labels (tennis: the sets so far and the games played) */
export function LiveChancePanel({ home, away, now, before, status, words }: { home: string; away: string; now: LiveNow; before: { pHome: number; pAway: number }; status: string; words?: { score: string; total: string } }) {
  const cap = (v: number) => Math.min(99, Math.max(1, Math.round(v)))
  const rows = [
    { k: 'H' as const, label: home, now: now.pHome, before: before.pHome, bar: 'bg-home' },
    { k: 'A' as const, label: away, now: now.pAway, before: before.pAway, bar: 'bg-away' }
  ]
  const top = now.pHome >= 50 ? 'H' : 'A'
  return (
    <div className="mt-4 rounded-2xl border border-live/40 bg-live/[0.06] p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-live animate-pulseDot" aria-hidden />
          <span className="text-sm font-bold text-ink">{t('Live win chance')}</span>
        </div>
        <span className="num text-xs font-semibold text-live">{status}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        {rows.map(r => {
          const diff = Math.round(r.now) - Math.round(r.before)
          return (
            <div key={r.k} className={`rounded-xl px-2 py-2 text-center ${r.k === top ? 'bg-surface border border-line' : ''}`}>
              <div className="text-[11px] text-muted truncate">{r.label}</div>
              <div className="num text-xl sm:text-2xl font-extrabold text-ink">{cap(r.now)}%</div>
              <div className={`num text-[11px] font-semibold ${diff > 0 ? 'text-win' : diff < 0 ? 'text-loss' : 'text-faint'}`}>
                {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {Math.abs(diff)} <span className="text-faint font-normal">· {t('was {0}%', { 0: Math.round(r.before) })}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex h-2 gap-[3px] mt-3" aria-hidden>
        {rows.map(r => <div key={r.k} className={`rounded-full ${r.bar} transition-all duration-700`} style={{ width: `calc(${Math.max(1, r.now)}% - 3px)` }} />)}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-surface/70 border border-line/60 px-3 py-2">
        <span className="text-xs text-muted">{words?.score ?? t('Projected final score')}</span>
        <span className="text-end leading-tight">
          <span className="block num text-sm font-extrabold text-ink whitespace-nowrap">{now.score.home} – {now.score.away}</span>
          <span className="block num text-[11px] text-faint whitespace-nowrap">{words?.total ?? t('{0} points in total', { 0: now.total })}</span>
        </span>
      </div>
    </div>
  )
}

/** The home team's win chance through the game: t = share of regulation played (overtime past 1), p = home %. */
export function SwingChart({ points, home, away, periods = 4, live = false }: { points: { t: number; p: number }[]; home: string; away: string; periods?: number; live?: boolean }) {
  if (points.length < 2) return null
  const W = 600, H = 150, PAD = 6
  const maxT = Math.max(1, ...points.map(x => x.t))
  // fix257: time runs from the start side (right to left in ar / he)
  const x = (v: number) => { const px = PAD + ((W - 2 * PAD) * v) / maxT; return isRtl ? W - px : px }
  const y = (p: number) => PAD + ((H - 2 * PAD) * (100 - p)) / 100
  const path = points.map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(q.p).toFixed(1)}`).join(' ')
  const area = `${path} L${x(points[points.length - 1].t).toFixed(1)},${y(50)} L${x(points[0].t).toFixed(1)},${y(50)} Z`
  const last = points[points.length - 1]
  const grid = Array.from({ length: periods - 1 }, (_, i) => (i + 1) / periods)
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
        <span className="text-home truncate">{home}</span>
        <span className="text-faint">{live ? t('Win chance so far') : t('How the win chance moved')}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={t('{0}: win chance through the game', { 0: home })}>
        <defs>
          <linearGradient id="swingFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--home))" stopOpacity="0.35" />
            <stop offset="50%" stopColor="rgb(var(--home))" stopOpacity="0.02" />
            <stop offset="50%" stopColor="rgb(var(--away))" stopOpacity="0.02" />
            <stop offset="100%" stopColor="rgb(var(--away))" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width={W} height={H} rx="12" className="fill-surface2/40" />
        {grid.map(g => <line key={g} x1={x(g)} x2={x(g)} y1={PAD} y2={H - PAD} className="stroke-line" strokeDasharray="3 4" />)}
        {maxT > 1 && <line x1={x(1)} x2={x(1)} y1={PAD} y2={H - PAD} className="stroke-faint" strokeDasharray="2 3" />}
        <line x1={PAD} x2={W - PAD} y1={y(50)} y2={y(50)} className="stroke-line" />
        <path d={area} fill="url(#swingFill)" />
        <path d={path} fill="none" className="stroke-ink" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.t)} cy={y(last.p)} r="4" className={live ? 'fill-live' : 'fill-ink'} />
      </svg>
      <div className="flex items-center justify-between text-[11px] font-semibold mt-1">
        <span className="text-away truncate">{away}</span>
        <span className="num text-faint">{t('{0}: {1}%', { 0: home, 1: Math.round(last.p) })}</span>
      </div>
    </div>
  )
}

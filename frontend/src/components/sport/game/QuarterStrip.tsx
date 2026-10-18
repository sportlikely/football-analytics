import { t } from '../../../lib/i18n'

/**
 * fix174: the game by quarter when the provider has no play-by-play — each quarter's points, who won it and the
 * running margin (basketball everywhere, NFL when there are no scoring plays).
 */
export default function QuarterStrip({ home, away, q }: { home: string; away: string; q: { home: (number | null)[]; away: (number | null)[] } }) {
  const n = Math.max(q.home.length, q.away.length)
  const cols: { label: string; h: number; a: number; run: number }[] = []
  let run = 0
  for (let i = 0; i < n; i++) {
    const h = q.home[i], a = q.away[i]
    if (h == null || a == null) continue
    run += h - a
    cols.push({ label: i < 4 ? t('Q{0}', { 0: i + 1 }) : n > 5 ? t('OT{0}', { 0: i - 3 }) : t('OT'), h, a, run })
  }
  if (!cols.length) return null
  const max = Math.max(1, ...cols.map(c => Math.abs(c.run)))
  return (
    <div>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map(c => {
          const won = c.h > c.a ? 'H' : c.h < c.a ? 'A' : null
          return (
            <div key={c.label} className="rounded-xl border border-line/60 bg-surface2/40 p-2 text-center min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wide text-faint">{c.label}</div>
              <div className="num text-sm font-extrabold mt-1"><span className={won === 'H' ? 'text-home' : 'text-muted'}>{c.h}</span><span className="text-faint">–</span><span className={won === 'A' ? 'text-away' : 'text-muted'}>{c.a}</span></div>
              <div className="h-8 mt-1.5 relative" aria-hidden>
                <span className="absolute left-0 right-0 top-1/2 h-px bg-line" />
                <span className={`absolute left-1/2 -translate-x-1/2 w-2 rounded-full ${c.run >= 0 ? 'bg-home bottom-1/2' : 'bg-away top-1/2'}`} style={{ height: `${(Math.abs(c.run) / max) * 50}%` }} />
              </div>
              <div className={`num text-[11px] font-semibold ${c.run > 0 ? 'text-home' : c.run < 0 ? 'text-away' : 'text-faint'}`}>{c.run > 0 ? '+' : ''}{c.run}</div>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[11px] text-faint">{t('Points per quarter; the bar and the number under it = the running margin ({0} up, {1} down).', { 0: home, 1: away })}</p>
    </div>
  )
}

import { t as tt } from '../../lib/i18n'
import { useStuck, stuckBg } from '../../lib/useStuck'

/** A list heading ("Today · 12 matches"), sticky under the header for day lists (football's, shared since fix152). */
export default function SectionTitle({ label, sub, count, accent, sticky, unit }: { label: string; sub?: string; count?: number; accent?: 'live'; sticky?: boolean; unit?: string }) {
  const [ref, stuck] = useStuck<HTMLDivElement>()
  return (
    <div ref={sticky ? ref : undefined} className={`flex items-baseline gap-3 mb-3 ${sticky ? `sticky top-[113px] sm:top-16 z-30 py-2 -my-2 ${stuckBg(stuck)}` : ''}`}>
      <h2 className={`font-display text-lg font-bold tracking-tight ${accent === 'live' ? 'text-live' : 'text-ink'}`}>
        {accent === 'live' && <span className="inline-block w-2 h-2 rounded-full bg-live animate-pulseDot me-2 align-middle" />}
        {label}
      </h2>
      {count !== undefined && <span className="num text-xs text-faint">{count} {unit ?? tt("matches")}</span>}
      {sub && <span className="text-xs text-faint">{sub}</span>}
    </div>
  )
}

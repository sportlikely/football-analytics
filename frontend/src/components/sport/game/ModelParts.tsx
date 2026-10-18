import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'

/**
 * "How this was calculated" as a table of the model's parts, one column per team (basketball's since fix110,
 * NFL + college since fix174): each row is a part of the prediction, the last row the result.
 */
export interface PartRow { label: string; h: string; a: string }
export default function ModelParts({ home, away, rows, total, note }: { home: ReactNode; away: ReactNode; rows: PartRow[]; total?: PartRow | null; note?: ReactNode }) {
  return (
    <div className="mt-3">
      <table className="w-full text-xs num">
        <thead>
          <tr className="text-faint"><th className="text-left font-semibold py-1">{t('Part')}</th><th className="text-right font-semibold w-24 truncate">{home}</th><th className="text-right font-semibold w-24 truncate">{away}</th></tr>
        </thead>
        <tbody>
          {rows.map(x => <tr key={x.label} className="border-t border-line/40"><td className="py-1 text-muted font-sans">{x.label}</td><td className="text-right text-ink">{x.h}</td><td className="text-right text-ink">{x.a}</td></tr>)}
          {total && <tr className="border-t border-line"><td className="py-1.5 font-sans font-bold text-ink">{total.label}</td><td className="text-right font-bold text-home">{total.h}</td><td className="text-right font-bold text-away">{total.a}</td></tr>}
        </tbody>
      </table>
      {note && <p className="mt-2 text-[11px] text-faint">{note}</p>}
    </div>
  )
}

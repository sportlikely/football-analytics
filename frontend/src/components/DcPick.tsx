import { useNavigate } from 'react-router-dom'
import { doubleChance, dcLabel, type DC, type Prediction } from '../lib/predict'
import { t } from '../lib/i18n'
import { bandOf, bandWord, BAND_TEXT } from '../lib/confidence'

/** Small "X2" tag (fix120: our pick is a double chance). */
export function DcTag({ code, className = '' }: { code: DC; className?: string }) {
  return (
    <span className={`inline-grid place-items-center h-4 px-1 rounded text-[9px] font-extrabold leading-none tracking-wide bg-accent text-bg num ${className}`} title={t("Our pick: double chance")}>
      {code}
    </span>
  )
}

/**
 * The main pick badge, football only: "Our pick: Barça or draw · 82%" (fix127: words, not the code), plus the band word
 * (fix281, lib/confidence: Very likely 80%+ / Likely 60–79% / Close call). Locked predictions show the code and names without the %.
 */
export default function OurPick({ p, home, away, dark = false, compact = false, showCode = false, className = '' }: { p: Prediction | null | undefined; home: string; away: string; dark?: boolean; compact?: boolean; showCode?: boolean; className?: string }) {
  const dc = doubleChance(p)
  if (!dc) return null
  const even = typeof p?.home === 'number' && typeof p?.away === 'number' && isEvenGame(p.home, p.away)
  return <OurPickBadge code={dc.code} pct={dc.pct} home={home} away={away} dark={dark} compact={compact} showCode={showCode} even={even} className={className} />
}

/** fix179: the top two win chances (home vs away) within 3 points = an even game (the model can't split them). */
export const isEvenGame = (home: number, away: number) => Math.abs(home - away) < 3

/** fix179: the small "Even game" chip, every sport (list rows, football pick badge, winner-sport prediction). */
export function EvenChip({ compact = true, dark = false }: { compact?: boolean; dark?: boolean }) {
  return (
    <span title={t("Both teams' win chances are within 3 points.")}
      className={`inline-block rounded-full border font-bold whitespace-nowrap leading-none ${compact ? 'text-[9px] px-1.5 py-px' : 'text-[11px] px-2 py-0.5'} ${dark ? 'border-white/40 text-white/80' : 'border-line text-muted'}`}>
      {t("Even game")}
    </span>
  )
}

/** Same badge from the code and % alone (alerts and other server lists that send { k, p }). */
export function OurPickBadge({ code, pct, home, away, dark = false, compact = false, showCode = false, even = false, className = '' }: { code: DC; pct: number | null; home: string; away: string; dark?: boolean; compact?: boolean; showCode?: boolean; even?: boolean; className?: string }) {
  const dc = { code, pct: pct === null ? null : Math.round(pct) }
  const band = dc.pct === null ? null : bandOf(dc.pct)
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 min-w-0 ${className}`}>
      <span className={`inline-flex items-center gap-1 min-w-0 max-w-full rounded-full font-extrabold ${compact ? 'text-[11px] px-2 py-0.5' : 'text-xs sm:text-[13px] px-2.5 py-1'} ${dark ? 'bg-[#C8FF3D] text-[#07090D]' : 'bg-accent text-bg'}`}>
        <span className="whitespace-nowrap">{t("Our pick")}</span>
        <DcHelp onAccent />
        <span className="truncate" title={t("Double chance: two of the three results. Right if either happens.")}>{dcLabel(dc.code, home, away)}</span>
        {dc.pct !== null && (
          <>
            <span aria-hidden>·</span>
            <span className="num whitespace-nowrap">{dc.pct}%</span>
          </>
        )}
      </span>
      {showCode && <span className="text-[10px] font-bold text-faint num" title={t("Double chance: two of the three results. Right if either happens.")}>{dc.code}</span>}
      {band && (
        <span data-band={band} className={`inline-block rounded-full border font-bold whitespace-nowrap ${compact ? 'text-[10px] px-1.5 py-px' : 'text-[11px] px-2 py-0.5'} ${dark ? 'border-white/40 text-white/90' : `border-current ${BAND_TEXT[band]}`}`}>
          {bandWord(band)}
        </span>
      )}
      {even && <EvenChip compact={compact} dark={dark} />}
    </span>
  )
}

/** The small "?" after "Our pick": opens the double-chance guide (rows are links themselves, so no nested <a>). */
export function DcHelp({ onAccent = false }: { onAccent?: boolean }) {
  const navigate = useNavigate()
  const go = (e: { preventDefault: () => void; stopPropagation: () => void }) => { e.preventDefault(); e.stopPropagation(); navigate('/guides/double-chance') }
  return (
    <span
      role="link" tabIndex={0} aria-label={t("What is double chance?")} title={t("Double chance: two of the three results. Right if either happens.")}
      onClick={go} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') go(e) }}
      className={`inline-grid place-items-center w-3.5 h-3.5 rounded-full border text-[8px] font-extrabold leading-none cursor-pointer ${onAccent ? 'border-current text-current opacity-70 hover:opacity-100' : 'border-faint/60 text-faint hover:text-ink hover:border-ink/50'}`}
    >?</span>
  )
}

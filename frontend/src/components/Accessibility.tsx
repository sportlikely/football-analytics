import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { t } from '../lib/i18n'

/**
 * Accessibility menu (Israeli Standard 5568 / WCAG 2.1 AA, EU Accessibility Act): a fixed button on every page that
 * opens settings the visitor can change — text size, contrast, readable font, highlighted links, stopped animations,
 * bigger cursor, line spacing. Choices are kept in this browser and applied as classes on <html>.
 */

interface Prefs { text: 0 | 1 | 2 | 3; contrast: 'none' | 'high' | 'invert' | 'gray'; font: boolean; links: boolean; motion: boolean; cursor: boolean; spacing: boolean }
const DEFAULT: Prefs = { text: 0, contrast: 'none', font: false, links: false, motion: false, cursor: false, spacing: false }
const KEY = 'b2b-a11y'

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT
  } catch {
    return DEFAULT
  }
}

export function applyA11y(p: Prefs) {
  const h = document.documentElement
  h.classList.remove('a11y-text-1', 'a11y-text-2', 'a11y-text-3', 'a11y-contrast', 'a11y-invert', 'a11y-gray', 'a11y-font', 'a11y-links', 'a11y-motion', 'a11y-cursor', 'a11y-spacing')
  if (p.text) h.classList.add(`a11y-text-${p.text}`)
  if (p.contrast === 'high') h.classList.add('a11y-contrast')
  if (p.contrast === 'invert') h.classList.add('a11y-invert')
  if (p.contrast === 'gray') h.classList.add('a11y-gray')
  if (p.font) h.classList.add('a11y-font')
  if (p.links) h.classList.add('a11y-links')
  if (p.motion) h.classList.add('a11y-motion')
  if (p.cursor) h.classList.add('a11y-cursor')
  if (p.spacing) h.classList.add('a11y-spacing')
}

/** Apply saved settings before the first paint (called from App). */
export function initA11y() {
  applyA11y(read())
}

export default function AccessibilityMenu() {
  const [open, setOpen] = useState(false)
  const [p, setP] = useState<Prefs>(() => read())
  const loc = useLocation()

  useEffect(() => {
    applyA11y(p)
    try {
      localStorage.setItem(KEY, JSON.stringify(p))
    } catch {
      /* private mode */
    }
  }, [p])

  useEffect(() => setOpen(false), [loc.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const active = p.text > 0 || p.contrast !== 'none' || p.font || p.links || p.motion || p.cursor || p.spacing
  const Toggle = ({ k, label, hint }: { k: 'font' | 'links' | 'motion' | 'cursor' | 'spacing'; label: string; hint: string }) => (
    <button
      type="button"
      role="switch"
      aria-checked={p[k]}
      onClick={() => setP({ ...p, [k]: !p[k] })}
      className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-start text-sm ${p[k] ? 'border-accent/60 bg-accent/10 text-ink' : 'border-line text-ink hover:bg-surface2/60'}`}
    >
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <span aria-hidden className={`w-10 h-6 rounded-full relative flex-shrink-0 transition-colors ${p[k] ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-surface transition-all ${p[k] ? 'start-5' : 'start-1'}`} />
      </span>
    </button>
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="a11y-menu"
        aria-label={t("Accessibility menu")}
        title={t("Accessibility")}
        className={`fixed z-40 start-3 bottom-[4.6rem] lg:bottom-6 lg:start-6 w-9 h-9 lg:w-12 lg:h-12 opacity-80 hover:opacity-100 focus:opacity-100 lg:opacity-100 rounded-full grid place-items-center shadow-lift border-2 ${active ? 'bg-accent text-bg border-accent' : 'bg-[#1d4ed8] text-white border-white/70'}`}
      >
        {/* the universal accessibility icon */}
        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="4.2" r="2.2" />
          <path d="M3.5 8.2a1.1 1.1 0 0 1 1.3-.9c2.4.6 4.8.9 7.2.9s4.8-.3 7.2-.9a1.1 1.1 0 1 1 .5 2.1c-1.8.5-3.6.7-5.4.8v2.6l2.6 7.2a1.1 1.1 0 0 1-2.1.8L12.6 15h-1.2l-2.2 5.8a1.1 1.1 0 1 1-2.1-.8l2.6-7.2v-2.6c-1.8-.1-3.6-.3-5.4-.8a1.1 1.1 0 0 1-.8-1.2z" />
        </svg>
      </button>

      {open && (
        <div
          id="a11y-menu"
          role="dialog"
          aria-modal="false"
          aria-label={t("Accessibility settings")}
          className="fixed z-50 start-4 end-4 bottom-40 lg:bottom-20 lg:start-6 lg:end-auto lg:w-[360px] max-h-[70vh] overflow-y-auto rounded-3xl border border-line bg-surface shadow-lift p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold text-ink">{t("Accessibility")}</h2>
            <button type="button" onClick={() => setOpen(false)} className="w-8 h-8 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface2" aria-label={t("Close")}>×</button>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted mb-1.5">{t("Text size")}</div>
            <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t("Text size")}>
              {([0, 1, 2, 3] as const).map(n => (
                <button key={n} type="button" role="radio" aria-checked={p.text === n} onClick={() => setP({ ...p, text: n })}
                  className={`h-10 rounded-xl border text-sm font-bold ${p.text === n ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink hover:bg-surface2/60'}`}>
                  {n === 0 ? 'A' : `A+${n}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted mb-1.5">{t("Colours")}</div>
            <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={t("Colours")}>
              {([['none', 'Normal'], ['high', 'High contrast'], ['invert', 'Inverted'], ['gray', 'Grayscale']] as const).map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={p.contrast === v} onClick={() => setP({ ...p, contrast: v })}
                  className={`h-10 rounded-xl border text-sm font-semibold ${p.contrast === v ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink hover:bg-surface2/60'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Toggle k="font" label={t("Readable font")} hint={t("Plain font, wider letters")} />
            <Toggle k="links" label={t("Highlight links")} hint={t("Underlined and marked")} />
            <Toggle k="spacing" label={t("More line spacing")} hint={t("Room between lines and words")} />
            <Toggle k="motion" label={t("Stop animations")} hint={t("No moving numbers or effects")} />
            <Toggle k="cursor" label={t("Big cursor")} hint={t("Easier to follow")} />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1 text-xs">
            <button type="button" onClick={() => setP(DEFAULT)} className="text-muted hover:text-ink underline underline-offset-4">{t("Reset")}</button>
            <Link to="/accessibility" className="font-semibold text-accent">{t("Accessibility statement →")}</Link>
          </div>
        </div>
      )}
    </>
  )
}

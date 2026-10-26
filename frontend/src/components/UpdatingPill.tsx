/**
 * fix250: while the app waits for the server (its { pending: true }, a slow answer shown from the kept copy) a small
 * "Updating…" pill shows at the top — the page itself keeps its last known data, never an empty screen.
 * It shows only after 600 ms of waiting (a quick refresh never flashes it).
 */
import { useEffect, useState } from 'react'
import { onWaiting } from '../lib/apiCache'
import { t } from '../lib/i18n'

export default function UpdatingPill() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onWaiting(n => {
      if (n > 0 && !timer && !show) timer = setTimeout(() => { timer = null; setShow(true) }, 600)
      if (n === 0) { if (timer) { clearTimeout(timer); timer = null } setShow(false) }
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [])
  if (!show) return null
  return (
    <div role="status" aria-live="polite" className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <span className="flex items-center gap-2 rounded-full bg-surface2 border border-line px-3 py-1 text-xs text-muted shadow">
        <span className="w-3 h-3 rounded-full border-2 border-line border-t-accent animate-spin" aria-hidden />
        {t('Updating…')}
      </span>
    </div>
  )
}

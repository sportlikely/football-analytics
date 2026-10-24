import { useEffect, useRef, useState } from 'react'
import { socket } from '../../../lib/socket'
import { t } from '../../../lib/i18n'

/**
 * fix208: live box scores (basketball, American football). The page joins its game's room on the socket while the box
 * score is live; the server sends `bbBox` / `nflBox` each time it stored a new one, and the page reloads its data (no
 * page reload). An open page also counts as "someone is watching": the server then fetches the box score every 60 s.
 */
export function useLiveBox(sport: 'bb' | 'nfl', id: number | null, active: boolean, onUpdate: () => void) {
  const cb = useRef(onUpdate)
  cb.current = onUpdate
  useEffect(() => {
    if (!active || !id) return
    const join = () => socket.emit('subscribe_game', { sport, id })
    let timer: ReturnType<typeof setTimeout> | null = null
    const onBox = (m: { id?: number }) => {
      if (Number(m?.id) !== id) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => cb.current(), 500)
    }
    join()
    socket.on('connect', join)
    socket.on(`${sport}Box`, onBox)
    return () => {
      if (timer) clearTimeout(timer)
      socket.off('connect', join)
      socket.off(`${sport}Box`, onBox)
      socket.emit('unsubscribe_game', { sport, id })
    }
  }, [sport, id, active])
}

/** "LIVE · updated 40 s ago" (ticks every 5 s) */
export function LiveBoxLabel({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(iv)
  }, [])
  const s = Math.max(0, Math.round((now - at) / 1000))
  const text = s < 10 ? t('LIVE · updated just now') : s < 90 ? t('LIVE · updated {0} s ago', { 0: s }) : t('LIVE · updated {0} min ago', { 0: Math.round(s / 60) })
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-live">
      <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />
      {text}
    </span>
  )
}

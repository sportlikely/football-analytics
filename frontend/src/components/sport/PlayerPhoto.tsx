import { useState } from 'react'
import { officialPhoto } from '../../lib/photoSources'

/**
 * A player's photo as a round picture — fix241: only from an official source (lib/photoSources.ts: API-Football today);
 * anything else, no photo, or one that fails to load: the initials with the flag as a small badge, same size — never a
 * broken image (fix52).
 */
const initialsOf = (raw: string | null | undefined) => {
  const s = typeof raw === 'string' && raw.trim() ? raw : '?'
  const w = s.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(x => x.length > 1)
  return (w.length >= 2 ? w[0][0] + w[w.length - 1][0] : (w[0] || s).slice(0, 2)).toUpperCase()
}

export default function PlayerPhoto({ src, name, flag, size = 40, square = false, className = '' }: { src: string | null | undefined; name: string; flag?: string | null; size?: number; square?: boolean; className?: string }) {
  const [broken, setBroken] = useState(false)
  const url = officialPhoto(src)
  const shape = square ? 'rounded-3xl' : 'rounded-full'
  const badge = flag && size >= 28 ? (
    <span aria-hidden className="absolute -bottom-0.5 -end-0.5 grid place-items-center rounded-full bg-surface ring-2 ring-surface leading-none" style={{ width: Math.round(size * 0.42), height: Math.round(size * 0.42), fontSize: Math.round(size * 0.3) }}>{flag}</span>
  ) : null
  return (
    <span className={`relative inline-grid flex-shrink-0 ${className}`} style={{ width: size, height: size }}>
      {url && !broken ? (
        <img src={url} alt={name} width={size} height={size} loading="lazy" onError={() => setBroken(true)} className={`${shape} w-full h-full object-cover bg-surface2 ring-1 ring-line/60`} />
      ) : (
        <span className={`${shape} w-full h-full bg-surface2 border border-line/60 grid place-items-center font-display font-bold text-muted leading-none`} style={{ fontSize: Math.max(7, Math.round(size * 0.36)) }} title={name}>{initialsOf(name)}</span>
      )}
      {badge}
    </span>
  )
}

/** fix241: the player-page header without an official photo — big initials with the country flag under them */
export function PlayerInitials({ name, flag }: { name: string; flag?: string | null }) {
  return (
    <span className="grid place-items-center gap-1.5 leading-none" title={name}>
      <span className="font-display text-3xl font-extrabold text-ink">{initialsOf(name)}</span>
      {flag && <span className="text-lg" aria-hidden>{flag}</span>}
    </span>
  )
}

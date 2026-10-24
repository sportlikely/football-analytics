import { useState } from 'react'
import { t } from '../../lib/i18n'

/**
 * fix211: a player's photo (tennis, basketball: Wikidata / Commons, served from our domain) as a round picture. No
 * photo, or one that fails to load: the initials with the flag as a small badge — never a broken image (fix52).
 */
export const isPlayerPhoto = (url: string | null | undefined) => typeof url === 'string' && url.startsWith('/media/players/')

const initialsOf = (raw: string | null | undefined) => {
  const s = typeof raw === 'string' && raw.trim() ? raw : '?'
  const w = s.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(x => x.length > 1)
  return (w.length >= 2 ? w[0][0] + w[w.length - 1][0] : (w[0] || s).slice(0, 2)).toUpperCase()
}

export default function PlayerPhoto({ src, name, flag, size = 40, square = false, className = '' }: { src: string | null | undefined; name: string; flag?: string | null; size?: number; square?: boolean; className?: string }) {
  const [broken, setBroken] = useState(false)
  const shape = square ? 'rounded-3xl' : 'rounded-full'
  const badge = flag && size >= 28 ? (
    <span aria-hidden className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-surface ring-2 ring-surface leading-none" style={{ width: Math.round(size * 0.42), height: Math.round(size * 0.42), fontSize: Math.round(size * 0.3) }}>{flag}</span>
  ) : null
  return (
    <span className={`relative inline-grid flex-shrink-0 ${className}`} style={{ width: size, height: size }}>
      {src && !broken ? (
        <img src={src} alt={name} width={size} height={size} loading="lazy" onError={() => setBroken(true)} className={`${shape} w-full h-full object-cover bg-surface2 ring-1 ring-line/60`} />
      ) : (
        <span className={`${shape} w-full h-full bg-surface2 border border-line/60 grid place-items-center font-display font-bold text-muted leading-none`} style={{ fontSize: Math.max(7, Math.round(size * 0.36)) }} title={name}>{initialsOf(name)}</span>
      )}
      {badge}
    </span>
  )
}

export interface PhotoCreditT { author: string; licence: string; licenceUrl: string | null; source: string }
/** "Photo: Jane Doe, CC BY-SA 4.0" under a player's photo, linked to the Commons file */
export function PhotoCredit({ credit }: { credit: PhotoCreditT | null | undefined }) {
  if (!credit) return null
  return (
    <a href={credit.source} target="_blank" rel="noopener noreferrer nofollow" className="block max-w-[9rem] text-[10px] leading-tight text-faint hover:text-muted break-words">
      {t("Photo: {0}, {1}", { 0: credit.author, 1: credit.licence })}
    </a>
  )
}

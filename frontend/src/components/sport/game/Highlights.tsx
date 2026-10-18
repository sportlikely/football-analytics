import { useEffect, useState } from 'react'
import axios from 'axios'
import { t } from '../../../lib/i18n'

/**
 * Official highlights (YouTube), click-to-play: nothing loads from YouTube until the viewer presses play. Football's
 * match page since fix-highlights; fix174: every sport (the url = that sport's highlights route).
 */
export default function Highlights({ url }: { url: string }) {
  const [h, setH] = useState<{ videoId: string; title: string; channel: string } | null | undefined>(undefined)
  const [play, setPlay] = useState(false)
  useEffect(() => {
    let off = false
    setH(undefined)
    axios.get(url).then(r => { if (!off) setH(r.data.data || null) }).catch(() => { if (!off) setH(null) })
    return () => { off = true }
  }, [url])
  if (h === undefined) return <div className="card aspect-video max-h-[420px] animate-pulse" aria-label={t("Loading…")} />
  if (!h)
    return (
      <div className="card p-8 sm:p-10 text-center space-y-3">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-surface2 text-muted grid place-items-center">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="5" width="15" height="14" rx="2" /><path d="M17 10l5-3v10l-5-3z" />
          </svg>
        </div>
        <div className="font-display text-lg font-bold text-ink">{t("There is no official highlight for this game yet")}</div>
        <p className="text-sm text-muted max-w-md mx-auto">{t("Official highlights usually come out a few hours after the final whistle. We keep checking the league and club channels, so come back later.")}</p>
      </div>
    )
  return (
    <section className="card p-5 sm:p-6 scroll-mt-32">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-base font-bold text-ink">{t("Highlights")}</h2>
        <span className="text-xs text-faint">{t("Official video · {0}", { 0: h.channel })}</span>
      </div>
      <div className="relative aspect-video rounded-2xl overflow-hidden bg-black border border-line/60">
        {play ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${h.videoId}?autoplay=1&rel=0&modestbranding=1&origin=${encodeURIComponent(window.location.origin)}`}
            title={h.title}
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <button type="button" onClick={() => setPlay(true)} className="group absolute inset-0 w-full h-full" aria-label={t("Play highlights: {0}", { 0: h.title })}>
            <img src={`https://i.ytimg.com/vi/${h.videoId}/hqdefault.jpg`} alt="" className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
            <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full bg-accent text-bg grid place-items-center shadow-lift group-hover:scale-105 transition-transform">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
            </span>
            <span className="absolute left-4 right-4 bottom-3 text-left text-sm font-bold text-white line-clamp-2">{h.title}</span>
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="text-[11px] text-faint">{t("Played by YouTube from the official channel. Some videos are only available in certain countries.")}</p>
        <a href={`https://www.youtube.com/watch?v=${h.videoId}`} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-accent hover:underline whitespace-nowrap">
          {t("Watch on YouTube")} ↗
        </a>
      </div>
    </section>
  )
}

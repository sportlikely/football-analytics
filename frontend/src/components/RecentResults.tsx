import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t as tt, LOCALE } from '../lib/i18n'
import RecordLink from './RecordLink'
import { dcLabel, type DC } from '../lib/predict'
import { DcTag } from './DcPick'
import { matchHref } from '../lib/links'

type Pick = 'H' | 'D' | 'A'
const PICK_COLOR: Record<Pick, string> = { H: 'text-home', D: 'text-draw', A: 'text-away' }

/* ---------- latest results: finished games with the pick we saved before kick-off ---------- */

interface Settled {
  matchId: number
  date: string
  competition: string | null
  home: string
  away: string
  homeCrest?: string | null
  awayCrest?: string | null
  score: string
  outcome: Pick
  /** the 1X2 hard call */
  pick: Pick
  hit: boolean
  /** fix120: our recommended pick, the double chance (p is null for free viewers) */
  dc?: { pick: DC; p: number | null; hit: boolean | null } | null
  p: Record<Pick, number> | null
}

export default function RecentResults({ code, limit, days = 14, compact, large, listClass = '' }: { code?: string; limit: number; days?: number; compact?: boolean; large?: boolean; listClass?: string }) {
  const [rows, setRows] = useState<Settled[] | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      axios
        .get(`${API_URL}/public/results`, { params: { days, limit, ...(code ? { competition: code } : {}) } })
        .then(r => !cancelled && (setRows(r.data.data?.rows || []), setError(false)))
        .catch(() => !cancelled && setError(true))
    load()
    const t = setInterval(load, 5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [code, limit, days])

  // a pick is right when the result is inside our double chance (fix120); older payloads fall back to the 1X2 pick
  const hits = rows?.filter(r => (r.dc ? r.dc.hit : r.hit)).length || 0
  return (
    <div>
      <div className={`flex items-baseline justify-between gap-2 ${large ? 'px-3 pt-3 pb-3' : 'px-1 pb-2'}`}>
        <h2 className={`font-display font-bold text-ink ${large ? 'text-lg' : ''}`}>{tt("Latest results")}</h2>
        {rows && rows.length > 0 && (
          <span className="text-[11px] text-faint">
            <span className="num font-semibold text-ink">{hits}</span>/<span className="num">{rows.length}</span> {tt("picks right")}</span>
        )}
      </div>
      {error && <p className="px-1 text-xs text-faint">{tt("Couldn't load results.")}</p>}
      {!rows && !error && (
        <div className="space-y-2">
          {Array.from({ length: compact ? 3 : 6 }).map((_, i) => (
            <div key={i} className="h-14 rounded-xl bg-surface2/60 animate-pulse" />
          ))}
        </div>
      )}
      {rows && rows.length === 0 && <p className="px-1 text-xs text-faint">{tt("No finished games in the last {0} days.", { 0: days })}</p>}
      <ul className={`space-y-1 ${listClass}`}>
        {rows?.map(r => (
          <li key={r.matchId}>
            <ResultRow r={r} compact={compact} />
          </li>
        ))}
      </ul>
      {rows && rows.length > 0 && (
        <RecordLink to="/accuracy" className="block px-1 pt-2 text-[11px] font-semibold text-muted hover:text-ink">
          {tt("How accurate is the model? →")}</RecordLink>
      )}
    </div>
  )
}

function ResultRow({ r, compact }: { r: Settled; compact?: boolean }) {
  const [hg, ag] = r.score.split(/[–-]/).map(x => x.trim())
  const pickName = r.pick === 'H' ? r.home : r.pick === 'A' ? r.away : 'Draw'
  const when = new Date(r.date).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
  const side = (name: string, crest: string | null | undefined, goals: string, won: boolean) => (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex items-center gap-2 min-w-0">
        <SmallCrest src={crest} name={name} />
        <span className={`text-sm truncate ${won ? 'font-semibold text-ink' : 'text-muted'}`}>{name}</span>
      </span>
      <span className={`num text-sm ${won ? 'font-bold text-ink' : 'text-muted'}`}>{goals}</span>
    </div>
  )
  return (
    <Link to={matchHref('football', r.matchId, { home: r.home, away: r.away, date: r.date })!} className="block rounded-xl px-2 py-2 hover:bg-surface2 transition-colors">
      <div className="flex items-center justify-between gap-2 text-[10px] text-faint mb-1">
        <span className="truncate">{r.competition}</span>
        <span className="flex-shrink-0">{when}</span>
      </div>
      {side(r.home, r.homeCrest, hg, r.outcome === 'H')}
      {side(r.away, r.awayCrest, ag, r.outcome === 'A')}
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
        {r.dc ? (
          <span className="flex items-center gap-1.5 min-w-0 text-faint">
            <span className="whitespace-nowrap">{tt("Our pick")}</span>
            <DcTag code={r.dc.pick} />
            <span className="font-semibold text-ink/85 truncate">{dcLabel(r.dc.pick, r.home, r.away)}</span>
            {!compact && r.dc.p !== null && <span className="num">{r.dc.p}%</span>}
          </span>
        ) : (
          <span className="text-faint truncate">
            {tt("Pick")}{' '}<span className={`font-semibold ${PICK_COLOR[r.pick]}`}>{pickName}</span>
            {!compact && r.p && <span className="num"> {Math.round(r.p[r.pick])}%</span>}
          </span>
        )}
        {r.dc && r.dc.hit !== null && (
          <span className={`flex-shrink-0 font-extrabold ${r.dc.hit ? 'text-win' : 'text-loss'}`} aria-label={r.dc.hit ? tt("Right") : tt("Wrong")}>{r.dc.hit ? '✓' : '✗'}</span>
        )}
      </div>
    </Link>
  )
}

/** A badge from a URL; falls back to .svg (some football-data.org crests), then to initials. */
function SmallCrest({ src, name }: { src?: string | null; name: string }) {
  const [url, setUrl] = useState(src || '')
  const [failed, setFailed] = useState(!src)
  useEffect(() => {
    setUrl(src || '')
    setFailed(!src)
  }, [src])
  if (failed)
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-surface2 flex-shrink-0 grid place-items-center text-[8px] font-bold text-faint">
        {name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}
      </span>
    )
  return (
    <img
      src={url}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      className="w-[18px] h-[18px] object-contain flex-shrink-0"
      onError={() => (url.endsWith('.png') && url.includes('football-data.org') ? setUrl(url.replace(/\.png$/, '.svg')) : setFailed(true))}
    />
  )
}


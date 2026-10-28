import { useEffect, useState } from 'react'
import { useEntityId } from '../../components/SlugRoute'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { tennisTournamentFav, tennisHref, tierLabel, surfaceName, isoOfCountry, countryName, type TMatch } from '../../lib/tennis'
import { Skeleton } from '../bb/parts'
import LeaguePage, { LCard as Card } from '../../components/sport/page/LeaguePage'
import GameRow from '../../components/sport/GameRow'
import { useNews, NewsRows } from '../../components/NewsList'
import { tennisSGame } from '../../components/sport/games/tennis'
import { DrawTab, type DrawRound } from './parts'

interface Data {
  key: string; name: string; tour: string; tier: string | null; level: string; women: boolean; surface: string | null; indoor: boolean | null
  city: string | null; country: string | null; start: string | null; end: string | null
  draw: DrawRound[]
  champions: { year: number; winner: { id: number | null; name: string }; runnerUp: string; score: string }[]
  record: { n: number; right: number; pct: number | null }
}

const flagEmoji = (iso: string | null) => (iso && /^[a-z]{2}$/i.test(iso) ? String.fromCodePoint(...iso.toUpperCase().split('').map(c => 0x1f1a5 + c.charCodeAt(0))) : '')
const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })

/**
 * Tennis tournament page (fix193b): football's league page — the header (tier, surface, indoor, city, dates, our
 * record in it), the draw and past champions on the left; live matches, next matches, latest results and news on the
 * right.
 */
export default function TennisTournament() {
  const key = useEntityId()
  const [d, setD] = useState<Data | null | undefined>(undefined)
  const news = useNews({ sport: 'tennis', limit: 8 })
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/tennis/tournament/${key}`).then(r => {
      setD(r.data.data)
      document.title = t('{0} · SportLikely', { 0: r.data.data.name })
    }).catch(() => setD(null))
  }, [key])
  if (d === undefined) return <div className="max-w-6xl mx-auto px-4 py-10"><Skeleton rows={6} /></div>
  if (!d) return <div className="max-w-6xl mx-auto px-4 py-10 text-muted">{t('Tournament not found.')}</div>
  const all: TMatch[] = d.draw.flatMap(r => r.matches)
  const first = all[0]
  const live = all.filter(m => m.state === 'live')
  const next = all.filter(m => m.state === 'upcoming').sort((a, b) => a.start.localeCompare(b.start)).slice(0, 12)
  const results = all.filter(m => m.state === 'done').sort((a, b) => b.start.localeCompare(a.start)).slice(0, 16)
  const rows = (list: TMatch[]) => <div className="divide-y divide-line/50">{list.map(m => <GameRow key={m.id} g={tennisSGame(m)} showDay />)}</div>
  const iso = isoOfCountry(d.country)
  const dates = d.start ? (d.end && d.end.slice(0, 10) !== d.start.slice(0, 10) ? `${day(d.start)} – ${day(d.end)}` : day(d.start)) : null
  return (
    <LeaguePage
      logo={null}
      // fix195: the place from the catalogue, else the city (Cali → Colombia); never "World"
      country={{ name: `${flagEmoji(iso)} ${[d.city, d.country ? countryName(d.country) : null].filter(Boolean).join(', ')}`.trim() }}
      name={d.name}
      sub={[first ? tierLabel(first) : null, surfaceName(d.surface, d.indoor) || null, dates].filter(Boolean).join(' · ')}
      fav={tennisTournamentFav(d)}
      // fix229: the weekly hub is this page (/tennis/league/<key>; the old /tennis/predictions/<key> moves here)
      hub={null}
      record={d.record.n > 0 && d.record.pct !== null ? { hitRate: d.record.pct, n: d.record.n } : null}
      left={<>
        <DrawTab m={null} rounds={d.draw} />
        <Card title={t('Past champions')}>
          {!d.champions.length ? <p className="text-sm text-faint">{t('No finals in our data yet.')}</p> : (
            <ul className="divide-y divide-line/50">
              {d.champions.map(c => (
                <li key={c.year} className="flex items-center gap-3 py-1.5 text-sm min-w-0">
                  <span className="w-10 num text-faint shrink-0">{c.year}</span>
                  {c.winner.id ? <Link to={tennisHref.player(c.winner.id, c.winner.name)!} className="min-w-0 truncate font-semibold text-ink hover:text-accent">{c.winner.name}</Link> : <span className="min-w-0 truncate font-semibold text-ink">{c.winner.name}</span>}
                  <span className="hidden sm:inline min-w-0 truncate text-xs text-faint">{t('beat {0}', { 0: c.runnerUp })}</span>
                  <span className="ms-auto num text-xs text-muted shrink-0">{c.score}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>}
      right={<>
        {live.length > 0 && <Card title={t('Live now')}>{rows(live)}</Card>}
        <Card title={t('Next matches')} action={<Link to="/tennis/matches" className="text-xs font-bold text-accent">{t('All →')}</Link>}>
          {next.length ? <div className="max-h-[430px] overflow-y-auto overscroll-contain">{rows(next)}</div> : <p className="text-sm text-faint">{t('No matches scheduled here right now.')}</p>}
        </Card>
        <Card title={t('Latest results')}>
          {results.length ? <div className="max-h-[430px] overflow-y-auto overscroll-contain">{rows(results)}</div> : <p className="text-sm text-faint">{t('No results yet.')}</p>}
        </Card>
        {(news === null || news === undefined || news.length > 0) && (
          <Card title={t('Tennis news')}>
            {news === null ? <Skeleton rows={3} h="h-14" /> : news && news.length ? <div className="-mx-2 max-h-[520px] overflow-y-auto overscroll-contain"><NewsRows items={news} /></div> : null}
          </Card>
        )}
      </>}
    />
  )
}

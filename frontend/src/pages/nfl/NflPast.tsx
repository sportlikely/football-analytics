import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { Card, Skeleton } from '../bb/parts'
import NflCalibration, { type AfCalibReport } from './NflCalibration'

interface M { games: number; hit: number; logLoss: number; brier: number }
interface Season { season: number; ab: M; blend: M | null; eloOnly: M; homeTeamHit: number; fbsOnly?: M; fbsFcs?: M }
/** fix146: the nfl-v2 experiments (walk-forward, NFL only) */
interface ExpV { id: string; name: string; total: M; perSeason: { season: number; games: number; hit: number; logLoss: number }[]; weeks1to4: M; rest: M }
interface Exp { builtAt: string; testSeasons: number[]; variants: ExpV[]; best: string; adopted: boolean; reason: string }
interface Report { model: string; builtAt: string; seasons: Season[]; total: { ab: M; blend: M; eloOnly: M }; baselines: { homeTeam: { hit: number; logLoss: number }; betterRecord: { hit: number } }; fbs?: M; fbsFcs?: M; levels?: Record<string, number>; blend?: { used: boolean } }

/**
 * Admin only (fix144, like basketball's Past seasons): how nfl-v1 and ncaa-v1 did on seasons they never saw — each of
 * the last 5 seasons tuned on the seasons before it. Internal, English only. Rebuild from /api/admin/nfl-model?rebuild=1.
 */
export default function NflPast() {
  const [d, setD] = useState<{ nfl: Report | null; college: Report | null; experiments?: Exp | null; calibration?: AfCalibReport | null } | null>(null)
  useEffect(() => { axios.get(`${API_URL}/nfl-past`).then(r => setD(r.data.data)).catch(() => setD({ nfl: null, college: null })) }, [])
  const row = (label: string, m: M | null | undefined, home?: number) => (
    <tr key={label} className="border-t border-line/50">
      <td className="py-1.5 text-ink">{label}</td>
      <td className="text-right num">{m?.games ?? '–'}</td>
      <td className="text-right num font-bold text-ink">{m ? `${m.hit}%` : '–'}</td>
      <td className="text-right num text-muted">{m?.logLoss ?? '–'}</td>
      <td className="text-right num text-muted">{m?.brier ?? '–'}</td>
      <td className="text-right num text-muted">{home !== undefined ? `${home}%` : ''}</td>
    </tr>
  )
  const block = (name: string, r: Report | null) => (
    <Card key={name} title={r ? `${name} · ${r.model}` : name}>
      {!r ? <p className="text-sm text-muted">No report yet: it is built on the server after the season backfill (Admin → NFL data), or open /api/admin/nfl-model{name === 'College football' ? '?league=2&' : '?'}rebuild=1.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead><tr className="text-faint text-[11px]"><th className="text-left font-semibold">Season (test)</th><th className="text-right font-semibold">Games</th><th className="text-right font-semibold">Hit</th><th className="text-right font-semibold">Log loss</th><th className="text-right font-semibold">Brier</th><th className="text-right font-semibold">Home team</th></tr></thead>
            <tbody>
              {r.seasons.map(s => row(String(s.season), s.blend || s.ab, s.homeTeamHit))}
              {r.seasons.some(s => s.fbsOnly) && r.seasons.map(s => s.fbsOnly ? row(`${s.season} FBS vs FBS`, s.fbsOnly) : null)}
              {r.seasons.some(s => s.fbsFcs) && r.seasons.map(s => s.fbsFcs ? row(`${s.season} FBS vs FCS`, s.fbsFcs) : null)}
              {row('All test seasons', r.blend?.used ? r.total.blend : r.total.ab, r.baselines.homeTeam.hit)}
              {row('Elo only', r.total.eloOnly)}
              {r.fbs && row('FBS vs FBS, all', r.fbs)}
              {r.fbsFcs && row('FBS vs FCS, all', r.fbsFcs)}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-faint">Baselines: home team {r.baselines.homeTeam.hit}% (LL {r.baselines.homeTeam.logLoss}), better record {r.baselines.betterRecord.hit}%. Efficiency blend {r.blend?.used ? 'kept' : 'not kept'}.{r.levels ? ` Teams: ${Object.entries(r.levels).map(([k, n]) => `${k} ${n}`).join(', ')}.` : ''} Built {new Date(r.builtAt).toLocaleString()}.</p>
        </div>
      )}
    </Card>
  )
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6 pb-28 xl:pb-10">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-ink">American football · past seasons (admin)</h1>
        <p className="mt-1 text-sm text-muted">Walk-forward: each test season is predicted with settings tuned only on the seasons before it. Picks saved before kick-off count in the public record from launch day on; these seasons never do.</p>
      </div>
      {!d ? <Skeleton rows={4} h="h-32" /> : <>{block('NFL', d.nfl)}{d.experiments && <Card title={`nfl-v2 experiments · test seasons ${d.experiments.testSeasons.join(', ')}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead><tr className="text-faint text-[11px]"><th className="text-left font-semibold">Variant</th><th className="text-right font-semibold">Games</th><th className="text-right font-semibold">Hit</th><th className="text-right font-semibold">Log loss</th><th className="text-right font-semibold">Weeks 1–4 LL</th><th className="text-right font-semibold">Rest LL</th></tr></thead>
            <tbody>{d.experiments.variants.map(v => (
              <tr key={v.id} className={`border-t border-line/50 ${v.id === d.experiments!.best ? 'text-accent' : ''}`}>
                <td className="py-1.5">{v.id} · {v.name}</td><td className="text-right num">{v.total.games}</td><td className="text-right num font-bold">{v.total.hit}%</td>
                <td className="text-right num">{v.total.logLoss}</td><td className="text-right num text-muted">{v.weeks1to4.logLoss ?? '–'}</td><td className="text-right num text-muted">{v.rest.logLoss ?? '–'}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="mt-2 text-[11px] text-faint">Best {d.experiments.best}: {d.experiments.adopted ? 'adopted as nfl-v2' : 'nfl-v1 kept'} ({d.experiments.reason}). Built {new Date(d.experiments.builtAt).toLocaleString()}. Per season and calibration: /api/admin/nfl-model.</p>
        </div>
      </Card>}{block('College football', d.college)}<NflCalibration r={d.calibration} /></>}
    </div>
  )
}

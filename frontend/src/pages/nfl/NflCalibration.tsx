import { Card } from '../bb/parts'

/** fix220 — the calibration layer and the ncaa-v2 test (admin only, English, from /api/nfl-past → calibration). */
interface S { games: number; logLoss: number | null; brier: number | null; hit: number | null }
interface Band { lo: number; hi: number; n: number; said: number | null; happened: number | null; gap: number | null }
interface Platt { a: number; b: number; n: number }
interface WfSeason { season: number; raw: S; cal: S; rawBands: Band[]; calBands: Band[]; fitOn: number[] }
interface Layer {
  source: string; mode: 'segments' | 'league' | 'none'; why: string; strong: number; strongDefault: number; calib: { global: Platt; segs: Record<string, Platt>; seasons: number[] } | null
  walkForward: { seasons: WfSeason[]; total: { raw: S; cal: S; rawBands: Band[]; calBands: Band[] } }
  saved: { games: number; raw: S; cal: S; rawBands: Band[]; calBands: Band[]; bySeg: Record<string, { raw: S; cal: S }> | null }
  nflV2Check?: { adopted: boolean; best: string; e1: any; bestRow: any; calibrated2026: WfSeason | null } | null
}
interface Cmp { v1: S; v2: S }
interface Cell { all: S; fbs: S }
interface LabRow { id: string; label: string; seasons: Record<string, Cell>; total: Cell; s2026: Cell | null; bands: Band[]; bandsFbs: Band[]; vsMarket: { games: number; ll: number | null; market: number | null } | null }
interface LabReport {
  version: string; at: string; seconds: number; live: string; table: LabRow[]; winner: string | null; promoted: boolean; model: string; reason: string
  fitOn: Record<string, number[]>; trainFrom: number
  market: { closingLines: number; bySeason: Record<string, number>; note: string; anchor: { games: number; scored: number; model: S; market: S; anchor: S; better: boolean } }
  roster: { teamSeasons: number; withRet: number; withTalent: number }
}
interface Refit2026 { at: string; model: string; why: string; scores: Record<string, Record<string, S>>; bandsFbs: Record<string, Band[]>; refit: { mode: string; games: number; seasons: number[] } }
export interface AfCalibReport {
  version: string; at: string; seconds: number; nfl: Layer; college: Layer; lab?: LabReport | null; college2026?: Refit2026 | null
  ncaaV2: { pass: boolean; reason: string; trainSeasons: number[]; testSeason: number; test2025: { whole: Cmp; conf: Cmp }; season2026: { season: number; whole: Cmp; conf: Cmp } | null; perSeason: ({ season: number; conf: Cmp } & Cmp)[] }
}

const th = 'text-end font-semibold'
const sc = (s: S | null | undefined) => (s && s.games ? `${s.hit ?? '–'}% · ${s.logLoss ?? '–'} · ${s.brier ?? '–'}` : '–')
const bands = (b: Band[]) => b.filter(x => x.n).map(x => `${x.lo}–${x.hi}%: ${x.said} → ${x.happened} (${x.n})`).join(' · ') || '–'

function LayerCard({ name, l }: { name: string; l: Layer }) {
  const segs = l.calib ? Object.entries(l.calib.segs) : []
  return (
    <Card title={`Calibration · ${name}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Season (test)</th><th className={th}>Games</th><th className={th}>Raw: hit · LL · Brier</th><th className={th}>Calibrated</th><th className={th}>Fitted on</th></tr></thead>
          <tbody>
            {l.walkForward.seasons.map(s => (
              <tr key={s.season} className="border-t border-line/50">
                <td className="py-1.5 text-ink">{s.season}</td><td className="text-end num">{s.raw.games}</td>
                <td className="text-end num text-muted">{sc(s.raw)}</td><td className="text-end num font-bold text-ink">{sc(s.cal)}</td>
                <td className="text-end num text-faint">{s.fitOn.length ? `${s.fitOn[0]}–${s.fitOn[s.fitOn.length - 1]}` : 'none'}</td>
              </tr>
            ))}
            <tr className="border-t border-line/50"><td className="py-1.5 text-ink">All test seasons</td><td className="text-end num">{l.walkForward.total.raw.games}</td><td className="text-end num text-muted">{sc(l.walkForward.total.raw)}</td><td className="text-end num font-bold text-ink">{sc(l.walkForward.total.cal)}</td><td /></tr>
            <tr className="border-t border-line/50"><td className="py-1.5 text-ink">This season, saved before kick-off</td><td className="text-end num">{l.saved.games}</td><td className="text-end num text-muted">{sc(l.saved.raw)}</td><td className="text-end num font-bold text-ink">{sc(l.saved.cal)}</td><td /></tr>
            {l.saved.bySeg && Object.entries(l.saved.bySeg).map(([k, v]) => (
              <tr key={k} className="border-t border-line/50"><td className="py-1.5 text-muted">· {k === 'mismatch' ? 'FBS vs FCS' : k === 'conf' ? 'conference games' : 'other games'}</td><td className="text-end num">{v.raw.games}</td><td className="text-end num text-muted">{sc(v.raw)}</td><td className="text-end num text-ink">{sc(v.cal)}</td><td /></tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-faint">Said → happened, all test seasons raw: {bands(l.walkForward.total.rawBands)}</p>
        <p className="text-[11px] text-faint">Calibrated: {bands(l.walkForward.total.calBands)}</p>
        <p className="text-[11px] text-faint">This season saved: raw {bands(l.saved.rawBands)} · with the layer {bands(l.saved.calBands)}</p>
        <p className="mt-1 text-[11px] text-faint">Layer kept? {l.why}.</p>
        <p className="text-[11px] text-faint">
          Source: {l.source}. Layer {l.calib ? `a ${l.calib.global.a.toFixed(3)}, b ${l.calib.global.b.toFixed(3)} on ${l.calib.global.n} games (${l.calib.seasons.join(', ')})${segs.length ? ` · ${segs.map(([k, p]) => `${k} a ${p.a.toFixed(2)} b ${p.b.toFixed(2)} (${p.n})`).join(' · ')}` : ''}` : 'not fitted (under 100 games): chances as the model gives them'}.
          {' '}Strong line {Math.round(l.strong * 100)}% (was {Math.round(l.strongDefault * 100)}%).
        </p>
        {l.nflV2Check && (
          <p className="text-[11px] text-faint">nfl-v2 on this season (experiments, raw): E1 nfl-v1 {l.nflV2Check.e1 ? `${l.nflV2Check.e1.hit}% · LL ${l.nflV2Check.e1.logLoss} (${l.nflV2Check.e1.games})` : '–'} · {l.nflV2Check.best} {l.nflV2Check.bestRow ? `${l.nflV2Check.bestRow.hit}% · LL ${l.nflV2Check.bestRow.logLoss}` : '–'} ({l.nflV2Check.adopted ? 'adopted' : 'not adopted'}); live model calibrated: {sc(l.nflV2Check.calibrated2026?.cal)}</p>
        )}
      </div>
    </Card>
  )
}

const ll = (s: S | null | undefined) => (s && s.games ? `${s.logLoss ?? '–'} · ${s.hit ?? '–'}%` : '–')

/** fix292 — the college lab: every candidate walk-forward, the winner and why (admin only, English). */
function LabCard({ l }: { l: LabReport }) {
  const seasons = ['2023', '2024', '2025', '2026']
  const a = l.market.anchor
  return (
    <Card title={`College lab · ${l.promoted ? `${l.winner} promoted (${l.model})` : `${l.live} stays`}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead><tr className="text-faint text-[11px]">
            <th className="text-start font-semibold">Candidate</th>
            {seasons.map(s => <th key={s} className={th}>{s === '2026' ? '2026 so far' : s}: LL · hit</th>)}
            <th className={th}>2023–25 all</th><th className={th}>2023–25 FBS vs FBS</th><th className={th}>vs closing line (LL / line)</th>
          </tr></thead>
          <tbody>
            {l.table.map(r => (
              <tr key={r.id} className="border-t border-line/50">
                <td className={`py-1.5 ${r.id === l.winner ? 'font-bold text-ink' : 'text-ink'}`} title={r.label}>{r.id}{r.id === l.live ? ' (live)' : ''}</td>
                {seasons.map(s => <td key={s} className="text-end num text-muted">{ll(r.seasons[s]?.all)}</td>)}
                <td className="text-end num font-bold text-ink">{ll(r.total.all)}</td>
                <td className="text-end num text-ink">{ll(r.total.fbs)}</td>
                <td className="text-end num text-faint">{r.vsMarket && r.vsMarket.games ? `${r.vsMarket.ll} / ${r.vsMarket.market} (${r.vsMarket.games})` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-faint">{l.reason}.</p>
        {l.table.filter(r => r.id === l.winner || r.id === l.live).map(r => (
          <p key={r.id} className="text-[11px] text-faint">{r.id} said → happened 2023–25: {bands(r.bands)} · FBS: {bands(r.bandsFbs)}</p>
        ))}
        <p className="text-[11px] text-faint">
          Market: {l.market.closingLines} closing lines ({Object.entries(l.market.bySeason).map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'}). Anchor (live model + closing line, by week): {a.scored} games, model {sc(a.model)}, line {sc(a.market)}, anchor {sc(a.anchor)}{a.better ? ' — better than both' : ''}. {l.market.note}.
        </p>
        <p className="text-[11px] text-faint">
          Elo tuned on {Object.entries(l.fitOn).map(([s, on]) => `${s}: ${on[0]}–${on[on.length - 1]}`).join(' · ')}; combiners from {l.trainFrom} to the season before; never on 2026. Rosters: {l.roster.withRet} team-seasons with returning production, {l.roster.withTalent} with talent. Built {new Date(l.at).toLocaleString('en-GB')} in {l.seconds} s ({l.version}).
        </p>
      </div>
    </Card>
  )
}

/** fix292 — the college layer refit on 2025 + 2026, out of fold. */
function RefitCard({ r }: { r: Refit2026 }) {
  const rows: [string, string][] = [['raw', 'No layer'], ['current', 'fix220 layer (2021–25)'], ['shared', 'Refit · one college layer'], ['split', 'Refit · separate FBS layer']]
  const groups: [string, string][] = [['fbs', 'FBS vs FBS'], ['mismatch', 'FBS vs FCS'], ['fcs', 'FCS'], ['all2026', '2026 all'], ['all', 'All']]
  return (
    <Card title={`College layer refit 2025 + 2026 · ${r.refit.mode === 'kept' ? 'fix220 layer kept' : r.refit.mode === 'fbs' ? 'separate FBS layer live' : 'shared college layer live'}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Out of fold</th>{groups.map(([k, l]) => <th key={k} className={th}>{l}: LL · hit</th>)}</tr></thead>
          <tbody>
            {rows.map(([k, label]) => (
              <tr key={k} className="border-t border-line/50"><td className="py-1.5 text-ink">{label}</td>{groups.map(([g]) => <td key={g} className="text-end num text-muted">{ll(r.scores[k]?.[g])}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {rows.map(([k, label]) => <p key={k} className="text-[11px] text-faint">{label}, FBS said → happened: {bands(r.bandsFbs[k] || [])}</p>)}
        <p className="mt-1 text-[11px] text-faint">{r.why}. Source {r.model}, {r.refit.games} games ({r.refit.seasons.join(', ')}), {new Date(r.at).toLocaleString('en-GB')}.</p>
      </div>
    </Card>
  )
}

export default function NflCalibration({ r }: { r: AfCalibReport | null | undefined }) {
  if (!r) return <Card title="Calibration + ncaa-v2 (fix220)"><p className="text-sm text-muted">Not built yet: it runs on the server after the walk-forward reports (or /api/admin/nfl-model?calib=1).</p></Card>
  const v = r.ncaaV2
  const cmpRow = (label: string, c: Cmp | undefined) => (
    <tr key={label} className="border-t border-line/50">
      <td className="py-1.5 text-ink">{label}</td><td className="text-end num">{c?.v1.games ?? '–'}</td>
      <td className="text-end num text-muted">{sc(c?.v1)}</td><td className="text-end num font-bold text-ink">{sc(c?.v2)}</td>
    </tr>
  )
  return (
    <>
      <Card title={`ncaa-v2 test · ${v.pass ? 'live' : 'ncaa-v1 kept'}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Games</th><th className={th}>n</th><th className={th}>ncaa-v1: hit · LL · Brier</th><th className={th}>ncaa-v2</th></tr></thead>
            <tbody>
              {cmpRow(`${v.testSeason} whole season (test)`, v.test2025.whole)}
              {cmpRow(`${v.testSeason} conference games (gate)`, v.test2025.conf)}
              {v.season2026 && cmpRow(`${v.season2026.season} so far (never tuned)`, v.season2026.whole)}
              {v.season2026 && cmpRow(`${v.season2026.season} conference games`, v.season2026.conf)}
              {v.perSeason.map(s => cmpRow(`${s.season} walk-forward`, s))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-faint">Gate: {v.reason}. Weights tuned on {v.trainSeasons.join(', ')} for the {v.testSeason} test (each walk-forward season on the seasons before it; live weights on 2021–2025). Built {new Date(r.at).toLocaleString('en-GB')} in {r.seconds} s ({r.version}).</p>
        </div>
      </Card>
      <LayerCard name="NFL" l={r.nfl} />
      <LayerCard name="College football" l={r.college} />
      {r.college2026 && <RefitCard r={r.college2026} />}
      {r.lab && <LabCard l={r.lab} />}
    </>
  )
}

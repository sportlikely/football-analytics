/**
 * Daily self-learning for the football league model (Oct 2026) — champion / challenger, and the 07:00 morning report.
 *
 * 04:00 UTC (after the night's results are settled), once a day:
 *  1. Rebuild the feature-model state and refit the feature model on every settled game (stored, not yet live).
 *  2. Challengers: (a) a fresher feature-model fit, (b) v3 row weights refitted with the v3 tuner on the two previous
 *     seasons + this season, (c) the mix weight at 0.4 / 0.5 / 0.6 (the ones not in use).
 *  3. Score the champion and every challenger on the last 60 days of settled league games, out of sample: every fit
 *     used for scoring was trained only on games before the window (walk-forward). Metric: log loss, tie-break Brier;
 *     the hit rate must not drop by more than 0.5 pp.
 *  4. Promote one challenger only if: ≥ 300 games in the window, log loss better by ≥ 0.003, and better or equal in
 *     the previous 60-day window too. Otherwise keep the champion.
 *  5. Guardrail: once the champion has played ≥ 100 games since it was promoted, if it is worse than the previous
 *     champion on those games by > 0.005, roll back automatically and flag it in the report.
 *  6. Everything goes to `model_daily` (admin: /api/admin/model-daily, card on the Admin page).
 * Challenger (a) is scored as a procedure: a fit trained up to the window start vs a fit as stale as the live one
 * (trained that many days earlier) — the live fit itself was trained on recent games and can't be scored honestly.
 * v3-mix publishing (mix_mode 'auto'): switched on the first day v3-mix beats v3 alone in both 60-day windows
 * (≥ 300 games each), off again if it falls behind v3 by > 0.005.
 * Never touches national-team (elo-intl), European-cup (elo-euro) or basketball models.
 *
 * 07:00 Asia/Jerusalem (DST-aware, checked every 5 minutes): plain-text report to ADMIN_EMAILS, also stored in the row.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { GROUPS, seasonCodes } from './history';
import { applyStoredTuning } from './gridModel';
import { v3WindowRun, liveVector, applyVector, isTuning } from './v3Tuner';
import { clearPredictionCache } from './predCache';
import { sendEmail, emailEnabled, SITE, esc } from './email';
import { lastDataHealth } from './dataHealth';
import { nbaV4ReportLines } from './nbaV4';
import { gridReportLines, autoTuneLine, leagueTuneLine, missFitLine } from './bbTuner';
import { timed, slicer, yieldLoop, heavy } from './perf';
import {
  buildFeatures, buildFeaturesAsync, fitFeatureModel, predictWith, storeFeatureModel, activateFeatureModel, activeFeatureModel, loadFeatureModel,
  fixtureByNames, getConfig, setConfig, mixWeight, mixMode, mixLive, setMixLive, scoreProbs, FEAT_MODEL, MIX_MODEL,
  dropFeatureState, FittedModel, FeatState
} from './featureModel';

const DAY = 24 * 3600 * 1000;
const TZ = 'Asia/Jerusalem';
export const DAILY_RULES = { windowDays: 60, minGames: 300, minGain: 0.003, maxHitDrop: 0.5, guardGames: 100, guardWorse: 0.005, mixOffWorse: 0.005 };

db.exec(`
  CREATE TABLE IF NOT EXISTS model_daily (
    date TEXT PRIMARY KEY,          -- Asia/Jerusalem date
    ran_at TEXT,
    champion TEXT,                  -- JSON: the setting in use after today's decision
    challengers TEXT,               -- JSON: every candidate with its scores
    decision TEXT,                  -- 'keep' | 'promote' | 'rollback' | 'error' | 'skipped'
    reason TEXT,
    rollback INTEGER NOT NULL DEFAULT 0,
    report TEXT,
    report_sent_at TEXT,
    ms INTEGER
  );
`);

type P3 = [number, number, number];
interface Champion {
  mixWeight: number; featModelId: number | null; featCutoff: string | null; v3Vector: number[]; since: string;
  label: string; prev?: Omit<Champion, 'prev'> | null;
}

/* ---------- dates ---------- */

function localParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const nice = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ---------- champion ---------- */

function champion(): Champion {
  try { const c = JSON.parse(getConfig('champion', '')); if (c && Array.isArray(c.v3Vector)) return c; } catch { /* first run */ }
  const act = activeFeatureModel();
  return { mixWeight: mixWeight(), featModelId: act?.id ?? null, featCutoff: act?.cutoff ?? null, v3Vector: liveVector(), since: new Date().toISOString().slice(0, 10), label: 'initial' };
}
const saveChampion = (c: Champion) => setConfig('champion', JSON.stringify(c));
const describe = (c: Champion) => `v3-mix, feature weight ${c.mixWeight}, feature fit to ${c.featCutoff || '—'}, champion since ${c.since}`;

/* ---------- scoring ---------- */

const mixP = (w: number, v: P3, f: P3): P3 => [0, 1, 2].map(i => (1 - w) * v[i] + w * f[i]) as P3;
interface Game { fid: number; date: string; y: number; mkt: P3 | null; v3: P3; v3fit: P3 | null; fChamp: P3; fFresh: P3 | null; fPrev: P3 | null; v3Prev: P3 | null }
interface Cand { id: string; label: string; kind: 'champion' | 'feature' | 'v3' | 'mix'; probs: (g: Game) => P3 | null; apply?: () => Promise<string> }

function scoreSet(games: Game[], f: (g: Game) => P3 | null) {
  const rows = games.map(g => ({ p: f(g), y: g.y })).filter(r => r.p) as { p: P3; y: number }[];
  return scoreProbs(rows);
}

let running = false;
export const dailyRunning = () => running;

/** The 04:00 job. `force` runs again even if today's row exists (admin). */
export async function runModelDaily(force = false): Promise<any> {
  const today = localParts().date;
  const existing: any = db.prepare(`SELECT date, ran_at FROM model_daily WHERE date = ?`).get(today);
  if (existing?.ran_at && !force) return { skipped: 'already ran today' };
  if (running) return { skipped: 'running' };
  if (isTuning()) return { skipped: 'a v3 tune is running' };
  running = true;
  const t0 = Date.now();
  const save = (o: { champion: Champion; challengers: any; decision: string; reason: string; rollback?: boolean }) => {
    db.prepare(`INSERT INTO model_daily (date, ran_at, champion, challengers, decision, reason, rollback, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET ran_at = excluded.ran_at, champion = excluded.champion, challengers = excluded.challengers,
      decision = excluded.decision, reason = excluded.reason, rollback = excluded.rollback, ms = excluded.ms`)
      .run(today, new Date().toISOString(), JSON.stringify(o.champion), JSON.stringify(o.challengers), o.decision, o.reason, o.rollback ? 1 : 0, Date.now() - t0);
  };
  // the live v3 weights are the truth (an admin may have re-tuned v3 since the last run)
  let champ: Champion = { ...champion(), v3Vector: liveVector(), mixWeight: mixWeight() };
  try {
    const R = DAILY_RULES;
    const now = Date.now();
    const W = { from: iso(now - R.windowDays * DAY), to: iso(now + DAY) };
    const Wp = { from: iso(now - 2 * R.windowDays * DAY), to: W.from };
    const todayIso = iso(now);

    // 1. state + the routine refit on every settled game (stored, not live)
    dropFeatureState();
    const st: FeatState = await buildFeaturesAsync(); // fix167: in slices
    const refit = await fitFeatureModel(st, todayIso);
    const refitId = refit ? storeFeatureModel(refit.model, todayIso, refit.n, null, false) : null;

    // feature fits for scoring (walk-forward: trained before each window)
    const champModel = champ.featModelId ? loadFeatureModel(champ.featModelId) : activeFeatureModel()?.model || null;
    const stale = champ.featCutoff ? Math.max(0, Math.round((now - Date.parse(champ.featCutoff)) / DAY)) : 0;
    const fitAt = async (cut: string) => (await fitFeatureModel(st, cut))?.model || null;
    const freshW = await fitAt(W.from), freshWp = await fitAt(Wp.from);
    const staleW = stale >= 7 ? await fitAt(iso(Date.parse(W.from) - stale * DAY)) : freshW;
    const staleWp = stale >= 7 ? await fitAt(iso(Date.parse(Wp.from) - stale * DAY)) : freshWp;
    if (!freshW || !freshWp || !staleW || !staleWp) throw new Error('too few games to fit the feature model for the windows');

    // 2b. v3 window run: live (champion) weights, refits before each window and on everything (for promotion)
    const prev = champ.prev || null;
    const run = await v3WindowRun({
      seasons: seasonCodes(3), scoreFrom: Wp.from,
      fits: [{ label: 'W', trainBefore: W.from }, { label: 'Wp', trainBefore: Wp.from }, { label: 'all', trainBefore: iso(now + DAY) }],
      vectors: { champion: champ.v3Vector, ...(prev ? { previous: prev.v3Vector } : {}) }
    });
    const divGroup = new Map<string, string>();
    for (const [g, cfg] of Object.entries(GROUPS)) for (const d of cfg.divisions) divGroup.set(d, g);
    const rowsByFid = new Map(st.rows.map(r => [r.fid, r]));
    const prevModel = prev?.featModelId ? loadFeatureModel(prev.featModelId) : null;
    const games: { W: Game[]; Wp: Game[] } = { W: [], Wp: [] };
    const slice = slicer(); // fix169: the job yields every 30 ms (it froze the server 0.5 s unlabelled)
    for (let i = 0; i < run.items.length; i++) {
      await slice();
      const it = run.items[i];
      const grp = divGroup.get(it.div);
      if (!grp) continue;
      const fx = fixtureByNames(st, grp, it.home, it.away, it.date);
      const row = fx ? rowsByFid.get(fx.fid) : null;
      if (!fx || !row || !row.ok) continue;
      const inW = it.date >= W.from;
      const fm = (m: FittedModel | null) => (m ? predictWith(m, row.x) : null);
      const v3 = (run.vectors.champion?.[i] || run.live[i]) as P3;
      const g: Game = {
        fid: fx.fid, date: it.date, y: it.o === 'H' ? 0 : it.o === 'D' ? 1 : 2, mkt: it.mkt, v3,
        v3fit: (run.fits[inW ? 'W' : 'Wp']?.probs[i] as P3) || null,
        fChamp: fm(inW ? staleW : staleWp)!, fFresh: stale >= 7 ? fm(inW ? freshW : freshWp) : null,
        fPrev: fm(prevModel), v3Prev: (run.vectors.previous?.[i] as P3) || null
      };
      (inW ? games.W : games.Wp).push(g);
    }

    // 3. candidates
    const w0 = champ.mixWeight;
    const cands: Cand[] = [{ id: 'champion', label: `champion (${describe(champ)})`, kind: 'champion', probs: g => mixP(w0, g.v3, g.fChamp) }];
    if (stale >= 7 && refit && refitId) cands.push({
      id: 'feature-refit', label: `feature model refit (live fit is ${stale} days old)`, kind: 'feature', probs: g => (g.fFresh ? mixP(w0, g.v3, g.fFresh) : null),
      apply: async () => { activateFeatureModel(refitId); champ = { ...champ, featModelId: refitId, featCutoff: todayIso }; return `feature model refit (fit ${todayIso}, ${refit.n} games)`; }
    });
    if (run.fits.W && run.fits.Wp && run.fits.all) cands.push({
      id: 'v3-weights', label: 'v3 row weights refitted (v3 tuner, 2 seasons + this season)', kind: 'v3', probs: g => (g.v3fit ? mixP(w0, g.v3fit, g.fChamp) : null),
      apply: async () => {
        const x = run.fits.all.x;
        applyVector(x, { source: 'model-daily', date: today, train: run.fits.all.train });
        applyStoredTuning();
        champ = { ...champ, v3Vector: x };
        return `v3 row weights refitted on ${run.fits.all.train} games`;
      }
    });
    for (const w of [0.4, 0.5, 0.6]) if (Math.abs(w - w0) > 1e-9) cands.push({
      id: `mix-${w}`, label: `mix weight ${w}`, kind: 'mix', probs: g => mixP(w, g.v3, g.fChamp),
      apply: async () => { setConfig('mix_weight', String(w)); champ = { ...champ, mixWeight: w }; return `mix weight ${w0} → ${w}`; }
    });

    const scored: { c: Cand; W: ReturnType<typeof scoreSet>; Wp: ReturnType<typeof scoreSet> }[] = [];
    for (const c of cands) { await yieldLoop(); scored.push({ c, W: scoreSet(games.W, c.probs), Wp: scoreSet(games.Wp, c.probs) }); }
    await yieldLoop();
    const base = scored[0];
    const reference = {
      v3: { W: scoreSet(games.W, g => g.v3), Wp: scoreSet(games.Wp, g => g.v3) },
      feature: { W: scoreSet(games.W, g => g.fChamp), Wp: scoreSet(games.Wp, g => g.fChamp) },
      market: { W: scoreSet(games.W.filter(g => g.mkt), g => g.mkt), Wp: scoreSet(games.Wp.filter(g => g.mkt), g => g.mkt) },
      championOnOddsGames: scoreSet(games.W.filter(g => g.mkt), base.c.probs)
    };
    const verdict = (s: typeof scored[number]) => {
      if (s.c.id === 'champion') return { pass: false, why: 'champion' };
      if (s.W.n < R.minGames) return { pass: false, why: `${s.W.n} games (< ${R.minGames})` };
      const d = s.W.logLoss - base.W.logLoss;
      if (d > -R.minGain) return { pass: false, why: `log loss ${d >= 0 ? '+' : ''}${d.toFixed(4)} (needs −${R.minGain})` };
      if (s.Wp.n && s.Wp.logLoss > base.Wp.logLoss) return { pass: false, why: `worse in the previous 60 days (${s.Wp.logLoss} vs ${base.Wp.logLoss})` };
      if (s.W.hitRate < base.W.hitRate - R.maxHitDrop) return { pass: false, why: `hit rate ${s.W.hitRate}% vs ${base.W.hitRate}%` };
      return { pass: true, why: `log loss ${d.toFixed(4)}, previous window ${(s.Wp.logLoss - base.Wp.logLoss).toFixed(4)}` };
    };
    const table = scored.map(s => ({ id: s.c.id, label: s.c.label, kind: s.c.kind, W: s.W, Wp: s.Wp, dW: Math.round((s.W.logLoss - base.W.logLoss) * 10000) / 10000, ...verdict(s) }));
    const challengers = { windows: { W, Wp }, games: { W: games.W.length, Wp: games.Wp.length }, reference, candidates: table, refitId, stale };

    // 5. guardrail first: a champion that is doing worse than the one it replaced goes back
    if (prev) {
      const since = champ.since;
      const after = [...games.Wp, ...games.W].filter(g => g.date >= since && g.fPrev && g.v3Prev);
      if (after.length >= R.guardGames) {
        const cur = scoreProbs(after.map(g => ({ p: mixP(champ.mixWeight, g.v3, g.fChamp), y: g.y })));
        const old = scoreProbs(after.map(g => ({ p: mixP(prev.mixWeight, g.v3Prev!, g.fPrev!), y: g.y })));
        if (cur.logLoss - old.logLoss > R.guardWorse) {
          if (prev.featModelId) activateFeatureModel(prev.featModelId);
          applyVector(prev.v3Vector, { source: 'model-daily rollback', date: today });
          applyStoredTuning();
          setConfig('mix_weight', String(prev.mixWeight));
          const back: Champion = { ...prev, since: todayIso, label: `rolled back to ${prev.label}`, prev: null };
          saveChampion(back);
          clearPredictionCache();
          const reason = `Rollback: since ${since} the champion scored ${cur.logLoss} vs ${old.logLoss} for the previous one (${after.length} games, worse by ${(cur.logLoss - old.logLoss).toFixed(4)} > ${R.guardWorse}).`;
          save({ champion: back, challengers: { ...challengers, guard: { games: after.length, current: cur, previous: old } }, decision: 'rollback', reason, rollback: true });
          return { decision: 'rollback', reason };
        }
        (challengers as any).guard = { games: after.length, current: cur, previous: old, ok: true };
      }
    }

    // 4. promotion
    const passing = table.filter(t => t.pass).sort((a, b) => a.W.logLoss - b.W.logLoss || a.W.brier - b.W.brier);
    let decision = 'keep', reason = games.W.length < R.minGames
      ? `No change: only ${games.W.length} scored league games in the last 60 days (rules need ${R.minGames}).`
      : 'No change: no challenger beat the champion by the rules.';
    if (passing.length) {
      const win = passing[0];
      const cand = cands.find(c => c.id === win.id)!;
      const before: Omit<Champion, 'prev'> = { ...champ };
      delete (before as any).prev;
      const what = await cand.apply!();
      champ = { ...champ, since: todayIso, label: win.label, prev: before };
      saveChampion(champ);
      clearPredictionCache();
      decision = 'promote';
      reason = `Changed: ${what}. Last 60 days log loss ${base.W.logLoss} → ${win.W.logLoss} (${win.W.n} games); previous 60 days ${base.Wp.logLoss} → ${win.Wp.logLoss}; hit ${base.W.hitRate}% → ${win.W.hitRate}%.`;
    } else {
      saveChampion(champ);
    }

    // publishing v3-mix (auto mode)
    const mixW = scored.find(s => s.c.id === 'champion')!;
    if (mixMode() === 'auto') {
      const beatsW = mixW.W.n >= R.minGames && mixW.W.logLoss <= reference.v3.W.logLoss;
      const beatsWp = mixW.Wp.n >= R.minGames && mixW.Wp.logLoss <= reference.v3.Wp.logLoss;
      if (!mixLive() && beatsW && beatsWp) { setMixLive(true); clearPredictionCache(); reason += ` v3-mix is now the published model (60 days: ${mixW.W.logLoss} vs v3 ${reference.v3.W.logLoss}; previous 60: ${mixW.Wp.logLoss} vs ${reference.v3.Wp.logLoss}).`; }
      else if (mixLive() && mixW.W.n >= R.minGames && mixW.W.logLoss - reference.v3.W.logLoss > R.mixOffWorse) { setMixLive(false); clearPredictionCache(); reason += ` v3-mix fell behind v3 (${mixW.W.logLoss} vs ${reference.v3.W.logLoss}): back to publishing v3.`; }
    }
    save({ champion: champ, challengers, decision, reason });
    logger.info(`model daily: ${decision} — ${reason}`);
    return { decision, reason, ms: Date.now() - t0 };
  } catch (e: any) {
    logger.warn(`model daily failed: ${e.message}`);
    save({ champion: champ, challengers: null, decision: 'error', reason: `Daily job failed: ${e.message}` });
    return { decision: 'error', reason: e.message };
  } finally {
    running = false;
  }
}

/* ------------------------------------------------------------------ */
/* Morning report                                                        */
/* ------------------------------------------------------------------ */

function trackedRows(from: string, to: string) {
  return db.prepare(`
    SELECT p.match_id, p.model, p.p_home, p.p_draw, p.p_away, p.odds_home, p.odds_draw, p.odds_away, r.outcome
    FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE p.settled = 1 AND p.locked = 1 AND COALESCE(p.backfilled, 0) = 0 AND r.outcome IN ('H','D','A')
      AND p.model IN ('grid-v3', '${MIX_MODEL}', '${FEAT_MODEL}') AND p.utc_date >= ? AND p.utc_date < ?`).all(from, to) as any[];
}
function periodNumbers(from: string, to: string) {
  const rows = trackedRows(from, to);
  const y = (o: string) => (o === 'H' ? 0 : o === 'D' ? 1 : 2);
  const by = (m: string) => rows.filter(r => r.model === m).map(r => ({ p: [r.p_home, r.p_draw, r.p_away] as P3, y: y(r.outcome) }));
  const odds = new Map<number, { p: P3; y: number }>();
  for (const r of rows) if (r.odds_home && r.odds_draw && r.odds_away && !odds.has(r.match_id)) odds.set(r.match_id, { p: [1 / r.odds_home, 1 / r.odds_draw, 1 / r.odds_away], y: y(r.outcome) });
  const pub = mixLive() && by(MIX_MODEL).length ? MIX_MODEL : 'grid-v3';
  const pubRows = by(pub);
  const strong = pubRows.filter(r => Math.max(...r.p) >= 60);
  const hit = (rs: { p: P3; y: number }[]) => rs.filter(r => { const q = r.p; const k = q[0] >= q[1] && q[0] >= q[2] ? 0 : q[2] >= q[1] ? 2 : 1; return k === r.y; }).length;
  return {
    games: new Set(rows.map(r => r.match_id)).size, published: pub,
    right: hit(pubRows), of: pubRows.length,
    strong: { n: strong.length, right: hit(strong) },
    mix: scoreProbs(by(MIX_MODEL)), v3: scoreProbs(by('grid-v3')), feature: scoreProbs(by(FEAT_MODEL)), market: scoreProbs([...odds.values()])
  };
}

const f4 = (s: { n: number; logLoss: number }) => (s.n ? s.logLoss.toFixed(3) : 'n/a');
const pctOf = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

export function buildReport(date = localParts().date): string {
  const row: any = db.prepare(`SELECT * FROM model_daily WHERE date = ?`).get(date);
  const champ = champion();
  const startToday = Date.parse(`${date}T00:00:00Z`);
  const yFrom = iso(startToday - DAY), yTo = iso(startToday);
  const y = periodNumbers(yFrom, yTo);
  const m = periodNumbers(iso(startToday - 30 * DAY), yTo);
  let ch: any = null;
  try { ch = row?.challengers ? JSON.parse(row.challengers) : null; } catch { ch = null; }
  const queued = ch?.candidates ? ch.candidates.filter((c: any) => c.id !== 'champion').sort((a: any, b: any) => a.dW - b.dW).slice(0, 3) : [];
  const health = lastDataHealth();
  const failing = health ? health.checks.filter(c => c.level !== 'ok') : [];
  const unsettled: any = db.prepare(`SELECT COUNT(DISTINCT match_id) AS n FROM predictions WHERE locked = 1 AND settled = 0 AND utc_date < ?`).get(new Date(Date.now() - 4 * 3600 * 1000).toISOString());
  const pubName = mixLive() ? 'v3-mix' : 'v3 (v3-mix in shadow)';
  const lines = [
    `SportLikely model report — ${nice(date)}`,
    '',
    `Model in use: ${pubName}. Champion: ${describe(champ)}.`,
    row ? (row.decision === 'keep' ? 'Today: No change.' : `Today: ${row.reason}`) : 'Today: the daily job has not run (check the server).',
    ...(row?.rollback ? ['ROLLBACK — see above.'] : []),
    '',
    `Yesterday (${nice(yFrom)}): ${y.games} games settled, picks right ${y.right}/${y.of} (${pctOf(y.right, y.of)}).`,
    `  log loss: v3-mix ${f4(y.mix)} · v3 ${f4(y.v3)} · feature ${f4(y.feature)} · bookmakers ${f4(y.market)}${y.market.n ? ` (${y.market.n} with odds)` : ''}`,
    `Last 30 days: ${m.games} games, picks right ${pctOf(m.right, m.of)}, 60%+ sure ${pctOf(m.strong.right, m.strong.n)} (${m.strong.n}).`,
    `  log loss: v3-mix ${f4(m.mix)} (${m.mix.n}) · v3 ${f4(m.v3)} (${m.v3.n}) · feature ${f4(m.feature)} (${m.feature.n}) · bookmakers ${f4(m.market)} (${m.market.n})`,
    '',
    `Data health: ${failing.length ? failing.map(c => `${c.label}: ${c.detail}`).join('; ') : health ? 'all checks ok' : 'not checked yet'}. Unsettled games (kick-off + 4 h): ${unsettled?.n ?? 0}.`,
    '',
    // fix217: the NBA's v4 against bb-v3, for 2 weeks after v4 starts
    ...(() => { const l = nbaV4ReportLines(); return l.length ? [...l, ''] : []; })(),
    // fix219: bb-v4 (grid) against bb-v3 in every basketball league, for 2 weeks after it goes live
    ...(() => { const l = gridReportLines(); return l.length ? [...l, ''] : []; })(),
    // fix222: the monthly bb-v4 tune on the live database (the worker's jobs.ts runs it; applied only through the gate)
    ...(() => { const l = autoTuneLine(); return l ? [l, ''] : []; })(),
    ...(() => { const l = leagueTuneLine(); return l ? [l, ''] : []; })(),
    ...(() => { const l = missFitLine(); return l ? [l, ''] : []; })(),
    'Next challengers:',
    ...(queued.length ? queued.map((c: any, i: number) => `  ${i + 1}. ${c.label}: ${c.dW >= 0 ? '+' : ''}${c.dW.toFixed(4)} vs champion over ${c.W.n} games — ${c.why}`) : ['  none scored today']),
    '',
    `Admin: ${SITE}/admin`
  ];
  return lines.join('\n');
}

export async function sendMorningReport(force = false) {
  const date = localParts().date;
  const row: any = db.prepare(`SELECT report_sent_at FROM model_daily WHERE date = ?`).get(date);
  if (row?.report_sent_at && !force) return { skipped: 'already sent' };
  const text = buildReport(date);
  db.prepare(`INSERT INTO model_daily (date, report) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET report = excluded.report`).run(date, text);
  const to = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (emailEnabled && to.length) {
    const html = `<pre style="font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap">${esc(text)}</pre>`;
    for (const addr of to) await sendEmail(addr, `Model report ${nice(date)}`, html, text);
  }
  db.prepare(`UPDATE model_daily SET report_sent_at = ? WHERE date = ?`).run(new Date().toISOString(), date);
  return { sent: emailEnabled && to.length > 0, to: to.length, text };
}

/** Last 30 days of the daily log (admin). */
export function modelDailyLog(days = 30) {
  const rows = db.prepare(`SELECT * FROM model_daily ORDER BY date DESC LIMIT ?`).all(days) as any[];
  return {
    champion: champion(), mixLive: mixLive(), mixMode: mixMode(), rules: DAILY_RULES, running,
    days: rows.map(r => ({
      date: r.date, ranAt: r.ran_at, decision: r.decision, reason: r.reason, rollback: !!r.rollback, ms: r.ms, report: r.report, reportSentAt: r.report_sent_at,
      champion: r.champion ? JSON.parse(r.champion) : null, challengers: r.challengers ? JSON.parse(r.challengers) : null
    }))
  };
}

/** Every 5 minutes: the daily job from 04:00 UTC, the report from 07:00 Asia/Jerusalem (DST-aware). */
export function startModelDailyScheduler() {
  // fix169: the tick awaits its work and labels it, so a slow part is named in the stall report (it ran outside its label)
  const tick = async () => {
    const now = new Date();
    const lp = localParts(now);
    const row: any = db.prepare(`SELECT ran_at, report_sent_at FROM model_daily WHERE date = ?`).get(lp.date);
    // 04:00–20:59 UTC only: late in the UTC evening the Jerusalem date is already tomorrow's
    // fix194: in the heavy-job queue (never with the tennis jobs or the player-page warm-up)
    if (now.getUTCHours() >= 4 && now.getUTCHours() < 21 && !row?.ran_at && !running && process.env.MODEL_DAILY !== 'off')
      await heavy('model daily job', () => timed('model daily job', () => runModelDaily())).catch(e => logger.warn(`model daily: ${e.message}`));
    // the report waits for the job when it is still running at 07:00 (until 09:00 local at the latest)
    if (lp.hour >= 7 && lp.hour < 12 && !row?.report_sent_at && (!running || lp.hour >= 9))
      await timed('model report', () => sendMorningReport()).catch(e => logger.warn(`model report: ${e.message}`));
  };
  // fix194: the tick is a plain timer (it only looks at the clock); the job and the report carry their own labels, so a
  // tick waiting in the heavy queue is not reported as running
  const run = () => { tick().catch(e => logger.warn(`model daily: ${e?.message || e}`)); };
  setTimeout(run, 3 * 60 * 1000).unref();
  setInterval(run, 5 * 60 * 1000).unref();
}

/**
 * Daily self-learning for the football league model (Oct 2026) — champion / challenger, and the 07:00 morning report.
 *
 * 04:00 UTC (after the night's results are settled), once a day:
 *  1. Rebuild the feature-model state and refit the feature model on every settled game (stored, live only if promoted).
 *  2. Candidates (fix251, utils/dailyRules.ts): (a) the champion with the fresher feature fit (the daily refit); the
 *     mix weight 0.4 … 1.0 (1.0 = the feature model alone), each with the current and the fresh fit; (b) the v3 row
 *     weights refitted with the v3 tuner (2 previous seasons + this season), with the champion's mix and with the
 *     best mix; a mix weight per league group (big leagues / rest) when each has ≥ 300 games; the market anchor
 *     (games with stored prices: blend toward the market, weight 0.1–0.4 chosen on the 60 days before each window).
 *  3. Score every candidate against the champion on the last 60 days (W) and the 60 before (Wp), out of sample: every
 *     fit used for scoring was trained only on games before its window (walk-forward). "Current fit" = a fit as stale
 *     as the live one (trained that many days before the window), "fresh" = trained up to the window start.
 *  4. Promote the best candidate only if: ≥ 300 games in each window, per-game log loss better in both windows, better
 *     in ≥ 90% of 2,000 paired bootstrap resamples of both windows together, hit rate not down by > 0.5 pp
 *     (fix251 — fix113's fixed −0.003 was never met: 14 days of "keep" with candidates better in both windows).
 *  5. Guardrail: once the champion has played ≥ 100 games since it was promoted, if it is worse than the previous
 *     champion on those games by > 0.005, roll back automatically and flag it in the report.
 *  6. Everything goes to `model_daily` (admin: /api/admin/model-daily, card on the Admin page).
 * The champion records the live settings: mix weight (or one per group), market anchor, v3 weights and the feature fit
 * in use (id + cutoff, from the active fit — fix113's first record said "feature fit to —", so (a) was never built).
 * v3-mix publishing (mix_mode 'auto'): switched on the first day v3-mix beats v3 alone in both 60-day windows
 * (≥ 300 games each), off again if it falls behind v3 by > 0.005.
 * Never touches national-team (elo-intl), European-cup (elo-euro) or basketball models. Prices stay admin-only: the
 * anchor moves the public probabilities, no price is shown.
 *
 * 07:00 Asia/Jerusalem (DST-aware, checked every 5 minutes): plain-text report to ADMIN_EMAILS, also stored in the row.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { GROUPS, seasonCodes } from './history';
import { applyStoredTuning } from './gridModel';
import { v3WindowRun, liveVector, applyVector, isTuning } from './v3Tuner';
import { clearPredictionCache } from './predCache';
import { sendEmail, emailEnabled, SITE } from './email';
import { renderAdminMail, adminUrl, type AdminMail } from './adminMail';
import { lastDataHealth } from './dataHealth';
import { nbaV4ReportLines } from './nbaV4';
import { gridReportLines, autoTuneLine, leagueTuneLine, missFitLine, impactFitLine } from './bbTuner';
import { timed, slicer, yieldLoop, heavy } from './perf';
import {
  buildFeaturesAsync, fitFeatureModel, predictWith, storeFeatureModel, activateFeatureModel, activeFeatureModel, loadFeatureModel,
  fixtureByNames, getConfig, setConfig, mixWeight, mixWeightGroups, marketAnchor, mixMode, mixLive, setMixLive, scoreProbs, FEAT_MODEL, MIX_MODEL,
  dropFeatureState, FittedModel, FeatState
} from './featureModel';
import {
  DAILY_RULES, candidateList, chooseAnchor, chooseWeight, groupOfDiv, mixP, anchorP, paired, preJudge, finishJudge, pairedBootstrapAsync, closeness,
  type P3, type Spec, type CandSpec, type FitKind
} from '../utils/dailyRules';
import { learningStatus } from './modelDailyHealth';

export { DAILY_RULES };
const DAY = 24 * 3600 * 1000;
const TZ = 'Asia/Jerusalem';

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

interface Champion {
  mixWeight: number; groupW?: { big: number; rest: number } | null; anchor?: number;
  featModelId: number | null; featCutoff: string | null; v3Vector: number[]; since: string;
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

/** The stored champion with the live settings filled in (fix251: the feature fit in use comes from the active fit). */
function champion(): Champion {
  const act = activeFeatureModel();
  const live = { mixWeight: mixWeight(), groupW: mixWeightGroups(), anchor: marketAnchor(), featModelId: act?.id ?? null, featCutoff: act?.cutoff ?? null };
  try { const c = JSON.parse(getConfig('champion', '')); if (c && Array.isArray(c.v3Vector)) return { ...c, ...live }; } catch { /* first run */ }
  return { ...live, v3Vector: liveVector(), since: new Date().toISOString().slice(0, 10), label: 'initial' };
}
const saveChampion = (c: Champion) => setConfig('champion', JSON.stringify(c));
const describe = (c: Champion) => {
  const w = c.groupW ? `feature weight ${c.groupW.big} big leagues / ${c.groupW.rest} rest` : `feature weight ${c.mixWeight}`;
  return `v3-mix, ${w}${c.anchor ? `, market anchor ${c.anchor}` : ''}, feature fit to ${c.featCutoff || '—'}${c.featModelId ? ` (#${c.featModelId})` : ''}, champion since ${c.since}`;
};
const specOf = (c: Omit<Champion, 'prev'>): Spec => ({ w: c.mixWeight, groupW: c.groupW || null, fit: 'current', v3: 'champion', anchor: c.anchor || 0 });

/* ---------- scoring ---------- */

type WinKey = 'W' | 'Wp' | 'Wpp';
interface Game {
  fid: number; date: string; div: string; win: WinKey; y: number; mkt: P3 | null;
  v3: P3; v3fit: P3 | null; fCur: P3; fFresh: P3; fLive: P3 | null; fPrev: P3 | null; v3Prev: P3 | null;
}
/** a setting's probabilities for one game; `aWf` = the walk-forward anchor weight of the game's window */
function probsOf(s: Spec, g: Game, aWf: number | null): P3 | null {
  const v = s.v3 === 'refit' ? g.v3fit : g.v3;
  if (!v) return null;
  const f = s.fit === 'fresh' ? g.fFresh : g.fCur;
  const w = s.groupW ? s.groupW[groupOfDiv(g.div)] : s.w;
  const a = s.anchor === 'wf' ? aWf : s.anchor;
  return anchorP(mixP(w, v, f), g.mkt, a || 0);
}
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
  // the live settings are the truth (an admin may have re-tuned v3 or changed the weight since the last run)
  let champ: Champion = { ...champion(), v3Vector: liveVector() };
  try {
    const R = DAILY_RULES;
    const now = Date.now();
    const W = { from: iso(now - R.windowDays * DAY), to: iso(now + DAY) };
    const Wp = { from: iso(now - 2 * R.windowDays * DAY), to: W.from };
    const Wpp = { from: iso(now - 3 * R.windowDays * DAY), to: Wp.from }; // only to choose the anchor weight for Wp
    const todayIso = iso(now);

    // 1. state + the routine refit on every settled game (stored; live only when a "fresh fit" candidate is promoted)
    dropFeatureState();
    const st: FeatState = await buildFeaturesAsync(); // fix167: in slices
    const refit = await fitFeatureModel(st, todayIso);
    const refitId = refit ? storeFeatureModel(refit.model, todayIso, refit.n, null, false) : null;

    // feature fits for scoring (walk-forward: trained before each window). "current" = as stale as the live fit
    const champModel = champ.featModelId ? loadFeatureModel(champ.featModelId) : activeFeatureModel()?.model || null;
    const stale = champ.featCutoff ? Math.max(0, Math.round((now - Date.parse(champ.featCutoff)) / DAY)) : 0;
    const fits = new Map<string, FittedModel | null>();
    const fitAt = async (cut: string) => { if (!fits.has(cut)) fits.set(cut, (await fitFeatureModel(st, cut))?.model || null); return fits.get(cut)!; };
    const back = (d: string) => iso(Date.parse(d) - stale * DAY);
    const fit = {
      cur: { W: await fitAt(back(W.from)), Wp: await fitAt(back(Wp.from)), Wpp: await fitAt(back(Wpp.from)) },
      fresh: { W: await fitAt(W.from), Wp: await fitAt(Wp.from) }
    };
    if (!fit.cur.W || !fit.cur.Wp || !fit.fresh.W || !fit.fresh.Wp) throw new Error('too few games to fit the feature model for the windows');

    // 2b. v3 window run: live (champion) weights, refits before each window and on everything (for promotion)
    const prev = champ.prev || null;
    const run = await v3WindowRun({
      seasons: seasonCodes(3), scoreFrom: fit.cur.Wpp ? Wpp.from : Wp.from,
      fits: [{ label: 'W', trainBefore: W.from }, { label: 'Wp', trainBefore: Wp.from }, { label: 'all', trainBefore: iso(now + DAY) }],
      vectors: { champion: champ.v3Vector, ...(prev ? { previous: prev.v3Vector } : {}) }
    });
    const divGroup = new Map<string, string>();
    for (const [g, cfg] of Object.entries(GROUPS)) for (const d of cfg.divisions) divGroup.set(d, g);
    const rowsByFid = new Map(st.rows.map(r => [r.fid, r]));
    const prevModel = prev?.featModelId ? loadFeatureModel(prev.featModelId) : null;
    const games: Record<WinKey, Game[]> = { W: [], Wp: [], Wpp: [] };
    const slice = slicer(); // fix169: the job yields every 30 ms (it froze the server 0.5 s unlabelled)
    for (let i = 0; i < run.items.length; i++) {
      await slice();
      const it = run.items[i];
      const grp = divGroup.get(it.div);
      if (!grp) continue;
      const fx = fixtureByNames(st, grp, it.home, it.away, it.date);
      const row = fx ? rowsByFid.get(fx.fid) : null;
      if (!fx || !row || !row.ok) continue;
      const win: WinKey = it.date >= W.from ? 'W' : it.date >= Wp.from ? 'Wp' : 'Wpp';
      if (win === 'Wpp' && !fit.cur.Wpp) continue;
      const fm = (m: FittedModel | null) => (m ? predictWith(m, row.x) : null);
      const fCur = fm(fit.cur[win])!;
      const g: Game = {
        fid: fx.fid, date: it.date, div: it.div, win, y: it.o === 'H' ? 0 : it.o === 'D' ? 1 : 2, mkt: it.mkt,
        v3: (run.vectors.champion?.[i] || run.live[i]) as P3,
        v3fit: win === 'Wpp' ? null : (run.fits[win]?.probs[i] as P3) || null,
        fCur, fFresh: win === 'Wpp' ? fCur : fm(fit.fresh[win])!,
        // the live fit on games after its cutoff (truly unseen) — for the guardrail
        fLive: champ.featCutoff && it.date >= champ.featCutoff ? fm(champModel) : null,
        fPrev: fm(prevModel), v3Prev: (run.vectors.previous?.[i] as P3) || null
      };
      games[win].push(g);
    }

    // 3. candidates, stage 1: the champion, the mix grid × {current, fresh fit}, the refitted v3 weights
    const c0 = specOf(champ);
    const v3Refit = !!(run.fits.W && run.fits.Wp && run.fits.all);
    const dropFresh = (l: CandSpec[]) => (refitId ? l : l.filter(c => c.fit !== 'fresh'));
    const champP = { W: games.W.map(g => probsOf(c0, g, null)), Wp: games.Wp.map(g => probsOf(c0, g, null)) };
    // the market-anchor weight of each window, chosen on the window before (walk-forward); `live` = chosen on W
    const anchorFor = (s: Spec) => {
      const base: Spec = { ...s, anchor: 0 };
      const rows = (k: WinKey) => games[k].map(g => ({ p: probsOf(base, g, null)!, mkt: g.mkt, y: g.y })).filter(r => r.p);
      return { W: chooseAnchor(rows('Wp')), Wp: games.Wpp.length ? chooseAnchor(rows('Wpp')) : null, live: chooseAnchor(rows('W')) };
    };
    const pairedOf = (s: Spec, k: 'W' | 'Wp', a: number | null) => paired(games[k].map((g, j) => ({ c: probsOf(s, g, a), b: champP[k][j], y: g.y })));
    const evalCand = async (c: CandSpec) => {
      await yieldLoop();
      const aw = c.anchor === 'wf' ? anchorFor(c) : null;
      const pw = pairedOf(c, 'W', aw?.W ?? null), pwp = pairedOf(c, 'Wp', aw?.Wp ?? null);
      return { c, aw, pw, pwp, W: scoreSet(games.W, g => probsOf(c, g, aw?.W ?? null)), Wp: scoreSet(games.Wp, g => probsOf(c, g, aw?.Wp ?? null)) };
    };
    const stage1 = dropFresh(candidateList({ champion: c0, v3Refit }));
    const scored: Awaited<ReturnType<typeof evalCand>>[] = [];
    for (const c of stage1) scored.push(await evalCand(c));
    const pooled = (x: { pw: { s: { n: number; diff: number } }; pwp: { s: { n: number; diff: number } } }) =>
      (x.pw.s.n * x.pw.s.diff + x.pwp.s.n * x.pwp.s.diff) / Math.max(1, x.pw.s.n + x.pwp.s.n);
    // the best plain mix (champion included) over both windows → stage 2
    const mixes = scored.filter(x => x.c.id === 'champion' || x.c.kind === 'mix' || x.c.kind === 'feature').filter(x => !x.c.groupW && x.c.v3 === 'champion');
    const bestMix = mixes.slice().sort((a, b) => pooled(a) - pooled(b))[0];
    const best = bestMix ? { w: bestMix.c.w, fit: bestMix.c.fit } : null;
    // per-group weight: each group's own best weight (both windows, the best mix's fit), only with ≥ 300 games per group per window
    let group: { big: number; rest: number; fit: FitKind } | null = null;
    if (best) {
      const inG = (k: 'W' | 'Wp', gr: string) => games[k].filter(g => groupOfDiv(g.div) === gr);
      const enough = ['big', 'rest'].every(gr => inG('W', gr).length >= R.groupMinGames && inG('Wp', gr).length >= R.groupMinGames);
      if (enough) {
        const ws = [...new Set([...R.mixWeights, c0.w])];
        const pick = (gr: string) => chooseWeight([...inG('W', gr), ...inG('Wp', gr)], ws, (g: Game, w) => probsOf({ ...c0, w, groupW: null, fit: best.fit }, g, null))?.w;
        const big = pick('big'), rest = pick('rest');
        if (big != null && rest != null && Math.abs(big - rest) > 1e-9) group = { big, rest, fit: best.fit };
      }
    }
    const anchorOk = games.W.some(g => g.mkt) && games.Wp.some(g => g.mkt);
    const stage2 = dropFresh(candidateList({ champion: c0, v3Refit, best, group, anchor: anchorOk })).filter(c => !stage1.some(s => s.id === c.id));
    for (const c of stage2) scored.push(await evalCand(c));
    await yieldLoop();

    // verdicts: the cheap checks first, the bootstrap only for candidates better in both windows
    const table: any[] = [];
    for (const x of scored) {
      let v: { pass: boolean; why: string; boot: any; gap: string | null };
      if (x.c.id === 'champion') v = { pass: false, why: 'champion', boot: null, gap: null };
      else {
        const pre = preJudge(x.pw, x.pwp, R);
        v = pre || finishJudge(x.pw, x.pwp, await pairedBootstrapAsync([...x.pw.d, ...x.pwp.d], yieldLoop, R.resamples), R);
      }
      table.push({
        id: x.c.id, label: x.c.label, kind: x.c.kind, spec: { w: x.c.w, groupW: x.c.groupW, fit: x.c.fit, v3: x.c.v3, anchor: x.c.anchor },
        W: x.W, Wp: x.Wp, n: { W: x.pw.s.n, Wp: x.pwp.s.n }, dW: x.pw.s.diff, dWp: x.pwp.s.diff, hit: { W: x.pw.s.hitC, champion: x.pw.s.hitB },
        ...(x.aw ? { anchorWeights: x.aw } : {}), pass: v.pass, why: v.why, gap: v.gap,
        boot: v.boot ? { pBetter: v.boot.pBetter, mean: v.boot.mean, lo: v.boot.lo, hi: v.boot.hi, n: v.boot.n } : null,
        close: Math.round(closeness({ W: x.pw.s, Wp: x.pwp.s, boot: v.boot }) * 1e5) / 1e5
      });
    }
    const base = scored[0];
    const reference = {
      v3: { W: scoreSet(games.W, g => g.v3), Wp: scoreSet(games.Wp, g => g.v3) },
      feature: { W: scoreSet(games.W, g => g.fCur), Wp: scoreSet(games.Wp, g => g.fCur) },
      market: { W: scoreSet(games.W.filter(g => g.mkt), g => g.mkt), Wp: scoreSet(games.Wp.filter(g => g.mkt), g => g.mkt) },
      championOnOddsGames: scoreSet(games.W.filter(g => g.mkt), g => probsOf(c0, g, null))
    };
    const bestCand = table.filter(t => t.id !== 'champion').sort((a, b) => a.close - b.close)[0] || null;
    const challengers = {
      windows: { W, Wp, Wpp }, games: { W: games.W.length, Wp: games.Wp.length, Wpp: games.Wpp.length }, reference, candidates: table, refitId, stale,
      liveFit: { id: champ.featModelId, cutoff: champ.featCutoff }, rules: R,
      best: bestCand ? { id: bestCand.id, label: bestCand.label, dW: bestCand.dW, dWp: bestCand.dWp, pBetter: bestCand.boot?.pBetter ?? null, pass: bestCand.pass, why: bestCand.why, gap: bestCand.gap } : null
    };

    // 5. guardrail first: a champion that is doing worse than the one it replaced goes back
    if (prev) {
      const since = champ.since;
      const after = [...games.Wp, ...games.W].filter(g => g.date >= since && g.fPrev && g.v3Prev);
      if (after.length >= R.guardGames) {
        const cs = specOf(champ), ps = specOf(prev);
        const cur = scoreProbs(after.map(g => ({ p: anchorP(mixP(cs.groupW ? cs.groupW[groupOfDiv(g.div)] : cs.w, g.v3, g.fLive || g.fCur), g.mkt, Number(cs.anchor) || 0), y: g.y })));
        const old = scoreProbs(after.map(g => ({ p: anchorP(mixP(ps.groupW ? ps.groupW[groupOfDiv(g.div)] : ps.w, g.v3Prev!, g.fPrev!), g.mkt, Number(ps.anchor) || 0), y: g.y })));
        if (cur.logLoss - old.logLoss > R.guardWorse) {
          if (prev.featModelId) activateFeatureModel(prev.featModelId);
          applyVector(prev.v3Vector, { source: 'model-daily rollback', date: today });
          applyStoredTuning();
          setConfig('mix_weight', String(prev.mixWeight));
          setConfig('mix_weight_groups', prev.groupW ? JSON.stringify(prev.groupW) : '');
          setConfig('market_anchor', String(prev.anchor || 0));
          const backTo: Champion = { ...prev, since: todayIso, label: `rolled back to ${prev.label}`, prev: null };
          saveChampion(backTo);
          clearPredictionCache();
          const reason = `Rollback: since ${since} the champion scored ${cur.logLoss} vs ${old.logLoss} for the previous one (${after.length} games, worse by ${(cur.logLoss - old.logLoss).toFixed(4)} > ${R.guardWorse}).`;
          save({ champion: backTo, challengers: { ...challengers, guard: { games: after.length, current: cur, previous: old } }, decision: 'rollback', reason, rollback: true });
          return { decision: 'rollback', reason };
        }
        (challengers as any).guard = { games: after.length, current: cur, previous: old, ok: true };
      }
    }

    // 4. promotion: the passing candidate with the biggest gain over both windows
    const passing = table.filter(t => t.pass).sort((a, b) => (a.boot?.mean ?? 0) - (b.boot?.mean ?? 0) || a.W.brier - b.W.brier);
    let decision = 'keep', reason = games.W.length < R.minGames
      ? `No change: only ${games.W.length} scored league games in the last 60 days (rules need ${R.minGames}).`
      : `No change: no candidate passed the bar${bestCand ? ` (closest: ${bestCand.label} — ${bestCand.why})` : ''}.`;
    if (passing.length) {
      const win = passing[0];
      const x = scored.find(s => s.c.id === win.id)!;
      const before: Omit<Champion, 'prev'> = { ...champ };
      delete (before as any).prev;
      const what: string[] = [];
      if (x.c.fit === 'fresh' && refitId && refit) {
        activateFeatureModel(refitId);
        champ = { ...champ, featModelId: refitId, featCutoff: todayIso };
        what.push(`feature fit ${todayIso} (#${refitId}, ${refit.n} games)`);
      }
      if (x.c.v3 === 'refit') {
        const vx = run.fits.all.x;
        applyVector(vx, { source: 'model-daily', date: today, train: run.fits.all.train });
        applyStoredTuning();
        champ = { ...champ, v3Vector: vx };
        what.push(`v3 row weights refitted on ${run.fits.all.train} games`);
      }
      const anchorLive = x.c.anchor === 'wf' ? (x.aw?.live ?? x.aw?.W ?? 0) : Number(x.c.anchor) || 0;
      if (Math.abs(x.c.w - c0.w) > 1e-9 || JSON.stringify(x.c.groupW) !== JSON.stringify(c0.groupW)) what.push(x.c.groupW ? `mix weight per group: big ${x.c.groupW.big}, rest ${x.c.groupW.rest}` : `mix weight ${c0.w} → ${x.c.w}`);
      if (Math.abs(anchorLive - (Number(c0.anchor) || 0)) > 1e-9) what.push(`market anchor ${anchorLive}`);
      setConfig('mix_weight', String(x.c.w));
      setConfig('mix_weight_groups', x.c.groupW ? JSON.stringify(x.c.groupW) : '');
      setConfig('market_anchor', String(anchorLive));
      champ = { ...champ, mixWeight: x.c.w, groupW: x.c.groupW, anchor: anchorLive, since: todayIso, label: win.label, prev: before };
      saveChampion(champ);
      clearPredictionCache();
      decision = 'promote';
      reason = `Changed: ${what.join('; ') || win.label}. Last 60 days log loss ${base.W.logLoss} → ${win.W.logLoss} (${win.n.W} games, ${win.dW.toFixed(4)}); previous 60 days ${base.Wp.logLoss} → ${win.Wp.logLoss} (${win.dWp.toFixed(4)}); better in ${Math.round((win.boot?.pBetter ?? 0) * 100)}% of ${R.resamples} resamples; hit ${win.hit.champion}% → ${win.hit.W}%.`;
    } else {
      saveChampion(champ);
    }

    // publishing v3-mix (auto mode)
    if (mixMode() === 'auto') {
      const mixW = base;
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
  const queued = ch?.candidates ? ch.candidates.filter((c: any) => c.id !== 'champion').sort((a: any, b: any) => (a.close ?? a.dW) - (b.close ?? b.dW)).slice(0, 3) : [];
  const ls = learningStatus();
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
    ...(() => { const l = impactFitLine(); return l ? [l, ''] : []; })(),
    `Learning: ${ls.lastPromotion ? `last promotion ${ls.lastPromotion.date} (${ls.daysSince} days ago)` : `no promotion yet (${ls.daysSince ?? 0} days)`}.`,
    'Next challengers:',
    ...(queued.length ? queued.map((c: any, i: number) => `  ${i + 1}. ${c.label}: ${c.dW >= 0 ? '+' : ''}${c.dW.toFixed(4)} (previous 60 days ${c.dWp != null ? `${c.dWp >= 0 ? '+' : ''}${c.dWp.toFixed(4)}` : 'n/a'}) vs champion over ${c.n?.W ?? c.W.n} games — ${c.why}`) : ['  none scored today']),
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
    // fix239: the admin template — the report as its body, a "what to do" only when something went wrong
    const r: any = db.prepare(`SELECT decision, reason, rollback FROM model_daily WHERE date = ?`).get(date);
    const health = lastDataHealth();
    const red = health ? health.checks.filter(c => c.level === 'fail') : [];
    const rolled = !!r?.rollback;
    const mail: AdminMail = {
      label: 'Model report', tone: rolled || red.length ? 'warn' : 'ok',
      title: `Model report ${nice(date)}`,
      what: !r ? 'The daily model job has not run today.' : rolled ? 'Last night’s model change was rolled back automatically: it predicted worse.' : r.decision === 'keep' ? 'The football model kept last night’s settings; yesterday’s numbers are below.' : `The football model changed last night: ${String(r.reason || '').replace(/\.$/, '')}.`,
      todo: !r ? 'Check that the worker is running (Admin → Site health); tell Claude if it stays so tomorrow.'
        : red.length ? `${red.length} data check${red.length === 1 ? ' is' : 's are'} red — open Admin → Needs you.` : null,
      pre: text.split('\n').slice(2).join('\n'),
      buttons: [{ text: 'Open models in Admin', href: adminUrl('models') }, ...(red.length ? [{ text: 'Open Needs you', href: adminUrl('needs-you'), kind: 'secondary' as const }] : [])]
    };
    const { html } = renderAdminMail(mail);
    for (const addr of to) await sendEmail(addr, `Model report ${nice(date)}`, html, text);
  }
  db.prepare(`UPDATE model_daily SET report_sent_at = ? WHERE date = ?`).run(new Date().toISOString(), date);
  return { sent: emailEnabled && to.length > 0, to: to.length, text };
}

/** Last 30 days of the daily log (admin). */
export function modelDailyLog(days = 30) {
  const rows = db.prepare(`SELECT * FROM model_daily ORDER BY date DESC LIMIT ?`).all(days) as any[];
  return {
    champion: champion(), mixLive: mixLive(), mixMode: mixMode(), rules: DAILY_RULES, running, learning: learningStatus(),
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

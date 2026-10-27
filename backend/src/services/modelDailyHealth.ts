/**
 * fix251: is the football daily learning job (services/modelDaily.ts) actually learning? Read from `model_daily` only
 * (no import of the job, so data health can read it without loading the model code).
 *  - learningStatus(): the last promotion, days since, today's best candidate and how far it is from passing (admin card)
 *  - modelDailyHealth(): data health warns when 30 days pass without a promotion while the best candidate is better
 *    in both windows (the bar may be too strict, or something stops the promotion)
 */
import { db } from '../db';
import { DAILY_RULES } from '../utils/dailyRules';
type Level = 'ok' | 'warn' | 'fail';

const DAY = 24 * 3600 * 1000;

export interface LearningStatus {
  lastPromotion: { date: string; reason: string } | null;
  daysSince: number | null;            // days since the last promotion (or since the first run when there was none)
  firstRun: string | null;
  today: { date: string; decision: string } | null;
  best: { id: string; label: string; dW: number; dWp: number; pBetter: number | null; pass: boolean; why: string; gap: string | null } | null;
}

export function learningStatus(now = Date.now()): LearningStatus {
  try {
    const promo: any = db.prepare(`SELECT date, reason FROM model_daily WHERE decision = 'promote' ORDER BY date DESC LIMIT 1`).get();
    const first: any = db.prepare(`SELECT MIN(date) AS d FROM model_daily WHERE ran_at IS NOT NULL`).get();
    const last: any = db.prepare(`SELECT date, decision, challengers FROM model_daily WHERE ran_at IS NOT NULL ORDER BY date DESC LIMIT 1`).get();
    let best: LearningStatus['best'] = null;
    try { best = last?.challengers ? JSON.parse(last.challengers)?.best ?? null : null; } catch { best = null; }
    const from = promo?.date || first?.d || null;
    return {
      lastPromotion: promo ? { date: promo.date, reason: promo.reason } : null,
      daysSince: from ? Math.max(0, Math.floor((now - Date.parse(`${from}T12:00:00Z`)) / DAY)) : null,
      firstRun: first?.d || null,
      today: last ? { date: last.date, decision: last.decision } : null,
      best
    };
  } catch {
    return { lastPromotion: null, daysSince: null, firstRun: null, today: null, best: null };
  }
}

export function modelDailyHealth(now = Date.now()): { id: string; label: string; level: Level; detail: string }[] {
  const s = learningStatus(now);
  if (!s.today) return [];
  const quiet = s.daysSince != null && s.daysSince >= DAILY_RULES.quietDays;
  const better = !!s.best && s.best.dW < 0 && s.best.dWp < 0;
  const since = s.lastPromotion ? `last promotion ${s.lastPromotion.date} (${s.daysSince} days ago)` : `no promotion since the first run ${s.firstRun} (${s.daysSince} days)`;
  const bestTxt = s.best ? `best candidate: ${s.best.label}, ${s.best.dW.toFixed(4)} / ${s.best.dWp.toFixed(4)}${s.best.pBetter != null ? `, better in ${Math.round(s.best.pBetter * 100)}% of resamples` : ''}${s.best.gap ? ` — ${s.best.gap}` : ''}` : 'no candidate scored';
  return [{
    id: 'model-daily-learning', label: 'Football model still learning',
    level: s.today.decision === 'error' ? 'warn' : quiet && better ? 'warn' : 'ok',
    detail: `${s.today.decision === 'error' ? `the ${s.today.date} run failed · ` : ''}${since} · ${bestTxt}`
  }];
}

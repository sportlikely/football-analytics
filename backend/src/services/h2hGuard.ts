/**
 * Head-to-head and the common-sense check for the European-cup and national-team models (Oct 2026).
 * Same idea as the league model (gridModel): past meetings feed a fitted row, and a team the factors rate weaker and
 * that is clearly worse on form or head-to-head may not come out as the favourite. Each model measures both on its own
 * out-of-sample test and only switches them on when they don't make it worse.
 */
export interface H2H { n: number; share: number; x: number }

export class Meetings {
  private map = new Map<string, { date: string; home: number; w: number }[]>();
  clear() { this.map.clear(); }
  /** fix202: the meetings as plain data (published by the worker) and back */
  dump() { return this.map; }
  load(m: Map<string, { date: string; home: number; w: number }[]>) { this.map = m; }
  private key(a: number, b: number) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  /** w = result from the home side's view: 1 win, 0.5 draw, 0 loss. */
  add(home: number, away: number, date: string, w: number) {
    const k = this.key(home, away);
    const l = this.map.get(k);
    if (l) l.push({ date, home, w }); else this.map.set(k, [{ date, home, w }]);
  }
  /** Last ≤10 meetings within `years`, from `home`'s point of view. x = centred, shrunk score (for a fitted weight). */
  get(home: number, away: number, date: string, years = 10): H2H | null {
    const l = this.map.get(this.key(home, away));
    if (!l) return null;
    const from = new Date(new Date(date).getTime() - years * 365.25 * 86400000).toISOString().slice(0, 10);
    const past = l.filter(m => m.date < date && m.date >= from).slice(-10);
    if (!past.length) return null;
    const score = past.reduce((s, m) => s + (m.home === home ? m.w : 1 - m.w), 0);
    return { n: past.length, share: score / past.length, x: (score - past.length / 2) / (past.length + 2) };
  }
}

export interface GuardOpt { on: boolean; formT: number; h2hT: number; margin: number }
/**
 * p = probabilities (0–1); factors > 0 when the model's own factors (without home advantage) favour the home side;
 * formGap > 0 when the home side is in better form. Returns the (possibly re-ordered) probabilities.
 */
export function commonSense(p: { h: number; d: number; a: number }, factors: number, formGap: number, h2h: H2H | null, o: GuardOpt) {
  if (!o.on) return { ...p, fired: false };
  const badH2H = (share: number) => !!h2h && h2h.n >= 5 && share <= o.h2hT;
  if (factors < 0 && (formGap <= -o.formT || badH2H(h2h ? h2h.share : 1)) && p.h > p.a - o.margin) {
    const mid = (p.h + p.a) / 2;
    return { h: mid - o.margin / 2, d: p.d, a: mid + o.margin / 2, fired: true };
  }
  if (factors > 0 && (formGap >= o.formT || badH2H(h2h ? 1 - h2h.share : 1)) && p.a > p.h - o.margin) {
    const mid = (p.h + p.a) / 2;
    return { h: mid + o.margin / 2, d: p.d, a: mid - o.margin / 2, fired: true };
  }
  return { ...p, fired: false };
}

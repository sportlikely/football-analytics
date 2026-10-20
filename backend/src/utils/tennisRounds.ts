/**
 * Tennis rounds (fix195, moved here in fix197): one code per round, from the provider's code or its text. Used by the
 * pages (services/tennisSite.ts) and by the data jobs (services/tennis.ts stores the code, so it is never empty).
 */

/** Q1–Q3 qualifying, R128 … R16, QF, SF, F, RR (round robin), R1 … (a numbered round of unknown size) */
export const ROUND_ORDER: Record<string, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 3, Q: 3, R1: 4.1, R2: 4.2, R3: 4.3, R4: 4.4, R128: 5, R64: 6, R32: 7, R16: 8, RR: 8.5, QF: 9, SF: 10, F: 12 };
const FRACTION: Record<string, string> = { '1': 'F', '2': 'SF', '4': 'QF', '8': 'R16', '16': 'R32', '32': 'R64', '64': 'R128' };
/**
 * The round code of a match: the provider's round_code when it is one we know, else read from its text ("ATP Brussels
 * - 1/16-finals" → R32, "Quarterfinals" → QF, "Qualification round 2" → Q2, "2nd round" → R2). Qualifying rounds are Q…
 */
export function normRound(code: string | null | undefined, round: string | null | undefined, qualifying: boolean): string | null {
  const c = String(code || '').toUpperCase().replace(/\s+/g, '');
  const r = String(round || '').toLowerCase();
  const q = qualifying || /qualif/.test(r) || /^Q\d?$/.test(c);
  if (/^Q\d$/.test(c)) return c;
  if (q) {
    const n = r.match(/(?:round|r)\s*(\d)|(\d)(?:st|nd|rd|th)\s+round/) || c.match(/^R(\d)$/);
    return n ? `Q${n[1] || n[2]}` : /final/.test(r) ? 'Q3' : 'Q';
  }
  if (c in ROUND_ORDER && c !== 'Q') return c;
  if (/^(F|FINAL)$/.test(c)) return 'F';
  const frac = r.match(/1\s*\/\s*(\d+)/);
  if (frac && FRACTION[frac[1]]) return FRACTION[frac[1]];
  if (/semi/.test(r)) return 'SF';
  if (/quarter/.test(r)) return 'QF';
  if (/round robin|group/.test(r)) return 'RR';
  if (/(^|[^a-z])(the )?finals?$/.test(r.trim()) || /(^|\s-\s)final$/.test(r.trim())) return 'F';
  const of = r.match(/(?:round of|last)\s*(\d+)/) || r.match(/\br\s*(\d{2,3})\b/);
  if (of && ['16', '32', '64', '128'].includes(of[1])) return `R${of[1]}`;
  const k = r.match(/(\d)(?:st|nd|rd|th)\s+round/) || r.match(/round\s*(\d)\b/);
  if (k) return `R${k[1]}`;
  return null;
}
/** English names of the codes (the pages translate the code themselves; this is for the preview text and SEO) */
export function roundEn(code: string | null): string | null {
  if (!code) return null;
  if (/^Q\d$/.test(code)) return `Qualifying R${code.slice(1)}`;
  if (code === 'Q') return 'Qualifying';
  if (/^R(16|32|64|128)$/.test(code)) return `Round of ${code.slice(1)}`;
  if (/^R\d$/.test(code)) return `Round ${code.slice(1)}`;
  return ({ QF: 'Quarter-final', SF: 'Semi-final', F: 'Final', RR: 'Round robin' } as Record<string, string>)[code] || null;
}

/** fix197: the round after this one (a player's next match in the same event), null after the final / unknown */
const NEXT: Record<string, string> = { Q1: 'Q2', Q2: 'Q3', Q3: 'Q4', R1: 'R2', R2: 'R3', R3: 'R4', R128: 'R64', R64: 'R32', R32: 'R16', R16: 'QF', QF: 'SF', SF: 'F' };
export const nextRound = (code: string | null): string | null => (code && NEXT[code]) || null;
/** fix197: the round named at the end of a tournament name ("ATP Brussels - 1/16-finals" → R32), never from the event's own name ("ATP Finals") */
export function roundFromName(name: string | null | undefined, qualifying: boolean): string | null {
  const parts = String(name || '').split(/\s[-–—]\s/);
  return parts.length > 1 ? normRound(null, parts[parts.length - 1], qualifying) : null;
}

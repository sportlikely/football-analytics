/**
 * fix215 — season simulator rules per competition, in one place (utils/seasonSim.ts plays them).
 *
 * Points, tie-breaks, the places of each zone (title, Champions League / Europe, promotion, relegation, play-offs),
 * split seasons and post-seasons. Zones that depend on cup winners or a federation's coefficient (a 5th Champions
 * League place, the Conference League place) are left at the places every season gives: "Europe" = the league
 * places that always go to a European cup. A league not listed here (or with `known: false`) gets the position
 * chances only, no zone columns, and data health lists it ("Season forecast rules").
 *
 * Keys: football = the public competition code (Football-Data.org code, else AF<API-Football id>); basketball = the
 * bb code; American football = 'NFL' / 'NCAA'.
 */
import type { LeagueRules, Zone, TieKey } from './seasonSim';

const FB_GD: TieKey[] = ['pts', 'gd', 'gf', 'h2h', 'h2hgd'];
const FB_H2H: TieKey[] = ['pts', 'h2h', 'h2hgd', 'gd', 'gf'];
const z = (key: Zone['key'], from: number, to = from): Zone => ({ key, from, to });
const fb = (tiebreaks: TieKey[], zones: Zone[], extra: Partial<LeagueRules> = {}): LeagueRules => ({ sport: 'football', tiebreaks, zones, known: true, ...extra });

/** Football: our competition code → its API-Football league (the season's fixtures live in af_fixtures). */
export const FD_TWIN: Record<string, number> = { PL: 39, ELC: 40, PD: 140, SA: 135, BL1: 78, FL1: 61, DED: 88, PPL: 94 };

export const FOOTBALL_RULES: Record<string, LeagueRules> = {
  // England
  PL: fb(FB_GD, [z('cl', 1, 4), z('europe', 1, 6), z('relegation', 18, 20)]),
  ELC: fb(FB_GD, [z('promotion', 1, 2), z('promo_po', 3, 6), z('relegation', 22, 24)]),
  AF41: fb(FB_GD, [z('promotion', 1, 2), z('promo_po', 3, 6), z('relegation', 21, 24)]),
  // Spain (head-to-head first)
  PD: fb(FB_H2H, [z('cl', 1, 4), z('europe', 1, 6), z('relegation', 18, 20)]),
  AF141: fb(FB_H2H, [z('promotion', 1, 2), z('promo_po', 3, 6), z('relegation', 19, 22)]),
  // Italy (head-to-head first)
  SA: fb(FB_H2H, [z('cl', 1, 4), z('europe', 1, 6), z('relegation', 18, 20)]),
  AF136: fb(FB_H2H, [z('promotion', 1, 2), z('promo_po', 3, 8), z('releg_po', 16, 17), z('relegation', 18, 20)]),
  // Germany: 16th plays the relegation play-off against the 2. Bundesliga's 3rd
  BL1: fb(FB_GD, [z('cl', 1, 4), z('europe', 1, 6), z('releg_po', 16), z('relegation', 17, 18)]),
  AF79: fb(FB_GD, [z('promotion', 1, 2), z('promo_po', 3), z('releg_po', 16), z('relegation', 17, 18)]),
  // France
  FL1: fb(FB_GD, [z('cl', 1, 4), z('europe', 1, 6), z('releg_po', 16), z('relegation', 17, 18)]),
  AF62: fb(FB_GD, [z('promotion', 1, 2), z('promo_po', 3, 5), z('relegation', 17, 18)]),
  // Netherlands, Portugal
  DED: fb(FB_GD, [z('cl', 1, 2), z('europe', 1, 4), z('releg_po', 16), z('relegation', 17, 18)]),
  PPL: fb(FB_H2H, [z('cl', 1, 2), z('europe', 1, 4), z('releg_po', 16), z('relegation', 17, 18)]),
  // Turkey (head-to-head first)
  AF203: fb(FB_H2H, [z('cl', 1, 2), z('europe', 1, 4), z('relegation', 16, 18)]),
  // Split seasons
  // Scotland: 33 games, then top six / bottom six play each other once more (5 games), points kept
  AF179: fb(FB_GD, [z('cl', 1, 2), z('europe', 1, 4), z('releg_po', 11), z('relegation', 12)], { split: { after: 33, groups: [{ from: 1, to: 6, rounds: 1 }, { from: 7, to: 12, rounds: 1 }] } }),
  // Switzerland: the same 33 + 5 format
  AF207: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('releg_po', 11), z('relegation', 12)], { split: { after: 33, groups: [{ from: 1, to: 6, rounds: 1 }, { from: 7, to: 12, rounds: 1 }] } }),
  // Belgium: 30 games, then three groups home and away with the points halved (rounded up)
  AF144: fb(FB_GD, [z('cl', 1, 2), z('relegation', 16)], { split: { after: 30, halve: 'up', groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }, { from: 13, to: 16, rounds: 2 }] } }),
  // Austria: 22 games, then top six / bottom six home and away with the points halved (rounded down)
  AF218: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('relegation', 12)], { split: { after: 22, halve: 'down', groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }] } }),
  // Denmark: 22 games, then top six / bottom six home and away, points kept
  AF119: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('relegation', 11, 12)], { split: { after: 22, groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }] } }),
  // Israel: 26 games, then top six home and away (10 games), bottom eight once (7 games)
  AF383: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('relegation', 13, 14)], { split: { after: 26, groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 14, rounds: 1 }] } }),
  // Scotland's Championship: 36 games
  AF180: fb(FB_GD, [z('promotion', 1), z('promo_po', 2, 4), z('releg_po', 9), z('relegation', 10)]),
  // Other single-table leagues
  AF307: fb(FB_GD, [z('relegation', 16, 18)]),
  AF106: fb(FB_H2H, [z('cl', 1), z('europe', 1, 3), z('relegation', 16, 18)]),
  AF103: fb(FB_GD, [z('cl', 1), z('releg_po', 14), z('relegation', 15, 16)]),
  AF113: fb(FB_GD, [z('cl', 1), z('releg_po', 14), z('relegation', 15, 16)]),
  AF71: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('relegation', 17, 20)]),
  AF98: fb(FB_GD, [z('relegation', 18, 20)])
};
/**
 * Football leagues whose season is not one table (conferences + play-offs, Apertura / Clausura with zones): the
 * simulator skips them until their format is modelled; data health lists them with the reason.
 */
export const FOOTBALL_SKIP: Record<string, string> = {
  AF253: 'MLS: two conferences + play-offs (not modelled yet)',
  AF128: 'Argentina: zones + play-offs (not modelled yet)',
  AF262: 'Liga MX: Apertura / Clausura + Liguilla (not modelled yet)'
};

const bb = (tiebreaks: TieKey[], zones: Zone[], extra: Partial<LeagueRules> = {}): LeagueRules => ({ sport: 'basketball', tiebreaks, zones, known: true, ...extra });
export const BASKETBALL_RULES: Record<string, LeagueRules> = {
  // NBA: each conference apart; 1–6 into the play-offs, 7–10 the play-in for seeds 7 and 8; four best-of-7 rounds
  NBA: bb(['pts', 'h2h', 'conf', 'pd'], [], { groupBy: 'group', post: { kind: 'bracket', seeds: 8, playIn: true, perGroup: true, bestOf: [7, 7, 7], final: 7 } }),
  // EuroLeague: 1–6 play-offs, 7–10 play-in, best-of-5 play-offs, then the Final Four (one game each, neutral)
  EL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [], { post: { kind: 'bracket', seeds: 8, playIn: true, bestOf: [5, 0, 0] } }),
  // Liga ACB: top 8, quarter-finals best of 3, semi-finals and final best of 5; the last two go down
  ACB: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', 17, 18)], { post: { kind: 'bracket', seeds: 8, bestOf: [3, 5, 5] } }),
  // Lega Basket Serie A: top 8, best of 5, 5, 7; the last goes down
  LBA: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', 16)], { post: { kind: 'bracket', seeds: 8, bestOf: [5, 5, 7] } }),
  // Basketball Bundesliga: 1–6 play-offs, 7–10 play-in, best of 5 throughout; the last two go down
  BBL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', 17, 18)], { post: { kind: 'bracket', seeds: 8, playIn: true, bestOf: [5, 5, 5] } })
};

export const NFL_RULES: Record<string, LeagueRules> = {
  NFL: { sport: 'nfl', tiebreaks: ['pts', 'h2h', 'div', 'conf', 'pd'], zones: [], post: { kind: 'nfl' }, known: true },
  // college: conference standings by conference record; the top two meet in the conference title game (no CFP yet)
  NCAA: { sport: 'nfl', tiebreaks: ['conf', 'pts', 'h2h', 'pd'], zones: [], groupBy: 'group', post: { kind: 'confTitle' }, known: true }
};

export function rulesFor(sport: 'football' | 'basketball' | 'nfl', code: string): LeagueRules {
  const r = sport === 'football' ? FOOTBALL_RULES[code] : sport === 'basketball' ? BASKETBALL_RULES[code] : NFL_RULES[code];
  if (r) return r;
  // unknown: one table, the usual tie-breaks, no zones
  return sport === 'football'
    ? { sport, tiebreaks: FB_GD, zones: [], known: false }
    : { sport, tiebreaks: ['pts', 'h2h', 'pd'], zones: [], known: false };
}

/** the simulator's numbers per sport (game scale: football latent probit units, else points of margin) */
export const SIM_PARAMS = {
  runs: 20000,
  football: { home: 0.2, drawBand: 0.33, sigma: 1, noise: 0.1, goalsH: 1.5, goalsA: 1.2 },
  basketball: { home: 2.5, drawBand: 0, sigma: 12, noise: 1.5, goalsH: 0, goalsA: 0 },
  nfl: { home: 1.8, drawBand: 0, sigma: 13.5, noise: 1.5, goalsH: 0, goalsA: 0 }
};

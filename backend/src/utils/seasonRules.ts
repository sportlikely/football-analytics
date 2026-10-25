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
const z = (key: Zone['key'], from: number, to = from, over?: Zone['over']): Zone => (over ? { key, from, to, over } : { key, from, to });
const fb = (tiebreaks: TieKey[], zones: Zone[], extra: Partial<LeagueRules> = {}): LeagueRules => ({ sport: 'football', tiebreaks, zones, known: true, ...extra });

/** Football: our competition code → its API-Football league (the season's fixtures live in af_fixtures). */
export const FD_TWIN: Record<string, number> = { PL: 39, ELC: 40, PD: 140, SA: 135, BL1: 78, FL1: 61, DED: 88, PPL: 94 };

/** fix230: where a rule comes from (the league's own site) and the season it was checked for */
const src = (source: string, season: string): Partial<LeagueRules> => ({ source, season });
/** fix230: new rules — their zones go live only when last season's replay beats the table order (seasonForecast.ts) */
const gated = (source: string, season: string, extra: Partial<LeagueRules> = {}): Partial<LeagueRules> => ({ ...src(source, season), gate: true, ...extra });

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
  // Turkey (head-to-head first): 18 teams, 34 rounds, the last three go down
  AF203: fb(FB_H2H, [z('cl', 1, 2), z('europe', 1, 4), z('relegation', 16, 18)], src('tff.org (Süper Lig)', '2026-27')),
  // Belgium (fix230): back to one table of 18 from 2026-27 — no play-offs, no halving; 1–4 European places, 17–18 down
  AF144: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('cl', 1), z('europe', 1, 4), z('relegation', 17, 18)], src('proleague.be', '2026-27')),
  // Split seasons (fix230: top_group = the championship round / top six after the split)
  // Scotland: 33 games, then top six / bottom six play each other once more (5 games), points kept
  AF179: fb(FB_GD, [z('cl', 1, 2), z('europe', 1, 4), z('top_group', 1, 6), z('releg_po', 11), z('relegation', 12)], { split: { after: 33, groups: [{ from: 1, to: 6, rounds: 1 }, { from: 7, to: 12, rounds: 1 }] }, ...src('spfl.co.uk', '2026-27') }),
  // Switzerland: the same 33 + 5 format; 11th plays the barrage against the Challenge League's 2nd
  AF207: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('top_group', 1, 6), z('releg_po', 11), z('relegation', 12)], { split: { after: 33, groups: [{ from: 1, to: 6, rounds: 1 }, { from: 7, to: 12, rounds: 1 }] }, ...src('sfl.ch', '2026-27') }),
  // Austria: 22 games, then top six / bottom six home and away with the points halved (rounded down: on equal points
  // the team that lost the half point ranks above)
  AF218: fb(['pts', 'rounded', 'gd', 'gf', 'h2h', 'h2hgd'], [z('cl', 1), z('europe', 1, 3), z('top_group', 1, 6), z('relegation', 12)], { split: { after: 22, halve: 'down', groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }] }, ...src('bundesliga.at', '2026-27') }),
  // Denmark: 22 games, then top six / bottom six home and away, points kept
  AF119: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('top_group', 1, 6), z('relegation', 11, 12)], { split: { after: 22, groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }] }, ...src('superliga.dk', '2026-27') }),
  // Israel: 26 games, then top six home and away (10 games), bottom eight once (7 games)
  AF383: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('top_group', 1, 6), z('relegation', 13, 14)], { split: { after: 26, groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 14, rounds: 1 }] }, ...src('football.org.il', '2026-27') }),
  // Greece (fix230): 26 games, then play-offs 1–4 and 5–8 and the play-out 9–14, home and away, points kept; 13–14 down
  AF197: fb(FB_GD, [z('cl', 1), z('europe', 1, 3), z('top_group', 1, 4), z('relegation', 13, 14)], { split: { after: 26, groups: [{ from: 1, to: 4, rounds: 2 }, { from: 5, to: 8, rounds: 2 }, { from: 9, to: 14, rounds: 2 }] }, ...gated('superleaguegreece.net', '2026-27') }),
  // Korea K League 1 (fix230): 33 games, then Final A (1–6) and Final B (7–12) once more, points kept; the champion to
  // the AFC Champions League. 2026: Gimcheon Sangmu (the army team) goes down wherever it finishes — not modelled
  AF292: fb(FB_GD, [z('cl', 1), z('top_group', 1, 6)], { split: { after: 33, groups: [{ from: 1, to: 6, rounds: 1 }, { from: 7, to: 12, rounds: 1 }] }, ...gated('kleague.com', '2026') }),
  // Scotland's lower leagues: 36 games
  AF180: fb(FB_GD, [z('promotion', 1), z('promo_po', 2, 4), z('releg_po', 9), z('relegation', 10)], src('spfl.co.uk', '2026-27')),
  AF183: fb(FB_GD, [z('promotion', 1), z('promo_po', 2, 4), z('releg_po', 9), z('relegation', 10)], gated('spfl.co.uk (League One)', '2026-27')),
  // League Two: the 10th plays the pyramid play-off against the Highland / Lowland League winners' tie
  AF184: fb(FB_GD, [z('promotion', 1), z('promo_po', 2, 4), z('releg_po', 10)], gated('spfl.co.uk (League Two)', '2026-27')),
  // Other single-table leagues
  // Saudi Pro League: 18 teams, the top two to the AFC Champions League Elite, 16–18 down
  AF307: fb(FB_GD, [z('cl', 1, 2), z('relegation', 16, 18)], src('spl.com.sa', '2026-27')),
  AF106: fb(FB_H2H, [z('cl', 1), z('europe', 1, 3), z('relegation', 16, 18)]),
  AF103: fb(FB_GD, [z('cl', 1), z('releg_po', 14), z('relegation', 15, 16)]),
  AF113: fb(FB_GD, [z('cl', 1), z('releg_po', 14), z('relegation', 15, 16)]),
  AF71: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('relegation', 17, 20)]),
  // Brazil Série B (fix230): 1–2 up, 3–6 a two-leg promotion play-off (3 v 6, 4 v 5), 17–20 down
  AF72: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('promotion', 1, 2), z('promo_po', 3, 6), z('relegation', 17, 20)], gated('cbf.com.br (Série B regulamento)', '2026')),
  AF98: fb(FB_GD, [z('relegation', 18, 20)]),
  // Japan J2 (fix230): 20 teams August–May, 1–2 up, 3–6 the J1 promotion play-off, 18–20 down
  AF99: fb(FB_GD, [z('promotion', 1, 2), z('promo_po', 3, 6), z('relegation', 18, 20)], gated('jleague.jp', '2026-27')),
  // Australia A-League Men (fix230): 26 rounds; Premiers = top of the table; finals: 3 v 6 and 4 v 5 at 3 and 4, then
  // two-legged semi-finals against 1 and 2 (the best left meets the worst), the grand final at the better placed
  AF188: fb(FB_GD, [z('shield', 1)], { post: { kind: 'bracket', seeds: 6, byes: 2, reseed: true, bestOf: [1, -3, 1] }, ...gated('aleagues.com.au', '2026-27') }),
  // MLS (fix230): two conferences of 15; in each 1–7 straight in, 8 v 9 the wild card (one game at 8); round one best
  // of three (no draws: penalties), then one game at the better seed; MLS Cup at the better record. Supporters' Shield
  // = the best record of the whole league
  AF253: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('shield', 1, 1, 'league')], { groupBy: 'group', groupsFrom: 'provider', post: { kind: 'bracket', seeds: 8, playIn: 'wildcard', perGroup: true, bestOf: [3, 1, 1], final: 1 }, ...gated('mlssoccer.com (2026 MLS Cup Playoffs format)', '2026') }),
  // USL Championship (fix230): East 13 / West 12, the top eight of each into a fixed one-game bracket, the final at
  // the better record; Players' Shield = the best record
  AF255: fb(['pts', 'wins', 'gd', 'gf', 'h2h'], [z('shield', 1, 1, 'league')], { groupBy: 'group', groupsFrom: 'provider', post: { kind: 'bracket', seeds: 8, perGroup: true, bestOf: [1, 1, 1], final: 1 }, ...gated('uslchampionship.com', '2026') }),
  // Liga MX (fix230): Apertura and Clausura are separate tables (17 games); from the Apertura 2026 no play-in again:
  // the top eight into the Liguilla, two legs every round, quarter-finals 1 v 8 … then re-seeded; level on aggregate the
  // better seed goes through, the final goes to extra time and penalties. No relegation
  AF262: fb(['pts', 'gd', 'gf', 'h2h'], [], { rounds: 'tournament', post: { kind: 'bracket', seeds: 8, reseed: true, bestOf: [-2, -2, -3] }, ...gated('ligamx.net (Apertura 2026)', 'Apertura 2026') }),
  // Argentina (fix230): Apertura and Clausura, 30 teams in two zones of 15 (16 games: the zone, a derby, one
  // interzonal); the top eight of each zone crossed (1A v 8B …), one game at the better placed up to the semi-finals,
  // the final on neutral ground. Annual table (both tournaments): its leader is "Campeón de Liga", its last goes down
  // (the second relegation place, the three-season average table, is not modelled)
  AF128: fb(FB_GD, [z('shield', 1, 1, 'annual'), z('relegation', -1, -1, 'annual')], { rounds: 'tournament', groupBy: 'group', groupsFrom: 'schedule', post: { kind: 'cross', seeds: 8, bestOf: [1, 1, 1, 0] }, ...gated('ligaprofesional.ar', 'Clausura 2026') })
};
/**
 * Football leagues whose season is not modelled at all (fix230: MLS, Argentina and Liga MX are now in FOOTBALL_RULES):
 * the simulator skips them; data health lists them with the reason.
 */
export const FOOTBALL_SKIP: Record<string, string> = {};

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
  BBL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', 17, 18)], { post: { kind: 'bracket', seeds: 8, playIn: true, bestOf: [5, 5, 5] } }),
  // fix230 — the rest of the big leagues (each: the source and the season it was checked for; gated by the replay)
  // EuroCup 2026-27: four groups of eight (home and away); the top four of each into the play-offs (best of 3, the
  // pairings across groups set by the league): play-off places only, no title line
  EC: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('playoffs', 1, 4)], { groupBy: 'group', groupsFrom: 'schedule', noTitle: true, ...gated('euroleaguebasketball.net/eurocup', '2026-27') }),
  // Basketball Champions League 2026-27: eight groups of four; the winner to the Round of 16, 2nd and 3rd to the
  // play-ins (best of 3 against the next group): the next round's places only
  BCL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('playoffs', 1), z('playin', 2, 3)], { groupBy: 'group', groupsFrom: 'schedule', noTitle: true, ...gated('championsleague.basketball', '2026-27') }),
  // ABA League 2026-27: first phase two groups of ten; the top four of each into the Top 8 (the rest: the play-out)
  ABA: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('top_group', 1, 4)], { groupBy: 'group', groupsFrom: 'schedule', noTitle: true, ...gated('aba-liga.com', '2026-27') }),
  // Basketbol Süper Ligi: 16 teams, top 8 (no play-in), quarter-finals best of 3, semi-finals and final best of 5; the
  // last two go down
  BSL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', -2, -1)], { post: { kind: 'bracket', seeds: 8, bestOf: [3, 5, 5] }, ...gated('tbf.org.tr', '2025-26') }),
  // Greek Basket League: top 8, the first two rounds best of 3, the final best of 5; the last goes down
  GBL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', -1)], { post: { kind: 'bracket', seeds: 8, bestOf: [3, 3, 5] }, ...gated('esake.gr', '2025-26') }),
  // LNB Élite (Pro A): 7–10 play-in, quarter-finals best of 3, semi-finals and final best of 5; 15th the relegation
  // play-off, 16th down
  LNB: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('releg_po', -2), z('relegation', -1)], { post: { kind: 'bracket', seeds: 8, playIn: true, bestOf: [3, 5, 5] }, ...gated('lnb.fr', '2025-26') }),
  // LKL: nine teams, four rounds (32 games); top 8, quarter-finals best of 3, semi-finals and final best of 5
  LKL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [], { post: { kind: 'bracket', seeds: 8, bestOf: [3, 5, 5] }, ...gated('lkl.lt', '2025-26') }),
  // NBL Australia: 1–2 straight to the semi-finals, 3–6 the play-in for seeds 3 and 4; semi-finals best of 3, the
  // championship series best of 5
  NBL: bb(['pts', 'h2h', 'h2hpd', 'pd'], [], { post: { kind: 'bracket', seeds: 4, playIn: true, playInFrom: 3, bestOf: [3, 5] }, ...gated('nbl.com.au', '2025-26') }),
  // CBA: 20 teams, 42 rounds; top 12, 1–4 wait out round one (5 v 12 …); rounds best of 3, 3, 5, 7 (re-seeded)
  CBA: bb(['pts', 'h2h', 'h2hpd', 'pd'], [], { post: { kind: 'bracket', seeds: 12, byes: 4, reseed: true, bestOf: [3, 3, 5, 7] }, ...gated('cba.net.cn', '2025-26') }),
  // NBB Brazil: 20 teams home and away; top 16, best of 5 every round (1 v 16 …); the last two go down
  NBB: bb(['pts', 'h2h', 'h2hpd', 'pd'], [z('relegation', -2, -1)], { post: { kind: 'bracket', seeds: 16, bestOf: [5, 5, 5, 5] }, ...gated('lnb.com.br (NBB regulamento)', '2025-26') })
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

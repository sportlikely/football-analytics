/**
 * fix223: the data-health "League settings fresh (<sport>)" line (leagueSettingsHealth.ts), every sport, for the sport
 * parity check (frontend/scripts/parity-check.ts reads this file).
 */
export const PARITY_PROVIDES = [
  { sport: 'football', keys: ['health.leagueSettings'] },
  { sport: 'basketball', keys: ['health.leagueSettings'] },
  { sport: 'nfl', keys: ['health.leagueSettings'] },
  { sport: 'tennis', keys: ['health.leagueSettings'] }
];

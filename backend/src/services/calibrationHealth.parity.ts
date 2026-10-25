/**
 * fix220: the data-health "Calibration (<sport>)" line (calibrationHealth.ts, said vs happened per band), every sport,
 * for the sport parity check (frontend/scripts/parity-check.ts reads this file).
 */
export const PARITY_PROVIDES = [
  { sport: 'football', keys: ['health.calibration'] },
  { sport: 'basketball', keys: ['health.calibration'] },
  { sport: 'nfl', keys: ['health.calibration'] },
  { sport: 'tennis', keys: ['health.calibration'] }
];

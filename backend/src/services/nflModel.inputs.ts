/** fix206: what SL American Football looks at, in plain words (see gridModel.inputs.ts for the rules; checked by scripts/how-it-works.test.ts). */
export const MODEL_INPUTS = {
  sport: 'american-football',
  files: ['nflModel.ts'],
  inputs: [
    { key: 'elo', label: 'Team strength (Elo)', detail: 'A rating from every result, where bigger wins count more, carried over between seasons.', code: ['elo'] },
    { key: 'qb', label: 'Quarterback', detail: "The starting quarterback's recent passing value; when the usual starter is out on the injury report, his backup's.", code: ['qbValue', 'injuredOut'] },
    { key: 'efficiency', label: 'Efficiency', detail: 'Yards per play for and against, turnovers and third downs, used only where it improves the test results.', code: ['efficiency'] },
    { key: 'home', label: 'Home field', detail: 'The usual home-field edge, and none at neutral sites such as international games and the Super Bowl.', code: ['hfa', 'neutral'] },
    { key: 'rest', label: 'Rest and bye weeks', detail: 'Extra rest after a bye week, less after a short week.', code: ['bye'] }
  ]
} as const;

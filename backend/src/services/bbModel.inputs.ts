/** fix206: what SL Basketball looks at, in plain words (see gridModel.inputs.ts for the rules; checked by scripts/how-it-works.test.ts). */
export const MODEL_INPUTS = {
  sport: 'basketball',
  files: ['bbModel.ts'],
  inputs: [
    { key: 'ratings', label: 'Team ratings', detail: 'Attack and defence ratings from every game, also measured per possession, updated after each result.', code: ['possessionsOf'] },
    { key: 'players', label: 'Player strength', detail: 'How good the players a team used in its last games are, from their numbers in every league we follow.', code: ['talent'] },
    { key: 'rest', label: 'Rest and back-to-backs', detail: 'Days of rest, and a penalty for the second night of a back-to-back.', code: ['b2b', 'restHome'] },
    { key: 'home', label: 'Home court', detail: "Each team's own home-court edge, learned from its results.", code: ['hca'] },
    { key: 'injuries', label: 'Injuries (NBA)', detail: "In the NBA, players listed out on the official injury report are taken out of the team's strength.", code: ['injuryLoss'] }
  ]
} as const;

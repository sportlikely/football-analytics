/** fix206: what SL Tennis looks at, in plain words (see gridModel.inputs.ts for the rules; checked by scripts/how-it-works.test.ts). */
export const MODEL_INPUTS = {
  sport: 'tennis',
  files: ['tennisModel.ts'],
  inputs: [
    { key: 'surface', label: 'Surface ratings', detail: 'An overall rating for each player and one for each surface: hard, clay and grass.', code: ['surface'] },
    { key: 'points', label: 'Serve and return points', detail: 'How well each player wins points on serve and on return, turned into games, sets and the match, point by point.', code: ['Markov'] },
    { key: 'fatigue', label: 'Fatigue', detail: 'Matches, sets and minutes played in the last days, and a long match the day before.', code: ['fatigue'] },
    { key: 'format', label: 'Match format', detail: 'Best of three or best of five sets: the longer the match, the more often the stronger player wins.', code: ['bestOf'] },
    { key: 'breaks', label: 'Breaks and comebacks', detail: 'A player coming back from a long break or a recent retirement.', code: ['stoppage'] }
  ]
} as const;

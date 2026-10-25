/**
 * fix206: the how-it-works pages' text (English keys; translations in frontend/src/locales/*.json),
 * the plain-data part only (no imports), so scripts/how-it-works.test.ts can load it with Node. Used by howItWorks.ts.
 */

export type HiwSport = 'football' | 'basketball' | 'american-football' | 'tennis';
export const HIW_SPORTS: HiwSport[] = ['football', 'basketball', 'american-football', 'tennis'];


/* ---------- the page text (English keys; the translations live in frontend/src/locales) ---------- */

export const SPORT_TEXT: Record<HiwSport, { title: string; faqAccuracy: string; mainPick: string; predicts: string[] }> = {
  football: {
    title: 'How our football predictions work',
    faqAccuracy: "How accurate are SportLikely's football predictions?",
    mainPick: 'Main pick: the double chance.',
    predicts: [
      'The chance of a home win, a draw and an away win.',
      'Our pick: the double chance, the two most likely results together. 85% or more is a strong pick.',
      'Expected goals, both teams to score and over / under goals.',
      'A live win chance during the match.'
    ]
  },
  basketball: {
    title: 'How our basketball predictions work',
    faqAccuracy: "How accurate are SportLikely's basketball predictions?",
    mainPick: 'Main pick: the winner.',
    predicts: [
      'The chance of each team winning.',
      'Our pick: the team more likely to win. 70% or more is a strong pick.',
      'The expected margin and total points.',
      'A live win chance and projected final score during the game.'
    ]
  },
  'american-football': {
    title: 'How our American football predictions work',
    faqAccuracy: "How accurate are SportLikely's American football predictions?",
    mainPick: 'Main pick: the winner.',
    predicts: [
      'The chance of each team winning.',
      'Our pick: the team more likely to win. 70% or more is a strong pick in the NFL, 75% in college football.',
      'The expected margin and total points.',
      'A live win chance and projected score during the game.'
    ]
  },
  tennis: {
    title: 'How our tennis predictions work',
    faqAccuracy: "How accurate are SportLikely's tennis predictions?",
    mainPick: 'Main pick: the winner.',
    predicts: [
      'The chance of each player winning.',
      'Our pick: the player more likely to win.',
      'The most likely set score and the expected total games.',
      'A live win chance that moves with the score.'
    ]
  }
};

export const HIW_TEXT = {
  intro: '{0} is our own model. Here is what it predicts, what it looks at and how we check it, in plain words.',
  description: 'What {0} looks at, how every prediction is saved before the start and checked after it, and how accurate it has been in each competition.',
  hPredict: 'What we predict',
  hInputs: 'What the model looks at',
  hTest: 'How we test it',
  test: [
    'Every prediction is saved before the start and never edited.',
    'After the game it is checked against the result, automatically.',
    'Every competition counts, the easy ones and the hard ones.',
    'A change to the model goes live only if it does better on games it never saw.'
  ],
  hCant: "What it can't do",
  cant: [
    'Upsets happen. A 70% pick still loses about 3 times in 10, and that is what 70% means.',
    'No model knows everything: late injuries, weather, motivation and news after we save the pick can change a game.',
    'Our numbers are probabilities, not promises.'
  ],
  // fix215: the season forecast (football, basketball, American football; tennis has no league season)
  hSeason: 'How the season forecast works',
  season: [
    'We play the rest of the season 20,000 times, game by game, with the same model as our match predictions.',
    'Each game uses our prediction for it: the chance of each result and, in football, the likely score, so goal difference counts too.',
    'Each run also moves every team’s strength a little, because form changes over a season.',
    'The league’s own rules decide the final table: points, tie-breaks, split seasons, play-ins and play-offs.',
    'A team’s chance of the title, Europe, the play-offs or relegation is the share of runs where it happened.',
    'The forecast runs again 10 minutes after every finished game of the league, and every night.'
  ],
  seasonCheck: 'We replay last season week by week with only what was known then. Its accuracy appears here once it beats simply reading the table as it stands.',
  seasonAccuracy: 'Last season replayed week by week: Brier score {0}, against {1} for reading the table as it stood. Lower is better.',
  hModel: 'Model and version',
  live: '{0} went live on {1}.',
  notLive: '{0} is not live yet.',
  changelogLink: 'See every change in the changelog',
  hAccuracy: 'Accuracy by competition',
  accuracyNote: 'Last 365 days, competitions with at least 20 finished games.',
  brierNote: 'Brier score: how far our chances were from what happened. Lower is better, 0 would be perfect.',
  accuracyEmpty: 'Not enough finished games yet. A competition appears here once it has 20.',
  colCompetition: 'Competition',
  colGames: 'Games',
  colMain: 'Main pick right',
  colBrier: 'Brier score',
  hFaq: 'Questions and answers',
  faqAccuracyA: 'Over the last 365 days our main pick was right in {0}% of {1} games. Every pick is saved before the start and checked after the game.',
  faqAccuracyNone: 'We count every game from launch day. There are not enough finished games yet for a fair number.',
  faq70Q: 'What does a 70% chance mean?',
  faq70A: 'In games like this one, that result happens about 7 times in 10. So a 70% pick still loses about 3 times in 10.',
  faqEditQ: 'Are predictions changed after the start?',
  faqEditA: 'No. Each prediction is saved before the start and never edited. Until the start it can still move when new team or player news comes in.',
  faqInputsQ: 'What does the model look at?',
  faqInputsA: 'Mainly: {0}. The full list is on this page.',
  faqModelQ: 'Which model do you use?',
  faqModelA: '{0}, our own model, live since {1}. Every change is tested on games the model never saw before it goes live.',
  faqModelANew: '{0}, our own model. Every change is tested on games the model never saw before it goes live.',
  changelogTitle: 'Changelog',
  changelogIntro: 'What changed on SportLikely, newest first: our models and the site.',
  changelogDescription: 'Every change to the SportLikely prediction models and the site, newest first, in plain words: new versions, new sports and new competitions.',
  kindModel: 'Model',
  kindSite: 'Site',
  allSports: 'All sports'
} as const;

/** Every English key the pages use, with the model input lists (scripts/how-it-works.test.ts checks all six locales). */
export function hiwStrings(inputs: Record<HiwSport, readonly { label: string; detail: string }[]>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(HIW_TEXT)) for (const s of Array.isArray(v) ? v : [v]) out.add(s);
  for (const s of HIW_SPORTS) {
    const x = SPORT_TEXT[s];
    [x.title, x.faqAccuracy, x.mainPick, ...x.predicts].forEach(k => out.add(k));
    for (const i of inputs[s]) { out.add(i.label); out.add(i.detail); }
  }
  return [...out];
}


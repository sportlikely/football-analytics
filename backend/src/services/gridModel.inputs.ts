/**
 * fix206: what SL Football looks at, in plain words, for the /how-it-works page (and its search-engine copy). Plain data,
 * no imports. `code` = ids or names that must exist in the model's own files (`files`): scripts/how-it-works.test.ts
 * fails when one disappears, and football's '#…' rows must cover every row the model uses (TEAM_ROW_IDS + DRAW_ROW_IDS
 * in gridModel.ts). Change a model's inputs → change this list in the same commit. Labels are English keys, translated
 * in frontend/src/locales/*.json.
 */
export const MODEL_INPUTS = {
  sport: 'football',
  files: ['gridModel.ts', 'h2hGuard.ts', 'nationalElo.ts', 'clubElo.ts'],
  inputs: [
    { key: 'ratings', label: 'Team ratings', detail: 'A strength rating built from every result, plus attack and defence ratings against teams of the same level.', code: ['#1e', '#19', '#14'] },
    { key: 'form', label: 'Recent form', detail: "Points from each team's last six games.", code: ['#21'] },
    { key: 'lineups', label: 'Injuries and line-ups', detail: 'Regular starters missing through injury or suspension, and the confirmed starting eleven about an hour before kick-off.', code: ['#13', '#12'] },
    { key: 'rest', label: 'Rest days', detail: 'How many games each team has played lately and how much rest it had.', code: ['#10'] },
    { key: 'h2h', label: 'Head-to-head', detail: 'The last ten meetings, plus a common-sense check: a team with clearly worse form, table and head-to-head is never made the favourite.', code: ['#7', 'commonSense'] },
    { key: 'squad', label: 'Squad strength', detail: "The market value of each team's 15 most valuable players.", code: ['#1'] },
    { key: 'home', label: 'Home advantage', detail: "The usual home edge, plus each team's own home and away record.", code: ['#23', 'homeGap'] },
    { key: 'draws', label: 'Draw signals', detail: 'How often these teams and this league draw, and derbies or big-stakes games.', code: ['#15', '#30', '#16'] },
    { key: 'cups', label: 'National teams and European cups', detail: 'Separate rating models for national teams and for European club cups, built from their own results.', code: ['elo-intl', 'elo-euro'] }
  ]
} as const;

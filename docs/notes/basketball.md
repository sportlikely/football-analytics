# Basketball — data, leagues, model bb-v3, result checks

Code: `basketball.ts` (API-Basketball sync, `BB_LEAGUES`, box scores, `fixFieldGoals`), `bbModel.ts` (bb-v1 ratings, bb-v2
possession ratings, blend, player talent, backtests, `buildAll`, `predictGame`), `bbSite.ts` (pages, `bbLeagues`),
`bbPlayers.ts`, `bdl.ts` (balldontlie NBA), `bbInjuries.ts`, `bbResults.ts`, `bbLive.ts` (live win chance), `bbLeagueConfig.ts` /
`bbLeagueCoverage.ts` (leagues added from Admin). Frontend `pages/bb/*`, `lib/bb.ts` (`BB_ORDER`, `BB_COUNTRY`). `BASKETBALL_PUBLIC=1` opens the
site to everyone; before that only admins see it. Launch target: 18 Oct 2026.
Admin endpoints: `/api/bb/status`, `/api/bb/sync`, `/api/bb/backtest`, `/api/bb/wf?code=` (cols id, pHome, margin, total),
`/api/bb/export?code=[&players=1]`, `/api/bb/live-test[?tune=1][&a=&b=]`.

## Leagues (18, 8 Oct 2026; code · API-Basketball id)
NBA 12 · EuroLeague EL 120 · Liga ACB 117 · Lega Basket Serie A LBA 52 · BSL Turkey 104 · LNB Pro A 2 · BBL Germany 40 ·
Greek Basket League GBL 45 · LKL 60 · EuroCup EC 194 · Basketball Champions League BCL 202 · ABA 198 · FIBA Europe Cup FEC 201 ·
NBL Australia 1 · B.League JBL 56 · CBA China 31 · NBB Brazil 26 · BSN Puerto Rico 76 (counted in the record since fix203).
Left out: NCAA (no box scores), Israeli league (never). Leagues added from Admin get code `BB<id>`, start "in testing" (admin label only since fix203).
Data: 5 seasons per league (`bb_games`, `bb_team_stats`, `bb_player_stats`), live scores once a minute while a game is on
(`timer` = minutes played in the period). From 2025-26 API-Basketball's "field goals" are 2-pointers only → `fixFieldGoals`
adds the 3s back by checking against the final score.

## Model bb-v3 (8 Oct 2026) — live
- v1: attack/defence point ratings updated game by game (k, carry-over r, back-to-back penalty, learned team home edge);
  v2: offensive/defensive rating per 100 possessions + pace; fixed 50/50 blend; calibration stretch ×1.05 (probit);
  player talent: game score per minute per player (decay 0.995, shrunk toward 0 with 800 minutes), team talent =
  minutes-weighted value of last game's players (NBA last 5), shift 0.12 × gap/13. NBA injuries from balldontlie's injury
  report (every 15 min) lower a team's talent before tip-off.
- Test, 14,308 games after each league's tuning season: log loss 0.5751, 69.3% picks right; picks of 70%+ 81.7% right.
  Calibration honest in every band (50–55% → 52.1% … 90%+ → 96.5%).
- Per league hit rate: GBL 76, ABA 77, CBA 74, LNB 72, LKL 71, BSL 71, NBB 71, ACB 69, FEC 69, B.League 68, LBA 67, BBL 66,
  BCL 67, NBA 66.5, NBL 64, EuroCup 63, EuroLeague 62 (lots of parity, probabilities still much better than "always home"),
  BSN 62 (= constant home rate → in testing).
- Tested and rejected (no gain or worse): rest across leagues, cup/EuroLeague midweek fatigue, 3-in-4 / 3-in-7, team-specific
  home edge in v1, per-league blend weights, finer learning rates, calibration per league, neutral Final Four, clipping big
  wins, domestic rating as an input for the cups, advanced player stats (PIE, plus-minus, net rating: no better than game
  score), head-to-head and tier/matchup residuals (worse — in basketball H2H adds nothing once strength, form, rest and
  talent are in; show it on the page and mention one-sided H2H in the text, don't change probabilities).
- What would help: knowing who plays (Europe has no injury feed; "missed the last game" doesn't help).

## Live win chance (fix110, 13 Oct 2026, `bbLive.ts`)
- What it shows (Yarin, 13 Oct): live win % for both teams + projected final score (and total), updated every minute
  with the live score sync. Where: game page box under the score ("was X%" vs tip-off), game rows (the team ahead on
  live % + projected score on wide screens), the live sidebar box, the basketball home live hero and a new "Live now"
  card on league pages (refreshes every minute while a game is on). Same access as the pre-game numbers: hidden for
  locked picks and while "guess first" covers the game.
- Model: from the bb-v3 prediction saved at tip-off. Expected margin still to come = sigma · probit(pHome) × share of
  regulation left; a share `b` = −0.4 of the current lead is given back in proportion to the time left (leads shrink);
  spread of what is still to come = league sigma × (share left)^(a/2), a = 0.7. P(home) = Φ(mean / sd) (a tie → OT ≈
  50/50 with the same tilt). Projected score = current score + pre-game points × share left, the margin part shifted by
  the same lead give-back. At tip-off it equals the pre-game prediction exactly.
- Clock: share left from status Q1–Q4 + `timer` (whole minutes played in the quarter), HT = half, BT = after the last
  quarter with points, OT = (5 − timer) / regulation. Quarters 12 min in NBA and CBA, 10 in FIBA leagues (the game-page
  clock now uses CBA = 12 too).
- Test (no server database from the cloud session): public NBA quarter scores (ESPN schedules via sportsdataverse,
  2020-21 … 2023-24, 4,872 games) with a stand-in margin rating as the pre-game model (64.3% right; bb-v3 NBA is 66.5%).
  Fit a / b on 2020-22, tested on 2022-24 (2,495 games):

  | checkpoint | live log loss | a = 1, b = 0 | score only (no pre-game) | picks right | projected score off by (per team) |
  |---|---|---|---|---|---|
  | after Q1 | 0.567 | 0.581 | 0.616 | 70.2% | 8.0 pts |
  | half-time | 0.488 | 0.508 | 0.528 | 76.4% | 6.7 pts |
  | after Q3 | 0.358 | 0.369 | 0.373 | 83.8% | 4.7 pts |

  Calibration within ~3 points in every 10% band at all three checkpoints. Tried and rejected: using the scoring pace so
  far for the projected score (every blend with the pace was worse than the pre-game points alone).
- To do after deploy: open `/api/bb/live-test?tune=1` (all leagues, bb-v3's walk-forward predictions, quarter scores
  in `bb_games`; tune = fit on older seasons, score on each league's newest). Change `BB_LIVE_CONF` only if the test
  season improves; look at per-league numbers for FIBA leagues (40-minute games).

## Result checks (fix99, `bbResults.ts`)
- Provider sent Wizards–Pistons swapped. Now every 30 min for games of the last 10 days: NBA compared with balldontlie
  (auto-corrected, source 'balldontlie'); all leagues: box-score points equal to the swapped score → "swapped?" flag, quarters
  that can't add up → "quarters" flag. Flagged games show "Result being checked", stay out of the record, email the admin.
  Admin tools on the game page (Save score / Swap / Provider is right / Undo) and a "Basketball results to check" card.
  Corrections (`bb_result_fix`) survive provider updates. NBA pre-season has no second source → manual.

## Featured game on the basketball home (Yarin, 11 Oct)
Only NBA or a big EuroLeague game: NBA season → EuroLeague with two big clubs (Real Madrid, Barcelona, Olympiacos,
Panathinaikos, Fenerbahçe, Efes, Žalgiris, Monaco, Partizan, Crvena zvezda, Olimpia Milano, Virtus Bologna, Bayern,
Baskonia) or play-offs/Final Four → NBA pre-season → brand card.

## balldontlie (GOAT plan, key `BALLDONTLIE_KEY`)
Used for NBA injuries, player bios/advanced stats/game logs, team squads, box-score extras, league leaders. Not used:
lineups (published after tip-off), play-by-play, odds/props (never), fantasy. Tables `bdl_*`, admin `/api/bb/bdl?path=`.

## Open
- Live win chance: check `/api/bb/live-test?tune=1` on the server (all leagues). Player photos and 10 missing team logos
  (licensed source needed).
- Points line for users' picks = average total of both teams' last 10 games, rounded to .5 (not the model's total).

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

## Basketball model 4.0 — bb-v4 grid, every league (fix219, 25 Oct 2026) — public "SL Basketball 4.0"
Football v3's structure for basketball: 13 rows per game (each a value per team as it was before tip-off), margin =
Σ weight × (home − away) in points, P = Φ(stretch × margin / sigma), sigma = the league's miss widened by 3-point
volatility; game page "1,000 points split" (components/sport/game/GridSplit.tsx, inside "How we calculated it").
Code: `utils/bbGridMath.ts` (rows, conversion, split, pattern search), `services/bbGrid.ts` (walk-forward row builder per
league, in the bb model thread; `bb_grid_rows` for the tuner / gate, `bb_grid_imp` keeps the impact parts so a build
refits only new windows), `services/bbTuner.ts` (tune, gate, live prediction). Admin card "Basketball model v4 (grid)";
`/api/bb/tune?train=2022,2023,2024&test=2025[&apply=1]` (job thread; 2026+ refused), `/api/bb/tuned[?reload=1|clear=1]`
(settings in `bb_tuned`, applied without a redeploy; code defaults = the fit below). `BB_GRID=on|off` overrides the gate.
- **Rows:** #1 player impact of the expected rotation (fix217's ridge, per league; 40-minute FIBA games: 200 minutes, cap
  35) · #2 net rating per 100 possessions (ridge on team indicators, same windows) · #3 team rating = bb-v3's whole
  prediction as a margin (see below) · #4 missing players (rotation players who missed the last 2 games; live NBA: the
  injury report + confirmed starters, fix217) · #5 four factors for / against (eFG%, TOV%, OREB%, FT rate, Dean Oliver
  weights, shrunk to the league) · #6 rest (−1 back-to-back, −0.5 third game in 4 days) · #7 home court (league + team;
  EuroLeague / BCL final fours neutral) · #8 carry-over (players who stayed, fading by game 25) · #9 matchups (shooting,
  rebounds, turnovers: style against style) · #10 form (last 10 against bb-v1's expectation) · #11 motivation (−1 late in
  the regular season under 30% wins) · #12 3-point attempt share (widens sigma) · #13 head-to-head (last 3, 2 years).
  Not built (no data): travel km / time zones (needs an arena table), playoff-race motivation (needs standings history).
- **#3 decision (train seasons only):** with bb-v1's points rating as #3 (the brief), the grid was worse than bb-v3 *on its
  own training seasons* (2022–24: 0.5829 vs 0.5815) and on 2025 (0.5813 vs 0.5792), all three groups failing the gate —
  information missing (bb-v3's possession ratings and talent), not overfitting. With bb-v3's whole team rating as #3:
  train 0.5787. Chosen on the train seasons; the test numbers below were looked at once.
- **Fit (train 2022-23 … 2024-25, 17,147 games, 18 leagues; pattern search from the starting weights, offsets for NBA and
  B.League (1,500+ train games), stretch per league):** split (points per row of 1,000): #3 team 648 · #1 impact 174 ·
  #5 four factors 50 · #7 home 43 · #13 H2H 29 · #10 form 22 · #4 missing 17 · #6 rest 11 · #8 carry-over 4 · #9 / #11 1 ·
  #2 net rating 0 (unused once #3 is in) · #12 widens sigma (0.675 × volatility). Weights in `GRID_DEFAULT`.

| test season 2025 (2025-26 / calendar 2025), log loss | games | bb-v3 | bb-v4 | games 1–25: bb-v3 | bb-v4 | gate |
|---|---|---|---|---|---|---|
| NBA | 1,315 / 385 | 0.5952 | **0.5945** | 0.6046 | **0.6023** | ✔ |
| Europe (12 leagues pooled) | 3,028 / 2,397 | 0.5817 | **0.5790** | 0.5720 | **0.5689** | ✔ |
| Rest of the world (NBL, JBL, CBA, NBB, BSN) | 2,111 / 1,110 | 0.5651 | **0.5640** | 0.5697 | **0.5694** | ✔ |
| All | 6,454 / 3,892 | 0.5791 | **0.5772** | 0.5746 | **0.5723** | |
| All, who actually played in place of #4 (the injury-feed ceiling) | 6,283 | 0.5779 | 0.5750 | | | |

Per league (test): better in 14 of 18 (EC 0.615→0.602, FEC 0.553→0.545, LNB 0.593→0.586, LKL, BSN, LBA, EL, ACB, JBL, CBA,
NBB, BBL, BSL, NBA), worse in ABA (+0.002), BCL (+0.003), GBL (+0.005), NBL (+0.015); hit rate about the same (69.1% vs
69.2%). The gate is per group, so those four follow their group. Live period (2026-27 / 2026, reported, never tuned):
better in 10 of 15 leagues with games (small samples; BSN 245 games: 0.670 → 0.664). NBA: by the train-only rule the grid (2023-25 0.5993) replaces fix217's NBA v4
(0.5999); fix217's injury / line-up re-pricing feeds #4.
- **Guards:** data health "Basketball model rows (bb-v4) within their usual range" (upcoming 48 h, a row more than 3 sd
  from its training spread warns; rest / motivation flags skipped) + "NBA vs backtest" (fix217); the 07:00 report lists
  bb-v4 vs bb-v3 per league for 2 weeks (market favourite: no basketball odds feed, n/a).

## Tuned on the live database + calibration layer (fix222, 25 Oct 2026) — public "SL Basketball 4.1"
Live 25 Oct: /api/bb/tuned stored:false (the code defaults from the 10 Oct research ran live); data health "Calibration
(Basketball)" failed: 60–70% said 64.7%, happened 58.4% (178 games).
- **Tune on the live database (worker):** jobs.ts "bb tune (auto)" ~20 min after a start, then hourly checks: due when
  nothing was tuned on this database yet, or the last automatic run is 30+ days old. runTune({ auto }) in the job thread:
  train 2022–24, test 2025 (GRID_TRAIN / GRID_TEST), applied only when at least one group passes the gate with the new
  weights and the 2025 log loss is not worse than with the settings live now; every run is kept in bb_tuned 'auto'
  (applied or not, why). Admin card: "Fitted on live data at <time> · train … → test …"; the 07:00 report has the line
  with the next re-tune date. Manual /api/bb/tune?apply=1 still works (the monthly clock follows the automatic runs).
- **Calibration layer (utils/sportCalib.ts, services/sportCalibration.ts):** fix220's Platt layer per league (a ≥ 0.05:
  monotone), each league's fit shrunk toward the all-leagues fit (150 games' worth). Rows: bb-v4's walk-forward rows
  (bb_grid_rows) as the live model shows them (bb-v4 where the group passes the gate, else bb-v3). Fit 2022–2024 → test
  2025; a league keeps its layer only when it beats raw on its 2025 games (100+; fewer = the all-leagues verdict); live
  layer 2022–2025; 2026+ reported, never fitted. Applied in predictGame to every shown chance (pRaw kept;
  bb_predictions.p_raw); built ~25 min after a start, after an applied tune, then daily (job thread 'bb calib'); state
  'calib:bb'. Strong line per league (fix220's rule): the lowest chance from which the calibrated 2025 picks were right
  ≥ 75% (bbStrongLine; the record, the lists, the game page and the picks email use it; predictions saved before the
  layer keep 70%). /api/admin/calibration?sport=basketball (&rebuild=1), table on the admin card.
- **On the 10 Oct copy (all 18 leagues built here, 88 s):** the auto tune passes all three groups (17,147 train, 6,454
  test games; 2025 log loss 0.5774 → 0.5774, applied). bb-v4 is already calibrated on 2025: bands 50–60 said 55.0 /
  happened 53.6, 60–70 65.0 / 65.6, 70–80 74.7 / 74.7, 80–90 84.8 / 81.6, 90+ 94.4 / 94.0; the layer moves log loss
  0.5774 → 0.5771 (kept in 12 leagues, near identity). The live season (633 games to 10 Oct) is worse and over-confident
  (log loss 0.630; 60–70 said 64.9 / happened 61.3) and the layer barely moves it (0.6296 → 0.6290). By games played,
  past seasons' first games are calibrated too (2025 games 0–4: 60–70 said 65.1 / happened 66.4), so this is a
  live-vs-backtest gap, not an early-season pattern a layer on past seasons could learn. **So the layer alone will not
  turn "Calibration (Basketball)" green if the live gap stays.** Next step (needs Yarin's decision, it breaks fix220's
  "the live season is never fitted"): an in-season layer fitted walk-forward on this season's own earlier games (fit on
  games before day D, used after D, kept only if it beats the season layer on the later days); or find the input that
  differs live (as fix220 suspected for college QBs). Strong lines on 2025 (fix220 rule): 60% in most leagues (picks of
  60%+ were right ~76%), EL 70%, BBL 68%, ACB 67%, JBL 64%, EC 63%, LKL 76% — lower than the old 70%: if "Strong" should
  stay rarer, change the rule in sportCalib.buildLayer (strongLine) for every sport at once.
## Key players, star rest, injuries from news (fix224, 25 Oct 2026)
- Card: top 5 per team by rating × projected minutes from the grid snapshot (`TeamSnap.pl`: players of the last 10 games),
  "without him" = the model's points (row #4 weight × the strength lost when his minutes go to the rest of the rotation —
  more than his own share when the bench is below average). Reasons line at 1.5+ points.
- Rest patterns (`bb_rest_rates`, daily): keep = 1 − sat / (chances + 3); used with 4 chances (NBA) / 3 (EuroLeague double
  weeks) and a 15% rate. Walk-forward (10 Oct copy, each chance priced from earlier games only, settings chosen on 2024-25):
  2025-26+ Brier of "he plays" NBA 0.0679 → 0.0658, EuroLeague 0.1312 → 0.1233 (+1 / 20%: 0.0659 / 0.1263, over-predicted
  28% sitting against 22–23% real). Not yet: the game-level log loss with / without (needs the server's rows; bb_rest_log
  names the games). `BB_REST=off` keeps the card and turns the model part off.
- News injuries (`bb_news_injuries`): every league but the NBA; precision first (admin review list, dismissed never return).

### In-season layer (fix222b, 25 Oct 2026) — behind a switch, off by default
- Yarin chose to build it (25 Oct). A second Platt layer on top of the season layer, fitted on this season's finished
  games (bb-v4's walk-forward rows of the live season, the season layer applied first), one fit per league shrunk toward
  the all-leagues fit (utils/sportCalib.ts inSeasonLayer). Test, walk-forward by day: each day's games calibrated with a
  fit on the games before that day only (the first 300 games of the season only fit); kept only when that beats the
  season layer by 0.0005 log loss over 200+ tested games. Live fit: every finished game of the season so far, rebuilt
  every 6 h with the calibration job. This is the one place a live season is fitted — always on games before the one
  predicted.
- Used only when the switch is on AND the test passed: Admin → "Basketball model v4 (grid)" → Calibration layer → In-season
  layer "Switch on / off" (`/api/admin/calibration?sport=basketball&inseason=on|off`, stored in sport_calib
  'basketball-inseason', security log "bb_inseason_layer"); `BB_INSEASON=on|off` in Railway overrides it. Switching
  rebuilds the layer and re-saves the next 7 days' predictions.
- 10 Oct copy: 633 live games, 325 tested walk-forward (from 25 Sep): season layer 0.5988 → with it 0.6026 → **not
  kept** (too early in the season). On the server (≈3,200 live games by 25 Oct) the card shows the verdict.

## NBA model v4 — bb-v4 (fix217, 25 Oct 2026) — public "SL Basketball 4.0"
(fix219: the grid above replaces this as the NBA base when the NBA group passes its gate; the re-pricing stays.)
Why: live NBA 2026-27 started 14/30; the gap to the market is same-day information (injuries, rest, starters).
Code: `utils/nbaImpact.ts` (ridge fit, rotation, replay, tuner — pure), `services/nbaV4.ts` (replay in the bb model thread,
live state `bb:v4`, gate, re-pricing, admin check), `bbModel.predictGame` → `nbaV4Adjust` for NBA games. Admin card
"NBA model check" (`/api/admin/nba-model-check`). Other leagues stay bb-v3.
- **Player impact ratings:** ridge regression of every regular-season game's margin on minutes (home +min/48, away −min/48,
  a home term), last 3 seasons weighted 1 / 0.5 / 0.25, lambda 30; refit at each season's first regular-season game and every
  14 days (walk-forward: a fit only sees earlier games; pre-season games never rate anyone). No data / rookie: −1.0.
- **Team strength** = Σ rating × projected minutes / 48 over the top 10, scaled to 240 (cap 42 a player). Projected minutes =
  his last 15 regular-season games (any team); no regular-season games yet → pre-season minutes × 0.7. Roster = players in
  the team's last 3 games (pre-season included, so summer moves count from the first game).
- **Final margin** = w × bb-v3 (its whole prediction as a margin, 12 × probit p: ratings, home edge, rest, talent) + 0.2 ×
  player-impact margin + 1.4 × what the same-day information changes in it + 0.5 home − 0.5 back-to-back (each side);
  w = 0.6 at a team's first game of the season → 0.75 after 15; P = Φ(margin / 12). Tuned by `tuneV4` on 2023-24 + 2024-25
  only (2022-23 is the first season in our database: the ridge fit has no earlier seasons there, it is the warm-up);
  2025-26 is the test season; `assertTuneSeasons` throws for 2025-26 / 2026-27.
- **Tried first and rejected (tune seasons):** the brief's form on bb-v3's neutral rating gap (0.6/0.5 team + 0.6 impact + 1.5
  home − 1.5 b2b): log loss 0.6055 on 2023-25 vs bb-v3 0.6028, 2025-26 0.5959 vs 0.5952 (fails "no worse"). bb-v3's own
  numbers on our database are stronger than the browser test's "current" model (2025-26 0.595, not 0.614).
- **Same-day information:** balldontlie injury report (every 15 min): Out = 0 min, Doubtful 25%, Questionable / day-to-day
  60%; freed minutes go to the next players (the 11th man joins the top 10, everyone scales to 240). Line-ups from balldontlie
  `/v1/lineups` when it has them (usually only after tip-off): confirmed starters play; a full list (10+) drops roster
  players not on it. Re-priced at 90, 30 and 10 min before tip-off (worker job "nba reprice", every minute: fresh report if the
  last is 4+ min old, line-ups, the game re-saved); the prediction recorded is the last one saved before tip-off. Every
  re-pricing is logged (`bb_v4_log`: players removed, margin before / after). bb-v3's old injury points are not added on top.
- **Weight of same-day information:** we hold no old injury reports, so it was tuned with who really played as the
  stand-in (the rotation of the players in the box score, with their projected minutes): 1.4 against 0.2 for the projected
  rotation — knowing who plays is worth far more than guessing it.

| 10 Oct database, walk-forward | games | bb-v3 log loss · Brier · right | v4 log loss · Brier · right |
|---|---|---|---|
| 2023-24 + 2024-25 (tune) | 2,649 | 0.6028 · 0.2074 · 67.2% | 0.5999 · 0.2066 · 67.0% |
| **2025-26 whole season (test)** | 1,315 | 0.5952 · 0.2048 · 68.1% | **0.5930 · 0.2039 · 68.0%** |
| **2025-26 games 1–25 (test)** | 385 | 0.6046 · 0.2086 · 67.5% | **0.6016 · 0.2076 · 67.0%** |
| 2025-26 games 26+ (test) | 930 | 0.5913 · 0.2032 · 68.4% | 0.5894 · 0.2024 · 68.4% |
| 2025-26, who plays known (stand-in for the injury report) | 1,262 | 0.5934 · 0.2041 · 68.5% | 0.5885 · 0.2019 · 68.4% |
| 2022-23 (warm-up, not tuned on) | 1,217 | 0.6521 · 0.2292 · 63.0% | 0.6482 · 0.2280 · 63.4% |

Calibration 2025-26 (v4, favourite's side): 50–60% → 54.6% right, 60–70% → 66.4%, 70–80% → 75.5%, 80%+ → 85.5%.
- **Gate (in code, every build, `v4Gate`):** 2025-26 whole season no worse ✔, games 1–25 better ✔ (above), and this season's
  finished games (20+, out of sample) better than the saved bb-v3 chances — not in the 10 Oct copy (no 2026-27 games yet):
  the server decides. Pass → mode `full` (bb-v4 recorded); fail → `reprice` (bb-v3 stays the base, only the injury /
  line-up part moves it, recorded as bb-v3). `NBA_V4=full|reprice|off` overrides. Both chances of every NBA game are saved
  (`bb_v4_shadow`): side by side on the admin card and in the daily model report for 2 weeks.
- **Guard:** data health "NBA vs backtest" — every basketball league with 50+ finished games in 30 days warns when its hit
  rate is more than 8 points under its backtest.
- Next: the same player-impact structure for the EuroLeague (no injury feed there: rosters + minutes only).

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
- fix217 after deploy: Admin → "NBA model check": the gate's "this season" row (needs 20 finished games) decides full v4 or
  re-pricing only; check that the first re-pricing rows (90 / 30 / 10 min) list removed players for teams with injuries, and
  whether balldontlie line-ups ever arrive before tip-off (the "line-ups" tag). If the gate says re-pricing only, change the
  changelog line (it says v4 rates every player) or set NBA_V4.
- Live win chance: check `/api/bb/live-test?tune=1` on the server (all leagues). Player photos and 10 missing team logos
  (licensed source needed).
- Points line for users' picks = average total of both teams' last 10 games, rounded to .5 (not the model's total).

## Per-league settings (fix223, 25 Oct 2026) — like football's league tune
- **What:** a league's own home edge (points added to #7 off a neutral court), stretch (× the shared stretch), sigma (× its
  typical miss: the league's spread of results against the model's margin relative to every league's, shrunk toward 1
  with 400 games' worth) and offsets for the 4 big rows (#1 impact, #3 team rating — bb-v3's points rating + possessions +
  talent, the grid's "points rating" —, #4 missing, #6 rest), pulled toward the shared settings by a ridge prior
  Σ((θ − θ₀)/τ)² / 2n (τ: home 1 pt, stretch 0.1, rows 2 steps), so the fewer games, the stronger the pull.
- **Gate (utils/leagueSettings.ts, used by every sport):** leagues with 400+ games in 2022-23 … 2024-25: fit 2022-23 +
  2023-24, kept only when it beats the shared model on 2024-25 by 0.0005 log loss (100+ games), then refitted on all
  three; 2025-26 = the untouched check (reported), 2026-27+ reported, never tuned (assertLsYears throws). Smaller
  leagues pooled by group (Europe second tier, Asia, Americas, Oceania, Africa: from bb_leagues.country, Israel like any
  country), fitted and gated the same way; members use the group's settings when the group passed.
- **Code:** `utils/bbGridMath.ts` (LeagueSet, fitLeagueSet, spreadOf, regionGroup; gridEval / split1000 apply it),
  `services/bbTuner.ts` runLeagueTune (job thread 'bb league tune'; bb_tuned 'leagues' = the kept settings + the shared
  settings they were fitted on: a later shared tune makes them stale, not used, until the refit), `/api/bb/league-tune
  [?apply=1]`, admin card "League settings (fix223)", data health "League settings fresh (Basketball)". Worker
  (jobs.ts "bb tune (auto)"): shared tune when due → league settings when due (first run, shared settings changed, 30+
  days) → the calibration layer again. 07:00 report line.
- **Shared tune first-store rule:** the server still showed stored:false / "default (fix219 research, 10 Oct database)"
  on 25 Oct — fix222's run is not applied when the 2025 log loss is not ≤ the code defaults', and those defaults were
  fitted on the 10 Oct copy. Now, while nothing is stored on a database, the first run is applied when the gate passes;
  "not worse than live" from the second run on; the fix222 run that stored nothing is due again once (rule 'fix223').
  `/api/bb/tune?apply=gate` does the same by hand.
- **10 Oct copy (24,234 rows, 18 leagues, every league 400+ train games, so no group used):** shared tune (17,147 train /
  6,454 test games) applied under the first-store rule: 2025 log loss 0.5774 → 0.5774, gate NBA 0.5952 → 0.5945, Europe
  0.5820 → 0.5794, rest of the world 0.5651 → 0.5639 (games 1–25 all better too). League settings on top: **only BSN
  kept** (2024 0.6719 → 0.6701; untouched 2025 0.6601 → 0.6577; live 245 games 0.6641 → 0.6648): home +1 pt, stretch
  ×0.98, sigma ×1.007, offsets #1 −0.04, #3 −0.04, #6 −0.125. Every other league's own fit lost on 2024 (ABA, BCL, LBA,
  NBB by 0.004–0.008: noise fitted on two seasons). All leagues: 2024 0.56959 → 0.56941, 2025 0.57741 → 0.57732, live
  0.62958 → 0.62981. So the shared model already carries most of what differs between leagues (per-league stretch,
  NBA / JBL offsets); the server's own run decides there.

## Row #4 missing players on who actually played (fix228, 25 Oct 2026)

Why: the first tune on the live database (25 Oct) gave #4 18 of 1,000 points (fix219 default 150). 2022-25 have no injury
reports, so in history #4 is only "rotation players who missed the last 2 games" — a weak proxy. The live injury feed and
confirmed line-ups (fix217 / fix224) could never earn weight in a tune on those rows.

- **Oracle rows**: every finished game already keeps `oracle` in bb_grid_rows (fix219): the strength of the rotation of
  the players who actually played (box score) minus the expected rotation's, home − away, in points (impact ratings ×
  projected minutes). That is what the injury report + confirmed line-up tell us before tip-off.
- **Fit** (`bbTuner.runMissFit`, maths `bbGridMath.fitMiss / fitProxy / missGate`): NBA oracle rows of 2022-23 … 2024-25
  → #4 weight + star factor (value × (1 + star × |value|), 0 … 0.5); every weight refitted, only #4 and the star kept.
  Other leagues (no injury feed): the proxy weight fitted the same way on their own stored rows, capped by the NBA's.
  Then the shared tune around the frozen #4 (`GridParams.miss`). Test 2025-26; 2026-27+ never in train.
- **Gate**: NBA 2025-26 games with who played known better than the settings live now, the whole 2025-26 season of
  every league no worse (inputs as live has them). The bb-v4 vs bb-v3 gate per group reads the NBA with #4 = 0 (fair:
  bb-v3 had no injury information in history).
- **Live**: NBA #4 = injury report + confirmed starters (+ the fix224 rest pattern before the report confirms), 0
  without them — never the "missed the last games" proxy. Other leagues: proxy + news / rest at their own weight.
- **Frozen**: no league offset or league setting moves #4; the monthly re-tune and the league settings keep it. A new
  fit only from Admin → "#4 Missing players" (Preview / Fit, store if the gate passes) or `/api/bb/missing-fit`.
- **Results**: not run on real data in the session that built it (no database copy). The weight, star, test gain and
  split before / after are in the admin card and the morning report after the worker's first run.

## Key players count more: box-score value + on/off, star factor (fix225, 25 Oct 2026)
Why (live test 25 Oct, 3 NBA seasons): game-level on/off ratings blur a star with his teammates (Jokić +3.0–4.4, Payton
Pritchard #2, Kevin Huerter top 10) because we have minutes per game, not who shared the floor; public impact ratings put
Jokić ~+10. Bulls–Wizards: the on/off model had the Bulls by 6 (Trae Young −0.7, Davis +1.5, the rest −1 to −4.5).
- **Box-score value** (`utils/boxValue.ts`, BPM-style): points, shot attempts (FGA + 0.44 FTA: the efficiency term),
  3-pointers made, rebounds, assists, per game length (48 NBA / CBA, 40 FIBA: one formula for every league) × league
  pace / team pace, minus the league-season mean. Steals, blocks and turnovers are NOT in our player box scores
  (API-Basketball gives them per team only): the team adjustment carries the team's share. Team adjustment: one constant
  per team-season so Σ value × minutes / (games × L) = the team's opponent-adjusted net rating per game. The
  coefficients are fitted on game margins with the players' season rates without that game (`fitBoxCoef`, every league
  pooled, 2022-23 … 2024-25 only: `assertBoxTrain`), once per database by the model build before the replay
  (`bbGrid.fitBoxFormula`, bb_tuned 'box'; code default 0.75 / −0.7 / 0.3 / 0.25 / 0.55). Last season's value carries
  (traded players keep theirs, any team); this season blended in by minutes, full weight at 800 (40-min leagues 667).
  No last season: NBA rookies (draft year = the season) from the draft slot (pick 1 ≈ 0, pick 30 ≈ −1.9, 2nd round −2;
  balldontlie bios by name), everyone else −1 (as before).
- **On/off with a minutes-scaled shrink**: the same ridge, each player's penalty lambda × 1,000 / his (season-weighted)
  minutes, between 0.1 × and 3 × lambda (`shrinkLambda`, `ridgeFit(…, perPlayer)`): high-minute stars barely shrunk.
- **Player impact** = wb × box value + (1 − wb) × on/off; wb by pattern search from 0.6 on the train seasons' log loss.
  The replay (`bbGrid.replayLeague`) rates every player three ways per window (fix219 on/off = C, the scaled on/off = A,
  box = B) and stores #1 / #4 / #4's top-3 part / #8 / the oracle / its top-3 part under A and B beside the fix219 rows
  (`bb_grid_rows.alt`; everything there is linear in the ratings, so any wb is a blend: `impactInputs`). The live
  snapshot keeps the three ratings per player ([id, C, minutes, since, A, B, top 3]) — the gate's answer applies without
  a rebuild. `bb_grid_imp` version `imp2|…|<formula version>`: the first build after deploy recomputes every game once.
- **Star factor (#4, NBA)**: the part of a team's lost impact that comes from its top 3 (by box value × minutes) counts ×
  factor, 1.0–1.6 (`topLoss`, `MissSet.top`; replaces fix228's `star` form when set), fitted with #4's weight on the
  fix228 oracle rows with the new values (`fitMiss(…, { form: 'top' })`), then frozen; the other leagues' proxy weight
  refitted on their rows; the shared tune around them (#4 stays frozen in every later tune, the impact setting too).
- **Gate** (`impactGate`, test 2025, each side on its own inputs as live has them — NBA #4 = who played): NBA whole
  season, NBA games 1–25, NBA who-played-known, Europe whole season, Europe games 1–25. Passes when the NBA's whole
  season and who-played-known improve and no check is worse; otherwise today's values stay (the report says why).
  `runImpactFit` (job thread 'bb impact fit', `/api/bb/impact-fit?apply=gate|1|0`, the worker once a database after
  the rows have the new values: `impactFitDue` + `impactRowsReady`), report in bb_tuned 'impact' either way.
- Live: rows #1 / #4 / #8 from the blend (`liveRows(…, imp)`), the NBA's #4 from the injury report with the grid's
  blended ratings and the top-3 part (`nbaV4.sideOf(…, gridRatings)`), the key players card / reasons / player page
  Impact read the same ratings and the star factor (a star out ≈ his points a game × #4's weight × factor).
- Admin card section "Key players count more" (formula, box share tried, #4 / star factor, the gate table, the 1,000
  points split before → after, top 20 per league before / after — the NBA should read like an MVP ballot — and 5 NBA
  teams' real with / without margin against what #4 implies before / after). Data health "Missing players row" names
  the impact setting live. Morning report line. Tests: `npm run test:fix225` (7).
- Real numbers: on the server after deploy (no basketball database copy here). If the gate keeps today's values, write
  the report's reason here.

## The gate judges each group the way it runs live (fix236, 25 Oct 2026)

- Live 25 Oct after fix228 / fix225: the stored gate said NBA "bb-v3 stays: whole season 0.5957 vs bb-v3 0.5952", Rest
  of the world "0.5674 vs 0.5635"; Europe passed. NBA game pages had no grid. The NBA comparison read #4 blind (= 0),
  but every live NBA game has the injury report + confirmed starters (fix217 / fix228). fix225 was rejected on NBA games
  1–25 0.60196 → 0.60308 with the whole season and who-played-known better.
- **Gate inputs** (`bbTuner.gateInputs` = `inputsFor(…, 'oracle')`): NBA #4 = who actually played on the test season,
  every other league its stored news / rest proxy — the same rows in `publishGridState`, `runTune`'s byGroup, the
  #4 fit, the impact fit and the calibration layer (`sportCalibration.buildBbCalibrationHere`). Whole season and games
  1–25 both on that basis; still only the test season (2025), the live period never in a gate or fit.
- **A failing group** is checked again (`gridGate` checks): without its leagues' own settings (fix223) — that variant
  may go live (`variant: 'shared'`, `groupParams` / `liveParams`: a return to the shared settings, not a new fit) —
  and, as a diagnosis only, with #4's proxy at its value before the fix228 fit and with the proxy off. If nothing
  passes, bb-v3 stays and the reason lists what was checked (admin card, under the gate table).
- **fix225 gate**: a games 1–25 check counts as worse only beyond 0.002 (`FIRST25_TOL`, noise at ~385 NBA games) when
  the whole season and who-played-known improve. The stored fit is judged again without a refit (`regateImpact`,
  `/api/bb/impact-regate?apply=gate|1|0`, the worker once a database: `impactRegateDue`), stored live when it passes.
- **Engine per group** (bb_tuned 'engine'): engine, variant, reason, basis, since (kept while the engine stays). Admin
  card (top of "Basketball model v4") and data health "Basketball engine per group" (warn when the NBA runs bb-v3).
  The game page's grid shows whenever the group's engine is bb-v4 (`gridLive`).
- Tests: `npm run test:fix236` (5). Real numbers: on the server after deploy (no basketball rows in the local copy);
  if Rest of the world still fails, the card's checks say whether the league settings or #4's proxy is the cause.

## fix238 — rows out of their usual range (26 Oct)

- Thunder – Clippers #1 19.38 (train 0.06 ± 5.40) is a real mismatch, not a broken row: NBA training rows reach −20.25 / +19.40,
  the 2025-26 test season had 8 games past 3 sd (10 Oct database).
- Test season (never tuned on), NBA, games with any row past 3 sd (#6 / #11 not judged): 219 games, bb-v3 0.4860 vs bb-v4 0.4951
  log loss (hit 77.2% vs 76.7%); per row bb-v3 better on #1 (8), #2 (16), #3 (7), #4 (64), #7 (21), #8 (81), #10 (7), #13 (27);
  bb-v4 better on #9 (10) and #12 (4). Whole season bb-v4 0.5945 vs bb-v3 0.5952.
- Rule: such a game is shown with bb-v3 where its group's test season agrees (`fallbackCheck` in utils/bbGridMath.ts, per group in
  the published grid state; under 20 games: on). A rotation that doesn't fill the game → bb-v3. Live player ratings held in the
  established players' range (`LeagueSnap.cap`); the stored training rows are unchanged.
- Not tried: a softer rule (shrink instead of switch, a per-row threshold) — would be fitted on the test season; needs its own gate.

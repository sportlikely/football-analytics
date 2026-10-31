# NFL model nfl-v1 (fix139, 16 Oct 2026) + college ncaa-v1 (fix142)

**fix292 (31 Oct):** the college layer is refitted on 2025 + 2026 (out of fold, separate FBS layer only if better) and the college model lab (ncaa-v3 candidates) — see model-lab.md.

## fix220 (25 Oct 2026): honest percentages + ncaa-v2

**Why.** Live 25 Oct, last 30 days: 237 games, 62% right; said 55.7 → 49.1% happened (57 games), 64.4 → 53.8 (65), 74.7 → 69.8 (53), 87.2 → 75.8 (62). 223 of 237 were college (63.2%; the backtest said 72–75%), NFL 6 / 14. Football and basketball had a calibration step; American football had none.

**Calibration layer** (`utils/afCalib.ts`, `services/afCalibration.ts`, read through `services/afCalibState.ts`):
- p' = σ(a · logit(p) + b), Newton fit, a ≥ 0.05 (monotone). College: one fit per segment (FBS vs FCS, conference game = same conference, other) shrunk toward the league fit (ridge, 150 games). NFL: one fit.
- Rows = the live model's own walk-forward test predictions: nfl-v2's experiment rows when nfl-v2 is adopted (stored as `model|exp-wf`), else nfl-v1's (`more-wf-1`); ncaa-v2's walk-forward rows when it passed its gate, else ncaa-v1's (`more-wf-2`). The walk-forward report now starts in 2021 (was: the last 5 seasons).
- Season S is calibrated with a fit on 2021 … S − 1; the live layer on 2021–2025. 2026 is never in a fit (`assertCalibSeasons` throws).
- Kept only when it beats the raw chances on the 2022–2025 walk-forward (per segment, one league fit, or none — the report says which and why).
- Applied to every shown chance (`predictNfl`); the expected margin stays the model's (More predictions calibrates it, fix204c). The raw chance is saved in `nfl_predictions.p_raw`.
- Strong line per league: the lowest chance where the shown (calibrated) picks of 2021–2025 were right ≥ 75% (50+ games); 70% / 75% until fitted.
- Data health "Calibration (<sport>)", every sport: last 30 days' picks by band, error when a band of 50+ games is more than 5 points off (100+ games). American football counts only predictions made with the layer.

**ncaa-v2** (`utils/ncaaV2.ts`): one pass over every college game, a game's numbers from earlier games only.
- Opponent-adjusted points per play (plays from the box score, else 70), offence and defence, this season and carried; rating = k / (k + games) × last season's end + the rest × this season (k tuned) — the early-season prior.
- Opponent-adjusted yards per play (box scores, 3+ games each). QB: the expected starter (the team's last starter — never this game's box score), ANY/A shrunk to replacement (200 attempts), a new starter (not last season's main passer, first 4 games) halfway more; the injury report's Out skips him (live).
- Rest (bye / short week), travel (state centres, away team, not at neutral sites), level (Power 2 / other FBS 1 / FCS 0), returning QB × the early-season weight.
- logit p = b + L · (wElo + wConf · conference + wMis · FBS-vs-FCS) + Σ w · x / spread, L = ncaa-v1's Elo logit. Pattern search on log loss (fix217's tuner), steps 0.4 → 0.02.
- Test: train 2021–2024, test 2025 whole season and conference games only; every season 2022 → now walk-forward (fitted on the seasons before it); 2026 reported, never tuned. Live weights: 2021–2025.
- **Gate**: ncaa-v2 goes live only if its log loss beats ncaa-v1 (as it ran in its walk-forward test) on 2025 conference games (100+). Else ncaa-v1 stays with the layer; the admin card says why.
- Noted: ncaa-v1's own backtest uses the box score's starting QB on finished games (hindsight); ncaa-v2 never does.

**Test tables (server).** Not known yet — the local database copy has no American football. After deploy: Admin → American football past seasons, last three cards (ncaa-v2 test, Calibration · NFL, Calibration · College football), or `/api/admin/nfl-model?league=2` → `calibration`. Paste here:

| | games | ncaa-v1 hit · LL · Brier | ncaa-v2 hit · LL · Brier |
|---|---|---|---|
| 2025 whole season (test) | – | – | – |
| 2025 conference games (gate) | – | – | – |
| 2026 so far (never tuned) | – | – | – |

| Calibration | raw hit · LL · Brier | calibrated | layer kept? | strong line |
|---|---|---|---|---|
| NFL, walk-forward 2022–2026 | – | – | – | – |
| NFL, 2026 saved before kick-off | – | – | | |
| College, walk-forward 2022–2026 | – | – | – | – |
| College, 2026 saved before kick-off | – | – | | |

Pipeline check only (synthetic 40-team college league, `npm run test:fix220`): gate on 2025 conference games ncaa-v2 LL 0.6658 vs ncaa-v1 0.6702 (186 games); an over-confident fixture (logit × 1.6) goes from a worst band 10+ points off to within 4 points on 2026 with a fit on 2021–2025.

## nfl-v2 experiments (fix146)

`services/nflExperiments.ts`: E1–E7b compared walk-forward (test seasons 2021 → now, fitted only on earlier seasons); adopted as nfl-v2 only if total log loss beats nfl-v1 (as it runs, incl. its blend) and hit % is not lower. Results: `/api/admin/nfl-model` → `experiments`, /american-football/past. Synthetic test (8 fake seasons): nfl-v1 with blend LL 0.5947 best, E3 efficiency 0.5969, E7 stack 0.5974, E7b trees 0.6161 (overfit) → nfl-v1 kept. Real numbers: server log after deploy.

## ncaa-v1 (fix142, college football, league 2)

Same code (`nflModel.ts`, every function takes the league), own settings tuned on college games only, stored under `model2|params` / `model2|report`. NFL settings got the new knobs fixed at the old behaviour (reg 1/3 to 1500, fcs 0, movCap 99) — the NFL walk-forward report is byte-identical to fix139 on the test data.

- **Regression between seasons**: toward the mean Elo of the team's conference (tuned share `reg`, grid 0.1–0.6), not toward 1500.
- **FCS teams** (and teams we have no row for) start `fcs` Elo below 1500 (grid 100–500).
- **Blowouts**: the margin multiplier is capped at `movCap` (grid 1.8–3.0, 99 = no cap).
- **Home field**: grids 40–130 (before 2020) / 30–120 (from 2020) — college home field is expected bigger than the NFL.
- **Neutral sites**: the venue name does not match the home team's stadium (bowls, kickoff games); without a stadium, post-season = neutral.
- **Rest / bye**, QB and efficiency: same as the NFL, only where box scores exist (last 3 seasons); the blend is kept only if it lowers the test log loss.
- **Report**: per season all games and FBS vs FBS (`seasons[].fbsOnly`, `fbs` total), baselines (home team, better record, Elo only), calibration. `GET /api/admin/nfl-model?league=2` (`&rebuild=1`).
- **Strong pick**: 75%+ (college has more mismatches).
- **Levels (fix143)**: FBS / FCS / other from conference + division (`levelOf`), schedule fallback (`classifyCollegeTeams`); games with a Division II / III team are left out of the model and the site. Report per season: all games, FBS vs FBS, FBS vs FCS.
- Test on a fake 40-team league (24 FBS / 16 FCS, 7 seasons, hidden strengths): hit 71%, LL 0.555 all games, 64.7% / 0.628 FBS vs FBS; home team baseline 64.7% / 0.653. Says only that the pipeline learns; the real numbers come from the server.


Code: `backend/src/services/nflModel.ts`. Data: `services/nfl.ts` tables (nfl_games, nfl_team_stats, nfl_player_stats, nfl_injuries). No odds anywhere.

## What it is
- **A. Elo** (538 style): start 1500, K tuned, margin-of-victory multiplier ln(|m|+1) × 2.2 / (0.001 × winner's Elo gap + 2.2),
  1/3 back to 1500 between seasons, home field tuned separately before 2020 and from 2020, rest: bye week (≥ 12.5 days) +,
  short week (≤ 5.5 days) − (both tuned), neutral site (international venues, Super Bowl) = no home field.
- **B. QB**: starter = most pass attempts in the game. QB value = rolling ANY/A ((yds + 20·TD − 45·INT − sack yds) / (att + sacks)),
  decayed 0.985 per game, shrunk (200 attempts) toward a replacement level 0.7 below the league mean (most low-sample passers are
  backups). Usual starter = most attempts over the team's recent games (older games × 0.75), so a backup becomes "usual" after
  2–3 starts. When this game's starter ≠ usual starter: Elo ± qbW × value gap (qbW tuned). Upcoming games: the usual starter
  unless the injury report has him Out / Doubtful / IR → the team's next QB by attempts this season. Inactives: the provider has
  no inactives list, so only the injury report is used.
- **C. Efficiency** (games with box scores): exp-weighted (0.15) yards per play for / against, turnovers given / taken,
  third-down %, red-zone %, sacks.
- **D. Blend**: standardised logistic on [A+B Elo gap, efficiency gaps], fitted on the training seasons only. Used only if the
  walk-forward test log loss beats A+B by 0.0005+; else A+B.
- Outputs: pHome (ties ≈ 0), expected margin (Elo gap / 25, or from the blend's p), expected total (points for / against
  ratings + league average, rate `alpha` tuned on total MAE). Strong pick = 70%+.

## Test (never on fitting data)
Each of the last 5 seasons (≥ 30 finished games, first season = warm-up): settings tuned on all earlier seasons only, then that
season predicted game by game (ratings update after each game, as live). Report per season + total: games, hit %, log loss,
Brier, margin MAE, total MAE, calibration bins 50-60/60-70/70-80/80+, baselines home team / better record / Elo only.
One log line per season: `nfl-v1 2024: hit …% LL … over … games (home …%, Elo …%) · with efficiency: …`, then a total line
saying which version is kept. `GET /api/admin/nfl-model` (admin) = the full report; `?rebuild=1` re-tunes in the background.

**Real numbers: not known yet.** The server holds the data; locally only a synthetic league was available (32 teams, 2016–2026,
built-in QB / efficiency effects). On it: A+B LL 0.6466 / hit 61.4%, with efficiency 0.6351 / 63.5% → D kept; home team 59.1%,
better record 59.3%. Those numbers only show the pipeline works — open `/api/admin/nfl-model` after the box-score backfill.

## Live
- Settings re-tuned every Tuesday (or when > 8 days old / missing; needs ≥ 200 finished games) from the NFL scheduler tick.
- Ratings replay from the stored settings whenever a game has finished (≈ 50 ms).
- Predictions of the next 9 days saved in `nfl_predictions` every 30-min tick (after the injury report) and after each final;
  frozen at kick-off (only `kickoff > now` rows are rewritten; shown only when made_at ≤ kickoff).
- Box-score backfill: last 10 seasons, newest first, 150 games (300 calls) per 30-min tick, daily reserve kept.

## Who sees what
Paid plans: numbers + why before kick-off. Free / signed-out: locked (no pick) until full time, then the numbers and ✓/✗.
Team page model tiles (Elo + rank, QB value, attack / defence ratings, next game win %): paid. Our record on a team: admins.
Backtest: admins only. NFL itself stays admin-only until `NFL_PUBLIC=1`.

## To check on the server
1. Box scores arriving for old seasons (Admin → NFL data / log "NFL box scores: n").
2. `passersOf` finds the Passing group (field names guessed: comp/att, yards, touch downs, interceptions, sacks "n-yds").
   If `data.withQb` in the report is 0, the names differ → fix the regexes.
3. The report: keep D only if it beats A+B; does qbW tune above 0? (On synthetic data the QB effect was small.)

## Live ratings (fix156, 17 Oct 2026)
The live engine is built once (background, with yields) and each newly finished game is added on top with `pre` + `update` — the same steps a full replay does, so the numbers match (checked: 0.000 points). A full replay still runs in the background every 6 h, after a re-tune, and when a result arrives more than 12 h out of order. Games and box-score lines are cached (`loadGames` signature, rowid-incremental `loadCtx` / `loadEffBox`).

## Level settings (fix223, 25 Oct 2026)
- Per level — NFL, FBS (both teams in the power conferences), G5 (other FBS games), FCS (an FCS team plays, FBS-vs-FCS
  included) — a home edge (probit units, off a neutral field only) and a stretch on the live model's walk-forward
  chance: p' = Φ(stretch · Φ⁻¹(p) + home), shrunk toward the shared model (home 0, stretch 1). Same gate as basketball
  (utils/leagueSettings.ts): 400+ games in 2022–2024 → fit 2022 + 2023, kept only when it beats the shared model on
  2024, refit 2022–2024; 2025 the untouched check, 2026 reported, never tuned; small levels pooled as "College".
  No row offsets: nfl-v1 / ncaa-v1 / v2 have no grid rows (their weights are tuned in their own walk-forward).
- Built inside the calibration build (services/afCalibration.ts, AF_VERSION fix223-1 forces one rebuild): the layer is
  then fitted on the chances with the settings and applied after them (afCalibState.calibrated(league, p, seg, game)).
  Report: /api/admin/nfl-model → calib report `settings`. Not run locally (no current American football copy here).

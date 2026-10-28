# Tennis model tennis-v1 (fix190, 20 Oct 2026)

Admin only: no pages, no public routes. Code: `backend/src/services/tennisModel.ts`. Data only from our own tables
(`services/tennis.ts`, see `tennis-data.md`). **Singles only.** Market prices are **never a model input**: they are an
admin benchmark only.

Admin:
- `GET /api/admin/tennis-model` returns the walk-forward report, the live settings, the progress of a running build, the
  live ratings state and the market benchmark. `?rebuild=1` rebuilds the report in the background (minutes).
  `?retune=1` re-tunes only the live settings.
- `GET /api/admin/tennis/predictions?status=upcoming|done&tour=slam|atp|wta|challenger|itf&limit=200` returns the saved
  predictions with the outcome, plus the live record (winnerBands + by-confidence bands, per tour). The record counts
  from the deploy day (`tennis_model_store.deploy_day`). It only uses predictions made before the start.

## Scope

- **Training:** every singles match we hold (ATP, WTA, Challenger, ITF, qualifying; the 2015–2022 ATP / WTA archive
  first). Left out of training and testing: juniors, UTR, exhibitions, and team events (Davis Cup, BJK Cup, Laver Cup,
  United Cup, Hopman). Exclusion uses the tier, the archive level `D`, or the tournament name.
- **Predicted and tested:** Grand Slams (main draw + qualifying), ATP, WTA (WTA 125 counts as WTA) and Challenger.
- **ITF:** predicted for admins, not in the test, never a strong pick.
- **Walkover / abandoned / unresolved:** void. These matches change no rating and are not in the record.
- **Retirement (or default) after the start:** counts for the winner in the record. In the ratings it moves `ret` (tuned)
  of a normal result. A retirement also feeds the "stoppage in the last 30 days" feature.

## A. Elo

- Each player has an overall Elo and one per surface (hard, clay, grass; indoor hard counts as hard).
- Rating used = `ws·surface + (1−ws)·overall`, with `ws` tuned per surface.
- K = `K0 / (matches + off)^shape` (538 style), times a level multiplier tuned per group: Slam, 1000 (incl. Finals and
  Olympics), 500, 250, Challenger (incl. WTA 125), ITF.
- **Best of 5:** the Elo gap is multiplied by `bo5` (tuned).
- **New player:** starts from his as-of ranking. Rank → Elo is `a − b·ln(rank)`, fitted on players with 25+ matches
  whose rank at the time is known. The test only fits on matches before 2024. With no known rank, the start uses a
  typical rank for the level of his first match (qualifying lower).
- **The test never uses a later ranking.** As-of ranks come from the archive rows and from tennis_rankings dates on or
  before the match. Live predictions use the current ranking.
- **60+ days without a match:** the rating is pulled toward the rank-based start (`pull`, tuned), and the "why" line
  says he is returning.
- **Archive player ids:** if the archive row has the same id and name as our player, that id is used. Otherwise the
  archive player is matched to a unique player with the same full name (or initial + last name). With no match, he
  keeps his own archive identity.

## B. Serve / return points + Markov chain

- **Strength per player:** a serve strength and a return strength, each a deviation from the tour mean.
  - Exp-weighted by time (`hl`, half-life in days, tuned).
  - Opponent-adjusted. Each observation is corrected by the opponent's current return / serve strength.
  - Kept overall and per surface, blended with `lam` (tuned).
  - Shrunk to the mean by `prior` points (tuned).
  - Weight = points × coverage. A partial tape counts less.
- **Means:** running serve-point means per gender × surface.
- **Match-up:** p1 serve point % = mean + p1 serve − p2 return, and the same for p2. Clamped to 20–95%.
- **The chain:** point → game → tiebreak → set → match. It follows the real format:
  - BO3 / BO5.
  - Every set: a 7-point tiebreak at 6-6.
  - Deciding set rule, per tournament:
    - **Slams since Mar 2022:** a 10-point tiebreak at 6-6.
    - **Match-tiebreak events:** a 10-point match tiebreak instead of the set. An event counts as one when most of its
      stored deciding sets read 1-0 or 8+ games. A tour event has no advantage final set.
  - Who serves first is 50/50.
- **What the chain gives:** win chance, set scores (2-0 … 0-2, BO5 3-0 … 0-3), total games (mean, median, chance over
  18.5–24.5 / 34.5–40.5) and the first-set winner.
- **Checked on simulated matches** (40,000 each, three formats). Win chance, mean games and straight-set chance are
  within the simulation's noise.

## C. Context (each group kept only if it lowers the walk-forward log loss)

Every value is p1 minus p2:

- **Fatigue:** matches in the last 3 / 7 / 14 days, sets and hours in the last 7, and a long match (3 sets or 150+ min)
  in the last 36 h.
- **Stoppage:** a medical timeout / retirement (tennis_stoppages) or a retirement loss in the last 30 days.
- **Home:** player country = tournament country. IOC codes, ISO codes and names are mapped to one code.
- **Surface switch:** his first match on this surface in 30+ days.
- **Ranking trend:** ln(rank 3 months ago) − ln(rank now). This only works where rank history exists, so it will mostly
  be 0 until tennis_rankings has months of dates.

## D. Blend

- The blend is a logistic model of [Elo logit, point-model logit, kept context] with **no intercept**, so it is symmetric
  in p1 / p2. The archive rows have p1 = the winner, so that matters. It is fitted with Newton steps and L2 regularisation
  on standardised inputs.
- `mode` = blend only if its walk-forward log loss beats Elo alone **and** the point model alone. Otherwise it is the best
  single one.
- **Sets and totals:** both serve-point chances move by the same shift until the chain's win chance equals the final
  win chance. Then the chain is read, so every output agrees with the final number.

## Test (never on fitting data)

- **Walk-forward by month**, Jan 2024 → the last full month. Each month is predicted with settings tuned only on the
  matches before it:
  - Elo and the point model are tuned on 2023-01 → the month before, on tested matches only.
  - The first month runs a 2-pass coordinate search from the defaults.
  - Later months take one step from the previous month's best settings.
  - The blend is refitted every month on the months before it.
- **How the tuning stays cheap:** each Elo / point-model setting is evaluated in **one full replay**, keeping the log
  loss per month. Ratings are online, so a replay that stops at month M predicts the same as the full one up to M. Each
  month's tune is then a sum over the months before it, not a new replay.
- **Run time:** on 18k synthetic matches the whole build took ~7 s (654 Elo settings, 23 point-model settings). On the
  server's ~400–500k matches expect a few minutes, in 30 ms slices. The worst event-loop stall measured locally was 60 ms.
- **When it starts:** only once the monthly backfill has reached 2023-01 (`tennis_meta` `pkg:2023-01`). Until then
  the tick says "waiting".
- **Report contents:**
  - Per tour (all, slam, atp, wta, challenger) and per surface (with a tour split): n, hit rate, log loss, Brier,
    calibration bands 50–60 / 60–70 / 70–80 / 80+, and hit rate when 70%+ sure.
  - Baselines on the same matches:
    - Higher-ranked player wins. This uses the rank at the time where we have it, else today's ranking, which looks
      ahead and so flatters the baseline. `withTodaysRanking` counts those.
    - Elo only.
    - Point model only.
  - Sets: hit rate of the most likely set score. Total games: mean absolute error, and over/under accuracy at the median
    line (median + 0.5).
  - Monthly table with the chosen settings, which context groups were tried and kept, and the rank → Elo fit.
- **Strong pick line per tour:** the lowest of 65 / 70 / 75% where the test hit rate is ≥ 75% (30+ picks). If no line
  reaches it, the line is 75 and `reached: false`.
- **Logging:** one log line per tour, plus the walk-forward Elo / point / blend line.
- **Market benchmark (admin only, stored in `tennis_market_bench`, never public):**
  - Up to 500 random tested ATP / WTA / Slam matches.
  - One call each to `/history/matches/{id}/prices` (Pro, first page).
  - Uses the last quote before the start (or at love). The mid is a probability when ≤ 1, else decimal odds → 1/odds.
    The two sides are normalised.
  - Compared with our test prediction, Elo only and point model only.
  - Runs after each report build, under the quota reserve.

## Live

- **Settings:** stored in `tennis_model_store` (`settings`, `report`, `test_preds`, `deploy_day`).
- **Weekly:** re-tuned on Monday from 04:00 Israel time (one neighbour pass from the current settings on 2023 → now; the
  rank map is refitted on everything). When a new full month is in, the whole report is rebuilt instead. Tuning waits
  while the live sync runs.
- **Ratings:**
  - Replayed in slices once a day or after a re-tune.
  - New results are added after each results job (`tennisResultsHook` from tennis.ts `syncHistory`) and on every tick.
    That covers finished matches of the last 3 days not yet counted.
  - Older rows that change (a tape added, a restatement) wait for the daily replay.
- **`tennis_predictions`:**
  - Columns: match_id, model, scheduled_at, cat, p1, sets JSON, games JSON, first_set_p1, why (lines + numbers),
    made_at, first_p1, first_at.
  - The next 48 h are predicted every 30 min until the scheduled start, then frozen. The first version is kept in
    first_p1 / first_at.
- **"Why" lines (fixed rules):**
  - Surface Elo gap ≥ 40.
  - Serve-point edge ≥ 2 points.
  - Long match in the last 36 h.
  - Returning after 60+ days.
  - 2+ more matches in the last 7 days.
  - Form gap ≥ 3 wins in the last 10.
  - Head-to-head on this surface (3+ meetings only).
  - Stoppage in the last 30 days.

## Settings and numbers

**Not run on the real data yet.** The server can't be reached from local tests, and the local database has no tennis
rows. The first build runs on its own once the backfill has reached 2023-01. Read the final settings (`live`) and the
report numbers from `/api/admin/tennis-model`, then write them here.

Defaults the search starts from:

- **Elo:** K0 250, offset 5, shape 0.4, levels 1.1 / 1.05 / 1 / 1 / 0.95 / 0.9, surface weight 0.5, BO5 1.15, pull 0.2,
  retirement 0.5.
- **Point model:** half-life 240 d, prior 300 points, surface blend 0.5.
- **Rank → Elo:** 2250 − 95·ln(rank).

**Synthetic check** (18k made-up matches whose truth is a serve / return model, so it only checks the code): the point
model beat Elo, the blend beat both (LL 0.576 vs 0.577 / 0.584), and every context group was rejected (they were noise
there).

## Calibration layer (fix222, 25 Oct 2026) — public "SL Tennis 1.1"

Live 25 Oct (data health): 60–70% said 64.3%, happened 53.8% (78 matches); 80%+ said 84.8%, happened 93.1%.
- Built inside the report (`buildTennisReport`, tennis worker thread) from its walk-forward chances (`pF`, the tested
  tours: Slams, ATP, WTA, Challenger): utils/sportCalib.ts — a **symmetric** Platt per tour (p' = σ(a·logit p), b = 0:
  who is listed first means nothing), each tour's fit shrunk toward the all-tours fit (150 matches' worth).
- Seasons = calendar years: fit 2024, test 2025; a tour keeps its layer only when it beats the raw chances on its 2025
  matches (100+; fewer = the all-tours verdict). Live layer fitted on 2024–2025; 2026 reported raw vs calibrated, never
  fitted. Strong line per tour = where the calibrated picks were right ≥ 75% on 2025 (`tennisStrongLine`; the old
  65 / 70 / 75 line when no layer is kept).
- Applied in `predictRow` to every shown chance (sets and totals follow the shown chance); `tennis_predictions.p_raw`
  keeps the model's own; predictions made before a new layer are recomputed on the next 30-min tick.
- Stored: tennis_model_store 'calib' + sport_calib 'tennis' (the report's `calibration` block: per tour raw vs
  calibrated, bands, the 2026 matches). The first tick after the deploy rebuilds the report once (no 'calib' of
  version fix222-1 yet; the report also re-fits the live settings, as the monthly rebuild does). `/api/admin/calibration
  ?sport=tennis` (`&rebuild=1` = the report again).
- Data health "Calibration (Tennis)" counts only predictions made with the layer (p_raw saved): green needs 100 such
  finished matches in 30 days with every band of 50+ within 5 points.
- A Platt layer moves every band the same way per tour: it cannot fix "too sure at 60–70%" and "not sure enough at 80%+"
  in the same tour at once. If the check stays red after a week, read the 2026 block of the report per tour first.
- Numbers: on the server after deploy (no tennis tables in the 10 Oct local copy).

## Tour × surface settings (fix223, 25 Oct 2026)
- Per tour × surface (slam / atp / wta / challenger × hard / clay / grass) a stretch on tennis-v1's walk-forward chance
  (symmetric: no "home", who is listed first means nothing), shrunk toward 1; small segments share their tour's. The
  walk-forward months start in 2024, so the periods are half-years: fit 2024, kept only when better than the shared
  model on 2025 H1, refit 2024 – 2025 H1; 2025 H2 = the untouched check; 2026 reported, never fitted
  (TENNIS_LS_YEARS). Built with the report (TENNIS_CALIB_VERSION fix223-1 forces one rebuild); the calibration layer is
  fitted on the chances with the settings and applied after them (predictRow). Report: sport_calib 'tennis' → settings.

## fix254 — the recent calibration layer (28 Oct 2026)

Data health failed: 60–70% said 64.9%, happened 74% (77 games). On top of the season layer, a recent layer
(utils/recentCalib.ts: isotonic on the pick's chance, walk-forward, the football daily job's promotion rules and
guardrail) is refitted nightly from 04:30 UTC (services/recentCalib.ts) on matches made with the season layer (p_raw
saved); predictRow applies it last, tennis_predictions.p_pre keeps the chance before it. Data health "Calibration
(Tennis)" counts only predictions made with a live recent layer. Admin: /api/admin/recent-calibration?run=tennis.

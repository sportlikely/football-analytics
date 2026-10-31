# Model lab (fix293, 31 Oct 2026)

A lab = every idea for a model tried on matches it never saw, one table, and the winner promoted only by a fixed rule.
Tennis (fix293) and football (fix291) have one (Yarin, 31 Oct). Admin only: nothing here reaches a public route.

## Tennis lab

Code: `backend/src/services/tennisModel.ts` (`runTennisLab`, `labPromoted`, `tennisLab`, `tennisLabText`).
Admin: Predictions & models → **Tennis lab** (`components/admin/TennisLabCard.tsx`), `GET /api/admin/tennis-lab`
(`?run=1` runs it again). It runs in the tennis model's worker thread, after that tick's predictions are saved, once per
version (`LAB_VERSION`) and once per full month. `TENNIS_LAB=off` stops it.

### Why the test is fair

- One starting point for every idea: the Elo / point-model settings the report chose for **2024-01** (tuned on 2023
  only) and the report's rank → Elo map; the blend of [Elo, point model, context] refitted every month on the months
  before it (as the report).
- **Validation = 2024** (each idea's own setting is picked here and kept when it lowers the 2024 log loss by 0.0003+ on
  top of what was kept before it). **Test = Jan 2025 → today** (2025 + 2026, the stored archive + our feed); the test is
  never used to pick anything.
- **Promotion:** the stack of kept ideas goes live when on the test it lowers the log loss by **0.0005+**, is better in
  **2025 and in 2026** alike, and the hit rate is not down by more than 0.5 pp. Otherwise the model stays as it is.
- Scores per row: log loss, Brier, hit rate, said vs happened per band (50–60 / 60–70 / 70–80 / 80+), each year, and on
  the test matches with a market price: ours vs the market's log loss. The chances compared are the model's own (before
  the calibration layers): the layers sit on top of whatever wins.

### Ideas tried (each off in the live model unless promoted)

| Family | What | Settings tried |
|---|---|---|
| elo-bleed | surface Elo: the other surfaces take a share of each step | 0.1, 0.25, 0.5 |
| elo-mov | margin of victory: a soft result from the share of games won (0.5 + 3 × (share − 0.5), clipped) | weight 0.2, 0.4 |
| elo-decay | time decay: bigger steps after a gap (up to 1 + d after 90 days away) | d 0.25, 0.5, 1 |
| elo-tourK | own K per tour (WTA × k; Slam / 1000 / … / Challenger levels were already tuned) | 0.85, 1.15, 1.3 |
| point-recent | serve / return: each new match shrinks the older ones (the last 10 / 25 matches) on top of the time half-life | 10, 25 |
| point-surface | serve / return surface split (the tuned share ± 0.25) | neighbours |
| tiebreak | tiebreak record, shrunk (6 tiebreaks' worth), ~25-match memory | on |
| clutch | break points saved / converted above the player's usual serve / return point rate | on |
| fatigue | matches 3 / 7 / 14 days, sets and hours 7 days, a long match yesterday (if the report had not kept it) | on |
| rest | days since the last match (log, capped at 60) | on |
| travel | a continent change within 10 days (time zones; the tournament country's continent) | on |
| h2h | head-to-head, shrunk (4 matches' worth) | on |
| style | big server vs returner: serve × return interaction and the serve-minus-return profile (from the point model) | on |
| market | anchor (fix278 walk-forward weight) and a learned combiner (logistic on model + market logits, refitted every 25 matches) on the test matches with a price (archive benchmark prices + `tennis_prices`) | reported |

What is promoted is part of the model from then on: the report starts from it (Elo / point settings) and keeps its
context groups before its own selection, the weekly re-tune and the live ratings use it, and the report is rebuilt once
when the promoted stack changes (`report.lab`). The market rows are reported only: live, the anchor of
`services/tennisAnchor.ts` (fitted daily on the live predictions) is the one in use.

### Results

Not run on the live data yet (the sandbox has no database copy). After the deploy the lab runs ~15–60 min after the
tennis tick; paste the card's "Copy for Claude" text here. A promoted stack = **SL Tennis 1.2** (1.1 is already the
public number): bump `version` / `since` in both modelNames files in that commit.

## Tennis winner anchor (fix293, part a)

- `tennis_prices` (the exchange mid taken 45–75 min before the start: our closing price) → player 1's margin-free chance
  (`priceP1`: a probability quote stays, decimal odds → 1 / odds, both sides normalised).
- Fit (daily, `runMarketFits`): settled tennis predictions saved before the start, the chance before the anchor
  (`p_anchor_pre`; older rows: `p1`), the closing price, the winner — fix278's `fitAnchorGroups` per **tour × surface**
  (`atp·hard` …; its own fit with 300+ matches, else the all-tours fit), kept only when the walk-forward blend beats the
  model alone and the market alone. Stored as market_anchor ('tennis', 'ml').
- Shown chance: model → tour × surface settings → season layer → recent layer → **anchor** (log-odds blend with the
  weight). No price or weight 0: unchanged. A price that arrives re-saves the prediction.
- "Close to the market (tennis)" and "Our lines vs the market" now count the settled matches with a price (winner chance:
  median |gap|, log loss ours vs market, the anchor's weight per group).

## Tennis calibration refit (fix293, part b)

The recent layer's rows are every settled match since the launch (19 Oct), also those saved before `p_raw` existed
(25 Oct). Once, on the first calibration tick after the deploy (not waiting for 04:30): the young-sport out-of-fold test
(isotonic vs Platt, 5 time blocks) on all of them; live when better on log loss over every match and the hit rate is not
down > 0.5 pp (`judgeRefit`, report `refit: "fix293"`). The nightly young rule and its rollback guard carry on after.
Before → after per band: data health "Calibration (tennis)" (the last run's table).

## Football lab (fix291, 31 Oct 2026)

**Why:** Yarin, 31 Oct — the double-chance pick is right 79.1% of the time (30 days, 1,620 games; 80%+: 85.4% on 363;
85%+: 91.5% on 247); target 82–83%. 1X2 at 60%+: 73.4% vs the market favourite 75.6%; calibration green; our goal lines
~4 points under the market on over 2.5.

**Where:** `backend/src/utils/footballLab.ts` (maths, pure), `services/footballLab.ts` (loads the games, the nightly run,
promotion / rollback), `services/footballLabLive.ts` (the promoted layer, live), Admin → Predictions & models →
**Football lab** (`frontend/src/components/FootballLabCard.tsx`), `/api/admin/football-lab` (`?run=1`), worker job
"football lab" 05:10 UTC (after the daily job 04:00, the recent calibration 04:30, the league fix 04:40; `FOOTBALL_LAB=off`
stops it). Tests: `npm run test:fix291`.

### The games and the windows

- **Seasons**: the grid-v3 walk-forward replay (`v3Tuner.v3WindowRun` with the live setting and, new, the v3 rows per
  game) of the last four seasons (2023-24 … 2026-27), the leagues with football-data.co.uk history, closing prices from
  the same files. The champion = what the site shows: v3-mix when it is live (feature-model fit trained before the game's
  season, the live mix weights per group), else grid-v3; the live market anchor on top. Note: grid-v3's row weights were
  tuned on 2024-25 + 2025-26 (6 Oct full tune), so on those seasons the *base* is in-sample — the layers are not.
  "This season so far" is out of sample for both.
- **Public record**: the last 60 days of settled games (every league), the main prediction as saved — before the lab
  layer (`predictions.lab_raw`) when it moved it; prices: the closing 1X2 line (`market_lines` 'ml') when stored, else
  the odds saved with the prediction.
- **Lab features** (walk-forward, from the feature model's fixtures in kick-off order): goals / xG / shots-on-target form
  (EWMA 0.15, my attack × their defence; shots on target × the league's goals per shot on target), each team's draw rate
  over its last 20 (shrunk to the league's), the league's draw rate, the confirmed XI's value ratio / known flag /
  previous-season rating, missing players' weight, Elo. A game without a feature-model fixture has none (layers that need
  them leave it unchanged).
- **Windows**: 2024-25, 2025-26, 2026-27 so far — each fitted only on games played before it starts (a season with fewer
  than 1,500 earlier games starts after the 1,500th game) — and the record's 60 days (fitted on everything before them).
  Judged by fix251's rule on the last two seasons (2025-26 and 2026-27 so far).

### The candidates

1. **Market anchor now** — p = (1 − a)·ours + a·market, a ∈ 0–0.6 per group (big 5 / rest; pooled below 150 priced
   games), from 80 priced games (not 300), refitted every night as the games grow.
2. **Goals model refresh** — λ per side = goals / xG / shots-on-target form (weights fitted), home factor, Poisson +
   Dixon–Coles rho, blended with the champion (β fitted). This is also the retest of the xG blend (the fitted xG weight).
   Big chances are not in the stored match stats (not used).
3. **Line-up re-rating** — the XI's value / rating and the missing players' weight move home vs away, one weight set
   per league group (v3 uses one weight for every league today). Missing players per *position*: the stored injuries
   have no position, so not tested yet.
4. **Separate draw model** — logit of P(draw) moved by the league's draw rate, both teams' draw habits, expected goals,
   closeness |H − A| and the champion's own draw; home and away keep their ratio. "Game state" is live-only (not a
   pre-match input).
5. **Learned combiner** — boosted trees (softmax, depth 3, 100 rounds, lr 0.04, min leaf hessian 60; no library) started
   from the champion's log-odds, over the champion, the market (flag + log-odds + gap), the lab features and every v3 row.
   Must beat the champion by ≥ 0.003 per game in both judged windows. Risk seen in the made-up run: when the inputs it
   trained on are missing (record games outside the history leagues) it can get worse — the record guard blocks that.
6. **Per-league pick rule** — report only: each league's threshold = the lowest in 0 / 60 … 90% whose earlier picks were
   right ≥ 82% (≥ 30 picks), else its surest; the card shows picks shown / right per window and the pooled table at
   every threshold. Showing fewer picks changes the site — Yarin decides.

### Promotion, refit, rollback

- fix251's bar (utils/dailyRules.ts constants): ≥ 300 games in each judged window, better in both, gain ≥ 0.0005 per
  game this season, better in ≥ 90% of 2,000 paired bootstrap resamples (seed 251), 1X2 hit rate not down > 0.5 pp; plus
  the record's 60 days not worse (≥ 300 games). The passing candidate with the biggest pooled gain wins; at most one
  promotion in 7 days (fix254). The same candidate passing again = refitted on every game (nightly).
- Live: `model_config` 'football_lab_live' → `applyLab` at the start of `leagueFixLive.applyLeagueFix` (both builders),
  grid-v3 and v3-mix only (feat-v1, cups, national teams untouched), before the per-league layer and fix254's recent
  calibration. The numbers before the layer go only to `predictions.lab_raw` (never on the prediction or its payload:
  an anchored number must not let anyone work a price back out).
- Guard: ≥ 100 record games since it went live and worse than no layer by > 0.005 → removed (decision "rollback").
- Public name: stays **SL Football 3.0** until a promotion; the card then says "→ SL Football 3.1" — bump
  `utils/modelNames.ts` + `frontend/src/lib/modelNames.ts` (version + since) in a commit (the name is static code).
- False positives: the 90% rule lets a lucky candidate through ~10% of the time per candidate (seen once in the made-up
  tests with a perfect champion: anchor −0.0006 at 92%); the record guard and the rollback are the safety net.

### Results

- Not run on real data in the session (no database copy; the server is not reachable from the cloud session). The
  first table is the server's run (05:10 UTC, or "run now" on the card).
- Made-up check (3 leagues × 20 teams × 5 seasons, odds from the true strengths; no feature fixtures): anchor −0.0098 /
  −0.0046 (promoted: biggest pooled gain), boosted trees −0.0091 / −0.0040 (also passed, 90% — but +0.041 on the
  120-game record without its inputs; the record guard counts from 300 games, the server's 60 days hold ~3,000), draw model −0.0016 / −0.0006 (78% of resamples), goals / line-up not fitted (no xG / XI there). Engine on
  made-up seasons with a better market and draw-prone teams: anchor and draw model found; perfect champion (3 seeds):
  nothing promoted.

## College football (FBS) lab (fix292, 31 Oct 2026)

**Why (Yarin, 31 Oct).** Last 30 days: FBS picks right 59.0% on 117 games, 80%+ only 67.7% (31), 70%+ 65.6% (61);
FCS 64.9% / 82.1% / 78.4%. The shown chances are too confident, most of all on FBS vs FBS games.

### Part 1 — the college layer refit on 2025 + 2026 (live at once)

`services/afCalibration.ts refitCollegeLayer()` (after every calibration build and once a day, job "af college refit"),
maths in `utils/collegeLab.ts refitCollege()`, applied in `afCalibState.calibrated()`:
- Rows: every settled college game of 2025 + 2026 — the live model's walk-forward chances (`calib|refitSrc`), and for 2026
  the chance really saved before kick-off (`nfl_predictions.p_raw`) when the same model made it; the level settings
  (fix223) applied first, as live.
- Out of fold, 5 folds by week. Candidates: no layer, the fix220 layer as it is (fitted 2021–2025; in-sample on 2025,
  unseen on 2026), one shared college Platt fit, a separate FBS Platt fit (FBS vs FBS games; the rest keep the shared fit).
- Separate FBS layer only when it beats the shared layer on FBS games by 0.0005 log loss (out of fold); else shared.
- The refit replaces the fix220 layer unless it is worse than it on the 2026 games (then "kept").
- **Decision (Yarin, fix292): 2026 may be in this layer's fit** (out of fold). The fix220 layer and every model weight still
  stop at 2025 (`assertCalibSeasons`, `assertLabFit`).
- Admin: /american-football/past → "College layer refit 2025 + 2026" (out-of-fold LL · hit per group, FBS bands, why).

### Part 2 — the lab

`utils/collegeLab.ts` (pure) + `services/collegeLab.ts` (inputs), run inside the fix220 build after the ncaa-v2 test.
Walk-forward: test seasons 2023, 2024, 2025, 2026 so far; for season S the Elo settings are tuned on the 4 seasons before
it (never past 2025) and the combiners fitted on 2022 … S − 1 (the live model's walk-forward chances start in 2022). Every
candidate is scored on the same games (the live model, ncaa-v1 and ncaa-v2 all have a walk-forward chance).

| id | candidate |
|---|---|
| ncaa-v1 / ncaa-v2 | as they ran in their own walk-forward tests |
| elo | margin rating in points: MOV capped, K higher for a team's first 4 games, home field, FCS start; pre-season = conference mean + carry × (last end − conference mean) + retW × returning production |
| talent | elo + roster talent: the roster's last-season box-score value from any team (transfers count), weighted by level (P4 1, G5 0.8, FCS 0.5), z within the season; + talent × early-season weight |
| home | elo + home field per team (home residuals shrunk with 15 games, × 0.7 a season) |
| conf | elo + conference strength (cross-conference residuals shrunk with 20 games, half carried) + G5 vs P4 and FBS vs FCS explicit |
| rows | logistic on all rows + the live model's chance |
| trees | boosted trees (80 × depth 2, Platt) on the same rows — the shape of nflExperiments E7b (fix291's football lab uses the same small ensemble) |
| market | closing line alone and an anchor (logistic on live model + closing line, walk-forward by week), games with a closing line only |

- Returning production / talent: box-score value per player (key-players weights, fix224). The providers give no
  historical rosters, so a season's roster = players with a box line for the team that season (+ the provider's roster for
  the live season) — a pre-season roster proxy. Games started are not in our data (games with a box line instead).
- Market: closing money lines exist from fix278 (feed of upcoming games); no older seasons, so the anchor is fitted on this
  season as it grows (80+ earlier games). The live market anchor of the shown chance stays fix278's (its own gate).
- **Promotion** (`pickWinner`): the best 2023–2025 log loss among the lab candidates, only if it beats the live model by
  0.002, is not worse on FBS vs FBS, and not worse on 2026 so far (100+ games). Then model id **ncaa-v3** (public name stays
  "SL American Football 1.1" — already 1.1 since fix220; bump to 1.2 in both modelNames files when the server promotes),
  the fix220 layer and the refit are fitted on its walk-forward chances, and `predictNfl` uses `collegeLabProb`.
- Admin: /american-football/past → "College lab" (per candidate: each season LL · hit, 2023–25 all and FBS vs FBS, vs
  closing line; bands of the winner and the live model; the reason).

### Results

**Server: not known yet** (no American football in the local database copy). After deploy the build runs once (AF_VERSION
fix292-1): log lines "college lab: …" and "af college refit (fix292): …". Paste the College lab table here.

Pipeline check only (synthetic 40-team league, `npm run test:fix292`, 2025 + 2026 test seasons only — the fixture's
seasons are too small for 2023 / 2024):

| | 2025 LL · hit | 2026 so far | 2023–25 FBS vs FBS | vs closing line (LL / line, 160) |
|---|---|---|---|---|
| ncaa-v1 | 0.6107 · 65.4% | 0.5452 · 71.3% | 0.6795 | 0.5452 / 0.5340 |
| ncaa-v2 (live) | 0.6199 · 66.3% | 0.5377 · 70.6% | 0.6854 | 0.5377 / 0.5340 |
| elo | 0.6131 · 64.6% | 0.5432 · 68.8% | 0.6837 | 0.5432 / 0.5340 |
| talent | 0.6188 · 64.2% | 0.5382 · 70.6% | 0.6845 | 0.5382 / 0.5340 |
| home | 0.6066 · 63.8% | 0.5502 · 70.0% | 0.6815 | 0.5502 / 0.5340 |
| conf | 0.6181 · 64.6% | 0.5396 · 69.4% | 0.6855 | 0.5396 / 0.5340 |
| rows | 0.6068 · 64.2% | 0.5390 · 69.4% | 0.6700 | 0.5390 / 0.5340 |
| trees | 0.6969 · 58.8% | 0.5929 · 63.1% | 0.7819 | 0.5929 / 0.5340 |

Fixture verdict: "home" best on 2025 but worse on 2026 → ncaa-v2 stays; the refit was worse than the fix220 layer on 2026
→ kept. Says only that the pipeline runs and the gates bite.

# More predictions — backtest and public gates (fix204, 23 Oct 2026)

"More predictions" are extra outputs from the models we already have (no new model):
football from the score grid of the main model's expected goals, basketball and American football from the predicted
margin / total / points with normal curves, tennis from the point-by-point chain. Code: `backend/src/utils/moreMath.ts`
(maths), `backend/src/services/morePredictions.ts` (saving, checking, record, gates, backtests). Table
`prediction_extras` (saved before the start, frozen at kick-off / first serve), `more_pred_gate` (public or admin-only
per output), `more_pred_backtest` (the latest report), `more_pred_fit` (league fits).

**Public rule (Yarin, fix204 F):** an output is shown to visitors only when its walk-forward calibration is within
3 points in every 10% step that has 100+ forecasts (every label's chance counts as one forecast). Otherwise it stays
admin-only (admins see every output, marked "admin only"). The server re-runs the backtests daily (tennis weekly) and
the gates follow automatically; admin view `/api/admin/more-predictions`, re-run `POST /api/admin/more-predictions/backtest`
(`?sport=`, `?refit=1`).

## How each output is made

- **Football** (score grid, independent Poisson like gridModel's topScores): top 5 likely scores + a 6×6 grid, total
  goals 0/1/2/3/4+, each team 0/1/2/3+, clean sheets, win by 2+, half-time H/D/A and HT/FT. Half-time: first-half goal
  rates = full-time rates × the league's first-half share, the second half from the rest.
  - **Goal-spread shrink (full-time outputs only):** grid-v3's expected goals are spread too wide for exact counts
    (games it puts at 4.2 goals averaged 3.4). Each side's expected goals are pulled toward the average:
    goals = m + k·(xg − m), k fitted by least squares on the seasons before (walk-forward: 2526 used k 0.877 from
    2425, 2627 used k 0.791 from 2425–2526; live: all stored backtest seasons). Out of sample it lowered log loss on
    every full-time output (likely scores 2.9035 → 2.8979, total goals 1.5276 → 1.5230, home goals 1.3329 → 1.3306,
    away goals 1.2987 → 1.2959, clean sheets, win by 2+). The main pick and its 1X2 are not touched.
  - Half-time kept the model's own expected goals: with the shrink its log loss was worse (1.0522 vs 1.0516).
- **Basketball / American football:** the margin's spread is the one that turns the predicted margin into our own win
  chance (so the bands never contradict the pick; clamped to 0.6–1.6 × the league spread), the total's is the league's
  (bb-v3's running spread; NFL / college: the walk-forward misses, else 13.5 / 13 and 16 / 17). First half: mean × the
  league's first-half share, spread × √share. Level at half and overtime: the normal curve's mass around 0, scaled per
  league by what the stored quarter scores show (k = what happened ÷ what the normal curve of that league's margins says).
  Bands: basketball margin 1–5 / 6–10 / 11–15 / 16+, NFL 1–3 / 4–7 / 8–14 / 15+ (+ "the other side wins"); totals 5 bands
  around the league's typical total (basketball 10 points wide, 8 when the spread is under 15; NFL 7); each side 4 bands.
  - Tried and rejected: basketball total / team-point spreads measured from the walk-forward misses instead of the
    model's running spread (total log loss 1.5207 → 1.5244, worse). Not used.
- **Tennis:** the chain's own set-score distribution (BO3 / BO5, deciding-set rule), first-set winner, total games bands
  (BO3 < 20 / 20–22 / 23–25 / 26+, BO5 < 33 / 33–36 / 37–40 / 41+) and P(at least one tie-break) (the same chain with the
  tie-break outcomes left out; a match tiebreak counts). Deciding-set rule outside the replay: Slams since 2022 → 10-point
  tiebreak, else a normal set. Retirements, walkovers and abandoned matches are not checked.

## First-half goal shares (football, stored half-time scores × results, Oct 2026 data)

| Division | Games | Share |  | Division | Games | Share |
|---|---:|---:|---|---|---:|---:|
| E0 | 810 | 0.449 | | I1 | 810 | 0.430 |
| E1 | 1,199 | 0.459 | | I2 | 810 | 0.452 |
| E2 | 1,194 | 0.438 | | D1 | 647 | 0.451 |
| SP1 | 829 | 0.435 | | D2 | 666 | 0.451 |
| SP2 | 1,012 | 0.436 | | F1 | 657 | 0.434 |
| F2 | 674 | 0.446 | | N1 | 675 | 0.447 |
| P1 | 674 | 0.450 | | B1 | 685 | 0.462 |
| T1 | 701 | 0.443 | | G1 | 504 | 0.454 |
| SC0 | 498 | 0.456 | | SC1 | 402 | 0.479 |

Competitions without 200 stored half-time scores (cups, national teams, leagues added from Admin) use 0.45. The live
fit is redone daily on the server.

## fix204b (23 Oct 2026): first server run, defaults, league bands

- **First run:** on start, every sport without a stored report is backtested 3 minutes in (heavy queue, sliced every
  ~30 ms, waits for live ticks), the league fits first when none are stored; the log says `more backtest <sport>: N outputs
  public (of M; …)`. The daily run skips a sport tested in the last 20 h. NFL / college stay "nothing to test yet" until
  the first Tuesday retrain stores walk-forward rows.
- **Goal-spread shrink before any fit:** k = 0.83 (between 2526 0.877 and 2627 0.791), averages 1.5 / 1.2 goals — never
  no correction (the 23 Oct Barça – Real Madrid "4+ goals 58%" was the uncorrected grid).
- **Bands per league (basketball, NFL / college):** total and team-point bands centred on the league's own running mean:
  basketball = bb-v3's per-league average points × 2 (NBA ≈ 225), else the league's finished games of the last ~13 months
  (50+), else the stored fit; NFL / college = the stored fit, else the league's recent games, else 45 / 55. (23 Oct: NBA
  game 519551 had the 160-point default bands, 100% in 175+.)
- **Sanity check:** a basketball / NFL total or team-point set with more than 85% in one band is logged
  (`more predictions <sport> <id>: total 175+ 99.9% in one band — admin only`) and that game's extras become admin-only
  (`prediction_extras.admin_only`, `flag`; out of the public page, record and crawler sentence). Data health lists them.
- Rows carry the maths version (`calc`); rows of upcoming games made before fix204b are made again on the next tick.
- NFL / tennis: rows are saved under the game's own current start time (the prediction table's copy can lag behind a
  moved game); the page may pass the unlock id (nflRid / tennisRid / basketball's negative id), both are accepted; a game
  the 5-minute job has not reached is saved when its page asks. Data health shows the real counts: games of the next 48 h
  with a prediction, with extras, without, flagged, and what the last save did (saved / unchanged / errors).
- Margin bands: the "loser" row reads "<other team> wins instead" (new string: "{0} wins" is translated as a count of
  wins in the six languages).

# Backtest results (server, live)

Not filled yet: the server can't be reached from the local checkout. After the fix204b deploy (first run ~3 minutes after
the start; tennis takes a few minutes more) open `/api/admin/more-predictions?format=md` as admin and paste the output
here, replacing this paragraph.

# Backtest results (walk-forward, run locally on the 10 Oct 2026 database copy)

## Football

grid-v3 walk-forward predictions, seasons 2627, 2526, 12017 games (half-time scores where stored); goal shrink k 2627: 0.791, 2526: 0.877.

| Output | Games | Top pick right | Brier | Log loss | Worst step (100+) | Public |
|---|---:|---:|---:|---:|---:|---|
| Likely scores (exact) | 12,017 | 12.7% | 0.9294 | 2.8979 | 0 | **yes** |
| Total goals 0/1/2/3/4+ | 12,017 | 29.8% | 0.7698 | 1.523 | 10.8 | no (admin only) |
| Home goals 0/1/2/3+ | 12,017 | 35.1% | 0.7236 | 1.3306 | 2.9 | **yes** |
| Away goals 0/1/2/3+ | 12,017 | 36.5% | 0.709 | 1.2959 | 3.1 | no (admin only) |
| Home clean sheet | 12,017 | 69.4% | 0.4124 | 0.6008 | 1.9 | **yes** |
| Away clean sheet | 12,017 | 77.5% | 0.3378 | 0.5168 | 5.3 | no (admin only) |
| Home win by 2+ | 12,017 | 78.8% | 0.316 | 0.4901 | 2.6 | **yes** |
| Away win by 2+ | 12,017 | 87.5% | 0.209 | 0.3558 | 1.7 | **yes** |
| Half-time result | 7,184 | 43.8% | 0.6374 | 1.0516 | 1.1 | **yes** |
| HT/FT (9) | 7,184 | 29.6% | 0.8162 | 1.9069 | 6.6 | no (admin only) |

Said vs happened, 10% steps with 100+ forecasts (step: forecasts, said → happened):

- Likely scores (exact): 0%: 423,561, 2.2 → 2.2 · 10%: 21,044, 12 → 12
- Total goals 0/1/2/3/4+: 0%: 10,991, 6 → 6.9 · 10%: 14,023, 15.9 → 17 · 20%: 28,949, 23.4 → 23.5 · 30%: 4,079, 34.4 → 31.9 · 40%: 1,615, 43.9 → 35.9 · 50%: 361, 53.5 → 42.7
- Home goals 0/1/2/3+: 0%: 1,856, 7.7 → 7.6 · 10%: 10,611, 15.8 → 16 · 20%: 22,267, 24.9 → 24.6 · 30%: 12,484, 34.2 → 34.7 · 40%: 700, 43.8 → 40.9 · 50%: 113, 53.8 → 51.3
- Away goals 0/1/2/3+: 0%: 4,458, 7.1 → 7.4 · 10%: 11,264, 15.5 → 15.4 · 20%: 14,632, 24.4 → 24.6 · 30%: 16,035, 35.1 → 35.1 · 40%: 1,463, 43.6 → 41.5 · 50%: 209, 52.9 → 49.8
- Home clean sheet: 10%: 1,471, 16.5 → 16.7 · 20%: 4,414, 25.5 → 27.4 · 30%: 4,463, 34.5 → 34.3 · 40%: 1,586, 44.1 → 42.7 · 50%: 1,586, 55.9 → 57.3 · 60%: 4,463, 65.5 → 65.7 · 70%: 4,414, 74.5 → 72.6 · 80%: 1,471, 83.5 → 83.3
- Away clean sheet: 0%: 517, 7.8 → 7.4 · 10%: 3,962, 15.9 → 16.2 · 20%: 5,297, 24.6 → 23.9 · 30%: 1,934, 33.9 → 33.5 · 40%: 307, 43.7 → 38.4 · 50%: 307, 56.3 → 61.6 · 60%: 1,934, 66.1 → 66.5 · 70%: 5,297, 75.4 → 76.1 · 80%: 3,962, 84.1 → 83.8 · 90%: 517, 92.2 → 92.6
- Home win by 2+: 0%: 847, 7.6 → 7.3 · 10%: 4,452, 15.6 → 14.2 · 20%: 4,266, 24.5 → 22.9 · 30%: 1,747, 34.2 → 31.6 · 40%: 705, 44.5 → 46.4 · 50%: 705, 55.5 → 53.6 · 60%: 1,747, 65.8 → 68.4 · 70%: 4,266, 75.5 → 77.1 · 80%: 4,452, 84.4 → 85.8 · 90%: 847, 92.4 → 92.7
- Away win by 2+: 0%: 4,119, 7.1 → 6.1 · 10%: 5,819, 14.2 → 12.6 · 20%: 1,587, 23.8 → 22.1 · 30%: 390, 34 → 32.8 · 40%: 102, 44.4 → 43.1 · 50%: 102, 55.6 → 56.9 · 60%: 390, 66 → 67.2 · 70%: 1,587, 76.2 → 77.9 · 80%: 5,819, 85.8 → 87.4 · 90%: 4,119, 92.9 → 93.9
- Half-time result: 0%: 116, 8.4 → 9.5 · 10%: 2,159, 16.5 → 15.8 · 20%: 5,819, 25.2 → 26.1 · 30%: 7,313, 35.4 → 35.4 · 40%: 5,500, 43.7 → 43.1 · 50%: 555, 53.3 → 53
- HT/FT (9): 0%: 33,972, 4.1 → 4.4 · 10%: 21,760, 14.8 → 14.8 · 20%: 5,742, 24.1 → 22.5 · 30%: 2,229, 34.1 → 32.2 · 40%: 708, 43.8 → 45.3 · 50%: 194, 54.2 → 60.8

## Basketball

bb-v3 walk-forward predictions, last two seasons of 18 leagues, 7949 games.

| Output | Games | Top pick right | Brier | Log loss | Worst step (100+) | Public |
|---|---:|---:|---:|---:|---:|---|
| Winning margin bands | 7,949 | 25.7% | 0.7454 | 1.4924 | 7.8 | no (admin only) |
| Total points bands | 7,949 | 31.5% | 0.7611 | 1.5207 | 8 | no (admin only) |
| Home points bands | 7,949 | 39.8% | 0.6906 | 1.2702 | 4.7 | no (admin only) |
| Away points bands | 7,949 | 37.6% | 0.7017 | 1.2928 | 7.1 | no (admin only) |
| First-half winner | 7,946 | 61.2% | 0.4847 | 0.7722 | 3.3 | no (admin only) |
| Overtime | 7,949 | 95.4% | 0.0875 | 0.1843 | 0.7 | **yes** |

Said vs happened, 10% steps with 100+ forecasts (step: forecasts, said → happened):

- Winning margin bands: 0%: 2,456, 8 → 8.7 · 10%: 26,461, 14.9 → 15.1 · 20%: 4,083, 24.6 → 25 · 30%: 3,269, 34.9 → 33.3 · 40%: 2,613, 44.5 → 44.1 · 50%: 590, 52.5 → 51.7 · 60%: 164, 64.5 → 56.7
- Total points bands: 0%: 4,768, 6.3 → 7.5 · 10%: 17,239, 16.1 → 17 · 20%: 13,344, 22.3 → 22.3 · 30%: 2,256, 34.5 → 30.9 · 40%: 1,159, 44.3 → 38.6 · 50%: 526, 54.2 → 46.8 · 60%: 260, 64.4 → 61.5 · 70%: 111, 74.7 → 66.7
- Home points bands: 0%: 3,643, 6 → 7.1 · 10%: 7,026, 15.4 → 16.4 · 20%: 14,543, 25.5 → 25.7 · 30%: 3,044, 33.9 → 33.6 · 40%: 1,661, 44.7 → 41.8 · 50%: 948, 54.3 → 49.6 · 60%: 569, 64.5 → 61.5 · 70%: 237, 74.5 → 70
- Away points bands: 0%: 2,894, 6.1 → 7.6 · 10%: 6,846, 15.5 → 16.6 · 20%: 15,833, 25.5 → 25.8 · 30%: 3,272, 33.8 → 31.9 · 40%: 1,546, 44.4 → 42 · 50%: 731, 54.6 → 51.7 · 60%: 384, 64.1 → 57 · 70%: 181, 74.6 → 72.4
- First-half winner: 0%: 8,089, 3.9 → 3.9 · 10%: 724, 15.9 → 18.2 · 20%: 1,759, 25.5 → 28.8 · 30%: 2,772, 35.3 → 35.8 · 40%: 3,254, 45.1 → 45.5 · 50%: 3,089, 54.9 → 54.7 · 60%: 2,300, 64.7 → 62.5 · 70%: 1,280, 74.4 → 72 · 80%: 482, 84 → 82
- Overtime: 0%: 7,948, 5.3 → 4.6 · 90%: 7,948, 94.7 → 95.4

So at the start, public: football likely scores, home goals, home clean sheet, win by 2+ (both), half-time result;
basketball overtime. Admin-only (with the reason): football total goals (off by 10.8 points at the top: the Poisson
total is still too sure about 3 and 4+ goals), away goals (3.1), away clean sheet (5.3 in the 40% step), HT/FT (6.6);
basketball margin (7.8 in the 60% step), total and each side's points (4.7–8: the bands around a league's typical total
are too sure at the top), first-half winner (3.3 in the 20% step).

## American football and tennis

Not run locally: the 10 Oct copy has no NFL quarter scores and no tennis tables. The server runs them:
- **NFL / college:** from the walk-forward test games of the weekly model report (stored by `buildReport` since fix204,
  `nfl_sync` key `more-wf-<league>`), last two seasons, league fit from the seasons before. Until the first report after
  this deploy (the weekly Tuesday retrain) there are no rows, so every NFL output stays admin-only.
- **Tennis:** the point model's walk-forward serve chances of every finished tour match since Jan 2023 (live settings;
  the settings were tuned on the whole history, a small optimism), retirements left out. First run 20 minutes after
  the deploy, then weekly.
Their table is in `/api/admin/more-predictions` (backtests); copy it here after the first server run.

## Record (public, per sport's record page)

Per output: games, top-pick hit rate, and said vs happened in 10% steps once 200+ games are checked (before that:
"Tracking since <date>: N games so far"). Every competition counts (fix203). Only public outputs are listed.

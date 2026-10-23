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

## fix204c (23 Oct 2026): causes, fixes at the source, calibration layer, NFL / college now

**Server gates after fix204b** (worst 10% step, points): football total goals 10.8, away goals 3.1, away clean sheet 5.3,
HT/FT 6.6; basketball margin 7.7, total 27.9, home points 14.5, away points 20.4, first half 4.9, overtime 3.3; tennis set
score 7.2, total games 13.2, tie-break 7.5; NFL / college "no backtest yet" (examples: Pacers – Mavericks total 240+ 48%,
home 120+ 59%; Barça – Real Madrid total goals 4+ 53%).

### Causes found (walk-forward data)

- **Football total goals / 4+:** not dispersion — goals are *under*-dispersed against Poisson (0.82–1.16 per division,
  0.91–1.02 by expected-goals band), so the negative binomial almost never applies (dispersion over 1.1 only in USA and
  NOR home goals). The cause is the mean: the two sides' expected-goals errors move together, so the per-side shrink
  (k 0.79) left the total too far from the average — games the model put at 4+ goals scored 3.57 on average, and 4+
  happened 46% where fix204b said 56%. Second cause: the shrink pulled every league toward the pooled average (~2.7
  goals), pushing low-scoring Argentina (2.04 goals) up to 2.38 expected and the Bundesliga down. Barça – Real (≈4.5
  expected goals raw) sits in the 4+ band: said 56% (fix204b) → 49% now → happened 46% for that band.
- **Basketball points (local copy):** the bias per league is small (|bias| ≤ 1.2 points except FEC 2.2; NBA +0.6),
  spread ratios 0.88–1.27 (CBA 1.27: its bands were too narrow). The real cause is the **slope**: actual totals move only
  0.3–0.85 of the way the predicted total moves away from the league's usual score (sport-wide 0.74), so the open-ended
  outer bands ("175+", "<145") were over-said; and the misses are **fat-tailed** (kurtosis 6.4 vs 3 for a normal curve:
  more games near the centre, more far out). The server's 27.9 / 14.5 / 20.4 are far bigger than the local 7.7 / 7 / 9:
  the server data (more leagues, the new season) must carry real per-league biases — its cause table is in the admin
  view and in `?format=md` (same columns as below).
- **Tennis, NFL / college:** not in the local copy (no tables). The server backtest writes their cause tables (tennis:
  total-games bias and spread ratio per tour / best-of / surface, tie-break and straight sets said vs happened by the
  favourite's chance; NFL / college: the points table).

### What changed (all fitted walk-forward: each period only from the games before it)

- **Football:** goal counts from a **Dixon–Coles grid** (dixonColes.ts τ; ρ fitted per division with 300+ games, pooled
  otherwise) with the **total and the difference shrunk apart** (kT 0.42 / kD 0.92 on the 10 Oct copy, least squares
  with each division centred on its own means) **toward each division's own average goals**; negative-binomial counts
  (gamma-mixed Poisson) when a division's dispersion is over 1.1. Half-time and HT/FT now use the shrunk means too. The
  main pick and its 1X2 are untouched.
- **Basketball / NFL / college:** per league (300+ games in the last ~13 months, else sport-wide): bias removed, the
  prediction pulled toward the league's mean prediction by the fitted slope, the measured spread (spread ratio), and the
  measured **shape** of the misses (39 quantiles, sport-wide) instead of the normal curve for the total and team-point
  bands. The margin bands and the win chance are untouched.
- **Tennis:** total games shifted by the bias of its tour / best-of / surface group (300+ matches, else the tour, else all).
- **Calibration layer** (`more_pred_calib`): per output, Platt (two outcomes) or isotonic (per label with 1,000+
  forecasts and ≤ 10 labels, else pooled), renormalised to 100% (margin: "the other side wins" keeps its chance). Fitted
  only on out-of-sample predictions (each season predicted with fits from the seasons before it), 3,000+ of them, and kept
  only when — fitted on the first 70% in time — it lowers both the worst step and the log loss on the last 30%. Applied
  when saving; a new fit re-saves the upcoming games (the row's `calc` stamp).
- **NFL / college now:** when no weekly report is stored, the backtest builds it from the stored history (the same
  walk-forward as the Tuesday report; 200+ finished games needed).
- **Sanity rules:** no regular game with > 85% in one band (fix204b), and a basketball / NFL expected total outside the
  league's usual range ± 3 SD (finished games of the last ~13 months) → logged, that game's extras admin-only.
- Heavy work: the backtests run in the heavy() queue (start-up, daily and the admin POST), sliced every ~30 ms, waiting
  for live ticks.

### Before → after (local walk-forward, 10 Oct copy)

Football: log loss better on 9 of 10 outputs (equal on home goals); total goals now passes (10.8 → 2.4); likely scores
fail on one thin step (20%+: 173 forecasts of 0-0 in low-scoring games, said 23 → happened 15). Basketball: margin
10.4 → 5.6, total 7.7 → 5.7, away points 9 → 3.6, overtime 5.2 → 0.4 (public); log loss better for margin, total, first
half and overtime, **slightly worse for home / away points** (+0.0007 / +0.002) — kept because they are the fixes asked
for and the server's biases are far bigger than the local ones; check the server numbers. The worst step of a thin bin
(100–300 forecasts) moves by ±3–5 points by chance alone (174 forecasts at 50%: ±3.8-point standard error), so the
3-point gate on those bins is partly luck; log loss is the steadier measure.

### Football (local, 10 Oct copy)

grid-v3 walk-forward predictions, seasons 2425, 2526, 2627 (15486 games); test 2526, 2627 (12017 games), goal model and calibration from the seasons before each; before = fix204b (shrink k 2526: 0.877, 2627: 0.791, independent Poisson) (run 2026-10-23 17:52 UTC).

| Output | Games | Worst step before → after | Log loss before → after | Top pick right | Public |
|---|---:|---:|---:|---:|---|
| Likely scores (exact) | 12,017 | 0 → 8.4 | 2.8979 → 2.8938 | 12.6% | no (admin only) |
| Total goals 0/1/2/3/4+ | 12,017 | 10.8 → 2.4 | 1.523 → 1.5184 | 29.9% | **yes** |
| Home goals 0/1/2/3+ | 12,017 | 2.9 → 2.1 | 1.3306 → 1.3287 | 35.7% | **yes** |
| Away goals 0/1/2/3+ | 12,017 | 3.1 → 5.5 | 1.2959 → 1.2946 | 36.6% | no (admin only) |
| Home clean sheet | 12,017 | 1.9 → 1.9 | 0.6008 → 0.6004 | 69.3% | **yes** |
| Away clean sheet | 12,017 | 5.3 → 4.4 | 0.5168 → 0.5156 | 77.4% | no (admin only) |
| Home win by 2+ | 12,017 | 2.6 → 2.9 | 0.4901 → 0.49 | 78.8% | **yes** |
| Away win by 2+ | 12,017 | 1.7 → 3 | 0.3558 → 0.3557 | 87.4% | **yes** |
| Half-time result | 7,184 | 1.1 → 3 | 1.0516 → 1.0509 | 43.8% | **yes** |
| HT/FT (9) | 7,184 | 6.6 → 9 | 1.9069 → 1.9058 | 29.7% | no (admin only) |

Cause (all walk-forward games; live shrink: each side k 0.787, total kT 0.418, difference kD 0.92): expected goals raw / shrunk vs goals, dispersion = actual variance ÷ Poisson variance (shrunk means), 4+ goals said (fix204b) vs happened:

| Division | Games | Expected raw → shrunk | Goals | Dispersion | 4+ said → happened | ρ | NB size H / A |
|---|---:|---:|---:|---:|---:|---:|---:|
| B1 | 680 | 2.7 → 2.73 | 2.75 | 1.06 | 28.9 → 29 | -0.08 | – / – |
| SC0 | 498 | 2.94 → 2.88 | 2.84 | 0.91 | 33 → 31.9 | -0.005 | – / – |
| P1 | 668 | 2.61 → 2.62 | 2.63 | 0.85 | 27.4 → 28.7 | 0.02 | – / – |
| T1 | 695 | 2.77 → 2.8 | 2.82 | 1.04 | 30.2 → 31.5 | -0.095 | – / – |
| N1 | 670 | 3.09 → 3.13 | 3.15 | 0.91 | 35.7 → 38.2 | -0.045 | – / – |
| SP1 | 829 | 2.72 → 2.7 | 2.69 | 0.9 | 29.3 → 25.9 | 0.015 | – / – |
| E0 | 810 | 3.01 → 2.91 | 2.84 | 0.9 | 34.2 → 31.5 | -0.08 | – / – |
| F1 | 657 | 2.99 → 2.93 | 2.89 | 1.04 | 33.9 → 33.9 | -0.03 | – / – |
| G1 | 500 | 2.52 → 2.51 | 2.51 | 0.88 | 25.8 → 22.4 | -0.09 | – / – |
| I1 | 810 | 2.57 → 2.54 | 2.52 | 0.91 | 26.6 → 24.3 | -0.03 | – / – |
| D1 | 648 | 3.24 → 3.23 | 3.22 | 0.97 | 38.2 → 43.8 | -0.08 | – / – |
| ARG | 922 | 2.09 → 2.06 | 2.04 | 0.95 | 19 → 14.1 | -0.105 | – / – |
| JPN | 454 | 2.53 → 2.51 | 2.5 | 1.09 | 26.1 → 23.6 | 0.09 | – / – |
| USA | 943 | 3.21 → 3.15 | 3.11 | 1.05 | 37.6 → 37.3 | -0.025 | – / – |
| BRA | 652 | 2.68 → 2.62 | 2.58 | 0.88 | 28.5 → 24.8 | -0.01 | – / – |
| NOR | 404 | 3.15 → 3.17 | 3.18 | 0.96 | 36.7 → 38.9 | -0.045 | – / – |
| SWE | 413 | 2.95 → 2.91 | 2.87 | 1.05 | 33.2 → 30 | -0.03 | – / – |
| MEX | 423 | 3.01 → 2.95 | 2.91 | 1.04 | 34.3 → 33.8 | -0.04 | – / – |
| DNK | 243 | 3.28 → 2.97 | 3.05 | 0.98 | 38.9 → 35 | – | – |
| POL | 379 | 2.87 → 2.82 | 2.78 | 0.97 | 31.8 → 30.1 | -0.135 | – / – |
| D2 | 357 | 3.11 → 3.03 | 2.97 | 1.02 | 35.9 → 31.9 | 0.01 | – / – |
| SC1 | 221 | 2.54 → 2.66 | 2.36 | 0.98 | 26.2 → 22.2 | – | – |
| E2 | 634 | 2.72 → 2.7 | 2.68 | 0.95 | 29.3 → 28.7 | 0.03 | – / – |
| E1 | 647 | 2.69 → 2.67 | 2.65 | 0.83 | 28.8 → 26.7 | -0.07 | – / – |
| F2 | 361 | 2.6 → 2.58 | 2.56 | 1.19 | 27.2 → 27.1 | -0.035 | – / 11.14 |
| SP2 | 545 | 2.71 → 2.67 | 2.63 | 1.03 | 29.2 → 27.9 | -0.005 | – / – |
| I2 | 423 | 2.64 → 2.59 | 2.56 | 0.84 | 27.9 → 25.5 | -0.085 | – / – |

| Expected total (raw) | Games | Shrunk | Goals | Dispersion | 4+ said (fix204b) → after → happened |
|---|---:|---:|---:|---:|---:|
| 0–2 | 857 | 2.14 | 2.13 | 0.93 | 14.6 → 17 → 15.6 |
| 2–2.5 | 3,749 | 2.48 | 2.48 | 0.96 | 21.8 → 23.8 → 23.6 |
| 2.5–3 | 5,712 | 2.75 | 2.7 | 0.96 | 29.5 → 29.8 → 28.6 |
| 3–3.5 | 3,634 | 3.01 | 2.99 | 0.98 | 37.7 → 35.4 → 35.1 |
| 3.5–4 | 1,222 | 3.25 | 3.22 | 0.95 | 46.1 → 40.8 → 39.9 |
| 4+ | 312 | 3.55 | 3.57 | 1.03 | 56.2 → 47.4 → 46.2 |

### Basketball (local, 10 Oct copy)

bb-v3 walk-forward predictions of 18 leagues (26085 games); test = each league's last two seasons (7949 games), fits and calibration from the games before each (run 2026-10-23 17:52 UTC). Calibration layer on: margin, half, ot.

| Output | Games | Worst step before → after | Log loss before → after | Top pick right | Public |
|---|---:|---:|---:|---:|---|
| Winning margin bands | 7,949 | 10.4 → 5.6 | 1.5208 → 1.5085 | 24.6% | no (admin only) |
| Total points bands | 7,949 | 7.7 → 5.7 | 1.5208 → 1.5203 | 31.5% | no (admin only) |
| Home points bands | 7,949 | 7 → 4.7 | 1.2725 → 1.2732 | 39.5% | no (admin only) |
| Away points bands | 7,949 | 9 → 3.6 | 1.296 → 1.298 | 37.5% | no (admin only) |
| First-half winner | 7,946 | 5.9 → 6.7 | 0.7738 → 0.7724 | 61.8% | no (admin only) |
| Overtime | 7,949 | 5.2 → 0.4 | 0.1871 → 0.1855 | 95.4% | **yes** |

Cause, per league (all walk-forward games): bias = predicted − actual (points); slope = how much of a prediction's distance from the league's usual score really happens (1 = all of it); spread ratio = corrected misses ÷ the spread the bands used:

| League | Games | Predicted total | Actual | Bias total / home / away | Slope total / home / away | Spread ratio total / home / away |
|---|---:|---:|---:|---:|---:|---:|
| BSN | 1,225 | 178.7 | 178.8 | -0.11 / -0.08 / -0.03 | 0.791 / 0.733 / 0.793 | 1.057 / 1.03 / 1.035 |
| BCL | 832 | 161.5 | 161.8 | -0.25 / -0.31 / 0.06 | 0.449 / 0.809 / 0.605 | 0.893 / 0.952 / 0.931 |
| LNB | 1,203 | 166.7 | 166.9 | -0.15 / -0.02 / -0.12 | 0.784 / 0.973 / 0.797 | 0.945 / 0.994 / 0.976 |
| LKL | 821 | 170.8 | 171.4 | -0.59 / -0.65 / 0.06 | 0.692 / 0.942 / 0.784 | 1.067 / 1.098 / 1.088 |
| FEC | 787 | 162.7 | 160.5 | 2.22 / 0.94 / 1.28 | 0.475 / 0.85 / 0.735 | 1.023 / 1.076 / 1.056 |
| BBL | 1,343 | 168.5 | 168.7 | -0.19 / -0.07 / -0.13 | 0.689 / 0.824 / 0.763 | 1.048 / 1.064 / 1.037 |
| ACB | 1,320 | 169.2 | 169.8 | -0.66 / -0.27 / -0.39 | 0.78 / 0.952 / 0.764 | 0.925 / 0.981 / 0.953 |
| JBL | 3,081 | 158.8 | 159.3 | -0.45 / -0.18 / -0.27 | 0.773 / 0.839 / 0.83 | 0.879 / 0.941 / 0.94 |
| NBA | 5,285 | 228.8 | 228.2 | 0.57 / 0.29 / 0.28 | 0.845 / 0.862 / 0.885 | 1.035 / 1.028 / 1.028 |
| ABA | 925 | 167.2 | 167.2 | 0.03 / 0.13 / -0.1 | 0.588 / 0.943 / 0.849 | 0.983 / 1.044 / 1.007 |
| BSL | 1,066 | 166.5 | 167.4 | -0.85 / -0.4 / -0.45 | 0.3 / 0.499 / 0.366 | 1.026 / 1.087 / 1.048 |
| NBL | 673 | 181 | 181.9 | -0.85 / -0.27 / -0.58 | 0.641 / 0.792 / 0.663 | 0.945 / 1.005 / 0.972 |
| LBA | 1,073 | 166.5 | 166.8 | -0.27 / -0.25 / -0.02 | 0.639 / 0.822 / 0.637 | 0.955 / 0.992 / 0.979 |
| CBA | 1,978 | 198.3 | 197.1 | 1.18 / 0.45 / 0.73 | 0.816 / 0.873 / 0.832 | 1.272 / 1.215 / 1.204 |
| EL | 1,431 | 166.6 | 166.6 | 0.05 / 0.01 / 0.04 | 0.731 / 0.751 / 0.757 | 0.974 / 1 / 0.981 |
| GBL | 725 | 160.8 | 161 | -0.16 / -0.03 / -0.13 | 0.629 / 0.94 / 0.773 | 0.96 / 1.007 / 1.006 |
| EC | 813 | 167.7 | 167.7 | 0.02 / 0.19 / -0.17 | 0.639 / 0.766 / 0.726 | 1.015 / 1.042 / 1.003 |
| NBB | 1,504 | 158.7 | 158.9 | -0.24 / -0.12 / -0.12 | 0.733 / 0.824 / 0.905 | 1.005 / 1.025 / 1.03 |
| all | 26,085 | 181.1 | 181.1 | 0.05 / 0.02 / 0.04 | 0.737 / 0.847 / 0.797 | 1.01 / 1.031 / 1.02 |

**Tried and rejected (out of sample, 10 Oct copy):** the per-side shrink only (total goals 8.7 even with calibration);
the difference shrunk by the per-side k (win by 2+ better, team goals / clean sheets / half-time worse); halves on the raw
expected goals (HT/FT 6.6 vs 5.2); calibration fitted on in-sample predictions (half-time 1.1 → 5.9: overfit); one cut per
season label (calendar-year leagues' "2526" starts in Jan 2025); the basketball slope from all history (total log loss
1.5227 vs 1.5203 with the last ~13 months); a pooled ρ instead of per division (likely scores 2.8940 vs 2.8938).

## fix204d (23 Oct 2026): likely scores back on the Poisson grid, bb-v3 points fixed in the model, gate on 300+ steps

**Server gates after fix204c** (worst 10% step): football likely scores 8.4 (0 with the fix204b grid), away goals 5.5,
away clean sheet 4.4, HT/FT 9; basketball margin 11.9, total 12.6, home points 9.1, away points 9.7; NFL margin 13.9,
total 3.6, home points 9.2, away points 7.2, halftime 3.4; tennis set score 5.1, total games 3.7, tie-break 3.4. NBA
game 519551 still showed the fix204b numbers (total 240+ 48%, home 120+ 59%).

### Why 519551 kept its numbers, and the re-save

The fix204c correction was fitted on the last ~13 months, where bb-v3's NBA totals were close to the results (local:
predicted 228.8 vs 228.5), so it barely moved a game the model itself put at ~240 — the problem was in the model, not
in the extras. Fixed in bb-v3 (below). Re-save: every new fit or calibration now re-saves the extras of every upcoming
game of that sport at once (new `calc` stamp; was: at the next 5-minute tick), and clears the record cache; the admin
view (`/api/admin/more-predictions` → `calc`) shows per sport the maths version, when the fits and maps were stored,
and how many upcoming games carry the current version vs an older one.

### bb-v3 points: the cause, fixed in the model (SL Basketball 3.0 → 3.1)

- **Cause found:** since early January 2026 the provider's box scores have **no offensive / defensive rebound split**
  in any league (local copy: 6,589 of 37,825 team rows outside the NBA, 1,370 of 10,586 NBA rows; every row since
  ~8 Jan). bb-v2's possessions then used a fixed 27% of missed shots as offensive rebounds; the real rate differs by
  league (NBA 22%), so the possession scale jumped mid-season (NBA −3%, most European leagues +2–4%, LNB +5%). bb-v2
  predicts points as pace × points per possession, and the pace learns fast from each box score while the league's
  points per possession learns slowly: totals moved off the league's level (FEC +4.4 points over the test seasons).
  Any single bad box score (doubled or cumulative stats) could also push a team's pace for many games.
- **Fix (bbModel.ts possessionsOf, basketball.ts parser):** the rebound split is read under every spelling
  (offence / offense / offensive …), offensive = total − defensive when only those come, else **the league's own
  offensive-rebound rate** from its box scores that have the split; a game more than 25% away from the league's median
  possessions is not used for the pace.
- **Walk-forward test (18 leagues, 14,343 test games, never seen when the settings were chosen):** bb-v3 win log loss
  0.57402 → 0.57394; mean |total bias| per league 0.72 → 0.44 points; FEC +4.40 → +0.55, CBA +1.29 → +0.85; **NBA
  predicted 228.8 vs actual 228.5 over the test seasons (target ±2), every league |bias| < 1.5 (largest BCL −1.07,
  NBL −1.04)**.
- **Checked and not the cause:** home court applied twice (no: v1 and v2 add ±half to each side, the talent shift
  ±half — the total is untouched); pre-season games (they count 0.3 and are outside the tests); the league mean
  (v1 follows the last ~100 games, so playoffs pull it down: first-5-games NBA bias −3.5) — weighting playoff games 0.3
  in the league averages was **tried and rejected** (log loss worse: FEC 0.5328 → 0.5341, NBA 0.5980 → 0.5982).
- **The server's NBA ~240 is not in the 10 Oct copy** (opening week predicted 224 there). The only input that moves all
  totals by ~7% is the pace from box scores — now guarded. The backtest report has a new table (`?format=md`, "bb-v3
  now, per league"): the upcoming games' predicted total vs the last 60 days, the v1 league mean, v2 pace × points per
  possession, box scores without the split — **read it first after the deploy**; if NBA still predicts > 232 there,
  the cause is elsewhere and the table says which part (v1 mean or v2 pace) carries it.
- **NFL / college:** nfl-v1's total is 2 × the league average + both sides' points-for / against ratings; the efficiency
  blend changes only the win chance and the margin, so it cannot over-state scoring. No structural fault found in the
  code; the server's cause table (bias per league) shows the size, and the per-league bias / slope / spread fit corrects
  it (synthetic test: a 3-point over-statement is found and removed).
- **Margin bands get their own spread:** centred on the de-biased margin with the measured spread of the margin misses
  per league (the win chance, the first-half and overtime sets keep theirs). Locally the basketball margin passes
  (4.1 → 2.5).

### Football: one grid per output

Likely scores always on the fix204b grid (independent Poisson with the per-side shrink, worst step 0 — Yarin); every
other output on whichever grid has the lower out-of-sample log loss (the backtest decides daily and stores it in the
live fit, `use`). Locally: Dixon–Coles for total goals, each team's goals, clean sheets, half-time and HT/FT; Poisson
for win by 2+ (equal log loss). Away goals and away clean sheet keep Dixon–Coles (lower log loss) although the Poisson
grid would pass their gate (away goals 2.1 vs 5.5) — the rule is log loss first, the gate then decides publication.

### Tennis

The extras now use the format and the deciding-set rule the model itself used for the match (saved with the prediction:
`why.numbers.bo` / `rule`; the model knows each event's rule from its history). Older rows: best of 5 for a men's Slam
main draw when the provider leaves `best_of` empty, the Slam 10-point tie-break by date — before, a men's Slam match
without `best_of` was saved as best of 3. Total-games bias per tour / best-of / surface and the calibration layer as in
fix204c (fitted out of sample). No tennis data in the local copy: the numbers come from the server run.

### Gate rule (Yarin's decision, fix204d)

An output is public when **every 10% step with 300+ forecasts is within 3 points** (steps with fewer forecasts are
reported, they don't decide) **and its log loss is not worse than its last public version** (tolerance 0.001: the test
games grow daily). Same rule in the daily run, the admin view (`gates` → `why` names the reason) and `?format=md`.

### Before → after (local walk-forward, 10 Oct copy; before = fix204b maths, new gate)

Football 8 of 10 public (fix204b: 7 under the new gate): total goals 10.8 → 2.4, likely scores 0 → 0, log loss better
or equal on every output. Basketball 6 of 6 public (fix204b: 1): margin 4.1 → 2.5, total 7.3 → 2.4, home points
4.5 → 1.2, away points 8.8 → 2.1, first half 5.9 → 3, overtime 0.8 → 0.4; log loss better on 5 of 6 (away points
1.2932 → 1.2938). NFL / college and tennis: server only.

### Football (local, 10 Oct copy, fix204d)

grid-v3 walk-forward predictions, seasons 2425, 2526, 2627 (15486 games); test 2526, 2627 (12017 games), goal model and calibration from the seasons before each; before = fix204b (shrink k 2526: 0.877, 2627: 0.791, independent Poisson) (run 2026-10-23 18:23 UTC). Calibration layer on: win2Home.

| Output | Games | Worst step (300+) before → after | Log loss before → after | Top pick right | Public |
|---|---:|---:|---:|---:|---|
| Likely scores (exact) | 12,017 | 0 → 0 | 2.8979 → 2.8971 | 12.7% | **yes** |
| Total goals 0/1/2/3/4+ | 12,017 | 10.8 → 2.4 | 1.523 → 1.5184 | 29.9% | **yes** |
| Home goals 0/1/2/3+ | 12,017 | 2.9 → 2.1 | 1.3306 → 1.3287 | 35.7% | **yes** |
| Away goals 0/1/2/3+ | 12,017 | 2.1 → 5.5 | 1.2959 → 1.2946 | 36.6% | no (admin only: calibration off by 5.5 points in a step with 300+ forecasts) |
| Home clean sheet | 12,017 | 1.9 → 1.8 | 0.6008 → 0.6004 | 69.3% | **yes** |
| Away clean sheet | 12,017 | 5.3 → 4.4 | 0.5168 → 0.5156 | 77.4% | no (admin only: calibration off by 4.4 points in a step with 300+ forecasts) |
| Home win by 2+ | 12,017 | 2.6 → 2.6 | 0.4901 → 0.49 | 78.8% | **yes** |
| Away win by 2+ | 12,017 | 1.7 → 1.4 | 0.3558 → 0.3558 | 87.5% | **yes** |
| Half-time result | 7,184 | 0.9 → 3 | 1.0516 → 1.0509 | 43.8% | **yes** |
| HT/FT (9) | 7,184 | 1.9 → 1.9 | 1.9069 → 1.9058 | 29.7% | **yes** |

Grid per output (out-of-sample log loss: Dixon–Coles / negative binomial vs the fix204b Poisson grid; likely scores always Poisson):

| Output | Dixon–Coles | Poisson | Used |
|---|---:|---:|---|
| Likely scores (exact) | 2.8938 | 2.8971 | Poisson |
| Total goals 0/1/2/3/4+ | 1.5184 | 1.5222 | Dixon–Coles |
| Home goals 0/1/2/3+ | 1.3287 | 1.3305 | Dixon–Coles |
| Away goals 0/1/2/3+ | 1.2946 | 1.2956 | Dixon–Coles |
| Home clean sheet | 0.6004 | 0.6007 | Dixon–Coles |
| Away clean sheet | 0.5156 | 0.5168 | Dixon–Coles |
| Home win by 2+ | 0.4901 | 0.49 | Poisson |
| Away win by 2+ | 0.3558 | 0.3558 | Poisson |
| Half-time result | 1.0509 | 1.0516 | Dixon–Coles |
| HT/FT (9) | 1.9058 | 1.9069 | Dixon–Coles |

Cause (all walk-forward games; live shrink: each side k 0.787, total kT 0.418, difference kD 0.92): expected goals raw / shrunk vs goals, dispersion = actual variance ÷ Poisson variance (shrunk means), 4+ goals said (fix204b) vs happened:

| Division | Games | Expected raw → shrunk | Goals | Dispersion | 4+ said → happened | ρ | NB size H / A |
|---|---:|---:|---:|---:|---:|---:|---:|
| B1 | 680 | 2.7 → 2.73 | 2.75 | 1.06 | 28.9 → 29 | -0.08 | – / – |
| SC0 | 498 | 2.94 → 2.88 | 2.84 | 0.91 | 33 → 31.9 | -0.005 | – / – |
| P1 | 668 | 2.61 → 2.62 | 2.63 | 0.85 | 27.4 → 28.7 | 0.02 | – / – |
| T1 | 695 | 2.77 → 2.8 | 2.82 | 1.04 | 30.2 → 31.5 | -0.095 | – / – |
| N1 | 670 | 3.09 → 3.13 | 3.15 | 0.91 | 35.7 → 38.2 | -0.045 | – / – |
| SP1 | 829 | 2.72 → 2.7 | 2.69 | 0.9 | 29.3 → 25.9 | 0.015 | – / – |
| E0 | 810 | 3.01 → 2.91 | 2.84 | 0.9 | 34.2 → 31.5 | -0.08 | – / – |
| F1 | 657 | 2.99 → 2.93 | 2.89 | 1.04 | 33.9 → 33.9 | -0.03 | – / – |
| G1 | 500 | 2.52 → 2.51 | 2.51 | 0.88 | 25.8 → 22.4 | -0.09 | – / – |
| I1 | 810 | 2.57 → 2.54 | 2.52 | 0.91 | 26.6 → 24.3 | -0.03 | – / – |
| D1 | 648 | 3.24 → 3.23 | 3.22 | 0.97 | 38.2 → 43.8 | -0.08 | – / – |
| ARG | 922 | 2.09 → 2.06 | 2.04 | 0.95 | 19 → 14.1 | -0.105 | – / – |
| JPN | 454 | 2.53 → 2.51 | 2.5 | 1.09 | 26.1 → 23.6 | 0.09 | – / – |
| USA | 943 | 3.21 → 3.15 | 3.11 | 1.05 | 37.6 → 37.3 | -0.025 | – / – |
| BRA | 652 | 2.68 → 2.62 | 2.58 | 0.88 | 28.5 → 24.8 | -0.01 | – / – |
| NOR | 404 | 3.15 → 3.17 | 3.18 | 0.96 | 36.7 → 38.9 | -0.045 | – / – |
| SWE | 413 | 2.95 → 2.91 | 2.87 | 1.05 | 33.2 → 30 | -0.03 | – / – |
| MEX | 423 | 3.01 → 2.95 | 2.91 | 1.04 | 34.3 → 33.8 | -0.04 | – / – |
| DNK | 243 | 3.28 → 2.97 | 3.05 | 0.98 | 38.9 → 35 | – | – |
| POL | 379 | 2.87 → 2.82 | 2.78 | 0.97 | 31.8 → 30.1 | -0.135 | – / – |
| D2 | 357 | 3.11 → 3.03 | 2.97 | 1.02 | 35.9 → 31.9 | 0.01 | – / – |
| SC1 | 221 | 2.54 → 2.66 | 2.36 | 0.98 | 26.2 → 22.2 | – | – |
| E2 | 634 | 2.72 → 2.7 | 2.68 | 0.95 | 29.3 → 28.7 | 0.03 | – / – |
| E1 | 647 | 2.69 → 2.67 | 2.65 | 0.83 | 28.8 → 26.7 | -0.07 | – / – |
| F2 | 361 | 2.6 → 2.58 | 2.56 | 1.19 | 27.2 → 27.1 | -0.035 | – / 11.14 |
| SP2 | 545 | 2.71 → 2.67 | 2.63 | 1.03 | 29.2 → 27.9 | -0.005 | – / – |
| I2 | 423 | 2.64 → 2.59 | 2.56 | 0.84 | 27.9 → 25.5 | -0.085 | – / – |

| Expected total (raw) | Games | Shrunk | Goals | Dispersion | 4+ said (fix204b) → after → happened |
|---|---:|---:|---:|---:|---:|
| 0–2 | 857 | 2.14 | 2.13 | 0.93 | 14.6 → 17 → 15.6 |
| 2–2.5 | 3,749 | 2.48 | 2.48 | 0.96 | 21.8 → 23.8 → 23.6 |
| 2.5–3 | 5,712 | 2.75 | 2.7 | 0.96 | 29.5 → 29.8 → 28.6 |
| 3–3.5 | 3,634 | 3.01 | 2.99 | 0.98 | 37.7 → 35.4 → 35.1 |
| 3.5–4 | 1,222 | 3.25 | 3.22 | 0.95 | 46.1 → 40.8 → 39.9 |
| 4+ | 312 | 3.55 | 3.57 | 1.03 | 56.2 → 47.4 → 46.2 |

### Basketball (local, 10 Oct copy, fix204d)

bb-v3 walk-forward predictions of 18 leagues (26085 games); test = each league's last two seasons (7949 games), fits and calibration from the games before each (run 2026-10-23 18:23 UTC). Calibration layer on: half, ot.

| Output | Games | Worst step (300+) before → after | Log loss before → after | Top pick right | Public |
|---|---:|---:|---:|---:|---|
| Winning margin bands | 7,949 | 4.1 → 2.5 | 1.5216 → 1.4994 | 25.6% | **yes** |
| Total points bands | 7,949 | 7.3 → 2.4 | 1.5174 → 1.5153 | 31.7% | **yes** |
| Home points bands | 7,949 | 4.5 → 1.2 | 1.2698 → 1.2688 | 39.7% | **yes** |
| Away points bands | 7,949 | 8.8 → 2.1 | 1.2932 → 1.2938 | 37.2% | **yes** |
| First-half winner | 7,946 | 5.9 → 3 | 0.7737 → 0.7725 | 61.8% | **yes** |
| Overtime | 7,949 | 0.8 → 0.4 | 0.1873 → 0.1856 | 95.4% | **yes** |

bb-v3 now, per league: upcoming games' predicted total vs the last 60 days, the v1 league mean, v2 pace × points per possession, box scores without the rebound split (60 days):

| League | Upcoming | Predicted total | Last 60 days (games) | v1 mean | v2 total (pace) | No rebound split |
|---|---:|---:|---:|---:|---:|---:|
| ABA | 17 | 168.3 | 166.5 (11) | 168.5 | 168.9 (76) | 22 / 22 |
| ACB | 18 | 183.9 | 189.8 (17) | 180.4 | 178.9 (77.5) | 34 / 34 |
| BBL | 16 | 169.1 | 171.6 (36) | 168.6 | 168 (76.1) | 72 / 72 |
| BCL | 8 | 169.1 | 177.1 (38) | 167.7 | 166.5 (75.1) | 76 / 76 |
| BSL | 15 | 166.8 | 168.7 (19) | 167.6 | 166.1 (72.4) | 38 / 38 |
| BSN | 0 | – | – (0) | 182.9 | 181.7 (77.6) | 0 / 0 |
| CBA | 42 | 182.3 | – (0) | 180.7 | 191.7 (84.8) | 0 / 0 |
| EC | 16 | 170.4 | 165.3 (32) | 169 | 168.9 (74.1) | 64 / 64 |
| EL | 21 | 171.2 | 171.9 (40) | 172.1 | 173.2 (70.7) | 80 / 80 |
| FEC | 25 | 159.9 | 157.5 (30) | 161.3 | 161.5 (75.5) | 60 / 60 |
| GBL | 14 | 168.2 | 162.7 (12) | 167.6 | 165.9 (74.1) | 24 / 24 |
| JBL | 45 | 166.4 | 167.1 (75) | 165.6 | 163.1 (73.5) | 150 / 150 |
| LBA | 14 | 170.8 | 171.4 (16) | 170.2 | 168.3 (75) | 32 / 32 |
| LKL | 10 | 171.4 | 168.6 (18) | 173.2 | 172 (74.3) | 36 / 36 |
| LNB | 15 | 170.5 | 169.4 (17) | 172.5 | 171.1 (75.9) | 34 / 34 |
| NBA | 76 | 223.7 | 228.6 (25) | 223.8 | 225.6 (101.6) | 50 / 50 |
| NBB | 20 | 161.4 | – (0) | 163.1 | 161.3 (75.1) | 0 / 0 |
| NBL | 13 | 187.5 | 187.5 (27) | 186.2 | 183.5 (79.4) | 54 / 54 |

Cause, per league (all walk-forward games): bias = predicted − actual (points); slope = how much of a prediction's distance from the league's usual score really happens (1 = all of it); spread ratio = corrected misses ÷ the spread the bands used:

| League | Games | Predicted total | Actual | Bias total / home / away | Slope total / home / away | Spread ratio total / home / away | Margin bias / spread ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| BSN | 1,225 | 178.5 | 178.8 | -0.25 / -0.15 / -0.1 | 0.814 / 0.75 / 0.814 | 1.079 / 1.045 / 1.049 | -0.05 / 0.912 |
| BCL | 832 | 161.1 | 161.8 | -0.64 / -0.5 / -0.14 | 0.427 / 0.835 / 0.588 | 0.891 / 0.949 / 0.932 | -0.36 / 0.96 |
| LNB | 1,203 | 166.8 | 166.9 | -0.08 / 0.01 / -0.09 | 0.776 / 0.967 / 0.792 | 0.945 / 0.994 / 0.976 | 0.1 / 0.973 |
| LKL | 821 | 170.9 | 171.4 | -0.51 / -0.61 / 0.1 | 0.7 / 0.946 / 0.785 | 1.065 / 1.095 / 1.087 | -0.71 / 1.045 |
| FEC | 787 | 160.6 | 160.5 | 0.11 / -0.12 / 0.23 | 0.616 / 1.025 / 0.843 | 1.109 / 1.117 / 1.107 | -0.35 / 0.972 |
| BBL | 1,343 | 168.6 | 168.7 | -0.1 / -0.02 / -0.08 | 0.688 / 0.824 / 0.76 | 1.051 / 1.066 / 1.039 | 0.06 / 0.891 |
| ACB | 1,320 | 169.2 | 169.8 | -0.62 / -0.25 / -0.37 | 0.778 / 0.953 / 0.76 | 0.926 / 0.981 / 0.954 | 0.11 / 0.947 |
| JBL | 3,081 | 159 | 159.3 | -0.3 / -0.1 / -0.2 | 0.772 / 0.837 / 0.83 | 0.88 / 0.942 / 0.941 | 0.1 / 0.961 |
| NBA | 5,285 | 228.8 | 228.2 | 0.55 / 0.28 / 0.28 | 0.845 / 0.862 / 0.885 | 1.035 / 1.028 / 1.028 | 0 / 0.88 |
| ABA | 925 | 167.2 | 167.2 | 0.06 / 0.15 / -0.08 | 0.587 / 0.939 / 0.848 | 0.984 / 1.045 / 1.007 | 0.23 / 1.009 |
| BSL | 1,066 | 166.6 | 167.4 | -0.77 / -0.35 / -0.42 | 0.3 / 0.739 / 0.503 | 1.02 / 1.066 / 1.042 | 0.06 / 1.056 |
| NBL | 673 | 181 | 181.9 | -0.89 / -0.29 / -0.59 | 0.787 / 0.882 / 0.777 | 0.979 / 1.029 / 0.993 | 0.3 / 1.008 |
| LBA | 1,073 | 166.4 | 166.8 | -0.36 / -0.3 / -0.06 | 0.676 / 0.844 / 0.662 | 0.952 / 0.989 / 0.977 | -0.24 / 1.025 |
| CBA | 1,978 | 198 | 197.1 | 0.83 / 0.27 / 0.56 | 0.918 / 0.948 / 0.909 | 1.246 / 1.196 / 1.184 | -0.28 / 1.105 |
| EL | 1,431 | 166.7 | 166.6 | 0.13 / 0.05 / 0.08 | 0.729 / 0.749 / 0.755 | 0.971 / 0.998 / 0.979 | -0.03 / 1.052 |
| GBL | 725 | 160.9 | 161 | -0.1 / 0 / -0.1 | 0.628 / 0.936 / 0.771 | 0.959 / 1.007 / 1.005 | 0.1 / 1.081 |
| EC | 813 | 167.7 | 167.7 | 0.05 / 0.2 / -0.15 | 0.641 / 0.778 / 0.718 | 1.013 / 1.039 / 1.002 | 0.35 / 0.929 |
| NBB | 1,504 | 158.7 | 158.9 | -0.23 / -0.11 / -0.11 | 0.732 / 0.824 / 0.905 | 1.005 / 1.025 / 1.03 | 0 / 1.059 |
| all | 26,085 | 181.1 | 181.1 | -0.02 / -0.02 / 0 | 0.783 / 0.879 / 0.824 | 1.01 / 1.03 / 1.02 | -0.02 / 0.962 |

# Backtest results (server, live)

Not filled yet: the server can't be reached from the local checkout. After the fix204d deploy every sport is
backtested again ~3 minutes after the start (its stored report predates fix204d); then open
`/api/admin/more-predictions?format=md` as admin and paste the output here (before → after, grids, the "bb-v3 now"
table, the cause tables), replacing this paragraph.

# fix204 backtest results (walk-forward, run locally on the 10 Oct 2026 database copy; before the fix204c fixes)

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

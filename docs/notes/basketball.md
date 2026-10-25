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

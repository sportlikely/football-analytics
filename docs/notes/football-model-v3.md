# Football model v3 (grid-v3) — what was tuned, tested and rejected

Code: `backend/src/services/gridModel.ts` (rows, `CONV`, `buildState`, `scoreMatch`, backtests, sweeps),
`v3Tuner.ts` (full tune), `h2hGuard.ts` (common-sense check), `squadValues.ts`, `apiFootball.ts` (lineups/injuries/xG),
`history.ts` (3 seasons of results per group, `GROUPS`), (`trial.ts` removed in fix203: every league counts in the public record).
Admin endpoints: `/api/model/v3/status`, `/api/backtest/run`, `/api/backtest/sweep`, `/api/model/v3/tune`,
`/api/model/v3/league-tune`, `/api/model/v3/tuned`, `/api/model/goals-calibration`.
Rule for every change: accepted only if log loss / Brier improve on games the fit never saw (walk-forward, later seasons).
Research behind the feature model / v3-mix: `all-data-test-model-oct-2026.md`, `model-sweep-oct-2026.md` (this folder).

## v3-mix + daily self-learning (fix113, 13 Oct 2026) — shadow until it passes
- **Feature model `feat-v1`** (`featureModel.ts`): second league model from data already in the DB. Walk-forward features per
  game: Elo diff (margin-weighted, K 20, ×1.5 in a team's first 10 games of a season) + learned home edge per division;
  EWMA α 0.15 of goals / xG / shots on target for and against (crossed attack vs defence) + their total; luck (goals − xG,
  last 10); home-only / away-only points; league draw and home rates; squad value log ratio + known flag; confirmed XI
  value (lineup names → `squad_players` via `playerKey`), XI previous-season rating and goals (`af_player_season`,
  season − 1; no lineup yet → the team's last known XI, flag 0); injuries count and previous-season minutes × rating.
  Fit: multinomial logit (standardised, L2 = C 0.5) + gradient-boosted trees (softmax, depth 3, 120 rounds, lr 0.03,
  min leaf hessian 80 — chosen conservative after a synthetic check showed the trees overfitting with lighter settings),
  averaged 50/50. Train: the two previous seasons + current season to date (from 1 July two seasons back).
  Stored in `feature_model` (json, trained_at, cutoff, train_games, test_logloss, active); state rebuilt every 30 min.
- **v3-mix** = (1 − w) × grid-v3 + w × feat-v1, w = 0.5 (`model_config.mix_weight`), league games only (national teams /
  UEFA cups stay on elo-intl / elo-euro). grid-v3, feat-v1 and v3-mix are all saved in `predictions` (model column) and
  compared in Admin → Accuracy. Shown as "v3"; "Why we think so" unchanged + one line when the feature model differs from
  v3 by > 8 points on the favourite.
- **Shadow mode** (Yarin, 13 Oct): the server DB can't be reached from the cloud session, so v3-mix went in computed and
  stored but not published. `model_config.mix_mode` = auto (default) / on / off (`/api/admin/v3-mix?mode=`); in auto the
  daily job publishes v3-mix once it beats v3 alone in both 60-day windows (≥ 300 games each), and goes back to v3 if it
  falls behind by > 0.005. Visitors never see feat-v1, nor v3-mix before it is live (JSON replacer in `index.ts`); the
  public record counts v3-mix only from the day it went live (`mix_live_since`). Backtest: `/api/admin/v3-mix?backtest=1`
  (feature model fitted before 1 July, scored on this season vs tracked v3 and vs the latest grid-v3 backtest run of
  2627 when one exists). **To do: run it on the server; the research expects ≈ −0.003 to −0.004 for the mix.**
- **Daily champion / challenger** (`modelDaily.ts`, 04:00 UTC): refit the feature model (stored, not live); challengers
  (a) fresher feature fit (scored as a procedure: fit to the window start vs a fit as stale as the live one), (b) v3 row
  weights refitted with the tuner (`v3WindowRun`: 2 previous seasons + this season, trained before each window), (c) mix
  weight 0.4 / 0.5 / 0.6. Scored on the last 60 days of settled league games (history replay, walk-forward), log loss,
  tie-break Brier, hit rate may drop ≤ 0.5 pp. Promote only with ≥ 300 games, ≥ 0.003 better, and better or equal in
  the previous 60 days. Guardrail: ≥ 100 games after a promotion and worse than the previous champion by > 0.005 →
  automatic rollback (feature model id, v3 vector, mix weight). Log: `model_daily`, `/api/admin/model-daily`
  (`?run=1`, `?preview=1`, `?report=1`), Admin → "Model: daily self-learning". `MODEL_DAILY=off` stops the job.
- **fix251 (27 Oct 2026): the daily job never learned** (decision "keep" every day 13–26 Oct). Causes: (1) the first
  champion record was saved with `featCutoff` null ("feature fit to —"), so the staleness was 0 and challenger (a) was
  never built — the live fit stayed the 13 Oct one while each night's refit (id 17 …) was stored and ignored; (2) the fixed
  −0.003 bar: on 26 Oct the feature model alone was −0.0024 / −0.0030 in both windows, refitted v3 −0.0012, mix 0.6
  −0.0011, none a promotion (the feature model alone was not even a candidate). Now (`utils/dailyRules.ts`):
  - the champion takes the live settings each run (mix weight / group weights / anchor / the active feature fit id +
    cutoff); (a) "fresher feature fit" is always a candidate (fresh = fit to the window start; current = a fit as stale
    as the live one); promoting it activates the night's refit;
  - candidates: mix 0.4 … 1.0 (1.0 = feature alone) × {current, fresh fit}; refitted v3 with the champion's mix and with
    the best mix (best over both windows); a mix weight per league group (big = E0 / SP1 / I1 / D1 / F1, rest = the
    others; each group's best weight, only with ≥ 300 games per group in each window); market anchor on the champion
    and on the best mix: on games with stored prices p = (1 − a)·ours + a·market (margin-free), a ∈ 0.1–0.4 chosen on
    the 60 days before each window (W ← Wp, Wp ← the 60 days before it; live weight chosen on W). Live: `model_config`
    `mix_weight_groups` (JSON) and `market_anchor` read by `mixPredictions` (prices from `odds.ts`, never shown — the
    payload only says `anchored: true`);
  - the bar: paired bootstrap of per-game log-loss differences (candidate − champion) over both windows, 2,000
    resamples, seeded; promote when better in both windows, better in ≥ 90% of the resamples, ≥ 300 games per window,
    hit rate not down > 0.5 pp; the passing candidate with the biggest pooled gain wins. Guardrail unchanged (≥ 100
    games after a promotion, worse than the previous champion by > 0.005 → rollback, now with group weights / anchor).
  - Admin card: last promotion, days since, today's best candidate and how far it is from passing, the candidate table.
    Data health "Football model still learning" (`model-daily-learning`): warn after 30 days without a promotion while
    the best candidate is better in both windows. Tests: `npm run test:fix251` (bootstrap, verdict, candidate list).
  - Not run on real data in the session (no database copy): the first table is what the server's run shows.
- **fix255 (28 Oct 2026): leagues under 52% on 1X2** (Yarin: 90 days, 6,100 games, 37 of 72 leagues under 52% = 3,269
  games; draws picked 59× while 1,476 happened; home bias Serie B 121 home picks / 49 home wins, Liga MX 101 / 46; market
  far better in Scotland Championship, China, Belgium Challenger, Qatar, PL, Nations League, J1). Test on the games of
  the public record only (the saved pre-kick-off main prediction, stored prices, the result), no new data —
  `utils/leagueFix.ts` (pure) + `services/leagueFix.ts` (worker job "league fix", 04:40 UTC nightly and 25 min after a
  start; `/api/admin/league-fix`, ?run=1; card "Leagues under 52%"):
  - walk-forward: a game's settings come only from games settled before its kick-off (+3 h) and history of the days
    before (last 2 seasons + this one, `history_matches` of the league's division); 150 days before the window feed the
    fits. Groups: big 5 / second tiers / Americas / Asia / Nordic / cups & national teams / other European top flights
    (`groupOf`: fixed codes, then the name, then the admin league's country).
  - candidates: (a) own home advantage — p ∝ (pH·e^(h/2), pD, pA·e^(−h/2)) with h moving the league's average saved
    split onto its history base rates, shrunk toward the group's (λ = n / (n + 60)); (b) own draw rate (pD·e^d, same
    fit) and both together; the draw pick rule "draw when P(D) ≥ max(H, A) − x" (x 0–0.10 per group) and the
    double-chance side as the pick (hit rate only); (c) close games (|H − A| < y) toward the base rates by s (y 0.05–0.15,
    s 0.2 / 0.4 per group); (d) market anchor 0.1–0.4 per group (fix251's anchor, prices never shown) and (a+b)+(d);
    (e) < 60 games in the window → the group's settings and the group's verdict.
  - bar: log loss better in both halves (first 45 / last 45 days, by a real margin ≥ 1e-5 — an unchanged candidate
    "passed" on float noise in the first test run), paired bootstrap (fix251, 2,000 resamples) ≥ 90%, hit rate not down
    > 0.5 pp; per league the passing candidate with the lowest log loss. Pick rules are tested and shown, never applied
    (the site names the most likely result everywhere; applying one = a display change, ask Yarin first).
  - applied live through `model_config` 'league_fix_live' (the fix251 config store): `services/leagueFixLive.ts`
    `applyLeagueFix` at the end of both prediction builders (afMatches / footballDataAPI) on every model of the game but
    feat-v1; the model's own numbers ride along (`league.raw` → `predictions.layer_raw`) and the nightly test reads
    them back, so it always starts from what the model said. Nightly: a new pass is added; a league already applied
    stays while its candidate is not worse on the 90 days and the last 45, else it is rolled back (report `rolledBack`).
  - data health "Leagues under 50%" (`leagues-under-50`): a league with ≥ 60 games under 50% on each of the last 30 days
    (rolling 90-day windows). Tests: `npm run test:fix255` (draw rule, home / draw refit, no leakage, verdict, a whole
    run on a made-up record: an over-rated home side fixed, a calibrated league untouched, a harmful setting rolled back).
  - Not run on real data in the session (no database copy, the server is not reachable from here): the table before →
    after is what the first server run shows on the card.
- **fix254 (28 Oct 2026): churn and calibration.** The daily job promoted on −0.0001 (28 Oct). Now a candidate needs a
  gain ≥ 0.0005 log loss per game in the last 60 days (DAILY_RULES.minGain) and promotions are at most once in 7 days
  (minDaysBetween; the guardrail rollback is never held: "held" in the reason). Calibration data health failed (50–60%
  said 54%, happened 59.8%, 326 games): the recent calibration layer (utils/recentCalib.ts, services/recentCalib.ts) —
  isotonic regression of "pick right" on the pick's chance, blocks shrunk toward their own chance (30 games), applied to
  the top chance only (the others keep their proportion, the favourite never changes), walk-forward (each 60-day window
  calibrated by a fit on the 180 days before it), promoted nightly (04:30 UTC) by the same rules (300+ games per window,
  better in both, gain ≥ 0.0005, bootstrap 90%, at most once a week) with the guardrail (worse than no layer by > 0.005
  over 100+ games since it went live → removed). Applied in tracking.freezePredictions to every shown football
  prediction (feat-v1 left alone); predictions.p_pre keeps the 1X2 before it (the next fit's input). Admin:
  /api/admin/recent-calibration (?run=football). Not run on real data in the session (no database copy).
- **Morning report**: 07:00 Asia/Jerusalem (Intl time zone, DST-aware; waits for the job until 09:00) to ADMIN_EMAILS,
  plain text: champion, today's change or "No change", yesterday and last 30 days (games, picks right, log loss v3-mix /
  v3 / feature / bookmakers, 60%+ hit rate), data health + unsettled games, next 3 challengers. Stored in `model_daily`.
- Synthetic check (no DB here; 8 leagues × 20 teams with known strengths): feature model 1.0462 vs truth 1.0392 vs a fixed
  guess 1.0753 on 720 test games, mean probabilities match the real rates; backtest / daily job / report run end to end.

## Full tune (6 Oct 2026) — live
- Train 2024-25 + 2025-26 (8,005 games, 12 live divisions), test 2026-27 (652 games). Test log loss 0.9913 → 0.9794
  (market 0.9775), Brier 0.592 → 0.585 (market 0.583), hit 49.2 → 50.2 (market 50.5). Gap to the market 0.014 → 0.002.
- Shared row weights live: Squad value 12.25 · Missing players 4.25 (frozen) · Confirmed XI 7.5 · Elo 7.25 · Attack 2.875 ·
  Defence 3.25 · Freshness 4.125 · Home/away record 1.875 · H2H 1.125 · Form 0 · Draw-prone 0.75 · League draw rate 0 · Derby 0.
- Conv: gapScale 0.22, homeGap 0.079, drawPoisScale 0.938, drawStretch 0.575, drawGapK 0.106, drawClose 80, gapCube 0.5,
  floorOutsider 28.75, floorDraw 120, drawCap standard 400 / even 340 / big 340, kDraw 1. Stored in `v3_tuned`.
- State knobs all within ±0.001 (half-lives, eloK, valueSpread, xgBlend, injK, xiK…) — nothing worth changing.
- Goals markets: O2.5 log loss 0.687, BTTS 0.690, hit 56.5 / 54.4% — weak but calibrated (GOAL_SCALE 1.05). A shots/xG goals
  model is the next candidate (gap ~0.01–0.02).

## Per-league settings (25 Sep 2026) — live for 5 divisions
- `v3_league_conv` per division (draw points, home gap, stretch, cube, close-game draw), fitted on 2024-25, kept only if it
  beats the shared model on 2025-26. Passed: E1, I2, N1, P1, SP1. Failed (shared model): E0, D1, F1, I1, B1, T1, G1, SC0, SC1,
  D2, F2, SP2. Lesson: league-level differences are mostly captured already; the market's edge is team-level information.

## Common-sense check + H2H archive (9 Oct 2026) — live
- Trigger: Málaga (last) 37% vs Espanyol. Live: `h2hArchive: 1` (10 seasons of football-data.co.uk in `h2h_archive`,
  H2H row only), `poisBlend: 0.25` (25% of the expected-goals 1X2 mixed in), guard `guardPts: 8, guardUsePpg: 1,
  guardH2H: 0.2, guardMargin: 20`: a team the rows rate weaker AND ≥8 pts behind over its last 10 (or ≤20% of H2H points
  in ≥5 meetings) can't be the favourite; reasons say so. Lower home advantage was worse — keep it.
- Yarin's principle: picks must make sense when someone looks at the stats, even when the record gain is small.

## Squad values, lineups, player quality (25–26 Sep 2026)
- Squad value (row #1) weight kept at 10 after sweeps (lower was worse on both seasons). Floor: every club ≥ half its division
  median (`squadFloorRatio 0.5`), floored values shown with "~". No manual entry of values (Yarin).
- Rows #12 confirmed XI and #13 injuries confirmed useful in top leagues (log loss 0.985 → 0.983). `xiNet` (replacements)
  tested, no gain, off. Player-quality row #1p (minutes-weighted strength from API-Football player seasons) tested: no gain,
  off (Elo already carries it).
- Lineups complete for E0, SP1, I1, D1, F1, N1, P1 from 2024-25; second divisions have no injuries this season in
  API-Football (D2, F2, I2, SP2, SC0, SC1).

## Weak leagues check (10 Oct 2026)
- Championship / second divisions trail the bookmakers by 2–6 hit-rate points and 15–21 Brier points (top divisions 7–12);
  the market itself only hits 46–48% there. Nothing broken.
- Relegated clubs in their first season are the worst slice (we make them 60–69% favourites, they win 48%). Tried squad-value
  multipliers/caps/Elo entry percentiles: no overall gain; knobs `relegSquadMult`, `relegSquadCap`, `relegSquadGames` left off.
  Promoted clubs are fine. Ideas: absolute (log) squad scale, League Two / SC2 history for promoted clubs.
- Row on/off sweeps per country: no single row moves Brier by more than ±1 point except squad value in Germany.

## 15 leagues added 7 Oct 2026 (were "in testing" until fix203; since 23 Oct they count in the public record)
- 2. Bundesliga AF79, Serie B AF136, LaLiga 2 AF141, Ligue 2 AF62, Scottish Championship AF180, League One AF41, Brazil AF71,
  Argentina AF128, MLS AF253, Liga MX AF262, J1 AF98, Denmark AF119, Poland AF106, Norway AF103, Sweden AF113. Decision:
  keep all, improve the weak ones. Calendar-year leagues use `seasonForDivision` (2026 → "2627").
- Brier gap to closing odds ×1000: Scottish Championship 2.7, Argentina 8.2, Japan 9.7, Poland 11.4 (close to top leagues);
  2. Bundesliga 14.8, MLS 15.4, Liga MX 15.9, Ligue 2 16.7; League One 18.7, LaLiga 2 19.4, Brazil 19.4, Serie B 21.2,
  Denmark 21.7, Sweden 22.7, Norway 33.3. Candidates to make public: SC1, ARG, JPN, POL (pending Yarin).
- Leagues added later from Admin → Football leagues use the same mechanism (code `AF<id>`, group of their own, history from
  API-Football fixtures, no odds).

## Draw picks / upset watch
- Draw picks rule (`drawAlerts.ts`): v3 draw ≥ 30%, anchored mkt + 0.75×(v3−mkt), edge 2–20%, not La Liga, skip when both
  teams drew 32%+ of last 20. Backtests 2024-26: ~31% draws, +7–8 ROI; 2026-27 start was variance. Review at ~100 alerts.
- Upset alerts vs the market failed the backtest (best of 228 rules not above noise). Live instead: model-only **Upset watch**
  (Pro): underdog ≥ 30% and favourite leads by ≥ 10 points; calibration said 30.9%, happened 28.7% (635 games).
- Bookmaker odds are used only to measure the model (admin) — never shown, never an input.

## UEFA cups (`clubElo.ts`, elo-euro) and national teams (`nationalElo.ts`, elo-intl)
- elo-euro: Elo over domestic (af_fixtures) + cup results, seeded from squad value; grid engine (Elo, squad value, goals,
  form, rest, home, per-cup draw threshold) refitted on every build and auto-selected by out-of-sample log loss.
  13 Oct 2026: Football-Data.org CL team names are matched to API-Football clubs in `matchFdTeam` (exact → club words →
  fuzzy ≥ 0.6); clubs with no squad value count as €12m (`MISSING_VALUE`); clubs with ≥2 games get a (low-confidence)
  number instead of the v1 fallback. Test (705 cup games): log loss 0.952, hit 58.4%.
- elo-intl: 8,864 internationals since 2014; grid (Elo gap, squad value, goal ratings, form, rest, home by kind, friendly
  scale); 2-year test log loss 0.852, hit 61%. Goals weight kept as fitted (Yarin's decision, 27 Sep).

## Live win chance (`liveChance.ts`)
- Half-time test on 10,650 games: log loss 1.003 → 0.824, hit 49.7 → 61.4%, well calibrated. Basketball needs the same.

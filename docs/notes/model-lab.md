# Model lab (fix293, 31 Oct 2026)

A lab = every idea for a model tried on matches it never saw, one table, and the winner promoted only by a fixed rule.
Tennis is the first sport with one (Yarin, 31 Oct). Admin only: nothing here reaches a public route.

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

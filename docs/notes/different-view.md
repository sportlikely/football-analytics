# "Our different view" test (fix246, admin only)

Question: when our model and the market disagree, is our side right more often than the market says — and would that
have made money at the market price? **Admin only.** No public page, API field, link or text; market prices stay
admin-only (hard rule) until Yarin decides on the results.

Where: Admin → Predictions & models → "Different view test" (`frontend/src/components/DiffViewCard.tsx`), route
`GET /api/admin/diff-view` (`?fresh=1` rebuilds; else a 15 min cache), service `backend/src/services/diffView.ts`,
maths `backend/src/utils/diffView.ts`, tests `npm run test:fix246`.

## Method

- Market % = 1/price ÷ the sum over all outcomes (margin removed proportionally; 3-way football, 2-way tennis; an
  exchange quote ≤ 1 is already a probability and is normalised the same way).
- Our side = the outcome we rate higher than the market by the most; gap = our % − market % (points).
- Bands 3–5, 5–8, 8–12, 12+ points (under 3: not counted). Per sport × league × band, past and live apart: games, how
  often our side happened, what the market said, what we said, return of 1 unit on our side at the stored price
  (95% interval of the mean return, normal approximation). Best / worst groups need 30+ games and are ranked by the
  low (best) / high (worst) end of the interval.

## Data

| Sport | Past seasons | Live |
|---|---|---|
| Football | grid-v3 walk-forward backtest (`backtest_predictions`), football-data.co.uk closing price (early price if no closing one) | saved prediction locked at kick-off (best model per game, as on the record) + last price stored before kick-off (The Odds API, `predictions.odds_*` / `market_odds`) |
| Tennis | walk-forward test predictions (`tennis_model_store.test_preds`) + last pre-start exchange quote (`tennis_market_bench`: fair probability only → return at the fair price) | saved prediction (frozen at the start) + exchange mid ~1 h before (`tennis_prices`) |
| Basketball, American football | no prices stored (n/a) | n/a |

Caveat: the football backtest seasons were also used to tune v3's settings, so past-season returns are optimistic; the
live record is the real test.

## Live record frozen at kick-off

Worker job "different view" (jobs.ts, every 5 min): games that started in the last 3 days with a gap of 5+ points are
written once to `diff_view_flags` from the numbers frozen at kick-off. Triggers stop any change to the numbers and any
delete; only the result (`outcome`, `won`, `settled_at`) is filled in (VOID for void games). The card lists the
upcoming games that would qualify (gap ≥ 5) so they can be followed from today.

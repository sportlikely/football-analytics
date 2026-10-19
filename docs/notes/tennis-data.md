# Tennis data (fix184, 19 Oct 2026)

Admin only: no pages, no public routes, no model yet. **Singles only** (doubles skipped everywhere).
Code: `backend/src/services/tennis.ts`. Admin: `GET /api/admin/tennis-probe`, `GET /api/admin/tennis/status`.

## Provider

Live Tennis API, **Pro plan** ($29.99/month): `https://api.livetennisapi.com/api/public/v1`, header `X-API-Key` =
`TENNIS_API_KEY` (Railway variable; never logged or returned). Spec: https://docs.livetennisapi.com/openapi.json and
https://docs.livetennisapi.com/llms.txt.

- Lists return `{ data, meta }`, `limit` ≤ 200, `offset` paging (`meta.has_more`). Unknown fields are ignored.
- Scores are player-major: `"games": [[6,3],[4,6]]` = 6-4, 3-6; `sets: [1,0]` = player 1 leads one set to nil.
- `?draw=singles` filters `/matches`, `/history/matches`, `/tournaments`, `/fixtures`.
- Limits: 300 calls a minute, 10,000 a day. `/usage` is free of quota (our count is checked against it every 30 min).
- Calling above the plan answers `403 {"error":"upgrade_required"}`; 429 has a `Retry-After`.

## What Pro has

| Endpoint | What we use it for |
|---|---|
| `/matches?status=upcoming` | upcoming singles matches with tier, format, tournament_id (every 15 min; fix187). `/fixtures` (no tier) only when that listing fails; missing tiers are filled from tennis_tournaments (by tournament_id, else same name + tour) |
| `/matches?status=live` | live singles matches (every 60 s while any is live, else 10 min) |
| `/history/matches?from=` | finished matches since the last sync (every 30 min) |
| `/history/matches/{id}` | the point tape of one match → `tennis_match_stats` (tour level first, 150 a run) |
| `/history/packages`, `/history/packages/{YYYY-MM}?format=jsonl` | monthly bulk tape files, **one line per match** (a whole `/history/matches/{id}` object) — the 2023 → last-full-month backfill, one month per run |
| `/history/packages/{YYYY}?kind=archive&format=jsonl` | yearly results-archive files (2015–2022, ATP + WTA); if the plan refuses them, the paged `/history/archive/matches` listing instead |
| `/history/archive/matches` | results 1968–2022: winner / loser, ranks, seeds; serve statistics from 1991 (detail endpoint / packages only) |
| `/players/{id}` | bio + ranking + cached stats (first sight, then weekly) |
| `/players/{id}/stoppages` | medical timeouts, retirements… of players in the next 48 h of fixtures (every 6 h, ATP / WTA / Challenger) |
| `/rankings?system=atp` / `?system=wta` | rank-ordered listing (daily, top 1,600). PRO listing = exactly one `system` and no `player`; `tour` is for elo only (the old `?tour=atp` call answered 400). If the listing is refused, tennis_rankings is filled from /players/{id} (ranking, points, movement); /api/admin/tennis/status → rankings.mode says which |
| `/tournaments` | catalogue (daily) |
| `/markets?match_id=` | match-winner market — **admin benchmark only**, last pre-match price (~1 h before the start) |

## What Pro does not have (Ultra, $99.99)

In-play statistics (`/matches/{id}/statistics`), live per-point events (`/matches/{id}/points`), the provider's live win
probability and analysis, per-player as-of rankings and the Elo tape, rally / charting (shot by shot), the reconstructed
2013–2022 archive tape, webhooks and the WebSocket feed. We compute our own statistics from the point tape instead.

## Tables

- `tennis_matches`: id (provider match id; archive results use **−archive id**, their own id space), tournament, tour,
  tier, surface, round, best_of, scheduled_at, status, players, sets / games (JSON, player-major), winner (1 / 2),
  outcome + retired flag, `extra` (archive: ranks, seeds, entry, minutes), source `fixture | live | history | archive`.
- `tennis_match_stats` (per player per match): service / return points played and won, service games played / held,
  break points faced / saved and had / converted, tiebreaks played / won, games, duration (observed tapes only),
  source `tape | archive`, `complete` (no gaps in the tape, starts at love), `gaps`. Checked against 40 simulated matches
  with known statistics (exact).
- `tennis_players`, `tennis_tournaments`, `tennis_rankings` (tour, date, rank, player, points), `tennis_stoppages`,
  `tennis_prices` (never sent to a public route), `tennis_calls` (calls per UTC day), `tennis_meta` (sync points,
  backfill progress).

## Quota rules

- Reserve `TENNIS_RESERVE` (default 1,500) for live play and fixtures: every other job stops when a call would go under it.
- 429 → 60 s pause. 401 / `upgrade_required` → logged once, that endpoint is not called again until restart.
- Backfill is cheap: one call per monthly tape package and one per archive year (if the archive packages are on the plan).

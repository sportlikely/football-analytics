# Season forecast (fix215, 25 Oct 2026)

Roadmap #2. Every league of the current season simulated to the end 20,000 times with our own match model; each
team's chance of every final position and of each zone (title, Champions League / Europe, promotion, play-offs,
relegation …). Football is the template; basketball and American football get the same blocks (`npm run parity`).
No bookmaker, odds or "bet" wording anywhere. Past seasons (the accuracy replay) are admin-only.

## Code
- `backend/src/utils/seasonSim.ts` — the engine (pure, no database). Seeded PRNG (mulberry32, seed = sport|code|day),
  so a run can be repeated exactly.
  - Football: each remaining game from OUR 1X2 as an ordered probit (z ~ N(m + noise, 1); home above +w, away below −w,
    so with no noise the three chances are exactly ours), then the score from the game's expected-goals Poisson grid
    restricted to that result (goal difference / goals scored for the tie-breaks).
  - Basketball / NFL: margin ~ N(mu + noise, sd) with mu / sd giving our own win chance (`marginOf`); no ties.
  - Season uncertainty: each run shifts every team's rating once (football 0.1 latent units, others 1.5 points).
  - Ranking: tie-break keys in order, a head-to-head key = mini-league among the teams still level at that point
    (played games + the run's own results). Split seasons (groups after N games, points halved up / down), play-in +
    brackets (best-of-N, 0 = one neutral game for a Final Four), NFL divisions + 3 wild cards + re-seeding + bye,
    college: top two of each conference play a neutral title game.
  - "What this game means": for each watched game (next 10 days) the zone chances of both teams in the runs with each
    result. In-process runs pause every 250 runs (`simulateSeasonAsync`).
- `backend/src/utils/seasonRules.ts` — one config: points, tie-breaks, zones, splits, post-seasons per competition
  (`FOOTBALL_RULES`, `BASKETBALL_RULES`, `NFL_RULES`), `FOOTBALL_SKIP` (MLS, Argentina, Liga MX: format not modelled),
  `SIM_PARAMS`. Unknown league → position chances only, no zone columns, data health lists it.
- `backend/src/utils/seasonFit.ts` — pure helpers (ratings least squares, table from results, the batch run and the
  replay) — the only code the job thread ('season sim') loads.
- `backend/src/services/seasonForecast.ts` — inputs, runs, storage, scheduler, reads, Free view, admin, data health.

## Inputs
- Football: fixtures from `af_fixtures` (the API-Football twin: PL 39, ELC 40, PD 140, SA 135, BL1 78, FL1 61, DED 88,
  PPL 94 + every AF league); leagues outside that feed (Israel 383, Saudi 307, Austria 218, Switzerland 207) are fetched
  into `sf_fixtures` every 6 h (1 call each, only with > 1,000 calls left); rounds named play-off / final / relegation
  are left out. Finished = FT / AET / PEN / AWD / WO, plus our settled `results` row (the fixture feed syncs every 6 h).
  The table is computed from those games; a points deduction in the provider's table (same games played) is kept.
  Team / match ids are the public ones (Football-Data ids through `team_map` / `fd_af_links`, else API-Football +
  1e9). Each remaining game: our saved main prediction (`tracking.mainRank`), else v3 for that pair
  (`predictV3ByNames`), else the ratings fitted to our predictions of the season.
- Basketball: `bb_games` regular season (`stageKind`), pre-season NBA left out; `bb_predictions`, else `predictGame`
  (bb-v3). NBA conferences from the provider's table (`bbStandings`); none → the league is skipped with the reason.
- American football: `nfl_games` regular season (NFL stage "Regular…", college numbered weeks); `nfl_predictions`, else
  the nfl-v1 / ncaa-v1 Elo (`nflRatings`, diff/25 points, home 48 / 65 Elo). College: FBS conferences, Independents get
  no title game, FCS opponents are teams of group "other" (not shown).
- Ratings for games that exist only inside a run (split groups, play-offs): least squares on the game means of our
  predictions (rating(home) − rating(away) + home edge, ridge λ = 2).

## Runs and storage
- Worker only. Each league again 10 min after its newest finished game changes (5-min check, debounced), every night
  (02:00 UTC: anything older than 20 h), at start-up when older than 26 h. Batches of 6 leagues per job thread.
  Measured locally: PL mid-season 20,000 runs ≈ 0.6 s, NBA ≈ 1.8 s (thread CPU); in-process the longest loop gap 42 ms.
- Tables: `season_forecast` (per league: teams JSON with pos[], zones, avg points / place, the rules used, run time),
  `season_forecast_games` (what each watched game means), `season_forecast_teams` (team → league),
  `season_forecast_history` (team per day: the chart), `season_forecast_skips` (why a league isn't simulated),
  `season_forecast_accuracy` (the replay), `sf_fixtures`.

## Pages and plans
- League page: tab "Season forecast" (shared `LeaguePage` `forecast` prop, #forecast in the address): team, now,
  average points / wins, average place, one column per zone, "Every position" = heat map. Team page: card with the zone
  tiles + a line chart of the best and the worst zone over the season. Game page: "What this game means" (only zones
  that move by ≥ 2 points).
- Free (and Premium): the forecast's top three and bottom three of each table + the visitor's favourite teams; the rest
  locked (team and today's table only, ordered by today's place). Pro / admin: all. The game line is locked like the
  game's prediction (paid plans, or a free pick spent on that game).
- Routes: `/api/season-forecast/:sport/league/:code`, `/team/:id`, `/game/:id` (worker routes), `/api/admin/season-forecast`,
  `POST /api/admin/season-forecast/run` (?sport=&code=, ?accuracy=1).

## Accuracy (admin only until it beats the table)
Last season replayed week by week from week 3: table and games known then, ratings fitted to the results' margins
known then (football 0.3 latent units a goal, capped at 3), 2,000 runs. Brier of title / first zone (top 4,
promotion or play-offs) / relegation against what happened, next to the "current table order" baseline. Mondays
03:00 UTC or Admin → Season forecast → "Replay last season". Data health "Season forecast calibrated (<sport>)" is green
once it beats the baseline; the how-it-works page shows the numbers only then. NBA is not replayed (past conferences are
not stored). Not yet run on the server: write the numbers here after the first replay.

### Season uncertainty (fix218)
A team's strength is not fixed for the rest of the season: every run draws a season-level shift per team (`noise`, sd in
rating units) and lets it drift game by game (`walk`: a random walk whose total drift to the season's end has sd `walk`;
step = walk / √games left). Both are fitted, not guessed: `fitNoiseHere` replays last season at matchweeks 5, 10 and 20
with every pair of noise × {0.5, 1, 1.5, 2, 3} and walk × {0, 0.5, 1, 2} (multiples of the base noise, 600 runs a pair)
and keeps the pair with the best mean Brier on title / first zone / relegation; one pair per sport (the mean over its
leagues) in `season_forecast_params`, used by every forecast from then on. Until the first fit: the base noise, no drift.
The fit + replay run ~8 min after a start when none is stored or it is over 7 days old, then Mondays 03:00 UTC.
">99%" / "<1%" on the pages only when the replay found ≥ 20 forecasts at that level and 98.5 %+ of them came true
(`extremesFor`); else "99%" / "1%". Fitted values on the server: not yet run — write them here after the first fit.

## Not done / to decide
- Cups' group stages (Champions League league phase), MLS / Argentina / Liga MX formats, college CFP bracket.
- Basketball leagues other than NBA, EuroLeague, ACB, LBA, BBL: position chances only (their play-off formats differ by
  season — add them to `BASKETBALL_RULES` when checked).
- The Belgian / Greek / Swiss post-split zones are the places every season gives; cup-winner places are not modelled.

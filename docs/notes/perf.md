# Server freezes (event-loop stalls): what blocks, what was fixed

The server runs on one thread. A job that runs for 1 s without giving the thread back makes every visitor wait 1 s.
`services/perf.ts` logs every stall over 500 ms ("Event loop blocked N ms (jobs that ran during it)") and `/api/perf`
(admin) lists the stalls over 300 ms, the worst stall per job and (fix194) the heavy-job queue.

Tools in `perf.ts`: `slicer()` (give the thread back every ~30 ms inside a loop), `yieldLoop()`, `inBatches()`,
`runStepsAsync()`, `timed()` / `every()` / `after()` (labelled jobs), and since fix194 `heavy()` / `everyHeavy()` /
`afterHeavy()`: **one heavy background job at a time**.

## fix194 (20 Oct 2026): tennis jobs + the 04:00 daily model job

Railway logs, 20 Oct: stalls of 0.5–2.2 s every few minutes from the tennis jobs (players 2220 ms, model first +
ratings 2117 ms, fixtures 2000 ms, live, history, backfill packages) and 1.2–1.8 s for ~3 minutes from 04:04 UTC
(model daily job + player pages warm + tennis live running together).

What was blocking and what changed:

| Where | Cause | Fix |
| --- | --- | --- |
| tennis fixtures / tournaments → `fillTiers` | two UPDATEs over every match + a GROUP BY over every match, every 15 min | UPDATEs limited to the last 14 days (time index, `INDEXED BY`); the tournament → tier map built in primary-key pages with yields, kept 6 h, then only recent rows added; writes 300 per transaction |
| tennis history → `fetchTapes` | the "no tape yet" query scanned every match since 2023 and every meta row | last 45 days on the time index (older months come with the tape packages); the "no tape" mark looked up by key |
| tennis history → results hook | `applyNewResults` read and replayed up to 8,000 rows in one block | async: keyset pages of 1,000, parse and replay in slices |
| tennis model / ratings → `loadRankHistory` | each 20,000-row page filtered on `date || rank` (no index): a full scan + sort of the rankings table per page | pages by rowid (sorted per player afterwards, in slices) |
| tennis model → `archiveMap`, `newCtx` | whole-table reads of players + a UNION over every match; name normalising in one loop | primary-key pages with yields (archive rows = negative ids); loops sliced |
| tennis model → `loadData` | filtered COUNT over every row; pages of 4,000 rows parsed in one go | plain COUNT (capacity); pages of 1,000; parse sliced; rule detection sliced |
| tennis model → ratings | full replay every 24 h | full replay only when the settings change or after 7 days; new results added incrementally (`applyNewResults`) |
| tennis model → predictions | all ~3,000 matches of the next 48 h recomputed every 30 min and written in one transaction | only matches whose players' ratings moved since their prediction (or no prediction, or 6 h old); written 200 per transaction |
| tennis backfill packages → `streamFile` | 200 tape lines (~100 KB of JSON each) parsed and stored per block | ~25 ms slices, one transaction per slice (never open across an await) |
| tennis players | HTTP 410 (player removed by the provider) aborted the job with a warning every 20 min, and the player was asked again next time | 410 → `tennis_players.gone = 1`, never asked again (players and stoppages); refresh list read from a new `updated_at` index |
| model daily → `fitVector` (v3 tuner) | one round = every parameter × a pass over the training games, with one yield per round | yields every ~30 ms inside the round |
| model daily → `fitLogit` / `fitTrees` (feature model) | yield every 25 passes / once per boosting round | yields every ~30 ms (each pass, each depth level, each binned feature) |
| everything at once | daily job + player-page warm-up + tennis jobs overlapping | `heavy()` queue: model daily job, player pages warm, tennis fixtures / history / players / rankings / tournaments / stoppages / backfill / model (+ the admin rebuild) run one at a time; a label already waiting is not queued twice; a job still running after 45 min no longer holds the queue. Tennis usage, live and prices stay on their own timers (small, time-critical). |

Not needed: worker threads. Every heavy loop now gives the thread back every ~30 ms; if a stall over 300 ms still
names one of these jobs after deploy, the next step is moving that piece (package parsing, the model tuning or the
full ratings replay) into a `worker_thread`.

Not tested locally with real tennis data (the local database copy has no tennis tables); checked: both typechecks,
the queue order (one at a time, no duplicates), the query plans of every changed query (time index / primary key, no
full scans), and the tennis modules loading and running on an empty database.

### Check after deploy (done 20 Oct, 18:10 UTC)

Two hours of Railway logs after the fix194 deploy: no "Event loop blocked" over 300 ms (only those over 500 ms are
logged; `/api/perf` lists the rest) mentioning tennis, model daily or player pages warm. Also check that the next
04:00 UTC daily job runs without a stall, and `/api/perf` → `heavy` shows the queue moving.

Result (logs 16:04–18:10 UTC; fix194 live from 16:03, fix195 from ~17:04): **no stall over 500 ms from the
tennis fixtures / tournaments / history / players / rankings / stoppages / backfill / model / ratings jobs** (before:
0.5–2.2 s every few minutes, e.g. `tennis players` 1.5–2.3 s at 15:16 and 15:36). Still listed:
- `tennis live` (not in the queue): 589 ms alone at 16:13, and named with other jobs at 16:34 and 17:04 (the 17:04 one was
  the fix195 boot). Cause: the live hook (`sampleLive` in tennisSite.ts) computed the live chance of every live
  match in one block and wrote each sample as its own commit. Fixed in the follow-up commit (fix194b): ~25 ms
  slices, one transaction per slice. To check: the next live hours.
- `player pages warm` at 16:23–16:24 (552–1409 ms), always together with page requests and `AF lineups/injuries` +
  `lineup/injury features` (fix196 covers those); the warm-up itself is mostly waiting for API-Football. Watch it.
- `model daily` did not run in this window (04:00 UTC): check the 21 Oct 04:00–04:10 logs.
Other stalls in the window (basketball game pages, /api/matches/upcoming, feature state, data health) are fix196's.

## fix196 (20 Oct 2026): the last freezes (basketball game pages, match list, feature state, data health)

Railway logs 20 Oct 16:10–17:00 UTC, after fix194 — what still blocked (all of these are "Event loop blocked" lines,
over 500 ms; the breakdown from the "bb game page" log lines and a copy of the database, 10 Oct):

| Where | Before | Cause | Fix |
| --- | --- | --- | --- |
| `/api/basketball/game/:id` and `/<lang>/basketball/game/*` (crawler pages) | 0.6–1.3 s each, many an hour (Googlebot reading old games) | the squads ("players to watch") read every player's career box scores (~4,000 lines a team) and ran after an await that never gave the thread back, so both teams + the rest of the page were one block; two SUMs over the whole league season (profile), the team's season games and the previous season asked of SQLite on every open, through an index that walked every league game before the date; today's NBA injury list built for finished games (715 ms on one page); the page kept only 2 min | page kept per game: finished 24 h (10 min in the first 2 days while box scores and checks come in), to come 5 min (never past tip-off), live not at all; the 1,500 most recent API pages and 3,000 crawler pages; a league season's games, box-score lines and seasons read once an hour and filtered in memory (same numbers: 40 game pages compared old vs new on the copy, identical); squads kept an hour per team and season and read 4 players at a time with a yield between; the thread given back after each part of the page; no injury list on finished games (it was today's list anyway); written preview kept 24 h for games finished 2+ days ago; new index `bb_games(code, season, kickoff)` (built in the index worker) for the crawler page's season records |
| `/api/matches/upcoming` | 0.9–1.1 s every 10 min | the whole list (predictions for ~750 matches) rebuilt inside the request after every fixture-window refresh | stale-while-revalidate: the last copy is served at once; over 30 s old, the next build starts in the background (5 matches a batch, yields); only the first request after a start waits (for a sliced build). Still sent through res.json (market strip + free / signed-out trim); signed-out visitors get the same trimmed copy as a string made once per build |
| feature state | 2.8 s (once 5.6 s) | the line-up lookup pages (40,000 rows) went into the maps in one loop (~400k rows); every fixture read in one sorted query; COUNT(*) over ~900k line-up rows for the change check; an admin backtest rebuilt the state with the synchronous builder | pages of 5,000 rows with a step every 2,000; fixtures in primary-key pages, sorted in memory; 64 player-season ranges instead of 12; MAX(rowid) instead of COUNT(*); the backtest uses the sliced build; the refresh runs in the heavy() queue and its slices wait for live ticks |
| data health | 2.0 s (with the live poll) | predictions in batches of 25 (one batch right after the prediction cache was cleared ≈ 1 s); the tennis check in one block; a few checks without a yield between them | batches of 5, a yield (and a wait for a live tick) between every check and inside the history loop; tennis check in slices; the 10-min job in the heavy() queue |
| AF lineups/injuries, lineup/injury features, predict more-leagues window | 0.6–1.4 s bursts, together | three jobs overlapping; line-up reads of 500 fixtures (~11,000 rows); predictions in batches of 25 | the AF tick, the AF features rebuild and the more-leagues predictions (always the latest window) in the heavy() queue; line-up reads of 150 fixtures; predictions 5 a batch, recording 10 |

New in perf.ts: `liveRunning()`, `afterLive()` (wait while the live poll or a live job runs, at most 3 s),
`heavySlicer()` (slicer that also waits for live ticks), `inBatches(…, { live: true })`, `runStepsAsync(…, { live: true })`,
and heavy() never starts a job during a live tick. Heavy queue now: model daily, player pages warm, tennis jobs, feature
state, data health, AF lineups/injuries, AF features, predict more-leagues window.

Longest single block on the copy of the database (this laptop; the server is roughly 3–5× slower and its disk is
colder), before → after:

| Job | Before | After |
| --- | --- | --- |
| 30 NBA / EuroLeague game pages in a row | one 3.4 s block | 24 ms |
| crawler basketball game page (20 old games, then the same again) | — | 65 ms first, 10 ms cached |
| feature state build | 183–197 ms | 31 ms per step |
| AF features rebuild (forced) | 56 ms | 41 ms |
| data health (steady state; the first run after start loads modules) | 106–197 ms | 30 ms |

Not tested locally: `/api/matches/upcoming` against a live fixture window (the local key gets 403 from
Football-Data.org) and anything with tennis data (the copy has none).

### Check after deploy (pending)

Two hours of Railway logs after the fix196 deploy: no "Event loop blocked" at all (any label; only those over 500 ms are
logged, `/api/perf` → recentStalls lists those over 300 ms — target: none over 300 ms). `/api/perf` → `heavy` shows the
queue (feature state, data health, AF lineups/injuries … one at a time); "matches upcoming build" appears as a job and
no request to /api/matches/upcoming is named in a stall. Also re-check the fix194 item (04:00 UTC daily job).

Result: _to fill in after the check._

## fix200 (23 Oct 2026): data health, news, tennis model, live ticks

`/api/perf` → recentStalls before fix200 (from Yarin's brief, 22–23 Oct):

| Where | Before | Cause | Fix |
| --- | --- | --- | --- |
| `/api/data-health` | 5.8 s | the checks ran inside the admin request (outside the heavy() queue, next to the 10-min job), and the 7-day "every game has a prediction" check computed a basketball / NFL prediction per game in one block | never computed on a request: a background job (heavy() queue, every 5 min, first a minute after start) runs it in slices and stores the JSON (`data_health_store`, utils/healthStore.ts); the endpoint, the admin card and the 07:00 report read the stored copy with its `at` time. The 7-day check is sliced too. Alert e-mail: 6 failing runs in a row (still 30 min) |
| news | 4.4 s | the refresh stored every story in one transaction with the league matching (one big regex per story) inside; the parse of 50+ feeds; a league page with no stories ran a search and stored it inside the visitor's request; the first request on a fresh database waited for the whole refresh | refresh and searches in the heavy() queue only (a request only queues them, a league search waits at most 8 s for its turn); parse with the heavy slicer, matchers built with a yield around each, stories stored 40 per transaction with a yield between |
| tennis model + ratings | 2.9 s | the replay, the report / re-tune and the 48-h predictions on the main thread (sliced since fix194, but long loops between yields and the typed-array copies) | a worker thread (`workers/tennisModelWorker.ts`) with its own read-only connection does all of it; its writes (store keys, predictions) come back and the main thread applies them in one transaction ("tennis model write-back" in /api/perf); the pages read a ratings snapshot (typed arrays, transferred, not copied). `TENNIS_WORKER=0` or 3 crashes → the old in-process path |
| lineups / bb live / nfl live / football live | 0.4–1.2 s | every live game of a tick processed in one block (predictions, recording, push; basketball / NFL writes + win-chance samples for the whole list) | at most 20 games per turn, the rest on the next macrotask (`perGames` / `mapGames` in perf.ts): football live poll (predictions, recording, push), AF live=all mapping, FD scores from AF, basketball and NFL live writes; lineup/injury feature rebuild 20 fixtures per turn |

Tested locally: the worker builds the same ratings as the in-process run on a made-up set of 900 matches / 48 players
(every array equal, the same player-page numbers) and a full tick in the worker writes its 3 predictions back through
the main thread (`npm run test:fix200`). Not measurable locally: the stall numbers (no live data, no provider keys).

### Check after deploy (pending)

Target with normal traffic, one hour after the deploy: `/api/perf` → `worstLastHour` < 1,000 ms and `stallsLastHour` < 20;
no stall naming data health, news, tennis model / tennis ratings; `jobs` shows "tennis model write-back" (short) and
`/api/admin/tennis-model` → `worker.on: true`.

Result: _to fill in after the check (worstLastHour, stallsLastHour, the top 5 recentStalls)._

## fix202 (23 Oct 2026): background jobs in a worker process; pages never built on a visitor's request

Before (Yarin's `/api/perf`, 23 Oct, 67 min after start, one process): **90 stalls an hour, worst 5.9 s, event-loop max
8.8 s**, 975 MB. Causes: football live tick (a 5.9 s stall, the job up to 38 s), basketball model rebuild (8.8 s),
basketball live (1–1.5 s), and pages built on the visitor's request when cold: `/api/basketball/games` 3.8 s,
`/api/tennis/record` 2.7 s, `/api/draw-alerts` 2.4 s, `/api/nfl/home` 2.0 s (0.3 s cached).

### How it works now

- **Two processes, one container, one SQLite file (WAL, `busy_timeout` 5000).** `index.ts` = the web process: listens
  at once, answers requests, pushes live games on the socket. It forks `worker.ts` (`--max-old-space-size=WORKER_HEAP_MB`,
  default 1536; the web process gets `WEB_HEAP_MB`, default 1024, in the Dockerfile) and restarts it when it exits (1 s
  after a long run, backing off to 1 min when it keeps dying). The worker exits when the web process goes.
  `WORKER=0` = everything in one process, as before (the jobs module is loaded only then).
- **Every scheduled job is in `jobs.ts`** (started by the worker): live polls (football, AF, basketball, NFL, tennis),
  fixtures / results / settling, voiding, odds, line-ups and injuries, model builds and daily tuners, more predictions,
  news, data health, backups, warmers, sitemaps, hubs, search indexes, highlight look-ups. `services/role.ts` says which
  process a module runs in (`isWeb`, `isWorker`, `runsJobs`); the web entry never imports `jobs.ts`
  (`npm run test:fix202` checks the source and what is loaded at run time). The routes moved from `index.ts` to `app.ts`
  (the same app runs in both processes).
- **Model state → the web process (`services/shared.ts`).** After each build the worker publishes what the pages read
  (v8.serialize into `shared_state`, an IPC message; the web process reads that one row and swaps it in; a 30-s
  version check catches a missed message; on start the web process loads the last copies). Published: football v2
  params, v3 group states (one key per group) + team-page trend snapshots, club Elo, national Elo, feature-model state
  (teams, lookups and the fixtures from yesterday on), AF line-up / injury features (games from 2 days ago on), squad
  values (reload), basketball leagues (League / LeagueV2 go as plain data and come back as instances) + player talent
  + NBA injury version, NFL ratings (the engine without its box-score context; the web process joins it to the games and
  box scores it reads itself and only adds newly finished games on top, never replays), tennis ratings snapshot,
  Football-Data.org window + standings + live list, API-Football window + league names + tables + each live tick's
  changes, the live-score book, hubs, search indexes (football, basketball), visitor countries and data-centre ranges.
  On the 10 Oct copy: the biggest v3 group (England) is 1.8 MB and loads in 12 ms; the feature state 4.2 MB, 39 ms;
  the football search index 2.7 MB, 29 ms.
- **Live games (`services/liveState.ts`).** The worker's live tick writes one `live_state` row per game (only the ones
  that changed, `updated_at`), deletes the finished ones and sends the ids; the web process re-reads those rows and
  pushes them (`matches:live` with the whole list, `match:live` to the changed games' rooms). `/api/matches/live` in
  the web process is that same list.
- **Stored pages (`services/pageCache.ts`, table `page_cache`).** Stale-while-revalidate: the worker builds them on
  start, keeps them fresh (every page has its own `freshMs`; any query a visitor asked for in the last hour is kept
  fresh too) and stores the ready-made views beside each page (signed out / paid / public …), so a request mostly
  sends a string. A copy older than `freshMs` is still served while the worker builds the next. A restart serves the
  last stored copy straight away. Stored: `/api/matches/upcoming` (30 s; rebuilt after each fixture-window refresh),
  `/api/public/summary`, `/api/public/record`, `/api/public/results`, `/api/draw-alerts`, `/api/basketball/games`
  (home lists, per access), `/api/basketball/standings/*`, `/api/basketball/record`, `/api/nfl/home` (per access),
  `/api/nfl/record`, `/api/tennis/home` and `/api/tennis/record` (once tennis is public), `/api/more/*/record`, the
  sitemaps, and the crawler HTML of every sport's home page in every language. A calendar day picked on the site and
  members with unlocked games still get the list built for them (reading the published model state). Copies nobody
  asked for in a week are dropped.
- **Admin / staff requests go to the worker.** Everything outside the public API (`OPEN_API`) is passed by the web
  process to the worker's own copy of the app on 127.0.0.1:`WORKER_PORT` (PORT + 1), body and all, with the visitor's
  address; the worker's port answers only the web process (a key made at every start). So the job state, the
  backtests and the rebuild buttons stay where the jobs run. Kept in the web process: `/api/perf`, `/api/draw-alerts`,
  `/api/admin/visitors` (who is online lives there). While the worker restarts, admin requests get a 503.
- **Visitor requests no longer start background work:** a news request never refreshes (a league with no stories asks
  the worker to search it), a team page passes its players to the worker's warm-up, a team / ratings page never starts
  an NFL replay, the tennis player page never starts a model thread.
- **API-Football usage counters** are written as additions (both processes count; neither overwrites the other).
- `/api/perf` (web): this process's stalls and jobs, plus `worker` (on, pid, restarts, last exit, memory, its own
  stalls, the last run of each job, the heavy queue), `pages` (every stored page: age, build time, size, requests) and
  `shared` (every state taken from the worker: size, load time). Worker log lines carry `"proc":"worker"`; its stalls
  are logged from 2 s ("Worker: event loop blocked …") since no visitor waits for it.

### Measured locally (10 Oct copy, provider keys blanked, this laptop)

| | Before (one process) | After (web process) |
| --- | --- | --- |
| Web process listening after start | the boot plus the schedulers over 2 min | 0.7 s (no model load); the worker starts after |
| `/api/basketball/games?days=7` / `?days=30&results=1` | built on request (3.8 s on the server) | 3–6 ms, first and second load |
| `/api/public/summary`, `/record`, `/results` | built on request when cold | 2–4 ms |
| `/api/draw-alerts`, `/api/nfl/home`, `/api/more/*/record`, `/`, `/de/basketball`, `/sitemap.xml` | built on request | 1–6 ms |
| 180 page loads (every endpoint above + match / game / team / crawler pages, cold then warm) | — | 0 stalls over 300 ms in the web process |
| Same predictions in both processes | — | basketball 40 games, club Elo 20, national Elo 20, v3 30, feature model 30: identical (made-up NFL games: identical, in the test) |
| Memory | 975 MB (server) | web 157 MB, worker 576 MB (local, no provider data) |

Tests: `npm run test:fix202` (the web entry never loads the job modules; a cold web process serves the stored copy
at once; one process builds in place and serves the old copy while it rebuilds; basketball and NFL predictions equal
across the processes; the real web + worker pair: a forwarded admin request, the worker's port refuses others, the
worker leaves with the web process; live rows). Every other suite (fix200–fix206, proxy guard) passes as one process
(the WORKER=0 path), and the signed-out leak test finds no leak against the split pair.

Not measurable locally: real provider data and traffic (live ticks, the server's slower disk), so the targets are
checked on the server.

### Check after deploy (pending)

1. Railway logs right after the deploy: "worker <pid>: admin requests on 127.0.0.1:3002"; no "worker exited" lines.
   The site answers within 10 s of the deploy (the stored pages from before the deploy).
2. One hour of normal traffic, `/api/perf` (web): `stallsLastHour` < 5, `worstLastHour` < 500 ms; `worker.on` true,
   `worker.restarts` 0, `worker.jobs` lists the live polls, the model builds and the stored pages; `pages` ages under
   each page's freshness; `shared` lists the v3 / bb / elo / feat / af / fd / search keys.
3. First and second load of each endpoint in the targets list < 600 ms (browser network tab, signed out and signed in).
4. Admin pages (data health, leagues, backups, tennis model …) work as before (the worker answers them).
5. Memory: the service's memory graph; if the plan is tight, lower `WORKER_HEAP_MB` / `WEB_HEAP_MB` (Railway variables).
6. If anything is wrong: set `WORKER=0` on Railway (everything back in one process; the stored pages are still used).

Result: _to fill in after the check (web stalls / worst, worker restarts, memory)._

Still built in the web process on a visitor's request (as before, every model now read from the published state):
match / game / team / player pages and their caches (the provider is called for a page never opened before), the
visitor's calendar (.ics), favourites and picks, and nfl-v2's recent-game features when nfl-v2 is adopted.

## fix210 (24 Oct 2026): the worker's memory crash and the last web stalls

`/api/perf` before (Yarin's brief, 24 Oct): **worker restarts 3, last exit SIGABRT after 1 min** (rss 1,018 MB, heap
707 MB, limit 1,536 MB); worker stalls 86 / h, worst 61.5 s (page upcoming, AF matches, bb model, stored pages, bb sync,
national Elo, search index all in the first minutes); **web stalls 43 / h, worst 5.3 s** (`/fr/*` 4.0 s,
`/api/player-page/:id` 3.9 s, `/api/news` and `/api/more/nfl` 2.5 s, `/api/matches/:id/details` 1.7 s,
`/basketball/*` 1.2 s, `/api/more/basketball` 1.1 s).

Reading: SIGABRT one minute after a start is V8 giving up at the heap limit; a 61-s stall next to it is the garbage
collector running again and again on a full heap. At start every big job ran at once (the stored-page round, the
search index, the AF window, the basketball model with every box-score line in memory, national Elo), and the worker
kept every page it ever built in memory (stored pages, 2,000 match details, 3,000 player pages, 1,500 basketball game
pages …) — after fix202 it answers all of them.

### The rules (every new job and route follows them)

1. **The web process never builds a page.** A public route that builds something is in `WORKER_ROUTES` and
   `PUBLIC_ROUTES` (`services/workerRoutes.ts`): the web process passes it to the worker; a signed-out visitor's answer
   is kept (memory, 32 MB cap, and `route_cache`, 2 days) and served stale-while-revalidate (freshness per route:
   20 s for game pages, 2–10 min for lists, team / player pages). Signed-in visitors always get the worker's fresh
   answer (their plan and unlocks change the page). The crawler HTML of every page and language is a stored page
   (`seo-page`, built by the worker on first request; the web process waits at most 4 s, then sends the plain app
   page). Page builders are registered (`services/builders.ts`); with `SL_STRICT_WEB=1` one called in the web
   process throws, in production it is counted (`/api/perf → webBuilds`, should stay `{}`).
   Guards: `npm run parity` (frontend/scripts/web-routes-check.ts: every public `app.get` is in `PUBLIC_ROUTES`; each
   'worker' sample matches `WORKER_ROUTES`; game / team / player pages of every sport on the worker) and
   `npm run test:fix210` (every public route + crawler pages opened in a web process: no builder, none over 50 ms).
2. **A loop gives the thread back every 50 items or 100 ms** (`yieldEvery()` in perf.ts; `slicer()` /
   `heavySlicer()` are the 30-ms versions). Big JSON in slices (`utils/jsonAsync.ts`), database writes 200–500 rows a
   transaction, never a transaction open across an await.
3. **One heavy job at a time** (`heavy()`): AF matches, bb sync / bb model, national Elo (build + sync), search
   indexes, every stored page with warm queries (page upcoming, records, home lists, crawler homes, sitemaps), plus
   the fix194 / fix196 list. heavy() nests: called inside a running heavy job (its async context) it runs there;
   `heavyQueued()` / `heavyLater()` queue from anywhere without waiting (a page rebuild asked by a heavy job runs
   after it).
4. **CPU-heavy model builds in a thread** (`services/threadJob.ts` + `workers/jobThread.ts`): one thread per build,
   ended after it (its memory is freed at once; a build over its heap — THREAD_HEAP_MB, max 12% of the container —
   ends the thread, not the worker). The build's `publishState` calls come back one state a message and are applied
   by the same `onState` code the web process uses, then published. Now: basketball model (talent pass + leagues),
   national Elo. `THREAD_JOBS=0` = in the worker's main thread as before. Tennis has its own thread (fix200).
5. **Every cache has a size cap.** Stored pages in memory: 400 copies / 48 MB in the web process
   (`PAGE_MEM_MAX`, `PAGE_MEM_MAX_MB`), none in the worker (the copy is in page_cache); match details 300, basketball
   game pages 300, player pages 400 + 300 (crawler), team pages 300 / 400 / 300, team analysis 500 per sport, NFL
   pages 500, crawler memo 2,000 — each page is also in its database store, so a miss is a read, not a build.

### Memory and restarts

- Heaps from the container: `utils/memLimit.ts` reads cgroup `memory.max` (v2) or `memory.limit_in_bytes` (v1);
  worker = min(WORKER_HEAP_MB, 55%), web = min(WEB_HEAP_MB, 30%) (the Dockerfile asks `node dist/utils/memLimit.js
  web` before start), job thread = min(THREAD_HEAP_MB 512, 12%). `/api/perf → memory`.
- Exit reason: the worker's stderr goes through the web process (still printed); on exit the last 50 lines, code and
  signal are stored in `worker_exits` with a reason ("out of memory: heap limit", "killed (SIGKILL …)", "aborted
  (SIGABRT …)", "crashed: …"). Restart after 5 s, then 30 s, then 2 min while it keeps dying (a run of 10+ min resets).
- What grows: every job's heap before / after (`jobs[...].heapDeltaMb`, `maxHeapDeltaMb`, `peakHeapMb` — the heap is
  sampled every 10 s into each running job); `/api/perf → worker.memByJob` = the top 5.
- History: both processes write hourly buckets (stalls over 300 ms, worst, heap / rss peaks, the 5 worst stalls with
  their jobs) to `perf_hours` every minute (48 h kept): `/api/perf → history` (web), `worker.hours`.
- Data health (worker, every 5 min): **Web stalls** (fail over 5 / h or one over 500 ms), **Worker stalls** (fail over
  2 s), **Worker memory** (warn over 70% of the heap limit), **Worker restarts** (warn 1, fail 3 in 24 h) — each with
  the top offenders.

### Measured locally (10 Oct copy, this laptop)

| | In the worker's main thread | In a job thread |
| --- | --- | --- |
| Basketball model, 18 leagues (forced) | 5.6 s, loop blocked up to 37 ms, heap after 43 MB | 6.7 s, main loop blocked ≤ 21 ms, heap after 18 MB; the same 60 predictions and walk-forward rows |
| National Elo build | 10.9 s, loop blocked up to 59 ms | 11.9 s, ≤ 19 ms; the same 40 predictions |

`npm run test:fix210`: 91 URLs (81 public API routes + 10 crawler pages, every sport) in a web process on the copy:
no builder ran, slowest 20 ms (before: `/api/leagues` asked Football-Data.org in the web process, 81 ms — moved to the
worker). The real pair: a worker route built by the worker and the second request served from the web's copy; a killed
worker recorded with its reason and back after 5 s. All earlier suites pass (fix200–fix209, proxy guard).

Not measurable locally: the server's memory and stalls under real traffic.

### Check after deploy (pending)

One hour after the deploy, `/api/perf`: `worker.restarts` 0, `stallsLastHour` < 5 and `worstLastHour` < 500 ms,
`worker.worstLastHour` < 2,000 ms, `webBuilds` {}. If the worker still exits: `worker.lastExit.reason` + `stderr`
and `worker.memByJob` say why and which job; write it here.

Result: _to fill in after the check._

## fix210b (24 Oct 2026): the last stalls after fix210

`/api/perf` one hour after fix210 (Yarin, 24 Oct): **memory fixed** (worker restarts 0, heap 729 / 1,728 MB). Still
failing: **web stalls 26 / h, worst 6.8 s** (first 10 s after the deploy: "GET /basketball/* + state load nfl" 6.8 s,
"+ state load squad" 3.1 s; then crawler pages of old basketball games, 1,304 an hour, 0.5–1.4 s stalls; "AF usage
flush" 880 ms on the web process → a 1.7 s stall); **worker stalls 100 / h, worst 4.2 s** (page draw-alerts 4.1 s,
scorers check + page results 3.75 s, no job name 3.0 s, AF lineups/injuries + lineup/injury features 2.6 s, more
predictions daily 2.3 s with +397 MB, bb sync + bb model 2.0 s).

| Where | Cause | Fix |
| --- | --- | --- |
| web: any database write | a write waits **synchronously** for the worker's lock (busy_timeout 5 s): the AF usage flush, the visit rows, security-log lines, the signed-out page copies (route_cache), perf rows were written by the web process | `services/deferredWrites.ts`: the web process queues them and sends them to the worker once a second (IPC, `serialization: 'advanced'`; kept while the worker restarts); the worker writes 500 a transaction. Cleanups (visits, security log, sessions, client errors, staff activity, calendar, scraper rows) run in the worker only; a browser's error report is passed to the worker. Left in the web process: sign-in and account actions (sign-up, log-in, sessions, plans, picks, favourites, unlocks) |
| web: start-up | requests came in while the model states loaded | the web process loads every stored state **before it listens** (Railway keeps the old instance until /api/health answers); an applier's async part (NFL engine) is awaited; the squad values and club value history are read 500 rows at a time with yields (`utils/pagedRead.ts`) |
| web: /basketball/game/:id in every language (crawlers, old games) | the page waited up to 4 s for the worker, often while another stall happened | **one data build per game** (`bbGameFacts` in seo.ts, stored as `bb-game-facts`: game, records, form, head-to-head, preview, the more-predictions line of all 7 languages); the web process writes the page's text from it (`bbGameSeo`, string work only) — a stored game is ~30 ms in any language. The worker builds **every finished game of each league's two latest seasons ahead** (jobs.ts "bb game pages", every 6 h, ids 500 a read, a yield every 50 games / 100 ms; on the 10 Oct copy: 8,039 games in 52 s, blocks ≤ 22 ms, 27 MB). Finished games' facts stay fresh 7 days (10 min in the first 2 days). Other pages: the wait is 3 s, then the plain app page |
| web: builders | fix210 still ran a page builder in production when one was called | it throws in the web process now (`builders.ts`) |
| worker: page draw-alerts | the whole report in one block (all settled draw alerts, every backtest season, team draw history) | `drawAlertsReportAsync`: settled rows 500 a read by rowid, yields in every loop, the backtest table kept 6 h; the summary card counts the draw picks only (it built the whole report) |
| worker: page results / record / summary | 30–400 days of settled predictions read in one query, three times per page | `preloadSettled`: read a day at a time with a yield, the three counts share the copy (60 s) |
| worker: scorers check | every game of 48 h checked and written one by one in one block | a yield every 50 games / 100 ms |
| worker: sitemaps | **sitemap-football.xml wrote every missing match preview inside the build (36 s on the copy)**; teams / players / leagues: season-long GROUP BYs | the stored preview dates only (78 ms); the other sitemaps are built in the job thread |
| worker: AF lineups/injuries | `mapTeams`: every API-Football team × every football-data name (similarity, 3 spellings) for every group on every tick, one UPDATE per team | only when a group's teams or names changed, a yield every 20 teams, the writes in one transaction. The features build was already sliced (30 ms) and stays in the worker: the model reads the full feature history from its memory |
| worker: more predictions daily (+397 MB) | league fits + walk-forward backtests in the worker's main thread | in the job thread (`moreBacktestHere`: own connection writes the fits / maps / gates; the basketball walk-forward rows are passed in); its memory is freed when the thread ends. Job thread heap now min(THREAD_HEAP_MB 768, 20% of the container) |
| worker: bb sync | a whole season's games in one transaction; every unchecked box score in one block | 200 games a transaction with a yield; field-goal check 2,000 a run |
| worker: search index | 55,000 fixture rows, each name normalised again | normalised only when the name changed; the index built as a generator in 40-ms slices |
| worker: no job name | IPC handlers, state publishes and the thread's state applies were unlabelled | each is named: `ipc <type>`, `state publish <key>`, `<job> thread: apply <key>` |
| worker: tennis live heap 1,242 MB | the peak is the heap seen while a job runs; tennis live runs every 30 s, so it is "running" at most peaks | caches lowered anyway: player tour 30,000 (was 100,000), events 500 (was 2,000), win-chance memo 150,000 in the main thread (600,000 in the model's own thread) |

Measured on the 10 Oct copy (this laptop, worker role, longest block per job): page draw-alerts 35 ms (13 ms with the
backtest table kept), results 7 ms, record 7 ms, summary 12 ms, sitemaps 11–62 ms, scorers check 17 ms, search index
76 ms. `npm run test:fix210`: 121 URLs (+ real old ids: basketball games in 7 languages, football players / matches in 7
languages, team, NFL, tennis pages) in a web process: no builder, slowest 34 ms; stored basketball facts rendered in 7
languages, each < 50 ms; the real pair as before (the exit row is now written by the next worker).

### Check after deploy (pending)

One hour after the deploy, Admin → Data health: Web stalls ok (≤ 5 / h, none over 500 ms), Worker stalls ok (none over
2 s), Worker memory / restarts ok. `/api/perf`: `webWrites.queued` near 0, `threadJobs` (bb model, national elo, more
backtest, sitemap: ok), `worker.topStalls` without "null". After the first "bb game pages" run (10 min after start):
`pages` has `bb-game-facts?id=…` rows and the crawler requests for old basketball games stop showing in topStalls.

Result: _to fill in after the check._

## fix221: the list APIs as strings only (25 Oct)

The stalls left after fix218 were the list APIs themselves (/api/basketball/games 2.9 s, /api/matches/upcoming 2.2 s,
/api/nfl/config 1.0 s, /<lang>/* 1.2 s). What the web process still did: JSON.parse of a stored page every time it read
it from page_cache (the ~5 MB upcoming list after every 30-s rebuild); for signed-in Free / Premium members the whole
list trimmed and serialised per request (basketball: built on the web for members with unlocks); res.json for admins
and data-centre visitors; a table scan per /api/nfl/config. Now: views with ETag + gzip made by the worker, the body
never read on the web, big lists as one string per row (members' copies joined), the rest passed to the worker
(`byWorker`), nfl-config and the crawler HTML stored. `npm run test:fix221`: 4.7 MB list in 6 ms (gzip 63 KB), member
copy 6.5 ms, 304 in 1 ms, web JSON.parse 0 KB, event loop max 6 ms.

## fix222: the stalls left after fix221 (25 Oct)

Live 25 Oct 13:45 UTC: web stalls 22 / h; worst 6,558 ms "boot (scheduler start)", 3,432 ms "/api/basketball/games +
/api/basketball/game/:id + /api/matches/upcoming", 2,545 ms /api/basketball/games, 1,221 ms "state load af".

- **"boot (scheduler start)" on the web was not a scheduler.** The web process starts none; the label was set in the
  listen callback, and the first stall tick after listen measured the whole module load before it (imports, table
  checks: ~6.5 s on Railway) and named it after that label. Now: the label only exists where a scheduler starts
  (WORKER=0); the stall clock starts at listen (`markListening`), and the module load is a start-up entry ("module load
  before listen", in /api/perf `startup`). Start-up stalls (before the state is loaded) no longer go into the hourly
  buckets that data health's "Web stalls" counts (they are still listed apart): nobody waited for them.
- **"state load af" = one big v8.deserialize.** A shared state over 256 KB (STATE_PART_KB) is now stored in parts
  (`shared_parts`): every big top-level list or Map is cut into ~256 KB slices; the web process reads and deserializes
  one slice per turn and joins them. Test (fix222): a 38 MB state that takes 672 ms in one piece blocks the web loop at
  most 14 ms. The worker's job threads (applyStored) join the parts in one go.
- **The list routes, traced by phase.** sendStored is three perf entries: "stored <page>: read" (getPage), ": pick"
  (the view / rows join), ": send" (res.send / gzip) — a stall now names the phase. A request passed on to the worker
  (forwardToWorker, a worker route without a copy) is marked as waiting (`track(...).wait()`): it is no longer named in
  a stall it did not cause (/api/basketball/game/:id is answered by the worker; it was named because it was in flight).
  A member's joined list (unlocks) and a data-centre visitor's locked list are gzipped in zlib's thread pool (they were
  sent as 5 MB of text); the unlock ETag reads only the etag column (not the 5 MB 'full' view and its gzip copy).
- Checked locally: test:fix221 (member copy 15 ms with gzip), test:fix210 no-web-compute (127 URLs, slowest 32 ms).

### Check after deploy (pending)
/api/perf (web) an hour after the deploy: `startup` has "module load before listen" and no "boot (scheduler start)";
`stallsLastHour` ≤ 5; `topStalls` — if a list route is still there, its label now says read / pick / send: send Claude
the exact label. `shared` (applied): af:window loaded in parts (bytes = the whole). Data health "Web stalls" ≤ 5 / h.

## fix227 — restarts: never a raw text page

Railway cannot overlap two deployments of a service with a volume, so a deploy or a variable change always has a short
gap with no listener (Railway answers 502). fix227 keeps it short and lets the site recover from it:
- `boot.ts` is the container entry: it listens on PORT before the modules load (`services/earlyStatic.ts` answers the
  build files and the plain app page; 503 for the API and /health) and hands its server to `index.ts`.
- The ready gate (app.ts) answers 503 only for /health, the API and the socket; files and pages go out before the state load.
- Shutdown exits once open requests are answered and the worker has stopped (5 s at most).
- A stored crawler page from an older build (it names a gone app file) is never sent.
- Frontend: the loader in index.html (retry the app file, then the "Updating SportLikely…" card) and `lib/startupRetry.ts`.
- Measured locally (`npm run test:fix227`): 0 errors for / and the app file over two restarts, gap 0.44 s.
- Data health "Errors during the last deploy" (`services/deployErrors.ts`).

## fix232 — no empty lists after a deploy, a light /api/perf

25 Oct ~17:55–18:07 UTC (fix225 deploy): /api/basketball/games answered 503 "Loading" for ~12 min while the worker's
first "bb model" build (every game's impact recomputed) held the heavy queue — the list builds were queued behind it.
/api/perf was 5 MB (every stored page listed with length(json), all jobs, the shared states) and froze the web
4.8–18.6 s each time it was opened.
- **Page lane** (`perf.pageLane`): stored-page builds run one at a time beside the heavy queue, never behind a model job.
  A heavy job a page build asks for runs inside it (as when pages were heavy jobs), unless it runs / waits already.
- **Pages first** (`perf.MODEL_JOBS`, `expectPagesFirst` / `pagesFirst`): the model rebuilds and fits of every sport
  wait for the warmer's first round (`stored pages: first round done in N s`), at most 10 min (`PAGES_FIRST_MAX_MS`).
  NFL ratings / model tick and the tennis model tick await it explicitly (they are not heavy() jobs).
- **The last copy survives**: the weekly clean-up never drops a warm list (`pageCache.cleanPageCache`); every stored
  answer carries `X-SL-Built-At`. A list without any copy is built in the page lane within seconds (no 12-min wait).
- **Deploy health**: 503 "Loading" answers of stored lists in the first 30 min (`deployErrors.noteLoading`), fail when
  any comes after the first 60 s.
- **/api/perf**: summary by default (≤ 50 KB, from memory: web / worker totals, top 20 stalls, jobs top 30 by total
  time, memory by job top 10, 24 h with the 2 worst stalls each); `?full=1` the old detail with the stored pages listed by
  the worker (`/api/perf/pages`; lists one by one, on-demand pages one line per name; the size is stored with each page,
  no length(json) scan; index `idx_page_cache_meta`); `?shared=1` the shared states. A stall while only /api/perf or
  /api/admin/* ran is kept apart (`diagStalls`), never in the hour's count or data health "Web stalls".
- Test: `npm run test:fix232` (restart with a 60-s fake model rebuild, `SL_TEST_MODEL_MS`).

## fix238 — the last freezes (26 Oct)
- Old crawler links → the id index on the web (no 3 s worker ask, no page build first). `/api/matches/upcoming` only the 14 / 30-day
  stored copies. Start-up: boot.ts holds API calls for the app; before the state, a kept route copy (X-SL-Copy: startup) or a wait
  (`STARTUP_WAIT_MS`, 30 s) — no 503 "Starting up" for the API (/health keeps it).

## fix240 — slug states republished only on change (26 Oct)
Live 26 Oct 14:45 UTC: web stalls 17 / h, worst 1,694 ms. The per-stall list (route + read / build / send / gc) is in the
admin-only /api/perf and could not be read from the dev machine, so it is not in the commit. One recurring cause found in
the code: the "slugs" job (every 15 min) published `slugs:<sport>` and `slugs-ids:<sport>` for all four sports on every
run (32 loads an hour on the web, each a map of up to hundreds of thousands of entries swapped in, the old one left to
major GC) although almost nothing changes between runs. Now each state is published only when its content hash changed
(`contentSig`, order-independent; `slug_state_sig` keeps it across worker restarts; published anyway when the stored
row is missing). Check: /api/perf?shared=1 on the web — slugs:* applied a few times a day; topStalls of the hour.

## fix243 — crawler bursts and "stored upcoming: read" (26 Oct)

Live 26 Oct: 33 web stalls over 300 ms an hour, worst 3.8 s, during crawler bursts on /pt/* /tr/* /it/* pages and
past-season basketball games; "stored upcoming: read" alone 1–2 s several times. Causes found in the code:
- **The covering index was never used.** fix232 built `idx_page_cache_meta(key, built_at, ms, kb)` so a page's time
  could be read without its text, but for `WHERE key = ?` SQLite picks the primary key's unique index and reads the row;
  `built_at` / `etag` come after the `json` column, so every freshness check walked the page's overflow chain (the
  upcoming list: several MB, cold on the volume after each 30 s rebuild). That was the whole "read" phase on the web.
  Now `INDEXED BY idx_page_cache_meta` (time; fix243b: the planned `idx_page_cache_etag` is not built — building it on the live table was the suspected cause of the failed deploy — so a member copy's ETag uses the plain query) (a member copy's
  ETag), with the plain query until the index exists (pageCache.ts `indexedQ`). Test: EXPLAIN shows COVERING INDEX.
- **View text read on the web thread.** The view a request sends (upcoming 'anon' several MB, a crawler page's HTML +
  gzip) was read with the main connection. Now `getPage(…, { views })` reads them in the web process's reader thread
  (services/pageReader.ts + workers/pageReader.ts: its own read-only connection) before it returns; the request only
  sends strings in memory. PAGE_READER=0 = the old synchronous read. /api/perf → `pageReader` (reads, maxMs, errors).
  Test: 10 × 8 MB views, longest web block 11 ms while the thread took up to 98 ms per read.
- **Basketball game HTML written on the web.** The crawler route parsed the stored facts (JSON.parse) and wrote the
  page (bbGameSeo + renderIndex) per request and language. Now `bb-game-seo` (id, lang, slug) is a stored page with its
  HTML made by the worker; the web sends it like every other crawler page. The pre-fix221 fallback (render from the
  page body) is gone: the plain app page instead.
- **Bots limited.** services/botGate.ts: a page render for a bot (crawler / tool user-agent, or none; signed-out, not
  admin) takes a slot: 4 at a time (BOT_PAGES), 16 waiting up to 4 s (BOT_QUEUE, BOT_WAIT_MS), the rest 503 +
  Retry-After 30. Browsers never take a slot. /api/perf → `botPages`.
- **Past-season match pages answer 410** before any render (links.md, fix243), which removes most of the old
  basketball game pages the crawlers walked (and their worker round trips).

## fix248 — measure first: a CPU profile for every web stall (26 Oct)

Stalls came back after fix135, 166, 169, 202, 221, 222, 232, 238 and 243; every one of those fixes guessed the cause
from the perf labels (the jobs and requests in flight). Live 26 Oct 20:53 UTC, 3 min after a restart: ~300 page renders
in 3 min on /<lang>/* and /basketball/* (many at exactly 3.0 / 6.0 s), /api/basketball/games up to 14.3 s, start-up state
loads 0.7–1.5 s, and nothing recorded what code ran during a stall.

- Step 1 (c215540, deployed on its own): the web process keeps a rolling CPU profile (`workers/cpuProfiler.ts`: an
  inspector session on the main thread from a worker thread, `Session.connectToMainThread`, 5 ms sampling
  (`CPU_PROFILE_US`), parsed in that thread, never on the web thread; swapped every 5 min since fix248b, see below). Started in
  `boot.ts` before the modules load, so the start-up load is profiled too. `CPU_PROFILE=0` turns it off.
- Every stall over 300 ms (perf.ts) asks for its window (process.hrtime = the profile's clock): top 15 functions by
  self-time, file:line mapped back to the .ts source through dist's source maps, the callers (6 frames) of the top 5.
  `/api/perf` → `web.diagStalls` (8 newest profiled stalls; ?full=1 the last 25), `web.cpuTop` (the functions summed
  over every profiled stall since the start), `web.cpuProfile` (on, profiled, notCovered, errors), and the top 3
  functions beside each of `web.topStalls`. A stall over 500 ms logs "Stall N ms CPU: fn file:line ms · …".
  The old `diagStalls` (stalls while only /api/perf or /api/admin ran) is now `adminStalls`.

**The live profile (c215540, 3 min after a restart, 13 stalls, 0 errors)**: cpuTop = SQLite `get` 2,208 ms / 9 stalls,
`all` 779 ms / 3, loadNow (shared.ts) 713 ms, the part reader (shared.ts:73) 391 ms, v8 deserialize 271 ms / 3,
squadValues.ts:288 126 ms, eachRowPaged 54 ms; everything else < 25 ms. The three worst: 851 ms of `all` from
loadNewerStates on the 30-s timer; 774 ms blocked outside JS (route_cache read in workerRoutes.readCopy); 498 ms of
`get` in pageCache.builtAtOf ← readRow ← getPage. **Rendering was not the cause: synchronous SQLite reads of big rows on
the web thread were.**

### fix248b — the web thread reads no big row (26 Oct)

- `workers/pageReader.ts` (fix243's reader thread, its own read-only connection) runs any read-only statement
  (`readSql` in services/pageReader.ts; BLOBs come back as Uint8Array, no copy). On the web it now does:
  - shared states (shared.ts): the 30-s version check (`SELECT key, ver`), each state's row and each part. The web
    thread only deserializes, one part at a time with a yield between. Parts are now cut from 2 items (was 50) and plain
    objects are cut by their entries too ('o'), so no single deserialize holds a whole big object. /api/perf → shared →
    `maxStepMs` per state = its longest single deserialize on the web (what is left to split).
  - stored pages (pageCache.ts): a row's time (builtAtAsync: indexed, plain query if the index is not there yet), the
    ETag a member's copy checks for 304 (`etags` in getPage, app.ts passes 'full'), and the views (fix243).
  - kept copies of worker routes (workerRoutes.readCopy, the start-up copy): async, read in the thread.
  - paged table reads (utils/pagedRead.ts: squad values, club value history): 200 rows per page from the thread.
  The synchronous read stays only as the fallback when the thread is not there (PAGE_READER=0, it failed).
- The profiler's own cost: each `Profiler.start` makes V8 log every compiled function on the main thread (30–40 ms
  idle, far more under load). Swapping the profile on every stall, or every 2 s, made it the cause of the blocks it
  measured (a 90-s load run went from p95 8 ms to 2.5 s with 2-s swaps). It now swaps every 5 min
  (`CPU_PROFILE_ROTATE_S`) and a stall's functions arrive at that swap (the "Stall … CPU" log line too).
- perf.ts: the stall tick is 100 ms (was 500: a 200–500 ms block was mostly invisible to it); blocks of 150–300 ms are
  profiled too and listed apart (`web.shortBlocks`, not counted as stalls); `web.loopByMinute` = the longest block per
  minute from Node's event-loop delay histogram (10 ms resolution) — the measure the load test uses.
- **Load test** (`npm run test:load`, scripts/load-test.mjs): starts the web + worker here (or `LOAD_URL`), waits for
  the worker's first round of stored pages, then 1,000 visitors (one address each) for 5 min: a page (every language
  and sport, crawler pages, real slug pages from a database copy) then 3 API calls, ~1 s apart. Passes when p95 < 1 s,
  no 5xx and the longest web block < 200 ms; reports p50 / p95 / p99, req/s, 5xx by route with the first answer,
  network errors by kind, the slowest routes, the stalls and their functions. `LOAD_DATA_DIR` = a database copy
  (Admin → Database backups); without it an empty database (checks the harness only). Locally no data-provider key:
  /api/basketball/standings/:code (built from a provider call) is left out (`LOAD_SKIP`).
- **Result** (27 Oct, this PC, the 10 Oct database copy, web + worker, 1,000 visitors × 5 min): 294,069 requests, 971 req/s,
  p50 3 ms · p95 9 ms · p99 43 ms, 0 × 5xx, 0 network errors, longest web block 199 ms → PASS (the block is at the line).
  Before fix248b on the same copy: p99 155 ms, 9.7k × 5xx, a 368 ms block. Still open: a few requests reached 5–8 s at the
  most (max, all routes at about the same moment, the web thread not blocked) — suspected the single reader thread's
  queue behind one slow read; check `pageReader.maxMs` in /api/perf live, two reader threads if it is that. The cluster
  (step 6) is not built: decide from the second live profile.
- Test: `npm run test:fix248` (a 900 ms busy function on top with its line; a dist function mapped to
  utils/slugRules.ts:25 with its caller).

### fix248c — what the second profile left: latency, not blocking (27 Oct)

The second live profile (acaabb2, 24 min of real traffic): **0 stalls over 300 ms** (before: 9–22 an hour, worst 2.5 s);
4 blocks of 150–300 ms (URL parsing, one SQLite prepare). Left: every HTML route with a max of 6.0–6.7 s, the reader
thread's maxMs 1,755, /api/basketball/game/:id avg 2.3 s / max 11.6 s, ~900 /basketball/* renders in 24 min.

- **HTML waits**: the 6 s = the slug lookup asking the worker (3 s) + the wait for a first build (SEO_WAIT_MS 3 s). A
  visitor now waits for neither: 800 ms at most for the slug answer, no first-build wait (the plain app page at once,
  the worker builds the copy in the background). A verified search engine keeps both 3 s waits (it gets the full
  HTML). /api/perf → `seoMisses`: which pages were sent as the app page and why (`not stored yet` / `no html` /
  `old build`, per kind and language, the last 20 addresses) — a kind that keeps missing is one the worker does not
  pre-build.
- **Reader pool**: services/pageReader.ts runs PAGE_READERS threads (default 2, each its own read-only connection),
  a read goes to the least busy one. /api/perf → pageReader: `threads`, `inflight` per thread, `over500`, the 5
  slowest reads (`slowest`: the statement or page key) — names the read behind a max like 1,755 ms.
- **/api/basketball/game/:id**: locally the build is 36–119 ms cold, 1 ms from the kept copy, 6–28 ms signed in (10 Oct
  copy). The live time was the data provider on the request path: `bbStandings` (kept an hour, then the next game
  view waited for API-Basketball; a failed call cached nothing, so every view retried it) and each team's roster
  (`rosterOf`, once 6–24 h old). Now the game page takes the last table (`bbStandingsNow`) and the stored roster at
  once and refreshes them in the background (one call per league / team at a time; a failed table call waits 5 min).
  It stays a worker route with kept copies (signed out: the copy at once, refreshed after 20 s) — the build itself is
  not the slow part. A game page over 1 s in all (waits included) is logged with its parts ("bb game page …").
- **Step 5, who sends the renders**: /api/perf → `htmlBy` (this hour and the last): HTML renders by user-agent
  family × network (AS name, or "other"), "verified" / "unverified bot", and how many were refused. An unverified bot
  (a crawler / tool user-agent that is not a verified search engine, or none) now gets the fix199 address limits on HTML
  from any network (60 an hour, 300 a day per address, 600 an hour per network: botHtmlLimiter) → 429 + Retry-After.
  Before, only data-centre / proxy addresses were counted. Browsers and verified search engines are never counted
  here; this machine's own address is not either (tests).
- The cluster (step 6) is not built: nothing blocks the web thread any more (Yarin, 27 Oct).
- **Profiler off by default** (CPU_PROFILE=1 turns it on): its 5-min swap was the remaining block (321 ms in the load test; the live short blocks of 160–220 ms every ~5 min, mostly (program)). **Load test** (27 Oct, 10 Oct copy, 1,000 visitors × 5 min): 296,628 requests, 980 req/s, p50 2 ms · p95 8 ms · p99 15 ms, 0 × 5xx, 0 network errors, longest web block 97 ms → PASS. Once in the run every route's max reached ~4 s at the same moment while the web thread was free (97 ms): suspected this PC (load client, web and the worker's model builds on one machine) — the live route max tells.

## fix254 — disk-bound reads (28 Oct)

- Indexed one-row lookups took 1.7–1.9 s (page_cache built_at by idx_page_cache_meta, shared_state versions): SQLite's
  default 2 MB cache per connection kept losing the hot index pages, every miss a volume read.
- Every connection: `cache_size` (readers 256 MB, worker 128 MB, web 64 MB, job threads 64 MB; all together ≤ 1/4 of the
  container limit, else scaled), `mmap_size` 1 GB (pages from the OS cache, shared), `temp_store = MEMORY` — utils/dbTune.ts.
- Hot keys in memory on the web: each page build's time + its views' ETags come with the 'page' message, the builds of the
  last 3 min again every 30 s ('page-meta'); a key is read from the disk once per web process (older than 6 days or the
  page's keepMs = read again: cleanPageCache may have dropped it). State versions: the worker sends its whole list every
  30 s ('state-vers'); the web reads the table only at start and when no list came for 90 s.
- /api/slug-of/* and /api/public/results: the 1-s rule for verified search engines too (deadline.ALWAYS_CUT).
- Railway volume latency: services/volumeProbe.ts, every 15 min (32 random 4 KB reads of the database file + one 4 KB
  write + fsync), in data health "Disk" and "Slow reads (3 h)" (which also shows the web's longest stall, target ≤ 500 ms)
  and /api/admin/db-space (`volumeLatency`).
- Trust proxy (fix254 item 1): req.ip = the rightmost X-Forwarded-For hop that is not loopback / private / CGNAT /
  link-local / ULA / Railway (AS400940); the Googlebot-UA log in Admin → Visitors → Search engines shows the chain.
- Test: npm run test:fix254.

## fix250 — nothing ever waits (27 Oct)

Live 27 Oct 00:40 (acaabb2): 0 stalls, reader queue 0, yet game routes 5–12 s and a blank page under the header. The
web thread was free: requests waited for the worker (busy with its jobs), a first build or a provider call — and
signed-in visitors (Yarin) always waited for the worker's fresh answer.

- **The one-second rule** (services/deadline.ts): every public GET not answered after 900 ms (DEADLINE_MS) gets
  `{ pending: true, data: null }` (202, X-SL-Pending), a page the plain app page; the handler keeps running and its
  answer is kept (memory, per visitor: anon / u<id>, proxy flag, gzip; 32 MB) and sent at once next time (X-SL-Copy:
  late; over 15 s old: X-SL-Stale + refreshed in the background, one run at a time). A signed-in person's copies go
  when they POST anything. Verified search engines are never cut (they wait on purpose). boot.ts: the same 900 ms while
  the modules load. Stored pages wait 600 ms for a first build (then pending), worker routes 700 ms (copy kept anyway);
  a copy past its freshness carries X-SL-Stale. Extras are `shared` (signed-in visitors get the signed-out copy).
- **Counted**: every public GET over 1 s by route → /api/perf slowRequests, table slow_requests (per minute, through the
  worker, 7 days) → data health **Slow requests**: fail on any in the last hour (search engines counted apart).
- **App** (frontend lib/apiCache.ts, an axios adapter): the last good answer per address (memory + localStorage under
  300 KB, 150 entries, reset when the person / plan changes); 4 s time-out; no answer in 500 ms + a kept one → the kept
  one at once, the fresh one when it lands (sl:api-fresh, useApiFresh on the game pages); pending / time-out / 5xx →
  the kept one, else asked again 0.8 → 10 s apart (~25 s) with the "Updating…" pill (components/UpdatingPill.tsx);
  PageSkeleton instead of the spinner / "Loading match…".
- **Game bundle** (services/gameBundle.ts, frontend lib/gameBundle.ts): /api/game-bundle/<sport>/<id> = the game route +
  extras + season forecast + more predictions, built by the worker from its own routes with the visitor's headers
  (X-SL-Parts = byte ranges); the web stores each part as that route's copy. The page asks for the bundle while it
  renders; the sections get their part without a call. The worker keeps the bundles opened in the last hour fresh
  (every 3 min, signed-out copies in route_cache).
- **Reader**: READER_THREADS (default 2; PAGE_READERS still read); reads over 500 ms logged once a minute per statement
  with the SQL, the time in the thread and the KB (/api/perf pageReader.slowLog); a stored view over 2 MB is kept as a
  marker row + 2 MB parts read in parallel (pageCache.ts / pageReader.readStored).
- Test: npm run test:fix250. Load: `LOAD_COLD=1 npm run test:load` = the server started, 200 visitors in its first
  minute, pass = every request < 1 s and no 5xx.
- **Measured** (27 Oct, this PC, the 10 Oct database copy, web + worker, provider keys blanked):
  - steady (`npm run test:load`, 1,000 visitors × 5 min): 297,029 requests, 981 req/s, p50 3 ms · p95 13 ms · p99 65 ms ·
    **max 930 ms** (every request under 1 s), 0 × 5xx, 627 × pending, longest web block 131 ms → PASS.
  - cold start (`LOAD_COLD=1 npm run test:load`): port answering 0.49 s after the start, 200 visitors in the first minute:
    11,960 requests, p95 12 ms, p99 283 ms, **max 908 ms**, 0 × 5xx, 11 × pending → PASS.
  - paint (`npm run test:paint`, Chromium, cold server, 20 pages across sports / languages, phone size): every page
    painted (skeleton or content) within 303 ms, none blank → PASS. Content: median 281 ms; 6 football match / team pages
    stayed on the skeleton + "Updating…" because the worker answered 500 "API_FOOTBALL_KEY is not set" here (no
    provider key locally) — on the server they are built.
  - slow-read log: no read over 500 ms in these runs.

## fix249 — database growth and the last slow reads (27 Oct)

Overnight 27 Oct: reader-thread reads up to 9.8 s (paged reads of club_value_comp / squad_players, the state version
list 5.5 s), 104 over 500 ms; "database" 2.6 GB (1.1 GB on 18 Oct). No database copy was available in the session, so
the numbers come from the server itself.

- **The size shown is file + WAL** (backup.ts `dbSize`). The WAL never shrank: no `journal_size_limit`, and a WAL only
  starts over when a checkpoint caught up with no reader on an old snapshot. Now `journal_size_limit` = 64 MB on the
  main connection and the upkeep thread (workers/dbMaint.ts, its own connection) runs PASSIVE every 5 min and TRUNCATE
  every 30 min — TRUNCATE takes the writer lock before it copies, so it runs only after a lock-free PASSIVE pass caught
  up, with a 300 ms wait for old readers (writers are held at most that long). "Blocked by a reader N in a row" in Disk = a
  long read transaction somewhere (dbstat, VACUUM INTO backup, a thread) keeps the WAL.
- **Retention** (utils/retention.ts, hourly, 2,000 rows a statement, 20 ms pause, 30 s a run): bot / no-signs visits and
  bots' league opens 14 days (people's 90 days: the 30-day numbers), crawler / scraper days, user-agent usage, browser
  errors, worker exits, reader hours, once-a-day alert marks, auto-fix notes already summarised, data-audit runs (last
  kept), deploy errors — 14 days; route copies 2 days (was one big hourly DELETE). PROTECTED lists the tables no rule
  may name (record, predictions, results, accounts, money, consent, security log). Kept as before: security_log 90 days,
  perf_hours 48 h, slow_requests 7 days, push_events 60 days, page_cache (cleanPageCache). Looked at and bounded
  already: market_odds / tennis_prices (one row per match), diff_view_flags (one per game, frozen), feature_model (40),
  shared_state / page_cache (replaced in place).
- **Space back**: the file had auto_vacuum = 0 (freed pages stay in the file). The one full VACUUM that turns on
  INCREMENTAL runs in the upkeep thread between 01:00 and 02:30 UTC (before the 02:40 backup) when free pages are
  ≥ 256 MB / 15% and the volume and temp disk have the file's size left (DB_VACUUM=0: never; POST
  /api/admin/db-space/vacuum: now). Writes wait while it runs (reads go on). After that every 10 min: incremental
  vacuum 1,024 pages a slice, 250 ms pause, ≤ 45 s, then TRUNCATE — the file shrinks at that checkpoint.
- **Slow reads**: the state version list reads `idx_shared_state_ver (key, ver)` with INDEXED BY (covering: the state
  rows are not visited); the web process no longer loads squad values or club value history at all (every caller is in
  the worker; the worker loads them once, its job threads on the state message). The paged reads were rowid range
  seeks already — their 9.8 s was time in the reader thread's queue / disk, not a scan.
- **Measured**: reader_hours (per hour: reads, over 500 ms, longest + what, written by the web via deferred); data
  health "Slow reads (3 h)" = the proof (no read over 500 ms, no slow request); "Disk" = volume free %, file + WAL,
  7-day growth from db_size_days, days until full (warn < 30, fail < 7 or < 10% free), the 15 biggest tables / indexes
  from the daily dbstat report (01:10 UTC, upkeep thread) with their own 7-day growth (db_space_tables).

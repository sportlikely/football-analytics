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

## fix202 (23 Oct 2026): background jobs in a separate worker process; pages never built on a visitor's request

Before (`/api/perf`, 23 Oct, 67 min after a start, one process): **90 stalls an hour, worst 5.9 s, event-loop max 8.8 s**,
memory 975 MB. Causes: football live tick (one 5.9 s stall, job max 38 s), basketball model rebuild (8.8 s), basketball
live (1–1.5 s), and endpoints built on request when cold: `/api/basketball/games` 3.8 s, `/api/tennis/record` 2.7 s,
`/api/draw-alerts` 2.4 s, `/api/nfl/home` 2.0 s (0.3 s when cached).

How it works now (two processes, one container, one SQLite file in WAL mode, `busy_timeout` 5000):

| Process | Entry | Runs |
| --- | --- | --- |
| web (PID 1, `node --max-old-space-size=512 dist/web.js`) | `web.ts` | stored pages, the built site's files, the live socket, `/api/health`; passes everything else to the worker as it came in (`X-Forwarded-For` + the address it saw). No job, no model, no provider call. |
| worker (child, `--max-old-space-size=$WORKER_HEAP_MB`, default 1536) | `worker.ts` → `index.ts` in the worker role | every scheduled job (live polls of every sport, fixtures, results / settling, odds, line-ups / injuries, model builds and daily tuners, news, data health, backups, warmers, sitemaps), every route on `127.0.0.1:$WORKER_PORT` (3901), the page builds |

- **Stored pages** (`services/pageCache.ts`, table `page_cache`): the football lists (`/api/matches/upcoming`, `/live`),
  `/api/public/summary`, `/results`, `/api/draw-alerts`, `/api/news`, `/api/hub*`, basketball games / record / standings,
  NFL home / record, tennis home / record, and the crawler HTML of the home pages and hubs in every language. The worker
  builds each one by asking its own route once per plan that sees it differently (signed out, free, Premium, Pro; e.g.
  the football lists: everyone but Pro gets the trimmed copy) — `services/pageBuilder.ts`. The web process answers from
  the stored copy at once (header `X-Stored-Age`), never waits for a build: a copy past its ttl (15 s – 15 min per page)
  is rebuilt by the worker, which hears every 2 s which pages were asked for. Prebuilt on start (`PREBUILD`: what the
  four home pages and the lists ask for); other query variants are stored after their first request (that one goes to
  the worker). A copy made before the worker's start (a deploy, other settings) is served and rebuilt in the first
  rounds; HTML only with the same `index.html` (asset names). A route that fails (5xx) keeps the last good copy and is
  asked again after its ttl (30 s – 5 min).
- **Who gets a stored page**: anyone signed out or on a plan, except admins, staff with permissions, data-centre /
  proxy networks (fix199 limits live in the worker) and maintenance tokens — those go to the worker. Signed-in users
  with unlocked games: football lists = the full copy trimmed for that user in the web process (same `teaseDeepExcept`
  as the auth middleware); basketball / NFL / tennis lists go to the worker (it decides per game).
- **Live**: the football live poll (worker) writes one row per live game to `live_state` (only rows that changed) and
  sends `{ ids, changed }` over the child-process channel; the web process re-reads the changed rows and pushes them on
  the socket (`services/liveSocket.ts`, same events as before). No live polling code in the web process.
- **Restarts**: the web process answers within a second of a start (stored pages + files; `/api/health` at once), the
  worker loads models after. If the worker exits it is started again (1 s, doubling up to 30 s while it keeps dying
  within 5 min); requests for it wait up to 20 s, then a page gets the app shell (`index.html`) and an API call 503 +
  `Retry-After: 5`. The worker stops if the web process goes away.
- **`/api/perf`**: the web process's numbers on top (`stallsLastHour`, `worstLastHour`, `memoryMb`, `front`: stored /
  trimmed / passed on / missed), `worker`: the worker's own perf (jobs with `lastAt` = last tick per job, stalls,
  memory) + `restarts`, `lastExit`, `pages` (built, failed, queue). Logs: the worker's lines carry `proc: "worker"`.
- **`WORKER=0`** runs `index.ts` alone, exactly as before fix202 (one process: jobs and requests together).

Not changed: pages outside the stored list (match / team / player / game pages, search, accounts, admin) are still
built by the worker on request, so a long worker job can still delay them (never the web process: it only waits).
Visitor counting (`trackVisit`) runs in the worker only: a stored-page request is not counted itself, the same visitor's
other requests (`/api/auth/me`, the "seen" beacon …) are. Rate limits apply to what reaches the worker; stored pages
cost nothing.

Tested locally (10 Oct database copy, provider keys blank, `BASKETBALL_PUBLIC` / `NFL_PUBLIC` / `TENNIS_PUBLIC` = 1):
- `npm run test:fix202`: page keys, which plans share a copy, stored-page ages / prune, live rows (order, changed only,
  removed when a game ends or after a worker restart).
- `npm run test:fix202:live` against `node dist/web.js` (env as above + `DB=` the copy): 15 pages × 5 visitors (signed
  out, free, Premium, Pro, free with unlocked games): **71 of 75 answers from stored copies, every one equal to the
  worker's own answer** for that visitor (timestamps left out; the only other difference: basketball standings, where
  the worker answers 500 here without a provider key and the stored copy is kept). Stored pages 2–3 ms (under 50 ms
  each); the 4 home pages' HTML byte-identical to the worker's. Live: the socket of the web process gets every 20-s
  tick. Worker killed: stored pages still answered (18 ms), a request for the worker waited 2.4 s for the restart.
- Start: the home page answered **0.63 s** after `node dist/web.js` (stored copy); worker ready ~1 s later.
- Memory here: web 70 MB, worker 172 MB (no provider data; production: ~975 MB in the worker).
- `WORKER=0`: one process, as before.

### Check after deploy (pending)

1. Railway memory: web + worker under the plan's limit (`/api/perf` → `memoryMb` + `worker.memoryMb`); if the worker
   needs more heap, set `WORKER_HEAP_MB` (default 1536).
2. Within 10 s of the deploy: `/` and `/api/public/summary` answer in < 1 s (`X-Stored-Age` header present).
3. After 1 hour of normal traffic, `/api/perf` (web process, top level): **stallsLastHour < 5, worstLastHour < 500 ms**;
   `worker.restarts` 0; `worker.pages.failed` small next to `built`.
4. First and second load < 600 ms: `/api/matches/upcoming?days=30`, `/api/public/summary`, `/api/public/results`,
   `/api/draw-alerts` (Pro), `/api/basketball/games?days=7`, `/api/basketball/standings/NBA`, `/api/nfl/home`,
   `/api/tennis/record?days=30&tour=all`, `/`, `/es/basketball`.
5. A live football match: the home Live strip and the match page move with the score (socket), signed out and as Pro.

Result: _to fill in after the check (before → after: stallsLastHour 90 → ?, worstLastHour 5.9 s → ?, the endpoint times)._

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

### Check after deploy (pending)

Two hours of Railway logs after the fix194 deploy: no "Event loop blocked" over 300 ms (only those over 500 ms are
logged; `/api/perf` lists the rest) mentioning tennis, model daily or player pages warm. Also check that the next
04:00 UTC daily job runs without a stall, and `/api/perf` → `heavy` shows the queue moving.

Result: _to fill in after the check._

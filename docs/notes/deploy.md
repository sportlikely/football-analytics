# Deploys and the site check (fix260, Yarin 28 Oct 2026 — permanent)

Nothing broken reaches visitors: every push to `main` runs the **Site check** (GitHub Actions,
`.github/workflows/site-check.yml`) and Railway deploys the commit only when that check is green.

## The one Railway setting to switch on (Yarin)

Railway → project → the SportLikely service → **Settings** → **Source** (the GitHub repo
`sportlikely/football-analytics`, branch `main`) → switch on **"Wait for CI"**.

With it on, Railway waits for every GitHub check on the pushed commit; a red **Site check** = the deploy is skipped
(it shows as "Skipped / waiting for CI" in Deployments, the live site keeps the previous build). Without it Railway
builds every push at once, as before. The toggle appears only once the repository has a GitHub Actions workflow
(this one) — push fix260 first, then switch it on.

Optional, for the email with the failing pages: GitHub → repo → Settings → Secrets and variables → Actions →
`RESEND_API_KEY` (the same Resend key as Railway's) and `REPORT_EMAIL_TO` (the address it goes to); `EMAIL_FROM`
optional. Without them GitHub's own "run failed" email still arrives (GitHub → Settings → Notifications → Actions), and
the run's summary page lists the pages in plain words.

## What the check runs

1. **Typecheck, parity, build** — backend `tsc --noEmit`, frontend `tsc --noEmit`, `npm run parity` (now also
   `scripts/relative-links-check.ts`: every internal link starts with `/`), the server build, the app build +
   `chunks-check` + the relative-link check on the built app.
2. **test:links** (`backend/scripts/links-test.mjs`) — a signed-out visitor starts from the sitemaps and the home page
   of every language, opens each page, follows every internal link 2 levels deep; fails on a relative href, a 404 /
   410 (a past season's match 410 is allowed) / 5xx, a redirect loop or more than one redirect hop, a link that opens
   the app's 404 or the search. Language copies of a page are checked over HTTP (same routes as the English page).
3. **test:site** (`backend/scripts/site-test.mjs`, 8 parts side by side, one Chromium per part, every job capped at
   15 min). fix260d — on a push it is the **gate** (`SITE_MODE` default): every route in English at 375 px and
   1280 px as a signed-out visitor and as the admin, every Admin and CRM tab with the staff console signed in and locked,
   and one page of each type (home, football home / matches / today / match / match tab / team / player / league,
   a basketball match, premium, search, the 404) in every other language at 375 px as a visitor (the admin-only
   languages ar / he as the admin) — about 620 page opens. The **full matrix** (every route × every language × both
   widths × visitor / free user / admin, ~7,400 opens) runs **nightly** (`site-nightly.yml`, 01:17 UTC, mode `full`,
   90 min cap per part) and emails its failures; it is not a gate. Pass = no console / page error, no first-party
   4xx / 5xx (except the intended 401 / 423 of a locked console and the 404 page's own 404), no "Something went wrong" /
   card error, no "Updating…" or skeleton still there 3 s after the page loaded, content painted. Outside addresses are
   blocked (hermetic). A warm-up round opens each route once first (one page per worker, reused); a route whose
   answers were all stored copies is done at once, only a route still being built is waited for (`SITE_WARM=0` skips it).
4. **Report** (only when something failed) — `backend/scripts/ci-report.mjs`: the failing pages in plain words on
   the run's summary and by email.

## The data the tests use

- CI and a plain local run: a fresh database seeded by `backend/scripts/site-seed.mjs` — test users (test values
  only: `admin@sl-test.local`, `free@sl-test.local`, password `Test-pass-1`, console `admin` / `Console-pass-1`,
  session cookies in the file) and four teams / players / games per sport around today (finished, today, coming),
  with predictions; slugs built by the app's own job (basketball names in the API's last-first order, so the
  first-name-first slugs and their 301 aliases are tested too).
- A production-size copy: `SITE_DATA_DIR=<folder with bet-to-beat.sqlite>` (Admin → Database backups, user tables
  emptied). The copy is copied to a temp folder first (never changed) and only the test users are added.
- No data-provider, email, AI or payment key reaches the test server (no outside call). The football match / team /
  player pages and the league table now open from our database when the provider fails (fix260), so they render in
  the tests as they do for visitors when API-Football is out of calls.

## Running it locally

```
cd backend && npm run test:site                    # the gate: ~620 page opens, ~4 min on 4 cores
SITE_MODE=full npm run test:site                   # the nightly matrix: ~7,400 opens, ~50 min on 4 cores
cd backend && npm run test:links
SITE_ONLY=/admin npm run test:site                 # only the routes containing /admin
```

Reports: `backend/site-report.json` (records the git tree it tested — the Stop hook compares it with HEAD) and
`backend/links-report.json`.

## 28 Oct 2026: the two failed Railway builds (11:56 and 12:05 UTC)

The Railway build logs are not reachable from a Claude session (no Railway login). What was checked: the commits pushed
then (fix258 `65d66f3` at 11:53, fix259 `2a9708e` 12:01 / fix259b `78723a9` 12:04) build cleanly with the Dockerfile's own
steps (`vite build`, backend `tsc`) — not a code error. The cause found the same afternoon (fix265 / fix265b, the
"Docker build (Railway check)" workflow that runs the Dockerfile on GitHub): the base image pull from public.ecr.aws
answered 429 "Data limit exceeded"; the Dockerfile now pulls `mirror.gcr.io/library/node:24-alpine`. The server live at
the time started 12:25:44 UTC (`/health` readyAt), right after fix257 `9675fed` (which contains fix258 + fix259 and still
had the Admin → Site health crash fixed by fix260).

With "Wait for CI" on, Railway waits for both workflows on the commit: "Site check" (this note) and "Docker build
(Railway check)" (fix265).

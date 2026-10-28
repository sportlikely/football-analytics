# SportLikely — instructions for Claude (read first, every session)

## Shipping (read first)

Every fix ends on **main** (Yarin, fix233: fix228–231 sat on claude/* branches and Railway never built them). Whatever
branch this chat is on (claude/*, a worktree, anything):

- `git pull --rebase origin main` → on conflict keep both sides → typecheck (backend + frontend, `npm run parity`) + this
  fix's tests → `git push origin HEAD:main`.
- Never stop at "pushed to my branch". If `git push origin HEAD:main` is refused, pull --rebase again and retry (up to 3
  times), then report the error.
- After pushing, check: `git fetch origin && git branch -r --contains HEAD` shows `origin/main`. Reply with the commit
  hash on main and the first line of the commit message.
- Never force-push main. Never push to main with a failing typecheck.
- Payments changes are the only exception: they go on a branch and Yarin merges (existing rule).
- A failed Railway deploy (fix265): GitHub Actions "Docker build (Railway check)" (`.github/workflows/docker-build.yml`)
  runs the same Dockerfile + a /health start on every push to main — read its log for the failing line.
- **A fix is done only when `npm run test:site` is green locally AND the "Site check" run on GitHub is green** (fix260,
  Yarin 28 Oct: every page checked before every deploy). Before pushing: `cd backend && npm run test:site` and
  `npm run test:links` (full runs; `SITE_LANGS=en SITE_WIDTHS=1280` only for a quick pass while working). After pushing:
  the Site check (`.github/workflows/site-check.yml`: typecheck, parity, test:links, test:site in 8 parts) must pass —
  Railway deploys only then ("Wait for CI", docs/notes/deploy.md). A red run = not deployed: fix it, push again.
- The Stop hook (`.claude/settings.json` → `.claude/hooks/check-on-main.mjs`) asks once at the end of a task when HEAD is
  not on origin/main, or when `backend/site-report.json` is missing / red / partial / from other code than HEAD; then warns.

SportLikely (sportlikely.com) is a sports-prediction site: football live, basketball launching ~18 Oct 2026, more sports later.
Owner: Yarin. One repo, one Railway service (`railway.json`, Dockerfile) serving the API and the built site. SQLite on a
Railway volume (`DATA_DIR=/data`). Push to `main` = deploy.

**Start of every session:** read this file, then `docs/notes/backlog.md` (what is open, what was decided) and the note
that matches the task. Decisions in `docs/notes/` are Yarin's decisions — follow them unless he changes them in the chat.
When you finish something durable (a new feature, a model result, a decision), update `docs/notes/backlog.md` and, if it
is model work, the matching note, in the same commit.

## Hard rules (never break these)

- **No bookmakers on the public site.** No odds, no bookmaker names or links. Odds comparison exists for admins only
  (model quality). Ads policy reason. Public proof = hit rate, strong picks, calibration.
- **Israel is treated like every other country** (Yarin, 19 Oct 2026): no special hiding and no highlighting. Ligat
  Ha'al (AF383) is a normal predicted league. The Israeli basketball league is not added yet (ask Yarin first).
- **Past seasons / backtests are admin-only** on every sport. The public record starts on launch day. A past season's match page
  answers 410 + noindex for non-admins, is out of sitemaps / crawler HTML and gets no app link (fix243: `services/pastSeason.ts`,
  frontend `lib/links.ts` matchHref → null, `components/MaybeLink.tsx`).
- **Secrets:** never print, log, commit or ask for API keys, tokens or passwords. They live in Railway variables.
  Never change or delete `TOTP_KEY` or `BACKUP_KEY` (two-step login and backups would break).
- **Accounts and money:** Yarin creates accounts and pays himself. Admin login needs two-step. Staff can't change their
  own console password. Account deletion must remove the user's picks/favorites.
- **Privacy:** never store visitor IPs except in the security log (90 days). Visitors are shown by country only.
- **Images:** don't hotlink NBA headshots (cdn.nba.com) or copy news photos. Crests/logos come from the data providers.
  **Official player photos only** (Yarin, fix241): a player photo is shown only when its source is on the allow-list
  (`backend/src/utils/photoSources.ts` = `frontend/src/lib/photoSources.ts`: API-Football today); no Wikimedia / Wikidata
  / free-licence photos. Everyone else: initials + flag (`components/sport/PlayerPhoto.tsx`). A licensed provider later =
  one allow-list entry + the playerPhotos.ts slot.
- **Branding:** the brand is "SportLikely" (sports in general, not "football predictions"). Copy says "sports
  predictions", "probabilities, not promises", "18+". No "bet"/"wager" wording in the product name or nav.
- **Model principle (Yarin):** a pick must make sense when someone looks at the stats. Keep home advantage, but a team
  with clearly worse form / table / head-to-head must not be made the favourite. Every model change is accepted only if
  it improves log loss / Brier on games it never saw (walk-forward or later seasons), never on the fitting data.
- **Public model names (fix191):** visitors see "SL <Sport> <major.minor>" only (SL Football 3.0, SL Basketball 3.1, SL
  American Football 1.0), from `frontend/src/lib/modelNames.ts` (backend twin `backend/src/utils/modelNames.ts`), never the
  internal ids (grid-v3, bb-v3, nfl-v1 …); admin pages show both ("SL Football 3.0 (v3-mix)"). Major = a new model, minor = a
  tested improvement that goes live: bump `version` and `since` in both modelNames files in the same commit. Weekly re-tunes
  don't change the number. General branding says "the SL engine" (no sports listed).
- **`BILLING_TEST_MODE`** must be removed before real payments go live. Don't wire real payment webhooks without Yarin.
- **Team analysis for every sport:** Every sport has team analysis on the team page (strengths & weaknesses by fixed rules, model rating tiles, 1–10 league scores, rank over time, our record on the team) — build it with the sport, not later.
- **List rows:** List rows in every sport use the fix127 block (commit 9b3f610): result cells with % (our pick highlighted) + 'Our pick · {words} · %' underneath. Phones too.
- **Football is the template for every page.** Every sport renders the shared components in components/sport/* (and
  components/SportHome for the home) with an adapter; never build a sport-specific page layout. Anything added to football is
  added to all sports. Menus come from one per-sport config (`frontend/src/lib/sportNav.ts`). No season / week picker on
  public lists (current season only; past seasons are admin-only).
- **Live games:** Live games appear once — in the Live strip — and never again in the day lists, in every sport; live cards look the same in every sport (football is the reference).

## Links (Yarin, 25 Oct 2026 — permanent, every sport, every language)

- **Every public page is `/<lang?>/<sport>/<kind>/<slug>`**: teams, players, leagues, matches, any future page type, any future
  sport (`/football/team/real-madrid`, `/es/basketball/match/lakers-vs-celtics-2026-10-26`, `/tennis/league/atp-paris-masters`).
  `<sport>` = football | basketball | american-football | tennis (a new sport: its name with dashes); one word "match" for
  every sport. Sport homes: `/football`, `/basketball`, `/american-football`, `/tennis` ("/" stays the site home).
- **No ids or query strings in public links.** Links come from `frontend/src/lib/links.ts` (teamHref / playerHref /
  leagueHref / matchHref, never a hand-built path); the server turns any old address into its slug one with `pubPath` /
  `pubLinks` (`backend/src/services/slugs.ts`). The few allowed query params are `ALLOWED_QUERY` in the slug rules (one list).
- Slug rules: one file, two copies that must stay identical (`backend/src/utils/slugRules.ts`, `frontend/src/lib/slugRules.ts`):
  lowercase ASCII with dashes, common short name. Who gets a shared name: `utils/slugAssign.ts` (the bigger item keeps the
  plain slug; the next gets name + country / team / birth year / -2). Table `slugs` (sport, kind, slug, id, is_primary).
- **Old links 301 in one hop, forever**; a renamed item keeps its old slug as an alias (301 to the new); an unknown slug opens
  the search (`/search?q=`), never a 404. New items get their slug from the worker's "slugs" job (15 min).
- **No `#…` for tabs — tabs are sub-paths; every sport page is `/<sport>/<page>`** (fix235). A match page opens on the
  prediction (`/football/match/<slug>`); its tabs are `…/stats`, `…/lineups`, `…/h2h`, `…/table`, `…/highlights` … (same names in
  every sport, `MATCH_TABS` in the slug rules, `lib/tabPath.ts`; a league's `…/forecast`; account / premium sections
  `/account/emails`, `/premium/packs`). Sport pages, same names in every sport: `/<sport>/matches`, `/today`, `/predictions/<league>`,
  `/favorites`, `/my-picks`, `/upset-watch`, `/draw-alerts`, `/accuracy`, `/past`; football is no longer at the root. Site-wide
  pages stay at the root: `/`, `/search`, `/account`, `/premium`, `/guides/…`, `/changelog`, `/how-it-works`, `/privacy`, `/terms`,
  `/contact`. Old addresses (`/matches`, `/predictions/today`, `/basketball/games` …) 301 in one hop (`movedPage` in the slug rules);
  old `#tab` links open their tab and the address becomes the sub-path. In-page `#` anchors only on guide pages.
- `npm run parity` fails on an id / query-string link, a `#…` link, an old page address or a missing `/<sport>/<kind>/:slug`
  route (scripts/links-check.ts); `npm run test:fix229` (backend) checks the rules, uniqueness, one-hop 301s and the sitemaps,
  `npm run test:fix235` the tab sub-paths and the page moves. Notes: docs/notes/links.md.

## How to work here

- Branches: every fix lands on `main` (see "Shipping" at the top). For anything touching payments, push a branch and
  ask him to merge.
- Commit message style: `fixNNN: short description` (next number: see the top of `docs/notes/backlog.md`). Keep the
  counter going.
- Before pushing: `cd backend && npx tsc --noEmit -p .` and `cd frontend && npx tsc --noEmit -p .` must pass
  (frontend has `noUnusedLocals` / `noUnusedParameters` on). Don't commit `node_modules`, `dist`, `.env`, `*.sqlite`.
- Before pushing: `cd frontend && npm run parity` must pass (also part of `npm run type-check` / `npm run build`). A new
  football block means a parity key in `frontend/src/lib/sportParity.ts` + the basketball and NFL versions in the same
  commit (listed in their `*.parity.ts` files), or an 'na: <reason>' Yarin approved (`docs/notes/sport-parity.md`).
- Copy: short, plain English, no jargon. Locales in `frontend/src/locales/*.json` (de, es, fr, it, pt, tr, id, hi, pl, el,
  ru (fix256), ar, he (fix257); English is the key). A new UI string needs the key used through `t("...")` and a
  translation in every file (`json.dumps(..., ensure_ascii=False, indent=1)` keeps the file format); `npm run parity`
  (scripts/locales-check.ts) fails on a missing key. ar / he are right to left and admin-only until the Railway variable
  `PUBLIC_LANGS` names them (backend `utils/langs.ts` = frontend `lib/i18n.ts` LANGS): no hreflang / sitemap / crawler HTML,
  /ar and /he 404 for visitors. Layout uses logical classes only (ms-/me-/ps-/pe-/start-/end-/text-start/text-end, never
  ml-/mr-/left-/text-left), a direction glyph or icon gets `.rtl-flip`, a signed number `ltr()`; numbers stay Western
  digits, dates via LOCALE. fix261: 1 · X · 2 cells and scores / ranges stay left to right on ar / he (`dir="ltr"` on the
  cells, `lib/rtlNumbers.ts` isolates every digit–dash–digit run).
- Server-written sentences (team analysis notes, model reasons / row notes, tennis why lines, labels inside lists,
  form errors) are translated on the page by `tg()` (`frontend/src/lib/genText.ts`: each sentence the server can write is
  a `g("…")` template = a dictionary key, numbers / names / months filled in). A new server sentence = a `g()` line +
  its translations; `npm run test:fix261` (backend) fails on a generator sentence without a template and renders home /
  team / match tabs / player / Upset watch in all 13 languages, failing on any English line (test-output/lang-audit.json).
- Names in the local script (fix261, he / ar; ru / el / hi later): `services/names.ts` (tables `name_items` + `names`,
  worker job "names" every 30 min: admin > press spelling > Wikidata label > letter rules `utils/nameScript.ts`), map
  `/api/names/<lang>` loaded before the first paint (`frontend/src/lib/names.ts`: API answers' name fields swapped, socket
  too); links / slugs / fixed Latin lists use `latinOf()`; the server's own texts `nameIn()` (crawler titles + body,
  emails, push, calendar); search takes both scripts (`latinFor`). Admin → Data & feeds → "Names in Hebrew / Arabic".
- Phones first: check layouts at 375 px. Bottom nav on phones; floating accessibility button bottom-left.
- Don't add dependencies without a reason; the backend uses Node's built-in `node:sqlite`, no ORM.
- The server can't be reached from local tests; test model changes on a database copy (admins can download one from
  Admin → Database backups) with `DATA_DIR` pointing at a folder holding `bet-to-beat.sqlite`, user tables emptied.

## Map of the code

Backend (`backend/src`, Express + TypeScript, `app.ts` holds every route):
- Processes (fix202): `boot.ts` = the container entry (fix227: listens before the modules load, then loads index.ts); `index.ts` = the web process (listens, live socket, reads the database, starts and restarts the
  worker); `worker.ts` + `jobs.ts` = every scheduled job. A new scheduled job goes in `jobs.ts` (or a service's
  start…Scheduler), never in app.ts / index.ts. Model state the pages read is published by the worker
  (`publishState` / `onState`, services/shared.ts); a heavy page every visitor opens is a stored page (`definePage`,
  services/pageCache.ts); live games go through services/liveState.ts. `WORKER=0` = one process. Admin / staff
  routes are answered by the worker (forwarded). Notes: docs/notes/perf.md (fix202).
  fix210: the web process never builds a page — a public route that builds something is listed in WORKER_ROUTES and
  PUBLIC_ROUTES (services/workerRoutes.ts: the worker answers, signed-out copies kept) and its builder registered
  (services/builders.ts); crawler HTML = stored pages. `npm run parity` + `npm run test:fix210` fail otherwise. Heavy
  model builds run in a job thread (services/threadJob.ts); a heavy loop yields every 50 items / 100 ms (yieldEvery);
  one heavy job at a time (heavy()); every cache has a size cap. Exits / memory / stalls: services/perfHistory.ts.
  fix210b: the web process writes nothing but sign-in / account actions — anything else goes through
  `deferred(sql)` (services/deferredWrites.ts: written by the worker); it loads the stored state before it listens.
  fix221: the web process only sends stored strings — never JSON.parse / stringify a page there. Every stored view has
  an ETag + gzip copy (made by the worker); a big list is stored row by row (`rows` in definePage: members' copies are
  joined from the strings); anything that needs the page itself goes to the worker (`byWorker` in app.ts).
  fix232: stored-page builds run in their own lane (perf.pageLane), never behind a heavy job; model rebuilds / fits of
  every sport (perf.MODEL_JOBS — add a new model job there) start after the first page round; warm lists are never
  dropped from page_cache (a restart serves the last copy, X-SL-Built-At). /api/perf = summary (?full=1, ?shared=1).
  fix263: two reader pools (services/pageReader.ts: `readSql(sql, args, all, pool, prio)` — 'small' for one-row lookups and
  rows under 64 KB, 'big' for states / parts / big views; 'bg' for loads no request waits on); the web holds the worker's
  whole page list (no page time read from disk) and slug ↔ id for every season (slugs-ids index). A static or
  near-static public answer is a stored page (definePage + warm), never computed on the web.
- Football data: `footballDataAPI.ts` (Football-Data.org: top leagues + Champions League), `afMatches.ts` +
  `apiFootball.ts` (API-Football: extra leagues, cups, national teams, lineups, injuries, match stats, player data),
  `unsettled.ts` + `utils/voidRules.ts` (fix200: games past kick-off + 48 h without a final → settled / moved / void with a
  reason; admin `/api/admin/voided`), `history.ts` (football-data.co.uk result history + per-league groups), `leagueConfig.ts` / `leagueCoverage.ts`
  (leagues added from Admin → Football leagues; each = group `AF<id>`, history from API-Football fixtures).
- Football models: `gridModel.ts` = **v3 (grid-v3)**, the live model for leagues: factor rows (squad value, Elo,
  attack/defence, confirmed XI, missing players, freshness, home/away record, H2H…) → points → probabilities, with the
  common-sense guard (`h2hGuard.ts`). `clubElo.ts` = `elo-euro` for UEFA cups (CL fixtures come from Football-Data.org,
  teams matched to API-Football clubs by name in `matchFdTeam`). `nationalElo.ts` = `elo-intl` for national teams.
  `historyModel.ts` = v2 (hidden), `predictionModel.ts` = v1 (fallback only; should not be visible for big games).
  `v3Tuner.ts` = full tune, `tracking.ts` = saved predictions + public record (every competition counts, fix203)
  `liveChance.ts` = live win chance. `featureModel.ts` = feature model (feat-v1) + v3-mix
  (shadow until published), `modelDaily.ts` = daily champion / challenger (04:00 UTC) + 07:00 Israel-time report.
- Basketball: `basketball.ts` (API-Basketball games/box scores, `BB_LEAGUES`), `bbModel.ts` (**bb-v3**: v1 ratings +
  v2 possession ratings, 50/50 blend, player talent), NBA on top: `nbaV4.ts` + `utils/nbaImpact.ts` (**bb-v4**, fix217: player
  impact ratings, injuries / line-ups re-priced 90 / 30 / 10 min before tip-off, gate → full or re-pricing only, admin "NBA
  model check"); every league: **bb-v4 grid** (fix219, football v3's structure): `utils/bbGridMath.ts` (13 rows, conversion,
  1,000-points split, pattern-search tuner), `bbGrid.ts` (walk-forward rows per league, `bb_grid_rows`), `bbTuner.ts` (tune /
  gate per group NBA / Europe / rest, `/api/bb/tune`, `/api/bb/tuned`, settings in `bb_tuned`), `bbSite.ts` (pages), `bbPlayers.ts`, `bdl.ts`
  (balldontlie: NBA injuries/players), `bbInjuries.ts`, `bbResults.ts` (result checks), `bbLive.ts` (live win chance + projected score), `bbLeagueConfig.ts` /
  `bbLeagueCoverage.ts` (leagues added from Admin → Basketball leagues, code `BB<id>`). `BASKETBALL_PUBLIC=1` opens
  the basketball site to everyone (admins see it before).
- NFL + college football (fix136–142; college = league 2, ncaa-v1, lists under /american-football/college, `?league=` on the API): `nfl.ts` (API-American-Football client, key `API_NFL_KEY` or `API_FOOTBALL_KEY`;
  tables nfl_games / nfl_teams / nfl_team_stats / nfl_player_stats / nfl_players / nfl_injuries / nfl_standings; games every
  30 min, live every 30 s during games, box scores after full time, standings 6 h, injuries 2 h, rosters daily; every job
  checks the day's quota), `nflSite.ts` (pages: weeks, game, standings, team + rule-based team analysis, player, leaders),
  `/api/nfl/*`, `/api/admin/nfl-probe`. fix174: `nflLive.ts` (live win chance, projected score, swing-chart samples per live tick),
  `nflGameExtras.ts` (schedule & rest, standings, likely starters, numbers changed, written preview, scoring plays), `nfl_player_games` (career index).
  Basketball swing chart: `bbLive.ts` keeps `bb_live_samples` (fix178). `npm run parity` (frontend) must show zero 'todo'. **`NFL_PUBLIC=1`** opens /american-football to everyone (admins see it before);
  past seasons stay admin-only. Frontend `pages/nfl/*`, `lib/nfl.ts`.
  fix220: calibration layer per league (`utils/afCalib.ts`, `afCalibration.ts` worker build, `afCalibState.ts` read everywhere: shown
  chance = layer(model chance), raw in `nfl_predictions.p_raw`, strong line per league) and **ncaa-v2** (`utils/ncaaV2.ts`, live only
  when it beats ncaa-v1 on 2025 conference games). Data health "Calibration (<sport>)" for every sport (`calibrationHealth.ts`).
  fix223: per-league settings like football's league tune (`utils/leagueSettings.ts`: own / group / shared, fit 2022-23 + 2023-24 →
  kept only if better on 2024-25 → refit; 2025-26 untouched check): basketball in `bbTuner.runLeagueTune` (bb_tuned 'leagues'),
  American football per level (NFL / FBS / G5 / FCS) and tennis per tour × surface inside their calibration builds.
  fix228: bb-v4 row #4 (missing players) weight fitted on who actually played (oracle rows) and frozen in every tune
  (`GridParams.miss`, `bbTuner.runMissFit`, /api/bb/missing-fit); NBA live #4 = injury report + confirmed starters only.
  fix225: player impact = box-score value (`utils/boxValue.ts`, BPM-style, sums to team net, formula fitted once on 2022-24:
  `bbGrid.fitBoxFormula`) blended with on/off (minutes-scaled shrink) + star factor on #4's top 3 (`GridParams.impact`,
  `MissSet.top`, rows in `bb_grid_rows.alt`, `bbTuner.runImpactFit`, /api/bb/impact-fit, gated; notes basketball.md).
  fix222: the same layer per league for basketball (`services/sportCalibration.ts`, on bb-v4's walk-forward rows) and tennis
  (inside the tennis report), maths in `utils/sportCalib.ts`; bb-v4 re-tuned on the live database monthly by the worker (gated).
- Tennis (fix184, admin only, no pages or model yet): `tennis.ts` — data from Live Tennis API **Pro** (key `TENNIS_API_KEY`, 10,000 calls a day, reserve `TENNIS_RESERVE` 1,500), **singles only**, market prices (`tennis_prices`) are an **admin-only** benchmark, never on a public route. Stats computed from the point tape (`tennis_match_stats`). Admin: `/api/admin/tennis-probe`, `/api/admin/tennis/status`. Notes: `docs/notes/tennis-data.md`.
  fix190: `tennisModel.ts` = **tennis-v1** (admin only: surface Elo + serve/return Markov chain + context, blend only if it
  wins the monthly walk-forward test; `tennis_predictions`; `/api/admin/tennis-model`, `/api/admin/tennis/predictions`).
  Notes: `docs/notes/tennis-model.md`. fix200: the model runs in a worker thread (`workers/tennisModelWorker.ts`, read-only
  DB connection; writes applied on the main thread; pages read a ratings snapshot; `TENNIS_WORKER=0` = in-process).
- Tennis (fix190, fix193): `tennis.ts` (Live Tennis API: tables tennis_*), `tennisModel.ts` (tennis-v1, public name SL Tennis 1.0:
  surface Elo + serve/return points → Markov chain; live chance), `tennisSite.ts` (pages: matches, match, player, tournament,
  rankings, search, accuracy), `seoTennis.ts` (crawler pages + sitemaps), `/api/tennis/*`. **`TENNIS_PUBLIC=1`** opens /tennis
  to everyone (admins see it before); singles only; ATP, WTA, Challenger, Slams (ITF admin-only); market prices admin-only.
  Frontend `pages/tennis/*`, `lib/tennis.ts`, adapters `SportHome/tennis.ts`, `sport/games/tennis.tsx`.
- Accounts & admin: `auth.ts`, `twoFactor.ts`, `roles.ts`, `staffConsole.ts`, `securityLog.ts`, `crm.ts`, `billing.ts`
  (plans since fix147: Premium $8.99 / 6 months $48.49 / year $86.29 (60 unlocks a month), Pro $14.99 / $80.99 / $143.99
  (unlimited); pick packs $0.79 per pick ($0.59 with Premium); 3-day money-back guarantee built; the 3-day free trial is
  still decided, not built), `userPicks.ts`
  (users' own picks + personal record), `favorites.ts`, `testers.ts`, `backup.ts`, `clientErrors.ts`, `dataHealth.ts`,
  `dataAudit.ts`, `seo.ts`, `proxyGuard.ts` + `proxyScrapers.ts` (fix199: data-centre / proxy scrapers, rules in docs/notes/security.md).
- Player photos (fix211, OFF since fix241): `playerPhotos.ts` keeps the Wikidata / Commons matcher behind `photosOn()` (false:
  Wikimedia is not an official source); `purgeUnofficialPhotos()` at worker start, data-health "Photo sources: official only".
- Push alerts (fix226): `pushAlerts.ts` (settings / devices on the web; detect + send only in the worker, after each live
  tick), rules in `utils/pushRules.ts`, Web Push crypto in `utils/webPush.ts` (no library), words `locales/push/<lang>.json`,
  keys `VAPID_PUBLIC` / `VAPID_PRIVATE` (never change them). Frontend `public/sw.js`, `lib/push.ts`, `components/AlertsCard.tsx`.
- Game extras (fix231): `services/gameExtras.ts` (worker job every 3 h: venues → Open-Meteo weather, football referees from API-Football,
  coverage; builders for `/api/extras/<sport>/game|team/<id>`), pure parts in `utils/gameExtras.ts` (weather rules, indoor venues, referee
  shrinkage, difficulty bands, trend generator). Frontend `components/sport/game/GameExtras.tsx` (Trends, Next games, Weather, Referee; TeamDifficulty).
- Season forecast (fix215): `utils/seasonSim.ts` (engine, pure), `utils/seasonRules.ts` (per-league rules), `utils/seasonFit.ts`
  (thread part), `services/seasonForecast.ts` (inputs, runs 10 min after each finished game + nightly, Free view, data health).
  Frontend `components/sport/forecast/*`, `lib/seasonForecast.ts`. Notes: docs/notes/season-forecast.md.
- Clean links (fix229): `services/slugs.ts` (table slugs + slug_ids, worker job "slugs", state `slugs:<sport>`, the 301s in
  app.ts's page route, `/api/slug*`), rules `utils/slugRules.ts` (= frontend `lib/slugRules.ts`), `utils/slugAssign.ts`;
  frontend `lib/links.ts` (every item link), `components/SlugRoute.tsx` (slug → id for the page, old in-app links move on).
- Admin emails (fix239): `services/adminMail.ts` — every admin / staff email uses `renderAdminMail` / `sendAdminMail` (title, what
  happened, what to do, buttons); action buttons are signed one-time links (`actionLink` + `onEmailAction`, page `/admin/act/<token>`);
  anything that fixed itself is `noteAutoFix` (07:00 summary), never its own email. Swapped results: `utils/resultSwap.ts`,
  `bbResults.ts` (basketball), `resultChecks.ts` (American football, tennis).
- Copy for Claude (fix259): `services/forClaude.ts` + `utils/forClaude.ts` (text, secret filter, 12 KB), frontend `components/admin/CopyForClaude.tsx`
  + `lib/forClaude.ts` — a new admin card gets the button through its Explained frame; a new red / yellow row passes its own `req`. Admin / CRM only.
- Site gate (fix260): `backend/scripts/site-test.mjs` (test:site: every route × language × 375 / 1280 px × signed-out / free /
  admin + Admin / CRM tabs console signed in and locked), `links-test.mjs` (test:links: sitemaps + language homes, 2 levels,
  404 / 410 / 5xx / loops / relative hrefs), `site-server.mjs` (the server on a database copy or the seeded data),
  `site-seed.mjs` (test users + teams / players / games of every sport), `ci-report.mjs` (failing pages in plain words);
  frontend `scripts/relative-links-check.ts` in parity. A new page type or route goes in site-test.mjs's lists. Notes:
  docs/notes/deploy.md.
- `OPEN_API` in `app.ts` lists the public routes; everything else is admin/staff only (answered by the worker).

Frontend (`frontend/src`, React + Vite + Tailwind, tokens in `index.css`, colours `accent` (lime), `win`, `loss`, `draw`):
- Shared game-page parts (fix174): `components/sport/game/` LiveChance (live box + swing chart), ModelParts ("how it was calculated"),
  NewsChange ("numbers changed"), QuarterStrip, Highlights, GamePreview, Court (basketball line-ups); `components/sport/NameLink.tsx` (every
  team / player / competition name is a link, `href` helpers per sport), `lib/tNodes.tsx` (links inside translated sentences).
  Basketball: `bbLineups.ts` (probable five, NBA numbers changed).
- `App.tsx` routes (lazy pages). Football pages in `pages/`, basketball in `pages/bb/`. `components/` shared cards.
- `lib/i18n.ts` (t, LOCALE), `lib/bb.ts` (basketball types, `BB_COUNTRY`), `lib/fame.ts` (how big a club is: used for
  Spotlight and the featured carousel), `lib/reveal.ts` (free users reveal 2 picks a week).
- Admin pages: `pages/Admin.tsx` (fix237: 7 tabs on sub-paths /admin/<tab>, Needs you first; every card and data-health check is placed
  and explained in `lib/adminTabs.ts` — a new card or check needs its entry there, `npm run parity` (scripts/admin-check.ts) fails otherwise;
  parts in `components/admin/AdminParts.tsx`, tiles from `/api/admin/summary`),
  `pages/Crm.tsx`.

## Model facts you should know (details in docs/notes)

- **Our recommended football pick is the double chance** (fix120): the two most likely results (1X / X2 / 12), % = their
  sum, right when the result is inside it; "Strong pick" = 85%+. 1X2 stays tracked as "the hard calls". Basketball: winner.
- Football v3 top leagues: hit rate ≈ bookmakers' favourite (≈50%), log loss within 0.002 of the closing odds; second
  divisions trail the market by 2–6 points (that's the leagues, not a bug). Strong picks (60%+) ≈ 75% right.
- Every competition counts in the public record in every sport (fix203); "in testing" is only an admin label on leagues added from Admin.
- Basketball bb-v3: 68.5–69.3% picks right over 14k test games, well calibrated; every league (BSN too) counts in the record.
- Everything tuned is tested out-of-sample; the notes record what was tried and rejected — don't retry those blindly.

## Planned next (Oct 2026)

1. Basketball launch ~18 Oct (`BASKETBALL_PUBLIC=1`); live win chance is built (fix110), check `/api/bb/live-test` first.
2. Football self-learning is built (fix113, v3-mix in shadow): check `/api/admin/v3-mix?backtest=1` on the server;
   still open: per-league drift, calibration watchdog, basketball.
3. Weekly automated review (site, model, data) that pushes safe fixes.
4. 3-day free trial on paid plans when payments go live (Lemon Squeezy preferred).
5. Pictures for every basketball player/team (licensed source), AI support chat, DMARC p=reject in early Nov.

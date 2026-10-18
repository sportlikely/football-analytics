# SportLikely — instructions for Claude (read first, every session)

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
- **Never mention Israel.** No Israeli league on the basketball site, no "Israel" anywhere in product copy. Israeli
  football results exist in the data (Ligat Ha'Al, AF383) and stay as they are; don't add Israel references.
- **Past seasons / backtests are admin-only** on every sport. The public record starts on launch day.
- **Secrets:** never print, log, commit or ask for API keys, tokens or passwords. They live in Railway variables.
  Never change or delete `TOTP_KEY` or `BACKUP_KEY` (two-step login and backups would break).
- **Accounts and money:** Yarin creates accounts and pays himself. Admin login needs two-step. Staff can't change their
  own console password. Account deletion must remove the user's picks/favorites.
- **Privacy:** never store visitor IPs except in the security log (90 days). Visitors are shown by country only.
- **Images:** don't hotlink NBA headshots (cdn.nba.com) or copy news photos. Crests/logos come from the data providers.
- **Branding:** the brand is "SportLikely" (sports in general, not "football predictions"). Copy says "sports
  predictions", "probabilities, not promises", "18+". No "bet"/"wager" wording in the product name or nav.
- **Model principle (Yarin):** a pick must make sense when someone looks at the stats. Keep home advantage, but a team
  with clearly worse form / table / head-to-head must not be made the favourite. Every model change is accepted only if
  it improves log loss / Brier on games it never saw (walk-forward or later seasons), never on the fitting data.
- **`BILLING_TEST_MODE`** must be removed before real payments go live. Don't wire real payment webhooks without Yarin.
- **Team analysis for every sport:** Every sport has team analysis on the team page (strengths & weaknesses by fixed rules, model rating tiles, 1–10 league scores, rank over time, our record on the team) — build it with the sport, not later.
- **List rows:** List rows in every sport use the fix127 block (commit 9b3f610): result cells with % (our pick highlighted) + 'Our pick · {words} · %' underneath. Phones too.
- **Football is the template for every page.** Every sport renders the shared components in components/sport/* (and
  components/SportHome for the home) with an adapter; never build a sport-specific page layout. Anything added to football is
  added to all sports. Menus come from one per-sport config (`frontend/src/lib/sportNav.ts`). No season / week picker on
  public lists (current season only; past seasons are admin-only).
- **Live games:** Live games appear once — in the Live strip — and never again in the day lists, in every sport; live cards look the same in every sport (football is the reference).

## How to work here

- Branches: for normal fixes and features push to `main` when Yarin says so ("push to main"). For anything touching
  payments, accounts, auth or data deletion, push a branch and ask him to merge.
- Commit message style: `fixNNN: short description` (next number: see the top of `docs/notes/backlog.md`). Keep the
  counter going.
- Before pushing: `cd backend && npx tsc --noEmit -p .` and `cd frontend && npx tsc --noEmit -p .` must pass
  (frontend has `noUnusedLocals` / `noUnusedParameters` on). Don't commit `node_modules`, `dist`, `.env`, `*.sqlite`.
- Before pushing: `cd frontend && npm run parity` must pass (also part of `npm run type-check` / `npm run build`). A new
  football block means a parity key in `frontend/src/lib/sportParity.ts` + the basketball and NFL versions in the same
  commit (listed in their `*.parity.ts` files), or an 'na: <reason>' Yarin approved (`docs/notes/sport-parity.md`).
- Copy: short, plain English, no jargon. Six locales in `frontend/src/locales/*.json` (de, es, fr, it, pt, tr; English
  is the key). A new UI string needs the key used through `t("...")` and a translation in all six files
  (`json.dumps(..., ensure_ascii=False, indent=1)` keeps the file format).
- Phones first: check layouts at 375 px. Bottom nav on phones; floating accessibility button bottom-left.
- Don't add dependencies without a reason; the backend uses Node's built-in `node:sqlite`, no ORM.
- The server can't be reached from local tests; test model changes on a database copy (admins can download one from
  Admin → Database backups) with `DATA_DIR` pointing at a folder holding `bet-to-beat.sqlite`, user tables emptied.

## Map of the code

Backend (`backend/src`, Express + TypeScript, `index.ts` holds every route):
- Football data: `footballDataAPI.ts` (Football-Data.org: top leagues + Champions League), `afMatches.ts` +
  `apiFootball.ts` (API-Football: extra leagues, cups, national teams, lineups, injuries, match stats, player data),
  `history.ts` (football-data.co.uk result history + per-league groups), `leagueConfig.ts` / `leagueCoverage.ts`
  (leagues added from Admin → Football leagues; each = group `AF<id>`, history from API-Football fixtures).
- Football models: `gridModel.ts` = **v3 (grid-v3)**, the live model for leagues: factor rows (squad value, Elo,
  attack/defence, confirmed XI, missing players, freshness, home/away record, H2H…) → points → probabilities, with the
  common-sense guard (`h2hGuard.ts`). `clubElo.ts` = `elo-euro` for UEFA cups (CL fixtures come from Football-Data.org,
  teams matched to API-Football clubs by name in `matchFdTeam`). `nationalElo.ts` = `elo-intl` for national teams.
  `historyModel.ts` = v2 (hidden), `predictionModel.ts` = v1 (fallback only; should not be visible for big games).
  `v3Tuner.ts` = full tune, `tracking.ts` = saved predictions + public record, `trial.ts` = leagues "in testing"
  (out of the public record). `liveChance.ts` = live win chance. `featureModel.ts` = feature model (feat-v1) + v3-mix
  (shadow until published), `modelDaily.ts` = daily champion / challenger (04:00 UTC) + 07:00 Israel-time report.
- Basketball: `basketball.ts` (API-Basketball games/box scores, `BB_LEAGUES`), `bbModel.ts` (**bb-v3**: v1 ratings +
  v2 possession ratings, 50/50 blend, player talent, `BB_TRIAL`), `bbSite.ts` (pages), `bbPlayers.ts`, `bdl.ts`
  (balldontlie: NBA injuries/players), `bbInjuries.ts`, `bbResults.ts` (result checks), `bbLive.ts` (live win chance + projected score), `bbLeagueConfig.ts` /
  `bbLeagueCoverage.ts` (leagues added from Admin → Basketball leagues, code `BB<id>`). `BASKETBALL_PUBLIC=1` opens
  the basketball site to everyone (admins see it before).
- NFL + college football (fix136–142; college = league 2, ncaa-v1, lists under /american-football/college, `?league=` on the API): `nfl.ts` (API-American-Football client, key `API_NFL_KEY` or `API_FOOTBALL_KEY`;
  tables nfl_games / nfl_teams / nfl_team_stats / nfl_player_stats / nfl_players / nfl_injuries / nfl_standings; games every
  30 min, live every 30 s during games, box scores after full time, standings 6 h, injuries 2 h, rosters daily; every job
  checks the day's quota), `nflSite.ts` (pages: weeks, game, standings, team + rule-based team analysis, player, leaders),
  `/api/nfl/*`, `/api/admin/nfl-probe`. **`NFL_PUBLIC=1`** opens /american-football to everyone (admins see it before);
  past seasons stay admin-only. Frontend `pages/nfl/*`, `lib/nfl.ts`.
- Accounts & admin: `auth.ts`, `twoFactor.ts`, `roles.ts`, `staffConsole.ts`, `securityLog.ts`, `crm.ts`, `billing.ts`
  (plans since fix147: Premium $8.99 / 6 months $48.49 / year $86.29 (60 unlocks a month), Pro $14.99 / $80.99 / $143.99
  (unlimited); pick packs $0.79 per pick ($0.59 with Premium); 3-day money-back guarantee built; the 3-day free trial is
  still decided, not built), `userPicks.ts`
  (users' own picks + personal record), `favorites.ts`, `testers.ts`, `backup.ts`, `clientErrors.ts`, `dataHealth.ts`,
  `dataAudit.ts`, `seo.ts`.
- `OPEN_API` in `index.ts` lists the public routes; everything else is admin/staff only.

Frontend (`frontend/src`, React + Vite + Tailwind, tokens in `index.css`, colours `accent` (lime), `win`, `loss`, `draw`):
- `App.tsx` routes (lazy pages). Football pages in `pages/`, basketball in `pages/bb/`. `components/` shared cards.
- `lib/i18n.ts` (t, LOCALE), `lib/bb.ts` (basketball types, `BB_COUNTRY`), `lib/fame.ts` (how big a club is: used for
  Spotlight and the featured carousel), `lib/reveal.ts` (free users reveal 2 picks a week).
- Admin pages: `pages/Admin.tsx` (overview cards incl. Site errors, Football leagues, Basketball leagues, Backups),
  `pages/Crm.tsx`.

## Model facts you should know (details in docs/notes)

- **Our recommended football pick is the double chance** (fix120): the two most likely results (1X / X2 / 12), % = their
  sum, right when the result is inside it; "Strong pick" = 85%+. 1X2 stays tracked as "the hard calls". Basketball: winner.
- Football v3 top leagues: hit rate ≈ bookmakers' favourite (≈50%), log loss within 0.002 of the closing odds; second
  divisions trail the market by 2–6 points (that's the leagues, not a bug). Strong picks (60%+) ≈ 75% right.
- 15 leagues added 7 Oct 2026 are "in testing" (`TRIAL_COMPETITIONS`), excluded from the public record.
- Basketball bb-v3: 68.5–69.3% picks right over 14k test games, well calibrated; BSN in testing.
- Everything tuned is tested out-of-sample; the notes record what was tried and rejected — don't retry those blindly.

## Planned next (Oct 2026)

1. Basketball launch ~18 Oct (`BASKETBALL_PUBLIC=1`); live win chance is built (fix110), check `/api/bb/live-test` first.
2. Football self-learning is built (fix113, v3-mix in shadow): check `/api/admin/v3-mix?backtest=1` on the server;
   still open: per-league drift, calibration watchdog, basketball.
3. Weekly automated review (site, model, data) that pushes safe fixes.
4. 3-day free trial on paid plans when payments go live (Lemon Squeezy preferred).
5. Pictures for every basketball player/team (licensed source), AI support chat, DMARC p=reject in early Nov.

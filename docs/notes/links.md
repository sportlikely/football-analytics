# Clean links (fix229, Yarin 25 Oct 2026 — permanent rule)

Every public page is `/<lang?>/<sport>/<kind>/<slug>`, in every sport and every language. No ids, no query strings.

| Page | Address | Old address (301, one hop) |
|---|---|---|
| Team | `/football/team/real-madrid`, `/basketball/team/real-madrid`, `/american-football/team/kansas-city-chiefs` | `/team/86?c=PD&n=Real+Madrid+CF`, `/team/1000000541`, `/basketball/team/…`, `/american-football/team/…` |
| Player | `/football/player/erling-haaland`, `/tennis/player/carlos-alcaraz` | `/player/1100`, `/basketball/player/…`, `/tennis/player/…` |
| League | `/football/league/premier-league`, `/basketball/league/nba`, `/american-football/league/nfl` · `college-football`, `/tennis/league/atp-paris-masters` | `/league/PL`, `/league/AF39`, `/league/BSA`, `/basketball/league/NBA`, `/american-football/league`, `/american-football/college/league`, `/tennis/tournament/…`, `/tennis/predictions/…` |
| Match | `/football/match/real-madrid-vs-barcelona-2026-10-26` (`-2` for a second game that day), tennis `<player>-vs-<player>-<day>` | `/match/560614`, `/basketball/game/519565`, `/american-football/game/…`, `/tennis/match/…` |
| Sport home | `/football`, `/basketball`, `/american-football`, `/tennis` ("/" stays the site home) | — |

Languages: `/es/football/team/real-madrid` etc. The day in a match slug is the UTC date of the start.

## Tabs and sport pages (fix235, Yarin 25 Oct 2026 — permanent)

No `#…` in links. A match page opens on the prediction; each other tab is a sub-path, same names in every sport
(`MATCH_TABS` in the slug rules): `/football/match/barcelona-vs-real-madrid-2026-10-25/stats` · `/lineups` · `/h2h` · `/table` ·
`/highlights` · `/rest` (basketball also `/box` `/players` `/quarters`, NFL `/players` `/plays`, tennis `/form` `/draw`). League
pages: `…/league/<slug>/forecast`. Sections: `/account/emails`, `/account/alerts`, `/premium/packs`. The app's routes end in `/*`
(`match/:slug/*`), so a tab click changes the address (`lib/tabPath.ts` useTabPath, replace) without reloading the page. An old
`#stats` / `#prediction` link opens that tab and the address becomes the sub-path; a sub-path that is not a tab → the page (301
on load). Crawler pages: a tab is its match page (one stored copy, canonical without the tab).

| Page | Address now | Old address (301, one hop, any language, `#…` dropped) |
|---|---|---|
| Lists | `/football/matches`, `/basketball/matches`, `/american-football/matches`, `/tennis/matches` | `/matches`, `/basketball/games`, `/american-football/games` |
| Today | `/football/today`, `/basketball/today`, `/american-football/today`, `/tennis/today` | `/predictions/today`, `/basketball/predictions/today` |
| Weekly hubs | `/football/predictions/premier-league`, `/basketball/predictions/nba`, `/american-football/predictions/nfl` | `/predictions/<slug>`, `/predictions/PL`, a hub under the wrong sport |
| Football pages | `/football/favorites`, `/my-picks`, `/upset-watch`, `/draw-alerts`, `/accuracy`, `/past` | `/favorites`, `/my-picks`, `/upset-watch`, `/draw-alerts`, `/accuracy`, `/past` |

Site-wide pages stay at the root: `/`, `/search`, `/account`, `/premium`, `/guides/…`, `/changelog`, `/how-it-works`, `/privacy`,
`/terms`, `/contact`. The moves are one function (`movedPage`, both copies of the slug rules): the server's 301s and `pubPath` /
`pubLinks` (crawler HTML, JSON-LD, sitemaps, emails, push, calendar), the app's `<MovedPage>` routes and the parity guard.
The crawler pages are still built from the old addresses inside (`internalPage`). Tests: `npm run test:fix235`.

## Slugs

- Rules: `backend/src/utils/slugRules.ts` = `frontend/src/lib/slugRules.ts` (identical files, `npm run parity` compares them):
  no accents ("Atlético" → atletico, "Köln" → koln, ß → ss, ø → o), lowercase, dashes, "&" → and, apostrophes dropped, club
  words off the ends of team names (FC, CF, AFC, SC, AC, AS, SSC, VfB, 1. …: "1. FC Köln" → koln, "FC St. Pauli" → st-pauli),
  a short-name list (Man City → manchester-city, PSG → paris-saint-germain, Bayern München → bayern-munich). A slug always has
  a letter (an all-digit slug would read as an old id).
- League slugs from the name; the Football-Data.org codes have fixed ones (PL premier-league, PD la-liga, SA serie-a, BL1
  bundesliga, FL1 ligue-1, CL champions-league …); tennis tournaments keep their keys; NFL nfl / college-football.
- Unique per sport and kind (`utils/slugAssign.ts`): the item with more games keeps the plain slug, the next one gets its full
  name / + country (Barcelona SC → barcelona-sc[-ecuador]), a league + country (premier-league-russia), a player + team, then
  birth year; then -2, -3. A slug is never handed to another item. Football Real Madrid and basketball Real Madrid don't clash.
- A rename (the name's plain slug changed) gives a new primary slug; the old one stays as an alias (301 to the new).
- Football teams are their API-Football club (1e9 + id); a Football-Data.org team id is an alias id (team_resolve, the team
  page's own lookup), so `/team/86?c=PD&n=…` and `/team/1000000541` both land on `/football/team/real-madrid`. An
  API-Football fixture with a Football-Data.org twin is the twin's match; a merged player / tennis match id is its main one.

## How it runs

- Table `slugs (sport, kind, slug, id, is_primary, base)` + `slug_ids (sport, kind, old_id, id)`.
- Worker job "slugs" (`services/slugs.ts` buildSlugs, jobs.ts): first run 4 min after start (the leagues and the team index
  are loaded by then), then every 15 min for new items; every 6 h everything again (renames, late old games).
- Each sport publishes `slugs:<sport>` (shared state): slug ↔ id for every team and league, this and last season's players,
  matches of −60 … +30 days, and the app's exception list. The web process answers from it only (no database read);
  anything else is asked of the worker (`/api/slug-route`, 3 s at most, else the plain app page).
- The page route in app.ts: an old address → 301 to the slug address (language prefix kept, the old query dropped except
  `ALLOWED_QUERY`); an alias → 301 to the primary; an unknown slug → 302 to `/search?q=<words>` (a match slug drawn from
  short names or with the sides swapped is found by the day + the words of both sides).
- Crawler pages: `seoPage` turns a slug address into the item's id inside; canonical, hreflang, JSON-LD and every link in the
  body are slug addresses (`link()` → `pubPath`, `pubLinks`); the item is put in the page (`#sl-ent`) so the app does not ask.
- Sitemaps: slug addresses only; an item without a slug yet is left out until the next build.
- Emails (fix216), push alerts (fix226), calendar (fix205), hubs, data-audit emails: `pubPath` on every page link.
- App: `lib/links.ts` draws every item link from the name with the shared rules, plus `/api/slugs/<sport>` (+ `/players`):
  the items whose slug differs (loaded once per visit, links drawn again when it arrives). Each link remembers its id, so a
  click opens the page at once (`components/SlugRoute.tsx`; the address bar then gets the item's own slug if it differs).
  Old in-app addresses (`<OldLink>` routes) move to the slug address.
- Guard: `npm run parity` → `frontend/scripts/links-check.ts`. Tests: `npm run test:fix229` (backend/scripts/slugs.test.mjs).
- fix280 — one source for list links and the table: the slugs job registers every game a list prints (the Football-Data.org
  window too, with or without a saved prediction) with every name the lists show (full + short name), and publishes a match
  exception whenever any of those names / days (with or without the side ids) would make another slug. One primary slug per
  match. A list's memo re-draws its links when the exceptions arrive (`useSlugVersion()` in its deps). test:site / test:links
  check every match link of the next 7 days on every sport's matches list against /api/slug.
- fix282b — every other slug a list could print for a match (a side's full or short name: "barcelona-vs-deportivo-alaves-…" next to "barcelona-vs-alaves-…") is stored as an alias of the match by the slugs job, so a link printed before the list knew the slug 301s in one hop (was: the search).

## After a deploy

Resubmit `https://sportlikely.com/sitemap.xml` in Google Search Console (and Bing Webmaster Tools) once the first "slugs" run
has finished (log "slugs football: … lookups", ~5–10 min after the start; Admin API `/api/admin/slugs` shows each sport's
state). The old addresses keep answering 301 forever.

fix238: the web process answers old match / player ids of every season from a prebuilt index (`slugs-ids:<sport>`, built with
the sport's slug state; `/api/admin/slugs` → idIndex). Once it is loaded the web never asks the worker for an old address; one
without a slug gets the plain app page at once (no page build before answering).

## fix243 — past seasons' match pages are admin-only

Every sport, any language prefix, the page and its tabs: a match of a past season answers **410** with `X-Robots-Tag:
noindex` (+ robots meta, a short line and a link to the sport home) for everyone but admins; the game APIs
(`/api/matches/:id…`, `/api/basketball/game/:id…`, `/api/nfl/game/:id…`, `/api/tennis/match/:id…`) and
`/api/slug/<sport>/match/<slug>` answer 410 too (the app shows "This game is from a past season"). Current-season
finished games stay public (the record). The rule (services/pastSeason.ts): older than the latest season of the game's
own competition — API-Football league seasons, Football-Data.org by the European season (1 July; Copa Libertadores,
Brasileirão, World Cup, Euros by their latest year), basketball by league season (a calendar league such as BSN stays
current until its next season starts), American football by nflCurrentSeason, tennis by calendar year. The web process
knows the window's past matches from its slug state (`p:match/<id>`); older ones are asked of the worker (slug-route),
which reads the tables. Out of every sitemap (urlset) and the crawler HTML (seo.ts `unlinkPast`: the link becomes text).
The app: `/api/slugs/<sport>/seasons` = the day each team's current season began (+ `d`, the latest such day); matchHref
gives no link (null) to an older game for non-admins (lib/links.ts `isPastSeasonGame`); list rows that can show one
(head-to-head, form, game logs, team results) render it as text (components/MaybeLink.tsx). Test: npm run test:fix243.

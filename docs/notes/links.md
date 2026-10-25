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
Weekly hubs (`/predictions/<slug>`) and list pages (`/matches`, `/predictions/today`, `/basketball/games` …) carry no ids and
stay where they are.

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

## After a deploy

Resubmit `https://sportlikely.com/sitemap.xml` in Google Search Console (and Bing Webmaster Tools) once the first "slugs" run
has finished (log "slugs football: … lookups", ~5–10 min after the start; Admin API `/api/admin/slugs` shows each sport's
state). The old addresses keep answering 301 forever.

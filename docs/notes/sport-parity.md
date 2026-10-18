# Sport parity (fix175, 18 Oct 2026)

**Status 19 Oct (fix174 + fix178): zero known gaps (no 'todo' left).** fix174 closed 24 of fix175's 26 gaps; fix178 the last two
(basketball swing chart from live samples, basketball team mini table).

## Not applicable — for Yarin to approve

| Block | Sport | Why |
|---|---|---|
| League logo | NFL + college | The provider's NFL and college league images are its 'image not available' placeholder (the same 29 KB file for both); we have no licensed mark. The pages show no logo rather than the placeholder. |

## Built in the closest way the data allows (provider gaps)

- **Line-ups:** no provider has basketball or American-football line-ups. Basketball: probable starting five = the last game's starters (box-score flag) who play 12+ min, minus players out, on a court. NFL / college: likely starters = season leaders by position from our box scores (no depth chart).
- **College FCS rosters:** the provider has none (Lehigh, UT Martin, Montana State…); the team page shows the team's season leaders from box scores instead.
- **Events:** basketball has no play-by-play → the game by quarter (points + running margin). NFL / college: scoring plays from games/events when the provider has them (current season, fetched with the box score), else the quarter strip.
- **Injuries:** reports exist for the NBA (ESPN) and the NFL / college (provider); other basketball leagues show no injury block (hidden, never empty).
- **Highlights:** YouTube via the official league / club / broadcaster channels (needs YOUTUBE_API_KEY); a game without an official video shows "no official highlight yet".


Football is the template: every block on a football page exists on the same page of every sport. The list of blocks is
`frontend/src/lib/sportParity.ts`; each sport says what it feeds in `*.parity.ts` files next to its adapters
(`components/SportHome/<sport>.parity.ts`, `components/sport/games/<sport>.parity.ts`, `pages/football.parity.ts`,
`pages/bb/basketball.parity.ts`, `pages/nfl/nfl.parity.ts`, `backend/src/services/seo.parity.ts`).

`cd frontend && npm run parity` (also in `npm run type-check` and `npm run build`) fails when:
- a block has no basketball / NFL version and no 'na' or 'todo' reason,
- a sport now feeds a block marked 'na' / 'todo' (change it to true),
- a shared component in `components/sport/**` / `components/SportHome/**` gets a prop only football passes
  (add it to basketball and NFL, or to `FOOTBALL_ONLY_PROPS` with a reason),
- a `*.parity.ts` file names a key that doesn't exist.
The admin overview's "Sport parity" card shows the same report (written by the check into `lib/sportParity.report.ts`).
The Railway build (Dockerfile) runs `vite build` only, so the check runs before pushing, like the typecheck.

Every block was checked against the code on 18 Oct 2026 (fix175 audit).

## Not applicable ('na') — Yarin decides these
- `game.beforeAfter` · Basketball: no line-up announcement to compare around (live 'was X%' is in the live chance)
- `game.beforeAfter` · NFL: no line-up announcement to compare around
- `game.lineups` · Basketball: the providers have no line-ups (basketball box scores only flag starters; American football only the starting QB, shown in the reasons)
- `game.lineups` · NFL: the providers have no line-ups (basketball box scores only flag starters; American football only the starting QB, shown in the reasons)

## Known gaps to build ('todo') — from the fix175 audit
These are real gaps (the data exists or could exist). Each one stays red on the admin card until it is built and its
key is added to the sport's `*.parity.ts` file.
- `home.introStats` (First-visit stat tiles) · Basketball: the adapter passes no stat tiles (the record bands exist)
- `home.introStats` (First-visit stat tiles) · NFL: the adapter passes no stat tiles (record not public yet)
- `games.leaguePanel` (League panel) · Basketball: no league panel in the games adapter (standings exist)
- `games.leaguePanel` (League panel) · NFL: no league panel in the games adapter (standings exist)
- `game.howCalculated` (How we calculated it) · NFL: no 'how we calculated' box (the model inputs are in the reasons)
- `game.preview` (Match / game preview text) · NFL: no written preview service for American football
- `game.restTab` (Rest tab) · NFL: no rest tab (rest days and bye / short week are in the model's reasons)
- `game.standingsTab` (Standings tab) · NFL: no standings tab (standings exist)
- `game.liveChance` (Live win chance) · NFL: no in-game win-chance model for American football yet
- `game.swingChart` (Win-chance swing chart) · Basketball: no swing chart (bbLive's quarter model could feed one)
- `game.swingChart` (Win-chance swing chart) · NFL: needs an in-game model first
- `game.highlights` (Video highlights) · Basketball: the highlights search is football-only
- `game.highlights` (Video highlights) · NFL: the highlights search is football-only
- `team.ourRecord` (Our record on the team) · NFL: admin-only until the NFL record goes public
- `team.miniTable` (Mini table) · Basketball: only a link to the table (standings exist)
- `team.miniTable` (Mini table) · NFL: only the record line (standings exist)
- `player.career` (Career) · NFL: current season only (older seasons are admin-only data)
- `player.injuries` (Injury history) · NFL: the player page doesn't show the injury report (nfl_injuries has it)
- `league.recordTile` (Record tile) · NFL: admin-only until the NFL record goes public
- `league.logo` (League logo) · NFL: no league logo stored (the provider's /leagues has one)
- `search.leagues` (Search: leagues) · NFL: search returns no NFL / college league
- `seo.crawler.player` (Crawler page: player) · Football: no player crawler page (only the not-found one)
- `seo.crawler.player` (Crawler page: player) · Basketball: player pages get the generic basketball page
- `seo.sitemap.player` (Sitemap: players) · Football: no player sitemap
- `seo.sitemap.player` (Sitemap: players) · Basketball: no player sitemap
- `seo.sitemap.player` (Sitemap: players) · NFL: no player sitemap

## Fixed with fix175
- Basketball and NFL game pages: half-time score under the score (from the quarters) and the postponed / cancelled
  note, like football (the prop check found them).
- NFL league page: favorite star and the weekly hub link ("This week's predictions →").

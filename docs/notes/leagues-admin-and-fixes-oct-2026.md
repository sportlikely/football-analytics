## Decided 13 Oct 2026 — 3-day free trial on every paid plan
- Yarin (after the Scouter review): every paid plan (Premium, Pro, Pro 6 months, Pro yearly) starts with a **3-day free trial**, like Scouter.
- Build together with payments (the trial is set in the payment provider's checkout, e.g. Lemon Squeezy subscription trial). Site copy: Plans page badge "3 days free", button "Start free trial"; account shows "Trial ends <date>"; reminder email 1 day before it ends; one trial per account/card (anti-abuse).
- Competitor notes: claude/competitor-180score.md; Scouter (Artlines Web Solutions, 1M+ Android installs, $5.99/wk · $15.99/mo · $89.99/yr, $1.49 single-match unlock, unverified "84% accuracy") reviewed 13 Oct in chat — ideas: single-match unlock, in-play calls, push alerts, native app.

## To do — exact league count from our data plans (asked 13 Oct 2026)
- Yarin asked how many leagues we'd have if we used everything API-Football Ultra + API-Basketball Ultra offer. API-Football says 1,200+ leagues & cups; the usable number for predictions depends on per-league coverage flags (fixtures, stats, lineups, odds) and history. Plan: admin endpoint that calls /leagues (football + basketball) and counts by coverage tier, so the answer comes from the real data.

## fix106 — more football leagues from the admin panel (13 Oct 2026, saved to Yarin's folder, push pending)
- Yarin: add every league with full information (players too), football first.
- Admin → Overview → **Football leagues** card: one API-Football `/leagues` request lists every senior league (youth/women/reserves/regional/friendlies filtered out) with tiers: full = events + lineups + fixture stats + player stats + players + standings; good = events + standings + lineups or stats; basic. "Ready to add" = full + playing now + 2 past seasons + not yet predicted. Pick leagues → "Add" → in testing by default; per-league "In testing" switch and Remove (removal takes effect after next deploy).
- Backend: services/leagueConfig.ts (table af_extra_leagues, onExtraLeague hooks), services/leagueCoverage.ts (scan cached a day in af_league_scan). Each added league = its own v3 group + division `AF<id>`; history = finished fixtures of 3 seasons from API-Football (history.storeAfHistory, AF_HISTORY_DIVS, no odds) — fd.co.uk CSV sync / H2H archive / half-times skip these. Added to AF_LEAGUES (lineups, injuries, stats, player seasons), EXTRA_COMPETITIONS (window, live, standings → team map). After adding: afTick(force) → window → v3 rebuild.
- Routes: GET /api/admin/league-coverage(?refresh=1), POST /api/admin/extra-leagues {ids}, POST /api/admin/extra-leagues/:id/remove, POST /api/admin/extra-leagues/:id/trial {trial}.
- Frontend: components/LeaguesCard.tsx, Admin.tsx, lib/leagueCountry.ts (country flags for ~80 more countries in the Countries menu).
- Tested with a mocked API (Austria + Ireland): scan/tiers/filters, add, history 3 seasons, v3 prediction, trial toggle, restart persistence, removal.
- Watch after adding many: request budget (each league ~50–100/day + backfill), model build time, daily data check %.

## fix107 — featured carousel + phone match header (13 Oct 2026, saved, push pending)
- Home: featured match → swipeable carousel (FeaturedCarousel in Home.tsx) when there are 2+ big games in 7 days: featured + up to 5 games with matchFame ≥ 8.5 and no side ≥ 85%, kick-off order; arrows (desktop), dots, peek of the next card on phones, auto-advance 8 s until touched; carousel games removed from "Next kick-offs". Locales: "Previous match", "Featured matches".
- Match page hero: competition / "Matchday · stage · group" / date stacked and centred on phones (roundBits).

## fix108 — basketball leagues from the admin panel (13 Oct 2026, saved, push pending)
- Yarin: add basketball leagues too ("we need more games to record").
- services/bbLeagueConfig.ts (table bb_extra_leagues; code BB<id>; onBbExtraLeague → BB_LEAGUES push) and services/bbLeagueCoverage.ts (API-Basketball /leagues scan, tiers full = team + player box scores + standings; women/youth/3x3/all-star filtered; Israel never listed). Routes /api/admin/bb-league-coverage, /api/admin/bb-extra-leagues (+ /:id/remove, /:id/trial). Adding starts bbSyncNow (5 seasons + box scores), model on next build.
- Frontend: LeaguesCard sport="basketball" in Admin; bbLeagues() sends `flag` → lib/bb.ts fills BB_COUNTRY for the countries menu.
- Tested with a mocked API: scan, filters, add, 4 seasons synced, bb-v3 prediction, flag.

## fix109 — Champions League predictions falling back to v1 (13 Oct 2026, saved, push pending)
- Full site check after the fix106–108 deploy (browser pane, phone + desktop; /api/health, data-health, site errors, upcoming predictions): site fine, carousel and phone header OK, no open site errors. Data check 94.6% (246/260), one unsettled game >1 day.
- Found: 7 of 29 Champions League games (Football-Data.org feed) were predicted by the old poisson-dc-v1 because clubElo.findTeam could not match the FD name to the API-Football club (jaccard ≥ 0.7 too strict: "FC Bayern München" ≠ "Bayern Munich", "PSV" ≠ "PSV Eindhoven", "FK Bodø/Glimt" (ø), "PAE AEK", "ŠK Slovan Bratislava", "Sabah FK" vs "Sabah FA"). Viking–Bayern showed 24/22/54.
- Fix (clubElo.ts): matchFdTeam — exact, then club-word match (clubTokens, ø/æ/ß handled, FD_ALIASES), then fuzzy ≥ 0.6; ties → club with most games; fdTeamMapping() helper. All 49 CL clubs now map (tested on the 10 Oct DB copy). n<8 rule relaxed to n<2 with 'low' confidence so no CL game falls back to v1.
- Found: clubs without a Transfermarkt value counted as "equal" → Sabah 56% vs Slavia Praha. Now MISSING_VALUE = €12m (seed Elo, squad row, value term). Out-of-sample on 705 cup games: log loss 0.958 → 0.952, hit rate 56.2 → 58.4%, Brier 0.567 → 0.563. Sabah–Slavia 36/20/44, Viking–Bayern 12/11/78, Slovan–Stuttgart 16/14/71.
- Phone: accessibility button and Feedback button shrunk (36 px, icon only) and moved closer to the bottom nav so they cover less content.
- Still to watch: data-health "1 game not settled"; Championship/second-division medium confidence is expected.

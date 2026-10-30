# Security notes

## Proxy scrapers (fix199, 22 Oct 2026)

**What happened:** on 20–21 Oct one script pulled thousands of pages through ~25 addresses of Datacamp Ltd (AS60068, NL,
resold to VPN / proxy services), each with a fake browser user-agent (Safari Mac / Chrome Android). Each address hit the
provider-cost cap (fix173) and got its own "scraper" line in the Security log.

**Which addresses:** the data-centre list in `backend/src/services/asn.ts` (`DC_ASNS`, iptoasn.com ranges, fix183) plus
the proxy / VPN-resale hosts added in fix199: Datacamp (AS60068, AS212238), M247 (AS9009), Clouvider (AS62240), PacketHub
(AS147049, AS207137), Zenlayer (AS21859), HostRoyale (AS203020), GSL Networks (AS137409). A new network on the list makes
the server download the ranges again (the file keeps a signature of the list).

**Who the rules skip:** admins, search engines verified by reverse + forward DNS (fix173: Googlebot, Bingbot, Applebot,
Yandex), and signed-in accounts with a confirmed email (they behave like any account, with their own limits).

**The rules (everyone else on those addresses):**

| Rule | Number |
| --- | --- |
| Provider calls (API-Football etc.) | none, stored data only from the first request |
| Page views per address (fix244: not API calls) | 60 an hour, 300 a day (UTC) |
| API reads per network (ASN, all its addresses) | 600 an hour |
| Over a limit | a browser gets the Quick check (fix244); the API answers 429 with `Retry-After` and `proxy: true` |
| Passed the Quick check | no address or network limit for 24 h, 300 page views an hour per pass |
| Signed out | no prediction at all, finished games too: every prediction is `{ model, locked }`, so game pages show the "Create a free account" prompt (UnlockPrompt) |

Not counted, never blocked: sign-in, sign-up, account, billing and unlock routes, the visit beacon, client errors, and the
login / signup / forgot / verify / join / account pages. People on a VPN can always reach every page and sign in.
Visitor counting is unchanged (bot reason `datacentre`).

### Quick check (fix244, 26 Oct 2026)

> **Correction (fix262 / fix262b, 28 Oct 2026): the 26 Oct "Datacamp scraper" was Railway's edge, not a scraper.**
> Railway's new Hikari edge (headers `x-railway-edge` / `x-hikari-trace`) runs on Datacamp (AS60068 / AS212238: e.g.
> 89.222.103.0/24, 152.233.x.0/24, 84.17.44.0/24) and appends its own address(es) to X-Forwarded-For; fix254's rule
> took that edge address as `req.ip`, so every visitor (the friend on the VPN included) and real Googlebot looked like
> "Datacamp" and shared the network cap. Since fix262b `req.ip` skips every consecutive edge hop (learned /24 ranges,
> plus hops in the edge networks AS60068 / AS212238; fix268, Yarin 28 Oct: the client hop left of them is verified
> as a search engine normally by list / DNS — the edge appends on the right, so the client cannot write that hop), so the proxy
> limits, the Quick check and the data-centre check apply to the real client address. Data health "Search engines
> verified" → "client networks" should show Datacamp ≈ 0 (only real VPN users on it); each Googlebot-UA sample lists
> every hop and which one was taken. The 20–21 Oct episode (fix199, fake browser user-agents, ~25 addresses) predates
> the Hikari edge and is not affected by this correction as far as we know.

**What happened:** a friend in Israel on a VPN got "Failed to load matches: Request failed with status code 429", then a
bare white page. A scraper on Datacamp (AS60068: 47,028 requests, 257 addresses, 34,558 refused; AS212238: 17,442 /
15,735 refused) used up the 600-an-hour network cap, so every person on that VPN network was refused on the first page.
And the 60 an hour per address counted API calls: one page load makes ~10, so a person got ~6 pages an hour.

- **Page views, not API calls** (per address): the app sends `X-SL-View` (`lib/viewId.ts`, a new id when the address
  changes, the first view of a page load starts with `L`); a view's first 15 calls count once; the HTML of a page load
  counts once and the app's first `L` view within 60 s after it is free. Calls without the header count one each, so a
  script gains nothing. The network cap still counts API calls (600 an hour).
- **Quick check** (`utils/quickCheck.ts`): when the rules would refuse a browser, the page route answers 429 with a small
  SportLikely page (no app, 7 languages, "You're on a VPN or proxy network", Sign in) with Cloudflare Turnstile (the fix168
  keys). The app opens it at `/<lang?>/quick-check` on a 429 with `check: true` and comes back to the page afterwards.
  Passing it (`POST /api/auth/quick-check`) sets `sl_pass`: httpOnly, SameSite=Lax, 24 h, signed (key made from
  `TURNSTILE_SECRET`), tied to the user-agent; a copied cookie on another user-agent is not valid. Stored data only and
  locked predictions for signed-out visitors stay as they are. Without Turnstile keys: the plain "try again later, or
  sign in" page.
- The app never shows "Request failed with status code 429" (`lib/proxyCheck.ts`): proxy 429 → Quick check; any other
  429 → "Too many requests, try again in a minute".
- Admin → Visitors → Who → Networks: "N passed the check · M refused after it" (pass holders refused by the pass's own
  limit or using it from another user-agent). Columns `passed`, `pass_refused` in `scraper_networks`.
- Tests: `npm run test:fix244` (backend).

**Security log:** one `scraper` line per network and day (`grp` = `AS60068:2026-10-21`), e.g. "Datacamp Ltd (AS60068, NL)
· 25 addresses · 4,100 requests · fake browser UA", updated in place every minute. A network gets its line when an
address is refused by a limit, reaches the cost cap, fails the crawler DNS check, or the network passes 300 requests in a
day. The addresses (IP, requests, refused, first / last seen) are behind the arrow (`security_log_ips`, kept 90 days like
the rest of the security log). `logger.warn('scraper: …')` once per network per day. Addresses outside these networks keep
the old per-address lines (fake crawler, cost cap).

**Admin Visitors → "Who is calling today":** the top 20 user-agents and networks of the day with request counts, each
marked verified search engine / SEO tool / data-centre / unknown script (or browser).

**Code:** rules in `services/proxyGuard.ts` (no imports; `npm run test:proxy` in backend), counting and the log in
`services/proxyScrapers.ts`, wiring in `index.ts` (the `/api` source middleware and the page route).

**Known limits:** the counts live in memory; after a restart the day's line continues from what was written (addresses may
be counted twice). The limiter is per server (fine for one Railway service).

## Search engines verified by their address lists (fix245, 26 Oct 2026)

Search Console (7–21 Oct): 15 % 4XX, 5 % 5XX, 22 % failed on 210k Google requests; Admin → Visitors: 369 Googlebot requests, verified 0. Google (AS15169) is on the data-centre list, so an unverified Googlebot got the proxy rules (60 page views an hour, 429, locked predictions) and the bot gate's 503. Now (services/crawlerIps.ts, utils/crawlerRanges.ts): a Google / Bing / Apple user-agent from an address in that engine's published list (downloaded daily by the worker; Google's googlebot, special-crawlers, user-triggered-fetchers(-google), Bing's bingbot, Apple's applebot; seed ranges until the first download) is verified at once, DNS or not; otherwise fix173's DNS check (system resolver, then 8.8.8.8 / 1.1.1.1). A verified search engine: no proxy limit, no rate limit, waits for a bot-gate slot (CRAWLER_WAIT_MS 15 s, then goes on), the worker builds a page instead of the 503 "Loading", 120 s startup wait. A crawler user-agent from any other address (Datacamp…) is refused as before. Data health "Search engines verified" fails on any 429 / 503 to Google's ranges.

## Scraper swarms (fix277, 29 Oct 2026)

29 Oct: one user-agent ("Chrome/155 … X11; Linux x86_64") made 222,665 requests from thousands of addresses, mostly US
home networks; only ~38k were on the data-centre list, so the proxy rules above never applied to the rest. Each address
opened a few pages, sent no seen beacon, and the next one took over.

| Rule | Value |
|---|---|
| Group | hash(user-agent) + country + network (AS number when on the data-centre list, else the /16; IPv6 /32) |
| Swarm (hour) | 40+ distinct addresses of a group in an hour, under 5% with human signs |
| Swarm (day) | 300+ distinct addresses of one user-agent in a day, any country, under 5% human (a group with 5%+ people today is spared) |
| Human signs | seen beacon visible 5+ s and used, not headless, 4+ s after the address's first page; a Quick-check pass; an email-verified account |
| Judged | only addresses first seen a minute ago or more (a person's beacon comes after 5 s) |
| Held | 6 h after it last qualified (kept across restarts by hashed group / user-agent keys, never addresses) |
| Never | admins, verified search engines, signed-in email-verified accounts, pass holders, account / sign-in / billing / beacon routes, documentation ranges (2001:db8::/32 …: the site gate) |
| Signed out in a swarm | 429 + the Quick check (Turnstile) on every page / API read, no crawler HTML, stored data only, no prediction, not a visit (visits.bot = 'swarm') |
| Pass holder | only its own 300 page views an hour |
| Admin | Visitors → Swarms: Rules / Always challenge / Trust per user-agent (`swarm_overrides`, applied at once) |
| Data health | "Scraper swarms": yellow while one is challenged, red if a trusted user-agent or a listed search engine got the challenge (7 days) |

Code: `utils/swarmRules.ts` (rules, unit-tested by `npm run test:fix277`), `services/swarmGuard.ts` (server side).

## Link previews and AI crawlers (fix285, 30 Oct 2026)

30 Oct: facebookexternalhit sat in Admin → Visitors → Swarms as "watching" with 148 addresses. Yarin: link previews and
verified crawlers are never challenged; AI crawlers get a switch each; the Visitors headline separates good bots.

- **Link previews** (Meta facebookexternalhit / meta-externalfetcher, Twitterbot, WhatsApp, TelegramBot, LinkedInBot,
  Slackbot, Discordbot, Pinterestbot; Applebot = search engine, fix245): checked by the addresses the company publishes
  (Meta = its network AS32934, X = AS13414, LinkedIn = AS14413 as seed prefixes; Telegram's cidr.txt downloaded daily) or
  reverse DNS where that is what it publishes (Pinterest `*.pinterest.com`). Verified = treated like a verified search
  engine: stored page with its Open Graph tags, no provider calls, never a swarm / proxy / Quick check.
- Previews made where nothing is published — the sender's phone (WhatsApp from a phone, iMessage) or changing cloud
  servers (Slack, Discord): never challenged, but **the Open Graph card only** (the page's head, no body, no scripts).
- A name of a company that publishes its addresses, from another network = a fake: a normal unknown caller (unknown-bot
  limits, proxy rules, swarm rules).
- **AI crawlers that name themselves** (OAI-SearchBot, ChatGPT-User, GPTBot, PerplexityBot, Perplexity-User,
  Claude-SearchBot / Claude-User / ClaudeBot, ExaBot / ExaUser, Amazonbot, meta-externalagent, DuckAssistBot,
  MistralAI-User, YouBot, CCBot): one switch each in Admin → Visitors → "AI crawlers and link previews" (under Swarms):
  **Challenge (default)** = the Quick check on every page / API read; **Trust** = like a search engine. Where the company
  publishes addresses (OpenAI, Perplexity: JSON lists downloaded daily; Amazon: reverse DNS), Trust needs them. Their
  pages never count as visits (visits.bot 'ai-trusted' / 'ai-blocked').
- **Visitors headline**: People · Search engines · Link previews · Blocked bots · Other bots, each caller counted once in
  its strongest category (people > search engines incl. trusted AI > previews > blocked: swarms, AI on Challenge, the
  403 bad bots > other), so the five add up to all callers; the daily chart has the same split. Bot page loads are now
  recorded too (the page route never went through the /api visit counter, so previews were never in Visitors).

Code: `utils/goodBots.ts` (rules + the headline categories), `services/goodBots.ts` (lists, DNS, switches in
`good_bot_modes` → state 'goodbots:modes', live counts), app.ts crawler middleware / API middleware / page route,
`services/visitors.ts` `markBotVisit`, `services/visitorSummary.ts` `kinds`. Tests: `npm run test:fix285`.

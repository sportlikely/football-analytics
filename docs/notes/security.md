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
| Page / API reads per address | 60 an hour, 300 a day (UTC) |
| Page / API reads per network (ASN, all its addresses) | 600 an hour |
| Over a limit | HTTP 429 with `Retry-After` (to the next hour / midnight UTC) |
| Signed out | no prediction at all, finished games too: every prediction is `{ model, locked }`, so game pages show the "Create a free account" prompt (UnlockPrompt) |

Not counted, never blocked: sign-in, sign-up, account, billing and unlock routes, the visit beacon, client errors, and the
login / signup / forgot / verify / join / account pages. People on a VPN can always reach every page and sign in.
Visitor counting is unchanged (bot reason `datacentre`).

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

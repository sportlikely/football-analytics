/**
 * fix212b: the web process answers nothing until every shared state the worker left (nfl, feat, geo, hub, …) is loaded.
 * It listens only after the load (index.ts), and — should a request still arrive before the flag is set — every route,
 * /api/health included, answers 503 with Retry-After, so Railway keeps the old instance serving. The load's stalls are
 * counted apart from the live ones (perf.ts): nobody waited for them.
 */
let ready = false;
let readyAt = 0;
let loadMs = 0;
let states = 0;
export const isReady = () => ready;
export function markReady(o: { loadMs: number; states: number }) { ready = true; readyAt = Date.now(); loadMs = o.loadMs; states = o.states; }
/** /api/health: when the state load ended and how long it took */
export const readiness = () => ({ ready, readyAt: readyAt ? new Date(readyAt).toISOString() : null, stateLoadMs: loadMs, statesLoaded: states });
/**
 * fix276: the warm-up — the first 10 minutes after the web process is ready (or before it is). A slow request, a slow
 * read or a search engine's 503 "Starting up" in it goes to "Errors during the last deploy" / the warm-up line, not
 * into the hour's counts of "Slow requests", "Slow reads (3 h)" or "Search engines verified".
 */
export const WARM_UP_MS = 10 * 60 * 1000;
export const inWarmUp = (now = Date.now()) => !ready || now - readyAt < WARM_UP_MS;

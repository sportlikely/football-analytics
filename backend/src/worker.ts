/**
 * fix202: the worker process, started by web.ts (never on its own). It runs index.ts in the worker role: every
 * scheduled job (live polls, fixtures, results, odds, line-ups, models and tuners, news, data health, backups, warmers,
 * sitemaps), the page builds of pageCache.ts, and every route on 127.0.0.1:WORKER_PORT for the requests web.ts passes on.
 */
process.env.SL_ROLE = 'worker';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('./index');

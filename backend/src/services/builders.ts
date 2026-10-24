/**
 * fix210: the functions that build a page (a player / team / match / game page, news, more predictions, the crawler
 * HTML …) are registered here. The web process never runs one: its routes for them pass the request to the worker
 * (services/workerRoutes.ts) or serve a stored page (services/pageCache.ts). A builder called in the web process is a
 * bug: it throws (fix210b; fix210 still ran it in production) and is counted and logged (/api/perf → webBuilds).
 * scripts/no-web-compute.test.mjs opens every public route in a web process to find one.
 */
import logger from '../utils/logger';
import { isWeb } from './role';

const names = new Set<string>();
const calls = new Map<string, { n: number; last: string }>();
const loggedAt = new Map<string, number>();

export class WebBuildError extends Error {
  constructor(name: string) { super(`builder "${name}" called in the web process`); this.name = 'WebBuildError'; }
}

/** `fn` registered as a page builder under `name` (same signature) */
export function builder<A extends unknown[], R>(name: string, fn: (...a: A) => R): (...a: A) => R {
  names.add(name);
  return (...a: A): R => {
    if (isWeb) {
      const c = calls.get(name) || { n: 0, last: '' };
      c.n++; c.last = new Date().toISOString();
      calls.set(name, c);
      if (Date.now() - (loggedAt.get(name) || 0) > 3600 * 1000) { loggedAt.set(name, Date.now()); logger.warn(`web process asked to build "${name}" (refused: the worker builds pages)`); }
      throw new WebBuildError(name);
    }
    return fn(...a);
  };
}

/** every registered builder (the test lists them) */
export const builderNames = () => [...names].sort();
/** builders the web process ran since start (should stay empty) */
export const webBuilds = () => Object.fromEntries(calls);

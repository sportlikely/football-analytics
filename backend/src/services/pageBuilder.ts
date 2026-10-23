/**
 * fix202 (worker only): keeps the stored pages of pageCache.ts fresh. A page is built by asking the worker's own route
 * on the internal port once per persona (the auth middleware treats the request as that plan, signed out of any
 * account: no visit counted, no limits, no provider budget of a visitor). The prebuild list first, then every page a
 * visitor asked for in the last 30 minutes whose copy is older than its ttl; one page at a time.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import logger from '../utils/logger';
import { every, after, timed } from './perf';
import { INTERNAL_SECRET, toWeb, onWeb } from './ipc';
import { PREBUILD, ruleFor, keyOfUrl, personasOf, pageBuiltAt, writePage, prunePages, type Persona } from './pageCache';

/** the HTML pages are stored with the index.html they were made from (a deploy changes the asset names) */
export function htmlBuildId(staticDir: string): string | null {
  try { return createHash('sha1').update(fs.readFileSync(path.join(staticDir, 'index.html'))).digest('hex').slice(0, 16); }
  catch { return null; }
}

const KEEP_HEADERS = ['content-type', 'cache-control', 'location', 'retry-after'];
const ACTIVE_MS = 30 * 60 * 1000;

function fetchOwn(port: number, key: string, persona: Persona): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: key, headers: { 'x-sl-build': INTERNAL_SECRET, 'x-sl-persona': persona, 'accept-encoding': 'identity' }, timeout: 60000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const h of KEEP_HEADERS) if (typeof res.headers[h] === 'string') headers[h] = res.headers[h] as string;
        resolve({ status: res.statusCode || 0, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const status = { built: 0, failed: 0, lastKey: '', lastMs: 0, lastAt: '', queue: 0, active: 0 };
export const pageBuilderStatus = () => ({ ...status });

export function startPageBuilder(port: number, staticDir: string) {
  // a copy made before this start (another deploy, other settings) is served until it is rebuilt, once, soon after
  const bootAt = Date.now();
  const prebuild = new Set(PREBUILD.map(k => keyOfUrl(k)).filter(Boolean) as string[]);
  const hits = new Map<string, number>();
  const asked = new Set<string>(); // never stored yet: first in line
  const retryAt = new Map<string, number>(); // a page whose route failed: not asked again before this time
  onWeb('hits', m => {
    const now = Date.now();
    for (const k of Array.isArray(m.keys) ? m.keys : []) {
      if (typeof k !== 'string' || !ruleFor(k.split('?')[0])) continue;
      if (!hits.has(k) && !prebuild.has(k) && hits.size > 3000) continue; // a flood of query variants
      hits.set(k, now);
    }
    for (const k of Array.isArray(m.missed) ? m.missed : []) if (typeof k === 'string' && ruleFor(k.split('?')[0])) asked.add(k);
  });

  let running = false;
  const build = async (key: string) => {
    const rule = ruleFor(key.split('?')[0]);
    if (!rule) return;
    const t0 = Date.now();
    const build = rule.html ? htmlBuildId(staticDir) : null;
    let ok = 0;
    for (const persona of personasOf(rule)) {
      try {
        const r = await fetchOwn(port, key, persona);
        // a server error keeps the last good copy (the next round tries again)
        if (r.status >= 500 || !r.status) { status.failed++; continue; }
        writePage(key, persona, { status: r.status, headers: r.headers, body: r.body, build });
        ok++;
      } catch (e: any) {
        status.failed++;
        logger.warn(`page build ${key} (${persona}): ${e?.message || e}`);
      }
    }
    if (ok) { status.built++; toWeb({ type: 'built', key }); }
    // a route that failed (provider down, data missing) is asked again after its ttl, at least 30 s, at most 5 min
    if (ok < personasOf(rule).length) retryAt.set(key, Date.now() + Math.max(30000, Math.min(rule.ttlMs, 300000))); else retryAt.delete(key);
    status.lastKey = key; status.lastMs = Date.now() - t0; status.lastAt = new Date().toISOString();
  };
  const round = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const due: { key: string; at: number; first: boolean }[] = [];
      for (const k of new Set([...asked, ...prebuild, ...hits.keys()])) {
        if (!prebuild.has(k) && !asked.has(k) && now - (hits.get(k) || 0) > ACTIVE_MS) { hits.delete(k); continue; }
        const rule = ruleFor(k.split('?')[0]);
        if (!rule || (retryAt.get(k) || 0) > now) continue;
        const { at, n } = pageBuiltAt(k);
        if (n >= personasOf(rule).length && now - at < rule.ttlMs && at >= bootAt) continue;
        due.push({ key: k, at: n ? at : 0, first: asked.has(k) || !n });
      }
      // pages never stored first (a visitor waited for them), then the oldest copies
      due.sort((a, b) => Number(b.first) - Number(a.first) || a.at - b.at);
      status.queue = due.length; status.active = hits.size;
      for (const d of due) {
        asked.delete(d.key);
        await timed('page build', () => build(d.key));
      }
    } finally {
      running = false;
    }
  };
  // the first round right after the server listens (the web process serves the copies of the last run meanwhile)
  after('page build', round, 1000);
  every('page build round', round, 3000).unref();
  every('page cache prune', () => {
    const keep = new Set([...prebuild, ...hits.keys()]);
    const n = prunePages(keep);
    if (n) logger.info(`page cache: ${n} pages nobody asked for in a day removed`);
  }, 3600 * 1000).unref();
}

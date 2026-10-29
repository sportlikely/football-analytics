/**
 * fix273: the database part of Admin → Visitors, built by the worker (in a job thread) every 5 minutes.
 *
 * It ran on the web thread on every poll of the Admin page (GET /api/admin/visitors, every 30 s): 13–23 s a call
 * on 29 Oct 04:38–05:21 UTC on the slow volume — one open admin tab froze the site for visitors all night. The
 * "by country" query had a sub-query per visitor (no index on vid: every visitor scanned the whole table). Here the
 * latest country is taken in the same pass (MAX(day || country): days are fixed-width), and nothing runs on the web.
 * Only the database is imported: the job thread loads this file alone.
 */
import { db } from '../db';

const PEOPLE = `(human = 1 OR signed_in = 1)`;
const since = (days: number, now: number) => new Date(now - (days - 1) * 86400000).toISOString().slice(0, 10);

/** the latest country of each visitor of the last `days` days, in one pass */
/** (the visitors are the callers without a bot user-agent; their country may come from any of their rows, as before) */
export const BY_COUNTRY_SQL = `
  SELECT COALESCE(country, '??') AS country, SUM(person) AS visitors, SUM(signed) AS signedIn, SUM(1 - person) AS bots FROM (
    SELECT vid, MAX(CASE WHEN ua_bot = 0 THEN signed_in ELSE 0 END) AS signed, MAX(CASE WHEN ua_bot = 0 AND ${PEOPLE} THEN 1 ELSE 0 END) AS person,
      substr(MAX(CASE WHEN country IS NOT NULL THEN day || country END), 11) AS country
    FROM visits WHERE day >= ? GROUP BY vid HAVING MIN(ua_bot) = 0
  ) GROUP BY COALESCE(country, '??') ORDER BY visitors DESC, bots DESC`;

export function visitorDbSummary(now = Date.now()) {
  const count = (days: number, where: string) => (db.prepare(`SELECT COUNT(DISTINCT vid) AS n FROM visits WHERE day >= ? AND ${where}`).get(since(days, now)) as any).n as number;
  const uniq = (days: number) => count(days, PEOPLE);
  const all = (days: number) => count(days, 'ua_bot = 0');
  const daily = db.prepare(`
    SELECT day, SUM(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS visitors, SUM(signed_in) AS signedIn, SUM(hits) AS hits,
      SUM(CASE WHEN ${PEOPLE} THEN 0 ELSE 1 END) AS bots, SUM(CASE WHEN ua_bot = 0 THEN 1 ELSE 0 END) AS allCallers
    FROM visits WHERE day >= ? GROUP BY day ORDER BY day
  `).all(since(30, now)) as { day: string; visitors: number; signedIn: number; hits: number; bots: number; allCallers: number }[];
  const returning = (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT vid FROM visits WHERE day >= ? AND ${PEOPLE} GROUP BY vid HAVING COUNT(*) > 1)`).get(since(30, now)) as any).n as number;
  const first = (db.prepare('SELECT MIN(day) AS d FROM visits').get() as any)?.d || null;
  const botReasons = db.prepare(`SELECT COALESCE(bot, 'no-signs') AS reason, COUNT(*) AS n FROM visits WHERE day = ? AND NOT ${PEOPLE} GROUP BY COALESCE(bot, 'no-signs') ORDER BY n DESC`).all(since(1, now)) as { reason: string; n: number }[];
  const byCountry = (days: number) => db.prepare(BY_COUNTRY_SQL).all(since(days, now)) as { country: string; visitors: number; signedIn: number; bots: number }[];
  const countriesSince = (db.prepare('SELECT MIN(day) AS d FROM visits WHERE country IS NOT NULL').get() as any)?.d || null;
  const peopleSince = ((db.prepare(`SELECT v FROM visit_meta WHERE k = 'people_since'`).get() as any)?.v as string) || '';
  return {
    today: uniq(1), last7: uniq(7), last30: uniq(30), returning30: returning,
    todayBots: count(1, `NOT ${PEOPLE}`), todayAll: all(1), last7All: all(7), last30All: all(30), botReasons,
    peopleSince, daily, countingSince: first,
    countries: { last7: byCountry(7), last30: byCountry(30), since: countriesSince }
  };
}

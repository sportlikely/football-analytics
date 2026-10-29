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
/*
 * fix274: one day = one Israel-time day (00:00–24:00 Asia/Jerusalem), the same key for the rows written (visitors.ts)
 * and the windows read here: "today" at 13:25 Israel time starts at 00:00 Israel time, not at 03:00 (UTC).
 */
const IL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
/** the Israel-time day of a moment, 'YYYY-MM-DD' */
export const visitDay = (ms = Date.now()) => IL_DAY.format(ms);
/** the first day of a window of `days` days ending today (calendar days: no 23 / 25-hour slip at a clock change) */
export const since = (days: number, now = Date.now()) => {
  const [y, m, d] = visitDay(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
};

/** the latest country of each visitor of the last `days` days, in one pass */
/** (the visitors are the callers without a bot user-agent; their country may come from any of their rows, as before) */
export const BY_COUNTRY_SQL = `
  SELECT COALESCE(country, '??') AS country, SUM(person) AS visitors, SUM(signed) AS signedIn, SUM(1 - person) AS bots FROM (
    SELECT vid, MAX(CASE WHEN ua_bot = 0 THEN signed_in ELSE 0 END) AS signed, MAX(CASE WHEN ua_bot = 0 AND ${PEOPLE} THEN 1 ELSE 0 END) AS person,
      substr(MAX(CASE WHEN country IS NOT NULL THEN day || country END), 11) AS country
    FROM visits WHERE day >= ? GROUP BY vid HAVING MIN(ua_bot) = 0
  ) GROUP BY COALESCE(country, '??') ORDER BY visitors DESC, bots DESC`;

export function visitorDbSummary(now = Date.now()) {
  /*
   * fix274: people, bots and all callers of a window from one pass, in one unit (distinct callers = vids): a caller is a
   * person when any of its rows in the window is one, else a bot — so people + bots = all, always. todayBots counted
   * every caller that was not a person (bot user-agents included) and todayAll only the callers without a bot user-agent
   * (29 Oct: 17,467 bots of 16,392 callers; the 1,082 bot user-agents were in one and not the other).
   */
  const callers = (days: number) => {
    const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(p), 0) AS people FROM (SELECT vid, MAX(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS p FROM visits WHERE day >= ? GROUP BY vid)`).get(since(days, now)) as any;
    return { all: r.n as number, people: r.people as number, bots: (r.n - r.people) as number };
  };
  const [w1, w7, w30] = [callers(1), callers(7), callers(30)];
  const daily = db.prepare(`
    SELECT day, SUM(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS visitors, SUM(signed_in) AS signedIn, SUM(hits) AS hits,
      SUM(CASE WHEN ${PEOPLE} THEN 0 ELSE 1 END) AS bots, COUNT(*) AS allCallers
    FROM visits WHERE day >= ? GROUP BY day ORDER BY day
  `).all(since(30, now)) as { day: string; visitors: number; signedIn: number; hits: number; bots: number; allCallers: number }[];
  const returning = (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT vid FROM visits WHERE day >= ? AND ${PEOPLE} GROUP BY vid HAVING COUNT(*) > 1)`).get(since(30, now)) as any).n as number;
  const first = (db.prepare('SELECT MIN(day) AS d FROM visits').get() as any)?.d || null;
  const botReasons = db.prepare(`SELECT COALESCE(bot, 'no-signs') AS reason, COUNT(*) AS n FROM visits WHERE day = ? AND NOT ${PEOPLE} GROUP BY COALESCE(bot, 'no-signs') ORDER BY n DESC`).all(since(1, now)) as { reason: string; n: number }[];
  const byCountry = (days: number) => db.prepare(BY_COUNTRY_SQL).all(since(days, now)) as { country: string; visitors: number; signedIn: number; bots: number }[];
  const countriesSince = (db.prepare('SELECT MIN(day) AS d FROM visits WHERE country IS NOT NULL').get() as any)?.d || null;
  const peopleSince = ((db.prepare(`SELECT v FROM visit_meta WHERE k = 'people_since'`).get() as any)?.v as string) || '';
  return {
    today: w1.people, last7: w7.people, last30: w30.people, returning30: returning,
    // fix274: all = people + bots (every caller, bot user-agents included), each window
    todayBots: w1.bots, todayAll: w1.all, last7Bots: w7.bots, last7All: w7.all, last30Bots: w30.bots, last30All: w30.all, botReasons,
    peopleSince, daily, countingSince: first, dayZone: 'Asia/Jerusalem',
    windowFrom: { today: since(1, now), last7: since(7, now), last30: since(30, now) },
    countries: { last7: byCountry(7), last30: byCountry(30), since: countriesSince }
  };
}

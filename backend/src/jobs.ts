/**
 * fix202: every scheduled job of the site, in one place. Started by the worker process (worker.ts), or by the web
 * process itself when WORKER=0 (the old one-process mode). The web entry (index.ts / app.ts) never imports this file
 * (scripts/worker-split.test.mjs checks it): live polls, fixtures / results / settling, voiding, odds, line-ups and
 * injuries, model builds and daily tuners, more predictions, news, data health, backups, warmers, sitemaps and
 * highlight look-ups all run here.
 */
import footballDataAPI from './services/footballDataAPI';
import logger from './utils/logger';
import { timed, every, after, inBatches, heavy, mapGames, afterHeavy, everyHeavy, expectPagesFirst } from './services/perf';
import { slimForList } from './services/predCache';
import { withLiveScore, publishLiveBook } from './services/liveScores';
import { scorersCheckTick } from './services/scorersCheck';
import { linkCheckTick } from './services/linkCheck';
import { recordPredictions, settlePending } from './services/tracking';
import { oddsTick } from './services/odds';
import {
  afUpcoming, afWithPredictions, pollAfLive, syncFdLiveFromAf, startAfMatchesScheduler, onAfWindow, withAfOdds, backfillAfOdds, warmMatchExtras
, afIdOfFd, fdIdOfAf } from './services/afMatches';
import { fdMatchesNeedingAf, linkFdTwins } from './services/fdReconcile';
import { startSquadValuesScheduler } from './services/squadValues';
import { startClvScheduler } from './services/clv';
import { startNationalEloScheduler } from './services/nationalElo';
import { startClubEloScheduler } from './services/clubElo';
import { startDataAuditScheduler } from './services/dataAudit';
import { startNewsScheduler } from './services/news';
import { startBasketballScheduler } from './services/basketball';
import { startBdlScheduler } from './services/bdl';
import { startBackups } from './services/backup';
import { startAsn } from './services/asn';
import { startCrawlerRanges } from './services/crawlerIps';
import { startTennisScheduler } from './services/tennis';
import { startTennisModelScheduler } from './services/tennisModel';
import { startGeo } from './services/geo';
import { ensureIndexes } from './services/dbIndexes';
import { warmHubs } from './services/hubs';
import { startFeatureModelScheduler } from './services/featureModel';
import { startModelDailyScheduler } from './services/modelDaily';
import { startNflScheduler, backfillPlayerGames } from './services/nfl';
import { markFresh, markFailed } from './services/freshness';
import { startDataHealthScheduler } from './services/dataHealth';
import { startMorePredictionsScheduler } from './services/morePredictions';
import { startSeasonForecastScheduler } from './services/seasonForecast';
import { resolveUnsettled, resolveUnsettledOnce, Providers as SettleProviders } from './services/unsettled';
import { startApiFootballScheduler, rebuildAfFeaturesAsync, afGet, afRemaining } from './services/apiFootball';
import { prepareModelV3Async } from './services/gridModel';
import { writeLive, clearLive } from './services/liveState';
import { startPageWarmer, refreshPages, storePage, storedAt } from './services/pageCache';
import { startBundleKeeper } from './services/gameBundle';
import { db } from './db';
import { yieldEvery } from './services/perf';
import { warmSearchIndex } from './services/teamPage';
import { warmBbSearch } from './services/bbPlayers';
import { photosTick, photosBbPass, photosOn, purgeUnofficialPhotos } from './services/playerPhotos';
import { autoTuneDue, runTune, leagueTuneDue, runLeagueTune, missFitDue, runMissFit, impactFitDue, impactRowsReady, runImpactFit, impactRegateDue, regateImpact } from './services/bbTuner';
import { threadJobsOn, inThread } from './services/threadJob';
import { buildBbCalibration } from './services/sportCalibration';
import { startKeyPlayersScheduler } from './services/keyPlayers';
import { picksEmailTick, migrateMarketingOptIn } from './services/pickEmails';
import { pushAlertsTick } from './services/pushAlerts';
import { buildSlugs } from './services/slugs';
import { startGameExtrasScheduler } from './services/gameExtras';
import { fillFromFinals } from './services/history';
import { checkOtherResults } from './services/resultChecks';
import { dailySummaryTick } from './services/adminMail';
import { diffViewFreezeTick } from './services/diffView';
import { startDbSpaceScheduler } from './services/dbSpace';

let started = false;

/** Start every scheduler (once). The worker calls it right after start; WORKER=0 calls it after listen. */
export function startJobs() {
  if (started) return;
  started = true;
  clearLive();
  // fix232: the model rebuilds and fits (perf.MODEL_JOBS) wait for the first round of stored pages (at most 10 min)
  expectPagesFirst();
  // fix232 (scripts/deploy-restart.test.mjs): a long "bb model" rebuild without data — the lists must stay served and rebuilt meanwhile
  const testModelMs = Number(process.env.SL_TEST_MODEL_MS) || 0;
  if (testModelMs) after('test model', () => heavy('bb model', async () => { const end = Date.now() + testModelMs; while (Date.now() < end) await new Promise(r => setTimeout(r, 50)); }), 1000).unref();

  every('link check', linkCheckTick, 3600 * 1000).unref();
  // fix239: American football / tennis results the data may have swapped (basketball's check runs in its own scheduler),
  // and the 07:00 Israel-time email of everything that fixed itself (checked every 5 minutes)
  after('result checks', () => checkOtherResults().catch(e => logger.warn(`result checks: ${e?.message || e}`)), 8 * 60 * 1000).unref();
  every('result checks', () => checkOtherResults().catch(e => logger.warn(`result checks: ${e?.message || e}`)), 30 * 60 * 1000).unref();
  every('admin daily summary', () => dailySummaryTick().catch(e => logger.warn(`admin daily summary: ${e?.message || e}`)), 5 * 60 * 1000).unref();
  // fix246: "Our different view" (admin only) — games with a 5+ point gap to the market written once after kick-off
  every('different view', () => { diffViewFreezeTick(); }, 5 * 60 * 1000).unref();
  // fix229: clean links — slugs for new teams / players / leagues / matches every 15 minutes (renames every 6 h); the
  // first run waits for the leagues and the team index to load (a league's country decides a shared name's slug)
  after('slugs', () => buildSlugs().then(() => every('slugs', () => buildSlugs(), 15 * 60 * 1000).unref()), 4 * 60 * 1000).unref();
  // fix169: the weekly prediction hubs are rebuilt in the background (visitors and crawlers get the cached copy)
  every('hub warm', () => warmHubs(), 15 * 60 * 1000).unref();
  // fix175: indexes for the crawler pages, built off the main thread
  after('db indexes', () => ensureIndexes(), 20 * 1000).unref();
  // fix249: checkpoints, retention (logs 14 days, in slices), incremental vacuum, the size report and history
  startDbSpaceScheduler();
  after('hub warm', () => warmHubs(), 60 * 1000).unref();
  // fix174: the player → games index for NFL player careers (once, in slices)
  after('nfl player games', () => backfillPlayerGames().catch(e => logger.warn(`nfl player games: ${e.message}`)), 5 * 60 * 1000).unref();
  after('link check', () => linkCheckTick(), 10 * 60 * 1000).unref();
  // fix202: the search indexes (teams, players) for the web process
  // fix210: in the heavy-job queue, built in pages
  afterHeavy('search index', async () => { await warmSearchIndex(); await warmBbSearch(); }, 30 * 1000).unref();
  everyHeavy('search index', () => warmSearchIndex(), 6 * 3600 * 1000).unref();
  everyHeavy('bb search index', () => warmBbSearch(), 3600 * 1000).unref();
  // fix210b: every finished basketball game page of the current and last season stored ahead (search engines read old
  // games ~1,300 an hour): the web process then only writes the text of the language asked for
  afterHeavy('bb game pages', () => prebuildBbGamePages(), 10 * 60 * 1000).unref();
  everyHeavy('bb game pages', () => prebuildBbGamePages(), 6 * 3600 * 1000).unref();
  // fix209: "Scorers shown" — every live / finished game of the last 48 h names its scorers (and fetches them again)
  after('scorers check', () => scorersCheckTick(), 3 * 60 * 1000).unref();
  every('scorers check', () => scorersCheckTick(), 5 * 60 * 1000).unref();
  // fix241: official photos only — the Wikidata / Commons matcher (fix211 / fix221) is off (photosOn() false: Wikimedia
  // is not on utils/photoSources.ts), its stored files and rows are deleted here; the jobs stay for a licensed source
  after('photo sources', () => { purgeUnofficialPhotos(); }, 60 * 1000).unref();
  if (photosOn()) {
    after('player photos', () => photosTick(), 4 * 60 * 1000).unref();
    every('player photos', () => photosTick(), 20 * 60 * 1000).unref();
    setTimeout(() => { photosBbPass().catch(e => logger.warn(`player photos: basketball pass: ${e?.message || e}`)); }, 6 * 60 * 1000).unref();
  }
  // fix222: bb-v4 tuned on this database (first run ~20 min after the start, once the grid rows are stored; then
  // monthly), applied only through the gate (bbTuner.runTune auto); then the basketball calibration layer again
  // fix223: then the per-league settings on top of the stored shared tune (first run, after an applied shared tune, monthly)
  // fix228: first the #4 fit on who actually played (once a database; stored through its gate), the tunes keep it frozen
  const bbAutoTune = async () => {
    let calib = false;
    const mwhy = missFitDue();
    if (mwhy) {
      try {
        const opt = { auto: mwhy, apply: 'gate' as const };
        const r: any = await heavy('bb miss fit', () => (threadJobsOn() ? inThread('bb miss fit', [opt]) : runMissFit(opt)));
        calib = !!r?.applied;
      } catch (e: any) { logger.warn(`bb-v4 #4 fit (${mwhy}): ${e?.message || e}`); }
    }
    // fix225: the box-score impact + star factor (once a database, after the model build stored the new values; through its gate)
    const iwhy = impactFitDue();
    if (iwhy && impactRowsReady()) {
      try {
        const opt = { auto: iwhy, apply: 'gate' as const };
        const r: any = await heavy('bb impact fit', () => (threadJobsOn() ? inThread('bb impact fit', [opt]) : runImpactFit(opt)));
        calib = calib || !!r?.applied;
      } catch (e: any) { logger.warn(`bb-v4 box-score impact (${iwhy}): ${e?.message || e}`); }
    }
    // fix236: a fix225 fit the old gate rejected, judged once more by the gate on the live basis (no refit)
    const rwhy = impactRegateDue();
    if (rwhy && impactRowsReady()) {
      try {
        const r: any = await heavy('bb impact regate', () => regateImpact({ auto: rwhy, apply: 'gate' }));
        calib = calib || !!r?.applied;
      } catch (e: any) { logger.warn(`bb-v4 box-score impact re-gate: ${e?.message || e}`); }
    }
    const why = autoTuneDue();
    if (why) {
      try {
        const r: any = await heavy('bb tune', () => (threadJobsOn() ? inThread('bb tune', [{ auto: why }]) : runTune({ auto: why })));
        calib = !!r?.auto?.applied;
      } catch (e: any) { logger.warn(`bb-v4 tune (${why}): ${e?.message || e}`); }
    }
    const lwhy = leagueTuneDue();
    if (lwhy) {
      try {
        const opt = { auto: lwhy, apply: true };
        await heavy('bb league tune', () => (threadJobsOn() ? inThread('bb league tune', [opt]) : runLeagueTune(opt)));
        calib = true;
      } catch (e: any) { logger.warn(`bb-v4 league settings (${lwhy}): ${e?.message || e}`); }
    }
    if (calib) await buildBbCalibration('after the bb-v4 tune');
  };
  after('bb tune (auto)', bbAutoTune, 20 * 60 * 1000).unref();
  every('bb tune (auto)', bbAutoTune, 3600 * 1000).unref();
  // fix222: the calibration layers of basketball (bb-v4's walk-forward rows) and tennis (tennis-v1's walk-forward months),
  // ~25 min after the start, then every 6 h (each kept only when it beats the raw chances on its test season; fix222b:
  // the basketball in-season layer follows this season's games)
  afterHeavy('bb calibration', () => buildBbCalibration('start'), 25 * 60 * 1000).unref();
  everyHeavy('bb calibration', () => buildBbCalibration('6-hourly'), 6 * 3600 * 1000).unref();
  // fix224: basketball star-rest patterns (daily), injuries from news + what was applied to each game (every 30 min)
  startKeyPlayersScheduler();
  // fix231: game-page extras — venues, weather (Open-Meteo) and referees for the next 72 h, every 3 h; coverage after
  startGameExtrasScheduler();
  // fix234: football results the history files don't have yet, from our own final scores (every 20 min; the 6-hourly
  // model fit uses them)
  const fillHistory = () => { const f = fillFromFinals(); if (f.added || f.replaced) logger.info(`history fill: ${f.added} added, ${f.replaced} replaced by the files, ${f.unmapped} without team names`); };
  after('history fill', fillHistory, 4 * 60 * 1000).unref();
  every('history fill', fillHistory, 20 * 60 * 1000).unref();
  // fix216: the daily picks email and the weekly digest, at each person's own send hour (checked every 5 min)
  migrateMarketingOptIn(); // fix218: the old "Email updates" switch → weekly digest, once
  every('picks emails', () => picksEmailTick().catch(e => logger.warn(`picks emails: ${e?.message || e}`)), 5 * 60 * 1000).unref();

  startLivePoll();

  // Save/refresh predictions every time the fixture window is refreshed
  // fix169: recorded in batches of 25 with yields (fix159 style)
  footballDataAPI.onWindowRefreshed = matches => {
    void timed('record predictions (main leagues)', () => inBatches(matches, 25, b => { recordPredictions(b); return []; })).catch(e => logger.warn(`record predictions: ${e.message}`));
    refreshPages('upcoming');
  };
  // Same for API-Football competitions (national teams, UEFA cups, extra leagues)
  // fix196: in the heavy() queue (one heavy job at a time, never during a live tick), always on the latest window;
  // 5 matches a batch (25 right after the prediction cache was cleared blocked up to ~1 s)
  let afWindowLatest: any[] = [];
  onAfWindow(matches => { afWindowLatest = matches; void heavy('predict more-leagues window', async () => {
    const matches = afWindowLatest;
    const withP: any[] = await timed('predict more-leagues window', () => inBatches(matches, 5, b => afWithPredictions(b), { live: true }));
    await timed('record predictions (more leagues)', () => inBatches(withP, 10, b => { recordPredictions(b); return []; }, { live: true }));
    refreshPages('upcoming');
    // then the bookmaker odds for matches starting soon, so every tracked game can be compared with the market
    // fix169: awaited and batched under a label (the continuation used to run after the label had ended)
    const ms = await withAfOdds(matches).catch(err => { logger.warn('AF odds for tracking failed', { message: err.message }); return [] as any[]; });
    if (ms.length) await timed('record predictions (odds)', () => inBatches(ms, 5, b => { recordPredictions(afWithPredictions(b)); return []; }, { live: true }));
  }).catch(err => logger.warn('AF window predictions failed', { message: err.message })); });
  // fix167: the schedulers start one after another over the first 2 minutes (each under its own name in /api/perf),
  // not all at once ("boot (scheduler start)" blocked 11 s on every deploy). The fixture window comes first.
  const STARTS: [string, () => unknown][] = [
    // Warm the fixture window now and keep it fresh in the background
    ['FD window', () => footballDataAPI.startBackgroundRefresh()],
    // Extra competitions (national teams, Europa/Conference League, Israel, Saudi, more European leagues)
    ['AF matches', () => startAfMatchesScheduler()],
    ['basketball', () => startBasketballScheduler()],
    // NFL games (fix136): every season once, then the current season every 6 h
    ['nfl', () => startNflScheduler()],
    // Injuries / suspensions / confirmed lineups (API-Football) for model v3 rows #12 and #13
    ['API-Football', () => startApiFootballScheduler()],
    // Squad market values for model v3 (weekly; first attempt after the history sync has team names)
    // fix169: the async v3 build (the sync one froze the server 1.6 s), awaited inside the 'squad values' label
    ['squad values', () => startSquadValuesScheduler(async () => { await prepareModelV3Async(); await rebuildAfFeaturesAsync(true); })],
    ['balldontlie', () => startBdlScheduler()],
    // Live closing-line value tracking (open price + v3 at 48 h, closing price in the last 35 min)
    ['clv', () => startClvScheduler()],
    // National-team Elo from international results since 2014 (API-Football)
    ['national elo', () => startNationalEloScheduler()],
    // European club Elo (UEFA cups + domestic results + squad values)
    ['club elo', () => startClubEloScheduler()],
    // Feature model + v3-mix (state every 30 min), daily champion / challenger at 04:00 UTC, report at 07:00 Jerusalem
    ['feature model', () => startFeatureModelScheduler()],
    ['model daily', () => startModelDailyScheduler()],
    ['news', () => startNewsScheduler()],
    ['data audit', () => startDataAuditScheduler()],
    ['data health', () => startDataHealthScheduler()],
    // Visitor countries: DB-IP country data, refreshed monthly (services/geo.ts)
    ['geo', () => startGeo()],
    // fix183: data-centre networks (iptoasn.com), so the visitor counter leaves out servers
    ['asn', () => startAsn()],
    // fix245: Google / Bing / Apple crawler address lists, daily (search engines verified even when DNS fails)
    ['crawler ranges', () => startCrawlerRanges()],
    // fix184: tennis data (Live Tennis API Pro, admin only)
    ['tennis', () => startTennisScheduler()],
    // fix190: tennis-v1 (admin only): report once the backfill reached 2023-01, weekly re-tune, predictions every 30 min
    ['tennis model', () => startTennisModelScheduler()],
    // Daily database backup (services/backup.ts)
    ['backups', () => startBackups()],
    // fix204: More predictions — saved before the start, checked after the game; league fits + backtests (the public gates) daily
    ['more predictions', () => startMorePredictionsScheduler()],
    // fix215: season forecast — every league simulated to the end, 10 min after each finished game and nightly
    ['season forecast', () => startSeasonForecastScheduler()]
  ];
  STARTS.forEach(([label, start], i) => after(`start ${label}`, start, Math.round((i * 120_000) / STARTS.length)));
  // fix202: the stored pages (match list, records, basketball / NFL / tennis home …): built once the windows and models
  // had a moment to load, then kept fresh
  after('stored pages', () => startPageWarmer(), 20 * 1000);
  // fix250: the game bundles visitors opened in the last hour, kept fresh (services/gameBundle.ts)
  startBundleKeeper();

  // Settle finished matches every 10 minutes (first run after 1 minute)
  // fix200: games past kick-off + 48 h without a final are looked up (by id, then by the two teams) once an hour and
  // settled, moved or voided (services/unsettled.ts); the stuck ones of 11–19 Oct once right after the deploy
  const settleProviders: SettleProviders = {
    afByIds: async ids => { if (afRemaining() < 50) throw new Error('API-Football budget reserve'); return (await afGet('/fixtures', { ids: ids.join('-') })).response || []; },
    afByTeams: async (home, away, from, to) => { if (afRemaining() < 50) throw new Error('API-Football budget reserve'); return (await afGet('/fixtures/headtohead', { h2h: `${home}-${away}`, from, to })).response || []; },
    fdRange: (from, to) => footballDataAPI.getMatchesInRange(from, to),
    // fix240: the same game at the other provider (stored links; home / away swapped twins are left out)
    twinOf: id => {
      if (id >= 1_000_000_000) return fdIdOfAf(id - 1_000_000_000);
      const l = afIdOfFd(id);
      return l && !l.swapped ? 1_000_000_000 + l.fid : null;
    }
  };
  let unsettledAt = 0;
  const settle = () =>
    settlePending(
      (from, to) => footballDataAPI.getMatchesInRange(from, to),
      async ids => (afRemaining() > 50 ? ((await afGet('/fixtures', { ids: ids.join('-') })).response || []) : []),
      id => afIdOfFd(id) // fix212: FD games without a final 20 min after the expected end are settled from API-Football
    )
      .then(async r => {
        if (Date.now() - unsettledAt > 3600 * 1000) {
          unsettledAt = Date.now();
          await resolveUnsettledOnce(settleProviders);
          const u = await resolveUnsettled(settleProviders, { log: true });
          if (u.checked) logger.info(`unsettled: ${u.checked} checked · ${u.settled} settled · ${u.moved} moved · ${u.voided} void · ${u.retry} looked again · ${u.review} in Needs you`);
          if (u.settled || u.voided) refreshPages('summary', 'record', 'results');
        }
        markFresh('results', r ? `${r.settled} settled, ${r.pending} pending` : undefined);
        if (r?.settled) refreshPages('summary', 'record', 'results');
        return backfillAfOdds();
      })
      .catch(err => { markFailed('results', err); logger.warn('Settle job failed', { message: err.message }); });
  // fix212b: every Football-Data game of the next 7 days linked to its API-Football fixture before kick-off
  const twins = () => footballDataAPI.getUpcomingMatches(7).then(ms => linkFdTwins(ms)).catch(e => logger.warn(`FD twins: ${e?.message || e}`));
  after('FD twins', twins, 3 * 60 * 1000);
  every('FD twins', twins, 60 * 60 * 1000);
  after('settle picks', settle, 60 * 1000);
  every('settle picks', settle, parseInt(process.env.SETTLE_INTERVAL_MS || '600000', 10));
  // Market odds: decide every 10 minutes which competitions deserve a fetch (budget-aware)
  const odds = () =>
    footballDataAPI
      .getUpcomingMatches(30)
      .then(ms => oddsTick(ms))
      .then(() => markFresh('odds'))
      .catch(err => { markFailed('odds', err); logger.warn('Odds job failed', { message: err.message }); });
  after('odds', odds, 90 * 1000);
  every('odds', odds, parseInt(process.env.ODDS_TICK_MS || '600000', 10));
  // Match-page tabs (averages, expected XI, H2H) prepared ahead for the next 48h, every 2 hours
  const warmExtras = async () => {
    const fd = await footballDataAPI.getUpcomingMatches(3).catch(() => [] as any[]);
    await warmMatchExtras([...fd, ...afUpcoming(3)], 48);
  };
  after('warm match extras', () => warmExtras().catch(() => undefined), 4 * 60 * 1000);
  every('warm match extras', () => warmExtras().catch(() => undefined), 2 * 3600 * 1000);
}

/**
 * fix210b: the stored data of every finished basketball game of each league's two latest seasons ('bb-game-facts',
 * app.ts), built when missing or when it was built in the game's first 2 days (box scores and checks still coming in).
 * Game ids read 500 at a time; a yield every 50 games / 100 ms and while a live tick runs; each page written when built.
 */
export async function prebuildBbGamePages(): Promise<{ checked: number; built: number }> {
  const step = yieldEvery(50, 100, { live: true });
  const seasons = new Map<string, string[]>();
  for (const r of db.prepare(`SELECT DISTINCT code, season FROM bb_games WHERE status IN ('FT','AOT')`).all() as any[]) {
    const l = seasons.get(r.code) || [];
    l.push(String(r.season));
    seasons.set(r.code, l);
  }
  const page = db.prepare(`SELECT game_id, kickoff FROM bb_games WHERE code = ? AND season = ? AND status IN ('FT','AOT') AND game_id > ? ORDER BY game_id LIMIT 500`);
  let checked = 0, built = 0;
  for (const [code, list] of seasons) {
    for (const season of list.sort().slice(-2)) {
      for (let after = 0; ;) {
        const rows = page.all(code, season, after) as { game_id: number; kickoff: string }[];
        if (!rows.length) break;
        after = rows[rows.length - 1].game_id;
        for (const g of rows) {
          checked++;
          const at = storedAt('bb-game-facts', { id: g.game_id }), settled = Date.parse(g.kickoff) + 2 * 86400000;
          if (!at || (at < settled && Date.now() > settled)) { await storePage('bb-game-facts', { id: g.game_id }); built++; }
          await step();
        }
      }
    }
  }
  if (built) logger.info(`bb game pages: ${built} built, ${checked} finished games checked`);
  return { checked, built };
}

// Push live scores (every 20 s, fix115): Football-Data.org's live list is fetched fresh every 3rd tick (rate limit),
// the last list is reused in between; API-Football's live=all is polled every tick while any match is live, and each
// Football-Data.org match shows the fresher of the two readings (liveScores.ts) — the same score as the match page.
// fix202: the tick writes its list to live_state; the web process pushes it on the socket (liveState.ts).
function startLivePoll() {
  const LIVE_POLL_MS = parseInt(process.env.LIVE_POLL_MS || '20000', 10);
  let livePolling = false;
  let liveTick = 0;
  every('live poll', async () => {
    if (livePolling) return; // a slow poll (API waits) must not overlap the next one
    livePolling = true;
    try {
      // fix155: each part under its own label, so /api/perf names any freeze (football live / AF live / live push)
      const fresh = liveTick++ % 3 === 0;
      const fdRaw: any[] = await timed('football live', () => (fresh ? footballDataAPI.getLiveMatches(true) : footballDataAPI.liveSnapshot()));
      // fix212: the window's matches FD is behind on (past kick-off and still TIMED, stale, or FD frozen) are live for
      // API-Football's purposes: they keep live=all polled and get its reading every tick
      const due = fdMatchesNeedingAf(await footballDataAPI.getUpcomingMatches(2).catch(() => [] as any[]));
      const afLiveNow = await timed('AF live', () => pollAfLive(fdRaw.length > 0 || due.length > 0));
      await timed('AF live', () => syncFdLiveFromAf(fdRaw, due));
      // fix200: at most 20 games per turn, the rest on the next macrotask (a Saturday has 100+ live games)
      const live: any[] = await timed('football live', async () => {
        const fdLive = await mapGames(fdRaw, b => {
          const withP = footballDataAPI.withPredictions(b.map(withLiveScore));
          recordPredictions(withP); // locks anything that has kicked off (Football-Data.org matches only)
          return withP;
        });
        const afLive = await mapGames(afLiveNow, b => afWithPredictions(b));
        return mapGames([...fdLive, ...afLive], b => b.map(slimForList));
      });
      await timed('live push', async () => {
        publishLiveBook();
        writeLive('football', live);
      });
      markFresh('live', `${live.length} live`);
    } catch (error: any) {
      logger.warn('Live poll failed', { message: error.message });
      markFailed('live', error);
    } finally {
      // fix226: push alerts ride on the live loop (every sport's games read after each tick; sent from here only)
      await timed('push alerts', () => pushAlertsTick()).catch(e => logger.warn(`push alerts: ${e?.message || e}`));
      livePolling = false;
    }
  }, LIVE_POLL_MS);
}

import express from 'express';
import zlib from 'node:zlib';
import { joinWaitlist, waitlistStats } from './services/waitlist';
import { slimForList, clearPredictionCache } from './services/predCache';
import { withLiveScore, liveBookStatus } from './services/liveScores';
import { goalEventsOverlay, noteServedScorers, scorersComplete } from './services/scorersCheck';
import { betterGoals } from './utils/scorers';
import { runLinkCheck, lastLinkCheck } from './services/linkCheck';
import { markMissingPlayer } from './services/missingPlayers';
import { signupToken, checkSignupToken, honeypotHit, turnstileOk, turnstileSiteKey, checkSignupSurge } from './services/signupGuard';
import { perfStatus, perfSummary, setJob, timed, yieldLoop, every, track, routeLabel, after, inBatches, requestDetail, heavy, perGames, mapGames } from './services/perf';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import logger from './utils/logger';

// Load .env from backend root (in production the host injects env vars and there is no file)
const envResult = dotenv.config();
if (envResult.error && process.env.NODE_ENV !== 'production') {
  console.error('❌ Error loading .env:', envResult.error.message);
}
console.log('API Key:', process.env.FOOTBALL_DATA_API_KEY ? '✅ SET' : '❌ NOT SET');

// Import after env is loaded
import footballDataAPI from './services/footballDataAPI';
import { recordPredictions, settlePending, accuracy, recentSettled, trackingStatus, computeMetrics, publicRecord, preloadSettled } from './services/tracking';
import { historyStatus, teamMapStatus, GROUPS, syncAll, syncH2HArchive, h2hArchiveStatus, syncHalfTimes } from './services/history';
import { withLive, liveHalfTimeTest } from './services/liveChance';
import { backtestUpsets, upsetWatchReport, upsetWatchBacktest } from './services/upsetAlerts';
import { submitContact, contactInbox, markContact, ContactError } from './services/contact';
import { adminSummary } from './services/adminSummary';
import { ADMIN_2FA_REQUIRED, checkCode, revealSetup, twoFactorEnabled, twoFactorStatus, startSetup, confirmSetup, newRecovery, disableTwoFactor, issueTicket, redeemTicket, securePastSessions, TwoFactorError } from './services/twoFactor';
import { securityLog, securityLogList } from './services/securityLog';
import { recordActivity, activityList } from './services/activity';
import { createInvite, setInviteOpen, inviteInfo, joinAsTester, testerOf, testerOverview, TesterError } from './services/testers';
import { runBackup, backupStatus, localPath, remoteList, remoteReady } from './services/backup';
import { reportClientError, clientErrorList, resolveClientError } from './services/clientErrors';
import { gamePicks, setPick, personalRecord, PickError } from './services/userPicks';
import { inboxList, inboxThread, reply, addNote, setStatus, assign, canOpen, searchCustomers, customerProfile, signOutEverywhere, segmentPreview, campaignList, sendTest, startCampaign, revenue, unsubscribe, CrmError, type Viewer } from './services/crm';
import { roleByKey, listRoles, listStaff, createRole, updateRole, deleteRole, RoleError, type Perm } from './services/roles';
import { consoleRow, sessionUnlocked, lockSession, setupOwn, setFor, renameFor, consoleLogin, changeOwn, resetOwn, removeFor, consoleUsers, ConsoleError } from './services/staffConsole';
import { modelV2Status, runBacktest, runBacktestAll, backtestProgress, backtestRows, backtestRunsList } from './services/historyModel';
import { oddsTick, oddsStatus, fetchCompetitionOdds, SPORT_KEYS } from './services/odds';
import { syncSquadValues, squadValuesStatus, squadCompetitions } from './services/squadValues';
import { syncClubValueHistory, clubValueHistoryStatus, findClub } from './services/squadHistory';
import { compareModels } from './services/compareModels';
import { gapReport } from './services/gapReport';
import { pastSeasons, pastPredictions, dataInventory, leaguePatterns } from './services/pastView';
import { marketTest, drawTest, anchoredDrawTest } from './services/marketTest';
import { clvTick, clvReport, clvProbe } from './services/clv';
import { diffViewReport } from './services/diffView';
import {
  isAfMatchId, isAfCode, afUpcoming, afLive, afWithPredictions, getAfMatchDetails, getAfStandings, getAfScorers, getAfRecent,
  afCompetitions, pollAfLive, syncFdLiveFromAf, afWindowStatus, refreshAfWindow, onAfWindow, isKnownAfFixture, afExtrasForFd, afLiveOverlay, withAfOdds, backfillAfOdds,
  warmMatchExtras, teamAverages, probableXI, lastMeetings, AF_OFFSET,
  afFixtureInfo, fixtureInjuriesRated, teamSchedule
} from './services/afMatches';
import { buildNationalElo, syncNationalHistory, nationalEloStatus, nationalGoalsSensitivity, tuneNational, nationalTuneStatus } from './services/nationalElo';
import { buildClubElo, syncEuropeanCups, clubEloStatus, clubValueReport } from './services/clubElo';
import { nationalValueSearch, historyMatchReport } from './services/squadValues';
import { drawAlertsReportAsync, drawPicksCount, drawFactorTest } from './services/drawAlerts';
import { teamPage as teamPageB, searchTeams, searchPlayers, searchPlayersRemote as searchPlayersRemoteB, resolveAfTeamId, setTeamOverride, teamOverrides } from './services/teamPage';
import { playerPage as playerPageB, findPlayer as findPlayerB } from './services/playerPage';
import { unlockStatus, unlockMatch, unlockedIds, isFinished, testCheckout, PLANS, billingTestMode, unlockStats, REFUND_DAYS, FREE_WEEKLY_UNLOCKS, packsFor, buyPack, addCredits, creditBalance, creditEvents, PICK_PRICE, PACK_SIZES } from './services/billing';
import { goalsCalibration } from './services/goalsCalibration';
import { runDataAudit, lastDataAudit } from './services/dataAudit';
import { newsFor as newsForB, newsStatus, bbTeamNames, footballTeamNames, nflTeamNamesById } from './services/news';
import { bbGet, bbStatus, bbSyncNow } from './services/basketball';
import { adminResult, resultChecksList, checkResults, openCheck, resultFix, ResultError } from './services/bbResults';
import { decideReview, openReviews, ReviewError } from './services/resultChecks';
import { actionInfo, runAction } from './services/adminMail';
import { bdlGet, refreshNbaInjuries, nbaInjuryStatus } from './services/bbInjuries';
import { bbPublic, bbLeagues, bbGames, bbGame as bbGameB, bbStandings, bbTeam as bbTeamB } from './services/bbSite';
import { bbPlayer as bbPlayerB, nbaLeaders, bbSearch, bbLeagueLeaders } from './services/bbPlayers';
import { bdlStatus } from './services/bdl';
import { bbBacktest, bbRecord, bbExport, bbExportPlayers, bbWalkForward } from './services/bbModel';
import { nbaV4Check } from './services/nbaV4';
import { newsInjuryList, reviewNewsInjury } from './services/keyPlayers';
import { runTune, tunedInfo, runLeagueTune, runMissFit, runImpactFit, storedLeagues, storedMiss, storedImpact, regateImpact } from './services/bbTuner';
import { startAdminJob, adminJobAnswer } from './services/adminJobs';
import { buildBbCalibration, calibReport, inSeasonMode, setInSeasonMode } from './services/sportCalibration';
import { bbLiveQuarterTest } from './services/bbLive';
import { highlightsFor, highlightsStatus, lastCandidates } from './services/highlights';
import { rebuildPlayerQuality, playerQualityTable } from './services/playerQuality';
import { db } from './db';
import { liveList, liveAt } from './services/liveState';
import { isWeb, isWorker, ROLE } from './services/role';
import { isReady, readiness } from './services/readiness';
import { serveEarly, needsState, currentMainScript } from './services/earlyStatic';
import { deployErrorsMiddleware, noteLoading } from './services/deployErrors';
import { stallsSinceReady, slowSinceReady } from './services/perf';
import { workerRoutes, workerRoutesStatus, sendStartupCopy } from './services/workerRoutes';
import { deadlineStart, lateCopy, slowRequests } from './services/deadline';
import { buildBundle, noteBundleAsked, isBundleCall, type BundleSport } from './services/gameBundle';
import { threadJobsOn, inThread, threadJobStatus } from './services/threadJob';
import { deferredStatus } from './services/deferredWrites';
import { builder, webBuilds } from './services/builders';
import { workerHealth, memorySizing } from './services/workerHealth';
import { perfHours } from './services/perfHistory';
import { sharedStatus } from './services/shared';
import { forwardToWorker, fetchFromWorker } from './services/forward';
import { linkAnswer, idOfSlug, slugOf, clientSlugs, slugStatus, internalPath, pubPath, isOldAddress, pastMatch, type LinkAnswer } from './services/slugs';
import { LINK_SPORTS, LINK_KINDS, isSlug, type LinkSport, type LinkKind } from './utils/slugRules';
import { definePage, getPage, refreshPages, pageCacheStatus, pageMemStatus, joinRows, etagOf, type Query, type Rows, type View } from './services/pageCache';
import { trackVisit, visitorStats, visitSeen } from './services/visitors';
import { networkOf } from './services/asn';
import { ProxyLimiter, proxyApplies, countedRead, lockAllPredictions, viewIdOf, makePass, readPass, PASS_COOKIE, PASS_MS } from './services/proxyGuard';
import { noteNetworkRequest, noteWho, whoToday, notePassed } from './services/proxyScrapers';
import { quickCheckPage, qcLangOf } from './utils/quickCheck';
import { shortName } from './utils/tennisNames';
import { tennisProbe, tennisStatus, tennisSample, tennisDataCheck, tennisMovedId } from './services/tennis';
import { tennisModelReport, tennisModelTick, tennisPredictions, tennisPlayerModel } from './services/tennisModel';
import { tennisPublic, tennisRid, tennisMatchesBetween, tennisLive, tennisRecent, withTennisPredictions, tennisMatch as tennisMatchB, tennisRecord, levelRank, tennisTournament as tennisTournamentB, tennisPlayer as tennisPlayerB, tennisRankings, tennisSearch, tennisAccuracy, tennisWriteup } from './services/tennisSite';
import { geoCredit, countryOf } from './services/geo';
import { bbGameFacts as bbGameFactsB, bbGameSeo, bbGamePath, bbFactsFreshMs } from './services/seo';
import { seoPage as seoPageB, renderIndex, sitemapXml, SITEMAPS, todayGroups as todayGroupsB, hubRedirect, leagueRedirect, MERGED_LEAGUES } from './services/seo';
import { listGuides, getGuide } from './services/guides';
import { howItWorks, hiwPublic, changelog, HIW_SPORTS, type HiwSport } from './services/howItWorks';
import { hubBySlug, hubByOld, hubOpen, buildHub, HUBS } from './services/hubs';
import { refreshFromDetails } from './services/matchPreview';
import { fontRoute, warmFonts } from './services/fonts';
import { listFavorites, addFavorites, removeFavorite, MAX_FAVORITES } from './services/favorites';
import { calendarToken, resetCalendarToken, calendarIcs, asCalLang, tokenHint, TOKEN_RE } from './services/calendar';
import { tuneV3Full, tuneStatus, isTuning } from './services/v3Tuner';
import { cleanName, mayHaveSponsor, NAME_KEYS } from './services/sponsorNames';
import { hiddenModels, v3MixBacktest, featureModelStatus, setConfig as setModelConfig, setMixLive } from './services/featureModel';
import { runModelDaily, sendMorningReport, modelDailyLog, buildReport, dailyRunning } from './services/modelDaily';
import { nflProbe, nflCurrentSeason, asLeague, asLeagues, LEAGUES } from './services/nfl';
import { winnerUpsetReport } from './services/winnerUpsets';
import { withNflPrediction, nflQbWithout, nflRatings, nflTeamModel, nflTeamRecord, nflRecord, nflAccuracy, nflModelReport, retrain as nflRetrain, NFL_MODEL, NCAA_MODEL } from './services/nflModel';
import { leagueForecast, leagueView, visibleIds, teamForecastCodes, teamHistory, gameMeaning, seasonForecastAdmin, allLeagues, runSeasonForecast, runSeasonAccuracy, type FcSport, extremesFor } from './services/seasonForecast';
import { nflPublic, nflWeeks, nflWeekGames, nflGamesBetween, nflLiveGames, nflRecentResults, nflGame as nflGameB, nflStandings, nflTeam as nflTeamB, nflPlayer as nflPlayerB, nflLeaders, nflSeasonsHeld, allowedSeason, leagueOfTeamId, nflSearch, nflPlayerCareer, nflPlayerInjury, nflTeamRow } from './services/nflSite';
import { nflLiveNow, nflLiveCurve } from './services/nflLive';
import { nflSchedule, nflGameStandings, nflStarters, nflBeforeAfter, nflPreview, nflEvents, nflKeyPlayers } from './services/nflGameExtras';
import { askAssistant, assistantConfigured, messagesToday, assistantStats } from './services/assistant';
import { normalizeName } from './services/history';
import { markFresh, markFailed } from './services/freshness';
import { storedDataHealth } from './services/dataHealth';
import { gameExtras as gameExtrasB, teamExtras as teamExtrasB, gameExtrasAdmin, extrasTick } from './services/gameExtras';
import { pushSettings, savePushPrefs, addPushSub, removePushSub, PushError, pushAdminStats, sendTestPush } from './services/pushAlerts';
import { emailSettings, saveEmailPrefs, initEmailPrefs, EmailPrefsError, checkUnsub, unsubscribePicks, verifyWebhook, handleWebhookEvent, emailAdminStats, sendTestEmail, previewEmail, crestPath } from './services/pickEmails';
import { moreForGame as moreForGameB, moreRecord, moreHealth, gateList, backtestReports, backtestMarkdown, calcStatus, moreBacktestNow, MORE_SPORTS, gameIdOf, hasExtras, saveOne as saveOneB } from './services/morePredictions';
/*
 * fix210: the page builders — the web process never runs one (its routes pass these requests to the worker:
 * services/workerRoutes.ts); with SL_STRICT_WEB=1 (scripts/no-web-compute.test.mjs) a call in the web process throws
 */
const teamPage = builder('team page', teamPageB);
const searchPlayersRemote = builder('player search (provider)', searchPlayersRemoteB);
const playerPage = builder('player page', playerPageB);
const findPlayer = builder('player lookup', findPlayerB);
const newsFor = builder('news', newsForB);
const gameExtras = builder('game extras', gameExtrasB); // fix231
const teamExtras = builder('team extras', teamExtrasB);
const bbGame = builder('basketball game page', bbGameB);
const bbTeam = builder('basketball team page', bbTeamB);
const bbPlayer = builder('basketball player page', bbPlayerB);
const tennisMatch = builder('tennis match page', tennisMatchB);
const tennisTournament = builder('tennis tournament page', tennisTournamentB);
const tennisPlayer = builder('tennis player page', tennisPlayerB);
const seoPage = builder('crawler page', seoPageB);
const bbGameFacts = builder('basketball game facts (crawler page)', bbGameFactsB);
const todayGroups = builder('today lists', todayGroupsB);
const nflGame = builder('NFL game page', nflGameB);
const nflTeam = builder('NFL team page', nflTeamB);
const nflPlayer = builder('NFL player page', nflPlayerB);
const moreForGame = builder('more predictions (game)', moreForGameB);
const saveOne = builder('more predictions (save)', saveOneB);
import { resolveUnsettled, resolveUnsettledOnce, voidedGames, pendingLookups, Providers as SettleProviders, openSettleReviews, decideSettle, SettleError } from './services/unsettled';
import { afStatus, afTick, rebuildAfFeaturesAsync, afGet, afRemaining, xgCoverage, afQuota } from './services/apiFootball';
import { afSource, uaKey, notePageRequest, noteBlocked, afUsageToday, isCrawlerRequest, noProviderCalls, claimsCrawler, crawlerVerdict, crawlerCheck, costCapped } from './services/afUsage';
import { noteCrawlerResponse, inGoogleRanges, crawlerReport } from './services/crawlerIps';
import { botGate, isBotUa } from './services/botGate';
import { pageReaderStatus } from './services/pageReader';
import { createHash, randomBytes } from 'node:crypto';
import { leagueCoverage, pickForAdding } from './services/leagueCoverage';
import { addExtraLeague, removeExtraLeague, setExtraTrial } from './services/leagueConfig';
import { bbLeagueCoverage, bbPickForAdding } from './services/bbLeagueCoverage';
import { addBbExtraLeague, removeBbExtraLeague, setBbExtraTrial } from './services/bbLeagueConfig';
import {
  signup, login, loginNeedsCheck, changePassword, setPlan, adminResetPassword, listUsers, userStats, createSession, destroySession, userForToken,
  parseCookies, setSessionCookie, clearSessionCookie, SESSION_COOKIE, staffOf, permsOf, setRole, Staff, userById, checkPassword, sessionHash, startEmailChange, confirmEmailChange, accessOf, canSeeFull, isPaid, teaseDeep, teaseDeepExcept, AuthError, Access, User,
  sendVerification, verifyEmail, requestPasswordReset, resetPassword, setMarketingOptIn, usersCsv, verificationRequired, exportUserData, deleteAccount, cancelPlan, resumePlan, leaveFeedback
} from './services/auth';
import { playerDataStatus, teamPlayers } from './services/playerData';
import { MODEL_V3, modelV3Status, runBacktestV3, runBacktestV3All, backtestProgressV3, prepareModelV3, CONV, sweepV3, autoVariants, parseCompactVariants, sweepProgress, backfillV3, setRelOverride, SweepVariant, tuneLeaguesV3, leagueTuneProgress, leagueConvStatus, clearLeagueConv, tunedStatus, clearTuning, applyStoredTuning, prepareModelV3Async } from './services/gridModel';
import { noteGameView } from './services/gameViews';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// In development accept any local origin (Vite may switch ports, 127.0.0.1 vs localhost, etc.)
const allowedOrigins = (process.env.CORS_ORIGIN || (isDev ? 'http://localhost:3000' : 'https://sportlikely.com,https://www.sportlikely.com,https://bettobeat.com,https://www.bettobeat.com'))
  .split(',')
  .map(o => o.trim());
const corsOrigin = isDev ? true : allowedOrigins;

// Private beta credentials (see the gate below); empty password = open site
const SITE_USER = process.env.SITE_USER || '';
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const SITE_AUTH = SITE_PASSWORD ? 'Basic ' + Buffer.from(`${SITE_USER}:${SITE_PASSWORD}`).toString('base64') : '';
// Read token for maintenance: GET /api/...?token=<API_READ_TOKEN> passes the gate (pages and sockets stay locked)
const API_READ_TOKEN = process.env.API_READ_TOKEN || '';
// Job token: like the read token but it may also START maintenance jobs (syncs, backfills, backtests, the data check).
// Leave it unset normally; set it on Railway only while such work is being done, then remove it.
const API_JOB_TOKEN = process.env.API_JOB_TOKEN || '';
const tokenKind = (t: unknown): 'read' | 'job' | null =>
  typeof t === 'string' && t ? (API_JOB_TOKEN && t === API_JOB_TOKEN ? 'job' : API_READ_TOKEN && t === API_READ_TOKEN ? 'read' : null) : null;

// GET endpoints that DO something (start a job, spend API calls, change data). The read token may not call them,
// and a browser may not call them from another website (see the cross-site guard below).
const ACTION_GET = /^\/api\/(model\/v3\/player-quality\/rebuild|data-audit\/run|history\/(sync-season|refit|h2h-archive)|af\/(odds-backfill|sync|raw)|bb\/(sync|raw|bdl|injuries-refresh)|clv\/(tick|probe)|model\/v3\/(backfill|squad\/sync|league-tune|league-conv)|backtest\/(run|sweep)|model\/elo\/tune)$/;
const isActionGet = (req: express.Request) =>
  req.method === 'GET' && (ACTION_GET.test(req.path) || (req.path === '/api/team-overrides' && !!req.query.field));

const app = express();
// Middleware (CSP off: the site loads Google Fonts and club crests from other hosts)
// Railway terminates TLS in front of us: trust the first proxy so req.ip / req.secure are real
app.set('trust proxy', 1);
// fix140: bad bots get nothing (before every other middleware). ShapBot alone (~17 pages a minute on /team + /player)
// used up the API-Football quota on 16 Oct. Search engines (Googlebot, bingbot, Applebot, DuckDuckBot) stay allowed;
// the same list is disallowed in robots.txt.
const BAD_BOTS = /ShapBot|Bytespider|AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot/i;
app.use((req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (!BAD_BOTS.test(ua)) return next();
  noteBlocked(uaKey(ua));
  res.status(403).type('text/plain').send('Forbidden');
});
// fix245: a search engine is verified once per request, first by its published address list (services/crawlerIps.ts:
// works even when DNS fails and before the state loads), then by DNS; every request with a Google / Bing / Apple
// user-agent (and every one from Google's ranges) is counted with its answer — a 429 / 503 to Google = data health fail
if (!isWorker) app.use((req, res, next) => {
  const ua = req.get('user-agent') || '';
  if (claimsCrawler(ua)) {
    const c = crawlerCheck(req.ip, ua);
    (req as any).slCrawler = c;
    if (c.ok) (req as any).verifiedCrawler = true;
  }
  if (claimsCrawler(ua) || inGoogleRanges(req.ip)) res.once('finish', () => noteCrawlerResponse(uaKey(ua), req.ip, (req as any).slCrawler?.ok ? (req as any).slCrawler.how : null, res.statusCode, req.path));
  next();
});
/** fix245: this request is a search engine verified by its list or DNS (set by the middleware above) */
const isVerifiedCrawler = (req: express.Request) => !!(req as any).verifiedCrawler;
// fix202: with the worker on, admin / staff / maintenance requests (outside the public API) go to the worker, which
// holds the job state and runs the rebuilds; the web process keeps the public API, the pages and /api/perf
const WEB_ONLY_API = /^\/api\/(perf|draw-alerts|admin\/visitors)$/;
if (isWeb) app.use('/api', (req, res, next) => {
  const p = req.originalUrl.split('?')[0];
  // fix210b: a browser's error report is written by the worker (the web process writes nothing but sign-in / account)
  if (p === '/api/client-error') return forwardToWorker(req, res);
  if (OPEN_API.test(p) || WEB_ONLY_API.test(p)) return next();
  forwardToWorker(req, res);
});
// referrerPolicy: helmet's default "no-referrer" breaks embedded YouTube players (error 153 — YouTube needs the site's origin)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.use(cors({ origin: corsOrigin, credentials: true }));
// fix216: the Resend webhook is checked against its exact bytes (svix signature)
app.use(express.json({ verify: (req, _res, buf) => { if ((req as any).url?.startsWith('/api/webhooks/')) (req as any).rawBody = buf; } }));
// fix158: every API request in flight is a named job in /api/perf (a freeze inside a handler names its route).
// fix167: every request, not only /api (search-engine pages and sitemaps are built on this thread too)
app.use((req, res, next) => {
  const done = track(routeLabel(req.method, req.path), requestDetail(req.path, req.query as any));
  (res.locals as any).perfDone = done; // fix222: services/forward.ts marks a request passed on to the worker as waiting
  res.on('finish', done);
  res.on('close', done);
  next();
});
/*
 * fix250: the one-second rule (services/deadline.ts) — a public GET not answered after 900 ms gets { pending: true }
 * (a page: the plain app page) while the work goes on and its answer is kept for the next request; every public GET
 * over 1 s is counted (data health "Slow requests"). Here, before the start-up wait, so that wait is cut too.
 */
let appPageBuf: Buffer | null = null;
app.use(deadlineStart({
  isApi: p => p.startsWith('/api/') && OPEN_API.test(p) && !/^\/api\/(health$|client-error$|webhooks\/|assistant\/)/.test(p),
  sendAppPage: SITE_PASSWORD ? null : res => {
    try { appPageBuf ||= fs.readFileSync(path.join(STATIC_DIR, 'index.html')); } catch { return false; }
    res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-SL-Pending': '1' }).end(appPageBuf);
    return true;
  },
  label: req => routeLabel(req.method, req.path),
  crawler: req => isVerifiedCrawler(req)
}));
// Shadow models (featureModel.ts): feat-v1 always, and v3-mix until it is live (then grid-v3) never reach visitors —
// they are stored and compared in the admin views only
// fix182: displayed names (team / league / competition) never carry a betting sponsor ("Partizan Mozzart Bet" → "Partizan")
app.set('json replacer', (key: string, value: any) =>
  typeof value === 'string' ? (NAME_KEYS.has(key) && mayHaveSponsor(value) ? cleanName(value) : value)
  : key === 'predictions' && Array.isArray(value) && value.some(p => p && typeof p.model === 'string')
    ? (() => { const hide = hiddenModels(); return value.filter(p => !(p && hide.has(p.model))); })()
    : value);
app.use(express.urlencoded({ extended: true }));

// fix212b / fix218: the web process answers nothing before its shared state is loaded (it listens at once and loads
// after, so a deploy's health check gets this 503 instead of a refused connection): 503 + Retry-After, /health included.
// fix227: except the built site's files and the plain app page (services/earlyStatic.ts: they need no state) — the
// 503 on the app file left visitors on the crawler text; the 503 stays for /health and the API only. Behind the beta
// gate (SITE_PASSWORD) only the public files go early. Every 5xx in the first 5 minutes is counted (deployErrors.ts).
if (isWeb) app.use(deployErrorsMiddleware);
// fix238: the API during the load (9 × 503 "Starting up" on 25 Oct): a signed-out worker page gets its last kept copy at
// once, every other API request waits for the state (at most STARTUP_WAIT_MS) and is answered then — no 5xx. /health
// and the socket keep the 503 (Railway's health check must see "not ready").
const STARTUP_WAIT_MS = Number(process.env.STARTUP_WAIT_MS) || 30000;
const CRAWLER_STARTUP_WAIT_MS = Number(process.env.CRAWLER_STARTUP_WAIT_MS) || 120000;
if (isWeb) app.use(async (req, res, next) => {
  if (isReady()) return next();
  if (!needsState(req.path) && (!SITE_PASSWORD || req.path.startsWith('/assets/') || PUBLIC_FILES.has(req.path)) && serveEarly(req, res)) return;
  if (req.path.startsWith('/api/') && req.path !== '/api/health' && !SITE_PASSWORD) {
    const signedIn = !!req.get('authorization') || String(req.get('cookie') || '').includes(`${SESSION_COOKIE}=`);
    if (await sendStartupCopy(req, res, signedIn)) return;
    const t0 = Date.now();
    const tick = () => {
      if (isReady()) return next();
      if (res.writableEnded || req.destroyed) return;
      // fix245: a verified search engine waits longer (a 503 to Googlebot counts against the site's crawl health)
      if (Date.now() - t0 > (isVerifiedCrawler(req) ? CRAWLER_STARTUP_WAIT_MS : STARTUP_WAIT_MS)) return res.status(503).set('Retry-After', '5').set('Cache-Control', 'no-store').json({ error: 'Starting up', ready: false });
      setTimeout(tick, 100);
    };
    return tick();
  }
  res.status(503).set('Retry-After', '5').set('Cache-Control', 'no-store').json({ error: 'Starting up', ready: false });
});
// API responses are data, not pages: keep them out of search results (robots.txt stays open so tools can read them)
app.use('/api', (_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// fix214: in production a GET is counted, not logged line by line — a write to the log pipe blocks the loop when the
// host reads it slowly (crawler bursts: the 2.7 s web stalls); one summary line a minute. LOG_REQUESTS=1 = every line.
const LOG_EVERY_REQUEST = isDev || process.env.LOG_REQUESTS === '1';
const reqCounts = new Map<string, number>();
if (!LOG_EVERY_REQUEST) setInterval(() => {
  if (!reqCounts.size) return;
  const all = [...reqCounts.values()].reduce((a, b) => a + b, 0);
  const top = [...reqCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k.replace(/^http GET /, '')} ${n}`).join(', ');
  reqCounts.clear();
  logger.info(`GET requests (last minute): ${all} — ${top}`);
}, 60 * 1000).unref();
app.use((req, _res, next) => {
  if (!LOG_EVERY_REQUEST && req.method === 'GET') {
    const k = routeLabel('GET', req.path);
    if (reqCounts.has(k) || reqCounts.size < 500) reqCounts.set(k, (reqCounts.get(k) || 0) + 1);
    return next();
  }
  // fix205: a calendar link is a secret too: only its first 6 characters reach the log
  logger.info(`${req.method} ${req.originalUrl.replace(/([?&]token=)[^&]+/g, '$1***').replace(/^(\/cal\/[A-Za-z0-9_-]{6})[^/?]*/, '$1…')}`);
  next();
});

// ---------- One address: https://sportlikely.com ----------
// www.sportlikely.com and plain http go to the canonical https address (301), so links, cookies and search engines
// all use one host. Only requests for our own domain are touched (Railway's internal health checks are not).
const CANONICAL_HOST = process.env.CANONICAL_HOST || (isDev ? '' : 'sportlikely.com');
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = (req.hostname || '').toLowerCase();
    if (req.path === '/api/health' || !host.endsWith(CANONICAL_HOST)) return next();
    if (host !== CANONICAL_HOST || !req.secure) return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    next();
  });
}

// Public files that carry no data (icons, share image, robots, sitemap) stay reachable behind the beta gate
const PUBLIC_FILES = new Set(['/favicon.svg', '/apple-touch-icon.png', '/og-image.png', '/robots.txt', '/sitemap.xml', ...Object.keys(SITEMAPS).map(f => `/${f}`)]);

// ---------- Private beta gate ----------
// Set SITE_USER + SITE_PASSWORD (e.g. on Railway) and the whole site — pages and API — asks for them.
// Uses the browser's own login prompt, so it works on phones and is remembered per device.
// Health check stays open so the host can monitor the service. Unset = open site (local dev).
if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path === '/health' || PUBLIC_FILES.has(req.path) || req.path.startsWith('/fonts/') || req.path.startsWith('/cal/')) return next(); // fix205: the calendar link is its own key
    if (req.headers.authorization === SITE_AUTH) return next();
    if (req.method === 'GET' && req.path.startsWith('/api/') && tokenKind(req.query.token)) return next();
    res.set('WWW-Authenticate', 'Basic realm="SportLikely - private beta", charset="UTF-8"');
    res.status(401).send('Private beta. Sign in to continue.');
  });
  logger.info('Private beta gate enabled (SITE_USER / SITE_PASSWORD)');
}

// ---------- Accounts: who is asking, and what they may see ----------
// anon / free  → matches, leagues, teams (predictions trimmed to the pick)
// premium      → + full predictions, Accuracy page data
// admin        → everything (maintenance, backtests, syncs, user admin). ADMIN_EMAILS or the read token (GET only).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User | null;
      access?: Access;
      staff?: Staff;
      perms?: Set<Perm>;
    }
  }
}

app.use((req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let user: User | null = null;
  try {
    user = userForToken(cookies[SESSION_COOKIE]);
  } catch (e: any) {
    logger.warn('Session lookup failed', { message: e.message });
  }
  req.user = user;
  req.access = accessOf(user);
  req.staff = staffOf(user);
  req.perms = new Set(permsOf(user));
  // Maintenance tokens (GET only): admin reads, never the user data (/api/admin/*). The read token cannot start jobs.
  const kind = req.method === 'GET' ? tokenKind(req.query.token) : null;
  if (kind) {
    if (req.path.startsWith('/api/admin')) return _res.status(403).json({ error: 'Not allowed with a maintenance token' });
    if (kind === 'read' && isActionGet(req)) return _res.status(403).json({ error: 'The read token is read-only' });
    req.access = 'admin';
  }
  next();
});

// visitor counts for the admin page (hashed IPs only); fix210: in the web process only (the worker's requests came from it)
if (!isWorker) app.use('/api', trackVisit);
// keys are salted hashes (salt new at every start), so not even the memory holds a visitor's IP (fix140)
const RL_SALT = randomBytes(16).toString('hex');
const ipKey = (req: express.Request) => createHash('sha256').update(RL_SALT + (req.ip || 'unknown')).digest('hex').slice(0, 20);
// fix140: every API-Football call made while answering this request counts as "page" (own small budget, afUsage.ts)
// or "admin"; the user-agent is counted per day for the admin card (no IPs). fix166: search-engine crawlers are marked
// (team / player pages make no provider call for them; admin card splits visitors / crawlers).
// fix173: a crawler-looking user-agent counts as a crawler only once DNS confirms it (Google / Bing / Apple / Yandex);
// until then, or when the check fails, the request makes no provider call and every visitor limit applies. Every
// visitor's provider calls are counted per day (IP hash, user-agent hash, paid account): over the cap, the rest of the
// day runs on stored data only. One security-log line per key and day (IP there only, per the privacy rule).
const scraperLogged = { day: '', keys: new Set<string>() };
const logScraperOnce = (key: string, req: express.Request, detail: string) => {
  const d = new Date().toISOString().slice(0, 10);
  if (scraperLogged.day !== d) { scraperLogged.day = d; scraperLogged.keys.clear(); }
  if (scraperLogged.keys.has(key)) return;
  scraperLogged.keys.add(key);
  const country = (req.ip && countryOf(req.ip)) || 'unknown country';
  securityLog(req, 'scraper', req.user, `${detail}; ${country}`);
  logger.warn(`scraper: ${detail} (${country}; ${uaKey(req.get('user-agent')).slice(0, 120)})`);
};
const proxyLimiter = new ProxyLimiter();
/*
 * fix248c (step 5): who sends the HTML page renders — per hour, by user-agent family × network (AS name, or "other"
 * for an address outside the data-centre / proxy lists), verified search engine or not, and how many were refused.
 * /api/perf → htmlBy (this hour and the last). An unverified bot (a crawler / tool user-agent that is not a verified
 * search engine) gets the fix199 address limits on HTML from any network (botHtmlLimiter: 60 an hour, 300 a day per
 * address, 600 an hour per network); before, only data-centre / proxy addresses were counted.
 */
const botHtmlLimiter = new ProxyLimiter();
every('bot html limits cleanup', () => botHtmlLimiter.prune(), 5 * 60000).unref();
const UA_FAMILY = /(googlebot|google-inspectiontool|googleother|bingbot|applebot|yandexbot|duckduckbot|baiduspider|petalbot|bytespider|gptbot|claudebot|ccbot|amazonbot|perplexitybot|ahrefsbot|semrushbot|mj12bot|dotbot|dataforseobot|facebookexternalhit|twitterbot|slackbot|whatsapp|telegrambot|discordbot|headlesschrome|python-requests|python-urllib|aiohttp|scrapy|curl|wget|go-http-client|okhttp|java|node-fetch|axios|undici|[a-z0-9-]*bot\b|[a-z0-9-]*crawler|[a-z0-9-]*spider|edg|opr|firefox|chrome|crios|safari)/i;
const uaFamily = (ua: string | undefined) => {
  if (!ua) return '(none)';
  const m = UA_FAMILY.exec(ua);
  const f = m ? m[1].toLowerCase() : 'other';
  return f === 'edg' ? 'edge' : f === 'opr' ? 'opera' : f === 'crios' ? 'chrome' : f;
};
const htmlHours: { hour: number; by: Map<string, { n: number; refused: number }> }[] = [];
function noteHtml(req: express.Request, verified: boolean, refused = false) {
  const hour = Math.floor(Date.now() / 3600000);
  let b = htmlHours[htmlHours.length - 1];
  if (!b || b.hour !== hour) { htmlHours.push((b = { hour, by: new Map() })); if (htmlHours.length > 2) htmlHours.shift(); }
  const ua = req.get('user-agent');
  const nw = req.ip ? networkOf(req.ip) : null;
  const k = `${uaFamily(ua)} · ${nw ? nw.name.slice(0, 40) : 'other'}${isBotUa(ua) ? (verified ? ' · verified' : ' · unverified bot') : ''}`;
  const e = b.by.get(k) || { n: 0, refused: 0 };
  e.n++; if (refused) e.refused++;
  b.by.set(k, e);
  if (b.by.size > 500) b.by.delete(b.by.keys().next().value as string);
}
const htmlByStatus = () => htmlHours.map(b => {
  const rows = [...b.by].sort((x, y) => y[1].n - x[1].n);
  return { hour: new Date(b.hour * 3600000).toISOString().slice(0, 13), total: rows.reduce((t, [, e]) => t + e.n, 0), top: rows.slice(0, 25).map(([k, e]) => ({ who: k, renders: e.n, refused: e.refused })) };
}).reverse();
const uaHash = (ua: string) => createHash('sha256').update(RL_SALT + ua).digest('hex').slice(0, 20);
// fix244: the Quick-check pass (cookie sl_pass) is signed with a key made from the Turnstile secret (no pass without Turnstile)
let passKeyOf: { secret: string; key: Buffer } | null = null;
const passKey = (): Buffer | null => {
  const secret = turnstileSiteKey() ? process.env.TURNSTILE_SECRET || '' : '';
  if (!secret) return null;
  if (passKeyOf?.secret !== secret) passKeyOf = { secret, key: createHash('sha256').update(`sl-pass|${secret}`).digest() };
  return passKeyOf.key;
};
const passOf = (req: express.Request, ua: string) => {
  const key = passKey(), tok = key ? parseCookies(req.headers.cookie)[PASS_COOKIE] : null;
  return key && tok ? readPass(key, tok, ua, Date.now()) : null;
};
app.use('/api', (req, _res, next) => {
  const ua = uaKey(req.get('user-agent'));
  if (req.access === 'admin') return afSource.run({ kind: 'admin', ua }, next);
  const ipH = ipKey(req);
  const claims = claimsCrawler(ua);
  const verdict = claims ? ((req as any).slCrawler?.ok ?? crawlerVerdict(req.ip, ua)) : false; // fix245: list, then DNS
  const crawler = verdict === true;
  (req as any).verifiedCrawler = crawler;
  (req as any).crawlerClaim = claims ? verdict === true : null; // fix183: the visitor counter's crawler check
  // fix210: counted once, in the web process (a request the worker answers was counted there before it was passed on)
  if (!isWorker) notePageRequest(ua, crawler);
  // fix199: a data-centre / proxy address (asn.ts) — stored data only, tight limits, one Security-log line per network
  const nw = req.ip ? networkOf(req.ip) : null;
  if (!isWorker) noteWho(ua, !!nw, crawler);
  const proxy = !!nw && proxyApplies({ network: true, admin: false, verifiedCrawler: crawler, verifiedAccount: !!req.user?.emailVerified });
  (req as any).proxyAnon = proxy && !req.user;
  const fake = claims && verdict === false;
  if (fake && !nw) logScraperOnce(`fake:${ipH}`, req, 'crawler user-agent from an address that is not the search engine (DNS check failed): stored data only');
  const paid = req.access === 'premium' || req.access === 'pro';
  const keys = { ip: ipH, ua: uaHash(ua), user: paid && req.user ? String(req.user.id) : null };
  const cap = costCapped(keys);
  if (cap && !nw) logScraperOnce(`cap:${cap.key}:${cap.key === 'ip' ? ipH : cap.key === 'ua' ? keys.ua : keys.user}`, req,
    `provider-cost cap: ${cap.calls} provider calls today by this ${cap.key === 'ip' ? 'address' : cap.key === 'ua' ? 'user-agent' : 'account'} (cap ${cap.cap}): stored data only until midnight UTC`);
  // fix244: page views per address (X-SL-View), a browser that passed the Quick check only its own pass limit
  const pass = proxy && !isWorker ? passOf(req, ua) : null;
  const refused = !isWorker && proxy && countedRead(req.method, req.originalUrl.split('?')[0])
    ? proxyLimiter.hit(ipH, nw!.asn, { view: viewIdOf(req.get('x-sl-view')), pass: pass?.ok ? pass.id : null }) : null;
  if (nw && !isWorker) noteNetworkRequest(nw, ipH, req.ip || '', ua, { refused: refused?.scope, capped: !!cap, fakeCrawler: fake, verified: crawler, exempt: !proxy && !crawler, passed: !!pass?.ok, passRefused: refused && pass ? pass.id : null });
  if (refused) {
    _res.set('Retry-After', String(refused.retryAfter));
    // check: the app opens the Quick check (a pass that reached its own limit: the plain message)
    return _res.status(429).json({ error: 'Too many pages opened from this network. Please try again later, or sign in.', proxy: true, check: !!passKey() && refused.scope !== 'pass-hour' });
  }
  afSource.run({ kind: 'page', ua, crawler, keys, ...(cap || (claims && !crawler) || proxy ? { offline: true } : {}) }, next);
});
every('proxy limits cleanup', () => proxyLimiter.prune(), 5 * 60000).unref();
/** fix166: team / player pages of every sport make no provider call for a crawler (stored or database data only). */
const crawlerSafe = <T>(fn: () => T): T => (isCrawlerRequest() ? noProviderCalls(fn) : fn());

// No bookmakers on the site (Oct 2026): odds, bookmaker names and market comparisons are internal data only.
// For everyone except admins, every API response is cleaned of them before it leaves the server.
const MARKET_KEYS = new Set(['odds', 'bookmaker', 'books', 'clv', 'price', 'bestPrice', 'marketDraw', 'marketHit', 'marketHits', 'marketN', 'marketHitRate', 'bookmakers', 'roi', 'msw', 'overround']);
function stripMarket(x: any, depth = 0): any {
  if (depth > 12 || x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(v => stripMarket(v, depth + 1));
  if (x instanceof Date) return x;
  const out: any = {};
  for (const [k, v] of Object.entries(x)) {
    if (MARKET_KEYS.has(k)) continue;
    // "market" as an object / number / null is bookmaker data; as a string it is a bet type ("double chance")
    if (k === 'market' && typeof v !== 'string') continue;
    out[k] = stripMarket(v, depth + 1);
  }
  return out;
}
app.use('/api', (req, res, next) => {
  if (req.access === 'admin') return next();
  // fix172: our own plan / pick-pack prices are not bookmaker data ("price" was stripped: /premium crashed for visitors)
  if (/^\/(billing|unlocks)(\/|$)/.test(req.path)) return next();
  const json = res.json.bind(res);
  res.json = (body: any) => json(stripMarket(body));
  next();
});

/*
 * fix202: stored pages (services/pageCache.ts): built by the worker, sent as they are. Each page keeps ready-made
 * strings of its common views beside it, so most requests only send text: 'anon' (signed out: bookmaker data stripped,
 * match predictions trimmed to the pick), 'full' (what every other non-admin sees: bookmaker data stripped), or a
 * page's own ('public' …). Admins, members with unlocked games (per-member trims) and data-centre visitors get the
 * stored page through res.json, so the per-request trims above and below apply as before.
 * fix221: the web process only sends strings. Every view has its ETag (304 when unchanged) and a gzip copy, both made by
 * the worker. The big lists (football upcoming, basketball games) are also stored row by row: a member with unlocked
 * games and a data-centre visitor get their copy joined from those strings. Anything else that would need the page
 * itself (admins, a view not stored) is passed to the worker — the web process never parses or serialises a page.
 */
const jsonText = (x: unknown) => JSON.stringify(x, app.get('json replacer'));
const VIEWS_PLAIN = { full: (b: any) => jsonText(stripMarket(b)) };
const VIEWS_MATCHES = { anon: (b: any) => jsonText(stripMarket(teaseDeep(b))), full: (b: any) => jsonText(stripMarket(b)) };
const ROWS_MARK = '\u0003rows';
/**
 * fix221: a list page ({ ..., [key]: rows }) as row strings: full (bookmaker data stripped), teased (`tease`, default the
 * football trim) and locked for data-centre visitors (lockAllPredictions: finished games too)
 */
async function listRows(body: any, opts: { key?: string; id?: (row: any) => number; full?: (row: any) => any; tease?: (row: any) => any } = {}): Promise<Rows> {
  const key = opts.key || 'data';
  const list: any[] = Array.isArray(body?.[key]) ? body[key] : [];
  const shell = jsonText(stripMarket({ ...body, [key]: ROWS_MARK }));
  const at = shell.indexOf(JSON.stringify(ROWS_MARK));
  const rows: Rows['rows'] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const full = jsonText(stripMarket(opts.full ? opts.full(r) : r));
    const teasedRow = opts.tease ? opts.tease(r) : teaseDeep(r);
    const tease = jsonText(stripMarket(teasedRow));
    const locked = jsonText(stripMarket(lockAllPredictions(teasedRow)));
    rows.push({ id: opts.id ? opts.id(r) : Number(r?.id), full, tease: tease === full ? undefined : tease, locked: locked === tease ? undefined : locked });
    if (i % 100 === 99) await yieldLoop();
  }
  return { head: `${shell.slice(0, at)}[`, tail: `]${shell.slice(at + JSON.stringify(ROWS_MARK).length)}`, rows };
}
/** the stored view for a match list (/api/matches/*): null = send the page through res.json */
const matchView = (req: express.Request) => {
  const access = req.access || 'anon';
  return access === 'admin' ? null : !req.user && access === 'anon' ? 'anon' : canSeeFull(access) ? 'full' : null;
};
/** the stored view for any other page: everyone but admins gets the same copy */
const plainView = (req: express.Request) => (req.access === 'admin' ? null : 'full');
/** fix221: one stored string as it is: ETag (304 when the browser has it), gzip copy when the browser takes gzip */
function sendView(req: express.Request, res: express.Response, v: View) {
  res.set('ETag', v.etag).vary('Accept-Encoding').type('application/json');
  if (req.fresh) return res.status(304).end();
  if (v.gz && req.acceptsEncodings('gzip') === 'gzip') return res.set('Content-Encoding', 'gzip').send(v.gz);
  res.send(v.text);
}
/**
 * fix222: a list joined for one reader (a member's unlocks, a data-centre visitor's locked rows) has no stored gzip copy:
 * over 16 KB it is compressed in zlib's thread pool (the main thread only hands it over), else sent as it is.
 */
function sendJoined(req: express.Request, res: express.Response, text: string) {
  res.type('application/json').vary('Accept-Encoding');
  if (text.length < 16 * 1024 || req.acceptsEncodings('gzip') !== 'gzip') return res.send(text);
  zlib.gzip(text, { level: 1 }, (err, gz) => {
    if (res.headersSent || res.writableEnded) return;
    if (err) return res.send(text);
    res.set('Content-Encoding', 'gzip').send(gz);
  });
}
/** fix221: the web process never builds a page itself: what needs the page (not a stored string) is answered by the worker */
const byWorker = (req: express.Request, res: express.Response, here: () => unknown) => (isWeb ? forwardToWorker(req, res) : here());
/**
 * A stored page. `view`: the stored string to send (null = the page through res.json: admins). `keep` (fix221): a
 * member's unlocked ids (row ids) — the list joined from its rows, those games in full, the rest teased.
 */
const STORED_WAIT_MS = Number(process.env.STORED_WAIT_MS) || 600;
async function sendStored(req: express.Request, res: express.Response, name: string, q: Query, view: string | null, keep?: Set<number>) {
  // fix222: each phase is its own perf entry ("stored bb-games: read / pick / send"), so a stall names the phase
  const read = track(`stored ${name}: read`);
  let s: Awaited<ReturnType<typeof getPage>>;
  // fix243: the views this request sends are read in the reader thread, never on the web thread (pageCache prefetch)
  const views = (req as any).proxyAnon ? ['rows', ...(view ? [view] : [])] : keep?.size ? ['rows'] : view ? [view] : [];
  // fix248: the 'full' ETag (304 check of a member's copy) is read there too
  // fix250: a visitor waits at most 600 ms for a first build (then { pending: true }; the worker stores it meanwhile)
  try { s = await getPage(name, q, { views, etags: !(req as any).proxyAnon && keep?.size ? ['full'] : undefined, waitMs: isVerifiedCrawler(req) ? undefined : STORED_WAIT_MS }); } finally { read(); }
  // fix232: counted in data health "Errors during the last deploy" (target 0 after the first 60 s)
  // fix245: a verified search engine never gets this 503: the worker builds the page now and answers
  if (!s && isWeb && isVerifiedCrawler(req)) return forwardToWorker(req, res);
  if (!s) { noteLoading(req.path); return res.status(202).set({ 'Cache-Control': 'no-store', 'X-SL-Pending': '1' }).json({ pending: true, data: null }); }
  // fix232: when this copy was built (after a restart: the last copy stored before it, until the worker has a new one)
  res.set('X-SL-Built-At', new Date(s.builtAt).toISOString());
  if (s.staleS) res.set('X-SL-Stale', String(s.staleS)); // fix250: older than the page's freshness (a new one is being built)
  const pick = track(`stored ${name}: pick`);
  try { return sendStoredPick(req, res, s, view, keep, name); } finally { pick(); }
}
function sendStoredPick(req: express.Request, res: express.Response, s: NonNullable<Awaited<ReturnType<typeof getPage>>>, view: string | null, keep: Set<number> | undefined, name: string) {
  const send = (f: () => unknown) => { const d = track(`stored ${name}: send`); try { return f(); } finally { d(); } };
  // fix199: a signed-out visitor from a data-centre network gets no prediction at all (finished games too)
  if ((req as any).proxyAnon) {
    const r = s.rows();
    if (r) { const text = joinRows(r, () => 'locked'); return send(() => sendJoined(req, res, text)); }
    const text = view ? s.variant(view) : undefined;
    return text !== undefined && text.length < 256 * 1024 ? res.json(JSON.parse(text)) : byWorker(req, res, () => res.json(s.body));
  }
  if (keep?.size) {
    const r = s.rows();
    if (!r) return byWorker(req, res, () => res.json(s.body));
    // (fix222: the ETag without reading the whole 'full' view's text and gzip: s.etagOf)
    const base = s.etagOf('full') || String(s.builtAt);
    res.set('ETag', `${base.slice(0, -1)}-${etagOf([...keep].sort((a, b) => a - b).join(',')).slice(1, 9)}"`).vary('Accept-Encoding');
    if (req.fresh) return res.status(304).end();
    const text = joinRows(r, id => (keep.has(id) ? 'full' : 'tease'));
    return send(() => sendJoined(req, res, text));
  }
  const v = view ? s.view(view) : undefined;
  if (!v) return byWorker(req, res, () => res.json(s.body));
  send(() => sendView(req, res, v));
}

// Cross-site guard: another website may not make a signed-in browser change anything here (POST / PUT / DELETE, or a
// GET that starts a job). Browsers send Sec-Fetch-Site; typed URLs are "none", our own pages "same-origin".
app.use('/api', (req, res, next) => {
  const site = req.get('sec-fetch-site');
  if (site === 'cross-site' && (req.method !== 'GET' || isActionGet(req))) return res.status(403).json({ error: 'Cross-site request blocked' });
  next();
});

// Rate limits (per visitor; admins exempt). In memory: fine for one server.
const buckets = new Map<string, { n: number; reset: number }>();
every('rate-limit cleanup', () => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60000).unref();
function rateLimit(name: string, max: number | ((req: express.Request) => number), windowMs: number, key: (req: express.Request) => string = ipKey) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // fix245: a verified search engine is never counted (its renderer's /api reads: ~48k in 15 days)
    // fix250: a game bundle's own reads (services/gameBundle.ts) were counted when the visitor asked for the bundle
    if (req.access === 'admin' || isVerifiedCrawler(req) || isBundleCall(req.headers)) return next();
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    const b = buckets.get(k);
    if (!b || b.reset < now) buckets.set(k, { n: 1, reset: now + windowMs });
    else if (++b.n > (typeof max === 'number' ? max : max(req))) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: windowMs >= 3600000 ? 'Too many pages opened today. Please try again tomorrow.' : 'Too many requests. Please slow down and try again in a minute.' });
    }
    next();
  };
}
app.use('/api', rateLimit('api', 600, 60000)); // ~10 a second, far above a person browsing
// team / player pages can cost API-Football calls the first time: 60 page opens per 10 minutes per visitor
app.use(['/api/team-page', '/api/player-page'], rateLimit('pages', 60, 10 * 60000));
// fix140: pages that can cost API-Football calls: at most 60 requests a minute per visitor
app.use(['/api/team-page', '/api/player-page', '/api/search'], rateLimit('page-min', 60, 60000));
// fix173: pages a scraper walks (team / player / search / match details): 400 a day per address, 2,000 for paid
// members; search engines that passed the DNS check are not counted (they make no provider calls)
const dayPages = rateLimit('day-pages', req => (req.access === 'premium' || req.access === 'pro' ? 2000 : 400), 24 * 3600000);
app.use(['/api/team-page', '/api/player-page', '/api/search', /^\/api\/matches\/\d+\/details/, /^\/api\/game-bundle\/football\//], (req, res, next) => ((req as any).verifiedCrawler || isBundleCall(req.headers) ? next() : dayPages(req, res, next)));
app.use('/api/unlocks', (req, res, next) => (req.method === 'POST' ? rateLimit('unlock', 30, 60000, r => String(r.user?.id || ipKey(r)))(req, res, next) : next()));

const OPEN_API = /^\/api\/(health$|visit\/seen$|auth\/|waitlist$|contact$|feedback$|client-error$|picks(\/|$)|testers\/|unsubscribe$|email\/(settings|unsubscribe)$|push\/(settings|subscribe|unsubscribe)$|webhooks\/resend$|favorites(\/|$)|assistant(\/|$)|matches(\/|$)|leagues(\/|$)|teams\/|team-page\/|player-page\/|search$|news$|today$|guides(\/|$)|how-it-works\/|season-forecast\/|extras\/|game-bundle\/|changelog$|hub(\/|$)|slugs\/|slug\/|slug-of\/|slug-route$|basketball\/|nfl\/|tennis\/|more\/|public\/(summary|results|record|geo-source|photo-credits)$|unlocks(\/|$)|billing\/)/;
const PREMIUM_GET_API = /^\/api\/(accuracy(\/recent|\/status)?|history\/status|clv|draw-alerts|upset-watch)$/; // past seasons and backtests are admin only (Oct 2026)

app.use('/api', (req, res, next) => {
  const p = req.originalUrl.split('?')[0];
  const access = req.access || 'anon';
  // fix199: signed out from a data-centre / proxy network: no prediction at all, finished games too (every sport) —
  // the game pages show the "Create a free account" prompt
  if ((req as any).proxyAnon) {
    const json = res.json.bind(res);
    res.json = (body: any) => json(lockAllPredictions(body));
  }
  if (OPEN_API.test(p)) {
    // Trim predictions: anonymous and free users see the pick only; $15 Premium sees unlocked and finished matches in full
    if (!canSeeFull(access) && p.startsWith('/api/matches')) {
      const json = res.json.bind(res);
      // signed-in Free users and $15 Premium users see what they unlocked
      if ((access === 'premium' || access === 'free') && req.user) {
        const ids = unlockedIds(req.user.id);
        res.json = (body: any) => json(teaseDeepExcept(body, (id, status) => ids.has(id) || isFinished(status)));
      } else res.json = (body: any) => json(teaseDeep(body));
    }
    return next();
  }
  if (access === 'admin') return next();
  // CRM: any staff member (each route checks its own permission)
  if (p.startsWith('/api/crm/') && req.perms?.size) return next();
  // 'Model & data' permission: read-only statistics (GET, no jobs, nothing under /api/admin)
  if (req.perms?.has('model') && req.method === 'GET' && !p.startsWith('/api/admin') && !isActionGet(req)
      && !['sync', 'apply', 'run', 'reload', 'clear', 'tune'].some(k => req.query[k] !== undefined)) return next();
  if (req.method === 'GET' && PREMIUM_GET_API.test(p)) {
    // draw alerts are a Pro feature; the rest is open to every paid plan
    const proOnly = p.startsWith('/api/draw-alerts') || p.startsWith('/api/upset-watch');
    if (proOnly ? access === 'pro' : isPaid(access)) return next();
    return res.status(access === 'anon' ? 401 : 402).json({ error: access === 'anon' ? 'Sign in required' : proOnly ? 'Pro required' : 'Premium required', premium: true, pro: proOnly });
  }
  return res.status(access === 'anon' ? 401 : 403).json({ error: 'Not allowed' });
});

// fix210: the public routes that build a page (match / team / player / game pages, news, today, more predictions … of
// every sport) are answered by the worker; signed-out copies are kept here (services/workerRoutes.ts)
// fix250: a public answer kept after the 900 ms cut (services/deadline.ts) is sent at once, refreshed in the background
app.use(lateCopy);
app.use(workerRoutes);

// Staff console login (services/staffConsole.ts): the CRM and the Users/admin area need a second, separate sign-in once
// per session. Console endpoints themselves (/api/crm/console/*) and maintenance tokens (which can't reach these) excluded.
const tokenHashOf = (req: express.Request) => { const t = parseCookies(req.headers.cookie)[SESSION_COOKIE]; return t ? sessionHash(t) : ''; };
app.use(['/api/crm', '/api/admin'], (req, res, next) => {
  if (req.path.startsWith('/console/') || req.path === '/console') return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (!sessionUnlocked(tokenHashOf(req))) return res.status(423).json({ error: 'Sign in to the staff console first.', console: 'locked' });
  if (consoleRow(req.user.id)?.must_change) return res.status(423).json({ error: 'Change your console password first.', console: 'change' });
  next();
});
// Staff activity log (services/activity.ts): every successful staff action in the CRM / Users area is recorded
app.use(['/api/crm', '/api/admin'], (req, res, next) => {
  res.on('finish', () => { if (res.statusCode < 400) recordActivity(req as any); });
  next();
});

function authFail(res: express.Response, e: any) {
  if (e instanceof AuthError || e instanceof TwoFactorError) return res.status(e.status).json({ error: e.message });
  logger.error('Auth error', { message: e?.message });
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

function sessionPayload(user: User | null) {
  let tester: { until: string } | null = null;
  try { tester = user ? testerOf(user.id) : null; } catch { /* table not ready */ }
  return { user, access: accessOf(user), staff: staffOf(user), perms: permsOf(user), tester, verificationRequired };
}

// Only JSON bodies on auth POSTs (with SameSite=Lax cookies this blocks cross-site form posts)
function jsonOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
  next();
}

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Keep the browser cookie in step with the sliding session (30 days from the last visit)
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (req.user && token) setSessionCookie(res, token, new Date(Date.now() + 30 * 86400000), req.secure);
  res.json(sessionPayload(req.user || null));
});

// fix168: the sign-up form's config (Turnstile site key when it is on) and its signed "shown at" token
app.get('/api/auth/config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ turnstileSiteKey: turnstileSiteKey() });
});
// fix244: the Quick check passed (Cloudflare Turnstile) → the signed pass for this browser (24 h, its user-agent)
app.post('/api/auth/quick-check', jsonOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = passKey();
  if (!key) return res.status(404).json({ error: 'Not available' });
  if (!(await turnstileOk(req.body?.token, req.ip || ''))) return res.status(400).json({ error: 'Please try again' });
  const ua = uaKey(req.get('user-agent'));
  res.cookie(PASS_COOKIE, makePass(key, ua, Date.now(), randomBytes(12).toString('base64url')), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: PASS_MS, path: '/' });
  const nw = req.ip ? networkOf(req.ip) : null;
  if (nw) notePassed(nw, ipKey(req), req.ip || '', ua);
  res.json({ ok: true });
});
app.get('/api/auth/signup-token', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ token: signupToken() });
});

app.post('/api/auth/signup', jsonOnly, async (req, res) => {
  try {
    // fix168: the hidden "website" field filled in = a bot: the normal answer, nothing created
    if (honeypotHit(req.body)) {
      logger.info('signup honeypot');
      securityLog(req, 'signup_honeypot', { email: String(req.body?.email || '').trim().slice(0, 254) || null });
      return res.status(201).json({ user: null, codeSent: true });
    }
    const why = checkSignupToken(req.body?.formToken);
    if (why) { logger.info(`signup refused: ${why}`); return res.status(400).json({ error: 'Please try again' }); }
    if (!(await turnstileOk(req.body?.turnstile, req.ip || ''))) return res.status(400).json({ error: 'Please try again', captcha: true });
    const user = signup(req.body?.email, req.body?.password, req.body?.name, req.ip || '', req.body?.optIn === true, req.body?.adult === true);
    securityLog(req, 'signup', user); // the network, for the CRM trust grade (security log, 90 days)
    // fix216: the picks emails' time zone and language from the browser; the switches follow the (unchecked) opt-in box
    try { initEmailPrefs(user.id, { optIn: req.body?.picksOptIn === true, tz: req.body?.tz, lang: req.body?.lang }); }
    catch (e: any) { logger.warn('Email settings not saved at sign-up', { message: e?.message }); }
    void checkSignupSurge();
    const s = createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, s.token, s.expires, req.secure);
    // Send the confirmation code; if the email fails the account still exists and the code can be re-sent
    let codeSent = false;
    try {
      await sendVerification(user);
      codeSent = verificationRequired;
    } catch (e: any) {
      logger.warn('Verification email not sent at sign-up', { message: e?.message });
    }
    res.status(201).json({ ...sessionPayload(user), codeSent });
  } catch (e) {
    authFail(res, e);
  }
});

app.post('/api/auth/verify', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    res.json(sessionPayload({ ...verifyEmail(req.user, req.body?.code), mfa: req.user.mfa }));
  } catch (e) {
    authFail(res, e);
  }
});

app.post('/api/auth/verify/resend', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    await sendVerification(req.user);
    res.json({ ok: true });
  } catch (e) {
    authFail(res, e);
  }
});

app.post('/api/auth/forgot', jsonOnly, async (req, res) => {
  try {
    await requestPasswordReset(req.body?.email, req.ip || '');
    res.json({ ok: true });
  } catch (e) {
    authFail(res, e);
  }
});

app.post('/api/auth/reset', jsonOnly, (req, res) => {
  try {
    const user = resetPassword(req.body?.email, req.body?.code, req.body?.password, req.ip || '');
    securityLog(req, 'password_reset', user);
    // a new password does not skip two-step login
    if (twoFactorEnabled(user.id)) return res.json({ twoFactor: true, ticket: issueTicket(user.id) });
    const s = createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, s.token, s.expires, req.secure);
    res.json(sessionPayload(user));
  } catch (e) {
    authFail(res, e);
  }
});

app.post('/api/auth/preferences', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    res.json(sessionPayload({ ...setMarketingOptIn(req.user.id, req.body?.optIn === true), mfa: req.user.mfa }));
  } catch (e) {
    authFail(res, e);
  }
});

// AI chat (signed-in users). Body: { messages: [{role, content}], matchId?, page? }
app.use('/api/assistant', (req, res, next) => (req.method === 'POST' ? rateLimit('assistant', 20, 60000, r => String(r.user?.id || ipKey(r)))(req, res, next) : next()));
const ASSISTANT_DAILY_CAP = parseInt(process.env.ASSISTANT_DAILY_CAP || '300', 10);
app.get('/api/assistant/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: { available: assistantConfigured(), signedIn: !!req.user } });
});
app.post('/api/assistant/chat', jsonOnly, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to chat with the assistant' });
  if (!assistantConfigured()) return res.status(503).json({ error: 'The assistant is not available yet' });
  if (messagesToday(req.user.id) >= ASSISTANT_DAILY_CAP) return res.status(429).json({ error: `That is a lot of questions for one day (${ASSISTANT_DAILY_CAP}). Please come back tomorrow.` });
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    const matchId = Number(req.body?.matchId) || null;
    let matchDetails: any = null, fullPrediction = false;
    if (matchId) {
      try {
        matchDetails = isAfMatchId(matchId) ? await getAfMatchDetails(matchId) : await footballDataAPI.getMatchDetails(matchId);
        const status = matchDetails?.match?.status || '';
        fullPrediction = canSeeFull(req.access || 'anon') || isFinished(status) || unlockedIds(req.user.id).has(matchId);
      } catch (e: any) {
        logger.warn(`assistant match context ${matchId}: ${e.message}`);
      }
    }
    const out = await askAssistant({ userId: req.user.id, access: req.access || 'free', messages, matchId, matchDetails, fullPrediction, page: typeof req.body?.page === 'string' ? req.body.page.slice(0, 120) : null });
    res.json({ data: out });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message || 'The assistant could not answer' });
  }
});
app.get('/api/admin/assistant', (_req, res) => res.json({ data: assistantStats() }));

// Favorites (signed-in users; visitors keep them in the browser and they are merged here on sign-in)
// Your picks + personal record (every signed-in account) — services/userPicks.ts
const pickErr = (res: express.Response, e: any) => e instanceof PickError ? res.status(e.status).json({ error: e.message }) : sendError(res, e, 'Picks failed');
app.get('/api/picks/game/:sport(fb|bb|nfl)/:id(\\d+)', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: { signedIn: !!req.user, ...gamePicks(req.user?.id ?? null, req.params.sport, parseInt(req.params.id, 10), req.access || 'anon') } }); }
  catch (e: any) { pickErr(res, e); }
});
app.post('/api/picks', rateLimit('picks', 120, 60000, r => String(r.user?.id || ipKey(r))), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to make your own picks.' });
  try {
    const b = req.body || {};
    const pick = b.pick === null || b.pick === undefined || b.pick === '' ? null : String(b.pick);
    res.json({ data: { signedIn: true, ...setPick(req.user.id, String(b.sport), parseInt(String(b.id), 10), String(b.market), pick, req.access || 'anon') } });
  } catch (e: any) { pickErr(res, e); }
});
app.get('/api/picks/record', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Sign in to see your record.' });
  try { res.json({ data: personalRecord(req.user.id, req.access || 'anon') }); } catch (e: any) { pickErr(res, e); }
});
app.get('/api/favorites', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ data: listFavorites(req.user.id) });
});
app.post('/api/favorites', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  res.json({ data: addFavorites(req.user.id, items), max: MAX_FAVORITES });
});
app.post('/api/favorites/remove', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ data: removeFavorite(req.user.id, req.body?.kind, req.body?.ref) });
});

// fix205: calendar subscription (services/calendar.ts). The signed-in user's private link (made the first time,
// ?lang= = the site language the file's words follow); "Reset link" makes a new one and the old stops at once.
const calSite = (req: express.Request) => (CANONICAL_HOST ? `https://${CANONICAL_HOST}` : `${req.protocol}://${req.get('host')}`);
const calOut = (req: express.Request, token: string, createdAt: string, lastUsedAt: string | null) => {
  const ics = `${calSite(req)}/cal/${token}.ics`;
  const webcal = ics.replace(/^https?:/, 'webcal:');
  return { url: ics, webcal, google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`, createdAt, lastUsedAt };
};
app.get('/api/favorites/calendar', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Sign in to get your calendar.' });
  const c = calendarToken(req.user.id, req.query.lang ? asCalLang(req.query.lang) : undefined);
  if (c.created) securityLog(req, 'calendar_link_created', req.user, `calendar link ${tokenHint(c.token)}`);
  res.json({ data: calOut(req, c.token, c.createdAt, c.lastUsedAt) });
});
app.post('/api/favorites/calendar/reset', rateLimit('cal-reset', 10, 3600000, r => String(r.user?.id || ipKey(r))), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to get your calendar.' });
  const token = resetCalendarToken(req.user.id, req.body?.lang ? asCalLang(req.body.lang) : undefined);
  securityLog(req, 'calendar_link_reset', req.user, `new calendar link ${tokenHint(token)}; the old link no longer works`);
  res.json({ data: calOut(req, token, new Date().toISOString(), null) });
});
// The file itself: no login (the link is the key), 60 requests an hour per link
const calKey = (r: express.Request) => createHash('sha256').update(String(r.params[0] || '')).digest('hex').slice(0, 20);
app.get(/^\/cal\/([A-Za-z0-9_-]{32})\.ics$/, rateLimit('cal', 60, 3600000, calKey), (req, res) => {
  const token = String(req.params[0] || '');
  res.set('Cache-Control', 'private, max-age=900');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  try {
    const body = TOKEN_RE.test(token) ? calendarIcs(token, calSite(req)) : null;
    if (!body) return res.status(404).type('text/plain').send('This calendar link is not valid any more. Get your link on sportlikely.com/account.');
    res.type('text/calendar; charset=utf-8').set('Content-Disposition', 'inline; filename="sportlikely.ics"').send(body);
  } catch (e: any) {
    logger.warn(`calendar ${tokenHint(token)}: ${e.message}`);
    res.status(500).type('text/plain').send('The calendar could not be made right now. Try again later.');
  }
});

// ---------- Staff console login ----------
const consoleFail = (res: express.Response, e: any) => (e instanceof ConsoleError ? res.status(e.status).json({ error: e.message }) : authFail(res, e));
app.get('/api/crm/console/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const row = consoleRow(req.user!.id);
  res.json({ data: { hasLogin: !!row, username: row?.username || null, unlocked: sessionUnlocked(tokenHashOf(req)), mustChange: !!row?.must_change, isAdmin: req.staff === 'admin' } });
});
app.post('/api/crm/console/setup', rateLimit('console', 10, 15 * 60000, r => String(r.user?.id)), jsonOnly, (req, res) => {
  try {
    if (req.staff !== 'admin') return res.status(403).json({ error: 'Your console login is set by your manager.' });
    const u = setupOwn(req.user!.id, tokenHashOf(req), req.body?.username, req.body?.password);
    securityLog(req, 'console_setup', req.user, `username ${u}`);
    res.json({ data: { ok: true } });
  } catch (e) { consoleFail(res, e); }
});
app.post('/api/crm/console/login', rateLimit('console', 10, 15 * 60000, r => String(r.user?.id)), jsonOnly, (req, res) => {
  try {
    const r = consoleLogin(req.user!.id, tokenHashOf(req), req.body?.username, req.body?.password);
    securityLog(req, 'console_login_ok', req.user);
    res.json({ data: r });
  } catch (e) {
    if (e instanceof ConsoleError && e.status !== 400) securityLog(req, 'console_login_fail', req.user, e.message);
    consoleFail(res, e);
  }
});
app.post('/api/crm/console/change', rateLimit('console', 10, 15 * 60000, r => String(r.user?.id)), jsonOnly, (req, res) => {
  try {
    if (!sessionUnlocked(tokenHashOf(req))) return res.status(423).json({ error: 'Sign in to the staff console first.', console: 'locked' });
    if (req.staff !== 'admin') return res.status(403).json({ error: 'Your console password is set by your manager. Ask them to change it.' });
    changeOwn(req.user!.id, req.body?.current, req.body?.next);
    securityLog(req, 'console_password_changed', req.user);
    res.json({ data: { ok: true } });
  } catch (e) { consoleFail(res, e); }
});
// Admin forgot their console login: account password + a two-step code clear it, then set it up again
app.post('/api/crm/console/reset', rateLimit('console', 10, 15 * 60000, r => String(r.user?.id)), jsonOnly, (req, res) => {
  try {
    if (req.staff !== 'admin') return res.status(403).json({ error: 'Ask your manager to reset your console login.' });
    checkPassword(req.user!.id, req.body?.password);
    checkCode(req.user!.id, req.body?.code);
    resetOwn(req.user!.id);
    securityLog(req, 'console_reset_admin', req.user);
    res.json({ data: { ok: true } });
  } catch (e) { consoleFail(res, e); }
});
app.post('/api/crm/console/lock', (req, res) => { lockSession(tokenHashOf(req)); res.json({ data: { ok: true } }); });

// ---------- CRM: every route checks its own permission (services/roles.ts); admin has all ----------
const staffName = (req: express.Request) => ({ id: req.user!.id, name: req.user!.name || req.user!.email.split('@')[0] });
const crmFail = (res: express.Response, e: any) =>
  e instanceof CrmError || e instanceof RoleError ? res.status(e.status).json({ error: e.message }) : e instanceof AuthError ? authFail(res, e) : sendError(res, e, 'CRM error');
const need = (perm: Perm) => (req: express.Request, res: express.Response, next: express.NextFunction) =>
  req.perms?.has(perm) ? next() : res.status(403).json({ error: 'Your role does not allow this.' });
const viewer = (req: express.Request): Viewer => ({ id: req.user!.id, manage: !!req.perms?.has('inbox.manage') });
const isAdminReq = (req: express.Request) => req.staff === 'admin';
/** Everyone who may work the inbox (for assigning): admins and staff whose role has inbox.read. */
function inboxStaff() {
  return listUsers().filter(u => u.isAdmin || (u.role && roleByKey(u.role)?.perms.includes('inbox.read'))).map(u => ({ id: u.id, name: u.name || u.email.split('@')[0] }));
}

app.get('/api/crm/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: { staff: req.staff, perms: [...(req.perms || [])], role: req.staff === 'admin' ? 'Admin' : roleByKey(req.user?.role)?.name || null } });
});
// Support inbox
app.get('/api/crm/inbox', need('inbox.read'), (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ data: { ...inboxList(String(req.query.status || '') || null, viewer(req)), staff: inboxStaff() } }); } catch (e) { crmFail(res, e); }
});
app.get('/api/crm/inbox/:id(\\d+)', need('inbox.read'), (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ data: inboxThread(parseInt(req.params.id, 10), viewer(req)) }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/inbox/:id(\\d+)/reply', need('inbox.reply'), rateLimit('crm-reply', 60, 60 * 60000, r => String(r.user?.id)), jsonOnly, async (req, res) => {
  try { canOpen(parseInt(req.params.id, 10), viewer(req)); await reply(parseInt(req.params.id, 10), staffName(req), req.body?.body, req.body?.close === true); res.json({ data: { ok: true } }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/inbox/:id(\\d+)/note', need('inbox.reply'), jsonOnly, (req, res) => {
  try { canOpen(parseInt(req.params.id, 10), viewer(req)); addNote(parseInt(req.params.id, 10), staffName(req), req.body?.body); res.json({ data: { ok: true } }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/inbox/:id(\\d+)/status', need('inbox.reply'), jsonOnly, (req, res) => {
  try { canOpen(parseInt(req.params.id, 10), viewer(req)); setStatus(parseInt(req.params.id, 10), req.body?.status); res.json({ data: { ok: true } }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/inbox/:id(\\d+)/assign', need('inbox.reply'), jsonOnly, (req, res) => {
  try {
    const to = req.body?.to === null ? null : parseInt(String(req.body?.to), 10);
    assign(parseInt(req.params.id, 10), Number.isFinite(to as number) ? (to as number) : null, viewer(req), new Set(inboxStaff().map(s => s.id)));
    res.json({ data: { ok: true } });
  } catch (e) { crmFail(res, e); }
});
// Customers
app.get('/api/crm/customers', need('customers.view'), (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ data: searchCustomers(req.query.q, req.query.trust) }); } catch (e) { crmFail(res, e); }
});
app.get('/api/crm/customers/:id(\\d+)', need('customers.view'), (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const id = parseInt(req.params.id, 10);
    const data: any = customerProfile(id, !!req.perms?.has('security'));
    if (data && req.perms?.has('activity')) data.staffActivity = activityList({ userId: id, limit: 50 }).rows;
    res.json({ data });
  } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/customers/:id(\\d+)/plan', need('customers.plan'), jsonOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const target = userById(id);
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.isAdmin || (target.role && !isAdminReq(req))) return res.status(403).json({ error: 'Staff plans are changed by the admin only.' });
    const plan = req.body?.plan === 'premium' || req.body?.plan === 'pro' ? req.body.plan : 'free';
    const days = Math.max(1, Math.min(400, parseInt(String(req.body?.days || '30'), 10) || 30));
    const base = target.premiumUntil && target.premiumUntil > new Date().toISOString() && target.plan === plan ? new Date(target.premiumUntil).getTime() : Date.now();
    const until = plan === 'free' ? null : new Date(base + days * 86400000).toISOString();
    const u = setPlan(id, plan, until, 'admin');
    securityLog(req, 'staff_plan_change', req.user, `account #${id} → ${plan}${until ? ` until ${until.slice(0, 10)}` : ''}`);
    res.json({ data: u });
  } catch (e) { crmFail(res, e); }
});
// fix147: pick packs per customer — balance + history, and grant / take credits (plan permission, logged)
app.get('/api/crm/customers/:id(\\d+)/credits', need('customers.view'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.set('Cache-Control', 'no-store').json({ data: { balance: creditBalance(id), events: creditEvents(id) } });
});
app.post('/api/crm/customers/:id(\\d+)/credits', need('customers.plan'), jsonOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!userById(id)) return res.status(404).json({ error: 'Account not found.' });
    const delta = Math.max(-500, Math.min(500, parseInt(String(req.body?.delta || '0'), 10) || 0));
    if (!delta) return res.status(400).json({ error: 'Give a number of picks (e.g. 5 or -5).' });
    const note = String(req.body?.note || '').slice(0, 60);
    const balance = addCredits(id, delta, `staff ${delta > 0 ? 'grant' : 'removal'} by #${req.user!.id}${note ? `: ${note}` : ''}`);
    securityLog(req, 'staff_credits', req.user, `account #${id} ${delta > 0 ? '+' : ''}${delta} picks → ${balance}${note ? ` (${note})` : ''}`);
    res.json({ data: { balance, events: creditEvents(id) } });
  } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/customers/:id(\\d+)/reset-email', need('customers.security'), async (req, res) => {
  try {
    const target = userById(parseInt(req.params.id, 10));
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.isAdmin || (target.role && !isAdminReq(req))) return res.status(403).json({ error: 'Not for staff accounts.' });
    await requestPasswordReset(target.email, req.ip || '');
    securityLog(req, 'staff_sent_reset', req.user, `account #${target.id}`);
    res.json({ data: { sentTo: target.email } });
  } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/customers/:id(\\d+)/sign-out', need('customers.security'), (req, res) => {
  try {
    const target = userById(parseInt(req.params.id, 10));
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.isAdmin || (target.role && !isAdminReq(req))) return res.status(403).json({ error: 'Not for staff accounts.' });
    const n = signOutEverywhere(target.id);
    securityLog(req, 'staff_signed_out_user', req.user, `account #${target.id} (${n} devices)`);
    res.json({ data: { devices: n } });
  } catch (e) { crmFail(res, e); }
});
// Campaigns
app.post('/api/crm/segment', need('campaigns'), jsonOnly, (req, res) => {
  try { res.json({ data: segmentPreview(req.body?.segment) }); } catch (e) { crmFail(res, e); }
});
app.get('/api/crm/campaigns', need('campaigns'), (_req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ data: campaignList() }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/campaigns/test', need('campaigns'), jsonOnly, async (req, res) => {
  try { await sendTest(req.body?.subject, req.body?.body, { id: req.user!.id, email: req.user!.email, name: req.user!.name }); res.json({ data: { sentTo: req.user!.email } }); } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/campaigns', need('campaigns'), jsonOnly, async (req, res) => {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm before sending.' });
    const r = await startCampaign(req.body?.subject, req.body?.body, req.body?.segment, req.user!.id);
    securityLog(req, 'campaign_sent', req.user, `#${r.id} to ${r.total}: ${String(req.body?.subject || '').slice(0, 80)}`);
    res.json({ data: r });
  } catch (e) { crmFail(res, e); }
});
// Revenue, security log
app.get('/api/crm/revenue', need('revenue'), (_req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ data: revenue() }); } catch (e) { crmFail(res, e); }
});
app.get('/api/crm/security', need('security'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uid = parseInt(String(req.query.user || ''), 10);
  res.json({ data: securityLogList(300, Number.isFinite(uid) ? uid : undefined) });
});
// Team & roles
app.get('/api/crm/team', need('team'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cons = consoleUsers();
  res.json({ data: { ...listRoles(), staff: listStaff().map(m => ({ ...m, console: cons.get(m.id) || null })), isAdmin: isAdminReq(req) } });
});
// Every team / role change needs a fresh two-step code: the code opens a short window (5 minutes) for this session.
const SUDO_MS = 5 * 60000;
const sudo = new Map<string, number>(); // session hash → until
const sessKey = (req: express.Request) => { const t = parseCookies(req.headers.cookie)[SESSION_COOKIE]; return t ? sessionHash(t) : ''; };
const sudoLeft = (req: express.Request) => Math.max(0, (sudo.get(sessKey(req)) || 0) - Date.now());
const needSudo = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  sudoLeft(req) > 0 ? next() : res.status(401).json({ error: 'Enter a code from your authenticator app to make team changes.', sudo: true });
every('sudo cleanup', () => { const now = Date.now(); for (const [k, v] of sudo) if (v < now) sudo.delete(k); }, 60000).unref();
app.get('/api/crm/team/sudo', need('team'), (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: { leftMs: sudoLeft(req) } }); });
app.post('/api/crm/team/sudo', need('team'), rateLimit('team-sudo', 10, 15 * 60000, r => String(r.user?.id)), jsonOnly, (req, res) => {
  try {
    if (!req.user!.twoFactor) return res.status(400).json({ error: 'Turn on two-step login in Settings first.' });
    const key = sessKey(req);
    if (!key) return res.status(401).json({ error: 'Sign in again.' });
    checkCode(req.user!.id, req.body?.code);
    sudo.set(key, Date.now() + SUDO_MS);
    securityLog(req, 'team_unlocked', req.user, 'two-step code for team changes (5 min)');
    res.json({ data: { leftMs: SUDO_MS } });
  } catch (e) {
    if (e instanceof TwoFactorError) securityLog(req, '2fa_fail', req.user, 'team changes');
    authFail(res, e);
  }
});

app.post('/api/crm/team/member', need('team'), needSudo, jsonOnly, (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const target = listUsers().find(u => u.email.toLowerCase() === email);
    if (!target) return res.status(404).json({ error: 'No account with this email. They need to sign up first.' });
    const role = req.body?.role ? String(req.body.role) : null;
    if (target.id === req.user!.id) return res.status(400).json({ error: 'You cannot change your own role.' });
    // only the admin may hand out or take away a role that can manage the team
    const touchesTeam = (k: string | null) => !!k && !!roleByKey(k)?.perms.includes('team');
    if ((touchesTeam(role) || touchesTeam(target.role)) && !isAdminReq(req)) return res.status(403).json({ error: 'Only the admin can change who manages the team.' });
    const u = setRole(target.id, role);
    if (!role) removeFor(target.id);
    securityLog(req, 'role_changed', req.user, `${target.email} → ${role ? roleByKey(role)?.name : 'no role'}`);
    res.json({ data: u });
  } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/team/console', need('team'), needSudo, jsonOnly, (req, res) => {
  try {
    const target = userById(parseInt(String(req.body?.userId), 10));
    if (!target) return res.status(404).json({ error: 'Account not found.' });
    if (target.id === req.user!.id) return res.status(400).json({ error: 'Change your own console password from the CRM header.' });
    if (!target.role) return res.status(400).json({ error: 'Add them to the team first.' });
    if (roleByKey(target.role)?.perms.includes('team') && !isAdminReq(req)) return res.status(403).json({ error: 'Only the admin can set this person’s console login.' });
    const existing = consoleRow(target.id);
    const pw = String(req.body?.password || '');
    // no new password: only the username changes (when there already is a login)
    if (!pw && existing) {
      const r = renameFor(target.id, req.body?.username, req.user!.id);
      securityLog(req, 'console_username_changed', req.user, `${target.email}: ${r.before} → ${r.username}`);
      return res.json({ data: { ok: true, username: r.username, passwordChanged: false } });
    }
    const u = setFor(target.id, req.body?.username || existing?.username, pw, req.user!.id);
    securityLog(req, 'console_login_set', req.user, `${target.email} → username ${u}`);
    res.json({ data: { ok: true, username: u, passwordChanged: true } });
  } catch (e) { consoleFail(res, e); }
});
app.post('/api/crm/team/roles', need('team'), needSudo, jsonOnly, (req, res) => {
  try {
    const r = createRole(req.body?.name, req.body?.perms, isAdminReq(req));
    securityLog(req, 'role_created', req.user, `${r.name}: ${r.perms.join(', ')}`);
    res.json({ data: r });
  } catch (e) { crmFail(res, e); }
});
app.post('/api/crm/team/roles/:key', need('team'), needSudo, jsonOnly, (req, res) => {
  try {
    if (!isAdminReq(req) && req.user!.role === String(req.params.key)) return res.status(403).json({ error: 'You cannot change your own role. Ask the admin.' });
    const r = updateRole(String(req.params.key), req.body?.name, req.body?.perms, isAdminReq(req));
    securityLog(req, 'role_updated', req.user, `${r.name}: ${r.perms.join(', ') || 'no permissions'}`);
    res.json({ data: r });
  } catch (e) { crmFail(res, e); }
});
/*
 * fix216: the daily picks email and the weekly digest (services/pickEmails.ts). Settings: the signed-in person's own
 * (an account action, written here). Unsubscribe: the footer link opens a page with one button; mail apps post to
 * the same URL (List-Unsubscribe-Post, one click). Webhook: Resend events (bounces, complaints, opens, clicks), the
 * writes go to the worker. Admin: numbers per day, a test to the admin's own address, a preview for any user id.
 */
app.get('/api/email/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ data: emailSettings(req.user) });
});
app.put('/api/email/settings', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const b = req.body || {};
    saveEmailPrefs(req.user.id, { daily: b.daily, weekly: b.weekly, news: b.news, sports: b.sports, sendHour: b.sendHour, tz: b.tz, lang: b.lang }, 'account');
    res.json({ data: emailSettings(req.user) });
  } catch (e: any) {
    if (e instanceof EmailPrefsError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Saving email settings failed');
  }
});
const picksUnsubPage = (state: 'ask' | 'done' | 'bad', action = '') => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>SportLikely</title>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0b0e13;color:#e8eaee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><div style="font-weight:800;font-size:20px">Sport<span style="color:#c6f432">Likely</span></div>
${state === 'ask' ? `<h1 style="font-size:20px">Stop the picks emails?</h1><p style="color:#9aa1ad">You will not get the daily picks email or the weekly digest any more, until you turn them back on in your account.</p>
<form method="post" action="${action}"><button type="submit" style="background:#c6f432;color:#0b0e13;border:0;border-radius:10px;padding:12px 20px;font-weight:800;font-size:15px;cursor:pointer">Unsubscribe</button></form>`
  : state === 'done' ? `<h1 style="font-size:20px">You are unsubscribed</h1><p style="color:#9aa1ad">No more daily picks or weekly digest emails. Account emails (codes, security) still arrive. You can turn them back on in your account.</p>`
  : `<h1 style="font-size:20px">This link is not valid</h1><p style="color:#9aa1ad">Turn the emails off in your account settings instead.</p>`}
<p><a href="/account#emails" style="color:#c6f432">Manage emails</a> · <a href="/" style="color:#c6f432">SportLikely</a></p></div></body>`;
app.get('/api/email/unsubscribe', (req, res) => {
  const ok = !!checkUnsub(req.query.u, req.query.t);
  const action = ok ? `/api/email/unsubscribe?u=${encodeURIComponent(String(req.query.u))}&t=${encodeURIComponent(String(req.query.t))}` : '';
  res.type('html').set('Cache-Control', 'no-store').send(picksUnsubPage(ok ? 'ask' : 'bad', action));
});
app.post('/api/email/unsubscribe', (req, res) => {
  // List-Unsubscribe-Post (form body "List-Unsubscribe=One-Click") or the page's button
  const oneClick = !!req.get('content-type')?.includes('form') && !req.get('sec-fetch-mode');
  const ok = unsubscribePicks(req.query.u, req.query.t, oneClick ? 'one-click' : 'unsubscribe-link');
  if (req.accepts(['html', 'json']) === 'html') return res.status(ok ? 200 : 400).type('html').set('Cache-Control', 'no-store').send(picksUnsubPage(ok ? 'done' : 'bad'));
  res.status(ok ? 200 : 400).json({ ok });
});
app.post('/api/webhooks/resend', (req, res) => {
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!raw || !verifyWebhook(raw, { id: req.get('svix-id'), timestamp: req.get('svix-timestamp'), signature: req.get('svix-signature') })) return res.status(401).json({ error: 'Bad signature' });
  try { res.json({ ok: true, did: handleWebhookEvent(req.body) }); } catch (e) { sendError(res, e, 'Webhook failed'); }
});
app.get('/api/admin/emails', (req, res) => {
  try { res.json({ data: emailAdminStats(Math.min(60, parseInt(String(req.query.days || '14'), 10) || 14)) }); } catch (e) { sendError(res, e, 'Email stats failed'); }
});
app.post('/api/admin/emails/test', async (req, res) => {
  try { res.json({ data: await sendTestEmail(req.user!, req.body?.kind === 'weekly' ? 'weekly' : 'daily') }); }
  catch (e: any) { if (e instanceof EmailPrefsError) return res.status(e.status).json({ error: e.message }); sendError(res, e, 'Test email failed'); }
});
app.get('/api/admin/emails/preview', (req, res) => {
  try {
    const p = previewEmail(parseInt(String(req.query.user || req.user!.id), 10), req.query.kind === 'weekly' ? 'weekly' : 'daily');
    res.set('Cache-Control', 'no-store');
    if ('skip' in p) return res.type('html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,Arial,sans-serif;padding:24px"><h2>Nothing to send</h2><p>${p.skip.replace(/[<>&]/g, '')}</p></body>`);
    res.type('html').send(p.html);
  } catch (e) { sendError(res, e, 'Preview failed'); }
});

/*
 * fix226: push alerts (services/pushAlerts.ts). Settings and this browser's subscription: the signed-in person's own
 * (account actions, written here). Alerts are sent by the worker's live loop only. Admin: numbers and a test push to
 * the admin's own devices (worker).
 */
app.get('/api/push/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ data: pushSettings(req.user) });
});
const pushFail = (res: express.Response, e: unknown, what: string) => (e instanceof PushError ? res.status(e.status).json({ error: e.message }) : sendError(res, e, what));
app.put('/api/push/settings', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const b = req.body || {};
    savePushPrefs(req.user.id, { on: b.on, starting: b.starting, score: b.score, final: b.final, upset: b.upset, myPicks: b.myPicks, quietFrom: b.quietFrom, quietTo: b.quietTo, tz: b.tz, lang: b.lang }, 'account');
    res.json({ data: pushSettings(req.user) });
  } catch (e) { pushFail(res, e, 'Saving alert settings failed'); }
});
// this browser's subscription (PushManager.subscribe); `on: true` = the person just allowed alerts here
app.post('/api/push/subscribe', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const b = req.body || {};
    addPushSub(req.user.id, b.subscription, req.get('user-agent'));
    if (b.on === true) savePushPrefs(req.user.id, { on: true, tz: b.tz, lang: b.lang }, 'account');
    res.json({ data: pushSettings(req.user) });
  } catch (e) { pushFail(res, e, 'Saving this device failed'); }
});
app.post('/api/push/unsubscribe', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try { removePushSub(req.user.id, req.body?.endpoint); res.json({ data: pushSettings(req.user) }); } catch (e) { pushFail(res, e, 'Removing this device failed'); }
});
app.get('/api/admin/push', (req, res) => {
  try { res.json({ data: pushAdminStats(Math.min(60, parseInt(String(req.query.days || '14'), 10) || 14)) }); } catch (e) { sendError(res, e, 'Push stats failed'); }
});
app.post('/api/admin/push/test', async (req, res) => {
  try { res.json({ data: await sendTestPush(req.user!) }); } catch (e) { pushFail(res, e, 'Test push failed'); }
});

app.delete('/api/crm/team/roles/:key', need('team'), needSudo, (req, res) => {
  try {
    if (!isAdminReq(req) && req.user!.role === String(req.params.key)) return res.status(403).json({ error: 'You cannot delete your own role.' });
    deleteRole(String(req.params.key), isAdminReq(req));
    securityLog(req, 'role_deleted', req.user, String(req.params.key));
    res.json({ data: { ok: true } });
  } catch (e) { crmFail(res, e); }
});
// One-click unsubscribe from campaign emails (link + List-Unsubscribe-Post)
const unsubPage = (ok: boolean) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>SportLikely</title>
<body style="font-family:Segoe UI,Arial,sans-serif;background:#0b0e13;color:#e8eaee;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><div style="font-weight:800;font-size:20px">Sport<span style="color:#c6f432">Likely</span></div>
<h1 style="font-size:20px">${ok ? 'You are unsubscribed' : 'This link is not valid'}</h1>
<p style="color:#9aa1ad">${ok ? 'You will not get update emails any more. Account emails (codes, security) still arrive. You can turn updates back on in your account.' : 'Turn updates off in your account settings instead.'}</p>
<a href="/" style="color:#c6f432">Back to SportLikely</a></div></body>`;
app.get('/api/unsubscribe', (req, res) => { res.type('html').set('Cache-Control', 'no-store').send(unsubPage(unsubscribe(req.query.u, req.query.t))); });
app.post('/api/unsubscribe', (req, res) => { const ok = unsubscribe(req.query.u, req.query.t); res.status(ok ? 200 : 400).json({ ok }); });

// Contact form → support inbox (anyone; signed-in users send from their account email)
app.post('/api/contact', rateLimit('contact', 5, 60 * 60000), jsonOnly, async (req, res) => {
  try {
    res.json({ data: await submitContact(req.body, req.user ? { id: req.user.id, email: req.user.email } : null) });
  } catch (e: any) {
    if (e instanceof ContactError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Message not sent');
  }
});
// ---------- Beta testers (services/testers.ts) ----------
const testerFail = (res: express.Response, e: any) => (e instanceof TesterError ? res.status(e.status).json({ error: e.message }) : sendError(res, e, 'Something went wrong'));
app.get('/api/testers/invite/:code', rateLimit('tester-invite', 60, 15 * 60000), (req, res) => {
  const info = inviteInfo(String(req.params.code));
  if (!info) return res.status(404).json({ error: 'This invite link is not valid.' });
  res.json({ data: info });
});
app.post('/api/testers/join', rateLimit('tester-join', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const r = joinAsTester(req.user.id, String(req.body?.code || ''));
    if (!r.already) securityLog(req, 'tester_joined', req.user, `invite ${req.body?.code}`);
    res.json({ data: r });
  } catch (e) { testerFail(res, e); }
});
// Feedback button (testers and staff): straight into the CRM support inbox, topic 'feedback'
const feedbackCount = new Map<number, number[]>();
// Site crash reports from visitors' browsers (no IP, no user stored) — see services/clientErrors.ts
app.post('/api/client-error', rateLimit('client-error', 20, 10 * 60000), jsonOnly, (req, res) => {
  try { res.json({ data: reportClientError(req.body) }); } catch { res.json({ data: { ok: false } }); }
});
app.get('/api/admin/client-errors', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: clientErrorList(Math.min(30, parseInt(String(req.query.days || '30'), 10) || 30)) });
});
app.post('/api/admin/client-errors/:sig([a-f0-9]{16})', jsonOnly, (req, res) => {
  resolveClientError(req.params.sig, !!req.body?.resolved);
  res.json({ data: { ok: true } });
});
// More football leagues (Oct 2026): API-Football coverage scan + leagues added from the admin panel (leagueConfig.ts)
app.get('/api/admin/league-coverage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await leagueCoverage(req.query.refresh === '1') }); }
  catch (e: any) { res.status(502).json({ error: `Coverage scan failed: ${e.message}` }); }
});
let extraLeagueJob: Promise<void> | null = null;
/** After adding leagues: pull their fixtures, history, injuries and lineups now, then rebuild the model. */
function warmExtraLeagues() {
  if (extraLeagueJob) return;
  extraLeagueJob = (async () => {
    try {
      await afTick(true);
      await refreshAfWindow().catch(() => undefined);
      await prepareModelV3Async();
      await rebuildAfFeaturesAsync(true);
    } catch (e: any) { logger.warn(`extra leagues warm-up: ${e.message}`); }
    finally { extraLeagueJob = null; }
  })();
}
app.post('/api/admin/extra-leagues', jsonOnly, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => parseInt(String(x), 10)).filter((x: number) => Number.isFinite(x) && x > 0).slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: 'No leagues chosen.' });
  try {
    const { ok, skipped } = await pickForAdding(ids);
    const added = ok.map(l => ({ id: l.id, name: l.name, ...addExtraLeague({ id: l.id, name: l.name, country: l.country, calendar: l.calendar, trial: true }) }));
    if (req.user) securityLog(req, 'leagues_added', req.user, added.map(a => `${a.id} ${a.name}`).join(', ').slice(0, 500));
    if (added.length) warmExtraLeagues();
    res.json({ data: { added, skipped, note: 'Fixtures, history and lineups are loading now; predictions appear when the model has rebuilt (usually 10–30 minutes).' } });
  } catch (e: any) { res.status(502).json({ error: e.message }); }
});
app.post('/api/admin/extra-leagues/:id(\\d+)/remove', jsonOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user) securityLog(req, 'league_removed', req.user, String(id));
  res.json({ data: removeExtraLeague(id) });
});
app.post('/api/admin/extra-leagues/:id(\\d+)/trial', jsonOnly, (req, res) => {
  res.json({ data: setExtraTrial(parseInt(req.params.id, 10), !!req.body?.trial) });
});
// The same for basketball (bbLeagueConfig.ts / bbLeagueCoverage.ts): leagues start "in testing" (admin label), sync begins right away
// NFL data check (fix136, admin only): plan, seasons + coverage, games we hold, sample stats / injuries / standings.
// About 10 API calls; cached 10 minutes (?refresh=1 runs it again).
// API-Football today (fix140, admin overview card): quota used / limit, calls by scheduler / page views / admin,
// the page budget, and the busiest user-agents (no IPs).
app.get('/api/admin/af-usage', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: { quota: afQuota(), ...afUsageToday() } });
});
// fix150: what the college lists see (season, weeks, default week, counts with / without the 'other' filter, raw values)
app.get('/api/admin/nfl-college-debug', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: require('./services/nflSite').collegeListsDebug() }); } catch (e) { sendError(res, e, 'College debug failed'); }
});
app.get('/api/admin/nfl-probe', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await nflProbe(req.query.refresh === '1') }); }
  catch (e: any) { res.status(502).json({ error: `NFL probe failed: ${e.message}` }); }
});
// Tennis data (fix184, admin only): what the Live Tennis API plan gives (one call per endpoint: status, plan error, key
// names, one trimmed sample row; never the key) and the state of the tables, backfill, quota and jobs.
app.get('/api/admin/tennis-probe', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await tennisProbe() }); }
  catch (e: any) { res.status(502).json({ error: `Tennis probe failed: ${e.message}` }); }
});
app.get('/api/admin/tennis/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: tennisStatus() }); } catch (e) { sendError(res, e, 'Tennis status failed'); }
});
// fix241: the player-photo review routes (fix211) are gone — official photos only, no Wikimedia matching to review
// fix195: duplicates, fixture ids, matches without a prediction (48 h), stale matches, names to check — target zero
// fix200: voided games (reason) and the games waiting for another lookup (rules: utils/voidRules.ts)
app.get('/api/admin/voided', (req, res) => {
  try { res.json({ data: { voided: voidedGames(Math.min(365, Number(req.query.days) || 90)), waiting: pendingLookups() } }); } catch (e) { sendError(res, e, 'Voided games failed'); }
});
app.get('/api/admin/tennis/check', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await tennisDataCheck() }); } catch (e) { sendError(res, e, 'Tennis check failed'); }
});
// fix187: ?tour=atp|wta|challenger&status=upcoming|live|completed&limit=30 — to compare with the real ATP / WTA schedule
app.get('/api/admin/tennis/sample', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: tennisSample({ tour: String(req.query.tour || ''), status: String(req.query.status || ''), limit: Number(req.query.limit) || 30 }) }); }
  catch (e) { sendError(res, e, 'Tennis sample failed'); }
});
// fix190: tennis-v1 (admin only): the walk-forward report (per tour / surface, baselines, sets and totals, market
// benchmark), the live settings and the progress. ?rebuild=1 rebuilds the report (minutes, background), ?retune=1 the
// live settings only.
// fix204: "More predictions" — one game's block (locked like the prediction: free users get { model, locked } and the
// list of outputs; finished games open for everyone), a sport's record, and the admin view (gates, backtests, health)
const MORE_RID: Record<string, (id: number) => number> = { football: id => id, basketball: id => -id, nfl: id => nflRid(id), tennis: id => tennisRid(id) };
// fix202: the visitors' copy is a stored page (admins get theirs built here)
definePage({ name: 'more-record', freshMs: 10 * 60 * 1000, variants: VIEWS_PLAIN, warm: MORE_SPORTS.map(sport => ({ sport })), build: q => ({ data: moreRecord(q.sport as any, false) }) });
app.get('/api/more/:sport(football|basketball|nfl|tennis)/record', async (req, res) => {
  try {
    if (req.access !== 'admin') return await sendStored(req, res, 'more-record', { sport: req.params.sport }, 'full');
    byWorker(req, res, () => res.json({ data: moreRecord(req.params.sport as any, true) }));
  } catch (e) { sendError(res, e, 'Failed to load the record'); }
});
app.get('/api/more/:sport(football|basketball|nfl|tennis)/:id(-?\\d+)', async (req, res) => {
  try {
    // fix204b: the game id or its unlock id; a game the 5-minute job has not reached yet is saved now (before the start only)
    const sport = req.params.sport as any, id = gameIdOf(sport, parseInt(req.params.id, 10));
    if (!hasExtras(sport, id)) await saveOne(sport, id);
    res.set('Cache-Control', 'no-store');
    res.json({ data: moreForGame(sport, id, { full: fullOne(req, MORE_RID[sport](id)), admin: req.access === 'admin' }) });
  } catch (e) { sendError(res, e, 'Failed to load more predictions'); }
});
// ?format=md: the backtest tables as Markdown for docs/notes/more-predictions-backtest.md
app.get('/api/admin/more-predictions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.query.format === 'md') { res.type('text/markdown').send(backtestMarkdown()); return; }
    res.json({ data: { calc: calcStatus(), gates: gateList(), backtests: backtestReports(), health: moreHealth() } });
  } catch (e) { sendError(res, e, 'Failed'); }
});
// runs in the background in the heavy queue (football + basketball a few minutes, tennis more); ?sport= one sport, ?refit=1 league fits first
app.post('/api/admin/more-predictions/backtest', (req, res) => {
  const sport = MORE_SPORTS.includes(String(req.query.sport) as any) ? (String(req.query.sport) as any) : undefined;
  void heavy('more predictions backtest', async () => { await moreBacktestNow(sport, req.query.refit === '1'); }).catch(e => logger.warn(`more backtest: ${e.message}`)); // fix210b: in the job thread
  res.json({ data: { started: true, sport: sport || 'all' } });
});
app.get('/api/admin/tennis-model', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // fix194: in the heavy-job queue like the scheduled ticks
  if (req.query.rebuild === '1' || req.query.retune === '1') { const f = req.query.rebuild === '1' ? 'report' : 'retune'; void tennisModelTick(f).catch(() => undefined); } // fix200: the worker thread (or the heavy() queue in-process)
  try { res.json({ data: tennisModelReport() }); } catch (e) { sendError(res, e, 'Tennis model report failed'); }
});
// fix190: ?status=upcoming|done&tour=slam|atp|wta|challenger|itf&limit= — saved predictions with the outcome + the live record
app.get('/api/admin/tennis/predictions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: tennisPredictions({ status: String(req.query.status || ''), tour: String(req.query.tour || ''), limit: Number(req.query.limit) || 200 }) }); }
  catch (e) { sendError(res, e, 'Tennis predictions failed'); }
});
// NFL model report (fix139, admin only): walk-forward test of nfl-v1 (each of the last 5 seasons tuned on the seasons
// before it), baselines, calibration, the live settings. ?rebuild=1 re-tunes now (takes a minute; runs in the background).
// fix142: ?league=2 (or college) = ncaa-v1.
let nflRebuilding = false;
app.get('/api/admin/nfl-model', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const league = asLeague(req.query.league), model = league === 2 ? NCAA_MODEL : NFL_MODEL;
  if (req.query.rebuild === '1' && !nflRebuilding) {
    nflRebuilding = true;
    nflRetrain(league).catch(e => logger.warn(`${model} rebuild: ${e.message}`)).finally(() => { nflRebuilding = false; });
  }
  // fix146: ?experiments=1 runs the nfl-v2 experiments now (background); the table comes with the NFL report
  if (league === 1 && req.query.experiments === '1' && !nflRebuilding) {
    nflRebuilding = true;
    import('./services/nflExperiments').then(m => m.runNflExperiments()).catch(e => logger.warn(`nfl-exp: ${e.message}`)).finally(() => { nflRebuilding = false; });
  }
  // fix220: ?calib=1 rebuilds the calibration layer + the ncaa-v2 test (background, heavy queue)
  if (req.query.calib === '1' && !nflRebuilding) {
    nflRebuilding = true;
    import('./services/afCalibration').then(m => heavy('af calibration', () => m.buildAfCalibration())).catch(e => logger.warn(`af calibration: ${e.message}`)).finally(() => { nflRebuilding = false; });
  }
  const experiments = league === 1 ? require('./services/nflExperiments').nflExperimentReport() : null;
  res.json({ data: { model, league, rebuilding: nflRebuilding, report: nflModelReport(league), experiments, calibration: require('./services/afCalibration').afCalibReport() } });
});
app.get('/api/admin/bb-league-coverage', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await bbLeagueCoverage(req.query.refresh === '1') }); }
  catch (e: any) { res.status(502).json({ error: `Coverage scan failed: ${e.message}` }); }
});
app.post('/api/admin/bb-extra-leagues', jsonOnly, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: any) => parseInt(String(x), 10)).filter((x: number) => Number.isFinite(x) && x > 0).slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: 'No leagues chosen.' });
  try {
    const { ok, skipped } = await bbPickForAdding(ids);
    const added = ok.map(l => ({ id: l.id, name: l.name, ...addBbExtraLeague({ id: l.id, name: l.name, country: l.country, flag: l.countryCode ? l.countryCode.toLowerCase() : null, trial: true }) }));
    if (req.user) securityLog(req, 'bb_leagues_added', req.user, added.map(a => `${a.id} ${a.name}`).join(', ').slice(0, 500));
    if (added.length) void bbSyncNow().catch(() => undefined);
    res.json({ data: { added, skipped, note: 'Five seasons of games and box scores are loading now; predictions appear after the next model build (usually within an hour).' } });
  } catch (e: any) { res.status(502).json({ error: e.message }); }
});
app.post('/api/admin/bb-extra-leagues/:id(\\d+)/remove', jsonOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user) securityLog(req, 'bb_league_removed', req.user, String(id));
  res.json({ data: removeBbExtraLeague(id) });
});
app.post('/api/admin/bb-extra-leagues/:id(\\d+)/trial', jsonOnly, (req, res) => {
  res.json({ data: setBbExtraTrial(parseInt(req.params.id, 10), !!req.body?.trial) });
});
app.post('/api/feedback', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
  const message = String(req.body?.message || '').replace(/\r/g, '').trim().slice(0, 3000);
  if (message.length < 3) return res.status(400).json({ error: 'Write a few words first.' });
  const now = Date.now();
  const list = (feedbackCount.get(req.user.id) || []).filter(t => now - t < 86400000);
  if (list.length >= 30) return res.status(429).json({ error: 'That is a lot of feedback for one day — thank you! Try again tomorrow.' });
  list.push(now); feedbackCount.set(req.user.id, list);
  const kind = ['bug', 'confusing', 'idea', 'like'].includes(req.body?.kind) ? String(req.body.kind) : 'other';
  const KIND: Record<string, string> = { bug: 'Something is broken', confusing: 'Confusing', idea: 'Idea', like: 'I like this', other: 'Other' };
  const page = String(req.body?.page || '').slice(0, 200) || null;
  const device = String(req.body?.device || '').slice(0, 60);
  db.prepare('INSERT INTO contact_messages (at, user_id, name, email, topic, message, page, sent) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(new Date().toISOString(), req.user.id, req.user.name || null, req.user.email, 'feedback', `[${KIND[kind]}${device ? ` · ${device}` : ''}]\n${message}`, page);
  res.json({ data: { ok: true } });
});
app.get('/api/crm/activity', need('activity'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const n = (v: any) => { const x = parseInt(String(v || ''), 10); return Number.isFinite(x) ? x : null; };
  res.json({ data: activityList({ staffId: n(req.query.staff), userId: n(req.query.user), action: req.query.action ? String(req.query.action).replace(/[^a-z_]/g, '') : null, limit: n(req.query.limit) || 300 }) });
});
app.get('/api/crm/testers', need('customers.view'), (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: testerOverview() });
});
app.post('/api/crm/testers/invite', need('customers.plan'), jsonOnly, (req, res) => {
  try {
    const code = createInvite(req.body?.label, req.body?.days, req.body?.maxUses, req.user!.id);
    securityLog(req, 'tester_invite_created', req.user, code);
    res.json({ data: { code } });
  } catch (e) { testerFail(res, e); }
});
app.post('/api/crm/testers/invite/:code', need('customers.plan'), jsonOnly, (req, res) => {
  try {
    setInviteOpen(String(req.params.code), !!req.body?.open);
    securityLog(req, req.body?.open ? 'tester_invite_opened' : 'tester_invite_closed', req.user, String(req.params.code));
    res.json({ data: { ok: true } });
  } catch (e) { testerFail(res, e); }
});
// Admin: contact messages (read, mark handled)
// fix237: the admin page's summary tiles + "Needs you" counts (light COUNT queries, answered by the worker)
app.get('/api/admin/summary', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: adminSummary() }); });
app.get('/api/admin/contact', (_req, res) => {
  try { res.json({ data: contactInbox(), timestamp: new Date().toISOString() }); }
  catch (e: any) { sendError(res, e, 'Contact inbox failed'); }
});
app.post('/api/admin/contact/:id(\\d+)', jsonOnly, (req, res) => {
  try { markContact(parseInt(req.params.id, 10), req.body?.handled !== false); res.json({ data: { ok: true } }); }
  catch (e: any) { sendError(res, e, 'Update failed'); }
});

// "Tell me when it opens" for the sports that are coming (anyone, signed in or not)
app.post('/api/waitlist', rateLimit('waitlist', 10, 15 * 60000), jsonOnly, (req, res) => {
  try {
    res.json({ data: joinWaitlist(req.body?.email ?? req.user?.email, req.body?.sport, req.user?.id ?? null, req.body?.lang) });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message || 'Could not save' });
  }
});
// ---------- Database backups (services/backup.ts) — admin only; downloading a copy needs a fresh two-step code ----------
app.get('/api/admin/backups', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const st: any = backupStatus();
  if (remoteReady()) {
    try { const l = await remoteList(); st.remote.copies = l.length; st.remote.latest = l[0] || null; st.remote.bytes = l.reduce((a, b) => a + b.size, 0); }
    catch (e: any) { st.remote.listError = e.message; }
  }
  res.json({ data: st });
});
app.post('/api/admin/backups/run', (req, res) => {
  securityLog(req, 'backup_manual', req.user);
  runBackup('manual').catch(() => undefined);
  res.json({ data: { started: true } });
});
app.get('/api/admin/backups/download/:name', needSudo, (req, res) => {
  const file = localPath(req.params.name);
  if (!file) return res.status(404).json({ error: 'Backup not found.' });
  securityLog(req, 'backup_downloaded', req.user, req.params.name);
  res.set('Cache-Control', 'no-store');
  res.download(file, req.params.name);
});
app.get('/api/admin/waitlist', (_req, res) => res.json({ data: waitlistStats() }));
app.get('/api/admin/visitors', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: { ...visitorStats(), who: whoToday(), crawlers: crawlerReport() } }); }); // fix245: + search engines // fix199: + who is calling today
app.get('/api/admin/news', (_req, res) => res.json({ data: newsStatus() }));

app.post('/api/auth/login', jsonOnly, async (req, res) => {
  try {
    // fix168: the hidden field filled in: the same answer as a wrong password
    if (honeypotHit(req.body)) { logger.info('login honeypot'); return res.status(401).json({ error: 'Wrong email or password.' }); }
    // after 3 failed attempts: Cloudflare Turnstile (when it is on)
    if (turnstileSiteKey() && loginNeedsCheck(req.body?.email, req.ip || '') && !(await turnstileOk(req.body?.turnstile, req.ip || '')))
      return res.status(400).json({ error: 'Please confirm you are not a robot.', captcha: true });
    const user = login(req.body?.email, req.body?.password, req.ip || '');
    // two-step login on: no session yet, only a short ticket for the code step
    if (twoFactorEnabled(user.id)) {
      securityLog(req, 'login_password_ok', user, 'waiting for two-step code');
      return res.json({ twoFactor: true, ticket: issueTicket(user.id) });
    }
    const s = createSession(user.id, req.headers['user-agent']);
    setSessionCookie(res, s.token, s.expires, req.secure);
    securityLog(req, 'login_ok', user);
    res.json(sessionPayload(user));
  } catch (e) {
    if (e instanceof AuthError && (e.status === 401 || e.status === 429))
      securityLog(req, 'login_fail', { email: String(req.body?.email || '').trim().slice(0, 254) || null }, e.status === 429 ? 'rate limited' : 'wrong email or password');
    // fix168: the next try needs the Turnstile check: tell the form to show it
    if (e instanceof AuthError && e.status === 401 && turnstileSiteKey() && loginNeedsCheck(req.body?.email, req.ip || '')) return res.status(401).json({ error: e.message, captcha: true });
    authFail(res, e);
  }
});

// Two-step login, step 2: the ticket from /auth/login (or /auth/reset) + a 6-digit code or a recovery code
app.post('/api/auth/2fa/login', rateLimit('login2fa', 20, 15 * 60000), jsonOnly, (req, res) => {
  try {
    const { userId, via } = redeemTicket(req.body?.ticket, req.body?.code);
    const s = createSession(userId, req.headers['user-agent'], true);
    setSessionCookie(res, s.token, s.expires, req.secure);
    const user = { ...userById(userId)!, mfa: true };
    securityLog(req, via === 'recovery' ? 'login_ok_recovery_code' : 'login_ok', user, 'two-step passed');
    res.json(sessionPayload(user));
  } catch (e) {
    if (e instanceof TwoFactorError) securityLog(req, '2fa_fail', null, e.message);
    authFail(res, e);
  }
});

// Two-step login settings (signed in)
app.get('/api/auth/2fa', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  res.set('Cache-Control', 'no-store');
  res.json({ data: twoFactorStatus(req.user.id) });
});
app.post('/api/auth/2fa/setup', rateLimit('2fa-setup', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    if (req.user.twoFactor) return res.status(400).json({ error: 'Two-step login is already on.' });
    checkPassword(req.user.id, req.body?.password);
    res.set('Cache-Control', 'no-store');
    res.json({ data: startSetup(req.user.id, req.user.email) });
  } catch (e) {
    authFail(res, e);
  }
});
app.post('/api/auth/2fa/confirm', rateLimit('2fa-setup', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const codes = confirmSetup(req.user.id, req.body?.code);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    securePastSessions(req.user.id, token ? sessionHash(token) : null); // this device stays signed in; every other device is signed out
    securityLog(req, '2fa_on', req.user);
    res.set('Cache-Control', 'no-store');
    res.json({ data: { recoveryCodes: codes }, ...sessionPayload({ ...userById(req.user.id)!, mfa: true }) });
  } catch (e) {
    authFail(res, e);
  }
});
app.post('/api/auth/2fa/recovery', rateLimit('2fa-setup', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const codes = newRecovery(req.user.id, req.body?.code);
    securityLog(req, '2fa_recovery_new', req.user);
    res.set('Cache-Control', 'no-store');
    res.json({ data: { recoveryCodes: codes } });
  } catch (e) {
    authFail(res, e);
  }
});
app.post('/api/auth/2fa/disable', rateLimit('2fa-setup', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    if (req.user.isAdmin && ADMIN_2FA_REQUIRED) return res.status(400).json({ error: 'Admin accounts must keep two-step login on (ADMIN_2FA_REQUIRED).' });
    checkPassword(req.user.id, req.body?.password);
    disableTwoFactor(req.user.id, req.body?.code);
    securityLog(req, '2fa_off', req.user);
    res.json(sessionPayload({ ...userById(req.user.id)!, mfa: req.user.mfa }));
  } catch (e) {
    authFail(res, e);
  }
});
// Add another device (second phone / tablet): password + a current code → the setup QR again
app.post('/api/auth/2fa/device', rateLimit('2fa-setup', 10, 15 * 60000), jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    checkPassword(req.user.id, req.body?.password);
    const d = revealSetup(req.user.id, req.user.email, req.body?.code);
    securityLog(req, '2fa_device_added', req.user);
    res.set('Cache-Control', 'no-store');
    res.json({ data: d });
  } catch (e) {
    authFail(res, e);
  }
});

// Change the account email: password (+ two-step code when on) → code to the new address → confirm
app.post('/api/auth/email', rateLimit('email-change', 10, 60 * 60000), jsonOnly, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    if (req.user.twoFactor) checkCode(req.user.id, req.body?.code);
    const to = await startEmailChange(req.user, req.body?.password, req.body?.email);
    securityLog(req, 'email_change_started', req.user, `to ${to}`);
    res.json({ data: { sentTo: to } });
  } catch (e) {
    authFail(res, e);
  }
});
app.post('/api/auth/email/confirm', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const r = confirmEmailChange(req.user, req.body?.code);
    securityLog(req, 'email_changed', r.user, `from ${r.oldEmail}`);
    res.json(sessionPayload({ ...r.user, mfa: req.user.mfa }));
  } catch (e) {
    authFail(res, e);
  }
});

// Admin: security log (sign-ins, two-step, account changes; IPs kept 90 days)
app.get('/api/admin/security-log', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uid = parseInt(String(req.query.user || ''), 10);
  res.json({ data: securityLogList(200, Number.isFinite(uid) ? uid : undefined) });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  clearSessionCookie(res, req.secure);
  res.json(sessionPayload(null));
});

// Your data (GDPR): download everything we hold about you, or delete the account (password required)
app.get('/api/auth/export', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    res.set('Content-Disposition', `attachment; filename="sportlikely-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(JSON.stringify(exportUserData(req.user.id), null, 2));
  } catch (e) {
    authFail(res, e);
  }
});
app.post('/api/auth/delete', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
  try {
    deleteAccount(req.user.id, req.body?.password, req.body?.reason, req.body?.details);
    clearSessionCookie(res, req.secure);
    res.json(sessionPayload(null));
  } catch (e) {
    authFail(res, e);
  }
});

// Cancel a paid plan (a reason is required) / undo. Until payments are connected this marks the plan as not renewing;
// the payment provider's cancel call goes here later.
app.post('/api/auth/cancel', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try { res.json(sessionPayload({ ...cancelPlan(req.user.id, req.body?.reason, req.body?.details), mfa: req.user.mfa })); } catch (e) { authFail(res, e); }
});
app.post('/api/auth/cancel/undo', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try { res.json(sessionPayload({ ...resumePlan(req.user.id), mfa: req.user.mfa })); } catch (e) { authFail(res, e); }
});
app.get('/api/admin/leave-feedback', (_req, res) => res.json({ data: leaveFeedback() }));

app.post('/api/auth/password', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    changePassword(req.user.id, req.body?.current, req.body?.next);
    securityLog(req, 'password_change', req.user);
    const s = createSession(req.user.id, req.headers['user-agent'], !!req.user.mfa);
    setSessionCookie(res, s.token, s.expires, req.secure);
    res.json({ ok: true });
  } catch (e) {
    authFail(res, e);
  }
});

// ---------- Admin: users and plans (payments will call setPlan later) ----------

app.get('/api/admin/users.csv', (_req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="sportlikely-users-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.send(usersCsv());
});

app.get('/api/admin/users', (_req, res) => {
  res.json({ data: listUsers(), stats: userStats() });
});

app.post('/api/admin/users/:id(\\d+)/plan', jsonOnly, (req, res) => {
  try {
    const plan = req.body?.plan === 'premium' || req.body?.plan === 'pro' ? req.body.plan : 'free';
    const untilDate = req.body?.until ? new Date(String(req.body.until)) : null;
    if (untilDate && isNaN(untilDate.getTime())) return res.status(400).json({ error: 'Invalid end date' });
    const until = untilDate ? untilDate.toISOString() : null;
    res.json({ data: setPlan(parseInt(req.params.id, 10), plan, until) });
  } catch (e) {
    authFail(res, e);
  }
});

// ---------- Plans and match unlocks (services/billing.ts) ----------
// fix144: the full prediction of a basketball / NFL game: paid plans, or a free pick spent on it (its reveal id)
const fullFor = (req: express.Request, ridOf: (id: number) => number): boolean | ((id: number) => boolean) => {
  if (isPaid(req.access || 'anon') || !req.user) return isPaid(req.access || 'anon');
  const ids = unlockedIds(req.user.id);
  return ids.size ? (id: number) => ids.has(ridOf(id)) : false;
};
const fullOne = (req: express.Request, rid: number) => isPaid(req.access || 'anon') || (!!req.user && unlockedIds(req.user.id).has(rid));

// This month's unlocks for the signed-in user: { plan, unlimited, allowance, used, left, resetsAt, testMode }
app.get('/api/unlocks', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: unlockStatus(req.user || null, req.access || 'anon') });
});
// Spend one unlock on a match. Body: { status } (finished matches are free and need no unlock)
// fix144: basketball (-id) and NFL (-(2e9 + id)) games use the same free picks
app.post('/api/unlocks/:id(-?\\d+)', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    res.json({ data: unlockMatch(req.user, req.access || 'anon', parseInt(req.params.id, 10), String(req.body?.status || '')) });
  } catch (e: any) {
    if (e instanceof AuthError) return res.status(e.status).json({ error: e.message, upgrade: !!(e as any).upgrade, data: unlockStatus(req.user, req.access || 'anon') });
    authFail(res, e);
  }
});
app.get('/api/billing/plans', (req, res) => res.json({ data: { plans: PLANS, testMode: billingTestMode, refundDays: REFUND_DAYS, freeWeekly: FREE_WEEKLY_UNLOCKS,
  // fix147: pick packs — the packs of the visitor's plan (signed out: the Free prices) and both price lists
  packs: packsFor(req.user ? req.access || 'free' : 'free'), pickPrice: PICK_PRICE, packSizes: PACK_SIZES } }));
// fix147: buy a pick pack (test mode only until the payment provider is wired; no real charge)
app.post('/api/billing/test-pack', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const r = buyPack(req.user, req.access || 'free', String(req.body?.pack || ''));
    logger.info(`Test pick pack: user #${req.user.id} +${r.pack.picks} (balance ${r.balance})`);
    res.json({ data: { ...r, status: unlockStatus(req.user, req.access || 'free') } });
  } catch (e) { authFail(res, e); }
});
// Test checkout (only while BILLING_TEST_MODE=1): switch your own plan
app.post('/api/billing/test-checkout', jsonOnly, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  try {
    const user = testCheckout(req.user, String(req.body?.plan || ''));
    logger.info(`Test checkout: user #${user.id} → ${user.plan}`);
    res.json(sessionPayload({ ...user, mfa: req.user.mfa }));
  } catch (e) {
    authFail(res, e);
  }
});
app.get('/api/admin/unlocks', (_req, res) => res.json({ data: unlockStats() }));

app.post('/api/admin/users/:id(\\d+)/password', jsonOnly, (req, res) => {
  try {
    const target = parseInt(req.params.id, 10);
    adminResetPassword(target, req.body?.password);
    securityLog(req, 'admin_set_password', req.user, `for account #${target}`);
    res.json({ ok: true });
  } catch (e) {
    authFail(res, e);
  }
});

function sendError(res: express.Response, error: any, fallback: string) {
  // fix173: no provider call allowed for this request (crawler, scraper cap, page budget): stored data only, not a failure
  if (error?.code === 'PAGE_BUDGET' || error?.code === 'NO_PROVIDER_CALL') return res.status(503).set('Retry-After', '3600').json({ error: 'More details soon', pending: true });
  const status = error?.response?.status || 500;
  const message = error?.response?.data?.message || error?.message || fallback;
  logger.error(fallback, { status, message });
  res.status(status).json({ error: fallback, message });
}

// ---------- REST ----------

// fix183: the browser's "seen" beacon (a person: page visible 5+ s and a scroll / click / key / touch). Nothing stored
// but the salted visitor hash, as for every visit; always 204 so the answer tells a script nothing.
app.post('/api/visit/seen', (req, res) => {
  try { visitSeen(req, (req as any).crawlerClaim ?? null); } catch { /* never fails the page */ }
  res.status(204).end();
});

// fix212b: + the start-up load (ready, when, how long) and this process's stalls since it was ready; fix218: + the
// requests over 500 ms since ready, and /health answers the same (Railway's check; 503 before the state is loaded)
const health = (_req: express.Request, res: express.Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime(), ...readiness(), stallsSinceReady: stallsSinceReady(), slowSinceReady: slowSinceReady() });
};
app.get('/api/health', health);
app.get('/health', health);

// Upcoming + live matches. ?days=30 (1-30). Served from memory.
/*
 * fix196: stale-while-revalidate (one build at a time, in slices). fix202: a stored page (pageCache.ts): the worker
 * builds it (on start, every 30 s and right after each fixture-window refresh), a request sends the stored copy —
 * signed-out visitors and paid plans a ready-made string, everyone else through res.json (the trims above).
 */
async function buildUpcoming(days: number): Promise<any> {
  // fix202: no Football-Data.org window (provider down at start): the other competitions are still listed
  const raw = (await footballDataAPI.getUpcomingMatches(days).catch(() => [] as any[])).map(withLiveScore);
  const fd = await inBatches(raw, 5, b => footballDataAPI.withPredictions(b));
  // + extra competitions from API-Football (national teams, cups, more leagues)
  const af = await inBatches(afUpcoming(days), 5, b => afWithPredictions(b));
  await yieldLoop();
  const matches = [...fd, ...af].sort((a: any, b: any) => a.utcDate.localeCompare(b.utcDate));
  const data = await inBatches(matches, 50, b => b.map(slimForList));
  await yieldLoop();
  return { data, count: matches.length, days, cacheAgeMs: footballDataAPI.windowAge, timestamp: new Date().toISOString() };
}
// fix221: stored row by row ('anon' / 'full' made from the rows; a member's unlocked games joined in by the web process)
definePage({ name: 'upcoming', freshMs: 30 * 1000, build: q => buildUpcoming(Number(q.days) || 30), rows: b => listRows(b), warm: [{ days: 14 }, { days: 30 }] });
app.get('/api/matches/upcoming', async (req, res) => {
  try {
    // fix238: only the two stored copies (14 / 30 days, warm): any other number was a key never built — the web waited
    // for the worker ("stored upcoming: read 1,579 ms"); a shorter ask gets the 14-day copy (a few more games)
    const days = (parseInt(String(req.query.days || '30'), 10) || 30) <= 14 ? 14 : 30;
    const access = req.access || 'anon';
    // signed-in Free / Premium: their unlocked games in full (finished games are in full for everyone)
    if (req.user && !canSeeFull(access)) return await sendStored(req, res, 'upcoming', { days }, 'anon', unlockedIds(req.user.id));
    await sendStored(req, res, 'upcoming', { days }, matchView(req));
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch upcoming matches');
  }
});

app.get('/api/matches/live', async (_req, res) => {
  try {
    // fix202: the web process sends the worker's last live list (the same list the socket pushes)
    const matches = isWeb ? liveList('football')
      : [...footballDataAPI.withPredictions((await footballDataAPI.getLiveMatches()).map(withLiveScore)), ...afWithPredictions(afLive())].map(slimForList);
    res.json({ data: matches, count: matches.length, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch live matches');
  }
});

// fix243: a past season's match is admin-only: its game APIs answer 410 for everyone else (the worker answers these)
const PAST_GAME_API = /^\/api\/(?:(matches)|basketball\/(game)|nfl\/(game)|tennis\/(match))\/(\d+)(?:\/[a-z0-9/]+)?$/;
app.use((req, res, next) => {
  if (isWeb || req.method !== 'GET' || req.access === 'admin') return next();
  const m = PAST_GAME_API.exec(req.path);
  if (!m) return next();
  const sport = m[1] ? 'football' : m[2] ? 'basketball' : m[3] ? 'american-football' : 'tennis';
  return pastMatch(sport, m[5]) ? pastGone(res) : next();
});
app.get('/api/matches/:id(\\d+)', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isAfMatchId(id) && !isKnownAfFixture(id)) return res.status(404).json({ error: 'Match not found' });
    const match = isAfMatchId(id) ? (await getAfMatchDetails(id)).match : withLiveScore(await footballDataAPI.getMatch(id));
    res.json({ data: match, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch match');
  }
});

// Everything for the match page: match + events + lineups + stats + h2h + standings + form
// Official highlights (YouTube) for a finished match we tracked. Names and date come from our own saved prediction,
// so only real matches can trigger a search (protects the YouTube quota).
app.get('/api/matches/:id(\\d+)/highlights', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row: any = db.prepare(`
      SELECT p.match_id AS id, p.utc_date, p.home_team, p.away_team, r.outcome
      FROM predictions p LEFT JOIN results r ON r.match_id = p.match_id
      WHERE p.match_id = ? LIMIT 1`).get(id);
    if (!row || !row.outcome || !['H', 'D', 'A'].includes(row.outcome)) { res.json({ data: null, timestamp: new Date().toISOString() }); return; }
    const h = await highlightsFor({ id, status: 'FINISHED', utcDate: row.utc_date, homeTeam: { name: row.home_team }, awayTeam: { name: row.away_team } });
    res.json({ data: h, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch highlights');
  }
});
// Admin: search again now and show what YouTube returned (to tune the official-channel list)
app.get('/api/highlights/debug', async (req, res) => {
  const id = Number(req.query.id);
  const row: any = db.prepare(`SELECT match_id, utc_date, home_team, away_team FROM predictions WHERE match_id = ? LIMIT 1`).get(id);
  if (!row) { res.status(404).json({ error: 'not tracked' }); return; }
  const h = await highlightsFor({ id, status: 'FINISHED', utcDate: row.utc_date, homeTeam: { name: row.home_team }, awayTeam: { name: row.away_team } }, true);
  res.json({ data: { found: h, search: lastCandidates }, timestamp: new Date().toISOString() });
});
// Player quality (v3 row #1p): rebuild from af_player_season, and inspect
app.get('/api/model/v3/player-quality/rebuild', (req, res) => {
  try {
    const k = req.query.k !== undefined ? Number(req.query.k) : 0.5;
    res.json({ data: rebuildPlayerQuality([2025, 2026], Number.isFinite(k) ? k : 0.5), timestamp: new Date().toISOString() });
  } catch (e: any) { sendError(res, e, 'Player quality rebuild failed'); }
});
app.get('/api/model/v3/player-quality', (req, res) => {
  res.json({ data: playerQualityTable(Number(req.query.season) || 2026, req.query.grp ? String(req.query.grp) : undefined), timestamp: new Date().toISOString() });
});
app.get('/api/highlights/status', (_req, res) => {
  res.json({ data: highlightsStatus(), timestamp: new Date().toISOString() });
});

/** fix209: API-Football's events on a Football-Data.org match: its goals when they name more of the score, its cards
 *  when FD has none, VAR decisions and missed penalties (FD has neither). */
function withAfEvents(m: any, ev: any) {
  if (!ev) return;
  const goals = betterGoals(m, ev.goals);
  if (goals !== (m.goals || [])) m.goals = goals;
  if (!(m.bookings?.length) && ev.bookings?.length) m.bookings = ev.bookings;
  if (!(m.substitutions?.length) && ev.substitutions?.length) m.substitutions = ev.substitutions;
  if (ev.varEvents?.length) m.varEvents = ev.varEvents;
  if (ev.missedPens?.length) m.missedPens = ev.missedPens;
}

/** Everything for the match page (match, events, lineups, stats, h2h, prediction, live chance, preview). */
async function buildMatchDetails(id: number): Promise<any> {
  const details: any = isAfMatchId(id) ? await getAfMatchDetails(id) : await footballDataAPI.getMatchDetails(id);
  // Football-Data.org has no statistics / lineups on our plan: fill them from API-Football (free for everyone)
  if (!isAfMatchId(id)) {
    try {
      const x = await afExtrasForFd(details.match);
      if (x) {
        const m = (details.match = { ...details.match, homeTeam: { ...details.match.homeTeam }, awayTeam: { ...details.match.awayTeam } });
        for (const [side, t] of [['homeTeam', x.home], ['awayTeam', x.away]] as const) {
          const cur = m[side];
          const hasStats = cur.statistics && typeof cur.statistics === 'object' && !('msg' in cur.statistics) && Object.keys(cur.statistics).length;
          if (!hasStats && t.statistics && Object.keys(t.statistics).length) cur.statistics = t.statistics;
          if (!(cur.lineup?.length) && t.lineup.length) {
            cur.lineup = t.lineup;
            cur.bench = t.bench;
            cur.formation = cur.formation || t.formation;
            cur.coach = cur.coach?.name ? cur.coach : t.coach;
          }
        }
        if ((m.minute === null || m.minute === undefined) && x.minute !== null) m.minute = x.minute;
        if (m.homeTeam.lineup?.length) details.probableLineups = null;
        withAfEvents(m, x.events);
      }
    } catch (e: any) {
      logger.warn('Live extras failed', { id, message: e.message });
    }
  }
  // one live score everywhere: the fresher of API-Football / Football-Data.org, as in the list (liveScores.ts)
  if (!isAfMatchId(id) && details?.match) details.match = withLiveScore(details.match);
  // live win chance on the match page (uses the red cards and minute filled in above)
  if (details?.match && details.prediction) {
    const lv = withLive({ ...details.match, prediction: details.prediction, predictions: details.predictions });
    details.prediction = lv.prediction;
    details.predictions = lv.predictions;
  }
  // SEO match preview (fix121): written from the details we just loaded, cached per match; never the pick or a %
  if (details?.match) {
    const pv = refreshFromDetails(details);
    details.preview = pv ? { text: pv.text, builtAt: pv.builtAt, title: pv.title } : null;
  }
  return details;
}

// fix122: match details cached per match — 60 s while the game is on, 5 min otherwise. A stale copy is served at once
// and refreshed in the background (stale-while-revalidate); only the first open of a match waits for the build.
// The cached object is shared: per-visitor trimming (teaser / no bookmakers) copies it in res.json.
const detailsCache = new Map<number, { at: number; ttl: number; data: any; refreshing: boolean; startedAt: number }>();
const LIVE_ST = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);
const detailsTtl = (d: any) => (LIVE_ST.has(String(d?.match?.status)) ? 60 * 1000 : 5 * 60 * 1000);

/**
 * fix165: the live state (status, minute, score, half-time) is applied when a response is SENT, from the same live
 * book the live list uses (Football-Data.org matches) or the last API-Football live poll (API-Football matches), and the
 * live win chance is recomputed from it. A cached copy can be a minute old; the score and minute it shows never are.
 */
function liveNow(id: number, data: any) {
  const m0 = data?.match;
  if (!m0) return data;
  // fix209: the scorers check's events when they name more goals than the copy we hold (a goal named after it was built)
  const m = goalEventsOverlay(isAfMatchId(id) ? afLiveOverlay(m0) : withLiveScore(m0));
  if (m === m0) return data;
  const out = { ...data, match: m };
  if (data.prediction) {
    const lv = withLive({ ...m, prediction: data.prediction, predictions: data.predictions });
    out.prediction = lv.prediction;
    out.predictions = lv.predictions;
  }
  return out;
}

/** fix165: while the Football-Data.org minute quota is used up, a live match refreshes from what API-Football gives us
 *  (statistics, lineups) on top of the last copy — never waiting in FD's queue. */
async function lightRefresh(prev: any) {
  const x = await afExtrasForFd(prev.match);
  const m = { ...prev.match, homeTeam: { ...prev.match.homeTeam }, awayTeam: { ...prev.match.awayTeam } };
  if (x) {
    for (const [side, t] of [['homeTeam', x.home], ['awayTeam', x.away]] as const) {
      const cur = m[side];
      if (t.statistics && Object.keys(t.statistics).length) cur.statistics = t.statistics; // live: always the fresh numbers
      if (!(cur.lineup?.length) && t.lineup.length) { cur.lineup = t.lineup; cur.bench = t.bench; cur.formation = cur.formation || t.formation; cur.coach = cur.coach?.name ? cur.coach : t.coach; }
    }
    if (x.minute !== null) m.minute = x.minute;
    withAfEvents(m, x.events);
  }
  return { ...prev, match: m };
}

const withTimeoutMs = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(Object.assign(new Error('timed out'), { timeout: true })), ms))]);

/*
 * fix177: a details request never answers 500 because a provider is slow (30 parallel opens of past matches queued in
 * Football-Data.org's rate limit and timed out):
 *  - a finished match's details are kept for good (match_details_store, from 6 h after kick-off): never rebuilt;
 *  - a first open waits 8 s at most; then it gets what we hold (match, result, saved prediction) + "More details soon"
 *    while the build goes on in ONE background queue (one build at a time, under the provider's rate limit);
 *  - one build per match at a time (requests share it).
 */
db.exec(`CREATE TABLE IF NOT EXISTS match_details_store (match_id INTEGER PRIMARY KEY, json TEXT NOT NULL, built_at TEXT NOT NULL)`);
const FINAL_ST = new Set(['FINISHED', 'AWARDED']);
const isSettled = (d: any) => FINAL_ST.has(String(d?.match?.status)) && Date.parse(d?.match?.utcDate || '') < Date.now() - 6 * 3600 * 1000;
function storedDetails(id: number): any | null {
  try { const r = db.prepare(`SELECT json FROM match_details_store WHERE match_id = ?`).get(id) as any; return r ? JSON.parse(r.json) : null; } catch { return null; }
}
/** What we hold without a provider call: the match from our saved predictions + its result, and the saved prediction. */
function offlineDetails(id: number): any | null {
  const p = db.prepare(`SELECT match_id, utc_date, competition_code, competition_name, home_team_id, home_team, away_team_id, away_team FROM predictions WHERE match_id = ? LIMIT 1`).get(id) as any;
  if (!p) return null;
  const r = db.prepare(`SELECT home_goals, away_goals, outcome FROM results WHERE match_id = ? LIMIT 1`).get(id) as any;
  const done = !!r && ['H', 'D', 'A'].includes(r.outcome);
  const match: any = {
    id, utcDate: p.utc_date, status: done ? 'FINISHED' : Date.parse(p.utc_date) > Date.now() ? 'TIMED' : 'IN_PLAY',
    competition: { code: p.competition_code, name: p.competition_name },
    homeTeam: { id: p.home_team_id, name: p.home_team, shortName: p.home_team }, awayTeam: { id: p.away_team_id, name: p.away_team, shortName: p.away_team },
    score: { winner: done ? ({ H: 'HOME_TEAM', D: 'DRAW', A: 'AWAY_TEAM' } as any)[r.outcome] : null, fullTime: { home: done ? r.home_goals : null, away: done ? r.away_goals : null } },
    goals: [], bookings: [], substitutions: []
  };
  let prediction: any = null, predictions: any[] = [];
  try { predictions = footballDataAPI.allPredictionsFor(match); prediction = footballDataAPI.predictionFor(match); } catch { /* none saved */ }
  return { match, prediction, predictions, head2head: null, standings: { home: null, away: null }, form: { home: [], away: [] }, probableLineups: null, partial: true, message: 'More details soon' };
}
const detailsInflight = new Map<number, Promise<any>>();
function buildOnce(id: number): Promise<any> {
  let run = detailsInflight.get(id);
  if (!run) {
    run = refreshMatchDetails(id).finally(() => detailsInflight.delete(id));
    detailsInflight.set(id, run);
  }
  return run;
}
const detailsQueue = new Set<number>();
let detailsWorker = false;
/** One background build at a time (60 s each at most). */
function queueDetails(id: number) {
  detailsQueue.add(id);
  if (detailsWorker) return;
  detailsWorker = true;
  void (async () => {
    while (detailsQueue.size) {
      const next = detailsQueue.values().next().value as number;
      detailsQueue.delete(next);
      if (detailsCache.has(next)) continue;
      try { await withTimeoutMs(buildOnce(next), 60 * 1000); } catch (e: any) { logger.warn(`details queue ${next}: ${e?.timeout ? 'timed out' : e?.message}`); }
    }
    detailsWorker = false;
  })();
}

function storeDetails(id: number, data: any, startedAt: number) {
  const cur = detailsCache.get(id);
  if (cur && cur.at > startedAt) return; // a newer copy is already there (a late refresh never overwrites it)
  // fix209: a finished page whose goals are not all named is not stored for good (rebuilt every 5 min until they are)
  const settled = isSettled(data) && scorersComplete(data?.match);
  noteServedScorers(data?.match);
  if (settled && !data?.partial) {
    try { db.prepare(`INSERT OR REPLACE INTO match_details_store (match_id, json, built_at) VALUES (?, ?, ?)`).run(id, JSON.stringify(data), new Date().toISOString()); } catch (e: any) { logger.warn(`details store ${id}: ${e.message}`); }
  }
  detailsCache.set(id, { at: Date.now(), ttl: settled ? Infinity : detailsTtl(data), data, refreshing: false, startedAt: 0 });
  // fix210: capped low (the page is also stored in the database; the worker answers every page request)
  if (detailsCache.size > 300) { const oldest = [...detailsCache.entries()].sort((x, y) => x[1].at - y[1].at)[0]; if (oldest) detailsCache.delete(oldest[0]); }
}
async function refreshMatchDetails(id: number) {
  const t0 = Date.now();
  const data = await withTimeoutMs(buildMatchDetails(id), 25 * 1000);
  storeDetails(id, data, t0);
  return data;
}
/** A background refresh of a cached copy: 25 s at most; one stuck for 2 min is reset and started again. */
function startRefresh(id: number, hit: { at: number; data: any; refreshing: boolean; startedAt: number }) {
  if (hit.refreshing && Date.now() - hit.startedAt < 2 * 60 * 1000) return;
  if (hit.refreshing) logger.warn(`details refresh stuck id=${id} age=${Math.round((Date.now() - hit.at) / 1000)}s: started again`);
  const t0 = Date.now();
  hit.refreshing = true;
  hit.startedAt = t0;
  const live = LIVE_ST.has(String(hit.data?.match?.status));
  // fix169: under its own label (it runs after the response, outside the request's label)
  const job = timed('details refresh', () => (live && !isAfMatchId(id) && footballDataAPI.quotaBusy ? lightRefresh(hit.data) : buildMatchDetails(id)));
  withTimeoutMs(job, 25 * 1000)
    .then(data => storeDetails(id, data, t0))
    .catch(e => {
      hit.refreshing = false;
      logger.warn(`details refresh ${e?.timeout ? 'timed out' : 'failed'} id=${id} age=${Math.round((Date.now() - hit.at) / 1000)}s${e?.timeout ? '' : `: ${e?.message}`}`);
    });
}

app.get('/api/matches/:id(\\d+)/details', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isAfMatchId(id) && !isKnownAfFixture(id)) return res.status(404).json({ error: 'Match not found' });
    const hit = detailsCache.get(id);
    if (hit) {
      if (Date.now() - hit.at > hit.ttl) startRefresh(id, hit);
      return res.json({ data: liveNow(id, hit.data), timestamp: new Date(hit.at).toISOString(), cached: true });
    }
    // fix177: a finished match we kept — never rebuilt
    const kept = storedDetails(id);
    if (kept) {
      detailsCache.set(id, { at: Date.now(), ttl: Infinity, data: kept, refreshing: false, startedAt: 0 });
      return res.json({ data: liveNow(id, kept), timestamp: new Date().toISOString(), cached: true });
    }
    try {
      const details = await withTimeoutMs(buildOnce(id), 8 * 1000);
      return res.json({ data: liveNow(id, details), timestamp: new Date().toISOString() });
    } catch (e: any) {
      if (e?.response?.status === 404) throw e;
      // slow or failing provider: what we hold now, the full page from the background queue
      const off = offlineDetails(id);
      if (!off) throw e;
      if (!e?.timeout) logger.warn(`details ${id}: ${e?.message} — served what we hold`);
      queueDetails(id);
      return res.json({ data: liveNow(id, off), timestamp: new Date().toISOString(), pending: true, message: 'More details soon' });
    }
  } catch (error: any) {
    if (error?.code === 'PAGE_BUDGET' || error?.code === 'NO_PROVIDER_CALL') return res.json({ data: null, pending: true, message: 'More details soon' });
    sendError(res, error, 'Failed to fetch match details');
  }
});

/**
 * fix209 — a list row opened with its arrow: the match's goals and cards only (the row builds the scorers line), from
 * the copy the match page holds or keeps, else the scorers check's events. Never a provider call: a match we hold
 * nothing for is queued for a build ("pending", the row asks again).
 */
app.get('/api/matches/:id(\\d+)/scorers', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const hit = detailsCache.get(id);
    const data = hit ? liveNow(id, hit.data) : (() => { const k = storedDetails(id); return k ? liveNow(id, k) : null; })();
    let m: any = data?.match || null;
    if (!m) {
      const off = offlineDetails(id);
      if (off) m = liveNow(id, off).match;
      if (!m?.goals?.length) queueDetails(id);
    } else if (hit && Date.now() - hit.at > hit.ttl) startRefresh(id, hit);
    if (!m) return res.json({ data: null, pending: true });
    res.json({ data: { id, status: m.status, homeTeam: { id: m.homeTeam?.id }, awayTeam: { id: m.awayTeam?.id }, score: { fullTime: m.score?.fullTime || { home: null, away: null } }, goals: m.goals || [], bookings: (m.bookings || []).filter((b: any) => b.card !== 'YELLOW') } });
  } catch (error: any) { sendError(res, error, 'Failed to fetch scorers'); }
});

/**
 * fix165 — admin: every live match, the live list's score / minute against what /details sends (and the raw cached
 * copy), with the cache age. Flags a score difference or a minute more than 1 apart.
 */
app.get('/api/admin/live-consistency', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const lastLiveList = liveList('football'), lastLiveAt = liveAt('football');
  const rows = lastLiveList.map((l: any) => {
    const hit = detailsCache.get(l.id);
    const sent = hit ? liveNow(l.id, hit.data)?.match : null;
    const score = (m: any) => (m ? `${m.score?.fullTime?.home ?? '-'}-${m.score?.fullTime?.away ?? '-'}` : null);
    const list = { status: l.status, minute: l.minute ?? null, score: score(l) };
    const details = sent ? { status: sent.status, minute: sent.minute ?? null, score: score(sent) } : null;
    const cached = hit ? { minute: hit.data?.match?.minute ?? null, score: score(hit.data?.match), ageSec: Math.round((now - hit.at) / 1000), refreshing: hit.refreshing } : null;
    const off = !!details && (details.score !== list.score || (list.minute !== null && details.minute !== null && Math.abs(list.minute - details.minute) > 1));
    return { id: l.id, match: `${l.homeTeam?.shortName || l.homeTeam?.name} – ${l.awayTeam?.shortName || l.awayTeam?.name}`, list, details, cached, off };
  });
  res.json({ data: { liveListAgeSec: lastLiveAt ? Math.round((now - lastLiveAt) / 1000) : null, live: rows.length, off: rows.filter(r => r.off).length, rows }, timestamp: new Date().toISOString() });
});

// Match page tabs, loaded when the tab opens (API-Football, cached; first view of a team can take a few seconds):
//   stats   → each team's averages over its last 10 games
//   lineups → the XI we expect from each team's last 5 lineups
//   h2h     → the last 10 meetings, however long ago
//   rest    → schedule & rest: days since the last game, games in the last 14/30 days, the next game
//   (lineups also carries the injured / doubtful players listed for the fixture)
app.get('/api/matches/:id(\\d+)/extras/:part(stats|lineups|h2h|rest)', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    let info: { fid: number; home: number; away: number; kickoff: string } | null;
    if (id >= AF_OFFSET) {
      if (!isKnownAfFixture(id)) return res.status(404).json({ error: 'Match not found' });
      info = await afFixtureInfo({ id });
    } else {
      const match = await footballDataAPI.getMatch(id);
      info = match ? await afFixtureInfo(match) : null;
    }
    if (!info) return res.json({ data: null, timestamp: new Date().toISOString() });
    const teams = { home: info.home, away: info.away };
    let data: any;
    if (req.params.part === 'stats') {
      const [home, away] = [await teamAverages(teams.home, 10), await teamAverages(teams.away, 10)];
      data = { home, away };
    } else if (req.params.part === 'lineups') {
      const [home, away] = [await probableXI(teams.home, 5), await probableXI(teams.away, 5)];
      let injuries: any = null;
      try { injuries = await fixtureInjuriesRated(info.fid, teams.home, teams.away); } catch { /* no injury list for this league */ }
      data = { home, away, injuries };
    } else if (req.params.part === 'rest') {
      const [home, away] = await Promise.all([teamSchedule(teams.home, info.kickoff), teamSchedule(teams.away, info.kickoff)]);
      data = { kickoff: info.kickoff, home, away };
    } else {
      data = await lastMeetings(teams.home, teams.away);
    }
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch match extras');
  }
});

app.get('/api/matches/:id(\\d+)/head2head', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isAfMatchId(id) && !isKnownAfFixture(id)) return res.status(404).json({ error: 'Match not found' });
    const h2h = isAfMatchId(id) ? (await getAfMatchDetails(id)).head2head : await footballDataAPI.getHeadToHead(id);
    res.json({ data: h2h, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch head-to-head');
  }
});

app.get('/api/leagues', async (_req, res) => {
  try {
    // fix176: a league listed by both providers appears once (BSA → AF71, the one with the predictions)
    const leagues = [...(await footballDataAPI.getLeagues()), ...afCompetitions()].filter((l: any) => !MERGED_LEAGUES[l.code]);
    res.json({ data: leagues, count: leagues.length, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch leagues');
  }
});

/**
 * fix176: Football-Data.org tournaments between editions (EC, WC) answer 404: their API-Football twin then gives the
 * latest edition, and the page never gets an error (no table = data null).
 */
const AF_TWIN: Record<string, string> = { EC: 'AF4', WC: 'AF1' };
app.get('/api/leagues/:code/standings', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    let standings: any;
    try { standings = isAfCode(code) ? await getAfStandings(code) : await footballDataAPI.getStandings(code); }
    catch (e: any) {
      if (!AF_TWIN[code]) throw e;
      standings = await getAfStandings(AF_TWIN[code]).catch(() => null);
    }
    if (!standings) return res.json({ data: null, timestamp: new Date().toISOString() });
    // Football-Data.org tables come without form on our plan: add it from the finished matches (newest first)
    if (!isAfCode(code) && standings?.standings?.some((t: any) => t.table?.some((r: any) => !r.form))) {
      try {
        const form = await footballDataAPI.getForm(code);
        standings.standings = standings.standings.map((t: any) => ({ ...t, table: (t.table || []).map((r: any) => ({ ...r, form: r.form || form.get(r.team?.id) || null })) }));
      } catch (e: any) {
        logger.warn(`form ${code}: ${e.message}`);
      }
    }
    res.json({ data: standings, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch standings');
  }
});

// Latest played edition of any API-Football competition (results + winner), for competitions outside our window
app.get('/api/leagues/:code/results', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const af = isAfCode(code) ? code : AF_TWIN[code]; // fix176: EC / WC → their latest edition
    if (!af) return res.json({ data: null, timestamp: new Date().toISOString() });
    res.json({ data: await getAfRecent(af), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch results');
  }
});

app.get('/api/leagues/:code/scorers', async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || '40'), 10) || 40;
    const code = req.params.code.toUpperCase();
    let scorers: any;
    try { scorers = isAfCode(code) ? await getAfScorers(code, limit) : await footballDataAPI.getScorers(code, limit); }
    catch (e: any) {
      if (!AF_TWIN[code]) throw e;
      scorers = await getAfScorers(AF_TWIN[code], limit).catch(() => ({ scorers: [] })); // fix176: between editions
    }
    res.json({ data: scorers, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch scorers');
  }
});

app.get('/api/teams/:id(\\d+)', async (req, res) => {
  try {
    const team = await footballDataAPI.getTeam(parseInt(req.params.id, 10));
    res.json({ data: team, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch team');
  }
});

// ---------- Team pages, search, news, public summary ----------

// Team page: /api/team-page/<site team id>?c=<competition code>&n=<team name> (FD teams are resolved to API-Football)
app.get('/api/team-page/:id(\\d+)', async (req, res) => {
  try {
    const afId = resolveAfTeamId(parseInt(req.params.id, 10), req.query.c ? String(req.query.c) : undefined, req.query.n ? String(req.query.n) : undefined);
    if (!afId) return res.status(404).json({ error: 'Team not found' });
    res.json({ data: await crawlerSafe(() => teamPage(afId, isPaid(req.access || 'anon'), req.query.c ? String(req.query.c) : undefined)), timestamp: new Date().toISOString() });
  } catch (error: any) {
    if (error?.code === 'PAGE_BUDGET' || error?.code === 'NO_PROVIDER_CALL') return res.json({ data: null, pending: true, message: 'More details soon' });
    sendError(res, error, 'Team page failed');
  }
});

// Player page: /api/player-page/<API-Football player id>; /api/player-page/find?name=&team=<site team id>&c=&n= → { id }
app.get('/api/player-page/find', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const team = parseInt(String(req.query.team || ''), 10);
    if (!name || !team) return res.status(400).json({ error: 'name and team are required' });
    const id = await crawlerSafe(() => findPlayer(name, team, req.query.c ? String(req.query.c) : undefined, req.query.n ? String(req.query.n) : undefined));
    if (!id) return res.status(404).json({ error: 'Player not found' });
    res.json({ data: { id }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    if (error?.code === 'PAGE_BUDGET' || error?.code === 'NO_PROVIDER_CALL') return res.json({ data: null, pending: true, message: 'More details soon' });
    sendError(res, error, 'Player lookup failed');
  }
});
app.get('/api/player-page/:id(\\d+)', async (req, res) => {
  try {
    res.json({ data: await crawlerSafe(() => playerPage(parseInt(req.params.id, 10), isPaid(req.access || 'anon'))), timestamp: new Date().toISOString() });
  } catch (error: any) {
    if (error?.code === 'PAGE_BUDGET' || error?.code === 'NO_PROVIDER_CALL') return res.json({ data: null, pending: true, message: 'More details soon' });
    // fix169: an old link to a player the provider doesn't have (crawlers): a quiet 404, one warning per id, never indexed
    if ((error?.response?.status || error?.status) === 404) {
      const id = parseInt(req.params.id, 10);
      if (markMissingPlayer(id)) logger.warn(`player page: no player ${id} (old link): 404, noindex`);
      return res.status(404).json({ error: 'Player not found' });
    }
    sendError(res, error, 'Player page failed');
  }
});

// Admin: upset alerts research (read-only): /api/backtest/upsets?grid=1[&K=&cut=&minGap=&minEdge=&maxEdge=]
app.get('/api/backtest/upsets', (req, res) => {
  try {
    const rule: Record<string, number> = {};
    for (const k of ['K', 'cut', 'minGap', 'minEdge', 'maxEdge']) { const v = Number(req.query[k]); if (req.query[k] !== undefined && Number.isFinite(v)) rule[k] = v; }
    res.json({ data: { ...backtestUpsets(rule, req.query.grid === '1'), watch: upsetWatchBacktest() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Upset backtest failed');
  }
});

// Admin: live win chance tested at half-time. ?sync=1 first downloads the half-time scores (football-data.co.uk);
// ?tune=1 adds a grid over late / lead / corrPow; ?late=&lead=&corrPow= try other values (nothing is changed live)
app.get('/api/backtest/live-ht', async (req, res) => {
  try {
    const sync = req.query.sync === '1' ? await syncHalfTimes() : undefined;
    const conf: Record<string, number> = {};
    for (const k of ['late', 'lead', 'corrPow', 'minRem']) { const v = Number(req.query[k]); if (req.query[k] !== undefined && Number.isFinite(v)) conf[k] = v; }
    res.json({ data: { sync: sync && { total: sync.total, errors: sync.errors }, ...liveHalfTimeTest(conf, req.query.tune === '1') }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Live half-time test failed');
  }
});

// Admin: goals calibration test (read-only): /api/model/goals-calibration?seasons=2526,2627&groups=1
app.get('/api/model/goals-calibration', (req, res) => {
  try {
    const seasons = String(req.query.seasons || '2526,2627').split(',').map(x => x.trim()).filter(x => /^\d{4}$/.test(x));
    res.json({ data: goalsCalibration(seasons.length ? seasons : ['2526', '2627'], req.query.groups === '1'), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Goals calibration failed');
  }
});

// Admin: data health — every feed's age and the validity checks (see services/dataHealth.ts).
// fix200: never computed on request (5.8 s stalls): the stored copy of the 5-minute background job, with its "at" time
app.get('/api/data-health', (_req, res) => {
  try {
    res.json({ data: storedDataHealth(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Data health failed');
  }
});

// Admin: weekly data check (player pages vs the official scorer lists). GET → last report; /run → run it now.
app.get('/api/data-audit', (_req, res) => res.json({ data: lastDataAudit(), timestamp: new Date().toISOString() }));
app.get('/api/data-audit/run', async (req, res) => {
  try {
    // ?bg=1: start it and answer straight away (the full check takes several minutes); the result shows in Data health
    if (req.query.bg === '1') {
      runDataAudit(req.query.email !== '0').catch(e => logger.warn(`data check: ${e.message}`));
      return res.json({ data: { started: true }, timestamp: new Date().toISOString() });
    }
    res.json({ data: await runDataAudit(req.query.email !== '0'), timestamp: new Date().toISOString() });
  } catch (error: any) {
    res.status(409).json({ error: error.message });
  }
});

// Admin: correct a team fact the provider has wrong (venue, city, capacity, founded, name). Site team id or AF id.
//   GET /api/team-overrides                       → all corrections
//   GET /api/team-overrides?id=1000000529&field=capacity&value=62000   (empty value = remove)
const teamOverrideHandler = (req: express.Request, res: express.Response) => {
  try {
    const q: any = { ...(req.query || {}), ...(req.body || {}) };
    if (!q.id) return res.json({ data: teamOverrides() });
    const raw = parseInt(String(q.id), 10);
    const afId = raw >= 1_000_000_000 ? raw - 1_000_000_000 : raw;
    if (!q.field) return res.json({ data: teamOverrides(afId) });
    res.json({ data: setTeamOverride(afId, String(q.field), q.value === undefined ? null : String(q.value)) });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};
app.get('/api/team-overrides', teamOverrideHandler);
app.post('/api/team-overrides', teamOverrideHandler);

// Search: teams (every club and national team we track) + upcoming / live matches of those teams
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ data: { teams: [], matches: [], competitions: [], players: [] } });
    const teams = searchTeams(q, 8);
    let players = searchPlayers(q, 6);
    if (players.length < 2) {
      const seen = new Set(players.map(p => p.id));
      players = [...players, ...(await searchPlayersRemote(q, 6)).filter(p => !seen.has(p.id))].slice(0, 6);
    }
    const norm = normalizeName(q);
    // competitions: every league / cup / national-team competition on the site (name, code or country)
    const leagues: any[] = [...(await footballDataAPI.getLeagues().catch(() => [] as any[])), ...afCompetitions()].filter((l: any) => !MERGED_LEAGUES[l.code]);
    const competitions = leagues
      .map((l: any) => {
        const hay = [l.name, l.code, l.area?.name, l.country].filter(Boolean).map((x: string) => normalizeName(x));
        const score = hay.some(h => h === norm) ? 3 : hay.some(h => h.startsWith(norm)) ? 2 : hay.some(h => h.includes(norm)) ? 1 : 0;
        return { l, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.l.rank ?? 9) - (b.l.rank ?? 9))
      .slice(0, 6)
      .map(({ l }) => ({ code: l.code, name: l.name, emblem: l.emblem || null, country: l.area?.name || l.country || null }));
    const upcoming = [...(await footballDataAPI.getUpcomingMatches(14).catch(() => [] as any[])), ...afUpcoming(14)];
    // "barcelona" → FC Barcelona's games first; "RCD Espanyol de Barcelona" only matches on a later word, so it ranks lower
    const CLUB_WORDS = new Set(['fc', 'cf', 'afc', 'rcd', 'cd', 'ud', 'sd', 'sc', 'ac', 'as', 'ss', 'ssc', 'us', 'fk', 'sk', 'bk', 'if', 'club', 'de', 'real']);
    const teamHit = (n?: string) => {
      if (!n) return 0;
      const x = normalizeName(n);
      if (!x.includes(norm)) return 0;
      const core = x.split(' ').filter(w => !CLUB_WORDS.has(w)).join(' ');
      return x === norm || x.startsWith(norm) || core.startsWith(norm) ? 2 : 1;
    };
    const hit = (m: any) => Math.max(...[m.homeTeam?.name, m.homeTeam?.shortName, m.awayTeam?.name, m.awayTeam?.shortName].map(teamHit));
    const scored = upcoming.map((m: any) => ({ m, h: hit(m) })).filter(x => x.h > 0);
    const best = Math.max(0, ...scored.map(x => x.h));
    const matches = scored
      .filter(x => x.h === best)
      .map(x => x.m)
      .sort((a: any, b: any) => a.utcDate.localeCompare(b.utcDate))
      .slice(0, 6)
      .map((m: any) => ({ id: m.id, utcDate: m.utcDate, status: m.status, competition: m.competition?.name, home: m.homeTeam?.shortName || m.homeTeam?.name, away: m.awayTeam?.shortName || m.awayTeam?.name, homeCrest: m.homeTeam?.crest, awayCrest: m.awayTeam?.crest }));
    // basketball: teams, players (any order of first / last name), leagues and coming games — when the section is open to this visitor
    let basketball: any = null;
    if (bbPublic() || req.access === 'admin') { try { basketball = bbSearch(q); } catch { basketball = null; } }
    // fix144: NFL + college football teams, players and coming games, same shape
    let americanFootball: any = null;
    if (nflPublic() || req.access === 'admin') { try { americanFootball = nflSearch(q); } catch { americanFootball = null; } }
    // fix193b: tennis players, tournaments and coming matches, same shape
    let tennis: any = null;
    if (tennisPublic() || req.access === 'admin') { try { tennis = tennisSearch(q, req.access === 'admin'); } catch { tennis = null; } }
    res.json({ data: { teams, players, matches, competitions, basketball, americanFootball, tennis }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Search failed');
  }
});

// fix229: clean links. The app's exception list per sport (stored by the worker, ETag), slug → id and id → slug for a
// page (the web process reads its state; anything outside it is asked of the worker, which reads the table)
const linkSport = (s: string): s is LinkSport => (LINK_SPORTS as readonly string[]).includes(s);
const linkKind = (k: string): k is LinkKind => (LINK_KINDS as readonly string[]).includes(k);
const slugEtags = new Map<string, { text: string; etag: string }>();
const sendSlugs = (req: express.Request, res: express.Response, text: string | null) => {
  if (!text) return res.status(503).set('Retry-After', '30').json({ error: 'Not ready yet' });
  const k = req.path;
  let e = slugEtags.get(k);
  if (!e || e.text !== text) { e = { text, etag: etagOf(text) }; slugEtags.set(k, e); }
  res.set({ ETag: e.etag, 'Cache-Control': 'public, max-age=300' }).type('json');
  if (req.fresh) return res.status(304).end();
  res.send(text);
};
app.get('/api/slugs/:sport', (req, res) => { const s = String(req.params.sport); if (!linkSport(s)) return res.status(404).json({ error: 'Not found' }); sendSlugs(req, res, clientSlugs(s)); });
app.get('/api/slugs/:sport/players', (req, res) => { const s = String(req.params.sport); if (!linkSport(s)) return res.status(404).json({ error: 'Not found' }); sendSlugs(req, res, clientSlugs(s, true)); });
// fix243: when each team's current season began (the app draws no link to a past season's match for non-admins)
app.get('/api/slugs/:sport/seasons', (req, res) => { const s = String(req.params.sport); if (!linkSport(s)) return res.status(404).json({ error: 'Not found' }); sendSlugs(req, res, clientSlugs(s, 'seasons')); });
/** fix243: a past season's match is admin-only (services/pastSeason.ts): 410 for everyone else, never indexed */
const pastGone = (res: express.Response) => res.status(410).set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }).json({ error: 'past-season', message: 'This game is from a past season. Past seasons are not public.' });
app.get('/api/slug/:sport/:kind/:slug', (req, res) => {
  const { sport, kind, slug } = req.params as Record<string, string>;
  if (!linkSport(sport) || !linkKind(kind) || !isSlug(slug)) return res.status(404).json({ error: 'Not found' });
  const hit = idOfSlug(sport, kind, slug);
  if (hit && kind === 'match' && req.access !== 'admin' && pastMatch(sport, hit.id)) return pastGone(res);
  if (hit) return res.set('Cache-Control', req.access === 'admin' && kind === 'match' ? 'private, no-store' : 'public, max-age=300').json({ data: { id: hit.id, slug: hit.canonical } });
  if (isWeb) return forwardToWorker(req, res);
  const a = linkAnswer(`/${sport}/${kind}/${slug}`);
  if (a && 'to' in a) return res.json({ data: { slug: a.to.split('/').pop() } });
  res.status(404).json({ error: 'Not found', search: a && 'search' in a ? a.search : null });
});
app.get('/api/slug-of/:sport/:kind/:id', (req, res) => {
  const { sport, kind, id } = req.params as Record<string, string>;
  if (!linkSport(sport) || !linkKind(kind) || !/^-?[A-Za-z0-9-]{1,40}$/.test(id)) return res.status(404).json({ error: 'Not found' });
  const s = slugOf(sport, kind, id);
  if (s) return res.set('Cache-Control', 'public, max-age=300').json({ data: { slug: s } });
  if (isWeb) return forwardToWorker(req, res);
  // the old address's own lookup (a Football-Data.org team id with its league + name)
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const a = linkAnswer(kind === 'league' && sport === 'american-football' ? (id === '2' ? '/american-football/college/league' : '/american-football/league') : internalPath(sport, kind, id), qs);
  if (a && 'to' in a) return res.json({ data: { slug: a.to.split('?')[0].split('/').pop() } });
  res.status(404).json({ error: 'Not found' });
});
// the page route's question to the worker (an address outside the web process's state): 301 / search / the item
app.get('/api/slug-route', (req, res) => {
  const p = String(req.query.p || '').slice(0, 300), qs = String(req.query.q || '').slice(0, 300);
  res.set('Cache-Control', 'no-store').json({ data: linkAnswer(p, qs) });
});
app.get('/api/admin/slugs', (_req, res) => res.json({ data: slugStatus() }));

// Weekly league hubs (fix125): this week's games of a big league with their preview texts (never the pick or a %)
app.get('/api/hub/:slug', (req, res) => {
  try {
    const def = hubBySlug(String(req.params.slug)) || hubByOld(String(req.params.slug));
    if (!def || !hubOpen(def, req.access === 'admin')) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'public, max-age=300').json({ data: buildHub(def) });
  } catch (e: any) { sendError(res, e, 'Hub failed'); }
});
app.get('/api/hub', (req, res) => {
  res.json({ data: HUBS.filter(h => hubOpen(h, req.access === 'admin')).map(h => ({ slug: h.slug, sport: h.sport, name: h.name })) });
});

// fix206: "How our models work" per sport (inputs from the model configs, accuracy by competition from the sport's
// record, last 365 days, 20+ games) and the changelog (docs/changelog.json). A sport before its launch: admins only.
app.get('/api/how-it-works/:sport', (req, res) => {
  const sport = String(req.params.sport) as HiwSport;
  if (!HIW_SPORTS.includes(sport) || (!hiwPublic(sport) && req.access !== 'admin')) return res.status(404).json({ error: 'Not found' });
  try { res.set('Cache-Control', 'public, max-age=600').json({ data: howItWorks(sport) }); }
  catch (e: any) { sendError(res, e, 'How it works failed'); }
});
// fix215: season forecast — every league simulated to the end 20,000 times with our match model. Free: the forecast's
// top three and bottom three of each table + the visitor's favourite teams; Pro / admin: everything (like matchView).
const FC_FAV: Record<FcSport, string> = { football: 'team', basketball: 'bb-team', nfl: 'nfl-team' };
const fcOpen = (req: express.Request, sport: string): sport is FcSport =>
  (sport === 'football' || sport === 'basketball' || sport === 'nfl') && (sport === 'football' || req.access === 'admin' || (sport === 'basketball' ? bbPublic() : nflPublic()));
// a favourite team: its ref, and every id it carries (football keys teams by name, ids = its Football-Data / API-Football ids)
const fcFavs = (req: express.Request, sport: FcSport) => new Set(req.user ? listFavorites(req.user.id).filter(f => f.kind === FC_FAV[sport])
  .flatMap(f => [String(f.ref), ...(((f as any).ids || []) as unknown[]).map(String)]) : []);
app.get('/api/season-forecast/:sport/league/:code([A-Za-z0-9]{1,12})', (req, res) => {
  const sport = String(req.params.sport);
  if (!fcOpen(req, sport)) return res.status(404).json({ error: 'Not found' });
  try {
    const lg = leagueForecast(sport, String(req.params.code));
    res.set('Cache-Control', 'private, no-store').json({ data: lg ? leagueView(lg, canSeeFull(req.access || 'anon'), fcFavs(req, sport)) : null });
  } catch (e: any) { sendError(res, e, 'Season forecast failed'); }
});
app.get('/api/season-forecast/:sport/team/:id(\\d+)', (req, res) => {
  const sport = String(req.params.sport);
  if (!fcOpen(req, sport)) return res.status(404).json({ error: 'Not found' });
  try {
    const id = String(req.params.id), full = canSeeFull(req.access || 'anon'), favs = fcFavs(req, sport);
    const out = teamForecastCodes(sport, id).map(code => {
      const lg = leagueForecast(sport, code);
      const row = lg?.teams.find(t => t.id === id);
      if (!lg || !row) return null;
      const open = full || visibleIds(lg, favs).has(id);
      return { code, league: lg.name, season: lg.season, runAt: lg.runAt, runs: lg.runs, known: lg.known, zones: lg.zones, size: row.pos.length, extremes: extremesFor(sport),
        team: open ? row : { id: row.id, name: row.name, now: row.now, locked: true },
        history: open ? teamHistory(sport, code, lg.season, id) : [] };
    }).filter(Boolean);
    res.set('Cache-Control', 'private, no-store').json({ data: out });
  } catch (e: any) { sendError(res, e, 'Season forecast failed'); }
});
app.get('/api/season-forecast/:sport/game/:id(\\d+)', (req, res) => {
  const sport = String(req.params.sport);
  if (!fcOpen(req, sport)) return res.status(404).json({ error: 'Not found' });
  try {
    const id = Number(req.params.id), m = gameMeaning(sport, String(id));
    if (!m) return res.set('Cache-Control', 'private, no-store').json({ data: null });
    // the same rule as the game's prediction: paid plans, or a free pick spent on this game
    const rid = sport === 'football' ? id : sport === 'basketball' ? -id : -(2e9 + id);
    const open = isPaid(req.access || 'anon') || (!!req.user && unlockedIds(req.user.id).has(rid));
    res.set('Cache-Control', 'private, no-store').json({ data: open ? { ...m, extremes: extremesFor(sport) } : { locked: true, league: m.league, home: { id: m.home.id, name: m.home.name }, away: { id: m.away.id, name: m.away.name } } });
  } catch (e: any) { sendError(res, e, 'Season forecast failed'); }
});
/**
 * fix231: the game-page extras (weather, referee, fixture difficulty, trends) and a team's next 5 games coloured by our
 * win chance. Same for everyone (difficulty is a colour, never the number). Answered by the worker (fix210).
 */
const extrasOpen = (req: express.Request, sport: string) => sport === 'football' || req.access === 'admin'
  || (sport === 'basketball' ? bbPublic() : sport === 'nfl' ? nflPublic() : tennisPublic());
app.get('/api/extras/:sport(football|basketball|nfl|tennis)/game/:id(-?\\d+)', (req, res) => {
  const sport = req.params.sport as 'football' | 'basketball' | 'nfl' | 'tennis';
  if (!extrasOpen(req, sport)) return res.status(404).json({ error: 'Not found' });
  try { res.set('Cache-Control', 'public, max-age=300').json({ data: gameExtras(sport, Number(req.params.id)) }); } catch (e: any) { sendError(res, e, 'Game extras failed'); }
});
// fix250: a game page in one request (services/gameBundle.ts) — built by the worker from the routes above, as the visitor
app.get('/api/game-bundle/:sport(football|basketball|nfl|tennis)/:id(-?\\d+)', async (req, res) => {
  if (isWeb) return forwardToWorker(req, res); // (workerRoutes answers it before this)
  try {
    const sport = req.params.sport as BundleSport, id = parseInt(req.params.id, 10);
    if (!req.user && req.access !== 'admin') noteBundleAsked(sport, id);
    const b = await buildBundle(sport, id, req.headers, req.ip || '');
    res.set({ 'Cache-Control': 'no-store', 'X-SL-Parts': b.parts }).type('application/json').send(b.body);
  } catch (e: any) { sendError(res, e, 'Game failed'); }
});
app.get('/api/extras/:sport(football|basketball|nfl|tennis)/team/:id(\\d+)', (req, res) => {
  const sport = req.params.sport as 'football' | 'basketball' | 'nfl' | 'tennis';
  if (!extrasOpen(req, sport)) return res.status(404).json({ error: 'Not found' });
  try { res.set('Cache-Control', 'public, max-age=600').json({ data: teamExtras(sport, Number(req.params.id)) }); } catch (e: any) { sendError(res, e, 'Team extras failed'); }
});
// fix231 (admin): coverage per sport, the last run, venues without coordinates; ?run=1 runs the job now
app.get('/api/admin/game-extras', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.query.run === '1') await extrasTick();
    res.json({ data: gameExtrasAdmin() });
  } catch (e: any) { sendError(res, e, 'Game extras failed'); }
});
// admin: every league's run (rules used, runs, last run time), skipped leagues, last season's replay
app.get('/api/admin/season-forecast', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: seasonForecastAdmin() }); } catch (e) { sendError(res, e, 'Failed'); }
});
// ?sport=&code= one league, else all; ?accuracy=1 replays last season (runs in the heavy queue, in a job thread)
app.post('/api/admin/season-forecast/run', (req, res) => {
  const sport = String(req.query.sport || ''), code = String(req.query.code || '');
  const refs = allLeagues().filter(r => (!sport || r.sport === sport) && (!code || r.code === code));
  if (req.query.accuracy === '1') void heavy('season forecast accuracy', () => runSeasonAccuracy()).catch(e => logger.warn(`season accuracy: ${e.message}`));
  else void heavy('season forecast', () => runSeasonForecast(refs, 'admin')).catch(e => logger.warn(`season forecast: ${e.message}`));
  res.json({ data: { started: true, leagues: req.query.accuracy === '1' ? 'last season' : refs.length } });
});
app.get('/api/changelog', (req, res) => {
  try { res.set('Cache-Control', 'private, max-age=600').json({ data: changelog(req.access === 'admin') }); }
  catch (e: any) { sendError(res, e, 'Changelog failed'); }
});

// Guides (fix125): plain-English explainers, rendered on the server (same text as the crawler HTML)
app.get('/api/guides', (_req, res) => {
  try { res.set('Cache-Control', 'public, max-age=600').json({ data: listGuides().map(({ slug, title, description }) => ({ slug, title, description })) }); }
  catch (e: any) { sendError(res, e, 'Guides failed'); }
});
app.get('/api/guides/:slug', (req, res) => {
  try {
    const g = getGuide(String(req.params.slug));
    if (!g) return res.status(404).json({ error: 'Guide not found' });
    res.set('Cache-Control', 'public, max-age=600').json({ data: { slug: g.slug, title: g.title, description: g.description, h1: g.h1, html: g.html, related: g.relatedGuides, updated: g.updated } });
  } catch (e: any) { sendError(res, e, 'Guide failed'); }
});

// Today's games grouped by league with a one-line preview each (fix124: /predictions/today pages). Never the pick or a %.
app.get('/api/today', (req, res) => {
  try {
    // fix152b: American football too (?sport=american-football&league=1|2|college), gated like the NFL pages
    const sport = req.query.sport === 'basketball' ? 'basketball' : req.query.sport === 'american-football' ? 'american-football' : req.query.sport === 'tennis' ? 'tennis' : 'football';
    if (sport === 'basketball' && !(bbPublic() || req.access === 'admin')) return res.status(404).json({ error: 'Not found' });
    if (sport === 'tennis' && !(tennisPublic() || req.access === 'admin')) return res.status(404).json({ error: 'Not found' });
    if (sport === 'american-football' && !(nflPublic() || req.access === 'admin')) return res.status(404).json({ error: 'Not found' });
    const lang = (['es', 'pt', 'de', 'fr', 'it', 'tr'].includes(String(req.query.lang)) ? String(req.query.lang) : 'en') as any;
    const dayIso = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : undefined;
    const tour = typeof req.query.tour === 'string' && /^(atp|wta|challenger|all)$/.test(req.query.tour) ? req.query.tour : null;
    res.set('Cache-Control', sport === 'american-football' || sport === 'tennis' ? 'private, max-age=300' : 'public, max-age=300').json({ data: todayGroups(sport, lang, dayIso, asLeagues(req.query.league), tour) });
  } catch (e: any) { sendError(res, e, 'Today failed'); }
});

app.get('/api/news', async (req, res) => {
  try {
    // ?league=PL → that league's news; no league → every league combined (home page)
    // ?sport=basketball → basketball news; ?team=<name>&short=<short name> (football) or ?teamId=<id> (basketball) → one team's news
    const sport = req.query.sport === 'basketball' ? 'basketball' : req.query.sport === 'american-football' ? 'american-football' : req.query.sport === 'tennis' ? 'tennis' : 'football';
    // NFL news (fix138) only once the NFL site is open for this visitor; tennis (fix193) likewise
    if (sport === 'american-football' && !(nflPublic() || req.access === 'admin')) return res.json({ data: [], timestamp: new Date().toISOString() });
    if (sport === 'tennis' && !(tennisPublic() || req.access === 'admin')) return res.json({ data: [], timestamp: new Date().toISOString() });
    let league = typeof req.query.league === 'string' && /^[A-Z0-9]{2,8}$/i.test(req.query.league) ? req.query.league : undefined;
    const limit = Math.min(30, parseInt(String(req.query.limit || '12'), 10) || 12);
    let team: string[] | undefined;
    if (sport === 'american-football' && /^\d+$/.test(String(req.query.teamId || ''))) {
      const tid = parseInt(String(req.query.teamId), 10);
      team = nflTeamNamesById(tid);
      league = leagueOfTeamId(tid) === 2 ? 'NCAA' : 'NFL'; // fix142: that league's feeds only
    } else if (sport === 'tennis' && /^\d+$/.test(String(req.query.playerId || ''))) {
      // a player's stories: their full name and surname (5+ letters, so "Li" or "Ruud" alone never match other news)
      const pr: any = db.prepare(`SELECT name FROM tennis_players WHERE id = ?`).get(parseInt(String(req.query.playerId), 10));
      const full = String(pr?.name || '').trim(), last = full.split(/\s+/).pop() || '';
      team = full ? [full, ...(last.length >= 5 ? [last] : [])] : [];
    } else if (sport === 'basketball' && /^\d+$/.test(String(req.query.teamId || ''))) {
      const id = parseInt(String(req.query.teamId), 10);
      const r: any = db.prepare(`SELECT code, CASE WHEN home_id = ? THEN home_name ELSE away_name END AS name FROM bb_games WHERE home_id = ? OR away_id = ? ORDER BY kickoff DESC LIMIT 1`).get(id, id, id);
      team = r ? bbTeamNames(r.name, r.code) : [];
    } else if (typeof req.query.team === 'string' && req.query.team.length >= 3 && req.query.team.length <= 80) {
      team = footballTeamNames(req.query.team, typeof req.query.short === 'string' ? req.query.short.slice(0, 60) : undefined);
    }
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ data: await newsFor({ sport, league, limit, team }), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'News failed');
  }
});

// Latest results with the pick saved before kick-off (open: it is the public proof). Percentages only for premium.
// /api/public/results?competition=PL&days=30&limit=50 → { rows, record } (record = hit rate over the same period)
// The public record (Accuracy page): v3 vs the bookmakers on the match result, both teams to score, over/under 2.5
// fix202: stored pages (built in the worker every 5 minutes and after results are settled)
definePage({
  name: 'record', freshMs: 5 * 60 * 1000, warm: [{ days: 30 }],
  // fix210b: the settled games read a day at a time first (preloadSettled), then counted from that copy
  build: async q => { await preloadSettled(Number(q.days) || 30, q.competition || undefined); return { data: publicRecord(Number(q.days) || 30, q.competition || undefined), timestamp: new Date().toISOString() }; },
  // the per-competition table is admin-only for now (Yarin, 10 Oct 2026): small samples look bad in public
  variants: { public: b => jsonText(stripMarket({ ...b, data: { ...b.data, byCompetition: [] } })) }
});
app.get('/api/public/record', async (req, res) => {
  try {
    const days = Math.min(400, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    res.set('Cache-Control', 'no-store');
    await sendStored(req, res, 'record', { days, competition }, req.access === 'admin' ? null : 'public');
  } catch (error: any) {
    sendError(res, error, 'Record failed');
  }
});

// finished games: every paid plan sees the percentages (it scans the whole record: a stored page, fix202)
const hideResultP = (b: any) => ({ ...b, data: { ...b.data, rows: b.data.rows.map((r: any) => ({ ...r, p: null, dc: r.dc ? { ...r.dc, p: null } : null })) } });
definePage({
  name: 'results', freshMs: 5 * 60 * 1000, warm: [{ days: 30, limit: 50 }],
  build: async q => {
    const days = Number(q.days) || 30, limit = Number(q.limit) || 50, competition = q.competition || undefined;
    await preloadSettled(days, competition); // fix210b: one paged read, the three counts below share it
    const rows = recentSettled(days, competition, limit, 'main').map((r: any) => {
      const { odds, confidence, model, ...rest } = r;
      return rest;
    });
    await yieldLoop();
    const main: any = accuracy(days, competition, 'main');
    await yieldLoop();
    // fix120: hitRate = double chance (our recommended pick); hardHitRate = the 1X2 result
    const dcRec: any = publicRecord(days, competition, 0).doubleChance;
    return { data: { rows, record: { days, n: dcRec.n || main.settled, hitRate: dcRec.v3 ?? null, hardHitRate: main.model?.hitRate ?? null } }, timestamp: new Date().toISOString() };
  },
  variants: { full: b => jsonText(stripMarket(b)), free: b => jsonText(stripMarket(hideResultP(b))) }
});
app.get('/api/public/results', async (req, res) => {
  try {
    const days = Math.min(400, parseInt(String(req.query.days || '30'), 10) || 30);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    await sendStored(req, res, 'results', { days, competition, limit }, req.access === 'admin' ? null : isPaid(req.access || 'anon') ? 'full' : 'free');
  } catch (error: any) {
    sendError(res, error, 'Failed to list results');
  }
});

// Home page proof block: our record over 30 days (all games) and the strong-pick record (a stored page, 10 min)
// Privacy page: which country data is in use (DB-IP, CC BY 4.0 — or iptoasn.com when that one is loaded)
app.get('/api/public/geo-source', (_req, res) => res.json({ data: geoCredit() }));
// fix216: team crests / logos used in the picks emails, stored by the worker (images in emails come from our domain)
app.get('/media/crests/:file', (req, res) => {
  const f = crestPath(req.params.file);
  if (!f) return res.status(404).set('Cache-Control', 'no-store').end();
  res.set('Cache-Control', 'public, max-age=2592000').type(path.extname(f)).sendFile(f);
});
// fix241: the Wikimedia player photos (fix211) are removed — old /media/players/… addresses answer 410 (the page shows
// initials + flag), /credits had only those photos and goes home, the credits list is empty
app.get('/media/players/*', (_req, res) => { res.status(410).set('Cache-Control', 'public, max-age=86400').end(); });
app.get('/api/public/photo-credits', (_req, res) => { res.set('Cache-Control', 'public, max-age=3600').json({ data: [] }); });

definePage({ name: 'summary', freshMs: 10 * 60 * 1000, warm: [{}], variants: VIEWS_PLAIN, build: async () => { await preloadSettled(30); return buildSummary(); } });
app.get('/api/public/summary', async (req, res) => {
  try { await sendStored(req, res, 'summary', {}, plainView(req)); } catch (error: any) { sendError(res, error, 'Summary failed'); }
});
function buildSummary() {
  const main: any = accuracy(30, undefined, 'main');
  // fix120: "picks right" = our double-chance pick; the 1X2 result stays as the hard call
  const rec: any = publicRecord(30);
  let draws: any = null;
  // fix210b: the number of draw picks only (was the whole draw report, backtests included)
  try { draws = { picks: drawPicksCount() }; } catch { /* backtests not loaded */ }
  return {
    data: {
      days: 30,
      // fix120: hitRate = our double-chance pick (the recommended pick); hardHitRate = the 1X2 result
      v3: { games: rec.doubleChance.n || main.settled, hitRate: rec.doubleChance.v3 ?? null, hardHitRate: main.model?.hitRate ?? null, strong: rec.doubleChance.strong?.n ? rec.doubleChance.strong : null, strong60: (main.strongPicks || []).find((t: any) => t.min === 60) || null },
      // double chance leads on the home page (fix118/119): overall, by how sure we were, and our best numbers
      doubleChance: rec.doubleChance, highlights: rec.highlights,
      drawAlerts: draws
    },
    timestamp: new Date().toISOString()
  };
}

// ---------- Market odds (The Odds API) ----------

app.get('/api/odds/status', (_req, res) => {
  try {
    res.json({ data: oddsStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to read odds status');
  }
});

// Manual fetch for one competition (costs 1 credit) — handy for testing the matching
app.post('/api/odds/refresh', async (req, res) => {
  try {
    const code = String(req.query.competition || '').toUpperCase();
    if (!SPORT_KEYS[code]) return res.status(400).json({ error: `Unknown competition. One of: ${Object.keys(SPORT_KEYS).join(', ')}` });
    const fixtures = (await footballDataAPI.getUpcomingMatches(30)).filter(m => m.competition?.code === code);
    const result = await fetchCompetitionOdds(code, fixtures);
    res.json({ data: { ...result, fixtures: fixtures.length, status: oddsStatus() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Odds refresh failed');
  }
});

// ---------- Prediction tracking / accuracy ----------

app.get('/api/accuracy', (req, res) => {
  try {
    const days = parseInt(String(req.query.days || '90'), 10) || 90;
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    const model = req.query.model ? String(req.query.model) : undefined;
    res.json({ data: accuracy(days, competition, model), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to compute accuracy');
  }
});

app.get('/api/accuracy/recent', (req, res) => {
  try {
    const days = parseInt(String(req.query.days || '90'), 10) || 90;
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    const limit = parseInt(String(req.query.limit || '100'), 10) || 100;
    const model = req.query.model ? String(req.query.model) : undefined;
    res.json({ data: recentSettled(days, competition, limit, model), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to list settled predictions');
  }
});

app.get('/api/accuracy/status', (_req, res) => {
  try {
    res.json({ data: trackingStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to read tracking status');
  }
});

// Manually trigger settlement (handy for testing)
app.post('/api/accuracy/settle', async (_req, res) => {
  try {
    const result = await settlePending((from, to) => footballDataAPI.getMatchesInRange(from, to));
    res.json({ data: result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Settlement failed');
  }
});

// ---------- History data, model v2, backtests ----------

app.get('/api/history/status', (_req, res) => {
  try {
    res.json({ data: { history: historyStatus(), model: modelV2Status(), modelV3: modelV3Status(), groups: GROUPS }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to read history status');
  }
});

app.get('/api/history/teams', (_req, res) => {
  try {
    res.json({ data: teamMapStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to read team map');
  }
});

// Load one extra (older) season of results, e.g. ?season=2324 — for out-of-sample backtests
// Head-to-head archive (older seasons, used only by the H2H row when CONV.h2hArchive = 1). GET → status, ?sync=1 → download
app.get('/api/history/h2h-archive', async (req, res) => {
  try {
    if (req.query.sync === '1') { const r = await syncH2HArchive(Number(req.query.back) || 10); res.json({ data: { total: r.total, seasons: r.seasons, errors: r.errors, failed: r.summary.filter(x => x.error).slice(0, 20) }, timestamp: new Date().toISOString() }); return; }
    res.json({ data: h2hArchiveStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'H2H archive failed');
  }
});
app.get('/api/history/sync-season', async (req, res) => {
  try {
    const season = String(req.query.season || '');
    if (!/^\d{4}$/.test(season)) { res.status(400).json({ error: 'season=YYYY (e.g. 2324)' }); return; }
    const r = await syncAll([season], false);
    prepareModelV3();
    res.json({ data: { total: r.total, summary: r.summary.filter(x => x.season === season) }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Season sync failed');
  }
});

// National-team Elo: status, or ?sync=1 to (re)load international results first
app.get('/api/model/elo', async (req, res) => {
  try {
    if (req.query.sync === '1') { await syncNationalHistory(req.query.force === '1'); buildNationalElo(); }
    else if (req.query.rebuild === '1') buildNationalElo();
    if (req.query.goals === '1') { res.json({ data: nationalGoalsSensitivity(), timestamp: new Date().toISOString() }); return; }
    res.json({ data: nationalEloStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'National Elo failed');
  }
});

// European club Elo: status, or ?sync=1 to load UEFA cup results first
// Admin checks for squad-value name matching: ?q= searches Transfermarkt names
app.get('/api/model/euro/values', (req, res) => {
  res.json({ data: clubValueReport(req.query.q ? String(req.query.q) : undefined), timestamp: new Date().toISOString() });
});
// National-team engine settings: /tune starts the search in the background (job token), /tune/status shows it
app.get('/api/model/elo/tune', (_req, res) => {
  if (nationalTuneStatus()?.running) return res.json({ data: nationalTuneStatus(), timestamp: new Date().toISOString() });
  tuneNational().catch(e => logger.warn(`national tune: ${e.message}`));
  res.json({ data: { started: true }, timestamp: new Date().toISOString() });
});
app.get('/api/model/elo/tune/status', (_req, res) => res.json({ data: nationalTuneStatus(), timestamp: new Date().toISOString() }));

app.get('/api/model/elo/values', (req, res) => {
  res.json({ data: nationalValueSearch(String(req.query.q || '')), timestamp: new Date().toISOString() });
});

app.get('/api/model/euro', async (req, res) => {
  try {
    if (req.query.sync === '1') { await syncEuropeanCups(req.query.force === '1'); buildClubElo(); }
    else if (req.query.rebuild === '1') buildClubElo();
    res.json({ data: clubEloStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Club Elo failed');
  }
});

// Refit v2 and rebuild v3 now (GET, e.g. after loading new leagues' history)
app.get('/api/history/refit', async (_req, res) => {
  try {
    const r = await footballDataAPI.prepareHistoryModel(false);
    prepareModelV3();
    res.json({ data: r, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Refit failed');
  }
});

// Re-download history and refit (force)
app.post('/api/history/sync', async (_req, res) => {
  try {
    const r = await footballDataAPI.prepareHistoryModel(true);
    res.json({ data: r, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'History sync failed');
  }
});

// Model v3 (grid): rebuild state now, or read its configuration
app.post('/api/model/v3/rebuild', (_req, res) => {
  try {
    res.json({ data: { groups: prepareModelV3(), status: modelV3Status() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Model v3 rebuild failed');
  }
});
app.get('/api/model/v3/status', (_req, res) => {
  res.json({ data: modelV3Status(), timestamp: new Date().toISOString() });
});

// Squad values (v3 row #1): status, or force a re-download and rebuild v3 state
// Point-in-time squad values (monthly history). ?sync=1 rebuilds, ?club=FC Porto shows a sample
app.get('/api/model/v3/squad/history', async (req, res) => {
  try {
    if (req.query.sync === '1') await syncClubValueHistory(squadCompetitions(), true);
    res.json({ data: clubValueHistoryStatus(req.query.club ? String(req.query.club) : undefined), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Club value history failed');
  }
});

// Admin: find a club in the Transfermarkt dump (clubs.csv, players.csv, monthly history). ?q=coventry
app.get('/api/model/v3/squad/find', async (req, res) => {
  try {
    if (req.query.fd) { res.json({ data: historyMatchReport(String(req.query.group || '').toUpperCase(), String(req.query.fd).split(',')), timestamp: new Date().toISOString() }); return; }
    res.json({ data: await findClub(String(req.query.q || '')), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Club search failed');
  }
});
app.get('/api/model/v3/squad', (_req, res) => {
  res.json({ data: squadValuesStatus(), timestamp: new Date().toISOString() });
});
const squadSyncHandler = async (_req: express.Request, res: express.Response) => {
  try {
    const r = await syncSquadValues(true);
    // fix169: the model is rebuilt in slices in the background (the sync build froze the server 1.6 s)
    if (r) void timed('squad values: model v3', async () => { await prepareModelV3Async(); await rebuildAfFeaturesAsync(true); }).catch(e => logger.warn(`squad values rebuild: ${e.message}`));
    res.json({ data: { synced: r, status: squadValuesStatus() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Squad values sync failed');
  }
};
app.post('/api/model/v3/squad/sync', squadSyncHandler);

// API-Football feed (injuries, suspensions, confirmed lineups): status and a manual sync
// Admin: raw API-Football answer for a fixture (to check what the provider has). ?path=/fixtures/statistics&fixture=123
app.get('/api/af/raw', async (req, res) => {
  const pathQ = String(req.query.path || '/fixtures');
  if (!['/fixtures', '/fixtures/statistics', '/fixtures/lineups', '/fixtures/events', '/leagues', '/players', '/players/topscorers'].includes(pathQ)) return res.status(400).json({ error: 'path not allowed' });
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (!['path', 'token', 'c'].includes(k)) params[k] = String(v);
  try {
    res.json({ data: await afGet(pathQ, params), timestamp: new Date().toISOString() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ---------- NFL site (fix137) ----------
// Open API, but until NFL_PUBLIC=1 only admins get data (everyone else sees the "coming soon" page).
// Predictions (fix139, nfl-v1): paid plans see them before kick-off, everyone sees finished ones; no odds. Past seasons: admins only.
app.use('/api/nfl', (req, res, next) => {
  if (req.path === '/config' || nflPublic() || req.access === 'admin') return next();
  res.status(404).json({ error: 'Not found' });
});
const nflAdmin = (req: express.Request) => req.access === 'admin';
const nflFull = (req: express.Request) => isPaid(req.access || 'anon');
/** fix142: ?league=1|2|college (default NFL) — pages of one league (standings, leaders, config) */
const nflLg = (req: express.Request) => asLeague(req.query.league);
/** fix185: list routes (home, games, record, today): missing / 'all' = both leagues; '1' / 'nfl' or '2' / 'college' = one */
const nflLgs = (req: express.Request) => asLeagues(req.query.league);
const byKick = <T extends { kickoff: string }>(a: T, b: T) => a.kickoff.localeCompare(b.kickoff);
const nflRid = (id: number) => -(2e9 + id); // frontend lib/nfl.ts nflRid
const nflWith = <T extends { id: number; state: string }>(req: express.Request, games: T[]) => nflWithF(fullFor(req, nflRid), games);
/** fix202: the same with the access already worked out (true / false for the stored pages, or a member's unlocks) */
const nflWithF = <T extends { id: number; state: string }>(f: boolean | ((id: number) => boolean), games: T[]) => {
  return games.map(g => {
    const x = withNflPrediction(g as any, typeof f === 'function' ? f(g.id) : f) as unknown as T & { prediction: any };
    // fix174: live win chance + projected score on live rows (numbers unlocked), like basketball
    if (g.state === 'live' && x.prediction && !x.prediction.locked) { const live = nflLiveNow(g.id); if (live) x.prediction = { ...x.prediction, live }; }
    return x;
  });
};
const nflConfigBody = (league: ReturnType<typeof asLeague>, admin: boolean) => ({ data: { public: nflPublic(), open: nflPublic() || admin, league, season: nflCurrentSeason(league),
  seasons: nflSeasonsHeld(admin, league), leagues: LEAGUES.map(l => ({ id: l, season: nflCurrentSeason(l) })) } });
// fix221: a stored page (the season list was a database scan on the web process on every page open); admins: the worker
definePage({ name: 'nfl-config', freshMs: 60 * 1000, variants: VIEWS_PLAIN, warm: LEAGUES.map(l => ({ league: l })), build: q => nflConfigBody(asLeague(q.league), false) });
app.get('/api/nfl/config', async (req, res) => {
  try {
    if (nflAdmin(req)) return byWorker(req, res, () => res.json(nflConfigBody(nflLg(req), true)));
    await sendStored(req, res, 'nfl-config', { league: nflLg(req) }, 'full');
  } catch (e) { sendError(res, e, 'Failed to load the NFL settings'); }
});
/** ?league= as one stored key: '' both leagues, '1' NFL, '2' college */
const nflLgKey = (req: express.Request) => { const l = nflLgs(req); return l.length === 1 ? String(l[0]) : ''; };
// fix202: a stored page per access (paid / not), built in the worker every 30 s; members with unlocked games get it built here
definePage({ name: 'nfl-home', freshMs: 30 * 1000, variants: VIEWS_PLAIN, warm: [{ full: 0 }, { full: 1 }], build: q => nflHomeBody(asLeagues(q.league), q.full === '1') });
app.get('/api/nfl/home', async (req, res) => {
  try {
    const f = fullFor(req, nflRid);
    if (typeof f === 'boolean') return await sendStored(req, res, 'nfl-home', { league: nflLgKey(req), full: f ? 1 : 0 }, plainView(req));
    byWorker(req, res, () => res.json(nflHomeBody(nflLgs(req), f))); // fix221: a member with unlocks / an admin
  } catch (e) { sendError(res, e, 'Failed to load the NFL home'); }
});
function nflHomeBody(asked: ReturnType<typeof asLeagues>, f: boolean | ((id: number) => boolean)) {
  // fix185: both leagues together by default (?league=nfl|college for one); every game keeps its league field
  const lgs = asked.filter(l => nflCurrentSeason(l));
  const league = asked.length === 1 ? asked[0] : lgs.length === 1 ? lgs[0] : 'all';
  const season = lgs.length ? nflCurrentSeason(lgs[0]) : null;
  if (!season) return { data: { season: null, league, live: [], week: null, games: [], upcoming: [], results: [], standings: null, leaders: [] } };
  // fix138: the next two weeks too (favorites rail), and the last 8 finals (Latest results)
  const now = Date.now();
  const per = lgs.map(l => {
    const s = nflCurrentSeason(l)!, { weeks, current } = nflWeeks(s, l);
    return { l, s, week: weeks.find(w => w.key === current) || null, games: current ? nflWeekGames(s, current, l) : [], standings: nflStandings(s, l) };
  });
  const stand = per.map(p => p.standings).filter(Boolean) as any[];
  const upcoming = nflWithF(f, lgs.flatMap(l => nflGamesBetween(new Date(now - 6 * 3600 * 1000).toISOString(), new Date(now + 14 * 86400000).toISOString(), l)).filter(g => g.state === 'upcoming').sort(byKick));
  // fix188: model rating + rank (and FBS / FCS for college) of every team in the coming games: the featured games
  const rate = new Map(lgs.map(l => [l, nflRatings(l)]));
  const ratings: Record<number, { elo: number; rank: number; level: string | null }> = {};
  for (const g of upcoming) for (const s of [g.home, g.away]) {
    const r = rate.get(g.league)?.get(s.id);
    if (r && !ratings[s.id]) ratings[s.id] = { ...r, level: g.league === 2 ? nflTeamRow(s.id)?.level || null : null };
  }
  return { data: {
    season, league, week: per.length === 1 ? per[0].week : null,
    live: nflWithF(f, lgs.flatMap(l => nflLiveGames(l)).sort(byKick)),
    games: nflWithF(f, per.flatMap(p => p.games).sort(byKick)),
    upcoming, ratings,
    results: nflWithF(f, lgs.flatMap(l => nflRecentResults(8, l)).sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, 8)),
    // the table(s): one league's as before; both → the rows of both (teams covered, the featured game's strength)
    standings: stand.length === 1 ? stand[0] : stand.length ? { season, league: 'all', conferences: stand.flatMap(s => s.conferences), rows: stand.flatMap(s => s.rows) } : null,
    leaders: nflLeaders(season, 3, lgs[0])
  } };
}
app.get('/api/nfl/games', (req, res) => {
  try {
    // a day on the visitor's clock (Today page)
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      const f = new Date(req.query.from), t = new Date(req.query.to);
      if (isNaN(f.getTime()) || isNaN(t.getTime()) || t <= f || t.getTime() - f.getTime() > 31 * 86400000) return res.status(400).json({ error: 'Bad range' }); // fix152a: up to 30 days (Games page)
      // fix185: both leagues by default, by kick-off
      return res.json({ data: { games: nflWith(req, nflLgs(req).flatMap(l => nflGamesBetween(f.toISOString(), t.toISOString(), l)).sort(byKick)) } });
    }
    // the week form: one league's weeks (the first asked); both leagues → each league's games of that week key, merged
    const lgs = nflLgs(req);
    const league = lgs[0];
    const season = allowedSeason(req.query.season, nflAdmin(req), league);
    if (!season) return res.json({ data: { season: null, league: lgs.length > 1 ? 'all' : league, weeks: [], week: null, games: [] } });
    const { weeks, current } = nflWeeks(season, league);
    const asked = typeof req.query.week === 'string' && /^(\d{1,2}|post)$/.test(req.query.week) ? req.query.week : null;
    const week = asked && weeks.some(w => w.key === asked) ? asked : current;
    const games = lgs.flatMap(l => {
      const s = l === league ? season : allowedSeason(req.query.season, nflAdmin(req), l);
      if (!s) return [];
      const k = l === league ? week : (asked || nflWeeks(s, l).current);
      return k ? nflWeekGames(s, k, l) : [];
    }).sort(byKick);
    res.json({ data: { season, league: lgs.length > 1 ? 'all' : league, weeks, week, games: nflWith(req, games) } });
  } catch (e) { sendError(res, e, 'Failed to load games'); }
});
app.get('/api/nfl/game/:id(\\d+)', (req, res) => {
  try {
    const d = nflGame(parseInt(req.params.id, 10), nflAdmin(req));
    if (!d) return res.status(404).json({ error: 'Game not found' });
    if (d.game.state === 'live') noteGameView('nfl', d.game.id); // fix208: open pages get the live player stats every 60 s
    const game = withNflPrediction(d.game, fullOne(req, nflRid(d.game.id)));
    // fix174: football's game-page parts — live win chance + swing chart (numbers unlocked), schedule & rest, the
    // division / conference table, likely starters, before vs after, the written preview, scoring plays
    const g = d.game, p: any = game.prediction, open = !!p && !p.locked;
    const qbNames = (p?.why?.qb || []).map((q: any) => q?.name || null) as [string | null, string | null];
    res.json({ data: { ...d, game, prediction: p,
      live: open ? { now: g.state === 'live' ? nflLiveNow(g.id) : null, curve: g.state === 'upcoming' ? [] : nflLiveCurve(g.id) } : null,
      schedule: { home: nflSchedule(g.home.id, g), away: nflSchedule(g.away.id, g) },
      standings: nflGameStandings(g),
      starters: g.state === 'done' ? null : { home: nflStarters(g.home.id, g.season), away: nflStarters(g.away.id, g.season) },
      // fix224: the key players card (QB first; "team without him" for the QB, the only position nfl-v1 prices)
      keyPlayers: g.state === 'done' ? null : { home: nflKeyPlayers(g.home.id, g.season, nflQbWithout(g.home.id)), away: nflKeyPlayers(g.away.id, g.season, nflQbWithout(g.away.id)) },
      beforeAfter: open ? nflBeforeAfter(g, p) : null,
      writeup: nflPreview(g.id, qbNames),
      events: g.state !== 'upcoming' ? nflEvents(g.id) : null // fix209: live too (the header's scoring plays)
    } });
  } catch (e) { sendError(res, e, 'Failed to load game'); }
});
// fix209: a list row opened with its arrow — the scoring plays
app.get('/api/nfl/game/:id(\\d+)/scorers', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const g = db.prepare(`SELECT home_id, away_id FROM nfl_games WHERE game_id = ?`).get(id) as any;
    if (!g) return res.status(404).json({ error: 'Game not found' });
    res.json({ data: { homeId: g.home_id, awayId: g.away_id, plays: nflEvents(id) || [] } });
  } catch (error: any) { sendError(res, error, 'Failed to fetch scorers'); }
});
// fix174: official highlights (YouTube, the league's / teams' own channels) for a finished NFL or college game
app.get('/api/nfl/game/:id(\\d+)/highlights', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = db.prepare(`SELECT kickoff, home_name, away_name, status, league FROM nfl_games WHERE game_id = ?`).get(id) as any;
    if (!r || !['FT', 'AOT'].includes(r.status)) return res.json({ data: null });
    const nickOf = (s: string) => (r.league === 2 ? s : String(s || '').split(/\s+/).pop() || s);
    res.json({ data: await highlightsFor({ id: 4_000_000_000 + id, status: 'FINISHED', utcDate: r.kickoff, homeTeam: { name: r.home_name, shortName: nickOf(r.home_name) }, awayTeam: { name: r.away_name, shortName: nickOf(r.away_name) } }) });
  } catch (e) { sendError(res, e, 'Failed to fetch highlights'); }
});
// fix209: a list row opened with its arrow — each team's top scorer (final box score, else the live one)
app.get('/api/basketball/game/:id(\\d+)/scorers', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const g = db.prepare(`SELECT home_id, away_id FROM bb_games WHERE game_id = ?`).get(id) as any;
    if (!g) return res.status(404).json({ error: 'Game not found' });
    let rows = db.prepare(`SELECT team_id, player_id, name, pts FROM bb_player_stats WHERE game_id = ?`).all(id) as any[];
    if (!rows.length) rows = db.prepare(`SELECT team_id, player_id, name, pts FROM bb_player_stats_live WHERE game_id = ?`).all(id) as any[];
    const top = (team: number) => {
      const r = rows.filter(x => x.team_id === team && x.name).sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0))[0];
      return r ? { id: r.player_id, name: r.name, points: r.pts ?? 0 } : null;
    };
    res.json({ data: { home: top(g.home_id), away: top(g.away_id) } });
  } catch (error: any) { sendError(res, error, 'Failed to fetch scorers'); }
});
app.get('/api/basketball/game/:id(\\d+)/highlights', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = db.prepare(`SELECT kickoff, home_name, away_name, status FROM bb_games WHERE game_id = ?`).get(id) as any;
    if (!r || !['FT', 'AOT'].includes(r.status)) return res.json({ data: null });
    res.json({ data: await highlightsFor({ id: 5_000_000_000 + id, status: 'FINISHED', utcDate: r.kickoff, homeTeam: { name: r.home_name }, awayTeam: { name: r.away_name } }) });
  } catch (e) { sendError(res, e, 'Failed to fetch highlights'); }
});
app.get('/api/nfl/standings', (req, res) => {
  try {
    const league = nflLg(req);
    const season = allowedSeason(req.query.season, nflAdmin(req), league);
    res.json({ data: season ? { ...nflStandings(season, league), leaders: nflLeaders(season, 5, league) } : null });
  } catch (e) { sendError(res, e, 'Failed to load standings'); }
});
app.get('/api/nfl/team/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), league = leagueOfTeamId(id);
    const season = allowedSeason(req.query.season, nflAdmin(req), league);
    const d = season ? nflTeam(id, season) : null;
    if (!d) return res.status(404).json({ error: 'Team not found' });
    // fix139: model tiles for paid plans (null + locked for the rest)
    // fix174: like football and basketball — our record on the team is public; strengths & weaknesses and the 1–10
    // scores are paid (free: a locked preview that says how many we found); the team's division / conference table
    const full = nflFull(req), cur = season === nflCurrentSeason(league);
    const a: any = d.analysis;
    const analysis = !a || full ? a : { season: a.season, locked: true, notesCount: (a.strengths?.length || 0) + (a.weaknesses?.length || 0), measures: [], strengths: [], weaknesses: [], rankByWeek: a.rankByWeek || [] };
    const st = nflStandings(season!, league);
    let division: any = null;
    for (const c of st.conferences) for (const dv of c.divisions) if (!division && dv.rows.some(r => r.team.id === d.team.id)) division = { conference: c.name, name: dv.name, rows: dv.rows };
    res.json({ data: { ...d, analysis, schedule: nflWith(req, d.schedule), results: nflWith(req, d.results),
      model: full && cur ? nflTeamModel(d.team.id) : null, modelLocked: !full,
      record: nflTeamRecord(d.team.id, season!), division,
      // fix177: no roster from the provider (FCS teams): the team's season leaders from our box scores instead
      leaders: d.roster.length ? null : nflStarters(d.team.id, season!) } });
  } catch (e) { sendError(res, e, 'Failed to load team'); }
});
app.get('/api/nfl/player/:id(\\d+)', (req, res) => {
  try {
    const pid = parseInt(req.params.id, 10);
    const pt = (db.prepare(`SELECT team_id FROM nfl_players WHERE player_id = ?`).get(pid) as any)?.team_id;
    const season = allowedSeason(req.query.season, nflAdmin(req), pt ? leagueOfTeamId(pt) : nflLg(req));
    const d = season ? nflPlayer(pid, season) : null;
    if (!d) return res.status(404).json({ error: 'Player not found' });
    // fix174: career by season and the injury report line, like the football and basketball player pages
    res.json({ data: { ...d, career: nflPlayerCareer(pid), injury: nflPlayerInjury(pid) } });
  } catch (e) { sendError(res, e, 'Failed to load player'); }
});
// fix144: Upset watch for every sport (Pro; model only) and the NFL accuracy page (admins, like basketball's for now)
const proGate = (req: express.Request, res: express.Response) => {
  const a = req.access || 'anon';
  if (a === 'pro' || a === 'admin') return true;
  res.status(a === 'anon' ? 401 : 402).json({ error: a === 'anon' ? 'Sign in required' : 'Pro required', premium: true, pro: true });
  return false;
};
app.get('/api/nfl/upset-watch', (req, res) => {
  if (!proGate(req, res)) return;
  try { res.json({ data: winnerUpsetReport('american-football'), timestamp: new Date().toISOString() }); } catch (e) { sendError(res, e, 'Upset watch failed'); }
});
app.get('/api/nfl/accuracy', (req, res) => {
  if (req.access !== 'admin') return res.status(404).json({ error: 'Not found' });
  try { res.json({ data: nflAccuracy(Math.min(3650, Math.max(1, parseInt(String(req.query.days || '3650'), 10) || 3650))) }); } catch (e) { sendError(res, e, 'Failed to load the record'); }
});
// fix144: NFL past seasons (admins and the model permission; not under the open /api/nfl/): the walk-forward reports
app.get('/api/nfl-past', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: { nfl: nflModelReport(1), college: nflModelReport(2), experiments: require('./services/nflExperiments').nflExperimentReport(), calibration: require('./services/afCalibration').afCalibReport() } });
});
// fix141: home "Our record" — last 30 days, picks saved before kick-off only
definePage({ name: 'nfl-record', freshMs: 5 * 60 * 1000, variants: VIEWS_PLAIN, warm: [{ days: 30 }], build: q => ({ data: nflRecord(Number(q.days) || 30, asLeagues(q.league)) }) });
app.get('/api/nfl/record', async (req, res) => {
  try { await sendStored(req, res, 'nfl-record', { days: Math.min(365, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30)), league: nflLgKey(req) }, plainView(req)); }
  catch (e) { sendError(res, e, 'Failed to load the record'); }
});
// ---------- Tennis site (fix193) ----------
// Open API, but until TENNIS_PUBLIC=1 only admins get data (everyone else sees the "coming soon" page). Predictions:
// tennis-v1 (shown as SL Tennis 1.0): paid plans before the start, everyone once the match is over — the same rules,
// free picks and pick packs as basketball / NFL (reveal id -(4e9 + id)). ITF stays admin-only. No market prices here.
app.use('/api/tennis', (req, res, next) => {
  if (req.path === '/config' || tennisPublic() || req.access === 'admin') return next();
  res.status(404).json({ error: 'Not found' });
});
const tnAdmin = (req: express.Request) => req.access === 'admin';
const tnTour = (req: express.Request) => (typeof req.query.tour === 'string' && /^(atp|wta|challenger|itf|all)$/.test(req.query.tour) ? req.query.tour : 'all');
const tnWith = (req: express.Request, list: any[]) => tnWithF(fullFor(req, tennisRid), list);
/** fix202: the same with the access already worked out (true / false for the stored pages, or a member's unlocks) */
const tnWithF = (f: boolean | ((id: number) => boolean), list: any[]) => {
  // fullFor's function form takes the match id (it maps it to the reveal id itself)
  return withTennisPredictions(list, typeof f === 'function' ? (rid: number) => f(-rid - 4e9) : f);
};
app.get('/api/tennis/config', (req, res) => {
  res.json({ data: { public: tennisPublic(), open: tennisPublic() || tnAdmin(req), tours: ['atp', 'wta', 'challenger', ...(tnAdmin(req) ? ['itf'] : [])] } });
});
// fix202: a stored page per tour and access (paid / not), built in the worker every 30 s (admins and members with
// unlocked matches get it built here)
definePage({ name: 'tennis-home', freshMs: 30 * 1000, variants: VIEWS_PLAIN, warm: tennisPublic() ? [{ tour: 'all', full: 0 }, { tour: 'all', full: 1 }] : [], build: q => tennisHomeBody(q.tour || 'all', q.full === '1', false) });
app.get('/api/tennis/home', async (req, res) => {
  try {
    const f = fullFor(req, tennisRid), admin = tnAdmin(req);
    if (typeof f === 'boolean' && !admin) return await sendStored(req, res, 'tennis-home', { tour: tnTour(req), full: f ? 1 : 0 }, plainView(req));
    byWorker(req, res, () => res.json(tennisHomeBody(tnTour(req), f, admin)));
  } catch (e) { sendError(res, e, 'Failed to load the tennis home'); }
});
function tennisHomeBody(tour: string, f: boolean | ((id: number) => boolean), admin: boolean) {
  const now = Date.now();
  const upcoming = tnWithF(f, tennisMatchesBetween(new Date(now - 3 * 3600e3).toISOString(), new Date(now + 4 * 86400e3).toISOString(), tour, admin, 2500).filter(m => m.state === 'upcoming'));
  // the featured matches: biggest coming events (Grand Slam / 1000 / 500 first), then the two players' ratings
  const ratings: Record<number, { elo: number; rank: number }> = {};
  const soon = upcoming.filter(m => Date.parse(m.start) - now < 48 * 3600e3).sort((a, b) => levelRank(a.tournament.tier, a.tour, a.tournament.name) - levelRank(b.tournament.tier, b.tour, b.tournament.name)).slice(0, 80);
  for (const m of soon) for (const s of [m.home, m.away]) if (s.id && !ratings[s.id]) { const r = tennisPlayerModel(s.id, m.women); if (r) ratings[s.id] = { elo: r.elo, rank: r.rank }; }
  return { data: {
    tour, live: tnWithF(f, tennisLive(tour, admin)), upcoming, ratings,
    results: tnWithF(f, tennisRecent(8, tour, admin)),
    levels: Object.fromEntries(upcoming.map(m => [m.id, levelRank(m.tournament.tier, m.tour, m.tournament.name)]))
  } };
}
app.get('/api/tennis/matches', (req, res) => {
  try {
    const now = Date.now();
    const f = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(now - 6 * 3600e3);
    const t = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date(now + 7 * 86400e3);
    if (isNaN(f.getTime()) || isNaN(t.getTime()) || t <= f || t.getTime() - f.getTime() > 31 * 86400000) return res.status(400).json({ error: 'Bad range' });
    res.json({ data: { matches: tnWith(req, tennisMatchesBetween(f.toISOString(), t.toISOString(), tnTour(req), tnAdmin(req), 3000)) } });
  } catch (e) { sendError(res, e, 'Failed to load matches'); }
});
app.get('/api/tennis/match/:id(-?\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const d = tennisMatch(id, fullOne(req, tennisRid(id)), tnAdmin(req));
    if (!d) {
      // fix195: an old fixture id merged into its match: the page goes to the match id
      const moved = tennisMovedId(id);
      if (moved) return res.status(404).json({ error: 'Match moved', movedTo: moved });
      return res.status(404).json({ error: 'Match not found' });
    }
    // fix193c: the written preview (English; the same text search engines get, no pick, no %)
    res.json({ data: { ...d, writeup: tennisWriteup(d) } });
  } catch (e) { sendError(res, e, 'Failed to load the match'); }
});
// home "Our record": the last 30 days, predictions saved before the start, from the public start day
definePage({ name: 'tennis-record', freshMs: 5 * 60 * 1000, variants: VIEWS_PLAIN, warm: tennisPublic() ? [{ days: 30, tour: 'all' }] : [], build: q => ({ data: tennisRecord(Number(q.days) || 30, q.tour || 'all') }) });
app.get('/api/tennis/record', async (req, res) => {
  try { await sendStored(req, res, 'tennis-record', { days: Math.min(3650, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30)), tour: tnTour(req) }, plainView(req)); }
  catch (e) { sendError(res, e, 'Failed to load the record'); }
});
app.get('/api/tennis/tournament/:key([a-z0-9-]{3,90})', (req, res) => {
  try {
    const f = fullFor(req, tennisRid);
    const d = tennisTournament(req.params.key, typeof f === 'function' ? (rid: number) => f(-rid - 4e9) : f, tnAdmin(req));
    if (!d) return res.status(404).json({ error: 'Tournament not found' });
    res.json({ data: d });
  } catch (e) { sendError(res, e, 'Failed to load the tournament'); }
});
app.get('/api/tennis/player/:id(\\d+)', (req, res) => {
  try {
    const f = fullFor(req, tennisRid);
    // fix193b: like the other sports — our record on the player is public; model tiles, the 1–10 scores and the
    // strengths / weaknesses are paid (free: a locked preview with how many we found)
    const d = tennisPlayer(parseInt(req.params.id, 10), typeof f === 'function' ? (rid: number) => f(-rid - 4e9) : f, isPaid(req.access || 'anon'), tnAdmin(req));
    if (!d) return res.status(404).json({ error: 'Player not found' });
    res.json({ data: d });
  } catch (e) { sendError(res, e, 'Failed to load the player'); }
});
app.get('/api/tennis/rankings', (req, res) => {
  try { res.json({ data: tennisRankings(req.query.tour === 'wta' ? 'wta' : 'atp') }); } catch (e) { sendError(res, e, 'Failed to load the rankings'); }
});
// fix193c: tennis past seasons (admins and the model permission; not under the open /api/tennis/): the walk-forward report
app.get('/api/tennis-past', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = tennisModelReport();
  res.json({ data: { model: r.model, ready: r.ready, running: r.running, report: r.report || null } });
});
// fix193c: the full record (admins until TENNIS_PUBLIC=1, like the other sports' Accuracy pages: admins only for now)
app.get('/api/tennis/accuracy', (req, res) => {
  if (req.access !== 'admin') return res.status(404).json({ error: 'Not found' });
  try { res.json({ data: tennisAccuracy(Math.min(3650, Math.max(1, parseInt(String(req.query.days || '3650'), 10) || 3650))) }); } catch (e) { sendError(res, e, 'Failed to load the record'); }
});
// fix193c: official highlights (YouTube: ATP / WTA / Tennis TV / the Slams) of a finished match — the shared service,
// searched by the two surnames
app.get('/api/tennis/match/:id(\\d+)/highlights', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = db.prepare(`SELECT scheduled_at, p1_name, p2_name, status, winner FROM tennis_matches WHERE id = ?`).get(id) as any;
    if (!r || r.status !== 'completed' || !(r.winner === 1 || r.winner === 2)) return res.json({ data: null });
    const sur = (n: string) => shortName(n); // fix195: the real surname ("de Minaur", "Bautista Agut")
    res.json({ data: await highlightsFor({ id: 6_000_000_000 + id, status: 'FINISHED', utcDate: r.scheduled_at, homeTeam: { name: r.p1_name, shortName: sur(r.p1_name) }, awayTeam: { name: r.p2_name, shortName: sur(r.p2_name) } }) });
  } catch (e) { sendError(res, e, 'Failed to fetch highlights'); }
});
app.get('/api/tennis/upset-watch', (req, res) => {
  if (!proGate(req, res)) return;
  try { res.json({ data: winnerUpsetReport('tennis'), timestamp: new Date().toISOString() }); } catch (e) { sendError(res, e, 'Upset watch failed'); }
});

app.get('/api/nfl/leaders', (req, res) => {
  try {
    const league = nflLg(req);
    const season = allowedSeason(req.query.season, nflAdmin(req), league);
    res.json({ data: season ? nflLeaders(season, 10, league) : [] });
  } catch (e) { sendError(res, e, 'Failed to load leaders'); }
});

// ---------- Basketball site (Oct 2026) ----------
// Open API, but until BASKETBALL_PUBLIC=1 only admins get data (everyone else sees the "coming soon" page).
// Paid plans see percentages, spread, total and predicted score; everyone else the pick (finished games in full).
app.use('/api/basketball', (req, res, next) => {
  if (req.path === '/config' || bbPublic() || req.access === 'admin') return next();
  res.status(404).json({ error: 'Not found' });
});
app.get('/api/basketball/config', (req, res) => {
  res.json({ data: { public: bbPublic(), open: bbPublic() || req.access === 'admin', leagues: bbLeagues() } });
});
/*
 * fix202: the lists the basketball home opens (next 7 days, last 30 days' results; a league's too) are stored pages per
 * access (paid / not), built in the worker every 30 s. A calendar day picked on the site (the visitor's own midnight)
 * and members with unlocked games are built here, as before.
 */
function bbGamesBody(code: string | undefined, results: boolean, days: number, range: { from: Date; to: Date } | null, full: boolean | ((id: number) => boolean)) {
  const now = Math.floor(Date.now() / 30000) * 30000; // fix159: 30-s steps, so the list cache (bbSite) is reused
  const day = 86400000;
  const from = range ? range.from : results ? new Date(now - days * day) : new Date(now - 4 * 3600 * 1000);
  const to = range ? range.to : results ? new Date(now) : new Date(now + days * day);
  return { data: bbGames({ from: from.toISOString(), to: to.toISOString(), code, results, limit: 400 }, full), timestamp: new Date().toISOString() };
}
const bbKnown = (code: string | undefined) => !code || bbLeagues().some(l => l.code === code);
// fix221: the locked copy (full=0) is stored row by row with each game's full row beside it, so a Free member's unlocked
// games are joined in by the web process; the frontend's four lists are kept warm
definePage({
  name: 'bb-games', freshMs: 30 * 1000,
  warm: [{ days: 7, full: 0 }, { days: 7, full: 1 }, { days: 30, full: 0 }, { days: 30, full: 1 }, { days: 7, results: 1, full: 0 }, { days: 7, results: 1, full: 1 },
    { days: 30, results: 1, full: 0 }, { days: 30, results: 1, full: 1 }],
  build: q => bbGamesBody(q.league || undefined, q.results === '1', Number(q.days) || 3, null, q.full === '1'),
  rows: (b, q) => {
    const open = q.full === '1' ? null : new Map(bbGamesBody(q.league || undefined, q.results === '1', Number(q.days) || 3, null, true).data.map((g: any) => [g.id, g]));
    return listRows(b, { id: g => -g.id, full: g => open?.get(g.id) || g, tease: g => g });
  }
});
app.get('/api/basketball/games', async (req, res) => {
  try {
    const day = 86400000;
    const code = typeof req.query.league === 'string' && /^[A-Za-z0-9]{2,8}$/.test(req.query.league) ? req.query.league.toUpperCase() : undefined;
    const results = req.query.results === '1';
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || '3'), 10) || 3));
    // a calendar day picked on the site (the visitor's own midnight to midnight)
    let range: { from: Date; to: Date } | null = null;
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      const f = new Date(req.query.from), t = new Date(req.query.to);
      if (!isNaN(f.getTime()) && !isNaN(t.getTime()) && t > f && t.getTime() - f.getTime() <= 14 * day) range = { from: f, to: t };
    }
    const full = fullFor(req, id => -id);
    // fix221: the locked copy is sent as 'anon' (its 'full' view has every game open: a member's unlocks are joined from it)
    const asked = { league: code, results, days, full: full === true ? 1 : 0 };
    if (!range && bbKnown(code)) {
      if (typeof full === 'function') return await sendStored(req, res, 'bb-games', asked, 'anon', new Set([...unlockedIds(req.user!.id)].filter(id => id < 0 && id > -2e9)));
      return await sendStored(req, res, 'bb-games', asked, req.access === 'admin' ? null : full ? 'full' : 'anon');
    }
    byWorker(req, res, () => res.json(bbGamesBody(code, results, days, range, full)));
  } catch (error: any) {
    sendError(res, error, 'Failed to load games');
  }
});
// fix169: the game page is kept, one copy per access level (full numbers or not)
// fix196: finished games 24 h, games to come 5 min (never past tip-off), live games not at all; the 1,500 most recently
// opened pages (search engines read old games: 0.6–1.3 s each when rebuilt on every open)
const bbGameCache = new Map<string, { at: number; until: number; data: any }>();
const bbGameTtl = (data: any) => {
  const st = data?.game?.state;
  if (st === 'live') return 0;
  const toTip = Date.parse(data?.game?.kickoff || '') - Date.now();
  // a game finished in the last 2 days still gets its box score, result check and swing chart: 10 min until then
  if (st === 'done' || st === 'off') return toTip > -2 * 86400000 ? 10 * 60 * 1000 : 24 * 3600 * 1000;
  return Math.max(0, Math.min(5 * 60 * 1000, Number.isFinite(toTip) ? toTip : 0));
};
app.get('/api/basketball/game/:id(\\d+)', async (req, res) => {
  try {
    const gid = parseInt(req.params.id, 10);
    noteGameView('bb', gid); // fix208: open pages get the live box score every 60 s (only live games are fetched)
    const full = fullOne(req, -gid);
    const key = `${gid}|${full ? 1 : 0}`;
    const hit = bbGameCache.get(key);
    if (hit && Date.now() < hit.until) { bbGameCache.delete(key); bbGameCache.set(key, hit); return res.json({ data: hit.data, timestamp: new Date(hit.at).toISOString(), cached: true }); }
    const data = await bbGame(gid, full);
    if (!data) return res.status(404).json({ error: 'Game not found' });
    const ttl = bbGameTtl(data);
    if (ttl > 0) bbGameCache.set(key, { at: Date.now(), until: Date.now() + ttl, data }); else bbGameCache.delete(key);
    while (bbGameCache.size > 300) bbGameCache.delete(bbGameCache.keys().next().value!); // fix210: capped low (the page is also stored in the database; the worker answers every page request)
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load game');
  }
});
// Basketball results: checks and admin corrections (services/bbResults.ts)
app.get('/api/admin/bb/result-checks', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: { ...resultChecksList(), other: openReviews(), football: openSettleReviews() } }); });
// fix240: football games with no final 48 h after kick-off (services/unsettled.ts): Enter result { home, away } / Void
app.post('/api/admin/settle-review/:id(\d+)', jsonOnly, (req, res) => {
  try {
    const r = decideSettle(parseInt(req.params.id, 10), String(req.body?.action || ''), req.body, req.user?.email || 'admin');
    securityLog(req, 'result_corrected', req.user, `football ${req.params.id}: ${req.body?.action}${req.body?.action === 'result' ? ` ${req.body?.home}-${req.body?.away}` : ''}`);
    refreshPages('summary', 'record', 'results');
    res.json({ data: r });
  } catch (e: any) {
    if (e instanceof SettleError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Could not settle the game');
  }
});
// fix239: American football / tennis results waiting for a decision (services/resultChecks.ts): swap / confirm
app.post('/api/admin/result-review/:sport/:id(\\d+)', jsonOnly, (req, res) => {
  try {
    const r = decideReview(req.params.sport, parseInt(req.params.id, 10), String(req.body?.action || ''), req.user?.email || 'admin');
    securityLog(req, 'result_corrected', req.user, `${req.params.sport} ${req.params.id}: ${req.body?.action}`);
    res.json({ data: r });
  } catch (e: any) {
    if (e instanceof ReviewError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Correction failed');
  }
});
// fix239: the buttons of the admin emails (services/adminMail.ts): /admin/act/<token> asks what the link does (GET) and
// runs it once (POST, from a signed-in admin's page — a mail scanner opening the link changes nothing); every use logged
app.get('/api/admin/email-action/:token', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: actionInfo(req.params.token) }); });
app.post('/api/admin/email-action/:token', jsonOnly, (req, res) => {
  const r = runAction(req.params.token, req.user?.email || 'admin');
  securityLog(req, 'email_action', req.user, `${r.label || 'link'}: ${r.message || r.state}`);
  if (r.payloadGame) for (const k of [`${r.payloadGame}|0`, `${r.payloadGame}|1`]) bbGameCache.delete(k); // the corrected page at once
  res.status(r.state === 'invalid' ? 404 : 200).json({ data: r });
});
app.post('/api/admin/bb/result-checks/run', async (_req, res) => {
  try { res.json({ data: await checkResults(30) }); } catch (e) { sendError(res, e, 'Check failed'); }
});
app.get('/api/admin/bb/game/:id(\\d+)/result', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.set('Cache-Control', 'no-store');
  res.json({ data: { check: openCheck(id), fix: resultFix(id) } });
});
app.post('/api/admin/bb/game/:id(\\d+)/result', jsonOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = adminResult(id, String(req.body?.action || ''), req.body, req.user?.email || 'admin');
    for (const k of [`${id}|0`, `${id}|1`]) bbGameCache.delete(k); // fix196: the corrected page at once
    securityLog(req, 'bb_result_corrected', req.user, `game ${id}: ${req.body?.action}${req.body?.hs != null ? ` ${req.body.hs}-${req.body.as_}` : ''}`);
    res.json({ data: r });
  } catch (e: any) {
    if (e instanceof ResultError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Correction failed');
  }
});
// fix202: stored pages (the top leagues built on start; any league kept fresh while visitors open it)
definePage({
  name: 'bb-standings', freshMs: 10 * 60 * 1000, variants: VIEWS_PLAIN, warm: ['NBA', 'EL', 'ACB', 'LBA', 'BSL', 'EC'].map(code => ({ code })),
  build: async q => ({ data: await bbStandings(q.code), timestamp: new Date().toISOString() })
});
app.get('/api/basketball/standings/:code([A-Za-z0-9]{2,8})', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    if (bbKnown(code)) return await sendStored(req, res, 'bb-standings', { code }, plainView(req));
    await byWorker(req, res, async () => res.json({ data: await bbStandings(code), timestamp: new Date().toISOString() }));
  } catch (error: any) {
    sendError(res, error, 'Failed to load standings');
  }
});
app.get('/api/basketball/team/:id(\\d+)', async (req, res) => {
  try {
    const data = await crawlerSafe(() => bbTeam(parseInt(req.params.id, 10), isPaid(req.access || 'anon')));
    if (!data) return res.status(404).json({ error: 'Team not found' });
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load team');
  }
});
app.get('/api/basketball/player/:id(\\d+)', async (req, res) => {
  try {
    const data = await crawlerSafe(() => bbPlayer(parseInt(req.params.id, 10)));
    if (!data) return res.status(404).json({ error: 'Player not found' });
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load player');
  }
});
app.get('/api/basketball/leaders', (req, res) => {
  try {
    // fix174: every league with box scores (?league=CODE); the NBA keeps balldontlie's leaders
    const code = typeof req.query.league === 'string' && /^[A-Za-z0-9]{2,8}$/.test(req.query.league) ? req.query.league.toUpperCase() : 'NBA';
    res.json({ data: code === 'NBA' ? nbaLeaders() : bbLeagueLeaders(code), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load leaders');
  }
});
definePage({
  name: 'bb-record', freshMs: 5 * 60 * 1000, variants: VIEWS_PLAIN, warm: [{ days: 30 }],
  build: q => ({ data: bbRecord(Number(q.days) || 3650, q.league || undefined), timestamp: new Date().toISOString() })
});
app.get('/api/basketball/record', async (req, res) => {
  try {
    const code = typeof req.query.league === 'string' && /^[A-Za-z0-9]{2,8}$/.test(req.query.league) ? req.query.league.toUpperCase() : undefined;
    const days = Math.min(3650, parseInt(String(req.query.days || '3650'), 10) || 3650);
    if (bbKnown(code)) return await sendStored(req, res, 'bb-record', { days, league: code }, plainView(req));
    byWorker(req, res, () => res.json({ data: bbRecord(days, code), timestamp: new Date().toISOString() }));
  } catch (error: any) {
    sendError(res, error, 'Failed to load record');
  }
});
app.get('/api/basketball/upset-watch', (req, res) => {
  if (!proGate(req, res)) return;
  try { res.json({ data: winnerUpsetReport('basketball'), timestamp: new Date().toISOString() }); } catch (e) { sendError(res, e, 'Upset watch failed'); }
});
// Admin: how the model did on past seasons it never saw (internal, like football's past seasons)
app.get('/api/bb/backtest', (_req, res) => res.json({ data: bbBacktest(), timestamp: new Date().toISOString() }));
// fix217 (admin): NBA model check — v4 mode, the gate table, the latest player fit, v4 vs bb-v3 side by side, and every
// re-pricing before tip-off (players removed, how far the margin moved). ?days= (default 14)
app.get('/api/admin/nba-model-check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: nbaV4Check(Math.min(90, Number(req.query.days) || 14)) }); } catch (e) { sendError(res, e, 'NBA model check failed'); }
});
// fix246 (admin only, not in OPEN_API): "Our different view" — games where our model and the market disagree, by sport,
// league and gap band (past seasons + live), the upcoming games with a 5+ point gap and the record frozen at kick-off.
// Market prices stay admin-only. ?fresh=1 rebuilds (else 15 min cache)
app.get('/api/admin/diff-view', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: await diffViewReport(Date.now(), req.query.fresh === '1') }); } catch (e) { sendError(res, e, 'Different view test failed'); }
});
// fix224 (admin): basketball injuries read from news ("reported out"): the review list, dismiss (never applied again) / ok
app.get('/api/admin/bb/news-injuries', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: newsInjuryList() }); } catch (e) { sendError(res, e, 'News injuries failed'); }
});
app.post('/api/admin/bb/news-injuries/:id(\d+)/:action(dismiss|ok)', jsonOnly, (req, res) => {
  const ok = reviewNewsInjury(Number(req.params.id), req.params.action as 'dismiss' | 'ok');
  if (ok) logger.info(`bb news injuries: ${req.params.action} ${req.params.id} by ${req.user?.email || 'admin'}`);
  res.json({ data: { ok } });
});
// fix219 (admin): bb-v4 grid tuner — ?train=2022,2023,2024&test=2025 (the live period 2026+ is refused), &apply=1 stores
// and publishes the settings (no redeploy). Runs in the job thread, one heavy job at a time.
// fix234: these four fits answer at once — ?run=1 starts the job (heavy queue, job thread), every call answers with
// the job's state, its result when done and the stored report (services/adminJobs.ts); the page polls
const fitJob = (key: string, run: () => unknown, stored: () => unknown, shape?: (r: any) => unknown): express.RequestHandler => (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (req.query.run === '1') startAdminJob(key, req.query, run);
    res.json({ data: adminJobAnswer(key, stored(), shape) });
  } catch (e) { sendError(res, e, `${key} failed`); }
};
const noParams = (r: any) => (r && typeof r === 'object' ? { ...r, params: undefined } : r);
app.get('/api/bb/tune', (req, res, next) => {
  const nums = (s: unknown) => String(s || '').split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
  // fix223: apply=gate stores the fit when the gate passes (the first store on a database; later: not worse than live)
  const apply = req.query.apply === '1' ? true : req.query.apply === 'gate' ? 'gate' as const : false;
  const opt = { train: nums(req.query.train), test: req.query.test ? parseInt(String(req.query.test), 10) : undefined, apply };
  return fitJob('bb tune', () => (threadJobsOn() ? inThread('bb tune', [opt]) : runTune(opt)), () => tunedInfo().report)(req, res, next);
});
// fix223 (admin): the per-league settings on top of the stored shared tune — a report; &apply=1 stores the leagues that
// passed their gate (fit 2022-23 + 2023-24, test 2024-25, refit on the three; 2025-26 the untouched check). Job thread.
app.get('/api/bb/league-tune', (req, res, next) => {
  const opt = { apply: req.query.apply === '1' };
  return fitJob('bb league tune', () => (threadJobsOn() ? inThread('bb league tune', [opt]) : runLeagueTune(opt)), () => storedLeagues()?.report ?? null)(req, res, next);
});
// fix228 (admin): row #4 (missing players) fitted on who actually played (NBA; the other leagues' proxy weight the same
// way), frozen in a shared tune around it; ?apply=gate (default) stores it when the gate passes, apply=1 always, apply=0 report only
app.get('/api/bb/missing-fit', (req, res, next) => {
  const apply = req.query.apply === '1' ? true : req.query.apply === '0' ? false : 'gate' as const;
  const opt = { apply };
  return fitJob('bb miss fit', () => (threadJobsOn() ? inThread('bb miss fit', [opt]) : runMissFit(opt)), () => noParams(storedMiss()), noParams)(req, res, next);
});
// fix225 (admin): player impact = box-score value blended with on/off + the star factor; ?apply=gate (default) | 1 | 0
app.get('/api/bb/impact-fit', (req, res, next) => {
  const apply = req.query.apply === '1' ? true : req.query.apply === '0' ? false : 'gate' as const;
  const opt = { apply };
  return fitJob('bb impact fit', () => (threadJobsOn() ? inThread('bb impact fit', [opt]) : runImpactFit(opt)), () => noParams(storedImpact()), noParams)(req, res, next);
});
// fix236 (admin): the stored fix225 fit judged again by the gate on the live basis (NBA #4 = who played), no refit; ?apply=gate (default) | 1 | 0
app.get('/api/bb/impact-regate', (req, res, next) => {
  const apply = req.query.apply === '1' ? true : req.query.apply === '0' ? false : 'gate' as const;
  return fitJob('bb impact regate', () => regateImpact({ apply }), () => noParams(storedImpact()), noParams)(req, res, next);
});
// fix219 (admin): the stored bb-v4 settings, the last tune report and the gate; ?reload=1 publishes again, ?clear=1 = code defaults
app.get('/api/bb/tuned', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: tunedInfo(req.query.clear === '1' ? 'clear' : req.query.reload === '1' ? 'reload' : undefined) }); } catch (e) { sendError(res, e, 'Failed'); }
});
// fix222 (admin): the calibration layer of basketball / tennis — the test season raw vs calibrated, per league kept or
// not, the strong lines and the live season (never fitted); ?rebuild=1 builds it again in the background
app.get('/api/admin/calibration', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sport = req.query.sport === 'tennis' ? 'tennis' : 'basketball';
  // fix222b: the basketball in-season layer's switch (stored; BB_INSEASON overrides it), then a rebuild to use it
  const inseason = req.query.inseason === 'on' || req.query.inseason === 'off' ? req.query.inseason : null;
  if (sport === 'basketball' && inseason) { setInSeasonMode(inseason); securityLog(req, 'bb_inseason_layer', req.user, inseason); }
  if (req.query.rebuild === '1' || (sport === 'basketball' && inseason)) {
    if (sport === 'basketball') void heavy('bb calibration', () => buildBbCalibration('admin'));
    else void tennisModelTick('report').catch(e => logger.warn(`tennis report: ${e?.message || e}`));
  }
  try { res.json({ data: { sport, rebuilding: req.query.rebuild === '1' || !!inseason, inSeasonMode: sport === 'basketball' ? inSeasonMode() : null, inSeasonEnv: process.env.BB_INSEASON || null, report: calibReport(sport) } }); } catch (e) { sendError(res, e, 'Failed'); }
});
app.get('/api/bb/wf', (req, res) => res.json({ data: bbWalkForward(String(req.query.code || '').toUpperCase()), timestamp: new Date().toISOString() }));
// Live scores: both providers' latest reading of every Football-Data.org match and the one shown (liveScores.ts)
app.get('/api/admin/live-book', (_req, res) => res.json({ data: liveBookStatus(), timestamp: new Date().toISOString() }));
// Football: daily self-learning log (last 30 days); ?run=1 runs today's job now, ?report=1 (re)sends the morning report,
// ?preview=1 builds the report text without sending
app.get('/api/admin/model-daily', async (req, res) => {
  try {
    if (req.query.run === '1') { if (dailyRunning()) { res.json({ data: { running: true } }); return; } void runModelDaily(true); res.json({ data: { started: true } }); return; }
    if (req.query.report === '1') { res.json({ data: await sendMorningReport(true) }); return; }
    if (req.query.preview === '1') { res.json({ data: { text: buildReport() } }); return; }
    res.json({ data: { ...modelDailyLog(Math.min(90, Number(req.query.days) || 30)), feature: featureModelStatus() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Model daily failed');
  }
});
// v3-mix: backtest on this season to date (?from=YYYY-MM-DD&season=2627) and publishing switch (?mode=auto|on|off, ?weight=0.5)
app.get('/api/admin/v3-mix', async (req, res) => {
  try {
    if (req.query.mode !== undefined) {
      const mode = String(req.query.mode);
      if (!['auto', 'on', 'off'].includes(mode)) { res.status(400).json({ error: 'mode must be auto, on or off' }); return; }
      setModelConfig('mix_mode', mode);
      if (mode === 'on') setMixLive(true);
      if (mode === 'off') setMixLive(false);
      clearPredictionCache();
    }
    if (req.query.weight !== undefined) {
      const w = Number(req.query.weight);
      if (!(w >= 0 && w <= 1)) { res.status(400).json({ error: 'weight must be 0..1' }); return; }
      setModelConfig('mix_weight', String(w));
      clearPredictionCache();
    }
    // fix234: ?backtest=1 starts the backtest (heavy queue) and answers at once; later calls show it running or its result
    const btOpt = { from: req.query.from ? String(req.query.from) : undefined, season: req.query.season ? String(req.query.season) : undefined };
    if (req.query.backtest === '1') startAdminJob('v3-mix backtest', btOpt, () => v3MixBacktest(btOpt));
    const bt = adminJobAnswer('v3-mix backtest', null);
    res.json({ data: { status: featureModelStatus(), ...(bt.job ? { backtest: bt.result ?? { running: bt.job.running, state: bt.job.state, queuedAt: bt.job.queuedAt, startedAt: bt.job.startedAt, error: bt.job.error } } : {}) }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'v3-mix failed');
  }
});
// live win chance tested at the end of Q1 / Q2 / Q3 on finished games (?tune=1: grid over a / b; ?a=&b= to try values)
app.get('/api/bb/live-test', (req, res) => {
  const conf: Record<string, number> = {};
  for (const k of ['a', 'b']) if (req.query[k] !== undefined && Number.isFinite(Number(req.query[k]))) conf[k] = Number(req.query[k]);
  try {
    res.json({ data: bbLiveQuarterTest(conf, req.query.tune === '1'), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Basketball live test failed');
  }
});
// Admin: research export of one league's games (model research in the browser)
app.get('/api/bb/export', (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) return res.status(400).json({ error: 'code' });
  res.json({ data: req.query.players ? bbExportPlayers(code) : bbExport(code), timestamp: new Date().toISOString() });
});

// Admin: basketball data (API-Basketball, same API-Sports key). Not in OPEN_API → admin only.
app.get('/api/bb/status', async (_req, res) => {
  try {
    res.json({ data: { ...(await bbStatus()), balldontlie: bdlStatus() }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Basketball status failed');
  }
});
app.get('/api/bb/sync', async (_req, res) => {
  try {
    res.json({ data: await bbSyncNow(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Basketball sync failed');
  }
});
app.get('/api/bb/raw', async (req, res) => {
  const pathQ = String(req.query.path || '/leagues');
  if (!['/leagues', '/seasons', '/games', '/teams', '/standings', '/statistics', '/odds', '/games/statistics/teams', '/games/statistics/players', '/players'].includes(pathQ)) return res.status(400).json({ error: 'path not allowed' });
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (!['path', 'token', 'c'].includes(k)) params[k] = String(v);
  try {
    res.json({ data: await bbGet(pathQ, params), timestamp: new Date().toISOString() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/api/bb/bdl', async (req, res) => {
  // admin: raw balldontlie calls (testing what the GOAT plan gives us); the key never leaves the server
  const pathQ = String(req.query.path || '/v1/player_injuries');
  if (!/^\/(v1|nba\/v1|nba\/v2)\/[a-z0-9_\/]+$/.test(pathQ)) return res.status(400).json({ error: 'path not allowed' });
  const params: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.query)) if (!['path', 'token', 'c'].includes(k)) { if (Array.isArray(v)) params[k.endsWith('[]') ? k : `${k}[]`] = v.map(String); else params[k] = String(v); } // Express turns ids[]=1 into ids: ['1']
  try {
    res.json({ data: await bdlGet(pathQ, params), timestamp: new Date().toISOString() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/api/bb/injuries-refresh', async (_req, res) => {
  const n = await refreshNbaInjuries();
  res.json({ data: { players: n, status: nbaInjuryStatus() }, timestamp: new Date().toISOString() });
});

// Admin: fill bookmaker odds for tracked national-team / cup matches saved without them (last 7 days)
app.get('/api/af/odds-backfill', async (_req, res) => {
  try {
    res.json({ data: await backfillAfOdds(80), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Odds backfill failed');
  }
});

app.get('/api/af/xg', (_req, res) => {
  res.json({ data: xgCoverage(), timestamp: new Date().toISOString() });
});

// fix164: broken team links (matches of the last and next 7 days, every sport; resolver only). ?run=1 checks now.
app.get('/api/admin/link-check', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // fix234: ?run=1 (or none stored yet) starts it in the background; the answer is the last stored check + the job's state
  try {
    if (req.query.run === '1' || !lastLinkCheck()) startAdminJob('link check', null, () => runLinkCheck());
    const j = adminJobAnswer('link check', null);
    res.json({ data: lastLinkCheck() ?? { running: true, queuedAt: j.job?.queuedAt ?? null, startedAt: j.job?.startedAt ?? null }, job: j.job, timestamp: new Date().toISOString() });
  } catch (e) { sendError(res, e, 'Link check failed'); }
});

// Admin: event-loop stalls and how long the heavy jobs take (why the site feels slow)
// fix202: this process's numbers (the web process: the one visitors wait for), the worker's health (last run of each
// job, memory, restarts), the stored pages and the model state taken from the worker
// fix232: a summary by default (≤ 50 KB, from memory only: no table read, no multi-MB JSON on the web — the 5 MB answer
// froze the web 4.8–18.6 s each time); ?full=1 the old detail (the stored-page list read by the worker, sent as its
// text), ?shared=1 the shared-state list. /api/perf itself is not counted as a web stall (perf.ts isDiagLabel).
const PERF_MAX = 50 * 1024;
const topJobs = (jobs: Record<string, any>, n: number) => Object.entries(jobs || {}).sort((a, b) => (b[1].totalMs || 0) - (a[1].totalMs || 0) || (b[1].maxMs || 0) - (a[1].maxMs || 0)).slice(0, n)
  .map(([job, j]) => ({ job, runs: j.runs, totalMs: j.totalMs ?? null, maxMs: j.maxMs, lastMs: j.lastMs, lastAt: j.lastAt, maxStallMs: j.maxStallMs }));
// fix248c: HTML pages sent as the plain app page (no stored copy), see noteSeoMiss
const seoMisses = { counts: new Map<string, number>(), last: [] as { at: string; kind: string; why: string; path: string }[] };
const seoMissStatus = () => ({ counts: Object.fromEntries([...seoMisses.counts].sort((a, b) => b[1] - a[1]).slice(0, 30)), last: seoMisses.last.slice(-20).reverse() });
function perfSummaryText(): string {
  const w: any = workerHealth();
  const { hours, ...web } = perfSummary();
  const worker = w.on === undefined || !('pid' in w) ? w : {
    on: w.on, pid: w.pid, upMin: w.upMin, restarts: w.restarts, restarts24h: w.restarts24h, reportAgeS: w.reportAgeS,
    lastExit: w.lastExit ? { ...w.lastExit, stderr: (w.lastExit.stderr || []).slice(-10) } : null,
    exits24h: (w.exits24h || []).slice(0, 5), memoryMb: w.memoryMb, heapMb: w.heapMb, heapLimitMb: w.heapLimitMb,
    stallsLastHour: w.stallsLastHour, worstLastHour: w.worstLastHour, running: w.running, heavy: w.heavy && { ...w.heavy, waiting: (w.heavy.waiting || []).slice(0, 20) },
    topStalls: (w.topStalls || []).slice(0, 20).map((s: any) => ({ at: s.at, ms: s.ms, job: s.job ? String(s.job).slice(0, 300) : null })),
    jobs: topJobs(w.jobs, 30), memByJob: (w.memByJob || []).slice(0, 10)
  };
  const body: any = { process: ROLE, summary: true, web, worker, memory: memorySizing(), pageMemory: pageMemStatus(), pageReader: pageReaderStatus(), botPages: botGate.status(), workerRoutes: workerRoutesStatus(), webBuilds: webBuilds(), webWrites: deferredStatus(), slowRequests: slowRequests(), seoMisses: seoMissStatus(), htmlBy: htmlByStatus(), hours };
  let text = JSON.stringify({ data: body, timestamp: new Date().toISOString() });
  if (text.length > PERF_MAX) { body.hours = hours.slice(-6); text = JSON.stringify({ data: body, timestamp: new Date().toISOString() }); }
  if (text.length > PERF_MAX) { body.hours = []; body.web.jobs = body.web.jobs.slice(0, 10); if (body.worker?.jobs) body.worker.jobs = body.worker.jobs.slice(0, 10); text = JSON.stringify({ data: body, timestamp: new Date().toISOString() }); }
  return text;
}
app.get('/api/perf', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.shared === '1') return res.json({ data: { process: ROLE, shared: sharedStatus(), workerShared: (workerHealth() as any).shared ?? null }, timestamp: new Date().toISOString() });
  if (req.query.full !== '1') return res.type('application/json').send(perfSummaryText());
  // the old detail: this process's numbers, the worker's report and the stored pages (listed by the worker)
  const { shared: _shared, ...worker } = workerHealth() as any;
  const head = JSON.stringify({ process: ROLE, ...perfStatus(), history: perfHours('web'), memory: memorySizing(), worker, pageMemory: pageMemStatus(), pageReader: pageReaderStatus(), botPages: botGate.status(), workerRoutes: workerRoutesStatus(), webBuilds: webBuilds(), webWrites: deferredStatus(), threadJobs: threadJobStatus() });
  let pages = 'null';
  if (isWeb) {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    try { const a = await fetchFromWorker(req, 15_000, `/api/perf/pages${qs}`); if (a.status === 200) pages = a.body.toString('utf8'); } catch { /* the worker is restarting */ }
  } else pages = JSON.stringify(pageCacheStatus());
  res.type('application/json').send(`{"data":${head.slice(0, -1)},"pages":${pages}},"timestamp":"${new Date().toISOString()}"}`);
});
// fix232 (worker): the stored pages for /api/perf?full=1
app.get('/api/perf/pages', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(pageCacheStatus()); });

app.get('/api/af/status', async (_req, res) => {
  try {
    res.json({ data: await afStatus(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'API-Football status failed');
  }
});
// Live closing-line value: v3 at the open price vs the closing price
app.get('/api/clv', (req, res) => {
  try {
    res.json({ data: clvReport(parseInt(String(req.query.days || '90'), 10) || 90), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'CLV report failed');
  }
});
app.get('/api/clv/probe', async (req, res) => {
  try {
    res.json({ data: await clvProbe(req.query.fixture ? Number(req.query.fixture) : undefined), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'CLV probe failed');
  }
});
app.get('/api/clv/tick', async (_req, res) => {
  res.json({ data: await clvTick(), timestamp: new Date().toISOString() });
});

app.get('/api/af/window', async (req, res) => {
  if (req.query.refresh === '1') await refreshAfWindow().catch(() => undefined);
  res.json({ data: afWindowStatus(), timestamp: new Date().toISOString() });
});

app.get('/api/af/sync', (_req, res) => {
  afTick(true).catch(() => undefined);
  res.json({ data: { started: true }, timestamp: new Date().toISOString() });
});

// Backfill v3 predictions for the tracked matches v2 already has (walk-forward, flagged backfilled=1)
const backfillHandler = (req: express.Request, res: express.Response) => {
  try {
    res.json({ data: backfillV3('dc-history-v2', req.query.redo === '1'), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'v3 backfill failed');
  }
};
app.post('/api/model/v3/backfill', backfillHandler);
app.get('/api/model/v3/backfill', backfillHandler);
app.get('/api/model/v3/squad/sync', squadSyncHandler);

// Start a walk-forward backtest (runs in the background).
// ?season=2526&group=E (group optional = all) &model=dc-history-v2|grid-v3
// For grid-v3, conversion constants can be overridden for calibration: &gapScale=0.05&kDraw=1.5&drawBase.big=240 …
const runBacktestHandler = (req: express.Request, res: express.Response) => {
  const season = String(req.query.season || '2526');
  const group = req.query.group ? String(req.query.group).toUpperCase() : undefined;
  const model = String(req.query.model || 'dc-history-v2');
  if (backtestProgress() || backtestProgressV3() || sweeping || leagueTuning) {
    res.status(409).json({ error: 'A backtest is already running', progress: backtestProgress() || backtestProgressV3() });
    return;
  }
  let job: Promise<any>;
  if (model === MODEL_V3) {
    const conv: any = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (['season', 'group', 'model', 'divisions', 'r', 'token'].includes(k)) continue;
      const num = parseFloat(String(v));
      if (!Number.isFinite(num)) continue;
      const [a, b] = k.split('.');
      if (b) conv[a] = { ...((CONV as any)[a] || {}), ...(conv[a] || {}), [b]: num };
      else conv[a] = num;
    }
    const allDivs = req.query.divisions === 'all'; // include second divisions (Championship, Segunda, Serie B, 2. BL, Ligue 2)
    // relevance override for this run only, compact syntax: r=1:0,0,0,0 (row #1 off)
    const rel = req.query.r ? parseCompactVariants(String(req.query.r))[0]?.rel || null : null;
    if (rel) setRelOverride(rel);
    job = (group ? runBacktestV3(season, group, conv, allDivs) : runBacktestV3All(season, conv, allDivs)).finally(() => { if (rel) setRelOverride(null); });
  } else {
    job = group ? runBacktest(season, group) : runBacktestAll(season);
  }
  job.catch(err => logger.error('Backtest failed', { message: err.message }));
  res.json({ data: { started: true, season, group: group || 'ALL', model }, timestamp: new Date().toISOString() });
};
app.post('/api/backtest/run', runBacktestHandler);
app.get('/api/backtest/run', runBacktestHandler); // GET alias so a run can be started from a browser tab

// v3 sweep: score many variants in memory, in the background; nothing is stored in the DB.
//   GET /api/backtest/sweep?season=2526&auto=rel|rows|conv     → start (auto lists: every relevance cell ±1 / each row off,half,x2 / conv nudges)
//   GET /api/backtest/sweep?season=2526&r=#1:0,0,0,0;#7:2,4,6,8/#21:4,6,8,6   → compact relevance variants (mismatch,standard,even,big)
//   GET /api/backtest/sweep?season=2526&v=[{"name":"x","conv":{"gapScale":0.2},"rel":{"#1":{"even":5}}}]
//   GET /api/backtest/sweep/result                              → progress while running, then the last table
// Base conv for every variant: dot-params as on the run endpoint (&homeGap=0.07&drawBase.even=340). &groups=E,SP limits leagues.
let sweeping = false;
let lastSweep: any = null;
const sweepHandler = (req: express.Request, res: express.Response) => {
  if (sweeping || leagueTuning || backtestProgressV3()) { res.status(409).json({ error: 'A sweep or backtest is already running', progress: sweepProgress }); return; }
  const q: any = { ...(req.query || {}), ...(req.body || {}) };
  const season = String(q.season || '2526');
  const groups = q.groups ? (Array.isArray(q.groups) ? q.groups : String(q.groups).split(',')).map((g: string) => g.toUpperCase()) : undefined;
  let variants: SweepVariant[] = [];
  try {
    if (q.variants) variants = q.variants;
    if (q.v) variants = variants.concat(JSON.parse(String(q.v)));
    if (q.r) variants = variants.concat(parseCompactVariants(String(q.r)));
    if (q.auto) for (const a of String(q.auto).split(',')) variants = variants.concat(autoVariants(a, q.step ? Number(q.step) : 1));
  } catch (err: any) { res.status(400).json({ error: `Bad variants: ${err.message}` }); return; }
  const base: any = q.base && typeof q.base === 'object' ? q.base : {};
  for (const [k, v] of Object.entries(req.query)) {
    if (['season', 'groups', 'auto', 'step', 'v', 'r', 'token'].includes(k)) continue;
    const num = parseFloat(String(v));
    if (!Number.isFinite(num)) continue;
    const [a, b] = k.split('.');
    if (b) base[a] = { ...((CONV as any)[a] || {}), ...(base[a] || {}), [b]: num };
    else base[a] = num;
  }
  sweeping = true;
  lastSweep = { running: true, startedAt: new Date().toISOString(), variants: variants.length };
  sweepV3(season, variants, base, groups)
    .then(out => { lastSweep = { running: false, ...out }; })
    .catch(err => { lastSweep = { running: false, error: err.message }; logger.error('Sweep failed', { message: err.message }); })
    .finally(() => { sweeping = false; });
  res.json({ data: { started: true, season, variants: variants.length, groups: groups || 'ALL', base }, timestamp: new Date().toISOString() });
};
app.get('/api/backtest/sweep', sweepHandler);
// Player data (API-Football /players per team & season) for the coming player-quality row
app.get('/api/players/data-status', (_req, res) => {
  res.json({ data: playerDataStatus(), timestamp: new Date().toISOString() });
});
app.get('/api/players/team', (req, res) => {
  const team = Number(req.query.team), season = Number(req.query.season);
  if (!team || !season) { res.status(400).json({ error: 'team and season required' }); return; }
  res.json({ data: teamPlayers(team, season), timestamp: new Date().toISOString() });
});
app.post('/api/backtest/sweep', sweepHandler);
app.get('/api/backtest/sweep/result', (_req, res) => {
  res.json({ data: sweeping ? { running: true, progress: sweepProgress } : lastSweep, timestamp: new Date().toISOString() });
});

// Full v3 tuner: every row weight and conversion constant fitted on whole seasons, scored on a later one
//   GET /api/model/v3/tune?train=2425,2526&test=2627[&since=YYYY-MM-DD][&rounds=80][&lambda=0][&shared=1][&lc=0][&obj=brier][&all=1][&only=rel|conv|#1,...][&freeze=...][&apply=1]
//   GET /api/model/v3/tune/result · GET /api/model/v3/tuned[?clear=1]
app.get('/api/model/v3/tune', (req, res) => {
  if (isTuning() || leagueTuning || sweeping || backtestProgressV3()) { res.status(409).json({ error: 'A tune, sweep or backtest is already running' }); return; }
  const q = req.query as Record<string, string>;
  const list = (v?: string) => (v ? String(v).split(',').map(x => x.trim()).filter(Boolean) : []);
  const opt = {
    train: list(q.train || '2425,2526'), test: list(q.test || '2627'), since: q.since || null,
    rounds: q.rounds ? parseInt(q.rounds, 10) : 80, lambda: q.lambda ? parseFloat(q.lambda) : 0,
    shared: q.shared === '1', lc: q.lc !== '0', obj: (q.obj === 'brier' ? 'brier' : 'll') as 'll' | 'brier',
    apply: q.apply === '1', allDivs: q.all === '1', freeze: list(q.freeze), only: list(q.only)
  };
  tuneV3Full(opt).then(() => logger.info('v3 full tune finished')).catch(err => logger.error('v3 full tune failed', { message: err.message }));
  res.json({ data: { started: true, options: opt }, timestamp: new Date().toISOString() });
});
app.get('/api/model/v3/tune/result', (_req, res) => {
  res.json({ data: tuneStatus(), timestamp: new Date().toISOString() });
});
app.get('/api/model/v3/tuned', (req, res) => {
  if (req.query.clear === '1') { clearTuning(); res.json({ data: { cleared: true, live: tunedStatus().live } }); return; }
  if (req.query.reload === '1') { const ok = applyStoredTuning(); res.json({ data: { reloaded: ok, ...tunedStatus() } }); return; }
  res.json({ data: tunedStatus(), timestamp: new Date().toISOString() });
});

// Per-league v3 settings (draw / home advantage / favourite strength per division), fitted on one season and
// kept only if they also win on the next one.
//   GET /api/model/v3/league-tune?train=2425&test=2526&extra=2627[&apply=1]   → start in the background
//   GET /api/model/v3/league-tune/result                                     → progress, then the report
//   GET /api/model/v3/league-conv[?clear=1]                                  → settings in use (clear = back to shared model)
let leagueTuning = false;
let lastLeagueTune: any = null;
app.get('/api/model/v3/league-tune', (req, res) => {
  if (leagueTuning || sweeping || backtestProgressV3()) { res.status(409).json({ error: 'A tune, sweep or backtest is already running', progress: leagueTuneProgress }); return; }
  const train = String(req.query.train || '2425'), test = String(req.query.test || '2526'), extra = String(req.query.extra || '2627');
  const apply = req.query.apply === '1';
  leagueTuning = true;
  lastLeagueTune = { running: true, startedAt: new Date().toISOString() };
  tuneLeaguesV3(train, test, extra, apply)
    .then(out => { lastLeagueTune = { running: false, ...out }; })
    .catch(err => { lastLeagueTune = { running: false, error: err.message }; logger.error('League tune failed', { message: err.message }); })
    .finally(() => { leagueTuning = false; });
  res.json({ data: { started: true, train, test, extra, apply }, timestamp: new Date().toISOString() });
});
app.get('/api/model/v3/league-tune/result', (_req, res) => {
  res.json({ data: leagueTuning ? { running: true, progress: leagueTuneProgress } : lastLeagueTune, timestamp: new Date().toISOString() });
});
app.get('/api/model/v3/league-conv', (req, res) => {
  if (req.query.clear === '1') clearLeagueConv();
  res.json({ data: leagueConvStatus(), timestamp: new Date().toISOString() });
});

// Admin: do team draw habits / head-to-head draws beat the bookmakers' draw price? ?season=2526
app.get('/api/backtest/draw-factors', (req, res) => {
  try {
    res.json({ data: drawFactorTest(String(req.query.season || '2526')), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Draw factor test failed');
  }
});

// Upset watch (Pro, model only): fix242 — favourite 50%+, underdog 25%+ with a clear reason, 10 a week shown, the last
// 30 days' record (utils/upsetWatch.ts); answered by the worker (WORKER_ROUTES)
app.get('/api/upset-watch', (_req, res) => {
  try {
    res.json({ data: upsetWatchReport(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Upset watch failed');
  }
});

// Draw alerts page (premium): upcoming alerts, live record, backtest seasons
// fix202: a stored page (2.4 s to build): built in the worker every 10 minutes
definePage({
  name: 'draw-alerts', freshMs: 10 * 60 * 1000, warm: [{}],
  build: async () => ({ data: await drawAlertsReportAsync(), timestamp: new Date().toISOString() }), // fix210b: in slices
  // visitors: our own draw picks and draw facts only (the value-alert machinery stays for admins)
  variants: { public: (b: any) => jsonText(stripMarket({ ...b, data: { picks: b.data.picks, likely: b.data.likely, leagues: b.data.leagues, teams: b.data.teams } })) }
});
app.get('/api/draw-alerts', async (req, res) => {
  try {
    await sendStored(req, res, 'draw-alerts', {}, req.access === 'admin' ? null : 'public');
  } catch (error: any) {
    sendError(res, error, 'Draw alerts failed');
  }
});

// Market-anchored draw model: market early draw + k × (v3 − market), picks at the best early price
app.get('/api/backtest/draws-anchored', (req, res) => {
  try {
    res.json({ data: anchoredDrawTest(String(req.query.season || '2526'), String(req.query.model || MODEL_V3)), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Anchored draw test failed');
  }
});

// Draw value test: v3's draw picks priced at Pinnacle / average / best available / best at close
app.get('/api/backtest/draws', (req, res) => {
  try {
    res.json({ data: drawTest(String(req.query.season || '2526'), String(req.query.model || MODEL_V3)), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Draw test failed');
  }
});

// Can we beat the market? Information (blend), closing-line value and per-division edges: ?season=2526&model=grid-v3
app.get('/api/backtest/market', (req, res) => {
  try {
    res.json({ data: marketTest(String(req.query.season || '2526'), String(req.query.model || MODEL_V3)), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Market test failed');
  }
});

// Head-to-head diagnostics on the same backtested matches: ?season=2526&a=dc-history-v2&b=grid-v3
// ---------- Past predictions page (walk-forward backtests) + data inventory ----------
app.get('/api/past/seasons', (_req, res) => {
  try { res.json({ data: pastSeasons(), timestamp: new Date().toISOString() }); } catch (e: any) { sendError(res, e, 'Past seasons failed'); }
});
app.get('/api/past/predictions', (req, res) => {
  try {
    const q = req.query;
    res.json({
      data: pastPredictions({
        season: String(q.season || '2526'), model: String(q.model || 'grid-v3'),
        division: q.division ? String(q.division) : undefined, team: q.team ? String(q.team).slice(0, 40) : undefined,
        result: q.result ? String(q.result) : undefined, page: parseInt(String(q.page || '1'), 10), limit: parseInt(String(q.limit || '50'), 10)
      }),
      timestamp: new Date().toISOString()
    });
  } catch (e: any) { sendError(res, e, 'Past predictions failed'); }
});
app.get('/api/past/patterns', (_req, res) => {
  try { res.json({ data: leaguePatterns(), timestamp: new Date().toISOString() }); } catch (e: any) { sendError(res, e, 'League patterns failed'); }
});
app.get('/api/past/data', (_req, res) => {
  try { res.json({ data: dataInventory(), timestamp: new Date().toISOString() }); } catch (e: any) { sendError(res, e, 'Data inventory failed'); }
});

// Where the model loses to the market + which missing information would help (admin)
app.get('/api/backtest/gap', (req, res) => {
  try {
    res.json({ data: gapReport(String(req.query.season || '2526'), String(req.query.model || 'grid-v3')), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Gap report failed');
  }
});

app.get('/api/backtest/compare', (req, res) => {
  try {
    const season = String(req.query.season || '2526');
    const a = String(req.query.a || 'dc-history-v2');
    const b = String(req.query.b || MODEL_V3);
    res.json({ data: compareModels(season, a, b), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Compare failed');
  }
});

app.get('/api/backtest/progress', (_req, res) => {
  res.json({ data: backtestProgress() || backtestProgressV3(), timestamp: new Date().toISOString() });
});

// Backtest results. ?season=2425&group=E&minEvidence=0
app.get('/api/backtest', (req, res) => {
  try {
    const season = String(req.query.season || '2425');
    const group = req.query.group ? String(req.query.group).toUpperCase() : undefined;
    const minEvidence = parseFloat(String(req.query.minEvidence || '0')) || 0;
    const oddsKind = String(req.query.odds || 'close') === 'early' ? 'early' : 'close';
    const edge = parseFloat(String(req.query.edge || '0.05')) || 0.05;
    const model = String(req.query.model || 'dc-history-v2');
    const rows = backtestRows(season, group, minEvidence, model);
    const metrics = computeMetrics(
      rows.map(r => ({
        p_home: r.p_home,
        p_draw: r.p_draw,
        p_away: r.p_away,
        odds_home: oddsKind === 'early' ? r.early_h : r.odds_home,
        odds_draw: oddsKind === 'early' ? r.early_d : r.odds_draw,
        odds_away: oddsKind === 'early' ? r.early_a : r.odds_away,
        outcome: r.outcome,
        groupKey: r.division,
        groupName: r.division
      })),
      { edgeThreshold: edge }
    );
    res.json({
      data: {
        ...metrics, // includes `model` (the model's metrics) and `market`
        season,
        modelName: model,
        group: group || null,
        minEvidence,
        odds: oddsKind,
        edge,
        runs: backtestRunsList(),
        progress: backtestProgress() || backtestProgressV3(),
        sample: rows.slice(0, 200)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    sendError(res, error, 'Failed to read backtest');
  }
});

// ---------- Static site (production: this one process serves the API and the built frontend) ----------

const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
  // Hashed assets can be cached for a long time; index.html must always be fresh
  // Search engines: a live sitemap (served before the static file of the same name) and per-page head tags + content
  app.get('/fonts/:file', fontRoute);
  warmFonts();
  // fix202: the sitemaps are stored pages, built in the worker every hour
  // fix210b: the big ones (teams, players, leagues, basketball, NFL, tennis: season-long GROUP BYs, up to 4.8 s of blocked
  // worker) are built in a job thread; football reads the fixture window in this process's memory
  definePage({ name: 'sitemap', freshMs: 3600 * 1000, warm: ['sitemap.xml', ...Object.keys(SITEMAPS)].map(file => ({ file })),
    build: q => (q.file === 'sitemap.xml' ? sitemapXml() : !SITEMAPS[q.file] ? null : q.file !== 'sitemap-football.xml' && threadJobsOn() ? inThread<string | null>('sitemap', [q.file]) : SITEMAPS[q.file]()) });
  const sitemapOf = async (file: string) => { const s = await getPage('sitemap', { file }); if (typeof s?.body !== 'string') throw new Error('not built yet'); return s.body; };
  app.get('/sitemap.xml', async (_req, res) => {
    try { res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(await sitemapOf('sitemap.xml')); }
    catch (e: any) { logger.warn(`sitemap: ${e.message}`); res.sendFile(path.join(STATIC_DIR, 'sitemap.xml')); }
  });
  for (const file of Object.keys(SITEMAPS)) app.get(`/${file}`, async (_req, res) => {
    try { res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(await sitemapOf(file)); }
    catch (e: any) { logger.warn(`${file}: ${e.message}`); res.status(503).send('Try again later'); }
  });
  // fix226: the push service worker is checked by the browser on every visit (a new version must reach everyone), the
  // web app manifest (iPhone: alerts need the site added to the Home Screen) keeps a day
  app.get('/sw.js', (_req, res) => res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).sendFile(path.join(STATIC_DIR, 'sw.js')));
  app.get('/manifest.webmanifest', (_req, res) => res.type('application/manifest+json').set('Cache-Control', 'public, max-age=86400').sendFile(path.join(STATIC_DIR, 'manifest.webmanifest')));
  // files under /assets have a content hash in their name (a new version gets a new name): cache them for a year,
  // so returning visitors never download or re-check them. Other files (logo, icons) keep 7 days.
  app.use('/assets', express.static(path.join(STATIC_DIR, 'assets'), { index: false, maxAge: '365d', immutable: true }));
  // fix167: a file that isn't there (an old version's page file, asked by a tab opened before a deploy) is a plain 404:
  // never the HTML page (the browser would run it as a script), never an error log line; not cached, so a CDN or
  // browser asks again. The page reloads itself for the new version (frontend lib/chunkReload.ts).
  app.use('/assets', (_req, res) => { res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found'); });
  app.use(express.static(STATIC_DIR, { index: false, maxAge: '7d' }));
  const indexHtml = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  // fix202: the sport home pages (every language) as search engines get them: stored pages built in the worker
  const SEO_HOMES = ['', ...['es', 'pt', 'de', 'fr', 'it', 'tr'].map(l => `/${l}`)].flatMap(l => ['', '/football', '/basketball', '/american-football', '/tennis'].map(s => `${l}${s}` || '/'));
  // fix221: the finished HTML is stored beside each (made by the worker): the web process only sends it
  const VIEWS_HTML = { html: (b: any) => (b ? renderIndex(indexHtml, b) : '') };
  definePage({ name: 'seo', freshMs: 10 * 60 * 1000, warm: SEO_HOMES.map(p => ({ path: p })), variants: VIEWS_HTML, build: q => seoPage(q.path) });
  // fix210: every other page's head tags + content (every language: /fr/* was 4 s on the web process) — built by the
  // worker when first asked for, then served stored (10 min fresh; kept 2 days); the web process never builds one
  const SEO_WAIT_MS = Number(process.env.SEO_WAIT_MS) || 3000;
  /*
   * fix248c: which pages are sent as the plain app page because no stored copy is there (and why): /api/perf → seoMisses
   * (counts by page kind × reason × language, the last 20 addresses). A kind that keeps missing is one the worker does
   * not pre-build.
   */
  const noteSeoMiss = (kind: string, why: string, p: string, lang: string) => {
    const k = `${kind} · ${why} · ${lang}`;
    seoMisses.counts.set(k, (seoMisses.counts.get(k) || 0) + 1);
    if (seoMisses.counts.size > 200) seoMisses.counts.delete(seoMisses.counts.keys().next().value as string);
    seoMisses.last.push({ at: new Date().toISOString(), kind, why, path: p.slice(0, 120) });
    if (seoMisses.last.length > 20) seoMisses.last.shift();
  };
  // fix210b: a basketball game's data, one build for every language (finished games built ahead by the worker:
  // jobs.ts "bb game pages"); the web process writes the page's text from it (bbGameSeo: no database, no build)
  definePage({ name: 'bb-game-facts', freshMs: 10 * 60 * 1000, freshOf: bbFactsFreshMs, refresh: false, keepMs: 8 * 86400000, build: q => bbGameFacts(Number(q.id)) });
  definePage({ name: 'seo-page', freshMs: 10 * 60 * 1000, refresh: false, keepMs: 2 * 86400000, variants: VIEWS_HTML, build: q => seoPage(q.path) });
  // fix243: a basketball game's page per language, finished HTML made by the worker from the shared facts (the web
  // process parsed the facts and wrote the page itself on every crawler request: part of the 26 Oct bursts)
  definePage({ name: 'bb-game-seo', freshMs: 5 * 60 * 1000, refresh: false, keepMs: 2 * 86400000, variants: VIEWS_HTML,
    build: async q => { const f = (await getPage('bb-game-facts', { id: Number(q.id) }))?.body; return f ? bbGameSeo(f, q.lang as any, q.slug || undefined) : null; } });
  // fix243: a past season's match (410, noindex): the app page with the robots tag and a short line for those without it
  const pastHtml = new Map<string, string>();
  const pastPage = (lang: string, sport: string) => {
    const k = `${lang}|${sport}`;
    let h = pastHtml.get(k);
    if (!h) {
      const home = `${lang === 'en' ? '' : `/${lang}`}/${sport}`;
      h = indexHtml.replace('</head>', '<meta name="robots" content="noindex"></head>')
        .replace('<div id="root"></div>', `<div id="root"><div class="sl-seo" style="max-width:960px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif;line-height:1.6"><h1>This game is from a past season</h1><p>Past seasons are not public. <a href="${home}">See this season's games</a>.</p></div></div>`);
      pastHtml.set(k, h);
    }
    return h;
  };
  // fix235: a tab (/football/match/<slug>/stats) is its page for search engines (one stored copy, canonical = the page)
  const seoPathOf = (p: string) => p.replace(/^((?:\/(?:es|pt|de|fr|it|tr))?\/[a-z-]+\/(?:match|league)\/[a-z0-9-]+)\/[a-z0-9-]+\/?$/, '$1');
  const seoHome = (p: string) => { const x = p.replace(/\/+$/, '') || '/'; return SEO_HOMES.includes(x) ? x : null; };
  // fix229: an address outside the web process's slug state — the worker reads the table (3 s at most, else the app page)
  // fix248c: a visitor waits at most 800 ms for the answer (then the app page: the app resolves the slug itself); a
  // verified search engine 3 s (it gets the 301 / the page's HTML, and does not mind the wait)
  const askWorker = async (req: express.Request, qs: string): Promise<LinkAnswer> => {
    try {
      const a = await fetchFromWorker(req, isVerifiedCrawler(req) ? 3000 : 800, `/api/slug-route?p=${encodeURIComponent(req.path.slice(0, 300))}&q=${encodeURIComponent(qs.slice(0, 300))}`);
      return a.status === 200 ? (JSON.parse(a.body.toString('utf8'))?.data ?? null) : null;
    } catch { return null; }
  };
  // fix244: the Quick check on its own address (the app opens it on a 429 from the proxy rules; never counted)
  app.get(/^(\/(de|es|fr|it|pt|tr))?\/quick-check\/?$/, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(quickCheckPage(qcLangOf(req.path), turnstileSiteKey()));
  });
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, async (req, res) => {
    // fix243: a bot's page takes a slot (services/botGate.ts): over the limit 503 + Retry-After; browsers never wait here
    if (req.access !== 'admin' && !req.user && isBotUa(req.get('user-agent'))) {
      // fix245: a verified search engine waits for a slot instead (never this 503); after a long wait it goes on without one
      const release = await botGate.enter(isVerifiedCrawler(req));
      if (!release) return res.status(503).set({ 'Retry-After': '30', 'Cache-Control': 'no-store' }).type('text/plain').send('Busy, please retry later');
      res.once('finish', release); res.once('close', release);
    }
    // fix229: clean links — an old address (/team/86?c=…, /match/1, /basketball/game/1 …, any language) answers 301 with
    // its slug address in one hop, a renamed item's old slug 301 to the new one, an unknown slug the search page
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    let la: LinkAnswer = linkAnswer(req.path, qs);
    if (la && 'ask' in la) la = await askWorker(req, qs);
    if (la && 'to' in la) return res.redirect(301, la.to);
    if (la && 'search' in la) return res.redirect(302, la.search);
    // fix243: a past season's match page: admins only (410 + noindex for everyone else, every language)
    if (la && 'page' in la && la.page.past && req.access !== 'admin') {
      const lang = /^\/(es|pt|de|fr|it|tr)(\/|$)/.exec(req.path)?.[1] || 'en';
      return res.status(410).set({ 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' }).type('html').send(pastPage(lang, la.page.sport));
    }
    // old hub URLs (fix134): /predictions/PL → /predictions/premier-league, permanently
    const moved0 = hubRedirect(req.path) || leagueRedirect(req.path); // fix176: /league/BSA → /league/AF71
    const moved = moved0 ? pubPath(moved0) : null; // fix229: straight to the slug address (one hop)
    if (moved) return res.redirect(301, moved + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
    // fix185: American football is one sport — the old college list pages are the same pages filtered to college
    const college = /^\/american-football\/college(\/games|\/today)?\/?$/.exec(req.path);
    if (college) return res.redirect(301, `/american-football${college[1] === '/games' ? '/matches' : college[1] || ''}?league=college`);
    // fix195: an old tennis fixture id merged into its match → the match's page (any language prefix kept)
    const tnOld = /^(\/[a-z]{2})?\/tennis\/match\/(\d+)\/?$/.exec(req.path);
    if (tnOld) { const to = tennisMovedId(Number(tnOld[2])); if (to) return res.redirect(301, `${tnOld[1] || ''}/tennis/match/${to}`); }
    // fix238: an old (id) address without a slug: its stored crawler copy if there is one, never a wait for a build
    // (the 3–4.7 s stalls of 25 Oct) — the worker builds it in the background, the plain app page meanwhile
    // fix248c: a visitor never waits for a first build (live 27 Oct: every HTML route had a max of 6.0–6.7 s = the 3 s
    // slug lookup + this 3 s wait) — the plain app page at once, the worker builds the copy in the background; only a
    // verified search engine still waits up to SEO_WAIT_MS for the full HTML
    const pageWait = isOldAddress(req.path) || !isVerifiedCrawler(req) ? 0 : SEO_WAIT_MS;
    // fix199: a page read from a data-centre / proxy address counts towards its limits (sign-in / sign-up pages never)
    const nw = req.access !== 'admin' && !req.user?.emailVerified && req.ip ? networkOf(req.ip) : null;
    const authPage = /^(\/[a-z]{2})?\/(login|signup|join|forgot|verify|account|reset|privacy|terms|contact)(\/|$)/.test(req.path);
    if (nw && !authPage) {
      const ua = uaKey(req.get('user-agent')), ipH = ipKey(req);
      const verified = isVerifiedCrawler(req) || (claimsCrawler(ua) && crawlerVerdict(req.ip, ua) === true);
      // fix244: a page load counts once (the app's first view after it is free); over a limit: the Quick check
      const pass = verified ? null : passOf(req, ua);
      const refused = verified ? null : proxyLimiter.hit(ipH, nw.asn, { page: true, pass: pass?.ok ? pass.id : null });
      noteNetworkRequest(nw, ipH, req.ip || '', ua, { refused: refused?.scope, verified, passed: !!pass?.ok, passRefused: refused && pass ? pass.id : null });
      noteHtml(req, verified, !!refused);
      if (refused) return res.status(429).set({ 'Retry-After': String(refused.retryAfter), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html')
        .send(quickCheckPage(qcLangOf(req.path), refused.scope === 'pass-hour' ? null : turnstileSiteKey()));
    } else if (req.access !== 'admin' && !req.user) {
      // fix248c (step 5): any other address — a bot user-agent that is not a verified search engine gets the same limits
      const uaRaw = req.get('user-agent');
      const bot = isBotUa(uaRaw);
      const verified = bot && (isVerifiedCrawler(req) || (claimsCrawler(uaKey(uaRaw)) && crawlerVerdict(req.ip || '', uaKey(uaRaw)) === true));
      // (never this machine itself: tests and local tools; behind Railway's proxy req.ip is the visitor)
      const local = /^(127\.|::1$|::ffff:127\.)/.test(req.ip || '');
      const refused = bot && !verified && !authPage && !local && req.ip
        ? botHtmlLimiter.hit(ipKey(req), networkOf(req.ip)?.asn || -1 - parseInt(ipKey(req).slice(0, 7), 16), { page: true }) : null;
      noteHtml(req, verified, !!refused);
      if (refused) return res.status(429).set({ 'Retry-After': String(refused.retryAfter), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('text/plain').send('Too many pages from this address. Please try again later.');
    }
    res.set('Cache-Control', 'no-cache');
    try {
      const lang0 = (/^\/(es|pt|de|fr|it|tr)(\/|$)/.exec(req.path)?.[1] || 'en') as any;
      const bbg = !bbPublic() ? null : la && 'page' in la && la.page.sport === 'basketball' && la.page.kind === 'match' ? { id: Number(la.page.id), lang: lang0 } : bbGamePath(req.path);
      const home = seoHome(req.path);
      // fix210: stored pages only; a page never built waits at most 3 s for the worker, then the plain app page
      // (the app renders it in the browser; the next request gets the stored copy)
      // fix243: the HTML is read in the reader thread (views); a basketball game is its own stored page per language
      const views = ['html'];
      const s = bbg ? await getPage('bb-game-seo', { id: bbg.id, lang: bbg.lang, slug: la && 'page' in la ? la.page.slug : '' }, { waitMs: pageWait, views })
        : home ? await getPage('seo', { path: home }, { waitMs: pageWait, views }) : await getPage('seo-page', { path: seoPathOf(req.path).slice(0, 300) }, { waitMs: pageWait, views });
      const html = s?.view('html');
      // fix227: a copy stored before a deploy names the old build's app file (gone: a 404, no app, the crawler text
      // left on screen) — the plain app page until the worker has made the new copy
      const main = currentMainScript();
      const missKind = bbg ? 'bb-game-seo' : home ? 'seo' : 'seo-page';
      if (html?.text && main && !html.text.includes(main)) { noteSeoMiss(missKind, 'old build', req.path, lang0); return res.sendFile(path.join(STATIC_DIR, 'index.html')); }
      if (html?.text) {
        res.set('ETag', html.etag).vary('Accept-Encoding').type('html');
        if (req.fresh) return res.status(304).end();
        return html.gz && req.acceptsEncodings('gzip') === 'gzip' ? res.set('Content-Encoding', 'gzip').send(html.gz) : res.send(html.text);
      }
      // a copy without its HTML (stored before fix221, or nothing to show): the plain app page — fix243: never parsed or
      // rendered here
      noteSeoMiss(missKind, s ? 'no html' : 'not stored yet', req.path, lang0);
      res.sendFile(path.join(STATIC_DIR, 'index.html'));
    } catch (e: any) {
      logger.warn(`seo page ${req.path}: ${e.message}`);
      res.sendFile(path.join(STATIC_DIR, 'index.html'));
    }
  });
  logger.info(`Serving frontend from ${STATIC_DIR}`);
}

// ---------- Errors ----------

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`Error: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

export { app, SITE_AUTH, corsOrigin, allowedOrigins, isDev };

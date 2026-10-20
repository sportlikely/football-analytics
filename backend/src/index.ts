import express from 'express';
import { joinWaitlist, waitlistStats } from './services/waitlist';
import { slimForList, clearPredictionCache } from './services/predCache';
import { withLiveScore, liveBookStatus } from './services/liveScores';
import { runLinkCheck, lastLinkCheck, linkCheckTick } from './services/linkCheck';
import { markMissingPlayer } from './services/missingPlayers';
import { signupToken, checkSignupToken, honeypotHit, turnstileOk, turnstileSiteKey, checkSignupSurge } from './services/signupGuard';
import { sendMail as sendMailFix168 } from './services/email';
import { perfStatus, setJob, timed, yieldLoop, every, track, routeLabel, after, inBatches, requestDetail } from './services/perf';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
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
import { recordPredictions, settlePending, accuracy, recentSettled, trackingStatus, computeMetrics, publicRecord } from './services/tracking';
import { historyStatus, teamMapStatus, GROUPS, syncAll, syncH2HArchive, h2hArchiveStatus, syncHalfTimes } from './services/history';
import { withLive, liveHalfTimeTest } from './services/liveChance';
import { backtestUpsets, upsetWatchReport, upsetWatchBacktest } from './services/upsetAlerts';
import { submitContact, contactInbox, markContact, ContactError } from './services/contact';
import { ADMIN_2FA_REQUIRED, checkCode, revealSetup, twoFactorEnabled, twoFactorStatus, startSetup, confirmSetup, newRecovery, disableTwoFactor, issueTicket, redeemTicket, securePastSessions, TwoFactorError } from './services/twoFactor';
import { securityLog, securityLogList } from './services/securityLog';
import { recordActivity, activityList } from './services/activity';
import { createInvite, setInviteOpen, inviteInfo, joinAsTester, testerOf, testerOverview, TesterError } from './services/testers';
import { runBackup, backupStatus, localPath, startBackups, remoteList, remoteReady } from './services/backup';
import { reportClientError, clientErrorList, resolveClientError } from './services/clientErrors';
import { gamePicks, setPick, personalRecord, PickError } from './services/userPicks';
import { inboxList, inboxThread, reply, addNote, setStatus, assign, canOpen, searchCustomers, customerProfile, signOutEverywhere, segmentPreview, campaignList, sendTest, startCampaign, revenue, unsubscribe, CrmError, type Viewer } from './services/crm';
import { roleByKey, listRoles, listStaff, createRole, updateRole, deleteRole, RoleError, type Perm } from './services/roles';
import { consoleRow, sessionUnlocked, lockSession, setupOwn, setFor, renameFor, consoleLogin, changeOwn, resetOwn, removeFor, consoleUsers, ConsoleError } from './services/staffConsole';
import { modelV2Status, runBacktest, runBacktestAll, backtestProgress, backtestRows, backtestRunsList } from './services/historyModel';
import { oddsTick, oddsStatus, fetchCompetitionOdds, SPORT_KEYS } from './services/odds';
import { syncSquadValues, squadValuesStatus, startSquadValuesScheduler, squadCompetitions } from './services/squadValues';
import { syncClubValueHistory, clubValueHistoryStatus, findClub } from './services/squadHistory';
import { compareModels } from './services/compareModels';
import { gapReport } from './services/gapReport';
import { pastSeasons, pastPredictions, dataInventory, leaguePatterns } from './services/pastView';
import { marketTest, drawTest, anchoredDrawTest } from './services/marketTest';
import { clvTick, clvReport, startClvScheduler, clvProbe } from './services/clv';
import {
  isAfMatchId, isAfCode, afUpcoming, afLive, afWithPredictions, getAfMatchDetails, getAfStandings, getAfScorers, getAfRecent,
  afCompetitions, pollAfLive, syncFdLiveFromAf, startAfMatchesScheduler, afWindowStatus, refreshAfWindow, onAfWindow, isKnownAfFixture, afExtrasForFd, afLiveOverlay, withAfOdds, backfillAfOdds,
  warmMatchExtras, teamAverages, probableXI, lastMeetings, AF_OFFSET,
  afFixtureInfo, fixtureInjuriesRated, teamSchedule
} from './services/afMatches';
import { buildNationalElo, syncNationalHistory, nationalEloStatus, startNationalEloScheduler, nationalGoalsSensitivity, tuneNational, nationalTuneStatus } from './services/nationalElo';
import { buildClubElo, syncEuropeanCups, clubEloStatus, startClubEloScheduler, clubValueReport } from './services/clubElo';
import { nationalValueSearch, historyMatchReport } from './services/squadValues';
import { drawAlertsReport, drawFactorTest } from './services/drawAlerts';
import { teamPage, searchTeams, searchPlayers, searchPlayersRemote, resolveAfTeamId, setTeamOverride, teamOverrides } from './services/teamPage';
import { playerPage, findPlayer } from './services/playerPage';
import { unlockStatus, unlockMatch, unlockedIds, isFinished, testCheckout, PLANS, billingTestMode, unlockStats, REFUND_DAYS, FREE_WEEKLY_UNLOCKS, packsFor, buyPack, addCredits, creditBalance, creditEvents, PICK_PRICE, PACK_SIZES } from './services/billing';
import { goalsCalibration } from './services/goalsCalibration';
import { runDataAudit, lastDataAudit, startDataAuditScheduler } from './services/dataAudit';
import { newsFor, newsStatus, startNewsScheduler, bbTeamNames, footballTeamNames, nflTeamNamesById } from './services/news';
import { bbGet, bbStatus, bbSyncNow, startBasketballScheduler } from './services/basketball';
import { adminResult, resultChecksList, checkResults, openCheck, resultFix, ResultError } from './services/bbResults';
import { bdlGet, refreshNbaInjuries, nbaInjuryStatus } from './services/bbInjuries';
import { bbPublic, bbLeagues, bbGames, bbGame, bbStandings, bbTeam } from './services/bbSite';
import { bbPlayer, nbaLeaders, bbSearch, bbLeagueLeaders } from './services/bbPlayers';
import { bdlStatus, startBdlScheduler } from './services/bdl';
import { bbBacktest, bbRecord, bbExport, bbExportPlayers, bbWalkForward } from './services/bbModel';
import { bbLiveQuarterTest } from './services/bbLive';
import { highlightsFor, highlightsStatus, lastCandidates } from './services/highlights';
import { rebuildPlayerQuality, playerQualityTable } from './services/playerQuality';
import { db } from './db';
import { trackVisit, visitorStats, visitSeen } from './services/visitors';
import { startAsn } from './services/asn';
import { startTennisScheduler, tennisProbe, tennisStatus, tennisSample } from './services/tennis';
import { startTennisModelScheduler, tennisModelReport, tennisModelTick, tennisPredictions, tennisPlayerModel } from './services/tennisModel';
import { tennisPublic, tennisRid, tennisMatchesBetween, tennisLive, tennisRecent, withTennisPredictions, tennisMatch, tennisRecord, levelRank, tennisTournament, tennisPlayer, tennisRankings, tennisSearch, tennisAccuracy, tennisWriteup } from './services/tennisSite';
import { startGeo, geoCredit, countryOf } from './services/geo';
import { ensureIndexes } from './services/dbIndexes';
import { seoPage, renderIndex, sitemapXml, SITEMAPS, todayGroups, hubRedirect, leagueRedirect, MERGED_LEAGUES } from './services/seo';
import { listGuides, getGuide } from './services/guides';
import { hubBySlug, hubByOld, hubOpen, buildHub, warmHubs, HUBS } from './services/hubs';
import { refreshFromDetails } from './services/matchPreview';
import { fontRoute, warmFonts } from './services/fonts';
import { listFavorites, addFavorites, removeFavorite, MAX_FAVORITES } from './services/favorites';
import { tuneV3Full, tuneStatus, isTuning } from './services/v3Tuner';
import { cleanName, mayHaveSponsor, NAME_KEYS } from './services/sponsorNames';
import { hiddenModels, v3MixBacktest, featureModelStatus, setConfig as setModelConfig, setMixLive, startFeatureModelScheduler } from './services/featureModel';
import { runModelDaily, sendMorningReport, modelDailyLog, buildReport, startModelDailyScheduler, dailyRunning } from './services/modelDaily';
import { nflProbe, startNflScheduler, nflCurrentSeason, asLeague, asLeagues, LEAGUES, backfillPlayerGames } from './services/nfl';
import { winnerUpsetReport } from './services/winnerUpsets';
import { withNflPrediction, nflRatings, nflTeamModel, nflTeamRecord, nflRecord, nflAccuracy, nflModelReport, retrain as nflRetrain, NFL_MODEL, NCAA_MODEL } from './services/nflModel';
import { nflPublic, nflWeeks, nflWeekGames, nflGamesBetween, nflLiveGames, nflRecentResults, nflGame, nflStandings, nflTeam, nflPlayer, nflLeaders, nflSeasonsHeld, allowedSeason, leagueOfTeamId, nflSearch, nflPlayerCareer, nflPlayerInjury, nflTeamRow } from './services/nflSite';
import { nflLiveNow, nflLiveCurve } from './services/nflLive';
import { nflSchedule, nflGameStandings, nflStarters, nflBeforeAfter, nflPreview, nflEvents } from './services/nflGameExtras';
import { askAssistant, assistantConfigured, messagesToday, assistantStats } from './services/assistant';
import { normalizeName } from './services/history';
import { markFresh, markFailed } from './services/freshness';
import { dataHealth, startDataHealthScheduler } from './services/dataHealth';
import { startApiFootballScheduler, afStatus, afTick, rebuildAfFeaturesAsync, afGet, afRemaining, xgCoverage, afQuota } from './services/apiFootball';
import { afSource, uaKey, notePageRequest, noteBlocked, afUsageToday, isCrawlerRequest, noProviderCalls, claimsCrawler, crawlerVerdict, costCapped } from './services/afUsage';
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
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  // Socket.io bypasses Express middleware, so the gate is applied here too
  allowRequest: (req, cb) => cb(null, !SITE_AUTH || req.headers.authorization === SITE_AUTH)
});

// Each socket joins 'full' (premium/admin) or 'teaser' (anonymous/free) — predictions are trimmed for 'teaser'
io.use((socket, next) => {
  try {
    const cookies = parseCookies(socket.request.headers.cookie);
    const user = userForToken(cookies[SESSION_COOKIE]);
    socket.data.full = canSeeFull(accessOf(user));
  } catch {
    socket.data.full = false;
  }
  next();
});

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
// referrerPolicy: helmet's default "no-referrer" breaks embedded YouTube players (error 153 — YouTube needs the site's origin)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
// fix158: every API request in flight is a named job in /api/perf (a freeze inside a handler names its route).
// fix167: every request, not only /api (search-engine pages and sitemaps are built on this thread too)
app.use((req, res, next) => {
  const done = track(routeLabel(req.method, req.path), requestDetail(req.path, req.query as any));
  res.on('finish', done);
  res.on('close', done);
  next();
});
// Shadow models (featureModel.ts): feat-v1 always, and v3-mix until it is live (then grid-v3) never reach visitors —
// they are stored and compared in the admin views only
// fix182: displayed names (team / league / competition) never carry a betting sponsor ("Partizan Mozzart Bet" → "Partizan")
app.set('json replacer', (key: string, value: any) =>
  typeof value === 'string' ? (NAME_KEYS.has(key) && mayHaveSponsor(value) ? cleanName(value) : value)
  : key === 'predictions' && Array.isArray(value) && value.some(p => p && typeof p.model === 'string')
    ? (() => { const hide = hiddenModels(); return value.filter(p => !(p && hide.has(p.model))); })()
    : value);
app.use(express.urlencoded({ extended: true }));

// API responses are data, not pages: keep them out of search results (robots.txt stays open so tools can read them)
app.use('/api', (_req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.originalUrl.replace(/([?&]token=)[^&]+/g, '$1***')}`);
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
    if (req.path === '/api/health' || PUBLIC_FILES.has(req.path) || req.path.startsWith('/fonts/')) return next();
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

app.use('/api', trackVisit); // visitor counts for the admin page (hashed IPs only)
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
const uaHash = (ua: string) => createHash('sha256').update(RL_SALT + ua).digest('hex').slice(0, 20);
app.use('/api', (req, _res, next) => {
  const ua = uaKey(req.get('user-agent'));
  if (req.access === 'admin') return afSource.run({ kind: 'admin', ua }, next);
  const ipH = ipKey(req);
  const claims = claimsCrawler(ua);
  const verdict = claims ? crawlerVerdict(ipH, req.ip) : false;
  const crawler = verdict === true;
  (req as any).verifiedCrawler = crawler;
  (req as any).crawlerClaim = claims ? verdict === true : null; // fix183: the visitor counter's crawler check
  notePageRequest(ua, crawler);
  if (claims && verdict === false) logScraperOnce(`fake:${ipH}`, req, 'crawler user-agent from an address that is not the search engine (DNS check failed): stored data only');
  const paid = req.access === 'premium' || req.access === 'pro';
  const keys = { ip: ipH, ua: uaHash(ua), user: paid && req.user ? String(req.user.id) : null };
  const cap = costCapped(keys);
  if (cap) logScraperOnce(`cap:${cap.key}:${cap.key === 'ip' ? ipH : cap.key === 'ua' ? keys.ua : keys.user}`, req,
    `provider-cost cap: ${cap.calls} provider calls today by this ${cap.key === 'ip' ? 'address' : cap.key === 'ua' ? 'user-agent' : 'account'} (cap ${cap.cap}): stored data only until midnight UTC`);
  afSource.run({ kind: 'page', ua, crawler, keys, ...(cap || (claims && !crawler) ? { offline: true } : {}) }, next);
});
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
    if (req.access === 'admin') return next();
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
app.use(['/api/team-page', '/api/player-page', '/api/search', /^\/api\/matches\/\d+\/details/], (req, res, next) => ((req as any).verifiedCrawler ? next() : dayPages(req, res, next)));
app.use('/api/unlocks', (req, res, next) => (req.method === 'POST' ? rateLimit('unlock', 30, 60000, r => String(r.user?.id || ipKey(r)))(req, res, next) : next()));

const OPEN_API = /^\/api\/(health$|visit\/seen$|auth\/|waitlist$|contact$|feedback$|client-error$|picks(\/|$)|testers\/|unsubscribe$|favorites(\/|$)|assistant(\/|$)|matches(\/|$)|leagues(\/|$)|teams\/|team-page\/|player-page\/|search$|news$|today$|guides(\/|$)|hub(\/|$)|basketball\/|nfl\/|tennis\/|public\/(summary|results|record|geo-source)$|unlocks(\/|$)|billing\/)/;
const PREMIUM_GET_API = /^\/api\/(accuracy(\/recent|\/status)?|history\/status|clv|draw-alerts|upset-watch)$/; // past seasons and backtests are admin only (Oct 2026)

app.use('/api', (req, res, next) => {
  const p = req.originalUrl.split('?')[0];
  const access = req.access || 'anon';
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
    void checkSignupSurge(sendMailFix168);
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
// The same for basketball (bbLeagueConfig.ts / bbLeagueCoverage.ts): leagues start in testing, sync begins right away
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
// fix187: ?tour=atp|wta|challenger&status=upcoming|live|completed&limit=30 — to compare with the real ATP / WTA schedule
app.get('/api/admin/tennis/sample', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ data: tennisSample({ tour: String(req.query.tour || ''), status: String(req.query.status || ''), limit: Number(req.query.limit) || 30 }) }); }
  catch (e) { sendError(res, e, 'Tennis sample failed'); }
});
// fix190: tennis-v1 (admin only): the walk-forward report (per tour / surface, baselines, sets and totals, market
// benchmark), the live settings and the progress. ?rebuild=1 rebuilds the report (minutes, background), ?retune=1 the
// live settings only.
app.get('/api/admin/tennis-model', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.rebuild === '1' || req.query.retune === '1') void tennisModelTick(req.query.rebuild === '1' ? 'report' : 'retune');
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
  const experiments = league === 1 ? require('./services/nflExperiments').nflExperimentReport() : null;
  res.json({ data: { model, league, rebuilding: nflRebuilding, report: nflModelReport(league), experiments } });
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
app.get('/api/admin/visitors', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: visitorStats() }); });
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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Upcoming + live matches. ?days=30 (1-30). Served from memory.
app.get('/api/matches/upcoming', async (req, res) => {
  try {
    const days = parseInt(String(req.query.days || '30'), 10) || 30;
    const fd = footballDataAPI.withPredictions((await footballDataAPI.getUpcomingMatches(days)).map(withLiveScore));
    // + extra competitions from API-Football (national teams, cups, more leagues)
    const matches = [...fd, ...afWithPredictions(afUpcoming(days))].sort((a: any, b: any) => a.utcDate.localeCompare(b.utcDate));
    res.json({
      data: matches.map(slimForList),
      count: matches.length,
      days,
      cacheAgeMs: footballDataAPI.windowAge,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch upcoming matches');
  }
});

app.get('/api/matches/live', async (_req, res) => {
  try {
    const matches = [...footballDataAPI.withPredictions((await footballDataAPI.getLiveMatches()).map(withLiveScore)), ...afWithPredictions(afLive())].map(slimForList);
    res.json({ data: matches, count: matches.length, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to fetch live matches');
  }
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
  const m = isAfMatchId(id) ? afLiveOverlay(m0) : withLiveScore(m0);
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
  const settled = isSettled(data);
  if (settled && !data?.partial) {
    try { db.prepare(`INSERT OR REPLACE INTO match_details_store (match_id, json, built_at) VALUES (?, ?, ?)`).run(id, JSON.stringify(data), new Date().toISOString()); } catch (e: any) { logger.warn(`details store ${id}: ${e.message}`); }
  }
  detailsCache.set(id, { at: Date.now(), ttl: settled ? Infinity : detailsTtl(data), data, refreshing: false, startedAt: 0 });
  if (detailsCache.size > 2000) { const oldest = [...detailsCache.entries()].sort((x, y) => x[1].at - y[1].at)[0]; if (oldest) detailsCache.delete(oldest[0]); }
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
      return res.json({ data: kept, timestamp: new Date().toISOString(), cached: true });
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
 * fix165 — admin: every live match, the live list's score / minute against what /details sends (and the raw cached
 * copy), with the cache age. Flags a score difference or a minute more than 1 apart.
 */
app.get('/api/admin/live-consistency', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
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

// Admin: data health — every feed's age and the validity checks (see services/dataHealth.ts). Runs the checks now.
app.get('/api/data-health', async (_req, res) => {
  try {
    res.json({ data: await dataHealth(), timestamp: new Date().toISOString() });
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
    const upcoming = [...(await footballDataAPI.getUpcomingMatches(14)), ...afUpcoming(14)];
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
const recordCache = new Map<string, { at: number; data: any }>();
app.get('/api/public/record', (req, res) => {
  try {
    const days = Math.min(400, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    const ck = `${days}|${competition || ''}`;
    let c = recordCache.get(ck);
    if (!c || Date.now() - c.at > 5 * 60000) {
      c = { at: Date.now(), data: publicRecord(days, competition) };
      recordCache.set(ck, c);
      if (recordCache.size > 200) recordCache.delete(recordCache.keys().next().value as string);
    }
    // the per-competition table is admin-only for now (Yarin, 10 Oct 2026): small samples look bad in public
    const data = req.access === 'admin' ? c.data : { ...c.data, byCompetition: [] };
    res.set('Cache-Control', 'no-store');
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Record failed');
  }
});

const resultsCache = new Map<string, { at: number; data: any }>();
app.get('/api/public/results', (req, res) => {
  try {
    const days = Math.min(400, parseInt(String(req.query.days || '30'), 10) || 30);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const competition = req.query.competition ? String(req.query.competition).toUpperCase() : undefined;
    const full = isPaid(req.access || 'anon'); // finished games: every paid plan sees the percentages
    // computed at most every 5 minutes per question (it scans the whole record)
    const ck = `${days}|${competition || ''}|${limit}`;
    let c = resultsCache.get(ck);
    if (!c || Date.now() - c.at > 5 * 60000) {
      const rows = recentSettled(days, competition, limit, 'main').map((r: any) => {
        const { odds, confidence, model, ...rest } = r;
        return rest;
      });
      const main: any = accuracy(days, competition, 'main');
      // fix120: hitRate = double chance (our recommended pick); hardHitRate = the 1X2 result
      const dcRec: any = publicRecord(days, competition, 0).doubleChance;
      c = { at: Date.now(), data: { rows, record: { days, n: dcRec.n || main.settled, hitRate: dcRec.v3 ?? null, hardHitRate: main.model?.hitRate ?? null } } };
      resultsCache.set(ck, c);
      if (resultsCache.size > 500) resultsCache.delete(resultsCache.keys().next().value as string);
    }
    const data = full ? c.data : { ...c.data, rows: c.data.rows.map((r: any) => ({ ...r, p: null, dc: r.dc ? { ...r.dc, p: null } : null })) };
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to list results');
  }
});

// Home page proof block: our record over 30 days (all games) and the strong-pick record (cached 10 min)
let summaryCache: { at: number; data: any } | null = null;
// Privacy page: which country data is in use (DB-IP, CC BY 4.0 — or iptoasn.com when that one is loaded)
app.get('/api/public/geo-source', (_req, res) => res.json({ data: geoCredit() }));

app.get('/api/public/summary', (_req, res) => {
  try {
    if (!summaryCache || Date.now() - summaryCache.at > 10 * 60 * 1000) {
      const main: any = accuracy(30, undefined, 'main');
      // fix120: "picks right" = our double-chance pick; the 1X2 result stays as the hard call
      const rec: any = publicRecord(30);
      let draws: any = null;
      try {
        const d: any = drawAlertsReport();
        draws = { picks: (d.picks || []).length };
      } catch { /* backtests not loaded */ }
      summaryCache = {
        at: Date.now(),
        data: {
          days: 30,
          // fix120: hitRate = our double-chance pick (the recommended pick); hardHitRate = the 1X2 result
          v3: { games: rec.doubleChance.n || main.settled, hitRate: rec.doubleChance.v3 ?? null, hardHitRate: main.model?.hitRate ?? null, strong: rec.doubleChance.strong?.n ? rec.doubleChance.strong : null, strong60: (main.strongPicks || []).find((t: any) => t.min === 60) || null },
          // double chance leads on the home page (fix118/119): overall, by how sure we were, and our best numbers
          doubleChance: rec.doubleChance, highlights: rec.highlights,
          drawAlerts: draws
        }
      };
    }
    res.json({ data: summaryCache.data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Summary failed');
  }
});

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
const nflWith = <T extends { id: number; state: string }>(req: express.Request, games: T[]) => {
  const f = fullFor(req, nflRid);
  return games.map(g => {
    const x = withNflPrediction(g as any, typeof f === 'function' ? f(g.id) : f) as unknown as T & { prediction: any };
    // fix174: live win chance + projected score on live rows (numbers unlocked), like basketball
    if (g.state === 'live' && x.prediction && !x.prediction.locked) { const live = nflLiveNow(g.id); if (live) x.prediction = { ...x.prediction, live }; }
    return x;
  });
};
app.get('/api/nfl/config', (req, res) => {
  const league = nflLg(req);
  res.json({ data: { public: nflPublic(), open: nflPublic() || nflAdmin(req), league, season: nflCurrentSeason(league), seasons: nflSeasonsHeld(nflAdmin(req), league),
    leagues: LEAGUES.map(l => ({ id: l, season: nflCurrentSeason(l) })) } });
});
app.get('/api/nfl/home', (req, res) => {
  try {
    // fix185: both leagues together by default (?league=nfl|college for one); every game keeps its league field
    const asked = nflLgs(req), lgs = asked.filter(l => nflCurrentSeason(l));
    const league = asked.length === 1 ? asked[0] : lgs.length === 1 ? lgs[0] : 'all';
    const season = lgs.length ? nflCurrentSeason(lgs[0]) : null;
    if (!season) return res.json({ data: { season: null, league, live: [], week: null, games: [], upcoming: [], results: [], standings: null, leaders: [] } });
    // fix138: the next two weeks too (favorites rail), and the last 8 finals (Latest results)
    const now = Date.now();
    const per = lgs.map(l => {
      const s = nflCurrentSeason(l)!, { weeks, current } = nflWeeks(s, l);
      return { l, s, week: weeks.find(w => w.key === current) || null, games: current ? nflWeekGames(s, current, l) : [], standings: nflStandings(s, l) };
    });
    const stand = per.map(p => p.standings).filter(Boolean) as any[];
    const upcoming = nflWith(req, lgs.flatMap(l => nflGamesBetween(new Date(now - 6 * 3600 * 1000).toISOString(), new Date(now + 14 * 86400000).toISOString(), l)).filter(g => g.state === 'upcoming').sort(byKick));
    // fix188: model rating + rank (and FBS / FCS for college) of every team in the coming games: the featured games
    const rate = new Map(lgs.map(l => [l, nflRatings(l)]));
    const ratings: Record<number, { elo: number; rank: number; level: string | null }> = {};
    for (const g of upcoming) for (const s of [g.home, g.away]) {
      const r = rate.get(g.league)?.get(s.id);
      if (r && !ratings[s.id]) ratings[s.id] = { ...r, level: g.league === 2 ? nflTeamRow(s.id)?.level || null : null };
    }
    res.json({ data: {
      season, league, week: per.length === 1 ? per[0].week : null,
      live: nflWith(req, lgs.flatMap(l => nflLiveGames(l)).sort(byKick)),
      games: nflWith(req, per.flatMap(p => p.games).sort(byKick)),
      upcoming, ratings,
      results: nflWith(req, lgs.flatMap(l => nflRecentResults(8, l)).sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, 8)),
      // the table(s): one league's as before; both → the rows of both (teams covered, the featured game's strength)
      standings: stand.length === 1 ? stand[0] : stand.length ? { season, league: 'all', conferences: stand.flatMap(s => s.conferences), rows: stand.flatMap(s => s.rows) } : null,
      leaders: nflLeaders(season, 3, lgs[0])
    } });
  } catch (e) { sendError(res, e, 'Failed to load the NFL home'); }
});
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
      beforeAfter: open ? nflBeforeAfter(g, p) : null,
      writeup: nflPreview(g.id, qbNames),
      events: g.state === 'done' ? nflEvents(g.id) : null
    } });
  } catch (e) { sendError(res, e, 'Failed to load game'); }
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
  res.json({ data: { nfl: nflModelReport(1), college: nflModelReport(2), experiments: require('./services/nflExperiments').nflExperimentReport() } });
});
// fix141: home "Our record" — last 30 days, picks saved before kick-off only
app.get('/api/nfl/record', (req, res) => {
  try { res.json({ data: nflRecord(Math.min(365, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30)), nflLgs(req)) }); }
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
const tnWith = (req: express.Request, list: any[]) => {
  const f = fullFor(req, tennisRid);
  // fullFor's function form takes the match id (it maps it to the reveal id itself)
  return withTennisPredictions(list, typeof f === 'function' ? (rid: number) => f(-rid - 4e9) : f);
};
app.get('/api/tennis/config', (req, res) => {
  res.json({ data: { public: tennisPublic(), open: tennisPublic() || tnAdmin(req), tours: ['atp', 'wta', 'challenger', ...(tnAdmin(req) ? ['itf'] : [])] } });
});
app.get('/api/tennis/home', (req, res) => {
  try {
    const tour = tnTour(req), admin = tnAdmin(req), now = Date.now();
    const upcoming = tnWith(req, tennisMatchesBetween(new Date(now - 3 * 3600e3).toISOString(), new Date(now + 4 * 86400e3).toISOString(), tour, admin, 2500).filter(m => m.state === 'upcoming'));
    // the featured matches: biggest coming events (Grand Slam / 1000 / 500 first), then the two players' ratings
    const ratings: Record<number, { elo: number; rank: number }> = {};
    const soon = upcoming.filter(m => Date.parse(m.start) - now < 48 * 3600e3).sort((a, b) => levelRank(a.tournament.tier, a.tour, a.tournament.name) - levelRank(b.tournament.tier, b.tour, b.tournament.name)).slice(0, 80);
    for (const m of soon) for (const s of [m.home, m.away]) if (s.id && !ratings[s.id]) { const r = tennisPlayerModel(s.id, m.women); if (r) ratings[s.id] = { elo: r.elo, rank: r.rank }; }
    res.json({ data: {
      tour, live: tnWith(req, tennisLive(tour, admin)), upcoming, ratings,
      results: tnWith(req, tennisRecent(8, tour, admin)),
      levels: Object.fromEntries(upcoming.map(m => [m.id, levelRank(m.tournament.tier, m.tour, m.tournament.name)]))
    } });
  } catch (e) { sendError(res, e, 'Failed to load the tennis home'); }
});
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
    if (!d) return res.status(404).json({ error: 'Match not found' });
    // fix193c: the written preview (English; the same text search engines get, no pick, no %)
    res.json({ data: { ...d, writeup: tennisWriteup(d) } });
  } catch (e) { sendError(res, e, 'Failed to load the match'); }
});
// home "Our record": the last 30 days, predictions saved before the start, from the public start day
app.get('/api/tennis/record', (req, res) => {
  try { res.json({ data: tennisRecord(Math.min(3650, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30)), tnTour(req)) }); }
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
    const sur = (n: string) => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(' ') : n; };
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
app.get('/api/basketball/games', (req, res) => {
  try {
    const now = Math.floor(Date.now() / 30000) * 30000; // fix159: 30-s steps, so the list cache (bbSite) is reused
    const day = 86400000;
    const code = typeof req.query.league === 'string' && /^[A-Za-z0-9]{2,8}$/.test(req.query.league) ? req.query.league.toUpperCase() : undefined;
    const results = req.query.results === '1';
    const days = Math.min(30, Math.max(1, parseInt(String(req.query.days || '3'), 10) || 3));
    let from = results ? new Date(now - days * day) : new Date(now - 4 * 3600 * 1000);
    let to = results ? new Date(now) : new Date(now + days * day);
    // a calendar day picked on the site (the visitor's own midnight to midnight)
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      const f = new Date(req.query.from), t = new Date(req.query.to);
      if (!isNaN(f.getTime()) && !isNaN(t.getTime()) && t > f && t.getTime() - f.getTime() <= 14 * day) { from = f; to = t; }
    }
    res.json({ data: bbGames({ from: from.toISOString(), to: to.toISOString(), code, results, limit: 400 }, fullFor(req, id => -id)), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load games');
  }
});
// fix169: the game page is kept 20 s while the game is live and 2 min otherwise (it was rebuilt on every open, up to
// 1.25 s); one copy per access level (full numbers or not)
const bbGameCache = new Map<string, { at: number; until: number; data: any }>();
app.get('/api/basketball/game/:id(\\d+)', async (req, res) => {
  try {
    const gid = parseInt(req.params.id, 10);
    const full = fullOne(req, -gid);
    const key = `${gid}|${full ? 1 : 0}`;
    const hit = bbGameCache.get(key);
    if (hit && Date.now() < hit.until) return res.json({ data: hit.data, timestamp: new Date(hit.at).toISOString(), cached: true });
    const data = await bbGame(gid, full);
    if (!data) return res.status(404).json({ error: 'Game not found' });
    bbGameCache.set(key, { at: Date.now(), until: Date.now() + ((data as any).game?.state === 'live' ? 20 : 120) * 1000, data });
    if (bbGameCache.size > 1000) bbGameCache.delete(bbGameCache.keys().next().value!);
    res.json({ data, timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Failed to load game');
  }
});
// Basketball results: checks and admin corrections (services/bbResults.ts)
app.get('/api/admin/bb/result-checks', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ data: resultChecksList() }); });
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
    securityLog(req, 'bb_result_corrected', req.user, `game ${id}: ${req.body?.action}${req.body?.hs != null ? ` ${req.body.hs}-${req.body.as_}` : ''}`);
    res.json({ data: r });
  } catch (e: any) {
    if (e instanceof ResultError) return res.status(e.status).json({ error: e.message });
    sendError(res, e, 'Correction failed');
  }
});
app.get('/api/basketball/standings/:code([A-Za-z0-9]{2,8})', async (req, res) => {
  try {
    res.json({ data: await bbStandings(req.params.code.toUpperCase()), timestamp: new Date().toISOString() });
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
app.get('/api/basketball/record', (req, res) => {
  try {
    const code = typeof req.query.league === 'string' && /^[A-Za-z0-9]{2,8}$/.test(req.query.league) ? req.query.league.toUpperCase() : undefined;
    res.json({ data: bbRecord(Math.min(3650, parseInt(String(req.query.days || '3650'), 10) || 3650), code), timestamp: new Date().toISOString() });
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
    const bt = req.query.backtest === '1' ? await v3MixBacktest({ from: req.query.from ? String(req.query.from) : undefined, season: req.query.season ? String(req.query.season) : undefined }) : undefined;
    res.json({ data: { status: featureModelStatus(), ...(bt ? { backtest: bt } : {}) }, timestamp: new Date().toISOString() });
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
  try { res.json({ data: req.query.run === '1' || !lastLinkCheck() ? await runLinkCheck() : lastLinkCheck(), timestamp: new Date().toISOString() }); } catch (e) { sendError(res, e, 'Link check failed'); }
});
every('link check', linkCheckTick, 3600 * 1000).unref();
// fix169: the weekly prediction hubs are rebuilt in the background (visitors and crawlers get the cached copy)
every('hub warm', () => warmHubs(), 15 * 60 * 1000).unref();
// fix175: indexes for the crawler pages, built off the main thread
after('db indexes', () => ensureIndexes(), 20 * 1000).unref();
after('hub warm', () => warmHubs(), 60 * 1000).unref();
// fix174: the player → games index for NFL player careers (once, in slices)
after('nfl player games', () => backfillPlayerGames().catch(e => logger.warn(`nfl player games: ${e.message}`)), 5 * 60 * 1000).unref();
after('link check', () => linkCheckTick(), 10 * 60 * 1000).unref();

// Admin: event-loop stalls and how long the heavy jobs take (why the site feels slow)
app.get('/api/perf', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: perfStatus(), timestamp: new Date().toISOString() });
});

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

// Upset watch (Pro): games where our model gives the underdog 30%+ (no bookmakers), and how those calls went
app.get('/api/upset-watch', (_req, res) => {
  try {
    res.json({ data: upsetWatchReport(), timestamp: new Date().toISOString() });
  } catch (error: any) {
    sendError(res, error, 'Upset watch failed');
  }
});

// Draw alerts page (premium): upcoming alerts, live record, backtest seasons
app.get('/api/draw-alerts', (req, res) => {
  try {
    const r: any = drawAlertsReport();
    // visitors: our own draw picks and draw facts only (the value-alert machinery stays for admins)
    const data = req.access === 'admin' ? r : { picks: r.picks, likely: r.likely, leagues: r.leagues, teams: r.teams };
    res.json({ data, timestamp: new Date().toISOString() });
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

// ---------- WebSocket ----------

io.on('connection', socket => {
  logger.info(`Client connected: ${socket.id}`);

  const tier = socket.data.full ? 'full' : 'teaser';
  socket.join(tier);

  socket.on('subscribe_match', (matchId: number) => {
    const id = Number(matchId);
    if (!Number.isInteger(id) || id <= 0) return;
    // one match page at a time is plenty: drop older match rooms
    for (const room of socket.rooms) if (room.startsWith('match:') && room !== `match:${id}:${tier}`) socket.leave(room);
    socket.join(`match:${id}:${tier}`);
  });

  socket.on('unsubscribe_match', (matchId: number) => {
    socket.leave(`match:${matchId}:${tier}`);
  });

  socket.on('disconnect', reason => {
    logger.info(`Client disconnected: ${socket.id} (${reason})`);
  });
});

app.set('io', io);

// Push live scores to all clients every 60s (only when someone is connected)
// Every 20 s (Oct 2026, fix115): Football-Data.org's live list is fetched fresh every 3rd tick (rate limit), the last
// list is reused in between; API-Football's live=all is polled every tick while any match is live, and each
// Football-Data.org match shows the fresher of the two readings (liveScores.ts) — the same score as the match page.
const LIVE_POLL_MS = parseInt(process.env.LIVE_POLL_MS || '20000', 10);
let livePolling = false;
let lastLiveList: any[] = [];
let lastLiveAt = 0;
let liveTick = 0;
every('live poll', async () => {
  if (livePolling) return; // a slow poll (API waits) must not overlap the next one
  livePolling = true;
  try {
    // fix155: each part under its own label, so /api/perf names any freeze (football live / AF live / live push)
    const fresh = liveTick++ % 3 === 0;
    const fdRaw: any[] = await timed('football live', () => (fresh ? footballDataAPI.getLiveMatches(true) : footballDataAPI.liveSnapshot()));
    const afLiveNow = await timed('AF live', () => pollAfLive(fdRaw.length > 0));
    await timed('AF live', () => syncFdLiveFromAf(fdRaw));
    const live: any[] = await timed('football live', () => {
      const fdLive = footballDataAPI.withPredictions(fdRaw.map(withLiveScore));
      recordPredictions(fdLive); // locks anything that has kicked off (Football-Data.org matches only)
      return [...fdLive, ...afWithPredictions(afLiveNow)].map(slimForList);
    });
    await timed('live push', () => {
      const ts = new Date().toISOString();
      io.to('full').emit('matches:live', { data: live, timestamp: ts });
      io.to('teaser').emit('matches:live', teaseDeep({ data: live, timestamp: ts }));
      // Per-match rooms get their own update (score / status / minute)
      for (const m of live) {
        io.to(`match:${m.id}:full`).emit('match:live', m);
        io.to(`match:${m.id}:teaser`).emit('match:live', teaseDeep({ m }).m);
      }
    });
    lastLiveList = live; lastLiveAt = Date.now(); // fix165: /api/admin/live-consistency
    markFresh('live', `${live.length} live`);
  } catch (error: any) {
    logger.warn('Live poll failed', { message: error.message });
    markFailed('live', error);
  } finally {
    livePolling = false;
  }
}, LIVE_POLL_MS);

// ---------- Static site (production: this one process serves the API and the built frontend) ----------

const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
  // Hashed assets can be cached for a long time; index.html must always be fresh
  // Search engines: a live sitemap (served before the static file of the same name) and per-page head tags + content
  app.get('/fonts/:file', fontRoute);
  warmFonts();
  app.get('/sitemap.xml', (_req, res) => {
    try { res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemapXml()); }
    catch (e: any) { logger.warn(`sitemap: ${e.message}`); res.sendFile(path.join(STATIC_DIR, 'sitemap.xml')); }
  });
  for (const [file, build] of Object.entries(SITEMAPS)) app.get(`/${file}`, (_req, res) => {
    try { res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(build()); }
    catch (e: any) { logger.warn(`${file}: ${e.message}`); res.status(503).send('Try again later'); }
  });
  // files under /assets have a content hash in their name (a new version gets a new name): cache them for a year,
  // so returning visitors never download or re-check them. Other files (logo, icons) keep 7 days.
  app.use('/assets', express.static(path.join(STATIC_DIR, 'assets'), { index: false, maxAge: '365d', immutable: true }));
  // fix167: a file that isn't there (an old version's page file, asked by a tab opened before a deploy) is a plain 404:
  // never the HTML page (the browser would run it as a script), never an error log line; not cached, so a CDN or
  // browser asks again. The page reloads itself for the new version (frontend lib/chunkReload.ts).
  app.use('/assets', (_req, res) => { res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found'); });
  app.use(express.static(STATIC_DIR, { index: false, maxAge: '7d' }));
  const indexHtml = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (req, res) => {
    // old hub URLs (fix134): /predictions/PL → /predictions/premier-league, permanently
    const moved = hubRedirect(req.path) || leagueRedirect(req.path); // fix176: /league/BSA → /league/AF71
    if (moved) return res.redirect(301, moved + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
    // fix185: American football is one sport — the old college list pages are the same pages filtered to college
    const college = /^\/american-football\/college(\/games|\/today)?\/?$/.exec(req.path);
    if (college) return res.redirect(301, `/american-football${college[1] || ''}?league=college`);
    res.set('Cache-Control', 'no-cache');
    try {
      res.type('html').send(renderIndex(indexHtml, seoPage(req.path)));
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  setJob('boot (scheduler start)'); setImmediate(() => setJob(null)); // fix165: the sync start-up work is named in /api/perf
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`WebSocket server ready (CORS: ${isDev ? 'any origin [dev]' : allowedOrigins.join(', ')})`);
  // Save/refresh predictions every time the fixture window is refreshed
  // fix169: recorded in batches of 25 with yields (fix159 style)
  footballDataAPI.onWindowRefreshed = matches => { void timed('record predictions (main leagues)', () => inBatches(matches, 25, b => { recordPredictions(b); return []; })).catch(e => logger.warn(`record predictions: ${e.message}`)); };
  // Same for API-Football competitions (national teams, UEFA cups, extra leagues)
  onAfWindow(matches => { void (async () => {
    // ~700 matches: predict 40 at a time with a pause between, so visitors are not kept waiting
    // fix169: 25 at a time, a yield whenever ~30 ms have passed (the window blocked 0.3 s and the recording 1.4 s)
    const withP: any[] = await timed('predict more-leagues window', () => inBatches(matches, 25, b => afWithPredictions(b)));
    await timed('record predictions (more leagues)', () => inBatches(withP, 25, b => { recordPredictions(b); return []; }));
    // then the bookmaker odds for matches starting soon, so every tracked game can be compared with the market
    // fix169: awaited and batched under a label (the continuation used to run after the label had ended)
    const ms = await withAfOdds(matches).catch(err => { logger.warn('AF odds for tracking failed', { message: err.message }); return [] as any[]; });
    if (ms.length) await timed('record predictions (odds)', () => inBatches(ms, 25, b => { recordPredictions(afWithPredictions(b)); return []; }));
  })().catch(err => logger.warn('AF window predictions failed', { message: err.message })); });
  // fix167: the schedulers start one after another over the first 2 minutes (each under its own name in /api/perf),
  // not all at once inside the listen callback ("boot (scheduler start)" blocked 11 s on every deploy). The site is
  // served from the stored data meanwhile; the fixture window comes first.
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
    // fix184: tennis data (Live Tennis API Pro, admin only)
    ['tennis', () => startTennisScheduler()],
    // fix190: tennis-v1 (admin only): report once the backfill reached 2023-01, weekly re-tune, predictions every 30 min
    ['tennis model', () => startTennisModelScheduler()],
    // Daily database backup (services/backup.ts)
    ['backups', () => startBackups()]
  ];
  STARTS.forEach(([label, start], i) => after(`start ${label}`, start, Math.round((i * 120_000) / STARTS.length)));
  // Settle finished matches every 10 minutes (first run after 1 minute)
  const settle = () =>
    settlePending(
      (from, to) => footballDataAPI.getMatchesInRange(from, to),
      async ids => (afRemaining() > 50 ? ((await afGet('/fixtures', { ids: ids.join('-') })).response || []) : [])
    )
      .then(r => { markFresh('results', r ? `${r.settled} settled, ${r.pending} pending` : undefined); return backfillAfOdds(); })
      .catch(err => { markFailed('results', err); logger.warn('Settle job failed', { message: err.message }); });
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
});

export { app, io };

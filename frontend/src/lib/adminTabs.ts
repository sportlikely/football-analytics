/**
 * fix237: the admin page's tabs, every card's place and plain-English explanation, and where each data-health check
 * belongs. One list, read by pages/Admin.tsx and checked by scripts/admin-check.ts (every card in exactly one tab, every
 * check of the backend mapped to a tab with a "What this is" text, no code words). Admin pages are English only.
 */

export type Level = 'ok' | 'warn' | 'fail'
export type AdminTab = 'needs-you' | 'users' | 'models' | 'data' | 'site' | 'messages' | 'security'

/** in page order; /admin opens the first one */
export const ADMIN_TABS: { key: AdminTab; label: string }[] = [
  { key: 'needs-you', label: 'Needs you' },
  { key: 'users', label: 'Visitors & users' },
  { key: 'models', label: 'Predictions & models' },
  { key: 'data', label: 'Data & feeds' },
  { key: 'site', label: 'Site health' },
  { key: 'messages', label: 'Emails & alerts' },
  { key: 'security', label: 'Security' }
]
export const adminTabOf = (x: string | undefined): AdminTab | null => (ADMIN_TABS.some(t => t.key === x) ? (x as AdminTab) : null)
export const adminPath = (t: AdminTab) => `/admin/${t}`

/** what /api/admin/summary answers (backend services/adminSummary.ts) */
export interface AdminSummary {
  injuriesToReview: number; bbResultsToCheck: number; contactOpen: number
  visitorsToday: number; signupsToday: number; accounts: number; paying: number
  siteErrorsOpen: number; siteErrors24h: number; failedSignIns24h: number
  backupOk: boolean | null; lastBackupAt: string | null; at: string
}
export interface HealthCheck { id: string; label: string; level: Level; detail: string; items?: string[] }

export interface AdminCardDef {
  id: string
  tab: AdminTab
  title: string
  /** one sentence: what this is */
  what: string
  /** one sentence when it is not green: what to do ("Nothing — it fixes itself", "Tell Claude", or an action) */
  todo: string
  /** data-health checks (id or id prefix ending in "-" / ":") whose worst level is this card's dot */
  checks?: string[]
  /** the dot from the summary, when the card has its own signal */
  status?: (s: AdminSummary) => Level
}

export const ADMIN_CARDS: AdminCardDef[] = [
  // ---------- Needs you ----------
  { id: 'needs-you', tab: 'needs-you', title: 'Waiting for you', what: 'Everything on the site that only a person can decide, with a button for each.', todo: 'Go through the list from the top; each item leaves once it is done.' },

  // ---------- Visitors & users ----------
  { id: 'visitors', tab: 'users', title: 'Visitors', what: 'How many people opened the site today, this week and this month, and from which countries (never their address).', todo: 'Nothing — it is information only.' },
  { id: 'accounts', tab: 'users', title: 'Accounts', what: 'How many people signed up, confirmed their email, pay, and want our updates.', todo: 'Nothing — it is information only.' },
  { id: 'users', tab: 'users', title: 'Users', what: 'Every account, with its plan, last sign-in and buttons to change the plan or reset a password.', todo: 'Nothing — use it when someone asks for help.' },
  { id: 'leave', tab: 'users', title: 'Why people leave', what: 'The reasons people gave when they cancelled a plan or deleted their account (last 12 months).', todo: 'Read the comments; tell Claude if one reason keeps coming back.' },
  { id: 'contact', tab: 'users', title: 'Contact messages', what: 'Messages sent from the contact form (they also arrive by email).', todo: 'Answer the open ones by email, then press "Mark answered".', status: s => (s.contactOpen ? 'warn' : 'ok') },

  // ---------- Predictions & models ----------
  { id: 'model-daily', tab: 'models', title: 'Football model: daily learning', what: 'Every night at 04:00 UTC the football model tries a small improvement and keeps it only if it predicts better; the 07:00 report says what happened.', todo: 'Nothing — a bad night is rolled back by itself. Tell Claude if it rolls back several days in a row.', checks: ['feed:model', 'v1-fallback', 'probabilities'] },
  { id: 'bb-engine', tab: 'models', title: 'Basketball model', what: 'Which basketball model each group of leagues uses (NBA, Europe, the rest), how its 1,000 points are shared between the factors, and the tests that decide it.', todo: 'Nothing — the monthly re-tune keeps it only when it is better. Tell Claude if a group switched to the older model.', checks: ['bb-engine', 'bb-grid-rows', 'bb-missing-row', 'bb-key-players', 'bb-star-rest', 'league-settings-basketball'] },
  { id: 'nba-check', tab: 'models', title: 'NBA model check', what: 'How the NBA model does with injuries and line-ups priced in before tip-off, against the plain model.', todo: 'Nothing — it is a test report. Tell Claude if the new model is worse for weeks.' },
  { id: 'season-forecast', tab: 'models', title: 'Season forecast', what: 'The chance of each team finishing in each place, re-run after every finished game.', todo: 'Press "Run now" once; if it stays red, tell Claude.', checks: ['season-forecast-'] },
  { id: 'calibration', tab: 'models', title: 'Do our percentages come true?', what: 'For football and basketball: when we said 70%, did it happen about 70% of the time over the last 30 days.', todo: 'Nothing for a few days — a short run of results can be off. Tell Claude if it stays red for a week.', checks: ['calibration-football', 'calibration-basketball', 'league-settings-football'] },
  { id: 'backtest', tab: 'models', title: 'Leagues vs past seasons', what: 'Each basketball league’s hit rate in the last 30 days against what the same model got on past seasons.', todo: 'Nothing for a few days — a league can have a bad month. Tell Claude if the gap stays over 8 points.', checks: ['bb-vs-backtest'] },
  { id: 'other-models', tab: 'models', title: 'American football and tennis models', what: 'Whether the American football and tennis percentages come true, and whether their per-league settings were refreshed.', todo: 'Tell Claude if one stays red for a week.', checks: ['calibration-nfl', 'calibration-tennis', 'league-settings-nfl', 'league-settings-tennis'] },

  // ---------- Data & feeds ----------
  { id: 'af-usage', tab: 'data', title: 'API-Football today', what: 'How much of today’s API-Football allowance (our main football data source) is used, and by what.', todo: 'If it is close to the limit, tell Claude — pages then show their stored copy.', checks: ['feed:extra-fixtures', 'feed:injuries-lineups'] },
  { id: 'nfl-data', tab: 'data', title: 'American football data', what: 'What the American football data source gives us: seasons, games with scores, injuries and tables.', todo: 'Tell Claude if a season or the scores are missing.' },
  { id: 'leagues-football', tab: 'data', title: 'Football leagues', what: 'The extra football leagues and cups we predict, and the ones you can add.', todo: 'Nothing — add or remove leagues when you want.' },
  { id: 'leagues-basketball', tab: 'data', title: 'Basketball leagues', what: 'The basketball leagues we predict, and the ones you can add.', todo: 'Nothing — add or remove leagues when you want.' },
  { id: 'game-extras', tab: 'data', title: 'Game extras', what: 'Weather, referee, fixture difficulty and trend sentences on the game pages of the next two days.', todo: 'Nothing — it fills in by itself within a few hours. Tell Claude if it stays under 80%.', checks: ['game-extras'] },
  { id: 'news-injuries', tab: 'data', title: 'Basketball injuries from news', what: 'Players reported out in news stories, for leagues without an official injury report; they lower the player’s minutes in the model.', todo: 'Press OK when the story is right, Dismiss when it is wrong.', checks: ['bb-news-injuries'], status: s => (s.injuriesToReview ? 'warn' : 'ok') },
  { id: 'bb-results', tab: 'data', title: 'Results to check', what: 'Scores the data source may have wrong (home and away swapped, quarters that don’t add up) in basketball, American football and tennis, and football games with no final from either provider 48 hours after kick-off; clear cases are fixed by themselves and listed in the 07:00 summary email, the rest don’t count until checked. Pre-season games are never listed (they are not in the record).', todo: 'Compare with the league’s own site, then press "Swap scores" or "Keep as is" — for football, enter the result or press Void (in Needs you or in the email).', status: s => (s.bbResultsToCheck ? 'warn' : 'ok') },

  // ---------- Site health ----------
  { id: 'speed', tab: 'site', title: 'Speed', what: 'Whether the website and the background jobs freeze, how much memory they use and how often they restarted.', todo: 'Nothing if it happens once — tell Claude if it stays red.', checks: ['perf:'] },
  { id: 'deploy-errors', tab: 'site', title: 'Errors during the last deploy', what: 'Pages or files that failed for visitors in the 5 minutes after the site last restarted (target: none).', todo: 'Tell Claude, with the time of the deploy.', checks: ['deploy-errors'] },
  { id: 'site-errors', tab: 'site', title: 'Site errors', what: 'Pages that broke in visitors’ browsers, sent by the site itself.', todo: 'Tell Claude about each open one; press "Mark fixed" once the fix is live.', status: s => (s.siteErrors24h ? 'fail' : s.siteErrorsOpen ? 'warn' : 'ok') },
  { id: 'link-check', tab: 'site', title: 'Broken team links', what: 'Team links on the games of the last and next 7 days that would open "team not found".', todo: 'Tell Claude — usually a team the data source renamed.' },
  { id: 'backups', tab: 'site', title: 'Database backups', what: 'The daily copy of the database, on the server and off-site, and the free disk space.', todo: 'Press "Back up now"; if it fails again, tell Claude.', status: s => (s.backupOk === false ? 'fail' : 'ok') },
  { id: 'parity', tab: 'site', title: 'Same features in every sport', what: 'Whether every block on the football pages also exists for basketball, American football and tennis.', todo: 'Tell Claude which gaps to build.' },

  // ---------- Emails & alerts ----------
  { id: 'emails', tab: 'messages', title: 'Daily picks emails', what: 'The daily email with our picks: who got it today, bounces, and whether its numbers match the site.', todo: 'Send yourself a test; if it is still red, tell Claude.', checks: ['email-'] },
  { id: 'push', tab: 'messages', title: 'Push alerts', what: 'Phone and browser alerts (kick-off, goals, results): how many were sent and how many failed.', todo: 'Send yourself a test; if it is still red, tell Claude.', checks: ['push-'] },

  // ---------- Security ----------
  { id: 'security', tab: 'security', title: 'Security log', what: 'Sign-ins, failed sign-ins, password and two-step changes, and blocked scrapers (addresses kept 90 days).', todo: 'If you see a sign-in you did not make, change your password and tell Claude.', status: s => (s.failedSignIns24h > 20 ? 'fail' : s.failedSignIns24h > 5 ? 'warn' : 'ok') },
  { id: 'staff', tab: 'security', title: 'Staff and roles', what: 'Who on the team can open the console and what each role may do.', todo: 'Change roles in the CRM → Team & roles.' }
]

export interface HealthRule {
  /** an exact check id, or a prefix ending in "-" or ":" */
  match: string
  tab: AdminTab
  /** a plain title instead of the backend label (when it has technical words) */
  title?: string
  what: string
  todo: string
}

const FIXES = 'Nothing — it fixes itself on the next run. Tell Claude if it is still red in an hour.'
export const HEALTH_RULES: HealthRule[] = [
  // ---------- Data & feeds ----------
  { match: 'matches', tab: 'data', title: 'Football match list', what: 'Whether the football games can be read at all.', todo: 'Tell Claude straight away — no football page works without it.' },
  { match: 'feed:live', tab: 'data', what: 'Live scores of the games on right now.', todo: FIXES },
  { match: 'feed:fixtures', tab: 'data', what: 'Games and scores of the main football leagues.', todo: FIXES },
  { match: 'feed:extra-fixtures', tab: 'data', what: 'Games and scores of the other football competitions.', todo: FIXES },
  { match: 'feed:standings', tab: 'data', what: 'Football league tables.', todo: FIXES },
  { match: 'feed:results', tab: 'data', what: 'Final scores and marking our predictions right or wrong.', todo: FIXES },
  { match: 'feed:odds', tab: 'data', what: 'Bookmaker prices, used only on admin pages to judge the model.', todo: 'Nothing — visitors never see them.' },
  { match: 'feed:injuries-lineups', tab: 'data', what: 'Injuries, line-ups and match stats for football.', todo: FIXES },
  { match: 'stuck', tab: 'data', title: 'Game status up to date', what: 'Games that should have started or finished but still show the old status.', todo: FIXES },
  { match: 'fd-moving', tab: 'data', title: 'Football-Data source moving', what: 'Whether our first football source still sends new scores.', todo: 'Nothing — the second source fills in. Tell Claude if it lasts a day.' },
  { match: 'fd-twins', tab: 'data', title: 'Both football sources linked', what: 'Games of the next 7 days that we could match between our two football sources.', todo: 'Tell Claude if the same teams stay on the list.' },
  { match: 'result-sources', tab: 'data', what: 'Whether both football sources give the same final score.', todo: 'Tell Claude which games — one source has a wrong score.' },
  { match: 'no-score', tab: 'data', what: 'Finished football games without a final score.', todo: FIXES },
  { match: 'duplicates', tab: 'data', what: 'The same football game listed twice.', todo: 'Tell Claude which games.' },
  { match: 'results', tab: 'data', what: 'Whether the stored win / draw / loss agrees with the score.', todo: 'Tell Claude which games.' },
  { match: 'tables', tab: 'data', what: 'Whether the football tables add up (games, points, goals).', todo: FIXES },
  { match: 'history', tab: 'data', title: 'Past results up to date', what: 'Whether the results the model learns from include the latest games.', todo: 'Nothing — the files update a few times a week. Tell Claude if a league stays behind.' },
  { match: 'players', tab: 'data', what: 'Whether our player pages match the official top-scorer lists.', todo: 'Tell Claude if many players are off.' },
  { match: 'tennis-data', tab: 'data', title: 'Tennis data', what: 'Each tennis match listed once, predicted and up to date.', todo: FIXES },
  { match: 'bb-standings', tab: 'data', what: 'Each team once in each basketball table.', todo: 'Tell Claude which league.' },
  { match: 'live-box', tab: 'data', title: 'Live box scores', what: 'Player numbers during live games arrive on time.', todo: FIXES },
  { match: 'scorers', tab: 'data', title: 'Scorers shown', what: 'Who scored is shown for finished games in every sport.', todo: FIXES },
  { match: 'photo-sources', tab: 'data', what: 'Player photos come only from an official source (API-Football today); everyone else shows initials + flag. Red = a photo from another source (the old free-licence files) is still stored.', todo: 'Nothing — they are removed a minute after the next start. Tell Claude if it stays red.' },
  { match: 'bb-news-injuries', tab: 'data', title: 'Basketball injuries from news', what: 'Players reported out in news stories that the model uses.', todo: 'Review the waiting stories in Data & feeds.' },
  { match: 'game-extras', tab: 'data', what: 'Weather, referee and trends on the next two days’ game pages.', todo: FIXES },

  // ---------- Predictions & models ----------
  { match: 'feed:model', tab: 'models', title: 'Model ratings fresh', what: 'Team ratings the model uses, refreshed every few hours.', todo: FIXES },
  { match: 'missing-predictions', tab: 'models', title: 'Upcoming games predicted', what: 'Football games of the next days that have our prediction.', todo: FIXES },
  { match: 'no-prediction-7d', tab: 'models', title: 'Every game of the week predicted', what: 'Games of the next 7 days in every sport without our prediction.', todo: FIXES },
  { match: 'more-predictions', tab: 'models', title: 'More predictions', what: 'Extra predictions (goals, both teams score …) saved before each game and checked after it.', todo: FIXES },
  { match: 'v1-fallback', tab: 'models', title: 'Every game on our main model', what: 'Games that had to use the old simple model because data was missing.', todo: 'Tell Claude which league if it stays on the list.' },
  { match: 'probabilities', tab: 'models', title: 'Percentages add up to 100%', what: 'Every prediction’s home / draw / away adds up to 100%.', todo: 'Tell Claude straight away.' },
  { match: 'unsettled', tab: 'models', title: 'Finished games in our record', what: 'Finished games that are not yet counted as right or wrong in our public record.', todo: 'Usually nothing: from 24 hours after kick-off both data providers are asked again. A game with no final at 48 hours shows in Needs you — enter the result (goals after 90 minutes) or press Void. Tell Claude if it stays red.' },
  { match: 'bb-vs-backtest', tab: 'models', title: 'Basketball: recent hit rate vs past seasons', what: 'Each league’s last 30 days against the same model on past seasons.', todo: 'Nothing for a few days. Tell Claude if the gap stays over 8 points.' },
  { match: 'bb-grid-rows', tab: 'models', title: 'Basketball model inputs look normal', what: 'No factor of an upcoming game is far outside what the model was trained on.', todo: 'Tell Claude which game — usually a data mistake.' },
  { match: 'bb-missing-row', tab: 'models', title: 'Missing players (basketball model)', what: 'How much missing players move the basketball prediction, measured on who actually played.', todo: 'Nothing — it is refitted by itself. Tell Claude if it stays red.' },
  { match: 'bb-engine', tab: 'models', title: 'Basketball model per group', what: 'Which basketball model each group of leagues uses and since when.', todo: 'Tell Claude if the NBA is on the older model.' },
  { match: 'bb-key-players', tab: 'models', title: 'Key players shown (basketball)', what: 'Each basketball game page shows the players who matter most.', todo: FIXES },
  { match: 'bb-star-rest', tab: 'models', title: 'Star rest (basketball)', what: 'Rest nights of star players are taken into account.', todo: FIXES },
  { match: 'calibration-', tab: 'models', title: 'Do our percentages come true?', what: 'When we said 70%, it happened about 70% of the time (last 30 days).', todo: 'Nothing for a few days. Tell Claude if it stays red for a week.' },
  { match: 'league-settings-', tab: 'models', title: 'League settings fresh', what: 'Each league’s own model settings were refreshed in the last 35 days.', todo: 'Nothing — the monthly refit does it. Tell Claude if it stays red.' },
  { match: 'season-forecast-', tab: 'models', title: 'Season forecast', what: 'The finishing-place chances are fresh, follow each league’s rules and add up.', todo: 'Run it from the Season forecast card; tell Claude if it stays red.' },

  // ---------- Site health ----------
  { match: 'perf:web-stalls', tab: 'site', title: 'Website freezes', what: 'Moments in the last hour when the website made visitors wait.', todo: 'Tell Claude if it stays red.' },
  { match: 'perf:worker-stalls', tab: 'site', title: 'Background job freezes', what: 'Moments when a background job held up the others.', todo: 'Nothing if once. Tell Claude if it stays red.' },
  { match: 'perf:worker-memory', tab: 'site', title: 'Background memory', what: 'How much memory the background jobs use.', todo: 'Nothing — it restarts by itself if needed. Tell Claude if it stays yellow.' },
  { match: 'perf:worker-restarts', tab: 'site', title: 'Background restarts', what: 'How often the background jobs restarted in 24 hours.', todo: 'Tell Claude if it happens three times a day.' },
  { match: 'deploy-errors', tab: 'site', what: 'Pages or files that failed for visitors right after the last restart.', todo: 'Tell Claude, with the time of the deploy.' },

  // ---------- Emails & alerts ----------
  { match: 'email-daily', tab: 'messages', what: 'Everyone due an email today got one (or has a reason why not).', todo: 'Send yourself a test; if it is still red, tell Claude.' },
  { match: 'email-bounces', tab: 'messages', what: 'Emails that could not be delivered.', todo: 'Nothing under 2%. Tell Claude if it grows.' },
  { match: 'email-record', tab: 'messages', title: 'Email numbers match the site', what: 'The record numbers in the email are the same as on the site.', todo: 'Tell Claude.' },
  { match: 'push-delivery', tab: 'messages', what: 'Alerts that reached the phone or browser.', todo: 'Nothing under 5% failed. Tell Claude if it grows.' },
  { match: 'push-dedupe', tab: 'messages', title: 'No alert sent twice', what: 'Nobody got the same alert twice.', todo: 'Tell Claude.' }
]

/** a check id matches an exact id, the same id with a "-<sport>" ending, or a prefix ending in "-" / ":" */
const matches = (id: string, m: string) => id === m || id.startsWith(/[-:]$/.test(m) ? m : `${m}-`)
/** the rule of a check id (exact first, then the longest match) */
export function healthRule(id: string): HealthRule | null {
  return HEALTH_RULES.find(r => r.match === id) || HEALTH_RULES.filter(r => matches(id, r.match)).sort((a, b) => b.match.length - a.match.length)[0] || null
}
/** a check whose rule is missing still shows, on Site health, with its own label */
export const healthTab = (id: string): AdminTab => healthRule(id)?.tab || 'site'

const RANK: Record<Level, number> = { fail: 0, warn: 1, ok: 2 }
export const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] < RANK[a] ? b : a), 'ok')
export const byLevel = <T extends { level: Level }>(xs: T[]) => [...xs].sort((a, b) => RANK[a.level] - RANK[b.level])

/** a card's dot: the worst of its summary signal and its checks */
export function cardLevel(c: AdminCardDef, s: AdminSummary | null, checks: HealthCheck[] | null): Level {
  const ls: Level[] = []
  if (c.status && s) ls.push(c.status(s))
  if (c.checks && checks) for (const k of checks) if (c.checks.some(m => matches(k.id, m))) ls.push(k.level)
  return worst(ls)
}
export const cardChecks = (c: AdminCardDef, checks: HealthCheck[] | null) => (c.checks && checks ? checks.filter(k => c.checks!.some(m => matches(k.id, m))) : [])
export const cardsOf = (t: AdminTab) => ADMIN_CARDS.filter(c => c.tab === t)
export const cardDef = (id: string) => ADMIN_CARDS.find(c => c.id === id)!

/** what waits for Yarin: the Needs you count (red checks are added by the page) */
export const waitingCount = (s: AdminSummary | null) => (s ? s.injuriesToReview + s.bbResultsToCheck + s.contactOpen : 0)

/** words that must not appear in the admin explanations (plain English, Yarin) */
export const CODE_WORDS = /\b(oracle|LL|proxy|stalls?|sd|bb-v\d|grid-v\d|v3-mix|5xx|heap|worker)\b/i

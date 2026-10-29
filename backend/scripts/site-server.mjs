// fix260: the site under test for test:site / test:links — the built server (dist) + the built app (frontend/dist) on a
// local port, on a database copy:
//   SITE_DATA_DIR (or LOAD_DATA_DIR) = a folder with a production-size bet-to-beat.sqlite (Admin → Database backups,
//   user tables emptied): copied to a temp folder first (the copy is never changed), the test users added;
//   else a fresh temp database with the seeded test teams / players / games of every sport (scripts/site-seed.mjs).
// No data-provider key reaches the server (no outside call); every sport is public; the test admin is ADMIN_EMAILS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { TEST_USERS } from './site-seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '../..');
export const FRONT = path.join(ROOT, 'frontend');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Chromium for playwright-core: PLAYWRIGHT_CHROMIUM, the cloud image's, then the Playwright caches */
export function findChromium() {
  const c = [process.env.PLAYWRIGHT_CHROMIUM, '/opt/pw-browsers/chromium'];
  for (const dir of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')].filter(Boolean)) {
    if (!fs.existsSync(dir)) continue;
    for (const b of fs.readdirSync(dir).filter(x => /^chromium-\d+$/.test(x)).sort().reverse())
      for (const exe of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) c.push(path.join(dir, b, exe));
  }
  return c.find(x => x && fs.existsSync(x)) || null;
}
export function playwright() {
  return createRequire(path.join(FRONT, 'package.json'))('playwright-core');
}

/**
 * the site's languages ('' = English): `all` (backend utils/langs.ts ALL_LANGS: the admin sees every one) and `public`
 * (publicLangs(): PUBLIC_LANGS, default every language but the admin-only ar / he — their prefix is a 404 for visitors)
 */
export function siteLanguages() {
  const { ALL_LANGS, publicLangs } = createRequire(import.meta.url)(path.join(here, '../dist/utils/langs.js'));
  const strip = l => (l === 'en' ? '' : l);
  return { all: ALL_LANGS.map(strip), public: publicLangs().map(strip) };
}
/** the languages a visitor sees */
export const languages = () => siteLanguages().public;

function prepareData(log) {
  const copy = process.env.SITE_DATA_DIR || process.env.LOAD_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-site-'));
  if (copy) {
    for (const f of ['bet-to-beat.sqlite', 'bet-to-beat.sqlite-wal', 'bet-to-beat.sqlite-shm']) if (fs.existsSync(path.join(copy, f))) fs.copyFileSync(path.join(copy, f), path.join(dir, f));
    log(`database: a copy of ${copy}`);
  } else log('database: seeded test data (no SITE_DATA_DIR)');
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(here, 'site-seed.mjs'), dir, ...(copy ? ['--users-only'] : [])], { cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv({ DATA_DIR: dir }), timeout: 600_000 });
  if (r.status !== 0) throw new Error(`site-seed failed: ${String(r.stderr || r.stdout).slice(-2000)}`);
  return { dir, copy: !!copy };
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  // no outside call: no data-provider, email, AI or payment key
  for (const k of Object.keys(env)) if (/(_API_KEY|_KEY|_TOKEN|_SECRET|RESEND|VAPID|WEBHOOK)$/.test(k) && !/^(PLAYWRIGHT|NODE)/.test(k)) delete env[k];
  for (const k of ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY', 'SMTP_URL', 'DATABASE_URL']) delete env[k];
  return env;
}

/** start the site; resolves when the page and the sports' slug states answer */
export async function startSite({ log = console.log } = {}) {
  if (!fs.existsSync(path.join(here, '../dist/boot.js'))) throw new Error('backend/dist missing: run `npx tsc` in backend first');
  if (!fs.existsSync(path.join(FRONT, 'dist/index.html'))) throw new Error('frontend/dist missing: run `npx vite build` in frontend first');
  const data = prepareData(log);
  const port = 4100 + Math.floor(Math.random() * 800);
  const env = cleanEnv({
    PORT: String(port), DATA_DIR: data.dir, NODE_ENV: 'production', LOG_LEVEL: 'warn', SITE_PASSWORD: '',
    BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', ADMIN_EMAILS: TEST_USERS.admin.email, ADMIN_2FA_REQUIRED: '0',
    STATIC_DIR: path.join(FRONT, 'dist'), BACKUP_DISABLED: '1', SL_TEST_SITE: '1'
  });
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, '../dist/boot.js')], { env, cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const logPath = path.join(os.tmpdir(), `sl-site-server-${port}.log`);
  const logFile = fs.createWriteStream(logPath);
  child.stdout.pipe(logFile); child.stderr.pipe(logFile);
  let exited = null;
  child.on('exit', c => { exited = c; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const ok = async u => { try { const r = await fetch(base + u, { signal: AbortSignal.timeout(3000) }); return r.status < 300; } catch { return false; } };
  for (;;) {
    if (exited !== null) throw new Error(`server exited (${exited}) — log ${logPath}`);
    if (await ok('/health') && await ok('/') && await ok('/api/slugs/football') && await ok('/api/slugs/basketball')) break;
    if (Date.now() - t0 > 180_000) throw new Error(`server not ready after 3 min — log ${logPath}`);
    await sleep(500);
  }
  // fix260d: ready as the live site is when Railway switches over — /health says ready and the worker answers (an admin
  // read goes to it); a cold worker seconds after start made single first opens slow on 2-core CI runners
  const t1 = Date.now();
  for (;;) {
    let ready = false, worker = false;
    try { ready = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).json()).ready === true; } catch { /* not yet */ }
    try { worker = (await fetch(`${base}/api/admin/summary`, { headers: { cookie: `b2b_session=${TEST_USERS.admin.tokens.unlocked}` }, signal: AbortSignal.timeout(5000) })).status === 200; } catch { /* not yet */ }
    if (ready && worker) break;
    if (exited !== null) throw new Error(`server exited (${exited}) — log ${logPath}`);
    if (Date.now() - t1 > 120_000) { log('note: /health not ready or the worker not answering after 2 min — testing anyway'); break; }
    await sleep(500);
  }
  log(`site up at ${base} after ${((Date.now() - t0) / 1000).toFixed(1)} s (server log ${logPath})`);
  const stop = async () => { if (exited === null) { child.kill('SIGTERM'); for (let i = 0; i < 40 && exited === null; i++) await sleep(100); if (exited === null) child.kill('SIGKILL'); } try { fs.rmSync(data.dir, { recursive: true, force: true }); } catch { /* fine */ } };
  return { base, port, dataDir: data.dir, copy: data.copy, logPath, stop };
}

/** the items to open per sport: a match (coming, and a finished one), a team, a player, a league — from the slugs table */
export function samplePages(dataDir) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'bet-to-beat.sqlite'), { readOnly: true });
  const out = {};
  const today = new Date().toISOString().slice(0, 10);
  const one = (sql, ...a) => db.prepare(sql).get(...a)?.slug || null;
  for (const sport of ['football', 'basketball', 'american-football', 'tennis']) {
    const kind = k => `SELECT slug FROM slugs WHERE sport = ? AND kind = '${k}' AND is_primary = 1`;
    out[sport] = {
      matchNext: one(`${kind('match')} AND substr(slug, -10) >= ? ORDER BY substr(slug, -10) LIMIT 1`, sport, today),
      matchDone: one(`${kind('match')} AND substr(slug, -10) < ? ORDER BY substr(slug, -10) DESC LIMIT 1`, sport, today),
      team: sport === 'tennis' ? null : one(`${kind('team')} ORDER BY rowid LIMIT 1`, sport),
      player: one(`${kind('player')} ORDER BY rowid LIMIT 1`, sport),
      league: one(`${kind('league')} ORDER BY rowid LIMIT 1`, sport)
    };
  }
  db.close();
  return out;
}

// fix271: pages with missing data, opened on every run (the 28 Oct crash: Game extras on college team pages with no next
// game) — three college teams, an NFL team without a next game, and in every sport a team with no upcoming game and a
// player with no current season (site-seed.mjs seedEdge; on a production copy the ones whose slug exists there)
export const EDGE_PAGES = [
  '/american-football/team/colorado-state', '/american-football/team/alabama-state', '/american-football/team/utah-state',
  '/american-football/team/chicago-state', '/american-football/team/washington-state', '/american-football/team/fresno-state',
  '/american-football/team/new-york-jets', '/american-football/player/aaron-rodgers',
  '/basketball/team/utah-jazz', '/basketball/player/lauri-markkanen',
  '/football/team/burnley', '/football/player/jay-rodriguez',
  '/tennis/player/dominic-thiem'
];
export function edgePages(dataDir) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'bet-to-beat.sqlite'), { readOnly: true });
  const has = db.prepare(`SELECT 1 FROM slugs WHERE sport = ? AND kind = ? AND slug = ?`);
  const out = EDGE_PAGES.filter(p => { const [, sport, kind, slug] = p.split('/'); return !!has.get(sport, kind, slug); });
  db.close();
  return out;
}

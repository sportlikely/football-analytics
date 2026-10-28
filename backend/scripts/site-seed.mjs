// fix260: the test site's database — seeded test users (test values only, never a real account) and a small set of
// teams, players and games in every sport, so test:site / test:links open every page type with content. Used when no
// production-size copy is given (SITE_DATA_DIR / LOAD_DATA_DIR: Admin → Database backups, user tables emptied); on a
// copy only the test users are added.
//
//   node scripts/site-seed.mjs <data dir> [--users-only]      (after tsc: it uses the app's own modules for the tables)
//
// Test accounts (password Test-pass-1, console login admin / Console-pass-1) and their session cookies (b2b_session):
//   admin@sl-test.local  admin-unlocked-token (console signed in) · admin-locked-token (console locked)
//   free@sl-test.local   free-token
// The server must run with ADMIN_EMAILS=admin@sl-test.local (scripts/site-server.mjs sets it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEST_USERS = {
  admin: { email: 'admin@sl-test.local', tokens: { unlocked: 'admin-unlocked-token', locked: 'admin-locked-token' } },
  free: { email: 'free@sl-test.local', token: 'free-token' }
};
export const TEST_PASSWORD = 'Test-pass-1';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = pw => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
};
const iso = ms => new Date(ms).toISOString();
const DAY = 86400000;

function seedUsers(db) {
  const now = iso(Date.now()), exp = iso(Date.now() + 30 * DAY);
  const user = (email, plan = 'free') => {
    db.prepare(`INSERT OR IGNORE INTO users (email, name, pass_hash, plan, created_at, email_verified, terms_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(email, email.split('@')[0], scrypt(TEST_PASSWORD), plan, now, now);
    return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  };
  const session = (uid, token, consoleOk) => db.prepare(`INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, mfa, console_ok) VALUES (?, ?, ?, ?, 'site-test', 1, ?)`)
    .run(sha(token), uid, now, exp, consoleOk);
  const a = user(TEST_USERS.admin.email), f = user(TEST_USERS.free.email);
  session(a, TEST_USERS.admin.tokens.unlocked, 1);
  session(a, TEST_USERS.admin.tokens.locked, 0);
  session(f, TEST_USERS.free.token, 0);
  db.prepare(`INSERT OR REPLACE INTO staff_console (user_id, username, pass_hash, must_change, updated_at) VALUES (?, 'admin', ?, 0, ?)`).run(a, scrypt('Console-pass-1'), now);
}

/* ---------- sports: a few teams, players and games around today (finished, today, coming) ---------- */
const T0 = Date.now();
const at = (days, hour = 19) => { const d = new Date(T0 + days * DAY); d.setUTCHours(hour, 0, 0, 0); return iso(d.getTime()); };
const DAYS = [-6, -4, -2, -1, 0, 1, 2, 4, 6];

function seedBasketball(db) {
  const teams = [[9101, 'Boston Celtics'], [9102, 'Los Angeles Lakers'], [9103, 'Portland Trail Blazers'], [9104, 'Golden State Warriors']];
  // API-Basketball writes names last name first ("Lillard Damian"); the slug and the page use the common order
  const players = { 9101: [[91011, 'Tatum Jayson'], [91012, 'Brown Jaylen']], 9102: [[91021, 'James LeBron'], [91022, 'Reaves Austin']], 9103: [[91031, 'Lillard Damian'], [91032, 'Champagnie Julian']], 9104: [[91041, 'Curry Stephen'], [91042, 'Harper D.']] };
  let id = 990001;
  const now = iso(T0);
  DAYS.forEach((d, i) => {
    const [h, a] = [teams[i % 4], teams[(i + 1 + (i >> 2)) % 4]];
    if (h[0] === a[0]) return;
    const done = d < 0;
    const gid = id++;
    db.prepare(`INSERT OR REPLACE INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, quarters, updated_at, stats) VALUES (?, 'NBA', 12, '2026-2027', 'NBA - Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(gid, at(d, 0), done ? 'FT' : 'NS', h[0], h[1], a[0], a[1], done ? 110 + i : null, done ? 104 + (i % 3) * 5 : null,
        done ? JSON.stringify({ home: [28, 27, 30, 25 + i], away: [26, 25, 28, 25 + (i % 3) * 5] }) : null, now, done ? 1 : 0);
    if (done) for (const [tid] of [h, a]) players[tid].forEach(([pid, name], k) =>
      db.prepare(`INSERT OR REPLACE INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast) VALUES (?, ?, ?, ?, 1, ?, ?, 8, 17, 3, 8, 4, 5, 6, 5)`)
        .run(gid, tid, pid, name, 34 - k * 4, 27 - k * 6));
    db.prepare(`INSERT OR REPLACE INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (?, 'NBA', ?, 'bb-v3', ?, ?, 221.5, 112, 109, ?)`)
      .run(gid, at(d, 0), 0.58 + (i % 3) * 0.05, 3.5, at(d - 1, 12));
  });
  for (const [tid, list] of Object.entries(players)) for (const [pid, name] of list)
    db.prepare(`INSERT OR REPLACE INTO bb_roster (team_id, season, player_id, name, number, country, position, age, updated_at) VALUES (?, '2026-2027', ?, ?, '0', 'USA', 'G', 28, ?)`).run(Number(tid), pid, name, now);
}

function seedNfl(db) {
  const now = iso(T0);
  const teams = [[9201, 'Kansas City Chiefs', 'KC'], [9202, 'Buffalo Bills', 'BUF'], [9203, 'Philadelphia Eagles', 'PHI'], [9204, 'Dallas Cowboys', 'DAL']];
  for (const [tid, name, code] of teams) {
    db.prepare(`INSERT OR REPLACE INTO nfl_teams (team_id, name, code, city, conference, division, updated_at, league, level) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)`)
      .run(tid, name, code, name.split(' ')[0], tid < 9203 ? 'American Football Conference' : 'National Football Conference', tid < 9203 ? 'AFC West' : 'NFC East', now);
    for (const [k, pos] of [[1, 'QB'], [2, 'WR']])
      db.prepare(`INSERT OR REPLACE INTO nfl_players (player_id, team_id, name, position, grp, number, age, season, updated_at) VALUES (?, ?, ?, ?, 'Offense', ?, 27, 2026, ?)`)
        .run(tid * 10 + k, tid, `${['Patrick', 'Josh', 'Jalen', 'Dak'][tid - 9201]} ${pos === 'QB' ? 'Starter' : 'Receiver'} ${code}`, pos, k, now);
  }
  let id = 990101;
  [-7, -1, 0, 3, 7].forEach((d, i) => {
    const h = teams[i % 4], a = teams[(i + 2) % 4], done = d < 0;
    db.prepare(`INSERT OR REPLACE INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, updated_at, league) VALUES (?, 2026, ?, 'Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(id++, `Week ${8 + i}`, at(d, 18), h[0], h[1], a[0], a[1], done ? 'FT' : 'NS', done ? 27 : null, done ? 20 + i : null, now);
    db.prepare(`INSERT OR REPLACE INTO nfl_predictions (game_id, season, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (?, 2026, ?, 'nfl-v1', 0.61, 3, 45.5, 24, 21, ?)`)
      .run(id - 1, at(d, 18), at(d - 1, 12));
  });
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('current', ?, '2026')`).run(now);
}

function seedTennis(db) {
  const now = iso(T0);
  const pl = [[9301, 'Carlos Alcaraz', 'ESP', 1], [9302, 'Jannik Sinner', 'ITA', 2], [9303, 'Alexander Zverev', 'GER', 3], [9304, 'Taylor Fritz', 'USA', 4]];
  for (const [pid, name, c, r] of pl)
    db.prepare(`INSERT OR REPLACE INTO tennis_players (id, name, country, tour, hand, dob, ranking, ranking_points, updated_at, seen_at, first_name, last_name) VALUES (?, ?, ?, 'atp', 'R', '2000-05-05', ?, ?, ?, ?, ?, ?)`)
      .run(pid, name, c, r, 10000 - r * 1000, now, now, name.split(' ')[0], name.split(' ')[1]);
  db.prepare(`INSERT OR REPLACE INTO tennis_tournaments (id, name, tour, tier, category, surface, indoor, city, country, start_date, end_date, updated_at) VALUES (9390, 'Paris Masters', 'atp', 'atp_1000', 'singles', 'hard', 1, 'Paris', 'France', ?, ?, ?)`)
    .run(at(-3).slice(0, 10), at(4).slice(0, 10), now);
  let id = 990201;
  [-2, -1, 0, 1, 2].forEach((d, i) => {
    const a = pl[i % 4], b = pl[(i + 1) % 4], done = d < 0;
    db.prepare(`INSERT OR REPLACE INTO tennis_matches (id, tournament_id, tournament, tour, tier, surface, indoor, draw, round, round_code, is_qualifying, best_of, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, sets, winner, retired, source, updated_at) VALUES (?, 9390, 'Paris Masters', 'atp', 'atp_1000', 'hard', 1, 'singles', 'Round of 16', 'R16', 0, 3, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'live', ?)`)
      .run(id++, at(d, 13), done ? 'finished' : 'not_started', a[0], a[1], b[0], b[1], done ? JSON.stringify([[6, 4], [7, 5]]) : null, done ? 1 : null, now);
    db.prepare(`INSERT OR REPLACE INTO tennis_predictions (match_id, model, scheduled_at, cat, p1, made_at) VALUES (?, 'tennis-v1', ?, 'atp', 0.62, ?)`).run(id - 1, at(d, 13), at(d - 1, 12));
  });
}

function seedFootball(db) {
  const AF = 1_000_000_000;
  const now = iso(T0);
  // API-Football clubs (Premier League = league 39, group AF39) and their players
  const teams = [[9401, 'Arsenal'], [9402, 'Chelsea'], [9403, 'Liverpool'], [9404, 'Manchester City']];
  for (const [tid, name] of teams) {
    db.prepare(`INSERT OR REPLACE INTO af_teams (grp, team_id, name, fd_name, score) VALUES ('AF39', ?, ?, ?, 80)`).run(tid, name, `${name} FC`);
    const names = { 9401: ['Bukayo Saka', 'Declan Rice'], 9402: ['Cole Palmer', 'Enzo Fernandez'], 9403: ['Mohamed Salah', 'Virgil van Dijk'], 9404: ['Erling Haaland', 'Phil Foden'] }[tid];
    names.forEach((pn, k) =>
      db.prepare(`INSERT OR REPLACE INTO af_player_season (player_id, season, team_id, league_id, name, age, position, apps, starts, minutes, rating, goals, assists) VALUES (?, 2026, ?, 39, ?, 24, 'Attacker', 9, 9, 800, '7.2', 4, 3)`)
        .run(tid * 10 + k + 1, tid, pn));
  }
  db.prepare(`INSERT OR REPLACE INTO af_league_dates (league_id, season, start, end, fetched_at) VALUES (39, 2026, '2026-08-14', '2027-05-23', ?)`).run(now);
  let id = 990301;
  DAYS.forEach((d, i) => {
    const h = teams[i % 4], a = teams[(i + 1 + (i >> 2)) % 4];
    if (h[0] === a[0]) return;
    const done = d < 0;
    db.prepare(`INSERT OR REPLACE INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status, hg, ag, lineups, stats) VALUES (?, 39, 2026, 'AF39', 'Premier League', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`)
      .run(id, at(d, 15), at(d, 15).slice(0, 10), h[0], a[0], h[1], a[1], done ? 'FT' : 'NS', done ? 2 : null, done ? i % 3 : null);
    // the saved prediction (grid-v3), made the day before
    const ph = 0.45 + (i % 3) * 0.08, pd = 0.27;
    db.prepare(`INSERT OR REPLACE INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, xg_home, xg_away, over25, btts, confidence, locked, settled, created_at, updated_at, backfilled) VALUES (?, 'grid-v3', 'AF39', 'Premier League', ?, ?, ?, ?, ?, ?, ?, ?, 1.6, 1.1, 0.55, 0.5, 'medium', ?, ?, ?, ?, 0)`)
      .run(AF + id, at(d, 15), AF + h[0], h[1], AF + a[0], a[1], ph, pd, 1 - ph - pd, done ? 1 : 0, done ? 1 : 0, at(d - 1, 12), at(d - 1, 12));
    id++;
  });
}

// Football-Data.org matches of the top competitions (their codes give the league pages: PL premier-league …)
function seedFootballData(db) {
  const comps = [['PL', 'Premier League', [57, 'Arsenal FC'], [61, 'Chelsea FC']], ['PD', 'Primera Division', [86, 'Real Madrid CF'], [81, 'FC Barcelona']],
    ['SA', 'Serie A', [108, 'FC Internazionale Milano'], [98, 'AC Milan']], ['BL1', 'Bundesliga', [5, 'FC Bayern München'], [4, 'Borussia Dortmund']],
    ['FL1', 'Ligue 1', [524, 'Paris Saint-Germain FC'], [516, 'Olympique de Marseille']], ['CL', 'UEFA Champions League', [86, 'Real Madrid CF'], [5, 'FC Bayern München']]];
  // each Football-Data.org team is an API-Football club (the team page's own resolution, table team_resolve)
  const af = { 57: 9401, 61: 9402 };
  let next = 9411;
  for (const [, , h, a] of comps) for (const [fd, name] of [h, a]) if (!af[fd]) {
    af[fd] = next++;
    db.prepare(`INSERT OR REPLACE INTO af_teams (grp, team_id, name, fd_name, score) VALUES ('AF39', ?, ?, ?, 70)`).run(af[fd], name.replace(/ (FC|CF)$|^(FC|AC) /g, ''), name);
  }
  // and a past game of theirs in API-Football's twin league (the team index is built from fixtures)
  const twin = { PD: 140, SA: 135, BL1: 78, FL1: 61, CL: 2 };
  let fx = 990501;
  for (const [code, name, h, a] of comps) if (twin[code])
    db.prepare(`INSERT OR REPLACE INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status, hg, ag, lineups, stats) VALUES (?, ?, 2026, ?, ?, ?, ?, ?, ?, ?, ?, 'FT', 1, 1, 0, 0)`)
      .run(fx++, twin[code], `AF${twin[code]}`, name, at(-20, 19), at(-20, 19).slice(0, 10), af[h[0]], af[a[0]], h[1], a[1]);
  for (const [fd, a] of Object.entries(af)) db.prepare(`INSERT OR REPLACE INTO team_resolve (fd_id, af_id, via, at) VALUES (?, ?, 'seed', ?)`).run(Number(fd), a, iso(T0));
  let id = 990401;
  comps.forEach(([code, name, h, a], i) => {
    for (const d of [-3, 2]) {
      const done = d < 0, ph = 0.48, pd = 0.26;
      db.prepare(`INSERT OR REPLACE INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, xg_home, xg_away, over25, btts, confidence, locked, settled, created_at, updated_at, backfilled) VALUES (?, 'grid-v3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.5, 1.2, 0.52, 0.5, 'medium', ?, ?, ?, ?, 0)`)
        .run(id, code, name, at(d + i % 2, 19), d < 0 ? h[0] : a[0], d < 0 ? h[1] : a[1], d < 0 ? a[0] : h[0], d < 0 ? a[1] : h[1], ph, pd, 1 - ph - pd, done ? 1 : 0, done ? 1 : 0, at(d - 1, 12), at(d - 1, 12));
      if (done) try { db.prepare(`INSERT OR REPLACE INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', 2, 1, 'H', ?)`).run(id, at(d, 22)); } catch { /* the results table's columns: the match still opens */ }
      id++;
    }
  });
}

export async function seedSite(dataDir, { usersOnly = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_EMAILS ||= TEST_USERS.admin.email;
  // the worker's role: the slug states are published (shared_state), as the server's own worker does after each build
  process.env.SL_ROLE = 'worker';
  const require = createRequire(import.meta.url);
  const dist = p => path.join(here, '../dist', p);
  // the app's own modules create every table they own (every service is loaded once, as the worker does)
  if (!fs.existsSync(dist('services'))) throw new Error('run tsc first (backend/dist missing)');
  for (const f of fs.readdirSync(dist('services')).filter(f => f.endsWith('.js')).sort()) {
    try { require(dist(`services/${f}`)); } catch (e) { console.warn(`site-seed: services/${f}: ${String(e?.message).split('\n')[0]}`); }
  }
  const { db } = require(dist('db/index.js'));
  seedUsers(db);
  if (!usersOnly) {
    const has = (db.prepare(`SELECT COUNT(*) AS n FROM bb_games`).get()).n;
    if (!has) { seedBasketball(db); seedNfl(db); seedTennis(db); seedFootball(db); seedFootballData(db); }
    const { buildSlugs } = require(dist('services/slugs.js'));
    await buildSlugs({ full: true });
  }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* fine */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/site-seed.mjs <data dir> [--users-only]'); process.exit(2); }
  seedSite(path.resolve(dir), { usersOnly: process.argv.includes('--users-only') })
    .then(() => { console.log(`site-seed: ${dir} ready`); process.exit(0); }, e => { console.error('site-seed failed:', e); process.exit(1); });
}

// fix239: results swapped by the provider fix themselves when every signal agrees (Kedainiai BC – Plunges Olimpas, LKL
// 24 Oct 2026: score 62-75, the players' points 75-62), stay manual when the signals disagree; NFL (scoring plays) and
// tennis (sets) the same; the admin email template renders in light and dark mode; the signed one-time links expire after
// 72 h and work once; anything fixed automatically goes into one 07:00 Israel-time summary. (dist build)
// Run: npm run test:fix239
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix239-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.RESEND_API_KEY; delete process.env.BREVO_API_KEY; // email off: nothing leaves the test
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { db } = require('../dist/db/index.js');
const { swapVerdict, tennisVerdict, nflPlayPoints, periodTotals } = require('../dist/utils/resultSwap.js');
const mail = require('../dist/services/adminMail.js');

/* ---------- the rule (pure) ---------- */

test('fix239: Kedainiai – Plunges Olimpas: players add up 75-62 against a 62-75 score → swapped (no quarters)', () => {
  const v = swapVerdict({ score: [62, 75], box: [75, 62], periods: null });
  assert.equal(v.action, 'swap', v.why);
});
test('fix239: … and with quarters that add up 75-62 too → swapped', () => {
  const v = swapVerdict({ score: [62, 75], box: [75, 62], periods: { home: [20, 18, 17, 20], away: [15, 16, 14, 17] } });
  assert.equal(v.action, 'swap', v.why);
});
test('fix239: signals disagree (quarters add up as sent) → a person decides', () => {
  const v = swapVerdict({ score: [62, 75], box: [75, 62], periods: { home: [15, 16, 14, 17], away: [20, 18, 17, 20] } });
  assert.equal(v.action, 'review');
  assert.match(v.why, /disagree/);
});
test('fix239: only the quarters say "reversed", no box score → a person decides', () => {
  assert.equal(swapVerdict({ score: [62, 75], box: null, periods: { home: [20, 18, 17, 20], away: [15, 16, 14, 17] } }).action, 'review');
});
test('fix239: nothing against the score → ok; a gap in the quarters is not a signal', () => {
  assert.equal(swapVerdict({ score: [75, 62], box: [75, 62], periods: { home: [20, 18, 17, 20], away: [15, 16, 14, 17] } }).action, 'ok');
  assert.equal(periodTotals({ home: [20, null, 17, 20], away: [15, 16, 14, 17] }), null);
  assert.equal(swapVerdict({ score: [62, 75], box: [74, 62], periods: null }).action, 'ok'); // not exactly reversed
});
test('fix239: American football — points per team from the scoring plays (by team id)', () => {
  const plays = [{ team: 7, score: [0, 7] }, { team: 9, score: [3, 7] }, { team: 7, score: [3, 14] }];
  assert.deepEqual(nflPlayPoints(plays, 9, 7), [3, 14]);
  assert.equal(nflPlayPoints([{ team: null, score: [0, 7] }], 9, 7), null);
});
test('fix239: tennis — sets and the sets count both against the winner → corrected; only one → review; retirement → left alone', () => {
  assert.deepEqual(tennisVerdict({ winner: 1, games: [[4, 3], [6, 6]], sets: [0, 2], retired: false }), { action: 'swap', winner: 2, why: tennisVerdict({ winner: 1, games: [[4, 3], [6, 6]], sets: [0, 2], retired: false }).why });
  assert.equal(tennisVerdict({ winner: 1, games: [[4, 3], [6, 6]], sets: [2, 0], retired: false }).action, 'review');
  assert.equal(tennisVerdict({ winner: 1, games: [[6, 7], [3, 6]], sets: [2, 0], retired: false }).action, 'ok');
  assert.equal(tennisVerdict({ winner: 1, games: [[4, 3], [6, 6]], sets: [0, 2], retired: true }).action, 'ok');
});

/* ---------- basketball end to end (database) ---------- */

test('fix239: the Kedainiai game is swapped, kept as a "box score" correction, back in the record; the disagreeing game stays manual', async () => {
  require('../dist/services/basketball.js'); // bb_games / bb_player_stats
  const bb = require('../dist/services/bbResults.js');
  const info = db.prepare('PRAGMA table_info(bb_games)').all();
  const cols = new Set(info.map(c => c.name));
  // any other required column gets a plain value (league_id, season …)
  const filler = Object.fromEntries(info.filter(c => c.notnull && c.dflt_value == null && !c.pk).map(c => [c.name, /TEXT/i.test(c.type) ? 'x' : 1]));
  const ko = new Date(Date.now() - 2 * 86400000).toISOString();
  const ins = (id, hs, as_, quarters) => {
    const row = { ...filler, game_id: id, code: 'LKL', kickoff: ko, status: 'FT', home_id: 100 + id, home_name: id === 1 ? 'Kedainiai BC' : 'Home ' + id, away_id: 200 + id, away_name: id === 1 ? 'Plunges Olimpas' : 'Away ' + id, hs, as_, quarters: quarters ? JSON.stringify(quarters) : null };
    const k = Object.keys(row).filter(c => cols.has(c));
    db.prepare(`INSERT INTO bb_games (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(c => row[c]));
  };
  const pinfo = db.prepare('PRAGMA table_info(bb_player_stats)').all();
  const pcols = new Set(pinfo.map(c => c.name));
  const pfill = Object.fromEntries(pinfo.filter(c => c.notnull && c.dflt_value == null).map(c => [c.name, /TEXT/i.test(c.type) ? 'x' : 1]));
  const pl = (game, team, player, pts) => {
    const row = { ...pfill, game_id: game, team_id: team, player_id: player, pts, name: 'P' + player, player_name: 'P' + player, min: 30, minutes: 30 };
    const k = Object.keys(row).filter(c => pcols.has(c));
    db.prepare(`INSERT INTO bb_player_stats (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(c => row[c]));
  };
  // 1: Kedainiai – score 62-75, players 75-62, no quarters (as in the provider data of 24 Oct)
  ins(1, 62, 75, null); pl(1, 101, 1, 40); pl(1, 101, 2, 35); pl(1, 201, 3, 30); pl(1, 201, 4, 32);
  // it was already under review from the old rule (as on the server): the new run settles it
  db.prepare(`INSERT INTO bb_result_check (game_id, issue, detail, found_at) VALUES (1, 'swapped?', 'old rule', ?)`).run(new Date().toISOString());
  // 2: the same, but the quarters add up the way the score was sent → disagree → manual
  ins(2, 62, 75, { home: [15, 16, 14, 17], away: [20, 18, 17, 20] }); pl(2, 102, 5, 75); pl(2, 202, 6, 62);
  const r = await bb.checkResults(10);
  assert.equal(r.fixedAuto, 1);
  const g1 = db.prepare('SELECT hs, as_ FROM bb_games WHERE game_id = 1').get();
  assert.deepEqual({ ...g1 }, { hs: 75, as_: 62 });
  const f1 = bb.resultFix(1);
  assert.equal(f1.source, 'box score');
  assert.equal(f1.provider_hs, 62);
  assert.equal(bb.openCheck(1), null, 'back in the record (no open check)');
  // the correction survives a provider update
  db.prepare('UPDATE bb_games SET hs = 62, as_ = 75 WHERE game_id = 1').run();
  bb.applyResultFixes();
  assert.equal(db.prepare('SELECT hs FROM bb_games WHERE game_id = 1').get().hs, 75);
  // game 2 stays manual, out of the record
  const g2 = db.prepare('SELECT hs, as_ FROM bb_games WHERE game_id = 2').get();
  assert.deepEqual({ ...g2 }, { hs: 62, as_: 75 });
  assert.equal(bb.openCheck(2).issue, 'swapped?');
  // the automatic fix waits for the summary, no email of its own
  const notes = db.prepare(`SELECT title FROM admin_auto_fixes WHERE summary_day IS NULL`).all().map(x => x.title);
  assert.ok(notes.some(t => /Kedainiai BC – Plunges Olimpas: 62-75 → 75-62/.test(t)), notes.join(' | '));
  // the "Needs you" email for game 2: subject, the two buttons as signed links, the clean admin path
  const { subject, mail: m } = bb.needsYouMail([{ ...db.prepare('SELECT * FROM bb_games WHERE game_id = 2').get(), issue: 'swapped?', detail: bb.openCheck(2).detail }]);
  assert.equal(subject, 'Needs you: 1 basketball result');
  const { html, text } = mail.renderAdminMail(m);
  assert.match(html, /Swap scores \(75–62\)/);
  assert.match(html, /Keep as is/);
  assert.match(html, /https:\/\/sportlikely\.com\/admin\/act\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}/);
  assert.match(html, /https:\/\/sportlikely\.com\/admin\/needs-you/);
  assert.match(text, /What to do: /);
  assert.ok(!/Users → Overview/.test(html + text), 'no old admin path');
  // the email button: swap from the link → the game is decided and counts again
  const link = /\/admin\/act\/([A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22})"[^>]*>Swap scores/.exec(html)[1];
  const out = mail.runAction(link, 'admin@example.com');
  assert.equal(out.state, 'used');
  assert.match(out.message, /Scores swapped/);
  assert.equal(bb.openCheck(2), null);
  assert.equal(db.prepare('SELECT hs FROM bb_games WHERE game_id = 2').get().hs, 75);
});

/* ---------- signed links ---------- */

test('fix239: a signed link works once, expires after 72 h, and a changed token does nothing', () => {
  let n = 0;
  mail.onEmailAction('test', p => { n += p.add; return { message: `added ${p.add}` }; });
  const t0 = Date.now();
  const tok = u => u.split('/admin/act/')[1];
  const a = tok(mail.actionLink('test', { add: 1 }, 'add one', t0));
  assert.equal(mail.actionInfo(a, t0 + 3600e3).state, 'ready');
  assert.equal(mail.runAction(a, 'x', t0 + 71 * 3600e3).message, 'added 1');
  assert.equal(mail.runAction(a, 'x', t0 + 71 * 3600e3).state, 'used'); // second click
  assert.equal(n, 1);
  const b = tok(mail.actionLink('test', { add: 5 }, 'add five', t0));
  assert.equal(mail.runAction(b, 'x', t0 + 72 * 3600e3 + 1000).state, 'expired');
  assert.equal(n, 1);
  const c = tok(mail.actionLink('test', { add: 7 }, 'add seven', t0));
  const forged = c.slice(0, 17) + (c[17] === 'A' ? 'B' : 'A') + c.slice(18);
  assert.equal(mail.runAction(forged, 'x', t0).state, 'invalid');
  assert.equal(mail.runAction('nonsense', 'x', t0).state, 'invalid');
  assert.equal(n, 1);
});

test('fix239: /admin/act/<token> is a plain app page (the slug rules leave it alone)', () => {
  const { linkAnswer } = require('../dist/services/slugs.js');
  const a = linkAnswer('/admin/act/abcdefghijklmnop.abcdefghijklmnopqrstuv', '');
  assert.ok(!a || !('to' in a || 'search' in a), JSON.stringify(a));
});

/* ---------- daily summary ---------- */

test('fix239: one summary at 07:00 Israel time with everything that fixed itself, then nothing until tomorrow', async () => {
  const { buildSummary, dailySummaryTick } = mail;
  const items = [1, 2, 3].map(i => ({ at: new Date().toISOString(), area: 'basketball result', title: `Game ${i}`, detail: null, href: null }));
  assert.equal(buildSummary(items).subject, 'Fixed automatically: 3 results (daily summary)');
  assert.equal(buildSummary(items.slice(0, 1)).subject, 'Fixed automatically: 1 result (daily summary)');
  // 06:30 Israel time (03:30 UTC in winter, 26 Oct 2026 is after the clocks change) → not yet; 07:05 → runs once
  const before = Date.parse('2026-10-27T04:30:00Z'), at = Date.parse('2026-10-27T05:05:00Z');
  assert.equal(mail.israelParts(before).hour, 6);
  assert.equal(await dailySummaryTick(before), null);
  const r = await dailySummaryTick(at);
  assert.ok(r && r.items >= 1, JSON.stringify(r));
  assert.equal(await dailySummaryTick(at + 600e3), null, 'once a day');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM admin_auto_fixes WHERE summary_day IS NULL`).get().n, 0);
});

/* ---------- the template in light and dark mode ---------- */

test('fix239: the admin email renders in light and dark mode (inline styles, logo header, buttons)', async () => {
  const m = {
    label: 'Basketball results', tone: 'warn', title: '1 basketball result to check',
    what: 'The score of Kedainiai BC – Plunges Olimpas may be wrong in the data, so it is left out of the record.',
    todo: 'Compare with the league’s own site, then press "Swap scores" or "Keep as is".',
    rows: [{ when: 'LKL · 24 Oct, 18:00', title: 'Kedainiai BC 62–75 Plunges Olimpas', titleHref: 'https://sportlikely.com/basketball/match/kedainiai-vs-plunges-olimpas-2026-10-24', detail: 'The players’ points add up to 75-62.',
      buttons: [{ text: 'Swap scores (75–62)', href: 'https://sportlikely.com/admin/act/x' }, { text: 'Keep as is', href: 'https://sportlikely.com/admin/act/y', kind: 'secondary' }] }],
    buttons: [{ text: 'Open in Admin', href: 'https://sportlikely.com/admin/needs-you' }]
  };
  const { html, text } = mail.renderAdminMail(m);
  // Gmail keeps inline styles (and drops <style> in some clients): every text block carries its own colour
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /logo-mark\.png/);
  assert.ok(!/<script|<link /i.test(html));
  for (const tag of html.match(/<(h1|p|a|div)\b[^>]*>/g)) if (!/display:none/.test(tag)) assert.match(tag, /style="/, tag);
  assert.match(text, /Swap scores \(75–62\): https:\/\/sportlikely\.com\/admin\/act\/x/);
  // a real browser in both schemes: the card turns dark, the text stays readable, the buttons are there
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return; }
  const out = path.join(here, '../test-output/fix239');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 640, height: 900 }, colorScheme: scheme });
      await page.setContent(html.replace(/https:\/\/sportlikely\.com\/logo-mark\.png/, 'data:image/gif;base64,R0lGODlhAQABAAAAACw='));
      const card = await page.$eval('.sl-card', el => getComputedStyle(el).backgroundColor);
      const h1 = await page.$eval('h1', el => getComputedStyle(el).color);
      const btn = await page.$$eval('a', as => as.filter(a => /Swap scores|Keep as is|Open in Admin/.test(a.textContent)).length);
      assert.equal(btn, 3);
      if (scheme === 'light') { assert.equal(card, 'rgb(255, 255, 255)'); assert.equal(h1, 'rgb(17, 20, 25)'); }
      else { assert.equal(card, 'rgb(21, 26, 33)'); assert.equal(h1, 'rgb(232, 234, 238)'); }
      await page.screenshot({ path: path.join(out, `admin-email-${scheme}.png`), fullPage: true });
      await page.close();
    }
  } finally { await browser.close(); }
});

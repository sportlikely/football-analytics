// fix260: the pure parts of the site gate — basketball names first-name first (slugs + 301 aliases), anything after an
// item's slug (tabs, doubled relative links, junk), the seeded test database, the CI report's plain words.
//   npm run test:fix260   (after tsc)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { bbCommonName } = require('../dist/utils/personName.js');
const { splitTail } = require('../dist/utils/slugRules.js');

test('basketball names: first name first', () => {
  assert.equal(bbCommonName('Lillard Damian'), 'Damian Lillard');
  assert.equal(bbCommonName('Champagnie Julian'), 'Julian Champagnie');
  assert.equal(bbCommonName('Gilgeous-Alexander Shai'), 'Shai Gilgeous-Alexander');
  assert.equal(bbCommonName('Van Vleet Fred'), 'Fred Van Vleet');
  assert.equal(bbCommonName('Jackson Jr. Jaren'), 'Jaren Jackson Jr.');
  assert.equal(bbCommonName('Harper D.'), 'D. Harper');
  assert.equal(bbCommonName('D. Harper'), 'D. Harper');
  assert.equal(bbCommonName('Nene'), 'Nene');
});

test('after a slug: tabs, doubled relative links, junk', () => {
  assert.deepEqual(splitTail('/football/match/a-vs-b-2026-10-28/stats'), { base: '/football/match/a-vs-b-2026-10-28', tab: 'stats', inner: null });
  assert.deepEqual(splitTail('/basketball/player/lillard-damian/player/damian-lillard'), { base: '/basketball/player/lillard-damian', tab: null, inner: '/basketball/player/damian-lillard' });
  assert.deepEqual(splitTail('/basketball/team/x/basketball/team/y'), { base: '/basketball/team/x', tab: null, inner: '/basketball/team/y' });
  assert.deepEqual(splitTail('/football/team/real-madrid/xyz'), { base: '/football/team/real-madrid', tab: null, inner: null });
  assert.deepEqual(splitTail('/football/team/real-madrid/a/b/c'), { base: '/football/team/real-madrid', tab: null, inner: null });
  assert.equal(splitTail('/football/team/real-madrid'), null);
  assert.equal(splitTail('/football/matches'), null);
  // the two copies of the rules stay identical (parity checks it too)
  assert.equal(fs.readFileSync(path.join(here, '../src/utils/slugRules.ts'), 'utf8'), fs.readFileSync(path.join(here, '../../frontend/src/lib/slugRules.ts'), 'utf8'));
});

test('seeded test site: every sport has items; basketball players are first-name first, the API order a 301 alias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fix260-'));
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(here, 'site-seed.mjs'), dir], { cwd: path.join(here, '..'), encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, r.stderr);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'bet-to-beat.sqlite'), { readOnly: true });
  for (const sport of ['football', 'basketball', 'american-football', 'tennis'])
    for (const kind of ['match', 'player', 'league', ...(sport === 'tennis' ? [] : ['team'])])
      if (!(sport === 'football' && kind === 'league')) assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM slugs WHERE sport = ? AND kind = ? AND is_primary = 1`).get(sport, kind).n > 0, `${sport} ${kind}`);
  const prim = db.prepare(`SELECT slug FROM slugs WHERE sport = 'basketball' AND kind = 'player' AND id = '91031' AND is_primary = 1`).get();
  assert.equal(prim.slug, 'damian-lillard');
  const alias = db.prepare(`SELECT is_primary FROM slugs WHERE sport = 'basketball' AND kind = 'player' AND slug = 'lillard-damian'`).get();
  assert.equal(alias?.is_primary, 0);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n >= 3);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM shared_state WHERE key LIKE 'slugs:%'`).get().n === 4);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CI report: plain words, every failing page listed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fix260r-'));
  const f = path.join(dir, 'site-report-1.json');
  fs.writeFileSync(f, JSON.stringify({ test: 'test:site', opened: 10, failed: 2, pages: [{ page: '/admin/site', opens: 2, roles: ['admin'], widths: [375, 1280], languages: ['en'], why: ['error box shown', '500 GET /api/x'] }] }));
  const r = spawnSync(process.execPath, [path.join(here, 'ci-report.mjs'), f], { encoding: 'utf8', env: { ...process.env, RESEND_API_KEY: '', GITHUB_STEP_SUMMARY: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Railway did not deploy it/);
  assert.match(r.stdout, /\/admin\/site — the page shows “Something went wrong”; the server answered 500 \(a server error\) for \/api\/x\. Seen by the admin, on phones and computers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

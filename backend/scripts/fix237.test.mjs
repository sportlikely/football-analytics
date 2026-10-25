// fix237: the admin page's summary (tiles + Needs you counts) answers on an empty database, counts what waits, and the
// admin tab sub-paths are plain app pages (no 301 / search redirect from the slug rules). (dist build)
// Run: npm run test:fix237
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix237-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const { adminSummary } = require('../dist/services/adminSummary.js');

test('fix237: summary on an empty database is all zeros, never throws', () => {
  const s = adminSummary();
  for (const k of ['photosToReview', 'injuriesToReview', 'bbResultsToCheck', 'contactOpen', 'visitorsToday', 'accounts', 'siteErrorsOpen', 'failedSignIns24h']) assert.equal(s[k], 0, k);
  assert.ok(s.at);
});

test('fix237: Needs you counts what waits', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS player_photos (sport TEXT, player_id INTEGER, status TEXT);
    CREATE TABLE IF NOT EXISTS contact_messages (id INTEGER PRIMARY KEY, handled INTEGER);
    CREATE TABLE IF NOT EXISTS client_errors (sig TEXT, count INTEGER, last_at TEXT, resolved_at TEXT);`);
  db.exec(`INSERT INTO player_photos VALUES ('tennis', 1, 'review'), ('tennis', 2, 'ok'), ('basketball', 3, 'review');
    INSERT INTO contact_messages (handled) VALUES (0), (1);`);
  db.prepare(`INSERT INTO client_errors VALUES ('a', 4, ?, NULL), ('b', 2, ?, ?)`).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const s = adminSummary();
  assert.equal(s.photosToReview, 2);
  assert.equal(s.contactOpen, 1);
  assert.equal(s.siteErrorsOpen, 1);
  assert.equal(s.siteErrors24h, 4);
});

test('fix237: /admin/<tab> is not touched by the slug rules', () => {
  const { linkAnswer } = require('../dist/services/slugs.js');
  for (const p of ['/admin', '/admin/needs-you', '/admin/users', '/admin/models', '/admin/data', '/admin/site', '/admin/messages', '/admin/security']) {
    const a = linkAnswer(p, '');
    assert.ok(!a || !('to' in a || 'search' in a), `${p} → ${JSON.stringify(a)}`);
  }
});

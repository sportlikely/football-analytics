// fix202: page keys, plans → stored copies, live rows (services/pageCache.ts, built: npm run build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix202-'));
const require = createRequire(import.meta.url);
const pc = require('../dist/services/pageCache.js');

test('one key per page: query sorted, a token or odd query never stored', () => {
  assert.equal(pc.pageKey('/api/news', { sport: 'tennis', limit: '10' }), '/api/news?limit=10&sport=tennis');
  assert.equal(pc.keyOfUrl('/api/news?sport=tennis&limit=10'), '/api/news?limit=10&sport=tennis');
  assert.equal(pc.pageKey('/api/public/summary', {}), '/api/public/summary');
  assert.equal(pc.pageKey('/api/public/summary', { token: 'x' }), null);
  assert.equal(pc.pageKey('/api/news', { a: ['1', '2'] }), null);
});

test('rules: which plans share a copy', () => {
  const p = path => ['anon', 'free', 'premium', 'pro'].map(a => pc.ruleFor(path).persona(a)).join(',');
  assert.equal(p('/api/matches/upcoming'), 'anon,anon,anon,pro'); // Premium sees football in full only when unlocked
  assert.equal(p('/api/basketball/games'), 'anon,anon,premium,premium');
  assert.equal(p('/api/draw-alerts'), 'anon,free,free,pro');
  assert.equal(p('/api/public/summary'), 'anon,anon,anon,anon');
  assert.ok(pc.ruleFor('/es/basketball').html);
  assert.ok(pc.ruleFor('/').html);
  assert.equal(pc.ruleFor('/team/86'), null);
  assert.equal(pc.ruleFor('/api/matches/123'), null);
  for (const k of pc.PREBUILD) assert.ok(pc.ruleFor(k.split('?')[0]), `prebuilt page without a rule: ${k}`);
});

test('stored pages: one copy per plan, the oldest decides the age', () => {
  pc.writePage('/api/x', 'anon', { status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}', build: null }, 1000);
  pc.writePage('/api/x', 'pro', { status: 200, headers: {}, body: '{"a":2}', build: null }, 2000);
  assert.equal(pc.readPage('/api/x', 'pro').body, '{"a":2}');
  assert.deepEqual(pc.pageBuiltAt('/api/x'), { at: 1000, n: 2 });
  pc.writePage('/api/x', 'anon', { status: 404, headers: {}, body: 'no', build: null }, 3000);
  assert.equal(pc.readPage('/api/x', 'anon').status, 404);
  assert.equal(pc.prunePages(new Set(), 0), 1);
  assert.equal(pc.readPage('/api/x', 'pro'), null);
});

test('live rows: written when changed, in list order, gone when the game is not live', () => {
  const last = new Map();
  assert.deepEqual(pc.writeLive('football', [{ id: 5, s: '0-0' }, { id: 7, s: '1-0' }], last), [5, 7]);
  assert.deepEqual(pc.writeLive('football', [{ id: 5, s: '0-0' }, { id: 7, s: '1-0' }], last), []);
  assert.deepEqual(pc.writeLive('football', [{ id: 7, s: '2-0' }, { id: 5, s: '0-0' }], last), [7, 5]); // order moved too
  assert.deepEqual(pc.readLive('football').map(r => r.id), [7, 5]);
  assert.deepEqual(pc.readLive('football', [5]).map(r => JSON.parse(r.json)), [{ id: 5, s: '0-0' }]);
  pc.writeLive('football', [{ id: 5, s: '0-1' }], last);
  assert.deepEqual(pc.readLive('football').map(r => r.id), [5]);
  // a new worker (empty memory) removes rows of games that ended while it was down
  pc.writeLive('football', [], new Map());
  assert.deepEqual(pc.readLive('football'), []);
});

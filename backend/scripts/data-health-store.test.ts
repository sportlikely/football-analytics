// fix200: the data-health job writes the report, the endpoint reads the stored copy (src/utils/healthStore.ts).
// Run: npm run test:health
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHealthStore, NOT_YET, type StoredReport } from '../src/utils/healthStore.ts';

const report = (level: 'ok' | 'warn' | 'fail', at: string): StoredReport => ({
  level, at, checks: [{ id: 'unsettled', label: 'Finished games are scored in our record', level, detail: '0 game(s) · 6 voided this month' }]
});

test('nothing stored yet: the endpoint has nothing (it then shows NOT_YET)', () => {
  const s = createHealthStore(new DatabaseSync(':memory:'));
  assert.equal(s.read(), null);
  assert.equal(NOT_YET.checks[0].id, 'pending');
});

test('the job writes, the endpoint reads the same report with its time', () => {
  const s = createHealthStore(new DatabaseSync(':memory:'));
  const r = report('warn', '2026-10-23T10:05:00.000Z');
  s.save(r);
  assert.deepEqual(s.read(), r);
  const r2 = report('ok', '2026-10-23T10:10:00.000Z');
  s.save(r2);
  assert.equal(s.read()?.at, '2026-10-23T10:10:00.000Z', 'the newest run wins');
});

test('after a restart the stored copy is read from the database', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'health-')), 'h.sqlite');
  const a = new DatabaseSync(file);
  createHealthStore(a).save(report('fail', '2026-10-23T09:00:00.000Z'));
  a.close();
  const b = createHealthStore(new DatabaseSync(file)); // a new process: empty memory
  assert.equal(b.read()?.level, 'fail');
  assert.equal(b.read()?.at, '2026-10-23T09:00:00.000Z');
});

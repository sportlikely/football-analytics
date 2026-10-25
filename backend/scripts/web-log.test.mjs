// fix214: the web process does not write a log line per GET in production (a write to the log pipe is synchronous on
// Linux and blocked the loop for up to 2.7 s during crawler bursts); log writes are timed and named in a stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist').replace(/\\/g, '/');

test('production web process: GET requests are counted, not logged one line each', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix214-log-'));
  const r = spawnSync(process.execPath, ['-e', `
    const D = ${JSON.stringify(DIST)};
    const { app } = require(D + '/app.js');
    require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
    const s = app.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + s.address().port;
      for (let i = 0; i < 30; i++) await fetch(base + '/api/health?i=' + i).then(x => x.text());
      process.exit(0);
    });`], { env: { ...process.env, DATA_DIR: dir, SL_ROLE: 'web', NODE_ENV: 'production', LOG_LEVEL: 'info', GEO_OFF: '1', CANONICAL_HOST: '' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n').filter(l => l.includes('GET /api/health'));
  assert.deepEqual(lines, [], 'a log line per request');
});

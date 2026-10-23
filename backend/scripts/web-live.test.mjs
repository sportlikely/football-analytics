// fix202: live updates reach the visitors' sockets (web process) from the worker's live poll, and the web process
// keeps answering while the worker restarts. Against a local web.js (WEB, WORKER_PID_PORT as in web-worker.test.mjs);
// the socket client comes from the frontend's node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { io } = require('socket.io-client');
const WEB = process.env.WEB || 'http://localhost:3111';
const WORKER_PORT = process.env.WORKER_PORT || '3911';

test('the live list reaches a socket of the web process every live tick (20 s)', async () => {
  const s = io(WEB, { transports: ['websocket'] });
  const got = [];
  s.on('matches:live', m => got.push(m));
  await new Promise(r => setTimeout(r, 45000));
  s.close();
  console.log(`${got.length} live pushes in 45 s (${got.map(m => m.data.length).join(', ')} games)`);
  assert.ok(got.length >= 2);
  assert.ok(got.every(m => Array.isArray(m.data) && m.timestamp));
});

test('the worker dies: stored pages still answer at once, the rest waits for the new worker', async () => {
  const pidOf = () => {
    const out = execSync('netstat -ano').toString().split('\n').find(l => l.includes(`:${WORKER_PORT} `) && l.includes('LISTENING'));
    return out ? out.trim().split(/\s+/).pop() : null;
  };
  const pid = pidOf();
  assert.ok(pid, 'worker found');
  execSync(process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`);
  await new Promise(r => setTimeout(r, 200));
  let t0 = performance.now();
  const stored = await fetch(`${WEB}/api/public/summary`);
  const storedMs = performance.now() - t0;
  assert.equal(stored.status, 200);
  assert.ok(stored.headers.get('x-stored-age') != null);
  t0 = performance.now();
  const passed = await fetch(`${WEB}/api/basketball/config`);
  const passedMs = performance.now() - t0;
  console.log(`stored page ${storedMs.toFixed(0)} ms while the worker was down; a request for the worker waited ${passedMs.toFixed(0)} ms (restart)`);
  assert.equal(passed.status, 200);
  const health = await (await fetch(`${WEB}/api/health`)).json();
  assert.equal(health.worker.restarts >= 1, true);
  assert.notEqual(pidOf(), pid);
});

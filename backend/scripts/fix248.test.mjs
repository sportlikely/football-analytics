// fix248: the web process's rolling CPU profile — a stall over 300 ms gets the top functions by self-time in its
// window (file:line), /api/perf → web.diagStalls + cpuTop. (dist build) Run: npm run test:fix248
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');

test('a stall is profiled: the busy function is on top, with its file:line, and a dist function maps to its .ts line', () => {
  const code = `
    const { startCpuProfile, cpuProfileStatus, flushCpuProfile } = require('${DIST}/services/cpuProfile.js');
    const perf = require('${DIST}/services/perf.js');
    const { slugify } = require('${DIST}/utils/slugRules.js');
    startCpuProfile();
    function burnTheThread(ms) { const t = Date.now(); let x = 0; while (Date.now() - t < ms) x += Math.sqrt(x + 1); return x; }
    function slugLoop(ms) { const t = Date.now(); let n = 0; while (Date.now() - t < ms) n += slugify('Real Madrid Club de Fútbol ' + n).length; return n; }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    (async () => {
      for (let i = 0; i < 100 && !cpuProfileStatus().on; i++) await wait(50);
      await wait(1200);
      burnTheThread(900);
      await wait(1500);
      slugLoop(700);
      await wait(1000);
      flushCpuProfile();
      await wait(2500);
      const s = perf.perfSummary();
      console.log('RESULT ' + JSON.stringify({ on: cpuProfileStatus(), diag: s.diagStalls, top: s.cpuTop }));
      process.exit(0);
    })();`;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env: { ...process.env, LOG_LEVEL: 'error', CPU_PROFILE: '1' }, encoding: 'utf8', timeout: 60000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-2000)}`);
  const out = JSON.parse(line.slice(7));
  assert.equal(out.on.on, true, JSON.stringify(out.on));
  assert.ok(out.diag.length >= 2, `profiled stalls: ${JSON.stringify(out.diag)}`);
  const burn = out.diag.find(s => s.cpu.top[0]?.fn === "burnTheThread");
  assert.ok(burn, JSON.stringify(out.diag.map(s => s.ms)));
  assert.equal(burn.cpu.covered, true);
  assert.equal(burn.cpu.top[0].fn, 'burnTheThread', JSON.stringify(burn.cpu.top.slice(0, 3)));
  assert.ok(burn.cpu.top[0].ms > 350, `self-time ${burn.cpu.top[0].ms}`);
  assert.ok(burn.cpu.top.length <= 15);
  const slug = out.diag.find(s => s !== burn && s.ms >= 300);
  assert.ok(slug, JSON.stringify(out.diag.map(s => s.ms)));
  const fns = slug.cpu.top.map(f => `${f.fn} ${f.at}`);
  assert.ok(fns.some(f => /utils\/slugRules\.ts:\d+$/.test(f)), `no source-mapped slugRules.ts line: ${fns.join(' | ')}`);
  assert.ok(slug.cpu.top.slice(0, 5).some(f => (f.stack || []).some(s => s.startsWith('slugLoop'))), 'callers kept');
  assert.ok(out.top.some(f => f.fn === 'burnTheThread'), 'cpuTop sums the stalls');
});

// fix248c: the reader threads are a pool (PAGE_READERS, default 2): a slow read on one never holds a quick one queued
test('reader pool: a quick read is answered while a slow read runs on the other thread', () => {
  const code = `
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix248c-'));
    process.env.DATA_DIR = dir;
    const { readSql, pageReaderStatus } = require('${DIST}/services/pageReader.js');
    (async () => {
      const slowSql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT COUNT(*) AS n FROM c';
      await readSql('SELECT 1 AS one'); await readSql('SELECT 1 AS one'); // both threads up
      const t0 = Date.now();
      const slow = readSql(slowSql).then(() => Date.now() - t0);
      await new Promise(r => setTimeout(r, 20));
      const t1 = Date.now();
      const quick = await readSql('SELECT 2 AS two');
      const quickMs = Date.now() - t1;
      const slowMs = await slow;
      console.log('RESULT ' + JSON.stringify({ quick, quickMs, slowMs, st: pageReaderStatus() }));
      process.exit(0);
    })();`;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env: { ...process.env, LOG_LEVEL: 'error' }, encoding: 'utf8', timeout: 60000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-2000)}`);
  const out = JSON.parse(line.slice(7));
  assert.equal(out.quick.two, 2);
  assert.equal(out.st.size, 2);
  assert.equal(out.st.threads, 2);
  assert.ok(out.slowMs > 150, `the slow read should take a while (${out.slowMs} ms)`);
  assert.ok(out.quickMs < out.slowMs / 2, `quick read waited behind the slow one: ${out.quickMs} ms vs ${out.slowMs} ms`);
  assert.ok(out.st.slowest.length >= 1 && /RECURSIVE/.test(out.st.slowest[0].what), JSON.stringify(out.st.slowest));
});

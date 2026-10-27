// fix252: the two visitor crashes of 26–27 Oct — (1) "App did not load (fix227 loader): Cannot destructure property
// 'default' of 'undefined'" / "app file failed 3 times" after a deploy: the old build's files kept 48 h, served before
// and after the app is up, index.html never cached, the empty / default-less import treated as a failed load with one
// hard reload; (2) "Cannot read properties of null (reading 'split')" on the homes and lists: a list row's link is null
// for a past season's game (fix243) — no scorers line, never a crash. Also: a results list with no stored copy gets the
// warm copy, not "Loading". Run: npm run test:fix252
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planArchive, archiveBuild, archivedAsset, KEEP_MS } from '../src/services/assetArchive.ts';
import { scorersRoute } from '../../frontend/src/lib/scorers.ts';
import { moduleDefault, isChunkError } from '../../frontend/src/lib/chunkReload.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const H = 3600 * 1000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `fix252-${p}-`));
const build = (files: Record<string, string>) => {
  const dir = tmp('dist');
  fs.mkdirSync(path.join(dir, 'assets'));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'assets', n), t);
  fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" src="/assets/index-NEW.js"></script>');
  return dir;
};

/* ---------- (1) the old build's files ---------- */

test('a file that left the build is kept at least 24 h (48 h), then dropped', () => {
  const m0 = { files: {} };
  const a = planArchive(m0, { 'index-OLD.js': 10, 'App-OLD.js': 20 }, NOW);
  assert.deepEqual(a.drop, []);
  const b = planArchive(a.manifest, { 'index-NEW.js': 10, 'App-OLD.js': 20 }, NOW + H); // deploy: index-OLD leaves
  assert.equal(b.manifest.files['index-OLD.js'].gone, NOW + H);
  assert.equal(b.manifest.files['App-OLD.js'].gone, null, 'a file still in the build is never gone');
  const c = planArchive(b.manifest, { 'index-NEW.js': 10, 'App-OLD.js': 20 }, NOW + H + 24 * H); // restart a day later
  assert.deepEqual(c.drop, [], 'still there 24 h after the deploy');
  assert.equal(c.manifest.files['index-OLD.js'].gone, NOW + H, 'a restart does not move the time it left');
  const d = planArchive(c.manifest, { 'index-NEW.js': 10, 'App-OLD.js': 20 }, NOW + H + KEEP_MS + 1);
  assert.deepEqual(d.drop, ['index-OLD.js']);
  assert.ok(KEEP_MS >= 24 * H);
});

test('over the size cap the oldest gone files go first, never the running build', () => {
  const m = { files: { 'a.js': { size: 100, gone: NOW - 3 * H }, 'b.js': { size: 100, gone: NOW - 2 * H }, 'c.js': { size: 100, gone: NOW - H } } };
  const r = planArchive(m, { 'cur.js': 100 }, NOW, KEEP_MS, 250);
  assert.deepEqual(r.drop, ['a.js', 'b.js']);
  assert.ok(r.manifest.files['cur.js'] && r.manifest.files['c.js']);
});

test('archiveBuild copies the build, keeps the last one after a deploy, and archivedAsset refuses odd names', async () => {
  const arch = tmp('arch');
  const v1 = build({ 'index-OLD.js': 'old main', 'App-OLD.js': 'old app' });
  assert.deepEqual(await archiveBuild(v1, arch, NOW), { copied: 2, kept: 2, dropped: 0 });
  const v2 = build({ 'index-NEW.js': 'new main', 'App-NEW.js': 'new app' });
  const r = await archiveBuild(v2, arch, NOW + H);
  assert.equal(r?.copied, 2);
  assert.equal(r?.kept, 4);
  assert.equal(fs.readFileSync(archivedAsset('App-OLD.js', arch)!, 'utf8'), 'old app');
  for (const bad of ['../index.html', 'builds.json', '..', '.hidden', 'a/b.js', 'x.js.part', 'missing.js']) assert.equal(archivedAsset(bad, arch), null, bad);
  const r3 = await archiveBuild(v2, arch, NOW + H + KEEP_MS + 1);
  assert.equal(r3?.dropped, 2);
  assert.equal(archivedAsset('App-OLD.js', arch), null);
  assert.ok(archivedAsset('App-NEW.js', arch));
  assert.equal(await archiveBuild(tmp('empty'), arch, NOW), null, 'no build: nothing done, no throw');
});

test('the early server sends an older build\'s file (before the app is up), a real 404 otherwise, index.html no-cache', async () => {
  const dist = path.join(here, '../dist/services/earlyStatic.js');
  if (!fs.existsSync(dist)) return; // npm run test:fix252 runs tsc first
  const arch = tmp('arch2');
  const v1 = build({ 'App-OLD.js': 'old app' });
  await archiveBuild(v1, arch, NOW);
  process.env.ASSET_ARCHIVE_DIR = arch;
  process.env.STATIC_DIR = build({ 'App-NEW.js': 'new app' });
  const require = createRequire(import.meta.url);
  const { serveEarly } = require(dist);
  const ask = (url: string) => {
    const out: { status?: number; headers?: Record<string, any>; body?: string } = {};
    const res: any = { setHeader() {}, writeHead(s: number, h: any) { out.status = s; out.headers = h; }, end(b: any) { out.body = b == null ? '' : String(b); } };
    assert.equal(serveEarly({ method: 'GET', url } as any, res), true);
    return out;
  };
  const old = ask('/assets/App-OLD.js');
  assert.equal(old.status, 200);
  assert.equal(old.body, 'old app');
  assert.match(old.headers!['Content-Type'], /javascript/);
  assert.equal(ask('/assets/App-NEW.js').body, 'new app');
  assert.equal(ask('/assets/App-GONE.js').status, 404);
  const page = ask('/football/match/a-vs-b-2026-10-27');
  assert.equal(page.headers!['Cache-Control'], 'no-cache');
});

test('app.ts: the archive before the /assets 404, index.html no-cache, archive started at listen', () => {
  const app = read('src/app.ts');
  const i = app.indexOf('archivedAsset(req.path'), j = app.indexOf("app.use('/assets', (_req, res) => { res.status(404)");
  assert.ok(i > 0 && j > i, 'the archive must answer before the /assets 404');
  assert.match(app, /setHeaders: \(res, file\) => \{ if \(file\.endsWith\('\.html'\)\) res\.setHeader\('Cache-Control', 'no-cache'\)/);
  assert.match(read('src/index.ts'), /archiveBuild\(STATIC_DIR\)/);
});

test('an import that came back empty or without its default export is a failed load (one hard reload)', () => {
  const App = () => null;
  assert.equal(moduleDefault({ default: App }), App);
  for (const m of [undefined, null, {}, { default: undefined }] as any[]) {
    let err: unknown;
    try { moduleDefault(m); } catch (e) { err = e; }
    assert.ok(err && isChunkError(err), `moduleDefault(${JSON.stringify(m)}) must throw a chunk error`);
  }
  // the wordings from the reports count as a failed app-file load
  assert.ok(isChunkError(new TypeError("Cannot destructure property 'default' of 'undefined' as it is undefined.")));
  assert.ok(isChunkError(new TypeError("Cannot read properties of undefined (reading 'default')")));
  assert.ok(!isChunkError(new TypeError("Cannot read properties of null (reading 'split')")));
  const main = fs.readFileSync(path.join(here, '../../frontend/src/main.tsx'), 'utf8');
  assert.ok(!/then\(\(\{ default: App \}\)/.test(main), 'main.tsx destructures the import result again');
  assert.match(main, /moduleDefault\(m\)/);
  const html = fs.readFileSync(path.join(here, '../../frontend/index.html'), 'utf8');
  assert.match(html, /if \(hardReload\(\)\) return;/, 'the loader shows its card before trying one hard reload');
  const cr = fs.readFileSync(path.join(here, '../../frontend/src/lib/chunkReload.ts'), 'utf8');
  assert.ok(html.includes("HARD = 'sl-hard-reload'") && cr.includes("HARD_KEY = 'sl-hard-reload'"), 'the loader and the app share the once-per-build key');
});

/* ---------- (2) the null link ---------- */

test('a list row with a null link has no scorers line and never throws', () => {
  for (const v of [null, undefined, ''] as any[]) assert.equal(scorersRoute(v), null);
  assert.deepEqual(scorersRoute('/match/12'), { sport: 'football', id: '12' });
  assert.deepEqual(scorersRoute('/fr/basketball/match/a-vs-b-2026-10-27', () => 77), { sport: 'basketball', id: '77' });
  const rs = fs.readFileSync(path.join(here, '../../frontend/src/components/sport/RowScorers.tsx'), 'utf8');
  assert.ok(!/href\.split\(/.test(rs));
});

/* ---------- the results list after a deploy ---------- */

test('/api/public/results without a stored copy gets the warm copy (X-SL-Copy: nearest), the Matches page asks the warm query', () => {
  const app = read('src/app.ts');
  assert.match(app, /name: 'results', freshMs: 5 \* 60 \* 1000, warm: \[\{ days: 30, limit: 50 \}\],\s*\/\/[^\n]*\n\s*fallback: q => \(q\.competition \? null : \{ days: 30, limit: 50 \}\)/);
  const i = app.indexOf('const fb = fallbackQuery(name, q)'), j = app.indexOf('if (!s) { noteLoading(req.path);');
  assert.ok(i > 0 && j > i, 'sendStored tries the stand-in copy before "Loading"');
  const fb = fs.readFileSync(path.join(here, '../../frontend/src/components/sport/games/football.tsx'), 'utf8');
  assert.match(fb, /public\/results`, \{ params: \{ days: 30, limit: 50 \} \}/);
});

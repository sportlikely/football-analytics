// fix252c: after `vite build` — one React on the page, ever ("Cannot read properties of null (reading 'useState')", 27 Oct:
// the loader's retry ran index-<hash>.js?r= next to the index-<hash>.js the page files import, two copies of React).
//   1. React's internals (the hook dispatcher) are in exactly one chunk, the vendor chunk (vite.config.ts manualChunks),
//      not in the entry;
//   2. every file a chunk imports is in the same build (a page from build A never imports a file of build B);
//   3. the built loader never loads the app file under a second address (?r= or any query).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const dir = path.join(dist, 'assets');
const bad = [];
const js = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const entry = (/<script type="module"[^>]*src="\/assets\/([^"?]+)"/.exec(html) || [])[1];
if (!entry) bad.push('no app file in dist/index.html');

const withReact = js.filter(f => fs.readFileSync(path.join(dir, f), 'utf8').includes('ReactCurrentDispatcher'));
if (withReact.length !== 1) bad.push(`React's dispatcher in ${withReact.length} chunks (${withReact.join(', ')}), want exactly 1`);
if (withReact.includes(entry)) bad.push(`React is in the entry ${entry}: it must be in the vendor chunk`);

for (const f of js) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.\/[^"']+)["']/g)) {
    const name = m[1].slice(2);
    if (name.includes('?')) bad.push(`${f} imports ${m[1]} (a query makes a second copy of the module)`);
    else if (!fs.existsSync(path.join(dir, name))) bad.push(`${f} imports ${m[1]}, not in this build`);
  }
}
if (/\?r='|\.src\s*=\s*[^;]*split\('\?'\)\[0\]\s*\+\s*'\?/.test(html)) bad.push('the loader loads the app file under a second address (?r=)');

if (bad.length) { console.error(`chunks-check (fix252c): FAIL\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`chunks-check (fix252c): ok — React in one chunk (${withReact[0]}), ${js.length} chunks, every import in this build, the loader reloads instead of a second app file`);

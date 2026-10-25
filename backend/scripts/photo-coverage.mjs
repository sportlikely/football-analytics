// fix221 diagnostic: basketball photo coverage per league on a database copy, against live Wikidata (answers cached).
// Run (after tsc): node scripts/photo-coverage.mjs <copy.sqlite> [players per league, default all] [cache.json]
// Builds the players exactly as the photo job does (basketballQueue: roster + box scores + balldontlie), takes the NBA
// and EuroLeague ones, and prints per league how many the matcher takes (high / review / none) with the reasons.
// The cache file keeps every Wikimedia answer, so a second run (a rule change) makes no call; it is also the recording
// scripts/photo-matcher.test.mjs replays (fixtures/wikidata-bb-coverage.json, trimmed to what the matcher reads).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
const [, , copy, perLeague, cacheFile = path.join(os.tmpdir(), 'photo-coverage-cache.json')] = process.argv;
if (!copy) { console.error('usage: node scripts/photo-coverage.mjs <copy.sqlite> [n] [cache.json]'); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-coverage-'));
fs.copyFileSync(copy, path.join(dir, 'bet-to-beat.sqlite'));
Object.assign(process.env, { DATA_DIR: dir, NODE_ENV: 'production', LOG_LEVEL: 'warn', PHOTO_GAP_MS: '200', SL_ROLE: 'worker' });
const require = createRequire(import.meta.url);
const ph = require('../dist/services/playerPhotos.js');
const UA = 'SportLikelyBot/1.0 (https://sportlikely.com; support@sportlikely.com) photo coverage check';
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
let calls = 0;
const used = new Set();
const KEEP = ['P31', 'P641', 'P106', 'P569', 'P27', 'P54', 'P18', 'P536', 'P597', 'P297', 'P298', 'P984', 'P118', 'P69', 'P647'];
const LANGS = ['en', 'mul', 'es', 'fr', 'de', 'it', 'pt', 'hr', 'sr', 'cs', 'pl', 'ru'];
const pick = (o, ks) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => ks.includes(k)));
function trim(j) {
  if (!j?.entities) return j;
  for (const e of Object.values(j.entities)) {
    if (e.labels) e.labels = pick(e.labels, LANGS);
    if (e.aliases) e.aliases = pick(e.aliases, LANGS);
    if (e.claims) e.claims = Object.fromEntries(Object.entries(pick(e.claims, KEEP)).map(([k, v]) => [k, v.map(c => ({ mainsnak: { datavalue: c.mainsnak?.datavalue } }))]));
    for (const k of Object.keys(e)) if (!['id', 'labels', 'aliases', 'claims'].includes(k)) delete e[k];
  }
  return j;
}
ph.__test.setFetcher(async url => {
  used.add(url);
  if (!(url in cache)) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
    cache[url] = trim(await r.json()); calls++;
    if (calls % 50 === 0) fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return { ok: true, status: 200, json: async () => structuredClone(cache[url]), arrayBuffer: async () => new ArrayBuffer(0) };
});
const NOW = Date.now();
const all = ph.__test.basketballQueue();
const byLeague = { NBA: all.filter(x => x.prio <= -1.9e6), EL: all.filter(x => x.prio > -1.9e6 && x.prio <= -0.9e6) };
const players = {};
for (const [lg, list] of Object.entries(byLeague)) {
  const named = list.filter(x => !ph.abbreviated(x.name)).sort((a, b) => a.id - b.id);
  players[lg] = perLeague ? named.filter((_, i) => i % Math.max(1, Math.floor(named.length / Number(perLeague))) === 0).slice(0, Number(perLeague)) : named;
  console.log(`${lg}: ${list.length} players, ${named.length} with a full name, checking ${players[lg].length}`);
}
const out = {};
for (const [lg, list] of Object.entries(players)) {
  const reasons = {}; let high = 0, low = 0;
  for (const p of list) {
    const d = ph.decide(p, await ph.__test.candidatesFor('basketball', p.name), NOW);
    if (d.confidence === 'high') high++; else if (d.confidence === 'low') low++;
    const r = d.confidence ? d.confidence : d.reason.replace(/\(Q[^)]*\)/, '').replace(/Q\d+/g, 'Q');
    reasons[r] = (reasons[r] || 0) + 1;
    if (process.env.VERBOSE && (d.confidence !== 'high' || (process.env.VERBOSE === '2' && !/team/.test(d.reason)))) console.log(`  ${lg} ${d.confidence || '-'}\t${p.name}\t${d.qid || ''}\t${d.reason}\tteams ${JSON.stringify(p.teams)} age ${p.age} ${p.country} ${p.college || ''}`);
  }
  out[lg] = { n: list.length, high, review: low, highPct: Math.round(1000 * high / Math.max(1, list.length)) / 10, reasons };
}
fs.writeFileSync(cacheFile, JSON.stringify(cache));
console.log(JSON.stringify(out, null, 1));
// FIXTURE=<file>: the players and the answers they used, for scripts/photo-matcher.test.mjs
if (process.env.FIXTURE) {
  const strip = ({ name, age, country, teams, leagues, college }) => ({ name, age, country, teams, leagues, college });
  fs.writeFileSync(process.env.FIXTURE, JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), note: 'fix221: NBA / EuroLeague players of a database copy (photo-coverage.mjs FIXTURE=…), live Wikidata answers trimmed to what the matcher reads', now: NOW, results: out,
    players: Object.fromEntries(Object.entries(players).map(([lg, l]) => [lg, l.map(strip)])), responses: Object.fromEntries([...used].filter(u => u in cache).map(u => [u, cache[u]])) }));
}
console.log(`Wikimedia calls this run: ${calls} (cache ${cacheFile})`);

// fix214 diagnostic: run the basketball matcher on known NBA players against live Wikidata, log each step.
// Optional: RECORD=<file> writes every Wikimedia JSON answer (for the recorded test).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-diag-'));
process.env.NODE_ENV = 'production'; process.env.LOG_LEVEL = 'warn'; process.env.PHOTO_GAP_MS = '250';
const require = createRequire(import.meta.url);
const ph = require('../dist/services/playerPhotos.js');
const UA = 'SportLikelyBot/1.0 (https://sportlikely.com; support@sportlikely.com) photo diagnostic';
const rec = {};
// keep only what the matcher reads (labels, aliases, the claims below), so the recording stays small
const KEEP = ['P31', 'P641', 'P106', 'P569', 'P27', 'P54', 'P18', 'P536', 'P597', 'P297', 'P298', 'P984'];
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
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const body = await r.text();
  if (process.env.VERBOSE) console.log('   GET', decodeURIComponent(url).slice(0, 220));
  rec[url] = trim(JSON.parse(body));
  return { ok: r.ok, status: r.status, json: async () => JSON.parse(body), arrayBuffer: async () => new ArrayBuffer(0) };
});
const players = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let hit = 0;
for (const p of players) {
  const c = await ph.__test.candidatesFor('basketball', p.name);
  const d = ph.decide({ sport: 'basketball', ...p }, c);
  if (d.confidence === 'high') hit++;
  console.log(`${d.confidence || '-'}\t${p.name}\t${d.qid || ''}\t${d.reason}\t| cands: ${c.map(x => `${x.qid}[${x.names.slice(0,2).join('/')}; dob ${x.dob}; ${x.sports.join(',')}; teams ${x.teams.length}]`).join(' ')}`);
}
console.log(`high: ${hit} of ${players.length}`);
if (process.env.RECORD) fs.writeFileSync(process.env.RECORD, JSON.stringify(rec));

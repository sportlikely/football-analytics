// fix182: logged-out leak test. Calls the public API as a signed-out visitor and fails when any match / game that is
// not finished carries anything of its prediction beyond { model, locked } (no pick, dc, confidence, percentages,
// draw / upset flags), or when a locked prediction carries more than that.
// Usage: npm run test:locked [-- https://sportlikely.com]   (default http://localhost:3001)
const base = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const DONE = /^(FINISHED|AWARDED|FT|AET|PEN|AOT|AP|done)$/;
const ALLOWED_LOCKED = new Set(['model', 'locked']);

const get = async p => {
  const r = await fetch(base + p, { headers: { 'User-Agent': 'SportLikely-leak-test' } });
  if (!r.ok) return { status: r.status, body: null };
  try { return { status: r.status, body: await r.json() }; } catch { return { status: r.status, body: null }; }
};

/** Every prediction object in a payload with the match / game that owns it. */
function check(path, body) {
  const bad = [];
  const walk = (v, where, owner) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`, owner));
    const own = 'status' in v || 'state' in v ? v : owner;
    for (const [k, x] of Object.entries(v)) {
      const preds = k === 'prediction' && x && typeof x === 'object' ? [x] : k === 'predictions' && Array.isArray(x) ? x.filter(p => p && typeof p === 'object') : [];
      for (const p of preds) {
        const st = String(own?.status ?? own?.state ?? '');
        const extra = Object.keys(p).filter(q => !ALLOWED_LOCKED.has(q));
        if (p.locked && extra.length) bad.push(`${where}.${k} locked but has ${extra.join(',')}`);
        else if (!p.locked && !DONE.test(st) && extra.length) bad.push(`${where}.${k} [${st}] unlocked for a signed-out visitor`);
      }
      walk(x, `${where}.${k}`, own);
    }
  };
  walk(body, '', null);
  return bad;
}

const paths = ['/api/matches/upcoming', '/api/today', '/api/today?sport=basketball', '/api/hub', '/api/search?q=real', '/api/basketball/games', '/api/nfl/games', '/api/nfl/home'];
const up = (await get('/api/matches/upcoming')).body?.data || [];
const next = up.find(m => !DONE.test(m.status));
if (next) paths.push(`/api/matches/${next.id}`, `/api/matches/${next.id}/details`, `/api/team-page/${next.homeTeam.id}`);
for (const h of ((await get('/api/hub')).body?.data || []).slice(0, 3)) paths.push(`/api/hub/${h.slug}`);
const bb = ((await get('/api/basketball/games')).body?.data || []).find(g => g.state === 'upcoming');
if (bb) paths.push(`/api/basketball/game/${bb.id}`, `/api/basketball/team/${bb.home.id}`);

let fails = 0;
for (const p of paths) {
  const { status, body } = await get(p);
  const bad = body ? check(p, body) : [];
  fails += bad.length;
  console.log(`${bad.length ? 'FAIL' : status === 200 ? 'ok  ' : 'skip'} ${status} ${p}${bad.length ? `\n     ${bad.slice(0, 5).join('\n     ')}${bad.length > 5 ? `\n     … ${bad.length - 5} more` : ''}` : ''}`);
}
console.log(fails ? `\n${fails} leak(s)` : '\nno leaks');
process.exit(fails ? 1 : 0);

/**
 * Clean-links check (fix229) — part of `npm run parity`.
 *
 * Every public page is /<lang?>/<sport>/<kind>/<slug> (docs/notes/links.md). Fails when
 *  1. a link in the app (a string or template literal starting with "/") points at an item page by id: /team/${id},
 *     /match/123, /basketball/game/…, /american-football/team/…, /tennis/tournament/…, /league/PL … (links come from
 *     lib/links.ts: teamHref / playerHref / leagueHref / matchHref);
 *  2. a link carries a query parameter that is not in ALLOWED_QUERY (lib/slugRules.ts, the one list);
 *  3. a page route of App.tsx takes an id (:id / :code / :key) and is not an OldLink (the old addresses only move on);
 *  4. a sport has no /<sport>/<kind>/:slug route for each of its kinds (tennis: player, league, match);
 *  5. the two copies of the slug rules (backend/src/utils/slugRules.ts, frontend/src/lib/slugRules.ts) differ;
 *  6. (fix235) an app link carries "#…" (tabs are sub-paths: …/match/<slug>/stats; in-page anchors only on guide pages),
 *     or a sport page is at the root / under an old name (/matches, /predictions/today, /basketball/games: movedPage).
 * Reads the code without running it (TypeScript syntax tree).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { ALLOWED_QUERY, LINK_SPORTS, LINK_KINDS, movedPage } from '../src/lib/slugRules.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')
const BACK = path.resolve(here, '../../backend/src')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !/\.report\.ts$/.test(e.name)) out.push(p)
  }
  return out
}
const rel = (f: string) => path.relative(path.resolve(here, '../..'), f)
const problems: string[] = []

// files allowed to name old addresses: the slug rules, the link helpers, the page that moves old links on
const EXEMPT = new Set(['lib/slugRules.ts', 'lib/links.ts', 'components/SlugRoute.tsx'])
/** an item page by id (old address) */
const OLD_ITEM = /^\/(?:(?:basketball|american-football|tennis|football)\/)?(?:team|match|player|league|game|tournament)\/(?:\$\{|\d|[A-Z])|^\/(?:basketball|american-football|tennis)\/(?:game|tournament)\/|^\/american-football(?:\/college)?\/league$|^\/tennis\/predictions\/\$\{/
/** `${base}/team/${id}`, `${nflBase(l)}/league` … (a sport's base path, then an item by id) */
const OLD_AFTER_BASE = /^\$\{x\}\/(?:team|match|player|league|game|tournament|predictions)\/\$\{|^\$\{x\}\/league$/
const PUBLIC_START = /^\/(?!api\/|assets\/|media\/|fonts\/|socket\.io)/
const allowed = new Set<string>(ALLOWED_QUERY as readonly string[])
/** fix235: the only files whose links may carry an in-page "#…" anchor (guide pages) */
const ANCHOR_OK = new Set(['pages/Guide.tsx'])

for (const file of walk(SRC)) {
  const r = path.relative(SRC, file).replace(/\\/g, '/')
  if (EXEMPT.has(r)) continue
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const textOf = (n: ts.Node): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    // a template whose first part is a sport's base path variable (`${base}/team/${id}`) keeps that marker; others don't
    if (ts.isTemplateExpression(n)) return (n.head.text === '' && !/base/i.test(n.templateSpans[0].expression.getText(sf)) ? '${v}' : '') + n.head.text + n.templateSpans.map((s, i) => (i === 0 && n.head.text === '' && !/base/i.test(s.expression.getText(sf)) ? '' : '${x}') + s.literal.text).join('')
    return null
  }
  const visit = (n: ts.Node) => {
    // route definitions are checked below (3)
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === 'path') return
    const t = textOf(n)
    // `${matchHref(…)}#prediction`: a link helper's address with a hash after it
    if (t != null && /^\$\{[vx]\}#[a-zA-Z]/.test(t) && !ANCHOR_OK.has(r)) problems.push(`${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} — "#…" after a link: "${t.slice(0, 70)}" (a tab is a sub-path: …/match/<slug>/stats)`)
    if (t != null && (PUBLIC_START.test(t) || OLD_AFTER_BASE.test(t))) {
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
      if (OLD_ITEM.test(t) || OLD_AFTER_BASE.test(t)) problems.push(`${rel(file)}:${line} — an item link by id: "${t.slice(0, 70)}" (use teamHref / playerHref / leagueHref / matchHref, lib/links.ts)`)
      // 6 (fix235): no "#…" in an app link (tabs and sections are sub-paths), no sport page at an old address
      if (/#[a-zA-Z]/.test(t) && !ANCHOR_OK.has(r)) problems.push(`${rel(file)}:${line} — "#…" in a link: "${t.slice(0, 70)}" (a tab is a sub-path: …/match/<slug>/stats, lib/tabPath.ts)`)
      const p0 = t.split(/[?#]/)[0]
      if (!p0.includes('${') && movedPage(p0)) problems.push(`${rel(file)}:${line} — an old page address "${p0}" (now ${movedPage(p0)}: every sport page is /<sport>/<page>)`)
      const q = t.indexOf('?')
      if (q >= 0 && !/^\/\$\{/.test(t)) {
        for (const m of t.slice(q + 1).matchAll(/(?:^|&)([a-zA-Z_]+)=/g))
          if (!allowed.has(m[1])) problems.push(`${rel(file)}:${line} — query parameter "${m[1]}" in a public link: "${t.slice(0, 70)}" (allowed: ALLOWED_QUERY in lib/slugRules.ts)`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

// 3 + 4: the routes of App.tsx
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8')
const routes: { path: string; element: string; base: string }[] = []
let base = ''
for (const line of app.split('\n')) {
  const fn = /^function (\w+)Routes\(\)/.exec(line)
  if (fn) base = { Tennis: '/tennis', Nfl: '/american-football', Bb: '/basketball' }[fn[1]] || ''
  const m = /<Route path="([^"]+)" element=\{(.+)\}\s*\/>/.exec(line)
  if (m) routes.push({ path: m[1].startsWith('/') ? m[1] : `${base}/${m[1]}`, element: m[2], base })
}
for (const r of routes) {
  if (/:(id|code|key)\b/.test(r.path) && !/^<OldLink\b/.test(r.element) && r.path !== '/join/:code') problems.push(`frontend/src/App.tsx — route ${r.path} takes an id: item pages are /<sport>/<kind>/:slug (old addresses: <OldLink …/>)`)
}
for (const sport of LINK_SPORTS) for (const kind of LINK_KINDS) {
  if (sport === 'tennis' && kind === 'team') continue
  if (!routes.some(r => (r.path === `/${sport}/${kind}/:slug` || ((kind === 'match' || kind === 'league') && r.path === `/${sport}/${kind}/:slug/*`)) && new RegExp(`<SlugRoute sport="${sport}" kind="${kind}"`).test(r.element)))
    problems.push(`frontend/src/App.tsx — ${sport}: no /${sport}/${kind}/:slug route (every sport has its slug pages)`)
}
// 6 (fix235): a match page takes its tab as a sub-path (…/match/:slug/*); every sport has /<sport>/matches and /today
for (const sport of LINK_SPORTS) {
  if (!routes.some(r => r.path === `/${sport}/match/:slug/*`)) problems.push(`frontend/src/App.tsx — ${sport}: the match route must be /${sport}/match/:slug/* (tabs are sub-paths)`)
  for (const page of ['matches', 'today']) if (!routes.some(r => r.path === `/${sport}/${page}`)) problems.push(`frontend/src/App.tsx — ${sport}: no /${sport}/${page} route (same page names in every sport)`)
}
// the server: one parser for the new addresses of every sport (services/slugs.ts parseNew, LINK_SPORTS)
const slugsTs = fs.readFileSync(path.join(BACK, 'services/slugs.ts'), 'utf8')
if (!/export function parseNew/.test(slugsTs) || !/LINK_SPORTS/.test(slugsTs)) problems.push('backend/src/services/slugs.ts — parseNew over LINK_SPORTS is missing')

// 5: the two rule files
const a = fs.readFileSync(path.join(BACK, 'utils/slugRules.ts'), 'utf8'), b = fs.readFileSync(path.join(SRC, 'lib/slugRules.ts'), 'utf8')
if (a !== b) problems.push('backend/src/utils/slugRules.ts and frontend/src/lib/slugRules.ts differ (copy one onto the other)')

if (problems.length) {
  console.error(`links-check: ${problems.length} problem(s) — public links are /<sport>/<kind>/<slug>, no ids or query strings (fix229)`)
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}
console.log(`links-check: every item link is a slug link; ${routes.filter(r => /:slug/.test(r.path)).length} slug routes over ${LINK_SPORTS.length} sports; query parameters limited to ${ALLOWED_QUERY.length}`)

/**
 * Web-compute check (fix210) — part of `npm run parity`.
 *
 * The web process never builds a page: every public GET route of backend/src/app.ts is listed in PUBLIC_ROUTES
 * (backend/src/services/workerRoutes.ts) as answered by the worker, a stored page, or a small web read. Fails when
 *  1. a public route of app.ts (under OPEN_API) is not in PUBLIC_ROUTES, or PUBLIC_ROUTES lists one app.ts doesn't have,
 *  2. a 'worker' route's sample URL is not matched by WORKER_ROUTES (the web process would run it), or a 'stored' /
 *     'web' route's sample is (the list says something else than what happens),
 *  3. a sport (football, basketball, American football, tennis) has no game, team or player page on the worker.
 * Reads the code without running it (TypeScript syntax tree). scripts/no-web-compute.test.mjs (backend) then opens
 * every sample in a real web process and fails when a page builder runs or a handler takes over 50 ms.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const BACK = path.resolve(here, '../../backend/src')
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const app = parse(path.join(BACK, 'app.ts'))
const routesFile = parse(path.join(BACK, 'services/workerRoutes.ts'))

// OPEN_API (the public API) and every app.get path
let openApi: RegExp | null = null
const appPaths: string[] = []
const visit = (n: ts.Node) => {
  if (ts.isVariableDeclaration(n) && (n.name as ts.Identifier).text === 'OPEN_API' && n.initializer && ts.isRegularExpressionLiteral(n.initializer)) {
    const t = n.initializer.text
    openApi = new RegExp(t.slice(1, t.lastIndexOf('/')), t.slice(t.lastIndexOf('/') + 1))
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'get'
      && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'app') {
    const a = n.arguments[0]
    if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text.startsWith('/api/')) appPaths.push(a.text)
  }
  ts.forEachChild(n, visit)
}
visit(app)
if (!openApi) { console.error('web-routes-check: OPEN_API not found in app.ts'); process.exit(1) }
// a route path → a URL it answers (:id(\d+) → 1, :sport(a|b) → a, :x → x)
const sampleOf = (p: string) => p.replace(/:([a-z]+)\(([^)]*)\)/gi, (_m, _n, r: string) => (r.includes('|') ? r.split('|')[0] : '1')).replace(/:[a-z]+/gi, 'x')
const publicPaths = appPaths.filter(p => openApi!.test(sampleOf(p)))

// PUBLIC_ROUTES and WORKER_ROUTES
const literal = (n: ts.Expression): any => {
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) return literal(n.expression)
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isRegularExpressionLiteral(n)) { const t = n.text; return new RegExp(t.slice(1, t.lastIndexOf('/')), t.slice(t.lastIndexOf('/') + 1)) }
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(e => literal(e as ts.Expression))
  if (ts.isObjectLiteralExpression(n)) {
    const o: any = {}
    for (const p of n.properties) if (ts.isPropertyAssignment(p)) o[(p.name as ts.Identifier).text] = literal(p.initializer)
    return o
  }
  return undefined
}
type Entry = { path: string; sport: string; by: string; sample: string; kind?: string }
let listed: Entry[] = [], workerRes: RegExp[] = []
routesFile.forEachChild(n => {
  if (!ts.isVariableStatement(n)) return
  for (const d of n.declarationList.declarations) {
    const name = (d.name as ts.Identifier).text
    if (name === 'PUBLIC_ROUTES' && d.initializer) listed = literal(d.initializer)
    if (name === 'WORKER_ROUTES' && d.initializer) workerRes = (literal(d.initializer) as { re: RegExp }[]).map(r => r.re)
  }
})

const problems: string[] = []
const byPath = new Map(listed.map(e => [e.path, e]))
for (const p of publicPaths) if (!byPath.has(p)) problems.push(`not listed in PUBLIC_ROUTES: ${p} (worker, stored or web?)`)
for (const e of listed) {
  if (!appPaths.includes(e.path)) problems.push(`PUBLIC_ROUTES lists a route app.ts doesn't have: ${e.path}`)
  const onWorker = workerRes.some(re => re.test(e.sample.split('?')[0]))
  if (e.by === 'worker' && !onWorker) problems.push(`'worker' route not in WORKER_ROUTES (the web process would build it): ${e.sample}`)
  if (e.by !== 'worker' && onWorker) problems.push(`'${e.by}' route matched by WORKER_ROUTES: ${e.sample}`)
}
for (const sport of ['football', 'basketball', 'nfl', 'tennis'])
  for (const kind of ['game', 'team', 'player'])
    if (!listed.some(e => e.sport === sport && e.kind === kind && e.by === 'worker')) problems.push(`${sport}: no ${kind} page answered by the worker`)

if (problems.length) {
  console.error(`web-routes-check: ${problems.length} problem(s) — the web process must never build a page (fix210)`)
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}
const count = (by: string) => listed.filter(e => e.by === by).length
console.log(`web-routes-check: ${publicPaths.length} public routes — ${count('worker')} on the worker, ${count('stored')} stored, ${count('web')} small web reads; game / team / player pages of every sport on the worker`)

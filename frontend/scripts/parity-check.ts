/**
 * Sport parity check (fix175) — `npm run parity` (also part of `npm run type-check` and `npm run build`).
 *
 * Football is the template: every feature block in src/lib/sportParity.ts must be fed by every sport, or carry an
 * 'na: <reason>' that Yarin approved (docs/notes/sport-parity.md). Fails with a "feature · missing in" table when
 *  1. a sport claims a key (true) but none of its *.parity.ts files lists it (or football doesn't provide it),
 *  2. a sport lists a key that the table marks 'na' (the table is out of date),
 *  3. a *.parity.ts file lists a key that doesn't exist,
 *  4. a shared component in components/sport/** or components/SportHome/** gets a prop from football that neither
 *     basketball nor NFL passes (unless FOOTBALL_ONLY_PROPS names it with a reason).
 * Reads the code without running it (TypeScript syntax tree). Writes src/lib/sportParity.report.ts for the admin card.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { PARITY, PARITY_SPORTS, FOOTBALL_ONLY_PROPS, type ParitySport } from '../src/lib/sportParity.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FRONT = path.resolve(here, '..')
const SRC = path.join(FRONT, 'src')
const BACK_SRC = path.resolve(FRONT, '../backend/src')

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const rel = (f: string) => path.relative(path.resolve(FRONT, '..'), f)

/* ---------- 1. what each sport provides (*.parity.ts: export const PARITY_PROVIDES = { sport, keys } | [...]) ---------- */

interface Provided { sport: string; keys: string[]; file: string }
const provided: Provided[] = []
const problems: string[] = []
const literal = (n: ts.Expression): any => {
  if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n)) return literal(n.expression)
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(e => literal(e as ts.Expression))
  if (ts.isObjectLiteralExpression(n)) {
    const o: any = {}
    for (const p of n.properties) if (ts.isPropertyAssignment(p)) o[(p.name as ts.Identifier).text ?? (p.name as any).text] = literal(p.initializer)
    return o
  }
  return undefined
}
const parityFiles = [...walk(SRC), ...walk(BACK_SRC)].filter(f => /\.parity\.ts$/.test(f))
for (const file of parityFiles) {
  const sf = parse(file)
  let found = false
  sf.forEachChild(n => {
    if (!ts.isVariableStatement(n) || !n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return
    for (const d of n.declarationList.declarations) {
      if ((d.name as ts.Identifier).text !== 'PARITY_PROVIDES' || !d.initializer) continue
      found = true
      const v = literal(d.initializer)
      for (const x of Array.isArray(v) ? v : [v]) {
        if (!x || typeof x.sport !== 'string' || !Array.isArray(x.keys)) { problems.push(`${rel(file)}: PARITY_PROVIDES must be { sport, keys: [...] } with string literals only`); continue }
        provided.push({ sport: x.sport, keys: x.keys, file: rel(file) })
      }
    }
  })
  if (!found) problems.push(`${rel(file)}: no exported PARITY_PROVIDES`)
}

const known = new Set<string>(PARITY.map(p => p.key))
const by = new Map<string, Set<string>>(PARITY_SPORTS.map(s => [s, new Set<string>()]))
for (const p of provided) {
  if (!by.has(p.sport)) { problems.push(`${p.file}: unknown sport "${p.sport}"`); continue }
  for (const k of p.keys) {
    if (!known.has(k)) problems.push(`${p.file}: unknown parity key "${k}" (add it to src/lib/sportParity.ts)`)
    by.get(p.sport)!.add(k)
  }
}

/* ---------- 2. the table: every key fed by every sport, or an 'na' reason ---------- */

interface Gap { key: string; label: string; missing: ParitySport[]; note?: string }
const gaps: Gap[] = []
const todo: { key: string; label: string; sport: ParitySport; reason: string }[] = []
for (const e of PARITY) {
  const missing: ParitySport[] = []
  const notes: string[] = []
  for (const s of PARITY_SPORTS) {
    const claim = (e as any)[s] as true | string
    const has = by.get(s)!.has(e.key)
    if (claim === true) { if (!has) missing.push(s); continue }
    const m = /^(na|todo): (.{5,})$/.exec(String(claim))
    if (!m) { missing.push(s); notes.push(`${s}: write true, 'na: <reason>' or 'todo: <reason>'`); continue }
    if (has) notes.push(`${s} provides it now: change '${m[1]}' to true`)
    else if (m[1] === 'todo') todo.push({ key: e.key, label: e.label, sport: s, reason: m[2] })
  }
  if (missing.length || notes.length) gaps.push({ key: e.key, label: e.label, missing, note: notes.join('; ') || undefined })
}

/* ---------- 3. props of shared components: football passes it, nobody else does ---------- */

const sportOfFile = (f: string): ParitySport | null => {
  const r = path.relative(SRC, f).replace(/\\/g, '/')
  if (r.startsWith('components/sport/') || r.startsWith('components/SportHome/')) {
    const base = path.basename(r).replace(/\.(parity\.)?tsx?$/, '')
    return base === 'football' ? 'football' : base === 'basketball' ? 'basketball' : base === 'nfl' ? 'nfl' : null
  }
  if (r.startsWith('pages/bb/')) return 'basketball'
  if (r.startsWith('pages/nfl/')) return 'nfl'
  if (/^pages\/[^/]+\.tsx$/.test(r)) return 'football'
  return null
}
// shared components = exported components of components/sport/** and components/SportHome/** (not a sport's adapter)
const sharedDirs = [path.join(SRC, 'components/sport'), path.join(SRC, 'components/SportHome')]
const shared = new Map<string, { named: Set<string>; dflt: string | null }>() // file (no extension) → exports
for (const f of sharedDirs.flatMap(d => walk(d))) {
  if (sportOfFile(f)) continue
  const sf = parse(f)
  const named = new Set<string>()
  let dflt: string | null = null
  sf.forEachChild(n => {
    const mods = (n as any).modifiers as ts.NodeArray<ts.Modifier> | undefined
    if (!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return
    const isDefault = mods.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
    if (ts.isFunctionDeclaration(n)) {
      const name = n.name?.text || path.basename(path.dirname(f)) + '/' + path.basename(f)
      if (isDefault) dflt = n.name?.text || name
      else if (n.name && /^[A-Z]/.test(n.name.text)) named.add(n.name.text)
    }
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && /^[A-Z]/.test(d.name.text)) named.add(d.name.text)
  })
  shared.set(f.replace(/\.tsx?$/, ''), { named, dflt })
}
const resolveImport = (from: string, spec: string): string | null => {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const c of [base, path.join(base, 'index')]) if (shared.has(c)) return c
  return null
}
const props = new Map<string, Map<ParitySport, Set<string>>>() // component → sport → props passed
for (const f of walk(SRC)) {
  const sport = sportOfFile(f)
  if (!sport) continue
  const sf = parse(f)
  const local = new Map<string, string>() // local JSX name → "file#Export"
  sf.forEachChild(n => {
    if (!ts.isImportDeclaration(n) || !n.importClause) return
    const target = resolveImport(f, (n.moduleSpecifier as ts.StringLiteral).text)
    if (!target) return
    const ex = shared.get(target)!
    const c = n.importClause
    if (c.name && ex.dflt) local.set(c.name.text, `${path.relative(SRC, target)}#${ex.dflt}`)
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) {
      const name = (el.propertyName || el.name).text
      if (ex.named.has(name)) local.set(el.name.text, `${path.relative(SRC, target)}#${name}`)
    }
  })
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const comp = local.get(n.tagName.getText(sf))
      if (comp) {
        const m = props.get(comp) || new Map<ParitySport, Set<string>>()
        const set = m.get(sport) || new Set<string>()
        for (const a of n.attributes.properties) if (ts.isJsxAttribute(a)) set.add(a.name.getText(sf))
        m.set(sport, set); props.set(comp, m)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
const propGaps: { comp: string; prop: string }[] = []
for (const [comp, m] of props) {
  const fb = m.get('football')
  if (!fb) continue
  const others = PARITY_SPORTS.filter(s => s !== 'football').map(s => m.get(s)).filter(Boolean) as Set<string>[]
  if (!others.length) continue // a football-only piece, not shared
  const name = comp.split('#')[1]
  for (const p of fb) if (!others.some(o => o.has(p)) && !(`${name}.${p}` in FOOTBALL_ONLY_PROPS)) propGaps.push({ comp: name, prop: p })
}

/* ---------- report ---------- */

const report = {
  ok: !gaps.length && !propGaps.length && !problems.length,
  keys: PARITY.length,
  gaps,
  propGaps,
  problems,
  todo,
  na: PARITY.flatMap(e => PARITY_SPORTS.filter(s => String((e as any)[s]).startsWith('na: ')).map(s => ({ key: e.key, sport: s, reason: String((e as any)[s]).slice(4) })))
}
const out = path.join(SRC, 'lib/sportParity.report.ts')
const body = `// Generated by scripts/parity-check.ts (npm run parity) — do not edit. Shown on the admin overview ("Sport parity").\n` +
  `export interface ParityReport {\n  ok: boolean; keys: number\n  gaps: { key: string; label: string; missing: string[]; note?: string }[]\n  propGaps: { comp: string; prop: string }[]\n  problems: string[]\n  todo: { key: string; label: string; sport: string; reason: string }[]\n  na: { key: string; sport: string; reason: string }[]\n}\n` +
  `export const PARITY_REPORT: ParityReport = ${JSON.stringify(report, null, 1)}\n`
if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== body) fs.writeFileSync(out, body)

if (report.ok) {
  console.log(`sport parity: ok — ${PARITY.length} blocks; ${report.na.length} 'na' (not applicable), ${todo.length} known gaps still to build (docs/notes/sport-parity.md); ${provided.length} parity declarations, ${props.size} shared components checked`)
  process.exit(0)
}
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
console.error('\nsport parity FAILED\n')
if (gaps.length) {
  console.error(pad('feature', 26) + pad('missing in', 28) + 'note')
  for (const g of gaps) console.error(pad(g.key, 26) + pad(g.missing.join(', ') || '-', 28) + (g.note || g.label))
}
if (propGaps.length) {
  console.error('\nshared component props passed by football only (add them to basketball / NFL, or to FOOTBALL_ONLY_PROPS with a reason):')
  for (const p of propGaps) console.error(`  ${p.comp}.${p.prop}`)
}
if (problems.length) { console.error('\nproblems:'); for (const p of problems) console.error('  ' + p) }
console.error('\nFootball is the template: a new football block = a parity key + the basketball and NFL versions in the same commit,\nor an \'na: <reason>\' Yarin approved (docs/notes/sport-parity.md).\n')
process.exit(1)

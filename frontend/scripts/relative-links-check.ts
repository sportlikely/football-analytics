/**
 * fix260: every internal link is absolute — part of `npm run parity`, and again after `vite build`.
 *
 * A relative link (href="player/damian-lillard", <Link to="team/x">, navigate('match/…')) resolves under the address of
 * the page it is on: /basketball/player/lillard-damian/player/damian-lillard (a 404, 28 Oct). Fails on
 *  1. the code: a JSX href / to, or a navigate / nav / Navigate call, whose text starts with neither "/", "http(s)://",
 *     "mailto:", "tel:", "#" nor an expression (a template literal starting with ${…} must start with a known absolute
 *     value: API_URL, a *Href / *Path helper, base, origin …);
 *  2. the built app (frontend/dist, when built): an href / to text in the bundle that is a bare path (letters, digits,
 *     dashes and slashes, no leading "/").
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')
const DIST = path.resolve(here, '../dist/assets')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}
const problems: string[] = []
const OK_START = /^(\/|https?:\/\/|mailto:|tel:|sms:|#|data:|blob:|$)/i
const isRelative = (text: string) => !OK_START.test(text) && !/^(-?\d+)$/.test(text)

for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8')
  if (!/href|to=|navigate|nav\(|Navigate/.test(src)) continue
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const where = (n: ts.Node) => `${path.relative(path.resolve(here, '../..'), file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
  const textOf = (e: ts.Expression | undefined): string | null => {
    if (!e) return null
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
    if (ts.isTemplateExpression(e)) return e.head.text // a template starting with ${…}: '' (an expression) — allowed
    if (ts.isParenthesizedExpression(e)) return textOf(e.expression)
    if (ts.isConditionalExpression(e)) { const a = textOf(e.whenTrue), b = textOf(e.whenFalse); return a !== null && isRelative(a) ? a : b !== null && isRelative(b) ? b : null }
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) { const b = textOf(e.right); return b !== null && isRelative(b) ? b : null }
    return null
  }
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && (n.name.text === 'href' || n.name.text === 'to')) {
      const init = n.initializer
      const t = !init ? null : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? textOf(init.expression) : null
      // `to` on a plain element (not a link) is some other prop; Group / Tile take an admin tab key (adminPath inside)
      const tag = (n.parent?.parent as ts.JsxOpeningLikeElement | undefined)?.tagName?.getText(sf) || ''
      const linkish = n.name.text === 'href' || /^(Link|NavLink|Navigate|MaybeLink|NameLink)$/.test(tag)
      if (t !== null && linkish && isRelative(t)) problems.push(`${where(n)}: ${tag} ${n.name.text}="${t}" is relative — start it with "/" (or use lib/links.ts)`)
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(navigate|nav)$/.test(n.expression.text) && n.arguments.length) {
      const t = textOf(n.arguments[0])
      if (t !== null && isRelative(t)) problems.push(`${where(n)}: ${n.expression.text}('${t}') is relative — start it with "/"`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

// the built app: bare-path href / to texts in the bundle (React props compile to {href:"…"} / {to:"…"})
if (fs.existsSync(DIST)) {
  for (const f of fs.readdirSync(DIST).filter(x => x.endsWith('.js'))) {
    const js = fs.readFileSync(path.join(DIST, f), 'utf8')
    for (const m of js.matchAll(/[{,]\s*(href|to)\s*:\s*"([^"]*)"/g)) {
      const v = m[2]
      if (/^[a-z0-9][a-z0-9\-_]*(\/[a-z0-9\-_]+)+\/?$/i.test(v) || (m[1] === 'href' && isRelative(v) && /^[a-z0-9-]+$/i.test(v) && !/^(javascript|void|none|auto)$/i.test(v)))
        problems.push(`dist/assets/${f}: built link ${m[1]}:"${v}" is relative`)
    }
    for (const m of js.matchAll(/href=\\?"([^"\\]*)\\?"/g)) if (isRelative(m[1]) && /^[a-z0-9][a-z0-9\-_/.]*$/i.test(m[1])) problems.push(`dist/assets/${f}: built link href="${m[1]}" is relative`)
  }
}

if (problems.length) {
  console.error(`relative-links check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`relative-links check: every internal link is absolute (code${fs.existsSync(DIST) ? ' + built app' : ''})`)

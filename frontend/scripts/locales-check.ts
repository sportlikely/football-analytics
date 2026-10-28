/**
 * fix256 — language check (part of `npm run parity`). Fails when
 *  1. a language in LANGS (src/lib/i18n.ts) has no src/locales/<lang>.json, or a locale file is not in LANGS,
 *  2. any language is missing a key that another language has (site dictionaries, and the server's email / push
 *     dictionaries in backend/src/locales/<kind>/),
 *  3. a translation drops or invents a placeholder ({0}, {name} …; a plural block counts as its variable),
 *  4. a translation is empty.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fails: string[] = []
// LANGS read from the source (i18n.ts uses import.meta.glob, so it isn't imported here)
const langsSrc = /export const LANGS = \{([\s\S]*?)\n\}/.exec(fs.readFileSync(path.join(FRONT, 'src/lib/i18n.ts'), 'utf8'))?.[1] || ''
const codes = [...langsSrc.matchAll(/^\s*([a-z]{2}):/gm)].map(m => m[1]).filter(l => l !== 'en')
if (codes.length < 2) fails.push('LANGS not found in src/lib/i18n.ts')

const placeholders = (s: string) =>
  s.replace(/\{(\w+)\s*,\s*plural\s*,(?:[^{}]|\{[^{}]*\})*\}/g, (_, v) => `{${v}}`).match(/\{\w+\}/g)?.sort().join(' ') || ''

function checkSet(label: string, dir: string, langs: string[], keysAreEnglish: boolean) {
  const dicts = new Map<string, Record<string, string>>()
  for (const l of langs) {
    const f = path.join(dir, `${l}.json`)
    if (!fs.existsSync(f)) { fails.push(`${label}: no ${path.relative(FRONT, f)} for "${l}"`); continue }
    try { dicts.set(l, JSON.parse(fs.readFileSync(f, 'utf8'))) } catch (e) { fails.push(`${label}: ${l}.json is not valid JSON (${(e as Error).message})`) }
  }
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) if (!langs.includes(f.slice(0, -5))) fails.push(`${label}: ${f} is not a language in LANGS`)
  const all = new Set<string>()
  for (const d of dicts.values()) for (const k of Object.keys(d)) all.add(k)
  for (const [l, d] of dicts) {
    const missing = [...all].filter(k => !(k in d))
    if (missing.length) fails.push(`${label}: ${l} is missing ${missing.length} key(s): ${missing.slice(0, 3).map(k => JSON.stringify(k)).join(', ')}${missing.length > 3 ? ' …' : ''}`)
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'string' || !v.trim()) { fails.push(`${label}: ${l} has an empty translation for ${JSON.stringify(k)}`); continue }
      if (keysAreEnglish && placeholders(v) !== placeholders(k)) fails.push(`${label}: ${l} placeholders ${placeholders(v) || '—'} ≠ ${placeholders(k) || '—'} in ${JSON.stringify(k)}`)
    }
  }
  return { langs: dicts.size, keys: all.size }
}

const site = checkSet('site', path.join(FRONT, 'src/locales'), codes, true)
const extra: string[] = []
for (const kind of ['email', 'push']) {
  const dir = path.resolve(FRONT, '../backend/src/locales', kind)
  if (!fs.existsSync(dir)) continue
  const r = checkSet(kind, dir, codes, false)
  extra.push(`${kind} ${r.keys} keys`)
}

if (fails.length) {
  console.error(`language check (fix256): FAILED\n${fails.slice(0, 40).map(f => `  ✗ ${f}`).join('\n')}${fails.length > 40 ? `\n  … ${fails.length - 40} more` : ''}`)
  process.exit(1)
}
console.log(`language check (fix256): ok — ${site.langs + 1} languages, ${site.keys} site keys each${extra.length ? `, ${extra.join(', ')}` : ''}`)

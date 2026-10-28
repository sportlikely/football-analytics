/**
 * fix256 + fix257 — language check (part of `npm run parity`).
 * Every language is complete, public or not (ar / he are admin-only until PUBLIC_LANGS names them, but their
 * dictionaries are checked like the others). Part of `npm run parity`. Fails when:
 * - a language of src/lib/i18n.ts LANGS has no src/locales/<lang>.json, or the backend twin (backend/src/utils/langs.ts
 *   ALL_LANGS) names other languages;
 * - a dictionary misses a key another one has, or a t("…") key used in the code (English is the key);
 * - a translation drops or renames a placeholder ({0}, {name}), loses a plural's `other` branch, or (right-to-left
 *   languages) writes Eastern Arabic digits or "%58" instead of "58%";
 * - the server's email / push dictionaries (backend/src/locales/<kind>/<lang>.json) miss a language or a key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '../src')
const BACK = path.join(here, '../../backend/src')
const problems: string[] = []

const i18n = fs.readFileSync(path.join(SRC, 'lib/i18n.ts'), 'utf8')
const block = /export const LANGS = \{([\s\S]*?)\} as const/.exec(i18n)?.[1] || ''
const LANGS = [...block.matchAll(/^\s+(\w{2}): \{ name:/gm)].map(m => m[1])
const RTL = (/RTL_LANGS: readonly Lang\[\] = \[([^\]]*)\]/.exec(i18n)?.[1] || '').match(/\w{2}/g) || []
if (LANGS.length < 2 || !LANGS.includes('en')) problems.push('could not read LANGS from src/lib/i18n.ts')

const back = fs.readFileSync(path.join(BACK, 'utils/langs.ts'), 'utf8')
const BACK_LANGS = (/export const ALL_LANGS = \[([^\]]*)\]/.exec(back)?.[1] || '').match(/\w{2}/g) || []
if (BACK_LANGS.join() !== LANGS.join()) problems.push(`backend utils/langs.ts ALL_LANGS (${BACK_LANGS.join(', ')}) ≠ frontend LANGS (${LANGS.join(', ')})`)
const BACK_RTL = (/RTL_LANGS: readonly SiteLang\[\] = \[([^\]]*)\]/.exec(back)?.[1] || '').match(/\w{2}/g) || []
if (BACK_RTL.join() !== RTL.join()) problems.push(`backend RTL_LANGS (${BACK_RTL.join(', ')}) ≠ frontend RTL_LANGS (${RTL.join(', ')})`)

/** the t("…") / tt('…') keys written in the code */
function codeKeys(): Set<string> {
  const keys = new Set<string>()
  const rx = /\b(?:t|tt)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(f.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(rx)) {
        const lit = m[1]
        try { keys.add(JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : lit)) } catch { /* not a plain literal */ }
      }
    }
  }
  walk(SRC)
  return keys
}

const holders = (s: string) => [...s.replace(/\{\w+\s*,\s*plural\s*,(?:[^{}]|\{[^{}]*\})*\}/g, '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
function checkValues(file: string, lang: string, d: Record<string, string>) {
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== 'string' || !v.trim()) { problems.push(`${file}: empty "${k.slice(0, 60)}"`); continue }
    if (holders(k) !== holders(v)) problems.push(`${file}: placeholders differ in "${k.slice(0, 60)}" → "${v.slice(0, 60)}"`)
    if (/plural/.test(k) && !/plural[\s\S]*other\s*\{/.test(v)) problems.push(`${file}: plural without "other" in "${k.slice(0, 60)}"`)
    if (RTL.includes(lang)) {
      if (/[٠-٩۰-۹]/.test(v)) problems.push(`${file}: Eastern Arabic digits in "${k.slice(0, 60)}" (Western digits only)`)
      if (/%\s*(\d|\{)/.test(v) && !/%\s*(\d|\{)/.test(k)) problems.push(`${file}: percent sign before the number in "${k.slice(0, 60)}" (write 58%)`)
    }
  }
}

/* ---------- the app's dictionaries ---------- */
const dicts = new Map<string, Record<string, string>>()
for (const l of LANGS.filter(l => l !== 'en')) {
  const f = path.join(SRC, 'locales', `${l}.json`)
  if (!fs.existsSync(f)) { problems.push(`src/locales/${l}.json is missing`); continue }
  dicts.set(l, JSON.parse(fs.readFileSync(f, 'utf8')))
}
for (const f of fs.readdirSync(path.join(SRC, 'locales')).filter(f => f.endsWith('.json')))
  if (!LANGS.includes(f.slice(0, -5))) problems.push(`src/locales/${f}: not a language of LANGS`)
const all = new Set<string>([...dicts.values()].flatMap(d => Object.keys(d)))
const used = codeKeys()
for (const [l, d] of dicts) {
  const miss = [...all].filter(k => !(k in d))
  if (miss.length) problems.push(`src/locales/${l}.json misses ${miss.length} key(s) other languages have, e.g. "${miss[0].slice(0, 70)}"`)
  const noKey = [...used].filter(k => !(k in d))
  if (noKey.length) problems.push(`src/locales/${l}.json misses ${noKey.length} key(s) used in the code, e.g. "${noKey[0].slice(0, 70)}"`)
  checkValues(`src/locales/${l}.json`, l, d)
}

/* ---------- the server's email / push words ---------- */
for (const kind of ['email', 'push']) {
  const dir = path.join(BACK, 'locales', kind)
  const packs = new Map<string, Record<string, string>>()
  for (const l of LANGS.filter(l => l !== 'en')) {
    const f = path.join(dir, `${l}.json`)
    if (!fs.existsSync(f)) { problems.push(`backend/src/locales/${kind}/${l}.json is missing`); continue }
    packs.set(l, JSON.parse(fs.readFileSync(f, 'utf8')))
  }
  const keys = new Set<string>([...packs.values()].flatMap(d => Object.keys(d)))
  for (const [l, d] of packs) {
    const miss = [...keys].filter(k => !(k in d))
    if (miss.length) problems.push(`backend/src/locales/${kind}/${l}.json misses ${miss.length} key(s), e.g. "${miss[0].slice(0, 70)}"`)
    checkValues(`backend/src/locales/${kind}/${l}.json`, l, d)
  }
}

if (problems.length) {
  console.error(`locales-check: ${problems.length} problem(s)`)
  for (const p of problems.slice(0, 60)) console.error('  ' + p)
  process.exit(1)
}
console.log(`locales-check: ${LANGS.length} languages (${LANGS.join(', ')}; right to left: ${RTL.join(', ') || 'none'}), ${all.size} keys each, ${used.size} used in the code, email + push words complete`)

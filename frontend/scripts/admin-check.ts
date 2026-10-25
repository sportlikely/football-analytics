/**
 * fix237: the admin page's tabs and explanations (part of `npm run parity`).
 *  - every card of lib/adminTabs.ts has one tab, a title, a "What this is" and a "What to do" text, in plain English
 *  - pages/Admin.tsx renders each registered card exactly once, inside its own tab's block, and every card component
 *    it renders sits inside an <Explained> frame (no card without an explanation)
 *  - every data-health check the backend can report (backend/src/services/*.ts) maps to a tab with a "What this is" text
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_CARDS, ADMIN_TABS, CODE_WORDS, HEALTH_RULES, healthRule } from '../src/lib/adminTabs.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fail: string[] = []
const tabs = new Set(ADMIN_TABS.map(t => t.key))

// ---------- the registry ----------
const seen = new Set<string>()
for (const c of ADMIN_CARDS) {
  if (seen.has(c.id)) fail.push(`card "${c.id}" is registered twice`)
  seen.add(c.id)
  if (!tabs.has(c.tab)) fail.push(`card "${c.id}": unknown tab "${c.tab}"`)
  for (const [k, v] of [['title', c.title], ['what', c.what], ['todo', c.todo]] as const) {
    if (!v || v.trim().length < 3) fail.push(`card "${c.id}": no "${k}" text`)
    else if (CODE_WORDS.test(v)) fail.push(`card "${c.id}" ${k}: code word "${v.match(CODE_WORDS)![0]}" — say it in plain English`)
  }
}
for (const r of HEALTH_RULES) {
  if (!tabs.has(r.tab)) fail.push(`check rule "${r.match}": unknown tab "${r.tab}"`)
  for (const [k, v] of [['title', r.title], ['what', r.what], ['todo', r.todo]] as const) {
    if (k !== 'title' && (!v || v.trim().length < 3)) fail.push(`check rule "${r.match}": no "${k}" text`)
    if (v && CODE_WORDS.test(v)) fail.push(`check rule "${r.match}" ${k}: code word "${v.match(CODE_WORDS)![0]}"`)
  }
}

// ---------- the page ----------
const page = fs.readFileSync(path.join(here, '../src/pages/Admin.tsx'), 'utf8')
const used = new Map<string, string[]>() // card id → tabs it is rendered in
// the blocks {tab === 'x' && …} of the main component; the users section is rendered in the users tab
const blocks = [...page.matchAll(/\{tab === '([a-z-]+)' &&/g)].map(m => ({ tab: m[1], at: m.index! }))
const mainEnd = page.indexOf('\nfunction UsersSection')
const usersSection = page.slice(mainEnd, page.indexOf('\n}\n', mainEnd))
for (const m of page.matchAll(/<Explained\b[^>]*\bid="([a-z0-9-]+)"/g)) {
  const at = m.index!
  const tab = at > mainEnd && at < mainEnd + usersSection.length ? 'users' : [...blocks].reverse().find(b => b.at < at)?.tab
  if (!tab) { fail.push(`card "${m[1]}" is rendered outside a tab`); continue }
  used.set(m[1], [...(used.get(m[1]) || []), tab])
}
for (const c of ADMIN_CARDS) {
  const t = used.get(c.id) || []
  if (!t.length) fail.push(`card "${c.id}" is registered but not on the page`)
  else if (t.length > 1) fail.push(`card "${c.id}" is rendered ${t.length} times (${t.join(', ')}) — one tab only`)
  else if (t[0] !== c.tab) fail.push(`card "${c.id}" is registered for "${c.tab}" but rendered in "${t[0]}"`)
}
for (const id of used.keys()) if (!seen.has(id)) fail.push(`card "${id}" is on the page but not in lib/adminTabs.ts (no explanation)`)
// every <…Card> of the main component and the users section inside an <Explained> frame
const scan = (src: string, where: string) => {
  let depth = 0
  for (const m of src.matchAll(/<(\/?)(Explained|[A-Z]\w*Card)\b([^>]*?)(\/?)>/g)) {
    if (m[2] === 'Explained') { if (m[1]) depth--; else if (!m[4]) depth++; continue }
    if (!m[1] && depth <= 0) fail.push(`${where}: <${m[2]}> is not inside an <Explained> frame`)
  }
}
scan(page.slice(page.indexOf('export default function Admin'), mainEnd), 'Admin')
scan(usersSection, 'UsersSection')

// ---------- the backend's data-health checks ----------
const svc = path.join(here, '../../backend/src/services')
const ids = new Set<string>()
const sample = (s: string) => s.replace(/\$\{[^}]*\}/g, 'football')
// dataHealth.ts and the modules whose *Health / *Checks lines it adds to the report
const dh = fs.readFileSync(path.join(svc, 'dataHealth.ts'), 'utf8')
const files = new Set(['dataHealth.ts'])
for (const m of dh.matchAll(/import \{([^}]+)\} from '\.\/([A-Za-z]+)'/g)) if (/Health|Checks|Check\b/.test(m[1])) files.add(`${m[2]}.ts`)
const feedsAt = dh.indexOf('const FEEDS'), feedsEnd = dh.indexOf('];', feedsAt)
for (const m of dh.slice(feedsAt, feedsEnd).matchAll(/\{ id: '([^']+)'/g)) ids.add(`feed:${m[1]}`)
for (const f of files) {
  let src = fs.readFileSync(path.join(svc, f), 'utf8')
  if (f === 'dataHealth.ts') src = src.slice(0, feedsAt) + src.slice(feedsEnd)
  for (const m of src.matchAll(/\bid: ['`]([^'`]+)['`],\s*label:/g)) if (!m[1].includes('${f.id}')) ids.add(sample(m[1]))
  for (const m of src.matchAll(/const id = `([^`]+)`, label = /g)) ids.add(sample(m[1]))
}
for (const sport of ['football', 'basketball', 'nfl', 'tennis']) for (const p of ['calibration-', 'league-settings-', 'more-predictions-']) ids.add(p + sport)
if (ids.size < 40) fail.push(`only ${ids.size} data-health checks found in backend/src/services — the scan is broken`)
for (const id of [...ids].sort()) if (!healthRule(id)) fail.push(`data-health check "${id}" has no tab / "What this is" text in lib/adminTabs.ts HEALTH_RULES`)

if (fail.length) {
  console.error(`admin-check: ${fail.length} problem(s)\n  ${fail.join('\n  ')}`)
  process.exit(1)
}
console.log(`admin-check: ${ADMIN_CARDS.length} cards in ${ADMIN_TABS.length} tabs, each explained; ${ids.size} data-health checks each mapped to a tab`)

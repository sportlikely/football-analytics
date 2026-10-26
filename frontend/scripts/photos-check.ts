/**
 * fix241 — official player photos only: part of `npm run parity` (so `npm run build` fails when it breaks).
 *  1. lib/photoSources.ts (twin of backend/src/utils/photoSources.ts, identical but for the twin line): API-Football
 *     (media.api-sports.io) allowed; Wikimedia, our old /media/players/… files and any other host refused;
 *  2. components/sport/PlayerPhoto.tsx rendered to HTML (react-dom/server): a non-official photo → initials + flag badge
 *     at the same size, an API-Football photo → the picture, no photo → initials + flag;
 *  3. the code: no /media/players/ address, no photo credit, every player picture drawn through PlayerPhoto or behind
 *     officialPhoto() (news pictures aside).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { officialPhoto, photoSourceOf } from '../src/lib/photoSources.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FRONT = path.resolve(here, '..')
const SRC = path.join(FRONT, 'src')
const fails: string[] = []
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).catch((e: any) => fails.push(`${name}: ${e?.message || e}`))

const FB = 'https://media.api-sports.io/football/players/276.png'

await check('the two photoSources files are the same rules', () => {
  const norm = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(l => !/Twin of /.test(l)).join('\n')
  assert.equal(norm(path.join(SRC, 'lib/photoSources.ts')), norm(path.resolve(FRONT, '../backend/src/utils/photoSources.ts')), 'frontend/src/lib/photoSources.ts and backend/src/utils/photoSources.ts differ')
})

await check('allow-list: API-Football only', () => {
  assert.equal(photoSourceOf(FB), 'api-football')
  assert.equal(officialPhoto('https://media-2.api-sports.io/american-football/players/12.png'), 'https://media-2.api-sports.io/american-football/players/12.png')
  for (const bad of ['/media/players/tennis/501-0123456789.webp', 'https://sportlikely.com/media/players/basketball/9-abcdef0123.webp',
    'https://upload.wikimedia.org/wikipedia/commons/a/a1/Player.jpg', 'https://commons.wikimedia.org/wiki/File:Player.jpg',
    'http://media.api-sports.io/football/players/276.png', 'https://media.api-sports.io.evil.example/x.png', 'https://cdn.nba.com/headshots/nba/latest/1040x760/2544.png', '', null, undefined])
    assert.equal(officialPhoto(bad as any), null, `allowed: ${bad}`)
})

await check('PlayerPhoto: initials + flag unless the photo is official', async () => {
  const file = path.join(SRC, 'components/sport/PlayerPhoto.tsx')
  let code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } }).outputText
  code = code.replace(/from ['"]\.\.\/\.\.\/lib\/photoSources['"]/, `from '${pathToFileURL(path.join(SRC, 'lib/photoSources.ts')).href}'`)
  const dir = path.join(FRONT, 'node_modules/.cache/fix241')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'PlayerPhoto.mjs')
  fs.writeFileSync(out, code)
  const { default: PlayerPhoto, PlayerInitials } = await import(pathToFileURL(out).href)
  const React = (await import('react')).default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const html = (src: string | null, size = 40) => renderToStaticMarkup(React.createElement(PlayerPhoto, { src, name: 'Carlos Alcaraz', flag: '🇪🇸', size }))
  for (const src of ['/media/players/tennis/501-0123456789.webp', 'https://upload.wikimedia.org/x.jpg', null]) {
    const h = html(src)
    assert.ok(!h.includes('<img'), `a picture for ${src}`)
    assert.ok(h.includes('>CA<'), `no initials for ${src}: ${h}`)
    assert.ok(h.includes('🇪🇸'), `no flag badge for ${src}`)
    assert.ok(h.includes('width:40px;height:40px'), `size changed for ${src}`)
  }
  const fb = html(FB)
  assert.ok(fb.includes(`<img src="${FB}"`), `the football photo is not shown: ${fb}`)
  assert.ok(fb.includes('width:40px;height:40px'), 'size changed for the football photo')
  const head = renderToStaticMarkup(React.createElement(PlayerInitials, { name: 'Nikola Jokić', flag: '🇷🇸' }))
  assert.ok(head.includes('>NJ<') && head.includes('🇷🇸'), `header initials: ${head}`)
})

await check('no Wikimedia / /media/players/ picture or photo credit left in the code', () => {
  const files: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(e.name)) files.push(p) } }
  walk(SRC)
  // news pictures (not players); the header guards with officialPhoto; NFL's hidden image only checks that it loads
  const ALLOWED = [/lead\.image/, /components\/sport\/page\/PlayerHeader\.tsx$/, /pages\/nfl\/NflPlayer\.tsx$/]
  for (const f of files) {
    const rel = path.relative(SRC, f).replace(/\\/g, '/')
    const text = fs.readFileSync(f, 'utf8')
    if (rel !== 'lib/photoSources.ts') {
      if (/\/media\/players\//.test(text)) fails.push(`${rel}: a /media/players/ address`)
      if (/PhotoCredit|photoCredit|isPlayerPhoto|wikimedia/i.test(text)) fails.push(`${rel}: Wikimedia photo / credit code`)
    }
    if (rel === 'components/sport/PlayerPhoto.tsx') continue
    text.split('\n').forEach((line, i) => {
      if (!/<img\b[^>]*src=\{[^}]*(photo|\.image|\.img\b|headshot)/i.test(line)) return
      if (/officialPhoto\(|<PlayerPhoto /.test(line) || ALLOWED.some(r => r.test(line) || r.test(rel))) return
      fails.push(`${rel}:${i + 1}: a player picture not drawn through PlayerPhoto / officialPhoto()`)
    })
  }
})

if (fails.length) {
  console.error(`photos check (fix241): ${fails.length} problem(s)\n` + fails.map(f => `  ✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log('photos check (fix241): ok — official photos only (API-Football), initials + flag everywhere else')

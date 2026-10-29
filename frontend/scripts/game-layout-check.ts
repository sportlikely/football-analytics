/**
 * fix284: every sport's game page goes through the one three-column frame (components/sport/game/GameLayout.tsx) —
 * part of `npm run parity`. Fails when
 *  1. GamePage.tsx does not render <GameLayout> with the page's preview and picks;
 *  2. a game page (pages/MatchDetail.tsx and every pages/<sport>/*Game.tsx / *Match.tsx) does not render <GamePage>
 *     with picks={<YourPicks …/>}, or misses <GamePicksSlot /> (phones: "Your picks" after the prediction block);
 *  3. a game page renders <YourPicks> or <GamePreview> anywhere but GamePage's picks= / preview= (it would show twice,
 *     or outside the side columns);
 *  4. a sport is missing: football, basketball, American football and tennis each need a game page.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')
const rel = (p: string) => path.relative(path.resolve(here, '../..'), p).replace(/\\/g, '/')
const problems: string[] = []

const gamePage = fs.readFileSync(path.join(SRC, 'components/sport/game/GamePage.tsx'), 'utf8')
if (!/<GameLayout\s+preview=\{p\.preview\}\s+picks=\{p\.picks\}>/.test(gamePage)) problems.push('frontend/src/components/sport/game/GamePage.tsx: does not render <GameLayout preview={p.preview} picks={p.picks}>')

const pages: string[] = [path.join(SRC, 'pages/MatchDetail.tsx')]
for (const dir of fs.readdirSync(path.join(SRC, 'pages'), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  for (const f of fs.readdirSync(path.join(SRC, 'pages', dir.name)))
    if (/^[A-Z]\w*(Game|Match)\.tsx$/.test(f)) pages.push(path.join(SRC, 'pages', dir.name, f))
}
const SPORTS: Record<string, RegExp> = { football: /pages\/MatchDetail\.tsx$/, basketball: /pages\/bb\//, 'american-football': /pages\/nfl\//, tennis: /pages\/tennis\// }
for (const [sport, re] of Object.entries(SPORTS)) if (!pages.some(p => re.test(rel(p)))) problems.push(`${sport}: no game page found`)

for (const file of pages) {
  const src = fs.readFileSync(file, 'utf8')
  const name = rel(file)
  if (!/<GamePage\b/.test(src)) { problems.push(`${name}: does not render <GamePage> (the shared frame)`); continue }
  if (!/\bpicks=\{<YourPicks\b/.test(src)) problems.push(`${name}: <GamePage> has no picks={<YourPicks …/>}`)
  if (!/<GamePicksSlot\s*\/>/.test(src)) problems.push(`${name}: no <GamePicksSlot /> after the prediction block (phones)`)
  const picks = src.match(/<YourPicks\b/g)?.length || 0, slotPicks = src.match(/picks=\{<YourPicks\b/g)?.length || 0
  if (picks !== slotPicks) problems.push(`${name}: <YourPicks> outside GamePage's picks= (${picks - slotPicks}×)`)
  const prev = src.match(/<GamePreview\b/g)?.length || 0, slotPrev = src.match(/preview=\{[^{}]*<GamePreview\b/g)?.length || 0
  if (prev !== slotPrev) problems.push(`${name}: <GamePreview> outside GamePage's preview= (${prev - slotPrev}×)`)
}

if (problems.length) {
  console.error(`game-layout-check (fix284): ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`game-layout-check: ${pages.length} game pages use GameLayout (preview left, Your picks right)`)

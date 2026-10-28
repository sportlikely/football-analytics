/**
 * fix267 — career check (part of `npm run parity`): every sport's player page shows the whole career with the one
 * shared table (src/components/sport/CareerTable.tsx), and the server sends it. Fails when
 *  - a player page of PLAYER_PAGES does not import CareerTable from components/sport/CareerTable or never renders it,
 *  - a player page still renders a career table of its own (a <table> next to the words "career" / "Career by season"),
 *  - the server's player answer of a sport no longer carries `careerTable` (services/bbPlayers.ts, the NFL and tennis
 *    player routes in app.ts) — football builds the table's shape from its own player page (fix152).
 * A new sport: its player page here and its server line below.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '../src')
const BACK = path.join(here, '../../backend/src')
const problems: string[] = []

export const PLAYER_PAGES: Record<string, string> = {
  football: 'pages/Player.tsx',
  basketball: 'pages/bb/BbPlayer.tsx',
  'american-football': 'pages/nfl/NflPlayer.tsx',
  tennis: 'pages/tennis/TennisPlayer.tsx'
}
for (const [sport, file] of Object.entries(PLAYER_PAGES)) {
  const p = path.join(SRC, file)
  if (!fs.existsSync(p)) { problems.push(`${sport}: player page ${file} not found`); continue }
  const s = fs.readFileSync(p, 'utf8')
  if (!/import CareerTable\b[^\n]*from '[./]+\/components\/sport\/CareerTable'/.test(s)) problems.push(`${sport}: ${file} does not import CareerTable from components/sport/CareerTable`)
  if (!/<CareerTable\b/.test(s)) problems.push(`${sport}: ${file} does not render <CareerTable>`)
  if (/Career by season/.test(s)) problems.push(`${sport}: ${file} still has its own "Career by season" table`)
}

const SERVER: [string, string, RegExp][] = [
  ['basketball', 'services/bbPlayers.ts', /careerTable: careerTable\(/],
  ['american-football', 'app.ts', /careerFor\('american-football'/],
  ['tennis', 'app.ts', /careerFor\('tennis'/]
]
for (const [sport, file, re] of SERVER) {
  const p = path.join(BACK, file)
  if (!fs.existsSync(p) || !re.test(fs.readFileSync(p, 'utf8'))) problems.push(`${sport}: the server's player answer (${file}) has no careerTable (services/playerCareers.ts careerFor)`)
}

if (problems.length) {
  console.error(`career check (fix267): ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`career check: ${Object.keys(PLAYER_PAGES).length} sports render the shared career table`)

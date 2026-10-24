/**
 * fix209 — scorers under the score: part of `npm run parity` (so `npm run build` fails when it breaks).
 *  1. lib/scorers.ts on finished games of every sport: goals in minute order per team, own goals on the side that got
 *     them (both provider conventions), penalties, red cards, "Goal 52'" for a goal not named yet that fills in on the
 *     next update (what the socket push does on the match page), basketball top scorer, NFL scoring plays;
 *  2. the header itself: components/sport/game/ScoreLines.tsx rendered to HTML (react-dom/server) for a finished
 *     football, basketball and NFL game — the build fails when the header has no scorer line;
 *  3. the wiring: GamePage draws HeaderScorers from its `scorers` prop, and the football, basketball and NFL game pages
 *     pass it (built with lib/scorers), the football page tracks socket goals; tennis keeps its set scores.
 * No future change to a game page can drop the scorers without this failing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { footballScorers, basketballScorers, nflScorers, goalSides, namedGoals, hasScorerLine, type FbMatch, type ScorerLines } from '../src/lib/scorers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const FRONT = path.resolve(here, '..')
const SRC = path.join(FRONT, 'src')
const fails: string[] = []
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).catch((e: any) => fails.push(`${name}: ${e?.message || e}`))
const text = (l: ScorerLines, s: 'home' | 'away') => l[s].map(i => `${i.pre ? i.pre + ' ' : ''}${i.name || 'Goal'} ${i.detail}`.trim()).join(' | ')

/* ---------- fixtures: finished games ---------- */

const VILLA = 58, CITY = 65
const villaCity: FbMatch = {
  homeTeam: { id: VILLA }, awayTeam: { id: CITY }, score: { fullTime: { home: 2, away: 1 } },
  goals: [
    { minute: 60, type: 'REGULAR', team: { id: VILLA }, scorer: { id: 1, name: 'Nicolas Jackson' } },
    { minute: 6, type: 'REGULAR', team: { id: VILLA }, scorer: { id: 1, name: 'Nicolas Jackson' } },
    { minute: 52, type: 'PENALTY', team: { id: CITY }, scorer: { id: 2, name: 'Erling Haaland' } }
  ],
  bookings: [{ minute: 77, team: { id: CITY }, player: { id: 3, name: 'Rodri' }, card: 'RED' }, { minute: 30, team: { id: VILLA }, player: { id: 4, name: 'Tielemans' }, card: 'YELLOW' }]
}
const ownGoal = (convention: 'players-team' | 'beneficiary'): FbMatch => ({
  homeTeam: { id: 1 }, awayTeam: { id: 2 }, score: { fullTime: { home: 1, away: 1 } },
  goals: [
    { minute: 10, type: 'REGULAR', team: { id: 1 }, scorer: { id: 10, name: 'Home Striker' } },
    // the away side's goal is an own goal by a home defender
    { minute: 70, type: 'OWN', team: { id: convention === 'players-team' ? 1 : 2 }, scorer: { id: 11, name: 'Home Defender' } }
  ]
})

await check('football: goals in minute order per team, one entry per scorer', () => {
  const l = footballScorers(villaCity)
  assert.equal(text(l, 'home'), "Nicolas Jackson 6', 60'")
  assert.equal(l.home.length, 1)
  assert.ok(text(l, 'away').startsWith("Erling Haaland 52' (P)"), text(l, 'away'))
})
await check('football: red card shown with the name, yellow cards not', () => {
  const l = footballScorers(villaCity)
  const red = l.away.find(i => i.mark === 'red')
  assert.ok(red && red.name === 'Rodri' && red.detail === "77'", JSON.stringify(l.away))
  assert.ok(!l.home.some(i => i.name === 'Tielemans'))
})
await check('football: own goal on the side that got it (player-team convention)', () => {
  const l = footballScorers(ownGoal('players-team'))
  assert.equal(text(l, 'away'), "Home Defender 70' (OG)")
  assert.equal(text(l, 'home'), "Home Striker 10'")
})
await check('football: own goal on the side that got it (beneficiary convention)', () => {
  const l = footballScorers(ownGoal('beneficiary'))
  assert.equal(text(l, 'away'), "Home Defender 70' (OG)")
  assert.deepEqual(namedGoals(ownGoal('beneficiary')), { home: 1, away: 1 })
})
await check('football: running score decides the side (Football-Data.org)', () => {
  const s = goalSides([
    { minute: 5, type: 'OWN', team: { id: 1 }, scorer: { id: 1, name: 'X' }, score: { home: 0, away: 1 } },
    { minute: 9, type: 'REGULAR', team: { id: 1 }, scorer: { id: 2, name: 'Y' }, score: { home: 1, away: 1 } }
  ], 1, 2, { home: 1, away: 1 })
  assert.deepEqual(s, ['away', 'home'])
})
await check('football live: a goal not named yet is "Goal 52\'" and fills in on the next update', () => {
  // the socket pushed 2-2 at 52' before the provider named the scorer
  const live: FbMatch = { ...villaCity, score: { fullTime: { home: 2, away: 2 } } }
  const before = footballScorers(live, { home: [], away: [52] })
  const pending = before.away.find(i => i.mark === 'pending')
  assert.ok(pending && pending.detail === "52'" && pending.name === '', JSON.stringify(before.away))
  const after = footballScorers({ ...live, goals: [...villaCity.goals!, { minute: 52, injuryTime: 2, type: 'REGULAR', team: { id: CITY }, scorer: { id: 5, name: 'Foden' } }] }, { home: [], away: [52] })
  assert.ok(!after.away.some(i => i.mark === 'pending'), JSON.stringify(after.away))
  assert.ok(after.away.some(i => i.name === 'Foden' && i.detail === "52'+2"))
})
await check('football: an upcoming / goalless game has no line', () => {
  assert.equal(hasScorerLine(footballScorers({ homeTeam: { id: 1 }, awayTeam: { id: 2 }, score: { fullTime: { home: 0, away: 0 } }, goals: [] })), false)
})
const bbLines = basketballScorers({ home: { id: 7, name: 'Tyrese Haliburton', short: 'Haliburton', points: 28 }, away: { id: 8, name: 'Luka Doncic', short: 'Doncic', points: 31 } })
await check('basketball: each team\'s top scorer', () => {
  assert.equal(text(bbLines, 'home'), 'Haliburton 28')
  assert.equal(text(bbLines, 'away'), 'Doncic 31')
})
const nflLines = nflScorers([
  { quarter: 'Q1', minute: '08', team: 1, player: 'Isiah Pacheco', playerId: 20, type: 'Touchdown' },
  { quarter: 'Q2', minute: '12', team: 1, player: 'Travis Kelce', playerId: 21, type: 'Touchdown' },
  { quarter: 'Q3', minute: '03', team: 2, player: 'Tyler Bass', playerId: 22, type: 'Field Goal' }
], 1, 2)
await check('NFL: the scoring plays per side, in order', () => {
  assert.equal(text(nflLines, 'home'), "TD Isiah Pacheco 08' Q1 | TD Travis Kelce 12' Q2")
  assert.equal(text(nflLines, 'away'), "FG Tyler Bass 03' Q3")
})

/* ---------- the header rendered to HTML ---------- */

await check('header render: finished football, basketball and NFL games show a scorer line', async () => {
  const file = path.join(SRC, 'components/sport/game/ScoreLines.tsx')
  let code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false } }).outputText
  // the page's translations need Vite: a plain English t() here
  code = code.replace(/from ['"]\.\.\/\.\.\/\.\.\/lib\/i18n['"]/, `from 'data:text/javascript,export const t = (s) => s'`)
  if (/from\s+['"][^'"]*lib\/scorers['"]/.test(code)) throw new Error('ScoreLines.tsx must only import types from lib/scorers')
  const dir = path.join(FRONT, 'node_modules/.cache/fix209')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'ScoreLines.mjs')
  fs.writeFileSync(out, code)
  const { HeaderScorers } = await import(pathToFileURL(out).href)
  const React = (await import('react')).default
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { MemoryRouter } = await import('react-router-dom')
  // react-router's Link uses useLayoutEffect: React warns about it on the server, nothing is wrong
  const err = console.error
  console.error = (...a: any[]) => { if (!/useLayoutEffect does nothing on the server/.test(String(a[0]))) err(...a) }
  const render = (lines: ScorerLines) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(HeaderScorers, { lines, playerHref: (id: number) => `/player/${id}` })))
  for (const [sport, lines, must] of [
    ['football', footballScorers(villaCity), ['Nicolas Jackson', "6&#x27;, 60&#x27;", 'Erling Haaland', 'Rodri', 'Red card']],
    ['basketball', bbLines, ['Haliburton', '28', 'Doncic', '31']],
    ['nfl', nflLines, ['Travis Kelce', 'TD', 'Tyler Bass', 'FG']]
  ] as const) {
    assert.ok(hasScorerLine(lines), `${sport}: no scorer line built`)
    const html = render(lines)
    assert.ok(html.includes('data-scorers="header"'), `${sport}: the header has no scorer line`)
    for (const m of must) assert.ok(html.includes(m), `${sport}: "${m}" missing from the header (${html.slice(0, 300)}…)`)
  }
})

/* ---------- the wiring (read without running) ---------- */

const src = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8')
/** the `scorers=` attribute of <GamePage …> in a page, as text */
function gamePageAttr(file: string, attr: string): string | null {
  const sf = ts.createSourceFile(file, src(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === 'GamePage')
      for (const a of n.attributes.properties) if (ts.isJsxAttribute(a) && a.name.getText(sf) === attr) found = a.initializer ? a.initializer.getText(sf) : ''
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}
await check('GamePage draws the scorers line from its scorers prop', () => {
  const g = src('components/sport/game/GamePage.tsx')
  assert.ok(/<HeaderScorers\s+lines=\{p\.scorers\.lines\}/.test(g), 'GamePage.tsx no longer renders <HeaderScorers lines={p.scorers.lines} …>')
})
for (const [file, builder] of [['pages/MatchDetail.tsx', 'footballScorers'], ['pages/bb/BbGame.tsx', 'basketballScorers'], ['pages/nfl/NflGame.tsx', 'nflScorers']] as const) {
  await check(`${file} passes the scorers line to GamePage`, () => {
    const a = gamePageAttr(file, 'scorers')
    assert.ok(a !== null, `${file}: <GamePage> has no scorers= prop`)
    assert.ok(a!.includes(builder), `${file}: scorers= is not built with ${builder} (${a})`)
  })
}
await check('football page: a goal over the socket is remembered and its scorer fetched', () => {
  const s = src('pages/MatchDetail.tsx')
  assert.ok(/pendingGoals\.current\[s\]\.push\(/.test(s) && /refetch\.push\(setTimeout\(\(\) => load\(false\)/.test(s), 'MatchDetail.tsx: the socket handler no longer tracks unnamed goals / refetches the details')
})
await check('tennis keeps its set scores under the score', () => {
  const a = gamePageAttr('pages/tennis/TennisMatch.tsx', 'scoreSub') || ''
  const f = gamePageAttr('pages/tennis/TennisMatch.tsx', 'footer') || ''
  assert.ok(a.includes('setsText') && f.includes('SetTable'), 'TennisMatch.tsx: set scores (scoreSub setsText / footer SetTable) missing')
})

if (fails.length) {
  console.error(`scorers check (fix209): ${fails.length} problem(s)\n` + fails.map(f => `  ✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log('scorers check (fix209): ok — header line rendered for football, basketball and NFL; every game page passes it')

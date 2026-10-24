/**
 * fix213 — layout check (part of `npm run parity`): every sport's Games page has football's layout. A headless Chromium
 * opens football /matches, /basketball/games, /american-football/games and /tennis/matches at 1440×900 and 390×844 on a
 * Saturday-night fixture (40 live games + the coming games, every API call answered here) and fails when:
 *  - the page title ("Games" / "Matches") is not within the first 900 px,
 *  - the Live box (desktop) or the live strip (phone) is taller than 60% of the screen,
 *  - the left column (Live box, leagues, Latest results) is missing on desktop.
 * Screenshots go to test-output/layout/ (not committed).
 *
 * Browser: PLAYWRIGHT_CHROMIUM (a chrome executable), else the newest Playwright Chromium in ms-playwright, else Chrome /
 * Edge. No browser on the machine → the check fails; LAYOUT_CHECK=skip skips it (say so in the commit).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'test-output', 'layout')
const LIVE_N = 40

if (process.env.LAYOUT_CHECK === 'skip') { console.log('layout check (fix213): skipped (LAYOUT_CHECK=skip)'); process.exit(0) }

function findChromium(): string | null {
  if (process.env.PLAYWRIGHT_CHROMIUM && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM
  const home = os.homedir()
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'AppData', 'Local', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean) as string[]
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    const builds = fs.readdirSync(d).filter(x => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const b of builds) {
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(d, b, exe)
        if (fs.existsSync(p)) return p
      }
    }
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (fs.existsSync(p)) return p
  return null
}

/* ---------- the fixture: a Saturday night, 40 live games per sport + 12 to come ---------- */

const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const soon = (i: number) => iso(now + (2 + (i % 12) * 5) * 3600e3)
const started = (i: number) => iso(now - (20 + i) * 60e3)
const team = (id: number, name: string) => ({ id, name, logo: null })
const score = (i: number): [number, number] => [(i * 7) % 31, (i * 5 + 3) % 28]

function football() {
  const comps = [{ code: 'PL', name: 'Premier League', rank: 0 }, { code: 'PD', name: 'Primera Division', rank: 0 }, { code: 'SA', name: 'Serie A', rank: 0 }, { code: 'BL1', name: 'Bundesliga', rank: 0 }, { code: 'ELC', name: 'Championship', rank: 2 }]
  const m = (i: number, live: boolean) => {
    const c = comps[i % comps.length], [h, a] = score(i)
    const t = (id: number) => ({ id, name: `Club ${id}`, shortName: `Club ${id}`, tla: `C${id}`, crest: null })
    return {
      id: 1000 + i, utcDate: live ? started(i) : soon(i), status: live ? 'IN_PLAY' : 'TIMED', minute: live ? 30 + (i % 50) : null,
      competition: { code: c.code, name: c.name, rank: c.rank }, homeTeam: t(i * 2 + 1), awayTeam: t(i * 2 + 2),
      score: { fullTime: live ? { home: h % 4, away: a % 3 } : { home: null, away: null } },
      prediction: i % 2 ? { model: 'grid-v3', locked: false, home: 48, draw: 27, away: 25, live: live ? { home: 55, draw: 25, away: 20 } : null } : { model: 'grid-v3', locked: true }
    }
  }
  const list = [...Array.from({ length: LIVE_N }, (_, i) => m(i, true)), ...Array.from({ length: 12 }, (_, i) => m(100 + i, false))]
  return (u: URL) => (u.pathname === '/api/matches/upcoming' ? { data: list } : u.pathname === '/api/public/results' ? { data: { rows: [] } } : null)
}

function basketball() {
  const leagues = [{ code: 'NBA', name: 'NBA', country: 'USA', logo: null }, { code: 'EL', name: 'EuroLeague', country: 'Europe', logo: null }, { code: 'ACB', name: 'Liga ACB', country: 'Spain', logo: null }]
  const g = (i: number, live: boolean) => {
    const [h, a] = score(i)
    return {
      id: 2000 + i, league: { code: leagues[i % 3].code, name: leagues[i % 3].name }, season: '2026-2027', round: null, preseason: false,
      kickoff: live ? started(i) : soon(i), status: live ? 'Q3' : 'NS', state: live ? 'live' : 'upcoming',
      home: team(i * 2 + 1, `Home ${i}`), away: team(i * 2 + 2, `Away ${i}`), score: live ? { home: 60 + h, away: 58 + a } : null, quarters: null,
      clock: live ? { played: 4, left: 8 } : null,
      prediction: i % 2 ? { model: 'bb-v3', pick: 'H', locked: false, pHome: 62, pAway: 38, live: live ? { pHome: 70, pAway: 30 } : null } : { model: 'bb-v3', pick: null, locked: true }
    }
  }
  const list = [...Array.from({ length: LIVE_N }, (_, i) => g(i, true)), ...Array.from({ length: 12 }, (_, i) => g(100 + i, false))]
  return (u: URL) => {
    if (u.pathname === '/api/basketball/config') return { data: { public: true, open: true, leagues } }
    if (u.pathname === '/api/basketball/games') return { data: u.searchParams.get('results') ? [] : list }
    return null
  }
}

function nfl() {
  // the 24 Oct report: 39 college games live at once, one NFL game
  const g = (i: number, live: boolean) => {
    const league = i === 3 ? 1 : 2, [h, a] = score(i)
    return {
      id: 3000 + i, season: 2026, week: 'Week 8', weekKey: '8', stage: 'Regular Season', kickoff: live ? started(i) : soon(i),
      status: live ? (i % 5 === 0 ? 'HT' : 'Q3') : 'NS', state: live ? 'live' : 'upcoming', clock: live ? '08:42' : null,
      home: team(i * 2 + 1, `${league === 1 ? 'Kansas City' : 'State'} Home${i}`), away: team(i * 2 + 2, `${league === 1 ? 'Denver' : 'Tech'} Away${i}`),
      score: live ? { home: h, away: a } : null, quarters: null, venue: null, league,
      prediction: i % 2 ? { locked: false, model: 'nfl-v1', pHome: 58, pAway: 42, pick: 'H', margin: 3, total: 44, live: live ? { pHome: 64, pAway: 36, score: { home: h, away: a }, total: 44 } : null } : { locked: true }
    }
  }
  const list = [...Array.from({ length: LIVE_N }, (_, i) => g(i, true)), ...Array.from({ length: 12 }, (_, i) => g(100 + i, false))]
  return (u: URL) => {
    if (u.pathname === '/api/nfl/config') return { data: { public: true, open: true, season: 2026, seasons: [2026], leagues: [{ id: 1, season: 2026 }, { id: 2, season: 2026 }] } }
    if (u.pathname === '/api/nfl/games') return { data: { games: list } }
    if (u.pathname === '/api/nfl/home') return { data: { results: [], live: [], games: [], upcoming: [] } }
    return null
  }
}

function tennis() {
  const tours = [{ key: 'paris', name: 'Paris Masters', tour: 'atp' }, { key: 'riyadh', name: 'WTA Finals', tour: 'wta' }, { key: 'brest', name: 'Brest Challenger', tour: 'challenger' }]
  const p = (id: number) => ({ id, name: `Player ${id}`, short: `Player${id}`, country: null, rank: id, logo: null })
  const m = (i: number, live: boolean) => {
    const t = tours[i % 3]
    return {
      id: 4000 + i, tour: t.tour, cat: 'singles', women: t.tour === 'wta',
      tournament: { key: t.key, name: t.name, tier: null, level: t.tour, surface: 'hard', indoor: true, city: null, country: null },
      round: 'R32', roundCode: 'R32', qualifying: false, bestOf: 3, start: live ? started(i) : soon(i), status: live ? 'Set 2' : 'NS', state: live ? 'live' : 'upcoming',
      home: p(i * 2 + 1), away: p(i * 2 + 2), score: live ? { sets: [[6, 4], [2, 3]], won: [1, 0], points: ['30', '15'], server: 1 } : null, winner: null, outcome: null, rid: -(3e9 + i),
      prediction: i % 2 ? { locked: false, model: 'tennis-v1', pHome: 60, pAway: 40, pick: 'H', live: live ? { pHome: 72, pAway: 28 } : null } : { locked: true }
    }
  }
  const list = [...Array.from({ length: LIVE_N }, (_, i) => m(i, true)), ...Array.from({ length: 12 }, (_, i) => m(100 + i, false))]
  return (u: URL) => {
    if (u.pathname === '/api/tennis/config') return { data: { public: true, open: true, tours: ['atp', 'wta', 'challenger'] } }
    if (u.pathname === '/api/tennis/matches') return { data: { matches: list } }
    if (u.pathname === '/api/tennis/home') return { data: { results: [] } }
    return null
  }
}

const SPORTS = [
  { sport: 'football', path: '/matches', api: football() },
  { sport: 'basketball', path: '/basketball/games', api: basketball() },
  { sport: 'nfl', path: '/american-football/games', api: nfl() },
  { sport: 'tennis', path: '/tennis/matches', api: tennis() }
]
const SCREENS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]

/* ---------- run ---------- */

const exe = findChromium()
if (!exe) {
  console.error('layout check (fix213): FAILED — no Chromium found. Install one (npx playwright install chromium) or set PLAYWRIGHT_CHROMIUM; LAYOUT_CHECK=skip to skip.')
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5287, strictPort: false, hmr: false } })
await server.listen()
const base = (server.resolvedUrls?.local[0] || 'http://localhost:5287/').replace(/\/$/, '')
const browser = await chromium.launch({ executablePath: exe, headless: true })
const fails: string[] = []
const lines: string[] = []
try {
  for (const s of SPORTS) {
    for (const sc of SCREENS) {
      const ctx = await browser.newContext({ viewport: { width: sc.width, height: sc.height }, deviceScaleFactor: 1, hasTouch: sc.name === 'phone', locale: 'en-GB' })
      // first visit cards / consent stay out of the way (the check measures the page, not the banner)
      await ctx.addInitScript(() => { try { localStorage.setItem('sl-consent', JSON.stringify({ v: 1, analytics: false, ads: false })) } catch { /* no storage */ } })
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e.message || e)))
      await page.route('**/socket.io/**', r => r.abort())
      await page.route('**/api/**', async r => {
        const u = new URL(r.request().url())
        const body = s.api(u)
        if (body) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
        if (u.pathname === '/api/auth/me') return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' })
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":null}' })
      })
      const tag = `${s.sport} ${sc.width}×${sc.height}`
      try {
        await page.goto(base + s.path, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForSelector('[data-testid="games-title"]', { timeout: 60000 })
        await page.waitForTimeout(800)
        const m = await page.evaluate(() => {
          const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0
          const box = (sel: string) => { const el = document.querySelector(sel); if (!vis(el)) return null; const r = el!.getBoundingClientRect(); return { top: r.top + window.scrollY, height: r.height } }
          return {
            title: box('[data-testid="games-title"]'), left: box('[data-testid="games-left"]'),
            liveBox: box('[data-testid="live-box"]'), liveStrip: box('[data-testid="live-strip"]'),
            liveRows: [...document.querySelectorAll('[data-testid="live-box"] li, [data-testid="live-strip"] a')].filter(vis).length,
            scrollW: document.documentElement.scrollWidth, w: window.innerWidth, h: window.innerHeight,
            // what sticks out on the right (deepest elements first), for the failure line
            wide: [...document.body.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1 && !el.closest('.overflow-x-auto, .overflow-hidden, .overflow-x-hidden') && el.children.length === 0 })
              .slice(0, 3).map(el => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : ''} "${(el.textContent || '').trim().slice(0, 20)}"`)
          }
        })
        await page.screenshot({ path: path.join(OUT, `${s.sport}-${sc.width}x${sc.height}.png`) })
        const desktop = sc.name === 'desktop'
        const live = desktop ? m.liveBox : m.liveStrip
        if (!m.title || m.title.top > 900) fails.push(`${tag}: the page title starts at ${m.title ? Math.round(m.title.top) : '—'} px (must be within the first 900 px)`)
        if (!live) fails.push(`${tag}: no ${desktop ? 'Live box' : 'live strip'} with ${LIVE_N} live games in the fixture`)
        else if (live.height > 0.6 * m.h) fails.push(`${tag}: the ${desktop ? 'Live box' : 'live strip'} is ${Math.round(live.height)} px tall (more than 60% of ${m.h})`)
        if (desktop && !m.left) fails.push(`${tag}: no left column (Live box, leagues, Latest results)`)
        if (m.scrollW > m.w + 1) fails.push(`${tag}: the page scrolls sideways (${m.scrollW} px wide: ${m.wide.join(', ') || '?'})`)
        // "Show all N live" opens every live game (?live=1), grouped by league, in the centre
        if (desktop && live) {
          await page.click('[data-testid="live-box"] a[href*="live=1"]')
          await page.waitForSelector('[data-testid="live-view"]', { timeout: 15000 })
          const all = await page.locator('[data-testid="live-view"] li').count()
          await page.screenshot({ path: path.join(OUT, `${s.sport}-${sc.width}x${sc.height}-live.png`) })
          if (all !== LIVE_N) fails.push(`${tag}: "Show all live" lists ${all} games, not ${LIVE_N}`)
        }
        if (errors.length) fails.push(`${tag}: page error — ${errors[0]}`)
        lines.push(`  ${tag.padEnd(28)} title at ${Math.round(m.title?.top ?? -1)} px · live ${Math.round(live?.height ?? -1)} px (${m.liveRows} rows) · left column ${m.left ? 'yes' : 'no'}`)
      } catch (e) {
        await page.screenshot({ path: path.join(OUT, `${s.sport}-${sc.width}x${sc.height}-error.png`) }).catch(() => {})
        fails.push(`${tag}: ${(e as Error).message.split('\n')[0]}${errors.length ? ` (page error: ${errors[0]})` : ''}`)
      }
      await ctx.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}

if (fails.length) {
  console.error(`layout check (fix213): FAILED\n${lines.join('\n')}\n${fails.map(f => `  ✗ ${f}`).join('\n')}\n  screenshots: ${path.relative(ROOT, OUT)}`)
  process.exit(1)
}
console.log(`layout check (fix213): ok — ${SPORTS.length} sports × ${SCREENS.length} screens, ${LIVE_N} live games each; screenshots in ${path.relative(ROOT, OUT)}\n${lines.join('\n')}`)
process.exit(0)

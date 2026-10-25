/**
 * fix215 — season forecast layout check (part of `npm run parity`, next to fix213's layout-check.ts). A headless Chromium
 * opens the "Season forecast" tab of a football (PL, 20 teams), basketball (NBA, two conferences of 15) and American
 * football (NFL, two conferences of 16) league page at 1440×900 and 390×844, every API call answered here, and fails when:
 *  - the forecast card is missing or doesn't list every team (Pro) / the top three, bottom three + a locked middle (Free),
 *  - the page scrolls sideways (the wide table must scroll inside its card),
 *  - "Every position" doesn't open the heat map,
 *  - the page throws.
 * Screenshots go to test-output/layout/forecast-*.png (not committed). Browser and LAYOUT_CHECK=skip: as layout-check.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'test-output', 'layout')

if (process.env.LAYOUT_CHECK === 'skip') { console.log('forecast layout check (fix215): skipped (LAYOUT_CHECK=skip)'); process.exit(0) }

function findChromium(): string | null {
  if (process.env.PLAYWRIGHT_CHROMIUM && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM
  const home = os.homedir()
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, 'AppData', 'Local', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean) as string[]
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    const builds = fs.readdirSync(d).filter(x => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const b of builds) for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(d, b, exe)
      if (fs.existsSync(p)) return p
    }
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) if (fs.existsSync(p)) return p
  return null
}

/* ---------- the fixture: one league forecast per sport ---------- */

const LONG = ['Wolverhampton Wanderers', 'Brighton & Hove Albion', 'Nottingham Forest', 'Southeast Missouri State Redhawks', 'Oklahoma City Thunder', 'Portland Trail Blazers']
function league(sport: string, code: string, groups: string[], perGroup: number, zones: string[], full: boolean) {
  const teams: any[] = []
  groups.forEach((g, gi) => {
    for (let k = 0; k < perGroup; k++) {
      const id = String(100 + gi * perGroup + k)
      const pos = Array.from({ length: perGroup }, (_, j) => Math.max(0, 1 - Math.abs(j - k) * 0.35))
      const s = pos.reduce((a, b) => a + b, 0)
      const z: Record<string, number> = {}
      zones.forEach((zz, zi) => { z[zz] = Math.max(0, Math.min(1, zi === zones.length - 1 && /releg/.test(zz) ? k / perGroup - 0.6 : 1 - k / (perGroup / (zi + 1)))) })
      const row = { id, name: `${LONG[(gi * perGroup + k) % LONG.length]} ${k + 1}`, group: g || null, logo: null, now: { rank: k + 1, pts: 30 - k, played: 12, w: 9 - (k % 9), d: 2, l: 1 + (k % 9), diff: 10 - k },
        avgPts: 70 - 2 * k, avgPos: k + 1.2, zones: z, pos: pos.map(p => p / s) }
      // Free: the middle is locked
      teams.push(!full && k >= 3 && k < perGroup - 3 ? { id, name: row.name, group: row.group, logo: null, now: row.now, locked: true } : row)
    }
  })
  return { sport, code, name: code, season: '2026', runAt: new Date().toISOString(), runs: 20000, known: true, zones, groups, teams, gamesLeft: 200, full, locked: full ? 0 : teams.filter(x => x.locked).length }
}
const CASES = [
  { sport: 'football', path: '/football/league/premier-league#forecast', id: 'PL', api: '/api/season-forecast/football/league/PL', teams: 20, mk: (full: boolean) => league('football', 'PL', [''], 20, ['title', 'cl', 'europe', 'relegation'], full) },
  { sport: 'basketball', path: '/basketball/league/nba#forecast', id: 'NBA', api: '/api/season-forecast/basketball/league/NBA', teams: 30, mk: (full: boolean) => league('basketball', 'NBA', ['Eastern Conference', 'Western Conference'], 15, ['title', 'final', 'conf_title', 'playoffs', 'playin'], full) },
  { sport: 'nfl', path: '/american-football/league/nfl#forecast', id: '1', api: '/api/season-forecast/nfl/league/NFL', teams: 32, mk: (full: boolean) => league('nfl', 'NFL', ['AFC', 'NFC'], 16, ['title', 'conf_title', 'div_title', 'bye', 'playoffs'], full) }
]
const CONFIG: Record<string, unknown> = {
  '/api/basketball/config': { data: { public: true, open: true, leagues: [{ code: 'NBA', name: 'NBA', country: 'USA', logo: null }] } },
  '/api/nfl/config': { data: { public: true, open: true, season: 2026, seasons: [2026], leagues: [{ id: 1, season: 2026 }, { id: 2, season: 2026 }] } }
}
const SCREENS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]

/* ---------- run ---------- */

const exe = findChromium()
if (!exe) {
  console.error('forecast layout check (fix215): FAILED — no Chromium found. Install one (npx playwright install chromium) or set PLAYWRIGHT_CHROMIUM; LAYOUT_CHECK=skip to skip.')
  process.exit(1)
}
fs.mkdirSync(OUT, { recursive: true })
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5297, strictPort: false, hmr: false } })
await server.listen()
const base = (server.resolvedUrls?.local[0] || 'http://localhost:5297/').replace(/\/$/, '')
const browser = await chromium.launch({ executablePath: exe, headless: true })
const fails: string[] = [], lines: string[] = []
try {
  for (const c of CASES) for (const full of [true, false]) for (const sc of SCREENS) {
    const ctx = await browser.newContext({ viewport: { width: sc.width, height: sc.height }, deviceScaleFactor: 1, hasTouch: sc.name === 'phone', locale: 'en-GB' })
    await ctx.addInitScript(() => { try { localStorage.setItem('sl-consent', JSON.stringify({ v: 1, analytics: false, ads: false })) } catch { /* no storage */ } })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', e => errors.push(String(e.message || e)))
    await page.route('**/socket.io/**', r => r.abort())
    await page.route('**/api/**', async r => {
      const u = new URL(r.request().url())
      // fix229: the slug address's item (SlugRoute asks /api/slug/<sport>/<kind>/<slug>)
      if (u.pathname.startsWith('/api/slug/')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { id: c.id, slug: u.pathname.split('/').pop() } }) })
      const body = u.pathname === c.api ? { data: c.mk(full) } : CONFIG[u.pathname]
      if (body) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      if (u.pathname === '/api/auth/me') return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' })
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"data":null}' })
    })
    const tag = `${c.sport} ${full ? 'Pro' : 'Free'} ${sc.width}×${sc.height}`
    const shot = `forecast-${c.sport}-${full ? 'pro' : 'free'}-${sc.width}x${sc.height}`
    try {
      await page.goto(base + c.path, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForSelector('[data-testid="season-forecast"] tbody tr', { timeout: 60000 })
      await page.waitForTimeout(400)
      const m = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-testid="season-forecast"] tbody tr').length,
        blurred: document.querySelectorAll('[data-testid="season-forecast"] tbody tr td[colspan]').length,
        top: (document.querySelector('[data-testid="season-forecast"]') as HTMLElement).getBoundingClientRect().top + window.scrollY,
        scrollW: document.documentElement.scrollWidth, w: window.innerWidth
      }))
      await page.screenshot({ path: path.join(OUT, `${shot}.png`), fullPage: false })
      if (m.rows !== c.teams) fails.push(`${tag}: ${m.rows} rows, not ${c.teams}`)
      const expLocked = full ? 0 : c.mk(false).locked
      if (m.blurred !== expLocked) fails.push(`${tag}: ${m.blurred} locked rows, not ${expLocked}`)
      if (m.scrollW > m.w + 1) fails.push(`${tag}: the page scrolls sideways (${m.scrollW} px wide)`)
      if (m.top > 900) fails.push(`${tag}: the forecast starts at ${Math.round(m.top)} px (must be within the first 900 px)`)
      await page.click('[data-testid="forecast-heat"]')
      await page.waitForTimeout(300)
      const h = await page.evaluate(() => ({ cells: document.querySelectorAll('[data-testid="season-forecast"] td[title]').length, scrollW: document.documentElement.scrollWidth, w: window.innerWidth }))
      await page.screenshot({ path: path.join(OUT, `${shot}-heat.png`) })
      if (!h.cells) fails.push(`${tag}: "Every position" shows no heat map`)
      if (h.scrollW > h.w + 1) fails.push(`${tag}: the heat map makes the page scroll sideways (${h.scrollW} px)`)
      if (errors.length) fails.push(`${tag}: page error — ${errors[0]}`)
      lines.push(`  ${tag.padEnd(30)} ${m.rows} rows (${m.blurred} locked) · forecast at ${Math.round(m.top)} px · heat map ${h.cells} cells`)
    } catch (e) {
      await page.screenshot({ path: path.join(OUT, `${shot}-error.png`) }).catch(() => {})
      fails.push(`${tag}: ${(e as Error).message.split('\n')[0]}${errors.length ? ` (page error: ${errors[0]})` : ''}`)
    }
    await ctx.close()
  }
} finally {
  await browser.close()
  await server.close()
}
if (fails.length) {
  console.error(`forecast layout check (fix215): FAILED\n${lines.join('\n')}\n${fails.map(f => `  ✗ ${f}`).join('\n')}\n  screenshots: ${path.relative(ROOT, OUT)}`)
  process.exit(1)
}
console.log(`forecast layout check (fix215): ok — ${CASES.length} sports × Pro / Free × ${SCREENS.length} screens; screenshots in ${path.relative(ROOT, OUT)}\n${lines.join('\n')}`)
process.exit(0)

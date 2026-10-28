/**
 * fix256 — the 11 languages at 375 px (`npm run test:fix256`). A headless Chromium opens five pages in every language
 * (home, football matches, a match page, a team page, Premium) at 375×812 on a fixture (every API call answered here)
 * and fails when a page scrolls sideways, a page error is thrown, a line of text sticks out of its box, or a string
 * that should be translated stays in English. Screenshots go to test-output/langs/<lang>-<page>.png (not committed).
 *
 * Browser: as layout-check.ts (PLAYWRIGHT_CHROMIUM, ms-playwright, Chrome / Edge). LANGS_LOG=1 prints every API call.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'test-output', 'langs')
const LANGS = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru']

function findChromium(): string | null {
  if (process.env.PLAYWRIGHT_CHROMIUM && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM
  const home = os.homedir()
  for (const d of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(home, 'AppData', 'Local', 'ms-playwright'), path.join(home, '.cache', 'ms-playwright')].filter(Boolean) as string[]) {
    if (!fs.existsSync(d)) continue
    if (fs.existsSync(path.join(d, 'chromium')) && fs.statSync(path.join(d, 'chromium')).isFile()) return path.join(d, 'chromium')
    for (const b of fs.readdirSync(d).filter(x => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])))
      for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']) if (fs.existsSync(path.join(d, b, exe))) return path.join(d, b, exe)
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']) if (fs.existsSync(p)) return p
  return null
}

/* ---------- fixture: one football evening ---------- */

const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const NAMES = ['Borussia Mönchengladbach', 'Wolverhampton Wanderers', 'Real Sociedad', 'Paris Saint-Germain', 'Athletic Club', 'Internazionale', 'Galatasaray', 'Olympiacos', 'Legia Warszawa', 'Persija Jakarta']
const crestless = (id: number) => ({ id, name: NAMES[id % NAMES.length], shortName: NAMES[id % NAMES.length].split(' ')[0], tla: NAMES[id % NAMES.length].slice(0, 3).toUpperCase(), crest: null })
const COMPS = [{ code: 'BL1', name: 'Bundesliga' }, { code: 'PL', name: 'Premier League' }, { code: 'PD', name: 'Primera Division' }]
const match = (i: number, state: 'live' | 'soon' | 'done') => ({
  id: 1000 + i, utcDate: state === 'soon' ? iso(now + (2 + i) * 3600e3) : state === 'live' ? iso(now - 50 * 60e3) : iso(now - (26 + i) * 3600e3),
  status: state === 'live' ? 'IN_PLAY' : state === 'soon' ? 'TIMED' : 'FINISHED', minute: state === 'live' ? 52 : null,
  competition: { ...COMPS[i % 3], rank: 0 }, season: { id: 2026 }, matchday: 9, homeTeam: crestless(i * 2), awayTeam: crestless(i * 2 + 1),
  score: { winner: state === 'done' ? 'HOME_TEAM' : null, fullTime: state === 'soon' ? { home: null, away: null } : { home: 2, away: 1 }, halfTime: { home: null, away: null } },
  prediction: { model: 'grid-v3', locked: false, home: 47, draw: 28, away: 25, confidence: 'medium', expectedGoals: { home: 1.6, away: 1.1 } }
})
const UPCOMING = [match(0, 'live'), ...Array.from({ length: 10 }, (_, i) => match(i + 1, 'soon'))]
const RESULTS = Array.from({ length: 6 }, (_, i) => match(20 + i, 'done'))
const side = (id: number) => ({ id, name: NAMES[id % NAMES.length], logo: '' })
const fx = (i: number, done: boolean) => ({ matchId: 1000 + i, date: iso(now + (done ? -1 : 1) * (3 + i) * 86400e3), status: done ? 'FT' : 'NS', comp: 'La Liga', compCode: 'PD', home: side(i % 2 ? 2 : i + 3), away: side(i % 2 ? i + 3 : 2), hg: done ? i % 3 : null, ag: done ? 1 : null })
const TEAM_PAGE = {
  team: { id: 2, name: 'Real Sociedad', logo: '', country: 'Spain', founded: 1909, national: false },
  venue: { name: 'Reale Arena', city: 'San Sebastián', capacity: 39500 },
  league: { id: 140, name: 'La Liga', logo: '', season: 2026 },
  standing: { rank: 7, points: 15, played: 10, won: 4, drawn: 3, lost: 3, gf: 13, ga: 11, rows: Array.from({ length: 6 }, (_, i) => ({ rank: 5 + i, id: i === 2 ? 2 : 50 + i, name: i === 2 ? 'Real Sociedad' : NAMES[i], logo: '', played: 10, gd: 3 - i, points: 18 - i, me: i === 2 })) },
  form: ['W', 'D', 'L', 'W', 'W'], last: Array.from({ length: 5 }, (_, i) => fx(i, true)), next: Array.from({ length: 3 }, (_, i) => fx(10 + i, false)),
  squad: Array.from({ length: 8 }, (_, i) => ({ id: 900 + i, name: ['Álex Remiro', 'Aritz Elustondo', 'Igor Zubeldia', 'Martín Zubimendi', 'Brais Méndez', 'Takefusa Kubo', 'Mikel Oyarzabal', 'Ander Barrenetxea'][i], number: i + 1, pos: ['Goalkeeper', 'Defender', 'Defender', 'Midfielder', 'Midfielder', 'Attacker', 'Attacker', 'Attacker'][i], age: 24 + i, photo: null, apps: 10, minutes: 800, goals: i, assists: 1 })),
  scorers: [{ id: 906, name: 'Mikel Oyarzabal', value: 6 }], assists: [{ id: 905, name: 'Takefusa Kubo', value: 4 }], premium: false
}

function answer(u: URL): unknown {
  const p = u.pathname
  if (p === '/api/auth/me') return undefined
  if (p === '/api/matches/upcoming' || p === '/api/matches/today' || p === '/api/matches') return { data: UPCOMING }
  if (p === '/api/public/results') return { data: { rows: [] } }
  if (/^\/api\/slug\/football\/match\//.test(p)) return { data: { id: 1001, slug: 'borussia-vs-wolverhampton-2026-10-28' } }
  if (/^\/api\/slug\/football\/team\//.test(p)) return { data: { id: 2, slug: 'real-sociedad' } }
  if (/^\/api\/slug-of\//.test(p)) return { data: null }
  if (p === '/api/matches/1001') return { data: UPCOMING[1] }
  if (p === '/api/matches/1001/details') return { data: { match: UPCOMING[1], prediction: UPCOMING[1].prediction, homeForm: RESULTS.slice(0, 5), awayForm: RESULTS.slice(1, 6), h2h: RESULTS.slice(0, 3), standings: null } }
  if (p === '/api/team-page/2') return { data: TEAM_PAGE }
  return null
}

const PAGES = [
  { key: 'home', path: '/' },
  { key: 'matches', path: '/football/matches' },
  { key: 'match', path: '/football/match/borussia-vs-wolverhampton-2026-10-28' },
  { key: 'team', path: '/football/team/real-sociedad' },
  { key: 'premium', path: '/premium' }
]
// words that must not stay in English on a translated page (nav and page furniture)
const ENGLISH = /\b(Matches|Sign in|Today|Our pick|Favorites|Accuracy)\b/

/* ---------- run ---------- */

const exe = findChromium()
if (!exe) { console.error('language layout check (fix256): FAILED — no Chromium found (set PLAYWRIGHT_CHROMIUM).'); process.exit(1) }
const only = process.env.LANGS_ONLY ? process.env.LANGS_ONLY.split(',') : LANGS
fs.mkdirSync(OUT, { recursive: true })
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5291, strictPort: false, hmr: false } })
await server.listen()
const base = (server.resolvedUrls?.local[0] || 'http://localhost:5291/').replace(/\/$/, '')
const browser = await chromium.launch({ executablePath: exe, headless: true })
const fails: string[] = []
const lines: string[] = []
try {
  for (const l of only) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, hasTouch: true, locale: 'en-GB' })
    await ctx.addInitScript(() => { try { localStorage.setItem('sl-consent', JSON.stringify({ v: 1, analytics: false, ads: false })) } catch { /* no storage */ } })
    for (const pg of PAGES) {
      const page = await ctx.newPage()
      const errors: string[] = []
      page.on('pageerror', e => errors.push(String(e.message || e)))
      await page.route('**/socket.io/**', r => r.abort())
      await page.route('**/api/**', async r => {
        const u = new URL(r.request().url())
        const body = answer(u)
        if (process.env.LANGS_LOG) console.log('  api', u.pathname + u.search, body ? '(fixture)' : '')
        if (u.pathname === '/api/auth/me') return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"signed out"}' })
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? { data: null }) })
      })
      const tag = `${l} ${pg.key}`
      try {
        await page.goto(base + (l === 'en' ? '' : `/${l}`) + (l !== 'en' && pg.path === '/' ? '' : pg.path), { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForSelector('main', { timeout: 30000 })
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(1200)
        const m = await page.evaluate(() => {
          const vis = (el: Element) => (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0
          const scrollers = '.overflow-x-auto, .overflow-x-scroll, .overflow-hidden, .overflow-x-hidden, .truncate, [class*="line-clamp"], [aria-hidden="true"]'
          const leaf = [...document.body.querySelectorAll('main *, header *, nav *')].filter(el => vis(el) && el.children.length === 0 && (el.textContent || '').trim())
          return {
            lang: document.documentElement.lang,
            scrollW: document.documentElement.scrollWidth, w: window.innerWidth,
            wide: leaf.filter(el => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(scrollers)).slice(0, 3).map(el => (el.textContent || '').trim().slice(0, 30)),
            // a word wider than its box (no wrap point): Hindi / Russian / Greek compound labels
            cut: leaf.filter(el => { const s = getComputedStyle(el); return !el.closest(scrollers) && (el as HTMLElement).clientWidth >= 48 && s.overflow === 'visible' && s.whiteSpace !== 'nowrap' && el.scrollWidth > (el as HTMLElement).clientWidth + 2 && (el as HTMLElement).clientWidth > 0 }).slice(0, 3).map(el => (el.textContent || '').trim().slice(0, 30)),
            nav: [...document.querySelectorAll('nav')].map(n => n.textContent || '').join(' '),
            text: (document.querySelector('main')?.textContent || '').length
          }
        })
        await page.screenshot({ path: path.join(OUT, `${l}-${pg.key}.png`) })
        if (m.lang !== l) fails.push(`${tag}: <html lang="${m.lang}">`)
        if (m.scrollW > m.w + 1) fails.push(`${tag}: the page scrolls sideways (${m.scrollW} px: ${m.wide.join(' | ') || '?'})`)
        else if (m.wide.length) fails.push(`${tag}: text sticks out on the right: ${m.wide.join(' | ')}`)
        if (m.cut.length) fails.push(`${tag}: text wider than its box: ${m.cut.join(' | ')}`)
        if (l !== 'en' && ENGLISH.test(m.nav)) fails.push(`${tag}: English left in the menu ("${ENGLISH.exec(m.nav)![0]}")`)
        if (m.text < 40) fails.push(`${tag}: the page is (nearly) empty`)
        if (errors.length) fails.push(`${tag}: page error — ${errors[0]}`)
        lines.push(`  ${tag.padEnd(14)} ${m.scrollW} px wide · ${m.text} chars`)
      } catch (e) {
        await page.screenshot({ path: path.join(OUT, `${l}-${pg.key}-error.png`) }).catch(() => {})
        fails.push(`${tag}: ${(e as Error).message.split('\n')[0]}`)
      }
      await page.close()
    }
    await ctx.close()
  }
} finally {
  await browser.close()
  await server.close()
}
if (fails.length) {
  console.error(`language layout check (fix256): FAILED\n${lines.join('\n')}\n${fails.map(f => `  ✗ ${f}`).join('\n')}\n  screenshots: ${path.relative(ROOT, OUT)}`)
  process.exit(1)
}
console.log(`language layout check (fix256): ok — ${only.length} languages × ${PAGES.length} pages at 375 px\n${lines.join('\n')}\n  screenshots: ${path.relative(ROOT, OUT)}`)

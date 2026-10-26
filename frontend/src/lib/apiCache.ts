/**
 * fix250: the app never shows a blank page while it waits for the server.
 *
 * Every public GET (/api/…, not the account / admin ones) goes through this axios adapter:
 *  - the last good answer of each address is kept (memory, and localStorage for answers under 300 KB);
 *  - the call times out after 4 s; if the server has not answered after 500 ms and a kept answer exists, the page gets
 *    the kept one at once and the fresh one lands in the store when it comes ('sl:api-fresh' event, useApiFresh);
 *  - the server's { pending: true } (202, X-SL-Pending: its 1-second rule), a time-out, a network error or a 5xx: the
 *    kept answer if there is one, else the call is asked again (0.8 → 6 s apart, for up to ~25 s) while the
 *    "Updating…" pill shows (UpdatingPill) — never an empty page; after that the error goes to the page as before;
 *  - a game page's parts may come from its bundle (lib/gameBundle.ts: primeGame) instead of five calls.
 */
import axios, { getAdapter, type AxiosResponse, type InternalAxiosRequestConfig, AxiosError } from 'axios'
import { useEffect, useRef } from 'react'

const FAST_MS = 500
const TIMEOUT_MS = 4000
const RETRY_MS = [800, 1500, 2500, 4000, 6000, 10000]
const LS_PREFIX = 'sl-api:'
const LS_INDEX = 'sl-api-index'
const LS_MAX_ITEM = 300 * 1024
const LS_MAX_ITEMS = 150
const MEM_MAX = 400
// personal, account, admin and write-like reads are never kept
const NOT_KEPT = /^\/api\/(auth|admin|crm|staff|picks|favorites|unlocks|email|push|billing|testers|perf|assistant|visit|client-error|contact|waitlist|feedback|unsubscribe|draw-alerts|accuracy|history|clv)(\/|$|\?)/

type Kept = { at: number; data: string; primedUntil?: number }
const mem = new Map<string, Kept>()
const memSet = (k: string, e: Kept) => {
  mem.delete(k); mem.set(k, e)
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value as string)
}

/* ---------- localStorage (each read / write in try: private mode, full storage) ---------- */
const lsIndex = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_INDEX) || '[]') } catch { return [] } }
function lsGet(k: string): Kept | null {
  try { const t = localStorage.getItem(LS_PREFIX + k); return t ? (JSON.parse(t) as Kept) : null } catch { return null }
}
function lsSet(k: string, e: Kept) {
  if (e.data.length > LS_MAX_ITEM) return
  try {
    const idx = lsIndex().filter(x => x !== k)
    idx.push(k)
    while (idx.length > LS_MAX_ITEMS) { const old = idx.shift()!; localStorage.removeItem(LS_PREFIX + old) }
    try { localStorage.setItem(LS_PREFIX + k, JSON.stringify({ at: e.at, data: e.data })) } catch {
      // full: drop the older half and try once more
      for (const old of idx.splice(0, Math.ceil(idx.length / 2))) localStorage.removeItem(LS_PREFIX + old)
      localStorage.setItem(LS_PREFIX + k, JSON.stringify({ at: e.at, data: e.data }))
    }
    localStorage.setItem(LS_INDEX, JSON.stringify(idx))
  } catch { /* storage off */ }
}
/** sign-in / sign-out: the kept answers were made for the other person */
export function resetApiCache() {
  mem.clear()
  try { for (const k of lsIndex()) localStorage.removeItem(LS_PREFIX + k); localStorage.removeItem(LS_INDEX) } catch { /* storage off */ }
}

const kept = (k: string): Kept | null => {
  const m = mem.get(k)
  if (m) return m
  const l = lsGet(k)
  if (l) mem.set(k, l)
  return l
}
const keep = (k: string, data: string) => {
  const e = { at: Date.now(), data }
  memSet(k, e)
  lsSet(k, e)
}
/** a fresh answer came after the page was given a kept one: pages that listen (useApiFresh) load again */
const freshAfterKept = (k: string, was: string, r: AxiosResponse | null) => {
  if (r && r.status === 200 && r.data !== was) window.dispatchEvent(new CustomEvent('sl:api-fresh', { detail: k }))
}

/* ---------- the "Updating…" state ---------- */
let waitingN = 0
const listeners = new Set<(n: number) => void>()
const setWaiting = (d: number) => { waitingN = Math.max(0, waitingN + d); listeners.forEach(f => f(waitingN)) }
/** UpdatingPill: how many calls are waiting for the server right now */
export function onWaiting(f: (n: number) => void) { listeners.add(f); f(waitingN); return () => { listeners.delete(f) } }

/* ---------- game bundles (lib/gameBundle.ts) ---------- */
const fromBundle = new Map<string, Promise<string | null>>()
/** these addresses' answers are on their way in one bundle: the calls wait for it (at most 1.5 s) instead of asking */
export function expectFromBundle(keys: string[], parts: Promise<Record<string, unknown> | null>) {
  for (const k of keys) {
    const p = parts.then(all => {
      const v = all ? all[k.replace(/^.*?(\/api\/)/, '/api/')] : undefined
      if (v === undefined || v === null) return null
      const data = JSON.stringify(v)
      memSet(k, { at: Date.now(), data, primedUntil: Date.now() + 15_000 })
      lsSet(k, { at: Date.now(), data })
      return data
    }, () => null).finally(() => setTimeout(() => fromBundle.delete(k), 15_000))
    fromBundle.set(k, p)
  }
}

/* ---------- the adapter ---------- */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '')
const answer = (cfg: InternalAxiosRequestConfig, data: string, how: string): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'x-sl-client-copy': how }, config: cfg, request: null })
const isPending = (r: AxiosResponse) => r.status === 202 || !!(r.headers && (r.headers as any)['x-sl-pending'])
const failedSoft = (e: unknown) => {
  const r = (e as AxiosError)?.response
  return !r || r.status >= 500 || (e as AxiosError)?.code === 'ECONNABORTED' || (e as AxiosError)?.code === 'ETIMEDOUT'
}

export function installApiCache() {
  const base = getAdapter(axios.defaults.adapter)
  axios.defaults.adapter = async (cfg: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const method = (cfg.method || 'get').toLowerCase()
    const k = axios.getUri(cfg)
    const p = pathOf(k)
    if (method !== 'get' || !p.startsWith('/api/') || NOT_KEPT.test(p) || (cfg.responseType && cfg.responseType !== 'json')) return base(cfg)
    cfg.timeout = Math.min(cfg.timeout || TIMEOUT_MS, TIMEOUT_MS)
    // a bundle part that just came: no call at all
    const now = Date.now()
    const m = mem.get(k)
    if (m?.primedUntil && m.primedUntil > now) { m.primedUntil = undefined; return answer(cfg, m.data, 'bundle') }
    const b = fromBundle.get(k)
    if (b) { const d = await Promise.race([b, sleep(1500).then(() => null)]); if (d) { const e = mem.get(k); if (e) e.primedUntil = undefined; return answer(cfg, d, 'bundle') } }

    const ask = (): Promise<AxiosResponse | null> => base(cfg).then(r => {
      if (isPending(r)) return null
      if (r.status === 200 && typeof r.data === 'string' && r.data.length) keep(k, r.data)
      return r
    }, e => { if (failedSoft(e)) return null; throw e })
    const have = kept(k)
    const first = ask()
    if (have) {
      // a kept answer: the server's if it comes within 500 ms, else the kept one now (the fresh one is kept when it comes)
      const r = await Promise.race([first, sleep(FAST_MS).then(() => undefined)])
      if (r) return r
      if (r === undefined) {
        setWaiting(1)
        first.then(x => x || retryInBackground(ask), () => null).then(x => freshAfterKept(k, have.data, x || null)).finally(() => setWaiting(-1))
        return answer(cfg, have.data, 'stale')
      }
      // pending / failed: the kept one, asked again in the background
      void retryInBackground(ask).then(x => freshAfterKept(k, have.data, x))
      return answer(cfg, have.data, 'stale')
    }
    // nothing kept: wait for the server, asking again while it says "pending" (X-SL-Once: asked once, e.g. a bundle)
    let r = await first
    if (r) return r
    if (cfg.headers?.has?.('X-SL-Once')) throw new AxiosError('Updating', 'ECONNABORTED', cfg)
    setWaiting(1)
    try {
      for (const ms of RETRY_MS) {
        await sleep(ms)
        r = await ask()
        if (r) return r
      }
    } finally { setWaiting(-1) }
    throw new AxiosError('Updating — please try again in a moment', 'ECONNABORTED', cfg)
  }
}
async function retryInBackground(ask: () => Promise<AxiosResponse | null>): Promise<AxiosResponse | null> {
  setWaiting(1)
  try {
    for (const ms of RETRY_MS.slice(0, 4)) { await sleep(ms); const r = await ask().catch(() => null); if (r) return r }
    return null
  } finally { setWaiting(-1) }
}

/** re-run `reload` when a fresh answer for this address (any query) was kept (after a kept one was shown) */
export function useApiFresh(prefix: string | null, reload: () => void) {
  const fn = useRef(reload)
  fn.current = reload
  useEffect(() => {
    if (!prefix) return
    let t: ReturnType<typeof setTimeout> | null = null
    const on = (e: Event) => {
      const k = pathOf(String((e as CustomEvent).detail || ''))
      if (!(k === prefix || k.startsWith(`${prefix}?`)) || t) return
      t = setTimeout(() => { t = null; fn.current() }, 50)
    }
    window.addEventListener('sl:api-fresh', on)
    return () => { window.removeEventListener('sl:api-fresh', on); if (t) clearTimeout(t) }
  }, [prefix])
}

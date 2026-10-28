/**
 * fix259: "Copy for Claude to fix" — what the admin / CRM pages send to /api/admin/for-claude (or /api/crm/for-claude for a
 * support message or a customer): the place, the check ids, the cards' text as shown, the /api/perf summary for speed.
 * The server adds the rest and writes the text (backend services/forClaude.ts). Admin and CRM pages only.
 */
import axios from 'axios'
import { API_URL } from './socket'
import {
  ADMIN_TABS, ADMIN_CARDS, cardChecks, cardLevel, healthRule, healthTab,
  type AdminSummary, type AdminTab, type HealthCheck
} from './adminTabs'

export interface ForClaudeReq {
  place: string
  scope: 'check' | 'card' | 'tab' | 'item' | 'site-error' | 'crm-message' | 'crm-customer'
  checks?: { id: string; title?: string; what?: string; todo?: string }[]
  cards?: { id: string; title?: string; text?: string }[]
  shown?: { title?: string; text?: string }[]
  sig?: string
  id?: number
  /** send the /api/perf summary (speed) */
  perf?: boolean
}

export const tabLabel = (t: AdminTab) => ADMIN_TABS.find(x => x.key === t)?.label || t
/** the build this tab runs ("index-AbC123"), like the error reports */
export function buildOfTab(): string {
  const s = [...document.scripts].map(x => x.src).find(x => /\/assets\/index-/.test(x)) || ''
  return (s.match(/index-[A-Za-z0-9_-]+/) || [''])[0]
}

/** button words and other page furniture that mean nothing in the copied text */
const FURNITURE = /^(Copy for Claude|Copy everything red\/yellow on this page for Claude|Copied ✓|Copying…|Undo|Hide|Show( all.*| less| fixed.*)?|Check now|Mark fixed|Reopen|Run now|Loading…|\d+ items?|Copy failed.*)$/
/** a card's text as shown (the page's own words and numbers) */
export function cardText(id: string): string {
  const el = document.querySelector<HTMLElement>(`[data-admin-card="${CSS.escape(id)}"]`)
  return elText(el)
}
export function elText(el: HTMLElement | null | undefined): string {
  if (!el) return ''
  return (el.innerText || el.textContent || '').split('\n').map(l => l.trim()).filter(l => l && !FURNITURE.test(l)).join('\n').slice(0, 16000)
}

export const checkReq = (c: { id: string }) => {
  const r = healthRule(c.id)
  return { id: c.id, title: r?.title, what: r?.what, todo: r?.todo }
}

/** one card: its checks, its text, perf for Speed */
export function cardReq(id: string, checks: HealthCheck[] | null): ForClaudeReq {
  const c = ADMIN_CARDS.find(x => x.id === id)
  const own = c ? cardChecks(c, checks) : []
  return {
    place: `Admin → ${c ? tabLabel(c.tab) : 'Admin'} → ${c?.title || id}`, scope: 'card',
    checks: own.filter(k => k.level !== 'ok').map(checkReq),
    cards: [{ id, title: c?.title, text: cardText(id) }],
    perf: id === 'speed' || own.some(k => k.id.startsWith('perf:'))
  }
}

/** one data-health check (a red / yellow row) */
export function checkOnlyReq(c: HealthCheck): ForClaudeReq {
  const r = healthRule(c.id)
  return { place: `Admin → ${tabLabel(healthTab(c.id))} → ${r?.title || c.label}`, scope: 'check', checks: [checkReq(c)], perf: /^perf:|stall|slow/.test(c.id) }
}

/** the whole tab: every red / yellow check and card on it */
export function tabReq(tab: AdminTab, summary: AdminSummary | null, checks: HealthCheck[] | null): ForClaudeReq {
  const bad = (checks || []).filter(c => healthTab(c.id) === tab && c.level !== 'ok')
  const cards = ADMIN_CARDS.filter(c => c.tab === tab && cardLevel(c, summary, checks) !== 'ok')
  return {
    place: `Admin → ${tabLabel(tab)} (everything red / yellow)`, scope: 'tab',
    checks: bad.map(checkReq),
    cards: cards.map(c => ({ id: c.id, title: c.title, text: cardText(c.id) })),
    perf: tab === 'site' || bad.some(c => c.id.startsWith('perf:'))
  }
}

/** the /api/perf summary, only the parts about speed (the request stays small) */
async function perfSlim(): Promise<unknown> {
  try {
    const d = (await axios.get(`${API_URL}/perf`)).data?.data || {}
    const pick = (o: any, ks: string[]) => Object.fromEntries(ks.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]))
    return {
      web: pick(d.web, ['stallsLastHour', 'worstLastHour', 'uptimeMin', 'memoryMb', 'topStalls', 'diagStalls', 'shortBlocks']),
      worker: pick(d.worker, ['stallsLastHour', 'worstLastHour', 'heapMb', 'heapLimitMb', 'restarts', 'restarts24h', 'lastExit', 'topStalls']),
      slowRequests: d.slowRequests, pageReader: d.pageReader
    }
  } catch { return null }
}

/** asks the server for the text */
export async function forClaudeText(req: ForClaudeReq, api: 'admin' | 'crm' = 'admin'): Promise<string> {
  const { perf, ...body } = req
  const r = await axios.post(`${API_URL}/${api}/for-claude`, { ...body, build: buildOfTab(), perf: perf ? await perfSlim() : undefined })
  return String(r.data?.data?.text || '')
}

/**
 * Copies the text. Safari only lets a page write the clipboard inside the click, so the text goes in as a promise
 * (ClipboardItem); other browsers write it when it arrives; the old way (a hidden text box) last.
 */
export async function copyLater(text: Promise<string>): Promise<void> {
  const W = window as any
  if (W.ClipboardItem && navigator.clipboard?.write) {
    try { await navigator.clipboard.write([new W.ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })]); return } catch { /* next */ }
  }
  const t = await text
  try { await navigator.clipboard.writeText(t); return } catch { /* next */ }
  const ta = document.createElement('textarea')
  ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('The browser did not allow copying')
}

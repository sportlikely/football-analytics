/**
 * fix261: on Hebrew / Arabic pages a score or a range ("2–1", "60–70%", "2026-27") reads left to right, as Israeli and
 * Arab sports sites write it. In right-to-left text the browser reverses a digit–dash–digit run ("2–1" shows as
 * "1–2"), so every such run in the page's text is wrapped in invisible left-to-right isolates (U+2066 … U+2069) as it
 * appears — one observer for the whole page, nothing for other languages. React keeps working: it only ever sets a text
 * node's whole value, which the observer wraps again.
 */
import { isRtl } from './i18n'

const RUN = /(\d+(?:[.,:]\d+)?%?)(\s?[–—-]\s?)(\d+(?:[.,:]\d+)?%?)/g
const OPEN = '⁦', CLOSE = '⁩'

/** a text with its digit–dash–digit runs isolated left to right (already isolated runs are left alone) */
export function isolateRuns(s: string): string {
  if (!/\d\s?[–—-]\s?\d/.test(s)) return s
  return s.replace(RUN, (all, a: string, d: string, b: string, at: number, whole: string) =>
    (whole[at - 1] === OPEN ? all : `${OPEN}${a}${d}${b}${CLOSE}`))
}

function fix(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue || ''
    const w = isolateRuns(v)
    if (w !== v) node.nodeValue = w
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|TEXTAREA|INPUT)$/.test((node as Element).tagName)) return
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) fix(n)
}

export function watchRtlNumbers() {
  if (!isRtl || typeof MutationObserver === 'undefined') return
  const start = () => {
    fix(document.body)
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === 'characterData') fix(m.target)
        else m.addedNodes.forEach(fix)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true })
}

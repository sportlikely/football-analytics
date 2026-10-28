/**
 * Languages. English is the source text: every visible string is written in English in the code and passed through
 * t(); the other languages are dictionaries in src/locales/<lang>.json keyed by the English text.
 *
 * The language is part of the address (sportlikely.com/es/...), so search engines index each language separately.
 * It is fixed for the page load: switching language navigates to the same page under the other prefix.
 * Placeholders: {0}, {1} or {name}. Plurals in a translation: "{n, plural, one {# partido} other {# partidos}}".
 */

export const LANGS = {
  en: { name: 'English', locale: 'en-GB' },
  es: { name: 'Español', locale: 'es-ES' },
  pt: { name: 'Português', locale: 'pt-BR' },
  de: { name: 'Deutsch', locale: 'de-DE' },
  fr: { name: 'Français', locale: 'fr-FR' },
  it: { name: 'Italiano', locale: 'it-IT' },
  tr: { name: 'Türkçe', locale: 'tr-TR' },
  id: { name: 'Bahasa Indonesia', locale: 'id-ID' },
  hi: { name: 'हिन्दी', locale: 'hi-IN' },
  pl: { name: 'Polski', locale: 'pl-PL' },
  el: { name: 'Ελληνικά', locale: 'el-GR' },
  ru: { name: 'Русский', locale: 'ru-RU' },
  // fix257: right to left; Arabic keeps Western digits and the Gregorian calendar (ar-SA's defaults are neither)
  ar: { name: 'العربية', locale: 'ar-SA-u-nu-latn-ca-gregory' },
  he: { name: 'עברית', locale: 'he-IL' }
} as const
export type Lang = keyof typeof LANGS
const CODES = Object.keys(LANGS) as Lang[]
const KEY = 'b2b-lang'

/**
 * fix257: which languages the public sees comes from the server (Railway variable PUBLIC_LANGS, backend
 * utils/langs.ts): the session payload's `langs` (admins: every language). Until it is known: every language but the
 * admin-only ones. The last list is kept so a first-visit redirect never sends someone to a hidden language.
 */
export const ADMIN_ONLY_DEFAULT: readonly Lang[] = ['ar', 'he']
export const RTL_LANGS: readonly Lang[] = ['ar', 'he']
const PUBLIC_KEY = 'sl-public-langs'
const defaultPublic = () => CODES.filter(l => !ADMIN_ONLY_DEFAULT.includes(l))
function storedPublic(): Lang[] {
  try {
    const v = JSON.parse(localStorage.getItem(PUBLIC_KEY) || 'null')
    if (Array.isArray(v)) { const l = v.filter(isLang); if (l.includes('en')) return l }
  } catch { /* private mode */ }
  return defaultPublic()
}
/** The session payload's language list (menu) and, for everyone but admins, the public list kept for next time. */
export function noteLangs(langs: unknown, admin: boolean): Lang[] {
  const l = Array.isArray(langs) ? langs.filter(isLang) : []
  if (!l.length) return admin ? [...CODES] : storedPublic()
  if (!admin) try { localStorage.setItem(PUBLIC_KEY, JSON.stringify(l)) } catch { /* private mode */ }
  return l
}
/** The menu before the session is known. */
export const initialMenuLangs = (): Lang[] => { const l = storedPublic(); return l.includes(lang) ? l : [...l, lang] }

const isLang = (x: unknown): x is Lang => typeof x === 'string' && (CODES as string[]).includes(x)

/** Language prefix of the current address ("/es/matches" → "es"), or null. */
export function langInPath(pathname: string): Lang | null {
  const m = pathname.match(/^\/([a-z]{2})(?=\/|$)/)
  return m && isLang(m[1]) ? m[1] : null
}

function detect(): Lang {
  if (typeof window === 'undefined') return 'en'
  const inPath = langInPath(window.location.pathname)
  if (inPath) return inPath
  return 'en'
}

/** The language of this page load. */
export const lang: Lang = detect()
/** Router basename: "" for English, "/es" for Spanish … */
export const basename = lang === 'en' ? '' : `/${lang}`
/** Locale for dates and numbers (toLocaleDateString etc.). */
export const LOCALE: string = LANGS[lang].locale
/** fix257: writing direction of this page load (<html dir>; layout uses CSS logical properties, so it mirrors). */
export const dir: 'rtl' | 'ltr' = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr'
export const isRtl = dir === 'rtl'
/**
 * fix257: a number with a sign or an apostrophe ("+2", "−1.5", "90'+") inside end-to-left text keeps its order
 * (else the sign moves behind it: "2+"). Wrapped in invisible start-to-right isolates for ar / he only. Plain numbers,
 * "58%" and score pairs ("2–1", home first = on the right) need nothing.
 */
export const ltr = (s: string | number): string => (isRtl ? `\u2066${s}\u2069` : String(s))

/** Address of the same page in another language. */
export function langHref(to: Lang, pathname = window.location.pathname, search = window.location.search, hash = window.location.hash) {
  const bare = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, m => (isLang(m.slice(1)) ? '' : m)) || '/'
  return `${to === 'en' ? '' : `/${to}`}${bare}${search}${hash}`
}

/** Remember the choice and open the same page in that language. */
export function setLang(to: Lang) {
  try {
    localStorage.setItem(KEY, to)
  } catch {
    /* private mode */
  }
  window.location.assign(langHref(to))
}

/**
 * First visit without a language in the address: follow the browser's language (once), unless the visitor chose a
 * language before. Returns true when a redirect was started (the caller should not render).
 */
export function redirectToPreferred(): boolean {
  if (typeof window === 'undefined' || langInPath(window.location.pathname)) return false
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    /* ignore */
  }
  let want: Lang | null = null
  // fix257: the browser's language only when it is public (an admin-only language answers 404 to visitors)
  const pub = storedPublic()
  if (saved) want = isLang(saved) && pub.includes(saved) ? saved : null
  else {
    const nav = (navigator.languages || [navigator.language]).map(l => String(l || '').slice(0, 2).toLowerCase())
    want = (nav.find(l => isLang(l) && pub.includes(l)) as Lang | undefined) || null
  }
  if (want && want !== 'en') {
    window.location.replace(langHref(want))
    return true
  }
  return false
}

/* ---------- dictionary ---------- */

const LOCALE_FILES = import.meta.glob('../locales/*.json') as Record<string, () => Promise<unknown>>

let dict: Record<string, string> = {}
const missing = new Set<string>()

export async function loadLocale(): Promise<void> {
  if (lang === 'en') return
  try {
    const loader = LOCALE_FILES[`../locales/${lang}.json`]
    if (!loader) throw new Error('no dictionary for ' + lang)
    const mod = (await loader()) as { default?: Record<string, string> }
    dict = (mod.default || mod) as Record<string, string>
  } catch (e) {
    console.warn('locale not loaded', lang, e)
  }
}

const rules = new Intl.PluralRules(LOCALE)

/** "{n, plural, one {# partido} other {# partidos}}" → the branch for n. */
function plural(body: string, vars: Record<string, string | number | null | undefined>): string {
  // body: "n, plural, one {...} other {...}"
  const m = body.match(/^\s*([\w]+)\s*,\s*plural\s*,\s*([\s\S]*)$/)
  if (!m) return body
  const n = Number(vars[m[1]])
  const branches: Record<string, string> = {}
  const re = /(=\d+|zero|one|two|few|many|other)\s*\{([^{}]*)\}/g
  let b: RegExpExecArray | null
  while ((b = re.exec(m[2]))) branches[b[1]] = b[2]
  const pick = branches[`=${n}`] ?? branches[Number.isFinite(n) ? rules.select(n) : 'other'] ?? branches.other ?? ''
  return pick.replace(/#/g, String(vars[m[1]]))
}

function fill(s: string, vars?: Record<string, string | number | null | undefined>): string {
  if (!vars) return s
  // plural blocks first (they contain braces of their own)
  let out = s.replace(/\{(\w+\s*,\s*plural\s*,[^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, body) => plural(body, vars))
  out = out.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k] ?? '') : all))
  return out
}

/** Translate an English string (the key). Missing translations fall back to English. */
export function t(key: string, vars?: Record<string, string | number | null | undefined>): string {
  const s = dict[key]
  if (s === undefined && lang !== 'en' && !missing.has(key)) {
    missing.add(key)
    if (import.meta.env?.DEV) console.debug('[i18n] missing', lang, key)
  }
  return fill(s ?? key, vars)
}

/** Keys with no translation in this language (for a quick check in the console). */
export const missingKeys = () => [...missing]

/** <html lang> and hreflang links, for search engines. */
export function applyHeadLang(pathname: string, publicLangs: readonly Lang[] = storedPublic()) {
  document.documentElement.lang = lang
  document.documentElement.dir = dir
  // fix257: hreflang for the public languages only; a page in an admin-only language is never indexed
  const hidden = !publicLangs.includes(lang)
  let robots = document.querySelector('meta[name="robots"][data-lang]')
  if (hidden && !robots) {
    robots = document.createElement('meta')
    robots.setAttribute('name', 'robots')
    robots.setAttribute('content', 'noindex')
    robots.setAttribute('data-lang', '1')
    document.head.appendChild(robots)
  } else if (!hidden && robots) robots.remove()
  const bare = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, m => (isLang(m.slice(1)) ? '' : m)) || '/'
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(el => el.remove())
  const origin = window.location.origin
  for (const code of CODES) {
    if (!publicLangs.includes(code)) continue
    const link = document.createElement('link')
    link.rel = 'alternate'
    link.hreflang = code
    link.href = `${origin}${code === 'en' ? '' : `/${code}`}${bare === '/' ? '' : bare}` || origin
    document.head.appendChild(link)
  }
  const x = document.createElement('link')
  x.rel = 'alternate'
  x.hreflang = 'x-default'
  x.href = `${origin}${bare === '/' ? '' : bare}`
  document.head.appendChild(x)
}

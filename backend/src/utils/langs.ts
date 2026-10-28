/**
 * fix257: the site's languages in one place (frontend twin: frontend/src/lib/i18n.ts LANGS).
 *
 * Every language here is complete (its dictionaries pass `npm run parity`). Which ones the public sees is the Railway
 * variable PUBLIC_LANGS (comma list, e.g. "en,es,pt,de,fr,it,tr,id,hi,pl,el,ru,ar,he"); default = every language except the
 * admin-only ones (ar, he: right-to-left, being reviewed). A language that is not public:
 * - is in the language menu for admins only (the session payload's `langs`),
 * - its prefix (/ar, /he) answers 404 + noindex to everyone else,
 * - has no hreflang, no sitemap entry and no crawler HTML.
 * Flipping one on is the variable alone — no code change.
 */

export const ALL_LANGS = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'] as const;
export type SiteLang = (typeof ALL_LANGS)[number];
/** Languages kept for admins until PUBLIC_LANGS names them. */
export const ADMIN_ONLY_DEFAULT: readonly SiteLang[] = ['ar', 'he'];
/** Written right to left: <html dir="rtl">, emails get dir="rtl" on their table. */
export const RTL_LANGS: readonly SiteLang[] = ['ar', 'he'];

/** Locale for dates and numbers. Arabic: Western digits and the Gregorian calendar (ar-SA's default is neither). */
export const LANG_LOCALE: Record<SiteLang, string> = {
  en: 'en-GB', es: 'es-ES', pt: 'pt-BR', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', tr: 'tr-TR',
  id: 'id-ID', hi: 'hi-IN', pl: 'pl-PL', el: 'el-GR', ru: 'ru-RU', ar: 'ar-SA-u-nu-latn-ca-gregory', he: 'he-IL'
};

export const isSiteLang = (x: unknown): x is SiteLang => typeof x === 'string' && (ALL_LANGS as readonly string[]).includes(x);
export const isRtl = (l: string) => (RTL_LANGS as readonly string[]).includes(l);

let cache: { raw: string | undefined; list: SiteLang[] } | null = null;
/** The languages everyone sees (English always). */
export function publicLangs(): SiteLang[] {
  const raw = process.env.PUBLIC_LANGS;
  if (cache && cache.raw === raw) return cache.list;
  const named = String(raw || '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(isSiteLang);
  const list = named.length ? ALL_LANGS.filter(l => l === 'en' || named.includes(l)) : ALL_LANGS.filter(l => !ADMIN_ONLY_DEFAULT.includes(l));
  cache = { raw, list };
  return list;
}
export const isPublicLang = (l: string) => (publicLangs() as string[]).includes(l);
/** The language menu for this visitor: every language for admins, the public ones for everyone else. */
export const menuLangs = (access: string | undefined): SiteLang[] => (access === 'admin' ? [...ALL_LANGS] : publicLangs());

/** "/(es|pt|…)" — every language prefix (English has none). */
export const LANG_ALT = ALL_LANGS.filter(l => l !== 'en').join('|');
const PREFIX = new RegExp(`^\\/(${LANG_ALT})(?=\\/|$)`);
/** Language of an address ("/he/football" → "he"), English when it has no prefix. */
export const langOfPath = (p: string): SiteLang => (PREFIX.exec(p)?.[1] as SiteLang) || 'en';
/** The address without its language prefix ("/he/football" → "/football"). */
export const stripLang = (p: string) => p.replace(PREFIX, '') || '/';
/** An address under a language that this visitor may not open (non-admins on /ar, /he until they are public). */
export const hiddenLangPath = (p: string, access: string | undefined) => access !== 'admin' && !isPublicLang(langOfPath(p));

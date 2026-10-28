/**
 * fix258: every HTML answer carries the page's own language — the stored crawler copies and the plain app page alike.
 *
 * Live 28 Oct: GET /es/football/matches (and other es / pt / de / fr / it / tr pages) could come back as the plain app
 * page (index.html as built: lang="en", no hreflang, canonical "/") — sent while a copy was being built, for a copy made
 * for an older build, at the 900 ms cut and during a start-up — while /id, /pl … (built fresh after fix256) were right.
 * Now the plain page gets the address's lang, canonical and the 13 hreflang links (12 languages + x-default), and a
 * stored copy without them (copyLooksRight) is treated like an old build: not sent, rebuilt.
 * Pure: no imports (earlyStatic loads it before the app's modules).
 */

export const PAGE_LANGS = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr', 'id', 'hi', 'pl', 'el', 'ru'] as const;
export type PageLang = (typeof PAGE_LANGS)[number];
const PREFIX = /^\/(es|pt|de|fr|it|tr|id|hi|pl|el|ru)(?=\/|$)/;
const SITE = 'https://sportlikely.com';
/** pages that are never indexed (account, sign-in …): lang only, no alternates */
const PRIVATE = /^\/(login|signup|join|forgot|verify|account|reset|admin|crm|quick-check|search)(\/|$)/;

/** '/es/football/matches' → { lang: 'es', path: '/football/matches' } (a tab sub-path stays: callers strip it) */
export function langOfPath(p0: string): { lang: PageLang; path: string } {
  const p = (p0.split('?')[0].replace(/\/+$/, '') || '/');
  const m = PREFIX.exec(p);
  return m ? { lang: m[1] as PageLang, path: p.slice(m[0].length) || '/' } : { lang: 'en', path: p };
}
export const langHref = (lang: PageLang, p: string) => (lang === 'en' ? p : `/${lang}${p === '/' ? '' : p}`);

/** the 13 alternates of a page (every language + x-default = the English address) */
export function hreflangLinks(p: string, site = SITE): string[] {
  return [...PAGE_LANGS.map(l => `<link rel="alternate" hreflang="${l}" href="${site + langHref(l, p)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${site + p}" />`];
}

/** fix235: a tab (/football/match/<slug>/stats) is its page (one canonical) */
const pageOfTab = (p: string) => p.replace(/^(\/[a-z-]+\/(?:match|league)\/[a-z0-9-]+)\/[a-z0-9-]+$/, '$1');

/** index.html for this address: its lang, its canonical / og:url and the hreflang set (none on private pages) */
export function appPageFor(indexHtml: string, reqPath: string, site = SITE): string {
  const { lang, path } = langOfPath(reqPath);
  const page = pageOfTab(path);
  const url = site + langHref(lang, page);
  let out = indexHtml.replace(/<html lang="[^"]*"/, `<html lang="${lang}"`);
  if (PRIVATE.test(path)) return out;
  out = out.replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${url}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${url}" />`);
  if (/hreflang=/.test(out)) return out;
  return out.replace('</head>', `    ${hreflangLinks(page, site).join('\n    ')}\n  </head>`);
}

/** a stored copy fit to send for this language: its own lang, and the full hreflang set unless it is noindex */
export function copyLooksRight(html: string, lang: PageLang): boolean {
  const head = html.slice(0, html.indexOf('</head>') + 1 || 20000);
  if (!head.includes(`<html lang="${lang}"`)) return false;
  if (/<meta name="robots" content="noindex/.test(head)) return true;
  if (!head.includes('hreflang="x-default"')) return false;
  // an English-only page (guides) names only en + x-default; every other page all 12 languages
  const n = (head.match(/hreflang="/g) || []).length;
  return n === 2 || PAGE_LANGS.every(l => head.includes(`hreflang="${l}"`));
}

/**
 * fix206: "How our models work" pages (/how-it-works, /basketball/how-it-works, /american-football/how-it-works,
 * /tennis/how-it-works) and the changelog (/changelog). One source for the app (GET /api/how-it-works/:sport,
 * GET /api/changelog) and the search-engine copy (seo.ts):
 *  - the page text is English keys below, translated with the app's own dictionaries (frontend/src/locales/*.json),
 *    so visitors and crawlers read the same words in every language;
 *  - "what the model looks at" comes from the config next to each model (gridModel.inputs.ts …), checked against the
 *    model's code by scripts/how-it-works.test.ts, so the page can't drift from the code;
 *  - the accuracy table is the sport's record (the same functions as the Accuracy pages: publicRecord, bbRecord,
 *    nflAccuracy, tennisAccuracy), last 365 days, competitions with 20+ finished games only;
 *  - the changelog is docs/changelog.json (newest first, every entry in the seven languages).
 * No odds, no market prices, no betting words. Tennis stays admin-only until TENNIS_PUBLIC=1 (basketball and American
 * football follow their own switches).
 */
import fs from 'fs';
import path from 'path';
import { SL_MODELS, slModel, type ModelSport } from '../utils/modelNames';
import { publicRecord } from './tracking';
import { bbRecord } from './bbModel';
import { nflAccuracy } from './nflModel';
import { tennisAccuracy, tennisPublic } from './tennisSite';
import { bbPublic } from './bbSite';
import { nflPublic } from './nflSite';
import { BB_LEAGUES } from './basketball';
import logger from '../utils/logger';
import { SPORT_TEXT, HIW_TEXT, HIW_SPORTS, type HiwSport } from './howItWorks.text';
import { MODEL_INPUTS as FOOTBALL_INPUTS } from './gridModel.inputs';
import { MODEL_INPUTS as BASKETBALL_INPUTS } from './bbModel.inputs';
import { MODEL_INPUTS as NFL_INPUTS } from './nflModel.inputs';
import { MODEL_INPUTS as TENNIS_INPUTS } from './tennisModel.inputs';
export { HIW_TEXT, HIW_SPORTS, type HiwSport } from './howItWorks.text';

export type HiwLang = 'en' | 'es' | 'pt' | 'de' | 'fr' | 'it' | 'tr';
export const HIW_LANGS: HiwLang[] = ['en', 'es', 'pt', 'de', 'fr', 'it', 'tr'];
/** Competitions with fewer finished games are left out of the table (too few to judge). */
export const HIW_MIN_GAMES = 20;
const DAYS = 365;

export const HIW_PATH: Record<HiwSport, string> = {
  football: '/how-it-works', basketball: '/basketball/how-it-works', 'american-football': '/american-football/how-it-works', tennis: '/tennis/how-it-works'
};
export const hiwSportOfPath = (p: string): HiwSport | null => HIW_SPORTS.find(s => HIW_PATH[s] === p) || null;

/** Open to everyone? (admins see every sport's page before its launch) */
export function hiwPublic(sport: HiwSport | 'all'): boolean {
  if (sport === 'basketball') return bbPublic();
  if (sport === 'american-football') return nflPublic();
  if (sport === 'tennis') return tennisPublic();
  return true;
}

export const INPUTS: Record<HiwSport, { key: string; label: string; detail: string }[]> = {
  football: FOOTBALL_INPUTS.inputs.map(({ key, label, detail }) => ({ key, label, detail })),
  basketball: BASKETBALL_INPUTS.inputs.map(({ key, label, detail }) => ({ key, label, detail })),
  'american-football': NFL_INPUTS.inputs.map(({ key, label, detail }) => ({ key, label, detail })),
  tennis: TENNIS_INPUTS.inputs.map(({ key, label, detail }) => ({ key, label, detail }))
};

/* ---------- translations: the app's own dictionaries ---------- */

const LOCALE_DIRS = [process.env.LOCALES_DIR, path.resolve(__dirname, '../../../frontend/src/locales')].filter(Boolean) as string[];
const dicts = new Map<HiwLang, Record<string, string>>();
function dict(lang: HiwLang): Record<string, string> {
  if (lang === 'en') return {};
  const had = dicts.get(lang);
  if (had) return had;
  let d: Record<string, string> = {};
  const dir = LOCALE_DIRS.find(x => fs.existsSync(path.join(x, `${lang}.json`)));
  try { if (dir) d = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8')); } catch (e: any) { logger.warn(`how-it-works: locale ${lang}: ${e.message}`); }
  dicts.set(lang, d);
  return d;
}
/** t() on the server: the English key in the page's language, {0} / {name} filled in. */
export function tr(lang: HiwLang, key: string, vars: Record<string, string | number> = {}): string {
  const s = dict(lang)[key] || key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const LOCALE: Record<HiwLang, string> = { en: 'en-GB', es: 'es-ES', pt: 'pt-BR', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', tr: 'tr-TR' };
export const hiwDate = (iso: string, lang: HiwLang) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/* ---------- accuracy by competition: the sport's record, last 365 days ---------- */

export interface HiwRow { key: string; name: string; n: number; main: number | null; brier: number | null }
export interface HiwAccuracy { rows: HiwRow[]; total: { n: number; hitRate: number | null } }

const TENNIS_GROUP: Record<string, string> = { slam: 'Grand Slams', atp: 'ATP', wta: 'WTA', challenger: 'Challenger' };
function accuracyRaw(sport: HiwSport): HiwAccuracy {
  if (sport === 'football') {
    const r = publicRecord(DAYS, undefined, 0);
    return {
      rows: r.byCompetition.map(c => ({ key: c.code || c.name, name: c.name, n: c.n, main: c.dc, brier: c.brier })),
      total: { n: r.doubleChance.n, hitRate: r.doubleChance.v3 }
    };
  }
  const r: { total: { n: number; hitRate: number | null }; leagues: { code: string; n: number; hitRate: number | null; brier: number | null }[] } =
    sport === 'basketball' ? bbRecord(DAYS) : sport === 'american-football' ? nflAccuracy(DAYS) : tennisAccuracy(DAYS);
  const name = (code: string) =>
    sport === 'basketball' ? BB_LEAGUES.find(l => l.code === code)?.name || code
      : sport === 'american-football' ? (code === 'NCAA' ? 'College football' : 'NFL')
        : TENNIS_GROUP[code] || code;
  // tennis: the tours only (the surface groups count the same matches twice)
  const leagues = sport === 'tennis' ? r.leagues.filter(l => !l.code.startsWith('s:')) : r.leagues;
  return { rows: leagues.map(l => ({ key: l.code, name: name(l.code), n: l.n, main: l.hitRate, brier: l.brier })), total: { n: r.total.n, hitRate: r.total.hitRate } };
}
const accCache = new Map<HiwSport, { at: number; v: HiwAccuracy }>();
const ACC_TTL = 60 * 60 * 1000;
export function hiwAccuracy(sport: HiwSport): HiwAccuracy {
  const hit = accCache.get(sport);
  if (hit && Date.now() - hit.at < ACC_TTL) return hit.v;
  let v: HiwAccuracy;
  try {
    const raw = accuracyRaw(sport);
    v = { rows: raw.rows.filter(r => r.n >= HIW_MIN_GAMES).sort((a, b) => b.n - a.n), total: raw.total };
  } catch (e: any) {
    logger.warn(`how-it-works accuracy (${sport}): ${e.message}`);
    v = hit?.v || { rows: [], total: { n: 0, hitRate: null } };
  }
  accCache.set(sport, { at: Date.now(), v });
  return v;
}

/* ---------- the page data (English keys + numbers; the app translates) ---------- */

export interface HiwFaq { q: string; a: string; vars?: Record<string, string | number>; list?: string[] }
export function howItWorks(sport: HiwSport) {
  const m = SL_MODELS[sport as ModelSport];
  const x = SPORT_TEXT[sport];
  const accuracy = hiwAccuracy(sport);
  const inputs = INPUTS[sport];
  const model = slModel(sport as ModelSport);
  const faq: HiwFaq[] = [
    accuracy.total.n >= HIW_MIN_GAMES && accuracy.total.hitRate != null
      ? { q: x.faqAccuracy, a: HIW_TEXT.faqAccuracyA, vars: { 0: accuracy.total.hitRate, 1: accuracy.total.n } }
      : { q: x.faqAccuracy, a: HIW_TEXT.faqAccuracyNone },
    { q: HIW_TEXT.faq70Q, a: HIW_TEXT.faq70A },
    { q: HIW_TEXT.faqEditQ, a: HIW_TEXT.faqEditA },
    // {0} = the first four inputs, each translated, joined by the reader's language
    { q: HIW_TEXT.faqInputsQ, a: HIW_TEXT.faqInputsA, list: inputs.slice(0, 4).map(i => i.label) },
    m.since ? { q: HIW_TEXT.faqModelQ, a: HIW_TEXT.faqModelA, vars: { 0: model, 1: m.since } } : { q: HIW_TEXT.faqModelQ, a: HIW_TEXT.faqModelANew, vars: { 0: model } }
  ];
  return {
    sport, path: HIW_PATH[sport],
    model: { name: model, version: m.version, since: m.since },
    title: x.title, mainPick: x.mainPick, predicts: x.predicts, test: HIW_TEXT.test, cant: HIW_TEXT.cant, inputs, accuracy, faq
  };
}

/** A FAQ answer in one language (dates and lists filled in). */
export function faqAnswer(f: HiwFaq, lang: HiwLang): string {
  const vars: Record<string, string | number> = { ...(f.vars || {}) };
  if (f.list) vars[0] = f.list.map(k => tr(lang, k)).join(', ');
  if (f.a === HIW_TEXT.faqModelA && typeof vars[1] === 'string') vars[1] = hiwDate(String(vars[1]), lang);
  return tr(lang, f.a, vars);
}

/* ---------- changelog: docs/changelog.json ---------- */

export interface ChangelogEntry { date: string; sport: HiwSport | 'all'; kind: 'model' | 'site'; version: string | null; text: Record<HiwLang, string> }
const CHANGELOG_FILES = [process.env.CHANGELOG_FILE, path.resolve(__dirname, '../../../docs/changelog.json')].filter(Boolean) as string[];
let changelogCache: { at: number; v: ChangelogEntry[] } | null = null;
export function changelogAll(): ChangelogEntry[] {
  if (changelogCache && Date.now() - changelogCache.at < 10 * 60 * 1000) return changelogCache.v;
  let v: ChangelogEntry[] = [];
  const file = CHANGELOG_FILES.find(f => fs.existsSync(f));
  try { if (file) v = (JSON.parse(fs.readFileSync(file, 'utf8')).entries || []) as ChangelogEntry[]; } catch (e: any) { logger.warn(`changelog: ${e.message}`); }
  v = [...v].sort((a, b) => b.date.localeCompare(a.date));
  changelogCache = { at: Date.now(), v };
  return v;
}
/** Entries of the sports this viewer can see (a sport before its launch: admins only). */
export const changelog = (admin: boolean) => changelogAll().filter(e => admin || hiwPublic(e.sport));
/** "SL Basketball 3.0" for an entry with a version, else null. */
export const entryModel = (e: ChangelogEntry) => (e.version && e.sport !== 'all' ? `${SL_MODELS[e.sport as ModelSport].name} ${e.version}` : null);

/* ---------- search-engine copy ---------- */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const link = (lang: HiwLang, p: string) => (lang === 'en' ? p : `/${lang}${p === '/' ? '' : p}`);
const SITE = 'https://sportlikely.com';

export interface HiwSeo { title: string; description: string; body: string; jsonld?: any[]; noindex?: boolean }
export function howItWorksSeo(pathname: string, lang: HiwLang): HiwSeo | null {
  const T = (k: string, v: Record<string, string | number> = {}) => esc(tr(lang, k, v));
  if (pathname === '/changelog') {
    const list = changelog(false);
    return {
      title: `${tr(lang, HIW_TEXT.changelogTitle)} | SportLikely`,
      description: tr(lang, HIW_TEXT.changelogDescription),
      body: `<h1>${T(HIW_TEXT.changelogTitle)}</h1><p>${T(HIW_TEXT.changelogIntro)}</p><ul>${list.map(e => {
        const m = entryModel(e);
        return `<li><time datetime="${e.date}">${esc(hiwDate(e.date, lang))}</time> · ${T(e.kind === 'model' ? HIW_TEXT.kindModel : HIW_TEXT.kindSite)}${m ? ` · ${esc(m)}` : ''}: ${esc(e.text[lang] || e.text.en)}</li>`;
      }).join('')}</ul><p>${HIW_SPORTS.filter(s => hiwPublic(s)).map(s => `<a href="${link(lang, HIW_PATH[s])}">${T(SPORT_TEXT[s].title)}</a>`).join(' · ')}</p>`
    };
  }
  const sport = hiwSportOfPath(pathname);
  if (!sport) return null;
  const d = howItWorks(sport);
  const title = `${tr(lang, d.title)} | SportLikely`;
  const description = tr(lang, HIW_TEXT.description, { 0: d.model.name });
  if (!hiwPublic(sport)) return { title, description, body: '', noindex: true };
  const ul = (keys: readonly string[]) => `<ul>${keys.map(k => `<li>${T(k)}</li>`).join('')}</ul>`;
  const faq = d.faq.map(f => ({ q: tr(lang, f.q), a: faqAnswer(f, lang) }));
  const rows = d.accuracy.rows;
  const body = `<h1>${T(d.title)}</h1><p>${T(HIW_TEXT.intro, { 0: d.model.name })}</p>`
    + `<h2>${T(HIW_TEXT.hPredict)}</h2>${ul(d.predicts)}`
    + `<h2>${T(HIW_TEXT.hInputs)}</h2><ul>${d.inputs.map(i => `<li><strong>${T(i.label)}</strong>: ${T(i.detail)}</li>`).join('')}</ul>`
    + `<h2>${T(HIW_TEXT.hTest)}</h2>${ul(HIW_TEXT.test)}`
    + `<h2>${T(HIW_TEXT.hCant)}</h2>${ul(HIW_TEXT.cant)}`
    + `<h2>${T(HIW_TEXT.hModel)}</h2><p>${d.model.since ? T(HIW_TEXT.live, { 0: d.model.name, 1: hiwDate(d.model.since, lang) }) : T(HIW_TEXT.notLive, { 0: d.model.name })} <a href="${link(lang, '/changelog')}">${T(HIW_TEXT.changelogLink)}</a></p>`
    + `<h2>${T(HIW_TEXT.hAccuracy)}</h2><p>${T(HIW_TEXT.accuracyNote)} ${T(d.mainPick)}</p>`
    + (rows.length
      ? `<table><thead><tr><th>${T(HIW_TEXT.colCompetition)}</th><th>${T(HIW_TEXT.colGames)}</th><th>${T(HIW_TEXT.colMain)}</th><th>${T(HIW_TEXT.colBrier)}</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(sport === 'tennis' ? tr(lang, r.name) : r.name)}</td><td>${r.n}</td><td>${r.main ?? '–'}%</td><td>${r.brier ?? '–'}</td></tr>`).join('')}</tbody></table><p>${T(HIW_TEXT.brierNote)}</p>`
      : `<p>${T(HIW_TEXT.accuracyEmpty)}</p>`)
    + `<h2>${T(HIW_TEXT.hFaq)}</h2>${faq.map(f => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}`;
  return {
    title, description, body,
    jsonld: [{
      '@context': 'https://schema.org', '@type': 'FAQPage', url: SITE + link(lang, pathname), inLanguage: lang,
      mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
    }]
  };
}

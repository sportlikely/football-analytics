import { t, LOCALE } from './i18n'

/**
 * Public model names (fix191, Yarin): "SL <Sport> <major.minor>" in every sport. Visitors only ever see these; the
 * internal ids (grid-v3, bb-v3, nfl-v1 …) stay on admin pages ("SL Football 3.0 (v3-mix)").
 * Major = a new model, minor = a tested improvement that goes live: bump `version` and `since` here in the same commit.
 * Weekly re-tunes don't change the number. Football's national-team and European-cup engines are part of SL Football.
 * fix192: every id the backend can save or return is listed (old ones too), so visitors never see a raw id.
 * Backend twin: backend/src/utils/modelNames.ts (keep both the same).
 */
export type ModelSport = 'football' | 'basketball' | 'american-football' | 'tennis' | 'baseball'

export const SL_MODELS: Record<ModelSport, { name: string; word: string; version: string; since: string | null; internal: string[] }> = {
  football: { name: 'SL Football', word: 'Football', version: '3.0', since: '2026-10-19', internal: ['v3-mix', 'grid-v3', 'feat-v1', 'v3-weights', 'elo-intl', 'elo-euro', 'dc-history-v2', 'poisson-dc-v1', 'v3', 'v2', 'v1'] },
  basketball: { name: 'SL Basketball', word: 'Basketball', version: '3.0', since: '2026-10-19', internal: ['bb-v3', 'bb-v2', 'bb-v1'] },
  'american-football': { name: 'SL American Football', word: 'American football', version: '1.0', since: '2026-10-19', internal: ['nfl-v1', 'nfl-v2', 'ncaa-v1', 'ncaa-v2'] },
  tennis: { name: 'SL Tennis', word: 'Tennis', version: '1.0', since: null, internal: ['tennis-v1'] },
  baseball: { name: 'SL Baseball', word: 'Baseball', version: '1.0', since: null, internal: [] }
}

/** "SL Football 3.0" — the sport word is translated, "SL" and the number never are. */
export function slModel(sport: ModelSport): string {
  const m = SL_MODELS[sport]
  const word = t(m.word)
  return `${word === m.word ? m.name : `SL ${word}`} ${m.version}`
}

/** fix192: ids a later model may add (nfl-v3, bb-v4 …) still land on the right sport by their prefix. */
const PREFIX: [RegExp, ModelSport][] = [[/^(nfl|ncaa)-/, 'american-football'], [/^bb-/, 'basketball'], [/^tennis-/, 'tennis'], [/^(grid|feat|elo|dc|poisson|v\d)/, 'football']]

/** The sport an internal model id belongs to (null for ids no sport claims). */
export function sportOfModel(id: string | null | undefined): ModelSport | null {
  if (!id) return null
  for (const s of Object.keys(SL_MODELS) as ModelSport[]) if (SL_MODELS[s].internal.includes(id)) return s
  for (const [re, s] of PREFIX) if (re.test(id)) return s
  return null
}

const warned = new Set<string>()
/**
 * Public name for an internal id ("bb-v3" → "SL Basketball 3.0"). fix192: never a raw id — an unknown id gives the
 * page's sport (`sport`; football only as the last fallback) and one console warning.
 */
export function slModelOf(id: string | null | undefined, sport: ModelSport = 'football'): string {
  const s = sportOfModel(id)
  if (s) return slModel(s)
  if (id && !warned.has(id)) { warned.add(id); console.warn(`[modelNames] unknown model id "${id}": add it to SL_MODELS`) }
  return slModel(sport)
}

/** Admin pages: both names, "SL Football 3.0 (v3-mix)". */
export function slAdmin(id: string): string {
  const s = sportOfModel(id)
  return s ? `${slModel(s)} (${id})` : id
}

/** The info line under the name: "Version 3.0 · updated 19 Oct 2026". */
export function slVersionLine(sport: ModelSport): string {
  const m = SL_MODELS[sport]
  const when = m.since ? new Date(`${m.since}T12:00:00Z`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : null
  return when ? t('Version {0} · updated {1}', { 0: m.version, 1: when }) : t('Version {0}', { 0: m.version })
}

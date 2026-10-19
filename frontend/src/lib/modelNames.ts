import { t, LOCALE } from './i18n'

/**
 * Public model names (fix191, Yarin): "SL <Sport> <major.minor>" in every sport. Visitors only ever see these; the
 * internal ids (grid-v3, bb-v3, nfl-v1 …) stay on admin pages ("SL Football 3.0 (v3-mix)").
 * Major = a new model, minor = a tested improvement that goes live: bump `version` and `since` here in the same commit.
 * Weekly re-tunes don't change the number. Football's national-team and European-cup engines are part of SL Football.
 * Backend twin: backend/src/utils/modelNames.ts (keep both the same).
 */
export type ModelSport = 'football' | 'basketball' | 'american-football' | 'tennis' | 'baseball'

export const SL_MODELS: Record<ModelSport, { name: string; word: string; version: string; since: string | null; internal: string[] }> = {
  football: { name: 'SL Football', word: 'Football', version: '3.0', since: '2026-10-19', internal: ['v3-mix', 'grid-v3', 'elo-intl', 'elo-euro'] },
  basketball: { name: 'SL Basketball', word: 'Basketball', version: '3.0', since: '2026-10-19', internal: ['bb-v3'] },
  'american-football': { name: 'SL American Football', word: 'American football', version: '1.0', since: '2026-10-19', internal: ['nfl-v1', 'ncaa-v1'] },
  tennis: { name: 'SL Tennis', word: 'Tennis', version: '1.0', since: null, internal: ['tennis-v1'] },
  baseball: { name: 'SL Baseball', word: 'Baseball', version: '1.0', since: null, internal: [] }
}

/** "SL Football 3.0" — the sport word is translated, "SL" and the number never are. */
export function slModel(sport: ModelSport): string {
  const m = SL_MODELS[sport]
  const word = t(m.word)
  return `${word === m.word ? m.name : `SL ${word}`} ${m.version}`
}

/** The sport an internal model id belongs to (football for anything unknown that isn't another sport's). */
export function sportOfModel(id: string | null | undefined): ModelSport | null {
  if (!id) return null
  for (const s of Object.keys(SL_MODELS) as ModelSport[]) if (SL_MODELS[s].internal.includes(id)) return s
  return null
}

/** Public name for an internal id ("bb-v3" → "SL Basketball 3.0"); unknown ids (old v1/v2) come back as they are. */
export function slModelOf(id: string | null | undefined, fallback: ModelSport = 'football'): string {
  const s = sportOfModel(id)
  return s ? slModel(s) : id ? id : slModel(fallback)
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

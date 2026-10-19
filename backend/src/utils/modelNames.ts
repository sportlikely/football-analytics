/**
 * Public model names (fix191, Yarin): "SL <Sport> <major.minor>" in every sport, for SEO text, emails and share images.
 * Twin of frontend/src/lib/modelNames.ts (keep both the same). Internal ids (grid-v3, bb-v3, nfl-v1 …) are admin-only.
 * Major = a new model, minor = a tested improvement that goes live: bump `version` and `since` in the same commit.
 * fix192: every id the backend can save or return is listed (old ones too), so visitors never see a raw id.
 */
export type ModelSport = 'football' | 'basketball' | 'american-football' | 'tennis' | 'baseball';

export const SL_MODELS: Record<ModelSport, { name: string; version: string; since: string | null; internal: string[] }> = {
  football: { name: 'SL Football', version: '3.0', since: '2026-10-19', internal: ['v3-mix', 'grid-v3', 'feat-v1', 'v3-weights', 'elo-intl', 'elo-euro', 'dc-history-v2', 'poisson-dc-v1', 'v3', 'v2', 'v1'] },
  basketball: { name: 'SL Basketball', version: '3.0', since: '2026-10-19', internal: ['bb-v3', 'bb-v2', 'bb-v1'] },
  'american-football': { name: 'SL American Football', version: '1.0', since: '2026-10-19', internal: ['nfl-v1', 'nfl-v2', 'ncaa-v1', 'ncaa-v2'] },
  tennis: { name: 'SL Tennis', version: '1.0', since: null, internal: ['tennis-v1'] },
  baseball: { name: 'SL Baseball', version: '1.0', since: null, internal: [] }
};

/** "SL Football 3.0" (English; the server's SEO pages and emails are English). */
export const slModel = (sport: ModelSport): string => `${SL_MODELS[sport].name} ${SL_MODELS[sport].version}`;

/** fix192: ids a later model may add (nfl-v3, bb-v4 …) still land on the right sport by their prefix. */
const PREFIX: [RegExp, ModelSport][] = [[/^(nfl|ncaa)-/, 'american-football'], [/^bb-/, 'basketball'], [/^tennis-/, 'tennis'], [/^(grid|feat|elo|dc|poisson|v\d)/, 'football']];

/** The sport an internal model id belongs to (null for ids no sport claims). */
export function sportOfModel(id: string | null | undefined): ModelSport | null {
  if (!id) return null;
  for (const s of Object.keys(SL_MODELS) as ModelSport[]) if (SL_MODELS[s].internal.includes(id)) return s;
  for (const [re, s] of PREFIX) if (re.test(id)) return s;
  return null;
}

const warned = new Set<string>();
/**
 * Public name for an internal id ("bb-v3" → "SL Basketball 3.0"). fix192: never a raw id or null — an unknown id gives
 * the caller's sport (football only as the last fallback) and one warning in the log.
 */
export function slModelOf(id: string | null | undefined, sport: ModelSport = 'football'): string {
  const s = sportOfModel(id);
  if (s) return slModel(s);
  if (id && !warned.has(id)) { warned.add(id); console.warn(`[modelNames] unknown model id "${id}": add it to SL_MODELS`); }
  return slModel(sport);
}

/** Admin text: "SL Football 3.0 (v3-mix)". */
export const slAdmin = (id: string): string => (sportOfModel(id) ? `${slModelOf(id)} (${id})` : id);

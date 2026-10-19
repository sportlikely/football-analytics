/**
 * Public model names (fix191, Yarin): "SL <Sport> <major.minor>" in every sport, for SEO text, emails and share images.
 * Twin of frontend/src/lib/modelNames.ts (keep both the same). Internal ids (grid-v3, bb-v3, nfl-v1 …) are admin-only.
 * Major = a new model, minor = a tested improvement that goes live: bump `version` and `since` in the same commit.
 */
export type ModelSport = 'football' | 'basketball' | 'american-football' | 'tennis' | 'baseball';

export const SL_MODELS: Record<ModelSport, { name: string; version: string; since: string | null; internal: string[] }> = {
  football: { name: 'SL Football', version: '3.0', since: '2026-10-19', internal: ['v3-mix', 'grid-v3', 'elo-intl', 'elo-euro'] },
  basketball: { name: 'SL Basketball', version: '3.0', since: '2026-10-19', internal: ['bb-v3'] },
  'american-football': { name: 'SL American Football', version: '1.0', since: '2026-10-19', internal: ['nfl-v1', 'ncaa-v1'] },
  tennis: { name: 'SL Tennis', version: '1.0', since: null, internal: ['tennis-v1'] },
  baseball: { name: 'SL Baseball', version: '1.0', since: null, internal: [] }
};

/** "SL Football 3.0" (English; the server's SEO pages and emails are English). */
export const slModel = (sport: ModelSport): string => `${SL_MODELS[sport].name} ${SL_MODELS[sport].version}`;

/** Public name for an internal id ("bb-v3" → "SL Basketball 3.0"); null for ids no sport claims. */
export function slModelOf(id: string | null | undefined): string | null {
  if (!id) return null;
  for (const s of Object.keys(SL_MODELS) as ModelSport[]) if (SL_MODELS[s].internal.includes(id)) return slModel(s);
  return null;
}

/** Admin text: "SL Football 3.0 (v3-mix)". */
export const slAdmin = (id: string): string => (slModelOf(id) ? `${slModelOf(id)} (${id})` : id);

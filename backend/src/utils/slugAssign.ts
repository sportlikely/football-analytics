/**
 * fix229: who gets which slug (pure — services/slugs.ts feeds it the rows of the slugs table and the entities of a
 * sport, scripts/slugs.test.mjs tests it).
 *
 * - One primary slug per entity; a slug belongs to one entity of a (sport, kind) forever (never handed to another).
 * - The most important entity (most games) gets the plain slug: FC Barcelona → barcelona; the next one with the same
 *   name gets its full name + country (Barcelona SC → barcelona-sc-ecuador), a league the country
 *   (premier-league-russia), a player the team, then the birth year; -2, -3 … when all of those are taken.
 * - A rename (the plain slug of the name changed) gives a new primary; the old one stays as an alias (301 to the new).
 * - Every other name an entity is known by (short / full names) becomes an alias when nobody holds that slug.
 */
import { plainSlug, slugify, teamSlug, matchSlug, type LinkKind } from './slugRules';

export interface SlugRow { slug: string; id: string; primary: boolean; base: string | null }
export interface SlugEntity {
  id: string;
  name: string;
  /** other names (short / full / older) — aliases when free */
  names?: string[];
  /** importance: more games = first claim on the plain slug */
  weight: number;
  country?: string | null;
  /** players: the team's slug; matches: unused */
  team?: string | null;
  year?: string | number | null;
  /** a fixed slug (league codes: PL → premier-league, tennis tournament keys) */
  fixed?: string | null;
}
export interface MatchEntity { id: string; home: string; away: string; date: string | null; weight?: number }

/** the plain slug an entity asks for (its fixed one, else from its name) */
export const baseOf = (kind: LinkKind, e: SlugEntity) => e.fixed || plainSlug(kind, e.name) || `${kind}-${e.id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function candidates(kind: LinkKind, e: SlugEntity, base: string): string[] {
  const out = [base];
  const raw = slugify(e.name);
  const c = e.country ? slugify(e.country) : '';
  if (kind === 'team') {
    if (raw && raw !== base) out.push(raw);
    if (c) out.push(`${raw || base}-${c}`, `${base}-${c}`);
  } else if (kind === 'league') {
    if (c) out.push(`${base}-${c}`);
    if (raw && raw !== base) out.push(raw);
  } else if (kind === 'player') {
    if (e.team) out.push(`${base}-${e.team}`);
    if (e.year) out.push(`${base}-${e.year}`);
    if (c) out.push(`${base}-${c}`);
  }
  return [...new Set(out.filter(Boolean))];
}

export interface AssignResult { add: SlugRow[]; demote: string[]; promote: SlugRow[] }

/**
 * New rows for `ents` given the rows already stored. `add` = rows to insert, `demote` = slugs that stop being an
 * entity's primary (they stay as its alias), `promote` = alias slugs that become an entity's primary again.
 */
export function assignSlugs(kind: LinkKind, existing: SlugRow[], ents: SlugEntity[]): AssignResult {
  const owner = new Map<string, string>();
  const primary = new Map<string, SlugRow>();
  for (const r of existing) { owner.set(r.slug, r.id); if (r.primary) primary.set(r.id, r); }
  const add: SlugRow[] = [], demote: string[] = [], promote: SlugRow[] = [];
  const order = [...ents].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const free = (s: string, id: string) => !owner.has(s) || owner.get(s) === id;
  for (const e of order) {
    const base = baseOf(kind, e);
    const cur = primary.get(e.id);
    if (cur && (cur.base === base || cur.slug === base)) continue;
    // new, or renamed: the first free candidate (an old alias of the same entity counts as free)
    let pick = candidates(kind, e, base).find(s => free(s, e.id));
    for (let n = 2; !pick; n++) if (free(`${base}-${n}`, e.id)) pick = `${base}-${n}`;
    if (cur) { demote.push(cur.slug); cur.primary = false; }
    const row: SlugRow = { slug: pick, id: e.id, primary: true, base };
    if (owner.get(pick) === e.id) promote.push(row); else add.push(row);
    owner.set(pick, e.id);
    primary.set(e.id, row);
  }
  for (const e of order) {
    for (const n of e.names || []) {
      const s = kind === 'team' ? teamSlug(n) : slugify(n);
      if (s && !owner.has(s)) { owner.set(s, e.id); add.push({ slug: s, id: e.id, primary: false, base: null }); }
    }
  }
  return { add, demote, promote };
}

/** match slugs: <home>-vs-<away>-<day>, a second game of the same teams that day -2 (kept once given) */
export function assignMatchSlugs(existing: Set<string>, ents: MatchEntity[]): SlugRow[] {
  const out: SlugRow[] = [];
  for (const e of [...ents].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id < b.id ? -1 : 1))) {
    const base = matchSlug(e.home, e.away, e.date);
    let s = base;
    for (let n = 2; existing.has(s); n++) s = `${base}-${n}`;
    existing.add(s);
    out.push({ slug: s, id: e.id, primary: true, base });
  }
  return out;
}

/**
 * fix201: basketball standings, one table per group. API-Basketball's /standings answer is a list of row arrays, but an
 * array can hold rows of several groups (NBA: 30 conference rows + 30 division rows under one "Western Conference"
 * heading) and several stages (pre-season next to the regular season). Here every row goes to its own (stage, group)
 * table, rows are re-ranked inside the table, and only the stage that matters is kept:
 *  - the latest regular stage with a played game (else the latest pre-season with one, else the first regular stage);
 *  - play-in / playoff tables with played games show above it (heading prefixed with the stage when it would repeat);
 *  - a pre-season table is never shown once the regular season has a played game.
 * Levels: "conference" (shown by default), "division" (behind the Divisions toggle), "group" (A / B / one table).
 * The site (game, team and league pages) reads only this output, so the three places can't disagree.
 */

export type StandLevel = 'conference' | 'division' | 'group';
export type StageKind = 'pre' | 'regular' | 'post';
export interface StandRow {
  position: number; team: { id: number; name: string; logo: string | null };
  played: number; won: number; lost: number; pct: number | null;
  pointsFor: number | null; pointsAgainst: number | null; form: string | null;
}
export interface StandGroup { name: string | null; stage: string | null; level: StandLevel; kind: StageKind; rows: StandRow[] }

const ALL_STAR = /all.?star/i;

export function stageKind(stage: string | null | undefined): StageKind {
  const s = stage || '';
  if (/pre.?season/i.test(s)) return 'pre';
  if (/play.?in|play.?off|final|knock.?out|quarter|semi/i.test(s)) return 'post';
  return 'regular';
}

export function levelOf(name: string | null | undefined): StandLevel {
  const s = name || '';
  if (/division/i.test(s)) return 'division';
  if (/conference/i.test(s)) return 'conference';
  return 'group';
}

const shapeRow = (r: any): StandRow => ({
  position: Number(r.position) || 0,
  team: { id: r.team?.id, name: r.team?.name, logo: r.team?.logo ?? null },
  played: r.games?.played ?? 0, won: r.games?.win?.total ?? 0, lost: r.games?.lose?.total ?? 0, pct: null,
  pointsFor: r.points?.for ?? null, pointsAgainst: r.points?.against ?? null, form: r.form || null
});

/** win %, then wins, then point difference (per game), then the name: positions 1..n inside the table */
export function rankRows(rows: StandRow[]): StandRow[] {
  const pct = (r: StandRow) => (r.played ? r.won / r.played : -1);
  const diff = (r: StandRow) => (r.pointsFor !== null && r.pointsAgainst !== null && r.played ? (r.pointsFor - r.pointsAgainst) / r.played : 0);
  return [...rows]
    .sort((a, b) => pct(b) - pct(a) || b.won - a.won || diff(b) - diff(a) || String(a.team.name).localeCompare(String(b.team.name)))
    .map((r, i) => ({ ...r, position: i + 1, pct: r.played ? Math.round((r.won / r.played) * 1000) / 1000 : null }));
}

const LEVEL_ORDER: Record<StandLevel, number> = { conference: 0, group: 1, division: 2 };

/** The provider's `response` (any nesting) → the tables to show. */
export function groupStandings(response: any): StandGroup[] {
  const flat: any[] = [];
  const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object' && x.team) flat.push(x); };
  walk(response);
  // one bucket per (stage, group name), in the order the provider gives them
  const buckets = new Map<string, { name: string | null; stage: string | null; rows: Map<number, StandRow> }>();
  for (const r of flat) {
    const stage: string | null = r.stage || null, name: string | null = r.group?.name || null;
    if (ALL_STAR.test(stage || '') || ALL_STAR.test(name || '') || r.team?.id == null) continue;
    const key = `${stage}|${name}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { name: name || stage, stage, rows: new Map() }));
    const row = shapeRow(r), had = b.rows.get(row.team.id);
    if (!had || row.played > had.played) b.rows.set(row.team.id, row);
  }
  const all = [...buckets.values()].filter(b => b.rows.size >= 3).map(b => ({
    name: b.name, stage: b.stage, level: levelOf(b.name), kind: stageKind(b.stage), rows: rankRows([...b.rows.values()])
  } as StandGroup));
  if (!all.length) return [];
  // stages in provider order with their games played
  const stages: { stage: string | null; kind: StageKind; played: number }[] = [];
  for (const g of all) {
    let s = stages.find(x => x.stage === g.stage);
    if (!s) stages.push((s = { stage: g.stage, kind: g.kind, played: 0 }));
    s.played += g.rows.reduce((a, r) => a + r.played, 0);
  }
  const last = (k: StageKind, played: boolean) => [...stages].reverse().find(s => s.kind === k && (!played || s.played > 0));
  const main = last('regular', true) || last('pre', true) || stages.find(s => s.kind === 'regular') || stages[0];
  const mainGroups = all.filter(g => g.stage === main.stage).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const post = main.kind === 'regular' ? all.filter(g => g.kind === 'post' && stages.find(s => s.stage === g.stage)!.played > 0) : [];
  // never two tables under the same heading: a playoff "Western Conference" becomes "Playoffs · Western Conference"
  const used = new Set(mainGroups.map(g => g.name));
  const postNamed = post.map(g => (used.has(g.name) && g.stage && g.stage !== g.name ? { ...g, name: `${g.stage} · ${g.name}` } : g));
  const out: StandGroup[] = [];
  const seen = new Set<string | null>();
  for (const g of [...postNamed, ...mainGroups]) { if (seen.has(g.name)) continue; seen.add(g.name); out.push(g); }
  return out;
}

/** fix201 data health: a table whose rows are not unique teams, or a team in two tables of the same level and stage. */
export function standingsIssues(groups: StandGroup[]): string[] {
  const issues: string[] = [];
  const where = new Map<string, string>();
  for (const g of groups) {
    const ids = g.rows.map(r => r.team.id);
    if (new Set(ids).size !== ids.length) issues.push(`${g.name}: ${ids.length - new Set(ids).size} team(s) listed twice`);
    for (const r of g.rows) {
      const key = `${g.kind}|${g.stage}|${g.level}|${r.team.id}`;
      const had = where.get(key);
      if (had && had !== g.name) issues.push(`${r.team.name} is in ${had} and ${g.name}`);
      else where.set(key, g.name || '');
    }
  }
  return issues;
}

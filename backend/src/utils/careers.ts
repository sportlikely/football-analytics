/**
 * fix267 — the whole career on every player page, every sport (football has had it since fix152): the pure parts.
 * services/playerCareers.ts fetches and stores the providers' seasons (player_seasons); this file turns provider
 * answers into season lines and season lines into the one table shape every sport's page renders
 * (frontend components/sport/CareerTable.tsx). No database, no network: tested in scripts/fix267.test.ts.
 */

export type CareerSport = 'basketball' | 'american-football' | 'tennis';
export type CareerKind = 'regular' | 'playoffs';
export interface CareerTeam { id: number | null; name: string; logo: string | null }
/** One season (tennis: one year) of one player at one team in one league, regular season or playoffs. */
export interface CareerLine {
  season: string; // shown: '2023-24' (basketball), '2023' (NFL, tennis)
  order: number; // the season's start year (sorting)
  kind: CareerKind;
  league: { code: string | null; name: string } | null;
  team: CareerTeam | null;
  /** the other teams of the same season (a trade: balldontlie's season line covers both) */
  also?: CareerTeam[];
  gp: number | null;
  stats: Record<string, number | string | null>;
  source: string; // where the numbers come from (shown under the table)
}
export interface CareerCol { key: string; kind: 'int' | 'dec' | 'pct' | 'text' }
export interface CareerView {
  sport: CareerSport;
  /** NFL: the position group the columns follow (qb, rb, wr, def, k, p, other) */
  group: string | null;
  columns: CareerCol[];
  parts: CareerKind[];
  rows: CareerLine[];
  totals: Partial<Record<CareerKind, { gp: number; stats: Record<string, number | string | null> }>>;
  highs: { key: string; value: number | string; season: string }[];
  seasons: number;
  from: string | null;
  partial: boolean;
  partialWhy: string | null;
  sources: string[];
}

export const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null;
  const v = Number(String(x).replace(/,/g, '').trim());
  return Number.isFinite(v) ? v : null;
};
const r1 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pctOf = (m: number, a: number) => (a > 0 ? Math.round((1000 * m) / a) / 10 : null);

/* ------------------------------------------------------------------ */
/* Basketball                                                           */
/* ------------------------------------------------------------------ */

export const BB_COLS: CareerCol[] = [
  { key: 'min', kind: 'dec' }, { key: 'pts', kind: 'dec' }, { key: 'reb', kind: 'dec' }, { key: 'ast', kind: 'dec' },
  { key: 'stl', kind: 'dec' }, { key: 'blk', kind: 'dec' }, { key: 'fgPct', kind: 'pct' }, { key: 'tpPct', kind: 'pct' }, { key: 'ftPct', kind: 'pct' }
];
/** made / attempted per game, kept (hidden) so career percentages are exact sums, not averages of averages */
const BB_SHOTS = ['fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta'] as const;

/** '2023-24' from 2023 */
export const bbLabel = (start: number) => `${start}-${String(start + 1).slice(2)}`;
/** API-Basketball season text ('2023-2024' or '2023') → start year */
export const bbStart = (season: string) => Number(String(season).slice(0, 4));

/** balldontlie season averages (base) → a line. pct fields are 0–1 in balldontlie. */
export function bdlLine(stats: any, season: number, kind: CareerKind, team: CareerTeam | null): CareerLine | null {
  const gp = num(stats?.gp);
  if (!stats || !gp) return null;
  const minOf = (m: any) => { if (m == null) return null; const s = String(m); if (s.includes(':')) { const [a, b] = s.split(':'); return (+a || 0) + (+b || 0) / 60; } return num(s); };
  const p = (x: any) => (num(x) == null ? null : r1(num(x)! * (num(x)! <= 1 ? 100 : 1)));
  const s: Record<string, number | null> = {
    min: r1(minOf(stats.min)), pts: r1(num(stats.pts)), reb: r1(num(stats.reb)), ast: r1(num(stats.ast)), stl: r1(num(stats.stl)), blk: r1(num(stats.blk)),
    fgPct: p(stats.fg_pct), tpPct: p(stats.fg3_pct), ftPct: p(stats.ft_pct),
    fgm: num(stats.fgm), fga: num(stats.fga), tpm: num(stats.fg3m), tpa: num(stats.fg3a), ftm: num(stats.ftm), fta: num(stats.fta)
  };
  return { season: bbLabel(season), order: season, kind, league: { code: 'NBA', name: 'NBA' }, team, gp, stats: s, source: 'balldontlie' };
}

/**
 * API-Basketball game lines of one season (/games/statistics/players?player=&season=) → one line per team and league.
 * `where(gameId, teamId)` says the league and stage (our games): false = left out (pre-season); a null league = a game
 * of a competition we don't follow, kept under the team as "other games".
 */
export function apiBbLines(rows: any[], seasonText: string, where: (gameId: number, teamId: number) => { league: { code: string | null; name: string } | null; playoffs: boolean } | false,
  teamOf: (teamId: number) => CareerTeam | null): CareerLine[] {
  const minOf = (m: any) => { if (m == null || m === '') return 0; const s = String(m); if (s.includes(':')) { const [a, b] = s.split(':'); return (+a || 0) + (+b || 0) / 60; } return num(s) || 0; };
  const by = new Map<string, { lg: { code: string | null; name: string } | null; kind: CareerKind; teamId: number; gp: number; t: Record<string, number> }>();
  for (const r of rows || []) {
    const min = minOf(r.minutes);
    if (!(min > 0)) continue; // on the bench: not a game played
    const teamId = num(r.team?.id) ?? 0, gameId = num(r.game?.id) ?? 0;
    const w = where(gameId, teamId);
    if (w === false) continue;
    const kind: CareerKind = w.playoffs ? 'playoffs' : 'regular';
    const k = `${teamId}|${w.league?.code ?? ''}|${kind}`;
    const x = by.get(k) || { lg: w.league, kind, teamId, gp: 0, t: {} as Record<string, number> };
    const add = (key: string, v: any) => { const n = num(v); if (n != null) x.t[key] = (x.t[key] || 0) + n; };
    x.gp++;
    add('min', min); add('pts', r.points); add('reb', r.rebounds?.total ?? r.rebounds); add('ast', r.assists);
    add('fgm', r.field_goals?.total); add('fga', r.field_goals?.attempts); add('tpm', r.threepoint_goals?.total); add('tpa', r.threepoint_goals?.attempts);
    add('ftm', r.freethrows_goals?.total); add('fta', r.freethrows_goals?.attempts);
    by.set(k, x);
  }
  const start = bbStart(seasonText);
  return [...by.values()].map(x => ({
    season: seasonText.includes('-') ? bbLabel(start) : String(start), order: start, kind: x.kind, league: x.lg, team: teamOf(x.teamId), gp: x.gp,
    stats: perGame(x.t, x.gp), source: 'API-Basketball'
  }));
}

/** totals of a season → per-game line (percentages from made / attempted) */
export function perGame(t: Record<string, number>, gp: number): Record<string, number | null> {
  const per = (k: string) => (t[k] == null || !gp ? null : r1(t[k] / gp));
  return {
    min: per('min'), pts: per('pts'), reb: per('reb'), ast: per('ast'), stl: per('stl'), blk: per('blk'),
    fgPct: pctOf(t.fgm || 0, t.fga || 0), tpPct: pctOf(t.tpm || 0, t.tpa || 0), ftPct: pctOf(t.ftm || 0, t.fta || 0),
    fgm: per('fgm'), fga: per('fga'), tpm: per('tpm'), tpa: per('tpa'), ftm: per('ftm'), fta: per('fta')
  };
}

/* ------------------------------------------------------------------ */
/* American football                                                    */
/* ------------------------------------------------------------------ */

export const NFL_GROUP_COLS: Record<string, CareerCol[]> = {
  qb: ['cmp', 'att', 'cmpPct', 'passYds', 'passTd', 'int', 'rate', 'rushYds', 'rushTd'].map(k => ({ key: k, kind: ['cmpPct', 'rate'].includes(k) ? 'dec' : 'int' } as CareerCol)),
  rb: ['car', 'rushYds', 'ypc', 'rushTd', 'rec', 'recYds', 'recTd'].map(k => ({ key: k, kind: k === 'ypc' ? 'dec' : 'int' } as CareerCol)),
  wr: ['rec', 'tgt', 'recYds', 'ypr', 'recTd', 'lng'].map(k => ({ key: k, kind: k === 'ypr' ? 'dec' : 'int' } as CareerCol)),
  def: ['tackles', 'solo', 'sacks', 'int', 'pd', 'ff'].map(k => ({ key: k, kind: k === 'sacks' ? 'dec' : 'int' } as CareerCol)),
  k: ['fgm', 'fga', 'fgPct', 'lng', 'xpm', 'xpa', 'kPts'].map(k => ({ key: k, kind: k === 'fgPct' ? 'dec' : 'int' } as CareerCol)),
  p: ['punts', 'puntYds', 'puntAvg', 'in20', 'lng'].map(k => ({ key: k, kind: k === 'puntAvg' ? 'dec' : 'int' } as CareerCol))
};
/** every stat key we keep, in the order 'other' shows them */
const NFL_ALL = ['cmp', 'att', 'passYds', 'passTd', 'int', 'rushYds', 'rushTd', 'car', 'rec', 'tgt', 'recYds', 'recTd', 'tackles', 'solo', 'sacks', 'pd', 'ff', 'fgm', 'fga', 'xpm', 'xpa', 'kPts', 'punts', 'puntYds', 'in20'];

/** position → the column group of the career table */
export function nflGroupOf(position: string | null | undefined): string {
  const p = String(position || '').toUpperCase().trim();
  if (/^QB/.test(p) || /QUARTERBACK/.test(p)) return 'qb';
  if (/^(RB|HB|FB)$/.test(p) || /RUNNING|FULLBACK/.test(p)) return 'rb';
  if (/^(WR|TE)$/.test(p) || /RECEIVER|TIGHT/.test(p)) return 'wr';
  if (/^(PK|K)$/.test(p) || /KICKER/.test(p)) return 'k';
  if (/^P$/.test(p) || /PUNTER/.test(p)) return 'p';
  if (/^(DE|DT|NT|DL|LB|OLB|ILB|MLB|CB|S|FS|SS|DB|EDGE)$/.test(p) || /LINEBACK|CORNER|SAFETY|DEFENS|TACKLE|END/.test(p)) return 'def';
  return 'other';
}

/** "21/32", "21-32", "2-14" → [21, 32] */
const pair = (v: any): [number, number] | null => {
  const m = /^\s*([\d,]+)\s*[/-]\s*([\d,]+)\s*$/.exec(String(v ?? ''));
  return m ? [num(m[1])!, num(m[2])!] : null;
};

/**
 * One player's groups ({ name: 'Passing', statistics: [{ name, value }] } as API-American-Football gives them, season
 * totals or one game's box score) → our keys. Season endpoint and box score name things differently: both are read.
 */
export function nflStatsOf(groups: { name: string; statistics: { name: string; value: any }[] }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const set = (k: string, v: number | null, keep = false) => { if (v == null) return; if (keep && out[k] != null) return; out[k] = v; };
  for (const g of groups || []) {
    const gn = String(g?.name || '').toLowerCase();
    for (const s of g?.statistics || []) {
      const n = String(s?.name || '').toLowerCase().trim(), v = s?.value;
      if (/^passing$/.test(gn)) {
        if (/comp(letions)?\s*(\/|-)?\s*att/.test(n) && pair(v)) { set('cmp', pair(v)![0]); set('att', pair(v)![1]); }
        else if (/^(completions|comp|cmp)$/.test(n)) set('cmp', num(v));
        else if (/^(passing )?attempts$|^att$/.test(n)) set('att', num(v));
        else if (/^(passing )?(yards|yds)$/.test(n)) set('passYds', num(v));
        else if (/touch ?downs?|^tds?$/.test(n) && !/intercept/.test(n)) set('passTd', num(v));
        else if (/^(interceptions|ints?)$/.test(n)) set('int', num(v), true);
        else if (/rating/.test(n)) set('rate', num(v));
      } else if (/^rushing$/.test(gn)) {
        if (/^(total )?rushes$|rushing attempts|^att(empts)?$|^car(ries)?$/.test(n)) set('car', num(v));
        else if (/^(rushing )?(yards|yds)$/.test(n)) set('rushYds', num(v));
        else if (/touch ?downs?|^tds?$/.test(n)) set('rushTd', num(v));
      } else if (/^receiving$/.test(gn)) {
        if (/receptions|^rec$/.test(n)) set('rec', num(v));
        else if (/targets|^tgts?$/.test(n)) set('tgt', num(v));
        else if (/^(receiving )?(yards|yds)$/.test(n)) set('recYds', num(v));
        else if (/touch ?downs?|^tds?$/.test(n)) set('recTd', num(v));
        else if (/long/.test(n)) set('lng', num(v));
      } else if (/defens/.test(gn)) {
        if (/^(total tackles|tackles|tot)$/.test(n)) set('tackles', num(v));
        else if (/unassisted|^solo/.test(n)) set('solo', num(v));
        else if (/^sacks?$/.test(n)) set('sacks', pair(v)?.[0] ?? num(v));
        else if (/passes defended|^pd$|passes defensed/.test(n)) set('pd', num(v));
        else if (/forced fumbles?|^ff$/.test(n)) set('ff', num(v));
        else if (/^interceptions?$|^ints?$/.test(n)) set('int', num(v));
      } else if (/intercept/.test(gn)) {
        if (/^(total )?interceptions$|^ints?$|^total$/.test(n)) set('int', num(v));
      } else if (/kicking/.test(gn)) {
        if (/^field goals?$/.test(n) && pair(v)) { set('fgm', pair(v)![0]); set('fga', pair(v)![1]); }
        else if (/field goals? made/.test(n)) set('fgm', num(v));
        else if (/field goals? att/.test(n)) set('fga', num(v));
        else if (/^extra points?$/.test(n) && pair(v)) { set('xpm', pair(v)![0]); set('xpa', pair(v)![1]); }
        else if (/extra points? made/.test(n)) set('xpm', num(v));
        else if (/extra points? att/.test(n)) set('xpa', num(v));
        else if (/long/.test(n)) set('lng', num(v));
        else if (/^(total )?points$/.test(n)) set('kPts', num(v));
      } else if (/punting/.test(gn)) {
        if (/^(total|punts)$/.test(n)) set('punts', num(v));
        else if (/^(gross )?(punting )?yards$/.test(n)) set('puntYds', num(v));
        else if (/in ?20|inside 20/.test(n)) set('in20', num(v));
        else if (/long/.test(n)) set('lng', num(v));
      }
    }
  }
  return out;
}

/** NFL passer rating from totals (the official formula) */
export function passerRating(cmp: number, att: number, yds: number, td: number, int: number): number | null {
  if (!(att > 0)) return null;
  const c = (x: number) => Math.max(0, Math.min(2.375, x));
  const a = c((cmp / att - 0.3) * 5), b = c((yds / att - 3) * 0.25), d = c((td / att) * 20), e = c(2.375 - (int / att) * 25);
  return r1(((a + b + d + e) / 6) * 100);
}

/** totals → the derived columns (completion %, yards per carry / catch, FG %, punt average; rating when missing) */
export function nflDerived(s: Record<string, number | string | null>): Record<string, number | string | null> {
  const o = { ...s };
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : null);
  if (n('att')) { o.cmpPct = pctOf(n('cmp') || 0, n('att')!); if (n('rate') == null) o.rate = passerRating(n('cmp') || 0, n('att')!, n('passYds') || 0, n('passTd') || 0, n('int') || 0); }
  if (n('car')) o.ypc = r1((n('rushYds') || 0) / n('car')!);
  if (n('rec')) o.ypr = r1((n('recYds') || 0) / n('rec')!);
  if (n('fga')) o.fgPct = pctOf(n('fgm') || 0, n('fga')!);
  if (n('punts')) o.puntAvg = r1((n('puntYds') || 0) / n('punts')!);
  return o;
}

/** the columns an NFL career shows: the position's group, else every stat the player has */
export function nflColumns(group: string, lines: CareerLine[]): CareerCol[] {
  const has = (k: string) => lines.some(l => l.stats[k] != null && l.stats[k] !== 0);
  const base = NFL_GROUP_COLS[group];
  if (base && base.some(c => has(c.key))) return base;
  const derived: Record<string, string> = { att: 'cmpPct', car: 'ypc', rec: 'ypr', fga: 'fgPct', punts: 'puntAvg' };
  const out: CareerCol[] = [];
  for (const k of NFL_ALL) if (has(k)) { out.push({ key: k, kind: k === 'sacks' ? 'dec' : 'int' }); if (derived[k]) out.push({ key: derived[k], kind: 'dec' }); }
  return out.slice(0, 9);
}

/* ------------------------------------------------------------------ */
/* Tennis                                                               */
/* ------------------------------------------------------------------ */

/** One match of the player, from our feed or the results archive. */
export interface TennisCareerMatch {
  date: string; // YYYY-MM-DD
  tournament: string | null;
  surface: string | null;
  level: number; // 0 Grand Slam, 1 1000 / Finals / Olympics, 2 500, 3 250, 4 Challenger, 5 ITF, 6+ left out
  round: string | null; // F, SF, QF, R16 … (normalised)
  won: boolean;
  rank: number | null; // the player's rank at the time (archive), if known
  walkover?: boolean;
}
export const TENNIS_COLS: CareerCol[] = [
  { key: 'rank', kind: 'int' }, { key: 'w', kind: 'int' }, { key: 'l', kind: 'int' }, { key: 'winPct', kind: 'pct' }, { key: 'titles', kind: 'int' },
  { key: 'finals', kind: 'int' }, { key: 'hard', kind: 'text' }, { key: 'clay', kind: 'text' }, { key: 'grass', kind: 'text' }, { key: 'slams', kind: 'text' }
];
const ROUND_DEPTH: Record<string, number> = { R128: 1, R64: 2, R32: 3, R16: 4, RR: 4.5, QF: 5, SF: 6, F: 7, W: 8 };
export const slamOf = (name: string | null): 'AO' | 'RG' | 'W' | 'US' | null => {
  const n = String(name || '').toLowerCase();
  if (/australian/.test(n)) return 'AO';
  if (/roland|french open/.test(n)) return 'RG';
  if (/wimbledon/.test(n)) return 'W';
  if (/u\.?s\.? open/.test(n)) return 'US';
  return null;
};

/**
 * Matches → one line per year at tour level (Grand Slams, 1000s, 500s, 250s, Finals, Olympics; qualifying, Challenger,
 * ITF and team events left out — how the tours count a career W–L): W–L, titles, finals, W–L per surface, the Grand
 * Slam result of each slam, the rank at the year's last match (`yearRank` overrides it with a stored year-end ranking).
 */
export function tennisYears(ms: TennisCareerMatch[], source: (year: number) => string, yearRank: (year: number) => number | null = () => null): CareerLine[] {
  const by = new Map<number, TennisCareerMatch[]>();
  for (const m of ms) {
    if (!(m.level <= 3) || !m.date || m.walkover) continue;
    if (m.round && /^Q/.test(m.round)) continue;
    const y = Number(m.date.slice(0, 4));
    if (!by.has(y)) by.set(y, []);
    by.get(y)!.push(m);
  }
  const out: CareerLine[] = [];
  for (const [y, list] of by) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const w = list.filter(m => m.won).length, l = list.length - w;
    const finals = list.filter(m => m.round === 'F');
    const surf = (s: string) => { const x = list.filter(m => String(m.surface || '').toLowerCase().startsWith(s)); return x.length ? `${x.filter(m => m.won).length}–${x.filter(m => !m.won).length}` : null; };
    const slam: Record<string, string> = {};
    for (const m of list) {
      if (m.level !== 0) continue;
      const k = slamOf(m.tournament);
      if (!k || !m.round) continue;
      const got = m.round === 'F' && m.won ? 'W' : m.round;
      if (!slam[k] || (ROUND_DEPTH[got] || 0) > (ROUND_DEPTH[slam[k]] || 0)) slam[k] = got;
    }
    const ranked = list.filter(m => m.rank && m.rank > 0);
    out.push({
      season: String(y), order: y, kind: 'regular', league: null, team: null, gp: list.length,
      stats: {
        rank: yearRank(y) ?? (ranked.length ? ranked[ranked.length - 1].rank : null), w, l, winPct: pctOf(w, w + l),
        titles: finals.filter(m => m.won).length, finals: finals.length, hard: surf('hard') ?? surf('carpet'), clay: surf('clay'), grass: surf('grass'),
        slams: (['AO', 'RG', 'W', 'US'] as const).filter(k => slam[k]).map(k => `${k} ${slam[k]}`).join(' · ') || null
      },
      source: source(y)
    });
  }
  return out.sort((a, b) => b.order - a.order);
}

/* ------------------------------------------------------------------ */
/* The view                                                             */
/* ------------------------------------------------------------------ */

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const wl = (s: unknown): [number, number] | null => { const m = /^(\d+)–(\d+)$/.exec(String(s ?? '')); return m ? [+m[1], +m[2]] : null; };

/** career totals of one part (regular / playoffs) */
function totalsOf(sport: CareerSport, lines: CareerLine[]): { gp: number; stats: Record<string, number | string | null> } {
  const gp = lines.reduce((a, l) => a + (l.gp || 0), 0);
  const st: Record<string, number | string | null> = {};
  if (sport === 'basketball') {
    // per-game averages weighted by games; percentages from made / attempted where every season has them
    const t: Record<string, number> = {}, g: Record<string, number> = {};
    for (const l of lines) for (const k of ['min', 'pts', 'reb', 'ast', 'stl', 'blk', ...BB_SHOTS]) {
      const v = l.stats[k];
      if (isNum(v) && l.gp) { t[k] = (t[k] || 0) + v * l.gp; g[k] = (g[k] || 0) + l.gp; }
    }
    for (const k of ['min', 'pts', 'reb', 'ast', 'stl', 'blk']) st[k] = g[k] ? r1(t[k] / g[k]) : null;
    const shot = (m: string, a: string, pk: string) => {
      if (g[m] && g[m] === g[a]) return pctOf(t[m], t[a]);
      // older seasons without made / attempted: games-weighted average of the season percentages
      let s = 0, n = 0;
      for (const l of lines) { const v = l.stats[pk]; if (isNum(v) && l.gp) { s += v * l.gp; n += l.gp; } }
      return n ? r1(s / n) : null;
    };
    st.fgPct = shot('fgm', 'fga', 'fgPct'); st.tpPct = shot('tpm', 'tpa', 'tpPct'); st.ftPct = shot('ftm', 'fta', 'ftPct');
  } else if (sport === 'american-football') {
    const sum: Record<string, number> = {};
    let lng: number | null = null;
    for (const l of lines) for (const [k, v] of Object.entries(l.stats)) {
      if (!isNum(v)) continue;
      if (k === 'lng') lng = Math.max(lng ?? 0, v);
      else if (NFL_ALL.includes(k)) sum[k] = (sum[k] || 0) + v;
    }
    Object.assign(st, nflDerived(Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v * 10) / 10]))));
    if (st.rate != null && sum.att) st.rate = passerRating(sum.cmp || 0, sum.att, sum.passYds || 0, sum.passTd || 0, sum.int || 0);
    if (lng != null) st.lng = lng;
  } else {
    let w = 0, l = 0, titles = 0, finals = 0, best: number | null = null;
    const surf: Record<string, [number, number]> = {};
    const slamWins: Record<string, number> = {};
    for (const x of lines) {
      w += (x.stats.w as number) || 0; l += (x.stats.l as number) || 0; titles += (x.stats.titles as number) || 0; finals += (x.stats.finals as number) || 0;
      if (isNum(x.stats.rank)) best = best == null ? x.stats.rank : Math.min(best, x.stats.rank);
      for (const s of ['hard', 'clay', 'grass']) { const v = wl(x.stats[s]); if (v) { surf[s] = surf[s] || [0, 0]; surf[s][0] += v[0]; surf[s][1] += v[1]; } }
      for (const part of String(x.stats.slams || '').split(' · ')) { const [k, r] = part.split(' '); if (r === 'W') slamWins[k] = (slamWins[k] || 0) + 1; }
    }
    Object.assign(st, { rank: best, w, l, winPct: pctOf(w, w + l), titles, finals,
      hard: surf.hard ? `${surf.hard[0]}–${surf.hard[1]}` : null, clay: surf.clay ? `${surf.clay[0]}–${surf.clay[1]}` : null, grass: surf.grass ? `${surf.grass[0]}–${surf.grass[1]}` : null,
      slams: Object.entries(slamWins).map(([k, n]) => `${k} ×${n}`).join(' · ') || null });
  }
  return { gp, stats: st };
}

/** the best season per headline stat (regular season) */
function highsOf(sport: CareerSport, group: string | null, lines: CareerLine[]) {
  const keys = sport === 'basketball' ? ['pts', 'reb', 'ast'] : sport === 'tennis' ? ['titles', 'w', 'rank']
    : ({ qb: ['passYds', 'passTd', 'rate'], rb: ['rushYds', 'rushTd'], wr: ['recYds', 'recTd', 'rec'], def: ['tackles', 'sacks', 'int'], k: ['fgm', 'kPts'], p: ['puntAvg'] } as Record<string, string[]>)[group || ''] || ['passYds', 'rushYds', 'recYds', 'tackles'];
  const out: CareerView['highs'] = [];
  for (const k of keys) {
    // basketball averages count from 10 games (a 3-game season is not a career high)
    const pool = lines.filter(l => l.kind === 'regular' && isNum(l.stats[k]) && (l.stats[k] as number) > 0 && (sport !== 'basketball' || (l.gp || 0) >= 10));
    if (!pool.length) continue;
    const best = pool.reduce((a, b) => ((k === 'rank' ? (b.stats[k] as number) < (a.stats[k] as number) : (b.stats[k] as number) > (a.stats[k] as number)) ? b : a));
    out.push({ key: k, value: best.stats[k] as number, season: best.season });
  }
  return out;
}

/** merge lines that describe the same season, team and league (a later source wins: our box scores over the provider) */
export function mergeLines(...sets: CareerLine[][]): CareerLine[] {
  const by = new Map<string, CareerLine>();
  for (const set of sets) for (const l of set) by.set(`${l.order}|${l.kind}|${l.team?.id ?? l.team?.name ?? ''}|${l.league?.code ?? l.league?.name ?? ''}`, l);
  return [...by.values()];
}

/** season lines → the table every sport's page shows */
export function careerView(sport: CareerSport, lines: CareerLine[], o: { group?: string | null; partialWhy?: string | null } = {}): CareerView {
  const group = sport === 'american-football' ? o.group || 'other' : null;
  const rows = lines.map(l => (sport === 'american-football' ? { ...l, stats: nflDerived(l.stats) } : l))
    .sort((a, b) => b.order - a.order || (a.kind === b.kind ? 0 : a.kind === 'regular' ? -1 : 1) || (b.gp || 0) - (a.gp || 0));
  const parts = (['regular', 'playoffs'] as CareerKind[]).filter(k => rows.some(r => r.kind === k));
  const columns = sport === 'basketball' ? BB_COLS.filter(c => rows.some(r => r.stats[c.key] != null)) : sport === 'tennis' ? TENNIS_COLS.filter(c => rows.some(r => r.stats[c.key] != null)) : nflColumns(group!, rows);
  const totals: CareerView['totals'] = {};
  for (const p of parts) totals[p] = totalsOf(sport, rows.filter(r => r.kind === p));
  const seasons = new Set(rows.filter(r => r.kind === 'regular').map(r => r.order));
  const first = rows.length ? rows.reduce((a, b) => (b.order < a.order ? b : a)) : null;
  return {
    sport, group, columns, parts, rows, totals, highs: highsOf(sport, group, rows), seasons: seasons.size, from: first?.season ?? null,
    partial: !!o.partialWhy, partialWhy: o.partialWhy || null, sources: [...new Set(rows.map(r => r.source))]
  };
}

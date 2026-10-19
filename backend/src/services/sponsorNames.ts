/**
 * fix182: betting sponsors never appear in a displayed team / league name, in any sport (no-bookmakers rule):
 * "Partizan Mozzart Bet" → "Partizan", "Crvena Zvezda Meridianbet" → "Crvena Zvezda", "AdmiralBet ABA League" → "ABA
 * League". One cleaner, used on stored basketball names, on every API response's name fields (index.ts JSON replacer)
 * and in the crawler pages (seo.ts). Real clubs that only look similar stay (allowlist).
 */

/** Betting brands (whole words, case-insensitive; an optional "Bet" after the brand goes with it). */
export const BETTING_SPONSORS = [
  'Mozzart', 'Meridianbet', 'Meridian', 'MaxBet', 'Soccerbet', 'AdmiralBet', 'Admiral', 'Betclic', 'Bet365', 'Tipsport', 'Stoiximan',
  'Novibet', 'Betano', 'Winamax', 'Unibet', 'Bwin', 'Superbet', 'Parimatch', 'PariMatch', '1xBet', 'Betway', 'Interwetten', 'Tipico',
  'Efbet', 'Winbet', 'Fonbet', 'Fortuna', 'Betsson', 'Betsafe', 'Optibet', 'Sportingbet', 'Betfair', 'Ladbrokes', 'William Hill',
  'Paddy Power', 'Marathonbet', 'Melbet', '22Bet', 'Leonbet', 'Olimpbet', 'Winline', 'BetBoom', 'BetCity', 'Liga Stavok', 'Eurobet',
  'Sisal', 'Snai', 'Betmotion', 'Codere', 'Sportybet', 'Betika', 'Betwinner', 'Mostbet', 'Pinnacle', 'Bet9ja', 'Premierbet', 'Merkur',
  'Lottomatica', 'Goldbet', 'Planetwin365', 'Admiral Bet', 'Mozzart Bet', 'Balkan Bet', 'Pinbet', 'Volcano', 'Oktagonbet', 'Wwin',
  'Chance', 'Niké', 'Nike Liga'
];
/** Club / league names that contain a word from the list but are not sponsors. */
const KEEP = /(?<![\p{L}\p{N}])(?:(?:SC |SV |VfB |TuS )?Fortuna (?:D(?:u|ü)sseldorf|Sittard|K(?:ö|o)ln|Hj(?:ø|o)rring|Babelsberg|Magdeburg|Chemnitz|Leipzig|'?54 Geleen)|Admira(?: Wacker)?)(?![\p{L}\p{N}])/giu;
/** Whole names we rename (a sponsor that IS the league's name). */
const RENAME: Record<string, string> = {
  'betclic elite': 'LNB Élite', 'betclic élite': 'LNB Élite', 'admiralbet aba league': 'ABA League', 'fortuna liga': 'Czech First League',
  'fortuna:liga': 'Czech First League', 'chance liga': 'Czech First League', 'niké liga': 'Slovak Super Liga', 'nike liga': 'Slovak Super Liga',
  'tipsport liga': 'Czech League', 'superbet liga': 'Liga I', 'optibet virsliga': 'Virsliga', 'efbet league': 'First League',
  'winbet first league': 'First League', 'mozzart bet superliga': 'SuperLiga', 'mozzart bet super liga': 'SuperLiga', 'meridianbet 1. cfl': 'Montenegrin First League'
};
// "Chance" / "Volcano" / "Merkur" / "Niké" are ordinary words or other businesses: only stripped next to a league word
const LEAGUE_ONLY = new Set(['chance', 'niké', 'nike liga', 'volcano', 'merkur', 'sisal', 'snai', 'pinnacle']);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = [...BETTING_SPONSORS].sort((a, b) => b.length - a.length);
const ANY = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(esc).join('|')})(?:\\s*Bet)?(?![\\p{L}\\p{N}])`, 'giu');
const STRIP = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.filter(n => !LEAGUE_ONLY.has(n.toLowerCase())).map(esc).join('|')})(?:\\s*Bet)?(?![\\p{L}\\p{N}])`, 'giu');
const STRIP_LEAGUE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.filter(n => LEAGUE_ONLY.has(n.toLowerCase())).map(esc).join('|')})(?=\\s+(?:liga|league|ligue|lig)\\b)`, 'giu');

/** Quick test: could this text hold a sponsor? (cheap, for the JSON replacer) */
export const mayHaveSponsor = (s: string) => { ANY.lastIndex = 0; return ANY.test(s); };

/** A team / league name without betting sponsors ("Partizan Mozzart Bet" → "Partizan"). */
function strip(text: string): string {
  const kept: string[] = [];
  let s = text.replace(KEEP, m => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
  s = s.replace(STRIP, '').replace(STRIP_LEAGUE, '');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
  return s.replace(/\(\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:)])/g, '$1');
}
export function cleanName(name: string): string {
  if (!name || typeof name !== 'string' || !mayHaveSponsor(name)) return name;
  const r = RENAME[name.trim().toLowerCase()];
  if (r) return r;
  const s = strip(name).replace(/\s*[-–·|,:]\s*$/, '').replace(/^\s*[-–·|,:]\s*/, '').trim();
  return s.length >= 2 ? s : name;
}

/** Sponsors inside running text (crawler pages, titles): renames first, then every sponsor word removed. */
export function cleanText(text: string): string {
  if (!text || typeof text !== 'string' || !mayHaveSponsor(text)) return text;
  let s = text;
  for (const [k, v] of Object.entries(RENAME)) s = s.replace(new RegExp(esc(k), 'gi'), v);
  return strip(s);
}

/** JSON keys that hold a displayed name. */
export const NAME_KEYS = new Set(['name', 'shortName', 'short', 'homeName', 'awayName', 'home_name', 'away_name', 'opponent', 'teamName', 'team', 'home', 'away', 'league', 'competition', 'comp', 'clubName', 'club', 'label', 'teamA', 'teamB']);

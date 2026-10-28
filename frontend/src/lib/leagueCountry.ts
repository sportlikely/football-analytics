import { latinOf } from './names'
/** Country of a football competition, for the Countries menu (flag codes as API-Sports uses them). */
const FD: Record<string, string> = {
  PL: 'gb-eng', ELC: 'gb-eng', BL1: 'de', SA: 'it', PD: 'es', FL1: 'fr', DED: 'nl', PPL: 'pt', BSA: 'br',
  CL: 'eu', EC: 'eu', WC: 'world'
}
const BY_NAME: Record<string, string> = {
  england: 'gb-eng', scotland: 'gb-sct', wales: 'gb-wls', 'northern ireland': 'gb-nir', germany: 'de', italy: 'it', spain: 'es', france: 'fr',
  netherlands: 'nl', portugal: 'pt', brazil: 'br', japan: 'jp', 'saudi-arabia': 'sa', 'saudi arabia': 'sa', turkey: 'tr', denmark: 'dk',
  norway: 'no', sweden: 'se', argentina: 'ar', poland: 'pl', belgium: 'be', mexico: 'mx', austria: 'at', israel: 'il', switzerland: 'ch',
  greece: 'gr', usa: 'us', croatia: 'hr', 'czech-republic': 'cz', 'czech republic': 'cz', ukraine: 'ua', russia: 'ru', china: 'cn',
  'south-korea': 'kr', 'south korea': 'kr', australia: 'au', colombia: 'co', chile: 'cl', uruguay: 'uy', egypt: 'eg', romania: 'ro', serbia: 'rs'
}
// More countries (Oct 2026: leagues added from Admin → Football leagues). API-Football writes multi-word names with
// hyphens ("Costa-Rica"); both spellings are looked up.
const MORE: Record<string, string> = {
  ireland: 'ie', hungary: 'hu', slovakia: 'sk', slovenia: 'si', bulgaria: 'bg', cyprus: 'cy', finland: 'fi', iceland: 'is',
  estonia: 'ee', latvia: 'lv', lithuania: 'lt', belarus: 'by', kazakhstan: 'kz', azerbaijan: 'az', georgia: 'ge', armenia: 'am',
  moldova: 'md', 'north macedonia': 'mk', macedonia: 'mk', albania: 'al', montenegro: 'me', bosnia: 'ba', 'bosnia and herzegovina': 'ba',
  kosovo: 'xk', luxembourg: 'lu', malta: 'mt', 'faroe islands': 'fo', andorra: 'ad', 'san marino': 'sm', gibraltar: 'gi',
  peru: 'pe', ecuador: 'ec', paraguay: 'py', bolivia: 'bo', venezuela: 've', 'costa rica': 'cr', honduras: 'hn', guatemala: 'gt',
  'el salvador': 'sv', panama: 'pa', jamaica: 'jm', canada: 'ca', qatar: 'qa', 'united arab emirates': 'ae', uae: 'ae', iran: 'ir',
  iraq: 'iq', jordan: 'jo', kuwait: 'kw', bahrain: 'bh', oman: 'om', india: 'in', thailand: 'th', vietnam: 'vn', indonesia: 'id',
  malaysia: 'my', singapore: 'sg', uzbekistan: 'uz', morocco: 'ma', algeria: 'dz', tunisia: 'tn', 'south africa': 'za', nigeria: 'ng',
  ghana: 'gh', kenya: 'ke', tanzania: 'tz', zambia: 'zm', cameroon: 'cm', senegal: 'sn', 'ivory coast': 'ci', "cote d'ivoire": 'ci',
  'new zealand': 'nz', 'hong kong': 'hk', 'chinese taipei': 'tw', taiwan: 'tw', philippines: 'ph', 'dominican republic': 'do'
}
const countryCode = (name: string) => {
  const k = latinOf(name).toLowerCase().trim()
  const sp = k.replace(/-/g, ' ')
  return BY_NAME[k] || BY_NAME[sp] || MORE[k] || MORE[sp] || null
}
export function footballCountry(c: { code: string; name: string; type?: string; rank?: number }) {
  if (FD[c.code]) return FD[c.code]
  if (c.rank === 3) return 'world' // national teams
  if (c.rank === 1 || /^uefa/i.test(latinOf(c.name))) return 'eu'
  const m = c.name.match(/\(([^)]+)\)\s*$/)
  if (m) return countryCode(m[1]) || 'world'
  return 'world'
}
/** "Serie A (Brazil)" → "Serie A" (the country is shown by the menu). */
export const leagueShortName = (name: string) => name.replace(/\s*\([^)]+\)\s*$/, '')

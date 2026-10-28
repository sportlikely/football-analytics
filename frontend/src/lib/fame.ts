/**
 * How big a team is (global recognition, not current form): 10 = the biggest clubs and nations, 1 = everyone else.
 * Used to pick the Spotlight games and the home page's featured match.
 */
import { latinOf } from './names'

// "Big club" ranking for the Spotlight — global recognition, not current form.
const FAME: [RegExp, number][] = [
  [/real madrid|barcelona|manchester united|liverpool|manchester city|bayern|paris saint|juventus|chelsea|arsenal/i, 10],
  [/\bac milan|internazionale|atl[ée]tico de madrid|borussia dortmund|tottenham/i, 9],
  [/napoli|as roma|ajax|benfica|fc porto|sporting clube de portugal|sevilla|leverkusen|marseille|lyonnais|newcastle|aston villa|lazio|atalanta/i, 7],
  [/villarreal|real sociedad|athletic club|leipzig|psv|feyenoord|west ham|everton|monaco|lille|fiorentina|real betis|valencia|eintracht frankfurt|m[öo]nchengladbach|leeds|nottingham|bologna|stuttgart|braga/i, 5],
  // national teams (whole name only, so no club matches by accident)
  [/^(brazil|argentina|france|england|spain|germany|portugal|italy|netherlands)$/i, 10],
  [/^(belgium|croatia|uruguay|colombia|usa|united states|mexico|morocco|japan|denmark|switzerland)$/i, 7],
  [/^(poland|austria|sweden|norway|turkey|t[üu]rkiye|senegal|nigeria|egypt|ukraine|serbia|scotland|wales|czechia|czech republic|korea republic|south korea|ecuador|chile|israel)$/i, 5],
  [/girona|brighton|wolverhampton|torino|celta|wolfsburg|schalke|hamburger|werder|k[öo]ln|union berlin|nice|lens|rennes|strasbourg|crystal palace|fulham|brentford|bournemouth|getafe|osasuna|udinese|genoa|parma|freiburg|hoffenheim|mainz|augsburg|toulouse|nantes|twente|az|utrecht|vit[óo]ria|guimar/i, 3]
]
export function fame(t0: { name: string; shortName?: string }) {
  // fix261: on he / ar pages the names arrive in the local script; the list is Latin
  const t = { name: latinOf(t0.name), shortName: t0.shortName ? latinOf(t0.shortName) : undefined }
  for (const [re, score] of FAME) if (re.test(t.name) || (t.shortName && re.test(t.shortName)) || re.test(`${t.name} ${t.shortName || ''}`)) return score
  return 1
}


/** A game's size: the bigger team counts most, the other adds a little (Real Madrid–Barcelona > Real Madrid–Getafe). */
export function matchFame(home: { name: string; shortName?: string }, away: { name: string; shortName?: string }) {
  const a = fame(home), b = fame(away)
  return Math.max(a, b) + 0.4 * Math.min(a, b)
}

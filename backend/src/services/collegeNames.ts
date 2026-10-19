/**
 * College school names (fix189). The same file lives in frontend/src/lib/collegeNames.ts — keep both in step.
 *
 * A nickname is stripped only when the full name is longer than a school name we know: "Ohio State Buckeyes" → "Ohio
 * State", "Alabama Crimson Tide" → "Alabama". A name that already is a school ("South Dakota", "North Dakota", "South
 * Alabama", "North Texas", "South Carolina State") stays whole. Unknown schools: the last word goes only when what is left
 * is more than a compass word and the last word isn't part of a school name (State, Tech, A&M …).
 */
const SCHOOLS_FBS = [
  'Boston College', 'California', 'Cal', 'Clemson', 'Duke', 'Florida State', 'Georgia Tech', 'Louisville', 'Miami', 'Miami (FL)', 'NC State', 'North Carolina State',
  'North Carolina', 'Pittsburgh', 'Pitt', 'SMU', 'Southern Methodist', 'Stanford', 'Syracuse', 'Virginia', 'Virginia Tech', 'Wake Forest',
  'Illinois', 'Indiana', 'Iowa', 'Maryland', 'Michigan', 'Michigan State', 'Minnesota', 'Nebraska', 'Northwestern', 'Ohio State', 'Oregon', 'Penn State',
  'Purdue', 'Rutgers', 'UCLA', 'USC', 'Southern California', 'Washington', 'Wisconsin',
  'Arizona', 'Arizona State', 'Baylor', 'BYU', 'Brigham Young', 'Cincinnati', 'Colorado', 'Houston', 'Iowa State', 'Kansas', 'Kansas State', 'Oklahoma State',
  'TCU', 'Texas Christian', 'Texas Tech', 'UCF', 'Central Florida', 'Utah', 'West Virginia',
  'Alabama', 'Arkansas', 'Auburn', 'Florida', 'Georgia', 'Kentucky', 'LSU', 'Louisiana State', 'Mississippi State', 'Missouri', 'Oklahoma', 'Ole Miss',
  'Mississippi', 'South Carolina', 'Tennessee', 'Texas', 'Texas A&M', 'Vanderbilt', 'Oregon State', 'Washington State',
  'Army', 'Charlotte', 'East Carolina', 'Florida Atlantic', 'FAU', 'Memphis', 'Navy', 'North Texas', 'Rice', 'South Florida', 'USF', 'Temple', 'Tulane', 'Tulsa',
  'UAB', 'UTSA', 'UT San Antonio',
  'Air Force', 'Boise State', 'Colorado State', 'Fresno State', 'Hawaii', "Hawai'i", 'Nevada', 'New Mexico', 'San Diego State', 'San Jose State', 'San José State',
  'UNLV', 'Utah State', 'Wyoming',
  'Appalachian State', 'App State', 'Arkansas State', 'Coastal Carolina', 'Georgia Southern', 'Georgia State', 'James Madison', 'Louisiana', 'Louisiana-Lafayette',
  'Louisiana-Monroe', 'Louisiana Monroe', 'UL Monroe', 'ULM', 'Marshall', 'Old Dominion', 'South Alabama', 'Southern Miss', 'Southern Mississippi', 'Texas State', 'Troy',
  'Akron', 'Ball State', 'Bowling Green', 'Buffalo', 'Central Michigan', 'Eastern Michigan', 'Kent State', 'Miami (OH)', 'Miami (Ohio)', 'Miami OH', 'Northern Illinois',
  'Ohio', 'Toledo', 'Western Michigan', 'UMass', 'Massachusetts',
  'Delaware', 'FIU', 'Florida International', 'Jacksonville State', 'Kennesaw State', 'Liberty', 'Louisiana Tech', 'Middle Tennessee', 'Middle Tennessee State',
  'Missouri State', 'New Mexico State', 'Sam Houston', 'Sam Houston State', 'UTEP', 'UT El Paso', 'Western Kentucky', 'WKU',
  'Notre Dame', 'UConn', 'Connecticut'
];
const SCHOOLS_FCS = [
  'South Dakota', 'South Dakota State', 'North Dakota', 'North Dakota State', 'Northern Iowa', 'Southern Illinois', 'Illinois State', 'Indiana State', 'Youngstown State',
  'Murray State', 'Missouri State', 'Montana', 'Montana State', 'Idaho', 'Idaho State', 'Weber State', 'Portland State', 'Sacramento State', 'UC Davis', 'Cal Poly',
  'Northern Arizona', 'Northern Colorado', 'Eastern Washington', 'Southern Utah', 'Utah Tech', 'Tarleton State', 'Abilene Christian', 'Austin Peay', 'Central Arkansas',
  'Eastern Kentucky', 'North Alabama', 'Stephen F. Austin', 'Incarnate Word', 'Nicholls', 'Nicholls State', 'McNeese', 'McNeese State', 'Northwestern State',
  'Southeastern Louisiana', 'Lamar', 'Houston Christian', 'Houston Baptist', 'East Texas A&M', 'Texas A&M-Commerce', 'UT Martin', 'Tennessee-Martin', 'Tennessee State',
  'Tennessee Tech', 'Southeast Missouri State', 'Southeast Missouri', 'Eastern Illinois', 'Western Illinois', 'Lindenwood', 'Southern Indiana', 'Charleston Southern',
  'Gardner-Webb', 'Robert Morris', 'South Carolina State', 'North Carolina A&T', 'North Carolina Central', 'Norfolk State', 'Morgan State', 'Delaware State', 'Howard',
  'Florida A&M', 'Bethune-Cookman', 'Alabama A&M', 'Alabama State', 'Jackson State', 'Grambling', 'Grambling State', 'Southern', 'Prairie View A&M', 'Texas Southern',
  'Arkansas-Pine Bluff', 'Mississippi Valley State', 'Furman', 'Wofford', 'Samford', 'Mercer', 'Chattanooga', 'The Citadel', 'VMI', 'East Tennessee State', 'Western Carolina',
  'Elon', 'Towson', 'Maine', 'New Hampshire', 'Rhode Island', 'Stony Brook', 'Albany', 'Monmouth', 'Hampton', 'Campbell', 'Richmond', 'William & Mary', 'Villanova',
  'Bryant', 'Holy Cross', 'Lehigh', 'Lafayette', 'Bucknell', 'Fordham', 'Colgate', 'Georgetown', 'Harvard', 'Yale', 'Princeton', 'Brown', 'Columbia', 'Cornell',
  'Dartmouth', 'Penn', 'Duquesne', 'Saint Francis', 'St. Francis (PA)', 'Central Connecticut', 'Central Connecticut State', 'Wagner', 'Sacred Heart', 'Merrimack',
  'Stonehill', 'Long Island', 'LIU', 'Mercyhurst', 'Drake', 'Butler', 'Dayton', 'San Diego', 'Davidson', 'Marist', 'Stetson', 'Presbyterian', 'Morehead State',
  'St. Thomas', 'Valparaiso', 'Eastern Michigan', 'West Georgia', 'Kennesaw State'
];
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const KNOWN = [...new Set([...SCHOOLS_FBS, ...SCHOOLS_FCS].map(norm))].sort((a, b) => b.length - a.length);
const KNOWN_SET = new Set(KNOWN);
/** College nicknames of two words ("Crimson Tide"): dropped whole to leave the school name. */
const TWO_WORD = /\s(crimson tide|nittany lions|fighting irish|yellow jackets|golden gophers|blue devils|tar heels|red raiders|horned frogs|sun devils|golden bears|demon deacons|scarlet knights|mean green|golden hurricane|golden eagles|green wave|red wolves|black knights|thundering herd|golden flashes|blue raiders|fighting illini|rainbow warriors|wolf pack|golden panthers|black bears|blue hens|golden lions|fighting hawks|big green|big red|purple eagles|mountain hawks|delta devils|golden rams|red flash|red foxes|blue hose|golden griffins|fighting camels|river hawks)$/i;
/** The rest after a known school that means "another school" ("Texas Southern", "Alabama A&M", "Tennessee State"). */
const NOT_NICK = /^(state|southern|northern|eastern|western|central|north|south|east|west|a&m|a&t|tech|christian|international|atlantic|baptist|college|university|valley|mountain|pacific|-|\(|st\.?|poly|mines|&|and)\b/i;
/** A last word that belongs to the school, not to a nickname. */
const SCHOOL_WORD = /^(state|tech|a&m|a&t|college|university|carolina|dakota|christian|international|atlantic|southern|northern|eastern|western|central|poly|mines|\(.*\))$/i;
/** What is left must be more than this ("South Dakota" → never "South"). */
const COMPASS = /^(north|south|east|west|central|northern|southern|eastern|western|new|san|santa|el|la|le|st\.?|saint|fort|cal|ut|ul|the)$/i;

export function schoolOf(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  const n = norm(clean);
  if (KNOWN_SET.has(n)) return clean;
  const m = clean.match(TWO_WORD);
  if (m) return clean.slice(0, m.index);
  for (const s of KNOWN) {
    if (!n.startsWith(s + ' ')) continue;
    const rest = n.slice(s.length + 1);
    if (NOT_NICK.test(rest) || rest.split(' ').length > 3) continue;
    return clean.slice(0, s.length);
  }
  const w = clean.split(' ');
  if (w.length < 2 || SCHOOL_WORD.test(w[w.length - 1])) return clean;
  const left = w.slice(0, -1);
  if (left.length === 1 && COMPASS.test(left[0])) return clean;
  return left.join(' ');
}

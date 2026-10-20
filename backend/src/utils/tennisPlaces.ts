/**
 * fix195: where a tennis tournament is played. The provider's country is sometimes empty or "World"; then the country
 * comes from the city (the catalogue's city, else a city named in the tournament: "Cali Challenger" → Colombia).
 * Countries are returned as English names ("Colombia"); a player's IOC code ("PER") → "Peru" with countryName().
 */

const IOC_ISO: Record<string, string> = Object.fromEntries(`arg:ar aus:au aut:at bel:be bih:ba bra:br bul:bg can:ca chi:cl chn:cn col:co cro:hr cyp:cy cze:cz den:dk ecu:ec egy:eg
esp:es est:ee fin:fi fra:fr gbr:gb geo:ge ger:de gre:gr hkg:hk hun:hu ind:in ina:id irl:ie ita:it jpn:jp kaz:kz kor:kr lat:lv ltu:lt lux:lu mar:ma mex:mx
mda:md mon:mc ned:nl nzl:nz nor:no par:py per:pe phi:ph pol:pl por:pt qat:qa rou:ro rsa:za rus:ru srb:rs slo:si svk:sk sui:ch swe:se tha:th tun:tn tur:tr
ukr:ua uru:uy usa:us uzb:uz ven:ve blr:by uae:ae ksa:sa tpe:tw mne:me mkd:mk alb:al arm:am aze:az isl:is mlt:mt dom:do pur:pr bar:bb jam:jm lbn:lb jor:jo
kuw:kw bah:bs zim:zw ken:ke bol:bo crc:cr gua:gt esa:sv hon:hn pan:pa cub:cu ngr:ng civ:ci sen:sn alg:dz vie:vn mas:my sgp:sg pak:pk sri:lk ban:bd
mgl:mn kgz:kg tjk:tj tkm:tm isr:il irq:iq iri:ir syr:sy lie:li and:ad smr:sm kos:xk`.split(/\s+/).filter(Boolean).map(x => x.split(':')));

let dn: Intl.DisplayNames | null = null;
const regionName = (iso: string): string | null => {
  try { dn ||= new Intl.DisplayNames(['en'], { type: 'region' }); const n = dn.of(iso.toUpperCase()); return n && n !== iso.toUpperCase() ? n : null; } catch { return null; }
};
const NOT_A_COUNTRY = /^(world|international|worldwide|global|n\/?a|tbd|unknown|-)$/i;

/** "PER" / "pe" / "Peru" → "Peru"; null for "World" and unknown codes */
export function countryName(x: string | null | undefined): string | null {
  const s = String(x || '').trim();
  if (!s || NOT_A_COUNTRY.test(s)) return null;
  if (/^[a-z]{2}$/i.test(s)) return regionName(s);
  if (/^[a-z]{3}$/i.test(s)) { const iso = IOC_ISO[s.toLowerCase()]; return iso ? regionName(iso) : null; }
  return s;
}

/** host cities of ATP / WTA / Challenger events → country (lower-case city, accents removed) */
const CITIES: Record<string, string> = {};
const add = (country: string, list: string) => { for (const c of list.split(',')) { const k = c.trim().toLowerCase(); if (k) CITIES[k] = country; } };
add('Colombia', 'cali, bogota, medellin, barranquilla, pereira, cartagena');
add('Peru', 'lima, arequipa, trujillo');
add('Chile', 'santiago, vina del mar, concepcion, temuco, puerto montt, la serena, coquimbo');
add('Argentina', 'buenos aires, cordoba, rosario, mendoza, tucuman, villa maria, la plata, mar del plata, bahia blanca, neuquen, san juan, junin, villa allende, corrientes');
add('Brazil', 'rio de janeiro, sao paulo, florianopolis, campinas, porto alegre, curitiba, brasilia, belo horizonte, sao leopoldo, blumenau, campo grande, itajai, guaruja, piracicaba, goiania');
add('Uruguay', 'montevideo, punta del este');
add('Paraguay', 'asuncion');
add('Bolivia', 'santa cruz, la paz, cochabamba');
add('Ecuador', 'guayaquil, quito, salinas, manta, cuenca');
add('Mexico', 'acapulco, los cabos, monterrey, guadalajara, merida, puerto vallarta, san luis potosi, leon, queretaro, tijuana, morelos, cancun, mexico city, zapopan, tlaxcala, chihuahua');
add('United States', 'new york, flushing meadows, indian wells, miami, cincinnati, mason, washington, atlanta, winston-salem, delray beach, houston, dallas, newport, los cabos, charleston, san diego, austin, cleveland, chicago, phoenix, sarasota, tallahassee, savannah, little rock, orlando, champaign, knoxville, charlottesville, las vegas, tiburon, fairfield, cary, lexington, indianapolis, rome ga, waco, boca raton, palm coast, bonita springs, columbus, new haven, stanford, san jose, carlsbad, berkeley, san antonio, birmingham al, puerto rico, sacramento, monterey, fort worth, hilton head, midland, chattanooga, granby, tyler, rancho santa fe, evansville, lincoln, edwardsville, champaign-urbana, bloomfield hills, iowa city');
add('Canada', 'toronto, montreal, vancouver, granby, calgary, drummondville, saguenay, winnipeg, edmonton, kitchener');
add('United Kingdom', 'london, wimbledon, queens, eastbourne, nottingham, birmingham, ilkley, surbiton, glasgow, manchester, bath, edinburgh, shrewsbury, loughborough, sunderland, roehampton');
add('Ireland', 'dublin, galway');
add('France', 'paris, roland garros, lyon, marseille, montpellier, metz, nice, rennes, bordeaux, orleans, brest, aix-en-provence, mouilleron-le-captif, roanne, saint-tropez, quimper, cherbourg, poitiers, limoges, saint-malo, strasbourg, rouen, nantes, pau, lille, cassis, villers-les-nancy, angers, troyes, sarreguemines, grenoble, toulouse, vendee, biarritz');
add('Spain', 'madrid, barcelona, mallorca, marbella, valencia, seville, sevilla, alicante, murcia, malaga, zaragoza, bilbao, santander, segovia, gran canaria, tenerife, oviedo, girona, valladolid, cordoba es, ibiza, burgos, lleida, puerto de la cruz, villena');
add('Portugal', 'lisbon, estoril, oeiras, porto, braga, maia, guimaraes, faro');
add('Italy', 'rome, roma, turin, torino, milan, milano, florence, firenze, naples, napoli, palermo, cagliari, genoa, genova, bergamo, parma, perugia, todi, trieste, verona, vicenza, como, francavilla, sanremo, bari, brescia, santa margherita di pula, pula, cordenons, biella, ortisei, barletta, mestre, iasi it, olbia, padova, rovereto, modena, piacenza, monza, cervia, forli, sardinia, sassuolo');
add('Germany', 'halle, hamburg, munich, munchen, stuttgart, berlin, bad homburg, cologne, koln, heilbronn, braunschweig, ismaning, eckental, aachen, ludwigshafen, augsburg, oberstaufen, meerbusch, troisdorf, lüdenscheid, ludenscheid, kassel, hamburg-rothenbaum, essen, wolfsburg, dortmund');
add('Austria', 'vienna, wien, kitzbuhel, linz, graz, salzburg, mauthausen, st. polten, innsbruck');
add('Switzerland', 'basel, geneva, gstaad, lausanne, biel, bienne, lugano, zug, verbier');
add('Belgium', 'antwerp, brussels, bruxelles, liege, ostend, mons, kortrijk');
add('Netherlands', 's-hertogenbosch, rosmalen, rotterdam, amsterdam, alphen aan den rijn, the hague, den haag, groningen, eindhoven');
add('Luxembourg', 'luxembourg');
add('Denmark', 'copenhagen, odense');
add('Sweden', 'stockholm, bastad');
add('Norway', 'oslo');
add('Finland', 'helsinki, tampere');
add('Poland', 'warsaw, krakow, sopot, poznan, wroclaw, szczecin, gdynia, bydgoszcz, katowice, lublin, kozerki');
add('Czechia', 'prague, praha, ostrava, brno, prostejov, liberec, pilsen, plzen, zlin, hradec kralove, olomouc');
add('Slovakia', 'bratislava, kosice, poprad');
add('Hungary', 'budapest, szekesfehervar, gyor');
add('Slovenia', 'ljubljana, portoroz, maribor');
add('Croatia', 'umag, zagreb, split, bol, osijek, makarska, zadar');
add('Serbia', 'belgrade, novi sad, kragujevac');
add('Bosnia and Herzegovina', 'banja luka, sarajevo');
add('Montenegro', 'podgorica, budva');
add('North Macedonia', 'skopje');
add('Albania', 'tirana');
add('Greece', 'athens, thessaloniki, heraklion, rhodes, chania');
add('Cyprus', 'limassol, nicosia');
add('Turkey', 'istanbul, antalya, ankara, izmir, bodrum, mersin');
add('Bulgaria', 'sofia, plovdiv, varna, burgas');
add('Romania', 'bucharest, cluj-napoca, cluj, iasi, constanta, sibiu, pitesti, brasov, targu mures');
add('Moldova', 'chisinau');
add('Ukraine', 'kyiv, kiev, odesa');
add('Estonia', 'tallinn');
add('Latvia', 'riga, jurmala');
add('Lithuania', 'vilnius');
add('Georgia', 'tbilisi, batumi');
add('Armenia', 'yerevan');
add('Azerbaijan', 'baku');
add('Kazakhstan', 'astana, almaty, nur-sultan, shymkent, aktobe');
add('Uzbekistan', 'tashkent, samarkand, fergana, namangan');
add('Kyrgyzstan', 'bishkek');
add('China', 'beijing, shanghai, shenzhen, wuhan, guangzhou, zhuhai, chengdu, tianjin, ningbo, nanchang, jiujiang, zhengzhou, hangzhou, zhangjiagang, suzhou, anning, kunming, wuxi, huzhou, qingdao, xi an, xian, changsha');
add('Hong Kong', 'hong kong');
add('Taiwan', 'taipei, kaohsiung');
add('Japan', 'tokyo, osaka, hiroshima, kyoto, yokohama, matsuyama, kobe, nagoya, kofu, toyota, keio, shimadzu, yokkaichi');
add('South Korea', 'seoul, busan, gwangju, chuncheon, gimcheon, daegu, jeonju');
add('India', 'pune, chennai, bengaluru, bangalore, mumbai, new delhi, delhi, kolkata, hyderabad');
add('Thailand', 'bangkok, nonthaburi, hua hin, pattaya, phuket');
add('Indonesia', 'jakarta, bali');
add('Malaysia', 'kuala lumpur');
add('Singapore', 'singapore');
add('Vietnam', 'ho chi minh city, hanoi');
add('Philippines', 'manila');
add('Australia', 'melbourne, sydney, brisbane, adelaide, perth, hobart, canberra, darwin, playford, burnie, launceston, traralgon, bendigo, shepparton, mildura, cairns, townsville, gold coast');
add('New Zealand', 'auckland, wellington, christchurch');
add('United Arab Emirates', 'dubai, abu dhabi');
add('Qatar', 'doha');
add('Saudi Arabia', 'riyadh, jeddah');
add('Bahrain', 'manama');
add('Israel', 'tel aviv, jerusalem, ramat hasharon');
add('Egypt', 'cairo, sharm el sheikh, sharm el-sheikh');
add('Morocco', 'marrakech, rabat, casablanca, agadir, meknes, tanger');
add('Tunisia', 'tunis, monastir, hammamet, sousse');
add('South Africa', 'johannesburg, cape town, durban, pretoria, stellenbosch');
add('Kenya', 'nairobi');
add('Nigeria', 'lagos, abuja');
add('Monaco', 'monte carlo, monte-carlo');
add('Dominican Republic', 'santo domingo');
add('Puerto Rico', 'san juan pr');
add('Guatemala', 'guatemala city');
add('Costa Rica', 'san jose cr');
add('Panama', 'panama city');
add('El Salvador', 'san salvador');
add('Venezuela', 'caracas');

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** the country of a city ("Cali" → "Colombia"), or of the first city named in a tournament name */
export function countryOfCity(city: string | null | undefined, tournament?: string | null): string | null {
  if (city) { const c = CITIES[plain(String(city)).trim()]; if (c) return c; }
  if (tournament) {
    const words = plain(String(tournament)).replace(/\([^)]*\)/g, ' ').replace(/[^a-z' -]+/g, ' ').split(/\s+/).filter(Boolean);
    // the longest run of words that is a known city ("santa margherita di pula", "rio de janeiro", "cali")
    for (let n = Math.min(5, words.length); n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) { const c = CITIES[words.slice(i, i + n).join(' ')]; if (c) return c; }
    }
  }
  return null;
}

/** the place line of a tournament: the provider's country unless it is empty / "World", else from the city or name */
export function tournamentPlace(country: string | null | undefined, city: string | null | undefined, tournament: string | null | undefined): { city: string | null; country: string | null } {
  return { city: city ? String(city) : null, country: countryName(country) || countryOfCity(city, tournament) };
}

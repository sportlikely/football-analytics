/**
 * fix181: publishers a Google News search story may come from (every sport). Anything else is dropped: no
 * universities / .edu, unknown blogs or content farms. The curated RSS feeds (news.ts FEEDS) don't go through this list.
 * A story passes when its publisher's domain (or a parent domain) is listed, the domain is an official federation /
 * league site, or the outlet name the feed gives is listed.
 */

/** Publisher domains (a subdomain counts: "sport.example.com" passes for "example.com"). */
export const TRUSTED_DOMAINS = [
  // international / English
  'bbc.co.uk', 'bbc.com', 'skysports.com', 'espn.com', 'espn.co.uk', 'espnfc.com', 'theguardian.com', 'goal.com', 'nytimes.com/athletic',
  'theathletic.com', 'reuters.com', 'apnews.com', 'afp.com', 'france24.com', 'beinsports.com', 'onefootball.com', 'fourfourtwo.com',
  'independent.co.uk', 'telegraph.co.uk', 'thetimes.co.uk', 'thetimes.com', 'standard.co.uk', 'mirror.co.uk', 'dailymail.co.uk', 'thesun.co.uk',
  'football.london', 'manchestereveningnews.co.uk', 'liverpoolecho.co.uk', 'birminghammail.co.uk', 'chroniclelive.co.uk', 'walesonline.co.uk',
  'irishtimes.com', 'independent.ie', 'rte.ie', 'the42.ie', 'scotsman.com', 'heraldscotland.com', 'dailyrecord.co.uk', 'bbc.co.uk/sport',
  'cbssports.com', 'nbcsports.com', 'foxsports.com', 'si.com', 'usatoday.com', 'yahoo.com', 'sports.yahoo.com', 'washingtonpost.com',
  'latimes.com', 'nypost.com', 'bleacherreport.com', 'theringer.com', 'sportingnews.com', 'cbc.ca', 'tsn.ca', 'sportsnet.ca', 'abc.net.au',
  'smh.com.au', 'theage.com.au', 'foxsports.com.au', 'news.com.au', 'stuff.co.nz', 'nzherald.co.nz', 'aljazeera.com', 'dw.com',
  'euronews.com', 'olympics.com', 'insidethegames.biz', 'worldsoccertalk.com', 'football-italia.net', 'football-espana.net',
  'besoccer.com/news', 'tribalfootball.com', 'transfermarkt.com', 'transfermarkt.co.uk', 'whoscored.com/news', 'planetfootball.com',
  'givemesport.com', 'sportbible.com', '90min.com', 'squawka.com', 'football365.com', 'teamtalk.com', 'caughtoffside.com',
  // Spain / Portugal / Latin America
  'marca.com', 'as.com', 'mundodeportivo.com', 'sport.es', 'elpais.com', 'elmundo.es', 'abc.es', 'relevo.com', 'eldesmarque.com',
  'record.pt', 'abola.pt', 'ojogo.pt', 'maisfutebol.iol.pt', 'publico.pt', 'globo.com', 'ge.globo', 'lance.com.br', 'uol.com.br',
  'estadao.com.br', 'folha.uol.com.br', 'ole.com.ar', 'tycsports.com', 'clarin.com', 'lanacion.com.ar', 'infobae.com', 'mediotiempo.com',
  'record.com.mx', 'eluniversal.com.mx', 'milenio.com', 'elcomercio.pe', 'emol.com', 'eltiempo.com', 'elcolombiano.com', 'semana.com',
  // Italy / Germany / France / Netherlands / Belgium / Switzerland / Austria
  'gazzetta.it', 'corrieredellosport.it', 'tuttosport.com', 'corriere.it', 'repubblica.it', 'sky.it', 'football-italia.net', 'calciomercato.com',
  'kicker.de', 'sportschau.de', 'spiegel.de', 'bild.de', 'faz.net', 'sueddeutsche.de', 'transfermarkt.de', 'sport1.de', 'ran.de',
  'lequipe.fr', 'francefootball.fr', 'rmcsport.bfmtv.com', 'lemonde.fr', 'lefigaro.fr', 'leparisien.fr', 'ouest-france.fr', 'getfootballnewsfrance.com',
  'vi.nl', 'nos.nl', 'ad.nl', 'telegraaf.nl', 'voetbalzone.nl', 'hln.be', 'nieuwsblad.be', 'sporza.be', 'dhnet.be', 'rtbf.be', 'lesoir.be',
  'srf.ch', 'blick.ch', 'nzz.ch', 'laola1.at', 'krone.at', 'derstandard.at',
  // Nordics / eastern Europe / Turkey / Greece
  'aftonbladet.se', 'expressen.se', 'svt.se', 'dr.dk', 'bold.dk', 'tipsbladet.dk', 'nrk.no', 'vg.no', 'dagbladet.no', 'yle.fi', 'hs.fi',
  'sport.pl', 'przegladsportowy.onet.pl', 'meczyki.pl', 'idnes.cz', 'isport.blesk.cz', 'nemzetisport.hu', 'nso.hu', 'gsp.ro', 'prosport.ro',
  'digisport.ro', 'sportal.bg', 'index.hr', 'sportske.jutarnji.hr', 'mozzartsport.com', 'b92.net', 'sport-express.ru', 'championat.com',
  'sports.ru', 'fanatik.com.tr', 'fotomac.com.tr', 'hurriyet.com.tr', 'milliyet.com.tr', 'trtspor.com.tr', 'aa.com.tr', 'dailysabah.com',
  'hurriyetdailynews.com', 'sport24.gr', 'gazzetta.gr', 'ekathimerini.com', 'balkaninsight.com',
  // Middle East / Africa / Asia
  'arabnews.com', 'saudigazette.com.sa', 'alarabiya.net', 'english.alarabiya.net', 'gulfnews.com', 'thenationalnews.com', 'khaleejtimes.com',
  'zawya.com', 'kooora.com', 'filgoal.com', 'ahram.org.eg', 'egyptindependent.com', 'kingfut.com', 'supersport.com', 'kickoff.com',
  'iol.co.za', 'news24.com', 'timeslive.co.za', 'citizen.digital', 'nation.africa', 'standardmedia.co.ke', 'punchng.com', 'vanguardngr.com',
  'premiumtimesng.com', 'completesports.com', 'myjoyonline.com', 'ghanaweb.com', 'hespress.com', 'moroccoworldnews.com', 'jeuneafrique.com',
  'japantimes.co.jp', 'kyodonews.net', 'nikkansports.com', 'koreaherald.com', 'koreatimes.co.kr', 'yna.co.kr', 'scmp.com', 'xinhuanet.com',
  'globaltimes.cn', 'thehindu.com', 'timesofindia.indiatimes.com', 'hindustantimes.com', 'indianexpress.com', 'sportstar.thehindu.com',
  'straitstimes.com', 'bangkokpost.com', 'vnexpress.net', 'thejakartapost.com', 'inquirer.net', 'thestar.com.my', 'nst.com.my', 'tehrantimes.com',
  // basketball / American football
  'nba.com', 'euroleaguebasketball.net', 'eurohoops.net', 'sportando.basketball', 'basketnews.com', 'fiba.basketball', 'hoopshype.com',
  'nfl.com', 'profootballtalk.nbcsports.com', 'ncaa.com', 'on3.com', '247sports.com', 'rivals.com', 'espn.co.uk/nfl'
];

/** Official federation / league / club sites (any domain matching these is accepted). */
export const OFFICIAL_SITE = /(^|\.)(fifa|uefa|the-afc|afc|cafonline|concacaf|conmebol|ofc|premierleague|efl|laliga|rfef|legaseriea|figc|bundesliga|dfb|ligue1|lfp|fff|eredivisie|knvb|ligaportugal|fpf|spfl|scottishfa|mlssoccer|ussoccer|ligamx|cbf|afa|spl|saff|uaeproleague|uaefa|qsl|qfa|jleague|jfa|kleague|kfa|a-leagues|footballaustralia|thecfa|aiff|indiansuperleague|psl|safa|caf|tff|hnl|hns|nogometni|pzpn|ekstraklasa|fotbal|mlsz|frf|lpf|bfunion|proleague|sfl|sfv|oefb|bundesliga\.at|dbu|superliga|nff|eliteserien|svenskfotboll|allsvenskan|palloliitto|veikkausliiga|ksi|fai|leagueofireland|ifa|faw|cymrufootball|thefa|englandfootball|nba|euroleague|fiba|nfl|ncaa)\.(com|org|net|co\.uk|es|it|de|fr|nl|pt|be|ch|at|dk|no|se|fi|is|ie|pl|cz|hu|ro|bg|hr|rs|tr|gr|ru|ua|sa|ae|qa|jp|kr|cn|in|au|za|ma|eg|com\.au|com\.sa|com\.br|com\.ar|com\.mx|us|ca|basketball)$/i;

/** Outlet names as Google News gives them (lower case), for stories whose publisher domain we don't have. */
export const TRUSTED_NAMES = [
  'bbc', 'bbc sport', 'bbc news', 'sky sports', 'espn', 'espn fc', 'espn uk', 'the guardian', 'guardian', 'goal', 'goal.com', 'the athletic',
  'the new york times', 'reuters', 'associated press', 'ap news', 'afp', 'france 24', 'bein sports', 'onefootball', 'fourfourtwo',
  'the independent', 'the telegraph', 'the times', 'evening standard', 'mirror', 'daily mail', 'the sun', 'football.london',
  'manchester evening news', 'liverpool echo', 'irish times', 'rte', 'the42', 'cbs sports', 'nbc sports', 'fox sports', 'sports illustrated',
  'usa today', 'yahoo sports', 'washington post', 'los angeles times', 'new york post', 'bleacher report', 'the ringer', 'sporting news',
  'cbc', 'tsn', 'sportsnet', 'abc news', 'al jazeera', 'dw', 'euronews', 'olympics.com', 'marca', 'as', 'as.com', 'mundo deportivo', 'sport',
  'el país', 'el pais', 'relevo', 'record', 'a bola', 'o jogo', 'globo', 'ge', 'lance!', 'olé', 'ole', 'tyc sports', 'infobae',
  'gazzetta dello sport', 'la gazzetta dello sport', 'corriere dello sport', 'tuttosport', 'sky sport', 'football italia', 'kicker',
  'sportschau', 'der spiegel', 'bild', "l'équipe", "l'equipe", 'france football', 'rmc sport', 'le monde', 'le figaro', 'le parisien',
  'voetbal international', 'nos', 'sporza', 'blick', 'arab news', 'saudi gazette', 'al arabiya', 'al arabiya english', 'gulf news',
  'the national', 'khaleej times', 'kooora', 'filgoal', 'ahram online', 'king fut', 'supersport', 'kick off', 'news24', 'japan times',
  'kyodo news', 'korea herald', 'korea times', 'yonhap news agency', 'south china morning post', 'xinhua', 'the hindu', 'times of india',
  'hindustan times', 'the indian express', 'sportstar', 'the straits times', 'bangkok post', 'daily sabah', 'hürriyet daily news',
  'nba', 'nba.com', 'euroleague', 'eurohoops', 'sportando', 'basketnews', 'fiba', 'hoopshype', 'nfl', 'nfl.com', 'profootballtalk', 'ncaa',
  'ncaa.com', 'on3', '247sports', 'transfermarkt', '90min', 'givemesport', 'football365', 'planet football', 'sportbible', 'squawka',
  'premier league', 'laliga', 'serie a', 'bundesliga', 'ligue 1', 'uefa', 'uefa.com', 'fifa', 'fifa.com', 'mls', 'mlssoccer.com', 'spl'
];

const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; } };
export const domainOf = hostOf;

/** A Google News search story's publisher is one we trust (domain from <source url>, else the outlet name). */
export function isTrustedSource(domainOrUrl: string | null | undefined, name: string | null | undefined): boolean {
  const host = domainOrUrl ? hostOf(domainOrUrl) : '';
  if (host) {
    if (/\.edu(\.[a-z]{2})?$|\.ac\.[a-z]{2}$|(^|\.)edu\./.test(host)) return false; // universities never
    if (OFFICIAL_SITE.test(host)) return true;
    if (TRUSTED_DOMAINS.some(d => { const dh = d.split('/')[0]; return host === dh || host.endsWith('.' + dh); })) return true;
    // an unlisted domain still passes under a listed outlet name (ESPN India, Marca English…)
  }
  const n = String(name || '').toLowerCase().trim();
  return !!n && TRUSTED_NAMES.includes(n);
}

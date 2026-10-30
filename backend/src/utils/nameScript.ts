/**
 * fix261: names in the local script (Hebrew, Arabic; Russian / Greek / Hindi later) when no Wikidata label exists.
 * Pure: no imports, no database (services/names.ts stores the results; scripts/fix261.test.mjs checks the spellings).
 *
 * Order of trust (services/names.ts): an admin's own spelling > the Wikidata label > PRESS (below: the spelling Israeli /
 * Arab sports press uses for the big names) > translit() (letter rules per language). A name without any of these stays
 * as the provider writes it. Names never change a slug (links stay Latin, docs/notes/links.md).
 *
 * translit(): word by word. A word in WORDS (club words, cities, nicknames: "United", "Madrid", "Lakers") takes its
 * press spelling; club-form tokens (FC, CF, SC, AFC …) are dropped when other words remain; acronyms ("PSV", "NBA") and
 * numbers stay as written; every other word goes through the letter rules (digraphs first: sch / sh / ch / th / ph / kh
 * / tz …, vowels by place in the word, doubled consonants once, Hebrew final letters).
 */

export type NameLang = 'he' | 'ar';
export const NAME_LANGS: readonly NameLang[] = ['he', 'ar'];
export const isNameLang = (l: unknown): l is NameLang => l === 'he' || l === 'ar';
/** Hebrew or Arabic letters in a string (search: "matches both scripts") */
export const LOCAL_SCRIPT = /[֐-׿؀-ۿݐ-ݿ]/;

/** lower case, accents and punctuation out ("Atlético Madrid" → "atletico madrid"); the key of PRESS / WORDS */
export function nameKey(s: string): string {
  return String(s || '').replace(/[ßẞ]/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/[łŁ]/g, 'l').replace(/[ıİ]/g, 'i').replace(/[đĐ]/g, 'dj')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.'’`"]/g, '').replace(/[^a-z0-9& -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ---------- whole names: the spelling the press uses (Latin key = nameKey) ---------- */
type Pair = [he: string, ar: string];
const P: Record<string, Pair> = {
  // England
  'arsenal': ['ארסנל', 'آرسنال'], 'chelsea': ['צ\'לסי', 'تشيلسي'], 'liverpool': ['ליברפול', 'ليفربول'],
  'manchester city': ['מנצ\'סטר סיטי', 'مانشستر سيتي'], 'manchester united': ['מנצ\'סטר יונייטד', 'مانشستر يونايتد'],
  'tottenham': ['טוטנהאם', 'توتنهام'], 'tottenham hotspur': ['טוטנהאם', 'توتنهام هوتسبير'], 'newcastle': ['ניוקאסל', 'نيوكاسل'],
  'newcastle united': ['ניוקאסל', 'نيوكاسل يونايتد'], 'aston villa': ['אסטון וילה', 'أستون فيلا'], 'west ham': ['ווסטהאם', 'وست هام'],
  'west ham united': ['ווסטהאם', 'وست هام يونايتد'], 'everton': ['אברטון', 'إيفرتون'], 'brighton': ['ברייטון', 'برايتون'],
  'brighton & hove albion': ['ברייטון', 'برايتون'], 'brighton and hove albion': ['ברייטון', 'برايتون'], 'wolves': ['וולבס', 'وولفرهامبتون'],
  'wolverhampton wanderers': ['וולבס', 'وولفرهامبتون'], 'wolverhampton': ['וולבס', 'وولفرهامبتون'], 'crystal palace': ['קריסטל פאלאס', 'كريستال بالاس'],
  'fulham': ['פולהאם', 'فولهام'], 'brentford': ['ברנטפורד', 'برينتفورد'], 'bournemouth': ['בורנמות\'', 'بورنموث'],
  'nottingham forest': ['נוטינגהאם פורסט', 'نوتنغهام فورست'], 'leicester': ['לסטר', 'ليستر سيتي'], 'leicester city': ['לסטר', 'ليستر سيتي'],
  'leeds': ['לידס', 'ليدز يونايتد'], 'leeds united': ['לידס', 'ليدز يونايتد'], 'burnley': ['ברנלי', 'بيرنلي'], 'sunderland': ['סנדרלנד', 'سندرلاند'],
  'southampton': ['סאות\'המפטון', 'ساوثهامبتون'], 'ipswich': ['איפסוויץ\'', 'إيبسويتش'], 'ipswich town': ['איפסוויץ\'', 'إيبسويتش تاون'],
  // Spain
  'real madrid': ['ריאל מדריד', 'ريال مدريد'], 'barcelona': ['ברצלונה', 'برشلونة'], 'fc barcelona': ['ברצלונה', 'برشلونة'],
  'atletico madrid': ['אתלטיקו מדריד', 'أتلتيكو مدريد'], 'atletico de madrid': ['אתלטיקו מדריד', 'أتلتيكو مدريد'], 'sevilla': ['סביליה', 'إشبيلية'],
  'real betis': ['ריאל בטיס', 'ريال بيتيس'], 'valencia': ['ולנסיה', 'فالنسيا'], 'villarreal': ['ויאריאל', 'فياريال'],
  'athletic club': ['אתלטיק בילבאו', 'أتلتيك بلباو'], 'athletic bilbao': ['אתלטיק בילבאו', 'أتلتيك بلباو'], 'real sociedad': ['ריאל סוסיאדד', 'ريال سوسيداد'],
  'girona': ['ג\'ירונה', 'جيرونا'], 'celta vigo': ['סלטה ויגו', 'سيلتا فيغو'], 'osasuna': ['אוססונה', 'أوساسونا'], 'getafe': ['חטאפה', 'خيتافي'],
  'espanyol': ['אספניול', 'إسبانيول'], 'mallorca': ['מיורקה', 'مايوركا'], 'rayo vallecano': ['ראיו ייקאנו', 'رايو فاييكانو'], 'alaves': ['אלאבס', 'ألافيس'],
  'las palmas': ['לאס פאלמאס', 'لاس بالماس'], 'leganes': ['לגאנס', 'ليغانيس'], 'real valladolid': ['ריאל ויאדוליד', 'ريال بلد الوليد'],
  // Italy
  'juventus': ['יובנטוס', 'يوفنتوس'], 'inter': ['אינטר', 'إنتر ميلان'], 'inter milan': ['אינטר', 'إنتر ميلان'], 'internazionale': ['אינטר', 'إنتر ميلان'],
  'ac milan': ['מילאן', 'ميلان'], 'milan': ['מילאן', 'ميلان'], 'napoli': ['נאפולי', 'نابولي'], 'ssc napoli': ['נאפולי', 'نابولي'], 'as roma': ['רומא', 'روما'],
  'roma': ['רומא', 'روما'], 'lazio': ['לאציו', 'لاتسيو'], 'atalanta': ['אטאלנטה', 'أتالانتا'], 'fiorentina': ['פיורנטינה', 'فيورنتينا'],
  'bologna': ['בולוניה', 'بولونيا'], 'torino': ['טורינו', 'تورينو'], 'genoa': ['ג\'נואה', 'جنوى'], 'udinese': ['אודינזה', 'أودينيزي'],
  'sassuolo': ['ססואולו', 'ساسولو'], 'cagliari': ['קליארי', 'كالياري'], 'lecce': ['לצ\'ה', 'ليتشي'], 'parma': ['פארמה', 'بارما'], 'como': ['קומו', 'كومو'],
  // Germany
  'bayern munich': ['באיירן מינכן', 'بايرن ميونخ'], 'bayern munchen': ['באיירן מינכן', 'بايرن ميونخ'], 'fc bayern munchen': ['באיירן מינכן', 'بايرن ميونخ'],
  'borussia dortmund': ['בורוסיה דורטמונד', 'بوروسيا دورتموند'], 'rb leipzig': ['לייפציג', 'لايبزيغ'], 'bayer leverkusen': ['באייר לברקוזן', 'باير ليفركوزن'],
  'eintracht frankfurt': ['איינטרכט פרנקפורט', 'آينتراخت فرانكفورت'], 'vfb stuttgart': ['שטוטגרט', 'شتوتغارت'], 'stuttgart': ['שטוטגרט', 'شتوتغارت'],
  'borussia monchengladbach': ['גלדבאך', 'بوروسيا مونشنغلادباخ'], 'vfl wolfsburg': ['וולפסבורג', 'فولفسبورغ'], 'wolfsburg': ['וולפסבורג', 'فولفسبورغ'],
  'sc freiburg': ['פרייבורג', 'فرايبورغ'], 'freiburg': ['פרייבורג', 'فرايبورغ'], 'werder bremen': ['ורדר ברמן', 'فيردر بريمن'], 'union berlin': ['אוניון ברלין', 'أونيون برلين'],
  '1899 hoffenheim': ['הופנהיים', 'هوفنهايم'], 'hoffenheim': ['הופנהיים', 'هوفنهايم'], 'mainz 05': ['מיינץ', 'ماينتس'], 'fsv mainz 05': ['מיינץ', 'ماينتس'],
  'fc augsburg': ['אאוגסבורג', 'أوغسبورغ'], 'augsburg': ['אאוגסבורג', 'أوغسبورغ'], 'hamburger sv': ['המבורג', 'هامبورغ'], '1 fc koln': ['קלן', 'كولن'], 'fc st pauli': ['סנט פאולי', 'سانت باولي'],
  // France
  'paris saint germain': ['פריז סן ז\'רמן', 'باريس سان جيرمان'], 'paris saint-germain': ['פריז סן ז\'רמן', 'باريس سان جيرمان'], 'psg': ['פריז סן ז\'רמן', 'باريس سان جيرمان'],
  'marseille': ['מארסיי', 'مارسيليا'], 'olympique marseille': ['מארסיי', 'مارسيليا'], 'lyon': ['ליון', 'ليون'], 'olympique lyonnais': ['ליון', 'ليون'],
  'monaco': ['מונאקו', 'موناكو'], 'as monaco': ['מונאקו', 'موناكو'], 'lille': ['ליל', 'ليل'], 'nice': ['ניס', 'نيس'], 'lens': ['לאנס', 'لانس'], 'rennes': ['רן', 'رين'],
  'stade rennais': ['רן', 'رين'], 'nantes': ['נאנט', 'نانت'], 'strasbourg': ['שטרסבורג', 'ستراسبورغ'], 'toulouse': ['טולוז', 'تولوز'], 'brest': ['ברסט', 'بريست'],
  // Netherlands / Portugal / Scotland / Turkey / Belgium / Greece
  'ajax': ['אייאקס', 'أياكس'], 'psv': ['פ.ס.וו איינדהובן', 'آيندهوفن'], 'psv eindhoven': ['פ.ס.וו איינדהובן', 'آيندهوفن'], 'feyenoord': ['פיינורד', 'فينورد'], 'az alkmaar': ['אלקמאר', 'ألكمار'],
  'benfica': ['בנפיקה', 'بنفيكا'], 'porto': ['פורטו', 'بورتو'], 'fc porto': ['פורטו', 'بورتو'], 'sporting cp': ['ספורטינג ליסבון', 'سبورتينغ لشبونة'],
  'sporting lisbon': ['ספורטינג ליסבון', 'سبورتينغ لشبونة'], 'braga': ['בראגה', 'براغا'], 'celtic': ['סלטיק', 'سلتيك'], 'rangers': ['ריינג\'רס', 'رينجرز'],
  'galatasaray': ['גלאטסראיי', 'غلطة سراي'], 'fenerbahce': ['פנרבחצ\'ה', 'فنربخشة'], 'besiktas': ['בשיקטאש', 'بشكتاش'], 'trabzonspor': ['טרבזונספור', 'طرابزون سبور'],
  'club brugge': ['קלוב ברוז\'', 'كلوب بروج'], 'anderlecht': ['אנדרלכט', 'أندرلخت'], 'olympiacos': ['אולימפיאקוס', 'أولمبياكوس'], 'olympiakos piraeus': ['אולימפיאקוס', 'أولمبياكوس'],
  'panathinaikos': ['פנאתינייקוס', 'باناثينايكوس'], 'paok': ['פאוק', 'باوك'], 'aek athens': ['א.א.ק אתונה', 'أيك أثينا'], 'red bull salzburg': ['זלצבורג', 'سالزبورغ'],
  'shakhtar donetsk': ['שחטאר דונייצק', 'شاختار دونيتسك'], 'dynamo kyiv': ['דינמו קייב', 'دينامو كييف'], 'red star belgrade': ['הכוכב האדום בלגרד', 'النجم الأحمر'],
  'crvena zvezda': ['הכוכב האדום בלגרד', 'النجم الأحمر'], 'young boys': ['יאנג בויז', 'يونغ بويز'], 'fc copenhagen': ['קופנהגן', 'كوبنهاغن'], 'dinamo zagreb': ['דינמו זאגרב', 'دينامو زغرب'],
  // Israel (Ligat Ha'al and the Leumit clubs people search for)
  'maccabi tel aviv': ['מכבי תל אביב', 'مكابي تل أبيب'], 'maccabi haifa': ['מכבי חיפה', 'مكابي حيفا'], 'hapoel beer sheva': ['הפועל באר שבע', 'هبوعيل بئر السبع'],
  'hapoel be er sheva': ['הפועל באר שבע', 'هبوعيل بئر السبع'], 'hapoel tel aviv': ['הפועל תל אביב', 'هبوعيل تل أبيب'], 'beitar jerusalem': ['בית"ר ירושלים', 'بيتار القدس'],
  'hapoel jerusalem': ['הפועל ירושלים', 'هبوعيل القدس'], 'maccabi netanya': ['מכבי נתניה', 'مكابي نتانيا'], 'hapoel haifa': ['הפועל חיפה', 'هبوعيل حيفا'],
  'bnei sakhnin': ['בני סכנין', 'أبناء سخنين'], 'ms ashdod': ['מ.ס. אשדוד', 'إم إس أشدود'], 'fc ashdod': ['מ.ס. אשדוד', 'إم إس أشدود'], 'hapoel petah tikva': ['הפועל פתח תקווה', 'هبوعيل بيتاح تكفا'],
  'maccabi petah tikva': ['מכבי פתח תקווה', 'مكابي بيتاح تكفا'], 'maccabi bnei raina': ['מכבי בני ריינה', 'مكابي أبناء الرينة'], 'ironi kiryat shmona': ['עירוני קריית שמונה', 'عيروني كريات شمونة'],
  'hapoel kiryat shmona': ['הפועל קריית שמונה', 'هبوعيل كريات شمونة'], 'hapoel hadera': ['הפועל חדרה', 'هبوعيل الخضيرة'], 'bnei yehuda': ['בני יהודה', 'بني يهودا'],
  'sektzia nes tziona': ['סקציה נס ציונה', 'سيكتسيا نيس تسيونا'], 'ironi tiberias': ['עירוני טבריה', 'عيروني طبريا'], 'hapoel ironi kiryat shmona': ['הפועל עירוני קריית שמונה', 'هبوعيل عيروني كريات شمونة'],
  // Saudi / Gulf / Egypt / North Africa
  'al hilal': ['אל הילאל', 'الهلال'], 'al nassr': ['אל נאסר', 'النصر'], 'al ittihad': ['אל איתיחאד', 'الاتحاد'], 'al ahli': ['אל אהלי', 'الأهلي'],
  'al ahli jeddah': ['אל אהלי', 'الأهلي'], 'al ahli saudi': ['אל אהלי', 'الأهلي'], 'al shabab': ['אל שבאב', 'الشباب'], 'al ettifaq': ['אל אתיפאק', 'الاتفاق'],
  'al taawoun': ['אל תעאון', 'التعاون'], 'al fateh': ['אל פתח', 'الفتح'], 'al qadsiah': ['אל קדסיה', 'القادسية'], 'al fayha': ['אל פייחה', 'الفيحاء'],
  'al raed': ['אל ראאד', 'الرائد'], 'al riyadh': ['אל ריאד', 'الرياض'], 'al khaleej': ['אל ח\'ליג\'', 'الخليج'], 'al wehda': ['אל וחדה', 'الوحدة'],
  'al okhdood': ['אל אוח\'דוד', 'الأخدود'], 'damac': ['דמאק', 'ضمك'], 'al kholood': ['אל ח\'לוד', 'الخلود'], 'al najma': ['אל נג\'מה', 'النجمة'], 'neom': ['נאום', 'نيوم'],
  'al sadd': ['אל סאד', 'السد'], 'al duhail': ['אל דוחייל', 'الدحيل'], 'al rayyan': ['אל ריאן', 'الريان'], 'al gharafa': ['אל ע\'ראפה', 'الغرافة'],
  'al arabi': ['אל ערבי', 'العربي'], 'qatar sc': ['קטאר', 'قطر'], 'al wahda': ['אל וחדה', 'الوحدة'], 'al ain': ['אל עין', 'العين'], 'shabab al ahli': ['שבאב אל אהלי', 'شباب الأهلي'],
  'al jazira': ['אל ג\'זירה', 'الجزيرة'], 'sharjah': ['שארג\'ה', 'الشارقة'], 'al ahly': ['אל אהלי קהיר', 'الأهلي'], 'zamalek': ['זמאלכ', 'الزمالك'], 'pyramids': ['פירמידס', 'بيراميدز'],
  'wydad': ['וידאד', 'الوداد'], 'wydad casablanca': ['וידאד קזבלנקה', 'الوداد الرياضي'], 'raja casablanca': ['ראג\'ה קזבלנקה', 'الرجاء الرياضي'], 'esperance de tunis': ['אספרנס', 'الترجي'],
  'esperance tunis': ['אספרנס', 'الترجي'], 'mamelodi sundowns': ['ממלודי סאנדאונס', 'ماميلودي صن داونز'],
  // the Americas
  'flamengo': ['פלמנגו', 'فلامنغو'], 'palmeiras': ['פלמייראס', 'بالميراس'], 'corinthians': ['קורינתיאנס', 'كورينثيانز'], 'sao paulo': ['סאו פאולו', 'ساو باولو'],
  'santos': ['סנטוס', 'سانتوس'], 'boca juniors': ['בוקה ג\'וניורס', 'بوكا جونيورز'], 'river plate': ['ריבר פלייט', 'ريفر بليت'], 'inter miami': ['אינטר מיאמי', 'إنتر ميامي'],
  'la galaxy': ['לוס אנג\'לס גלקסי', 'لوس أنجلوس غالاكسي'], 'los angeles galaxy': ['לוס אנג\'לס גלקסי', 'لوس أنجلوس غالاكسي'],
  // basketball: EuroLeague, NBA (the city words below + these nicknames make the rest)
  'maccabi playtika tel aviv': ['מכבי תל אביב', 'مكابي تل أبيب'], 'maccabi rapyd tel aviv': ['מכבי תל אביב', 'مكابي تل أبيب'], 'hapoel ibi tel aviv': ['הפועל תל אביב', 'هبوعيل تل أبيب'],
  'real madrid baloncesto': ['ריאל מדריד', 'ريال مدريد'], 'fenerbahce beko': ['פנרבחצ\'ה', 'فنربخشة'], 'anadolu efes': ['אנאדולו אפס', 'أنادولو إفيس'],
  'zalgiris kaunas': ['ז\'לגיריס קובנה', 'جالجيريس كاوناس'], 'partizan': ['פרטיזן', 'بارتيزان'], 'olimpia milano': ['אולימפיה מילאנו', 'أوليمبيا ميلانو'],
  'ea7 emporio armani milano': ['אולימפיה מילאנו', 'أوليمبيا ميلانو'], 'virtus bologna': ['וירטוס בולוניה', 'فيرتوس بولونيا'], 'monaco basket': ['מונאקו', 'موناكو'],
  'baskonia': ['בסקוניה', 'باسكونيا'], 'valencia basket': ['ולנסיה', 'فالنسيا'], 'alba berlin': ['אלבה ברלין', 'ألبا برلين'], 'asvel': ['אסוול', 'أسفيل'],
  'paris basketball': ['פריז', 'باريس'], 'dubai basketball': ['דובאי', 'دبي'],
  // leagues and cups
  'premier league': ['פרמייר ליג', 'الدوري الإنجليزي الممتاز'], 'championship': ['צ\'מפיונשיפ', 'دوري البطولة الإنجليزية'], 'league one': ['ליג 1 האנגלית', 'دوري الدرجة الأولى الإنجليزي'],
  'league two': ['ליג 2 האנגלית', 'دوري الدرجة الثانية الإنجليزي'], 'fa cup': ['הגביע האנגלי', 'كأس الاتحاد الإنجليزي'], 'efl cup': ['גביע הליגה האנגלי', 'كأس الرابطة الإنجليزية'],
  'league cup': ['גביע הליגה', 'كأس الرابطة'], 'community shield': ['מגן הקהילה', 'درع المجتمع'], 'la liga': ['לה ליגה', 'الدوري الإسباني'], 'primera division': ['לה ליגה', 'الدوري الإسباني'],
  'segunda division': ['הליגה השנייה בספרד', 'الدوري الإسباني الدرجة الثانية'], 'copa del rey': ['גביע המלך', 'كأس ملك إسبانيا'], 'serie a': ['סרייה א\'', 'الدوري الإيطالي'],
  'serie b': ['סרייה ב\'', 'الدوري الإيطالي الدرجة الثانية'], 'coppa italia': ['גביע איטליה', 'كأس إيطاليا'], 'bundesliga': ['בונדסליגה', 'الدوري الألماني'],
  '2 bundesliga': ['הבונדסליגה השנייה', 'الدوري الألماني الدرجة الثانية'], 'dfb pokal': ['גביע גרמניה', 'كأس ألمانيا'], 'ligue 1': ['ליג 1', 'الدوري الفرنسي'], 'ligue 2': ['ליג 2', 'الدوري الفرنسي الدرجة الثانية'],
  'coupe de france': ['גביע צרפת', 'كأس فرنسا'], 'eredivisie': ['ארדיביזי', 'الدوري الهولندي'], 'primeira liga': ['הליגה הפורטוגלית', 'الدوري البرتغالي'], 'liga portugal': ['הליגה הפורטוגלית', 'الدوري البرتغالي'],
  'super lig': ['הסופר ליג הטורקית', 'الدوري التركي'], 'premiership': ['הפרמיירשיפ הסקוטית', 'الدوري الاسكتلندي'], 'jupiler pro league': ['הליגה הבלגית', 'الدوري البلجيكي'],
  'pro league': ['הליגה הסעודית', 'دوري روشن السعودي'], 'saudi pro league': ['הליגה הסעודית', 'دوري روشن السعودي'], 'super league': ['הסופרליג היוונית', 'الدوري اليوناني'],
  'ligat haal': ['ליגת העל', 'الدوري الإسرائيلي الممتاز'], 'ligat ha al': ['ליגת העל', 'الدوري الإسرائيلي الممتاز'], 'liga leumit': ['הליגה הלאומית', 'الدوري الإسرائيلي الدرجة الثانية'],
  'state cup': ['גביע המדינה', 'كأس الدولة'], 'toto cup ligat al': ['גביע הטוטו', 'كأس توتو'], 'stars league': ['ליגת הכוכבים', 'دوري نجوم قطر'], 'egyptian premier league': ['הליגה המצרית', 'الدوري المصري الممتاز'],
  'botola pro': ['הליגה המרוקאית', 'الدوري المغربي'], 'mls': ['MLS', 'الدوري الأمريكي'], 'major league soccer': ['MLS', 'الدوري الأمريكي'], 'serie a brazil': ['הליגה הברזילאית', 'الدوري البرازيلي'],
  'brasileirao': ['הליגה הברזילאית', 'الدوري البرازيلي'], 'liga profesional argentina': ['הליגה הארגנטינאית', 'الدوري الأرجنتيني'], 'liga mx': ['הליגה המקסיקנית', 'الدوري المكسيكي'],
  'uefa champions league': ['ליגת האלופות', 'دوري أبطال أوروبا'], 'champions league': ['ליגת האלופות', 'دوري أبطال أوروبا'], 'uefa europa league': ['הליגה האירופית', 'الدوري الأوروبي'],
  'europa league': ['הליגה האירופית', 'الدوري الأوروبي'], 'uefa europa conference league': ['הקונפרנס ליג', 'دوري المؤتمر الأوروبي'], 'uefa conference league': ['הקונפרנס ליג', 'دوري المؤتمر الأوروبي'],
  'conference league': ['הקונפרנס ליג', 'دوري المؤتمر الأوروبي'], 'uefa super cup': ['הסופר קאפ האירופי', 'كأس السوبر الأوروبي'], 'uefa nations league': ['ליגת האומות', 'دوري الأمم الأوروبية'],
  'nations league': ['ליגת האומות', 'دوري الأمم'], 'world cup': ['המונדיאל', 'كأس العالم'], 'fifa world cup': ['המונדיאל', 'كأس العالم'], 'world cup qualification': ['מוקדמות המונדיאל', 'تصفيات كأس العالم'],
  'european championship': ['אליפות אירופה', 'بطولة أمم أوروبا'], 'euro championship': ['אליפות אירופה', 'بطولة أمم أوروبا'], 'africa cup of nations': ['אליפות אפריקה', 'كأس الأمم الأفريقية'],
  'asian cup': ['גביע אסיה', 'كأس آسيا'], 'copa america': ['קופה אמריקה', 'كوبا أمريكا'], 'copa libertadores': ['קופה ליברטדורס', 'كأس ليبرتادوريس'], 'club world cup': ['מונדיאל הקבוצות', 'كأس العالم للأندية'],
  'afc champions league': ['ליגת האלופות האסייתית', 'دوري أبطال آسيا'], 'afc champions league elite': ['ליגת האלופות האסייתית', 'دوري أبطال آسيا للنخبة'], 'caf champions league': ['ליגת האלופות האפריקאית', 'دوري أبطال أفريقيا'],
  'friendlies': ['משחקי ידידות', 'مباريات ودية'], 'friendlies clubs': ['משחקי ידידות', 'مباريات ودية'], 'nba': ['NBA', 'NBA'], 'euroleague': ['יורוליג', 'اليوروليغ'], 'eurocup': ['יורוקאפ', 'اليوروكاب'],
  'acb': ['הליגה הספרדית', 'الدوري الإسباني لكرة السلة'], 'liga acb': ['הליגה הספרדית', 'الدوري الإسباني لكرة السلة'], 'winner league': ['ליגת העל בכדורסל', 'الدوري الإسرائيلي لكرة السلة'],
  'nfl': ['NFL', 'NFL'], 'ncaa': ['NCAA', 'NCAA'], 'atp': ['ATP', 'ATP'], 'wta': ['WTA', 'WTA'],
  'wimbledon': ['וימבלדון', 'ويمبلدون'], 'roland garros': ['רולאן גארוס', 'رولان غاروس'], 'french open': ['רולאן גארוס', 'رولان غاروس'], 'us open': ['אליפות ארה"ב הפתוחה', 'بطولة أمريكا المفتوحة'],
  'australian open': ['אליפות אוסטרליה הפתוחה', 'بطولة أستراليا المفتوحة'],
  // the players everyone searches for
  'lionel messi': ['ליונל מסי', 'ليونيل ميسي'], 'l messi': ['L. מסי', 'L. ميسي'], 'cristiano ronaldo': ['כריסטיאנו רונאלדו', 'كريستيانو رونالدو'],
  'kylian mbappe': ['קיליאן אמבפה', 'كيليان مبابي'], 'k mbappe': ['K. אמבפה', 'K. مبابي'], 'erling haaland': ['ארלינג הולאנד', 'إيرلينغ هالاند'], 'e haaland': ['E. הולאנד', 'E. هالاند'],
  'mohamed salah': ['מוחמד סלאח', 'محمد صلاح'], 'm salah': ['M. סלאח', 'M. صلاح'], 'harry kane': ['הארי קיין', 'هاري كين'], 'h kane': ['H. קיין', 'H. كين'],
  'jude bellingham': ['ג\'וד בלינגהאם', 'جود بيلينغهام'], 'vinicius junior': ['ויניסיוס ג\'וניור', 'فينيسيوس جونيور'], 'vinicius jr': ['ויניסיוס ג\'וניור', 'فينيسيوس جونيور'],
  'lamine yamal': ['לאמין ימאל', 'لامين يامال'], 'robert lewandowski': ['רוברט לבנדובסקי', 'روبرت ليفاندوفسكي'], 'kevin de bruyne': ['קווין דה בריינה', 'كيفن دي بروين'],
  'neymar': ['ניימאר', 'نيمار'], 'karim benzema': ['קארים בנזמה', 'كريم بنزيما'], 'riyad mahrez': ['ריאד מחרז', 'رياض محرز'], 'achraf hakimi': ['אשרף חכימי', 'أشرف حكيمي'],
  'manor solomon': ['מנור סולומון', 'مانور سولومون'], 'oscar gloukh': ['אוסקר גלוך', 'أوسكار غلوخ'], 'eran zahavi': ['ערן זהבי', 'عيران زهافي'],
  'lebron james': ['לברון ג\'יימס', 'ليبرون جيمس'], 'stephen curry': ['סטף קרי', 'ستيفن كوري'], 'nikola jokic': ['ניקולה יוקיץ\'', 'نيكولا يوكيتش'], 'luka doncic': ['לוקה דונצ\'יץ\'', 'لوكا دونتشيتش'],
  'giannis antetokounmpo': ['יאניס אנטטוקומפו', 'يانيس أنتيتوكومبو'], 'kevin durant': ['קווין דוראנט', 'كيفن ديورانت'], 'deni avdija': ['דני אבדיה', 'ديني أفدييا'],
  'victor wembanyama': ['ויקטור וומבניאמה', 'فيكتور ويمبانياما'], 'jayson tatum': ['ג\'ייסון טייטום', 'جايسون تاتوم'], 'shai gilgeous-alexander': ['שיי גילג\'ס-אלכסנדר', 'شاي غيلجس ألكسندر'],
  'damian lillard': ['דמיאן לילארד', 'داميان ليلارد'], 'levante': ['לבאנטה', 'ليفانتي'], 'levante ud': ['לבאנטה', 'ليفانتي'],
  'carlos alcaraz': ['קרלוס אלקראס', 'كارلوس ألكاراز'], 'jannik sinner': ['יאניק סינר', 'يانيك سينر'], 'novak djokovic': ['נובאק ג\'וקוביץ\'', 'نوفاك ديوكوفيتش'],
  'aryna sabalenka': ['ארינה סבלנקה', 'أرينا سابالينكا'], 'iga swiatek': ['איגה שוויונטק', 'إيغا شفيونتيك'], 'coco gauff': ['קוקו גאוף', 'كوكو غوف'], 'ons jabeur': ['אונס ג\'אבר', 'أنس جابر']
};
export const PRESS: Record<NameLang, Map<string, string>> = { he: new Map(), ar: new Map() };
for (const [k, [he, ar]] of Object.entries(P)) { PRESS.he.set(k, he); PRESS.ar.set(k, ar); }

/* ---------- countries (the site shows them on leagues, flags, players) ---------- */
const C: Record<string, Pair> = {
  'england': ['אנגליה', 'إنجلترا'], 'scotland': ['סקוטלנד', 'اسكتلندا'], 'wales': ['ויילס', 'ويلز'], 'northern ireland': ['צפון אירלנד', 'أيرلندا الشمالية'],
  'ireland': ['אירלנד', 'أيرلندا'], 'spain': ['ספרד', 'إسبانيا'], 'italy': ['איטליה', 'إيطاليا'], 'germany': ['גרמניה', 'ألمانيا'], 'france': ['צרפת', 'فرنسا'],
  'netherlands': ['הולנד', 'هولندا'], 'portugal': ['פורטוגל', 'البرتغال'], 'belgium': ['בלגיה', 'بلجيكا'], 'turkey': ['טורקיה', 'تركيا'], 'turkiye': ['טורקיה', 'تركيا'],
  'greece': ['יוון', 'اليونان'], 'austria': ['אוסטריה', 'النمسا'], 'switzerland': ['שווייץ', 'سويسرا'], 'denmark': ['דנמרק', 'الدنمارك'], 'sweden': ['שוודיה', 'السويد'],
  'norway': ['נורווגיה', 'النرويج'], 'finland': ['פינלנד', 'فنلندا'], 'iceland': ['איסלנד', 'آيسلندا'], 'poland': ['פולין', 'بولندا'], 'czech republic': ['צ\'כיה', 'التشيك'],
  'czechia': ['צ\'כיה', 'التشيك'], 'slovakia': ['סלובקיה', 'سلوفاكيا'], 'hungary': ['הונגריה', 'المجر'], 'romania': ['רומניה', 'رومانيا'], 'bulgaria': ['בולגריה', 'بلغاريا'],
  'serbia': ['סרביה', 'صربيا'], 'croatia': ['קרואטיה', 'كرواتيا'], 'slovenia': ['סלובניה', 'سلوفينيا'], 'bosnia': ['בוסניה', 'البوسنة'], 'bosnia and herzegovina': ['בוסניה והרצגובינה', 'البوسنة والهرسك'],
  'montenegro': ['מונטנגרו', 'الجبل الأسود'], 'north macedonia': ['צפון מקדוניה', 'مقدونيا الشمالية'], 'albania': ['אלבניה', 'ألبانيا'], 'kosovo': ['קוסובו', 'كوسوفو'],
  'ukraine': ['אוקראינה', 'أوكرانيا'], 'russia': ['רוסיה', 'روسيا'], 'belarus': ['בלארוס', 'بيلاروسيا'], 'georgia': ['גאורגיה', 'جورجيا'], 'armenia': ['ארמניה', 'أرمينيا'],
  'azerbaijan': ['אזרבייג\'ן', 'أذربيجان'], 'kazakhstan': ['קזחסטן', 'كازاخستان'], 'cyprus': ['קפריסין', 'قبرص'], 'malta': ['מלטה', 'مالطا'], 'luxembourg': ['לוקסמבורג', 'لوكسمبورغ'],
  'lithuania': ['ליטא', 'ليتوانيا'], 'latvia': ['לטביה', 'لاتفيا'], 'estonia': ['אסטוניה', 'إستونيا'], 'moldova': ['מולדובה', 'مولدوفا'], 'israel': ['ישראל', 'إسرائيل'],
  'saudi arabia': ['ערב הסעודית', 'السعودية'], 'qatar': ['קטאר', 'قطر'], 'united arab emirates': ['איחוד האמירויות', 'الإمارات'], 'uae': ['איחוד האמירויות', 'الإمارات'],
  'egypt': ['מצרים', 'مصر'], 'morocco': ['מרוקו', 'المغرب'], 'tunisia': ['תוניסיה', 'تونس'], 'algeria': ['אלג\'יריה', 'الجزائر'], 'jordan': ['ירדן', 'الأردن'], 'iraq': ['עיראק', 'العراق'],
  'iran': ['איראן', 'إيران'], 'kuwait': ['כווית', 'الكويت'], 'bahrain': ['בחריין', 'البحرين'], 'oman': ['עומאן', 'عمان'], 'lebanon': ['לבנון', 'لبنان'], 'syria': ['סוריה', 'سوريا'],
  'palestine': ['פלסטין', 'فلسطين'], 'libya': ['לוב', 'ليبيا'], 'sudan': ['סודאן', 'السودان'], 'yemen': ['תימן', 'اليمن'], 'japan': ['יפן', 'اليابان'], 'south korea': ['דרום קוריאה', 'كوريا الجنوبية'],
  'korea republic': ['דרום קוריאה', 'كوريا الجنوبية'], 'china': ['סין', 'الصين'], 'india': ['הודו', 'الهند'], 'australia': ['אוסטרליה', 'أستراليا'], 'new zealand': ['ניו זילנד', 'نيوزيلندا'],
  'usa': ['ארה"ב', 'الولايات المتحدة'], 'united states': ['ארה"ב', 'الولايات المتحدة'], 'canada': ['קנדה', 'كندا'], 'mexico': ['מקסיקו', 'المكسيك'], 'brazil': ['ברזיל', 'البرازيل'],
  'argentina': ['ארגנטינה', 'الأرجنتين'], 'uruguay': ['אורוגוואי', 'الأوروغواي'], 'chile': ['צ\'ילה', 'تشيلي'], 'colombia': ['קולומביה', 'كولومبيا'], 'peru': ['פרו', 'بيرو'],
  'ecuador': ['אקוודור', 'الإكوادور'], 'paraguay': ['פרגוואי', 'باراغواي'], 'bolivia': ['בוליביה', 'بوليفيا'], 'venezuela': ['ונצואלה', 'فنزويلا'], 'costa rica': ['קוסטה ריקה', 'كوستاريكا'],
  'nigeria': ['ניגריה', 'نيجيريا'], 'ghana': ['גאנה', 'غانا'], 'senegal': ['סנגל', 'السنغال'], 'cameroon': ['קמרון', 'الكاميرون'], 'ivory coast': ['חוף השנהב', 'ساحل العاج'],
  'cote divoire': ['חוף השנהב', 'ساحل العاج'], 'south africa': ['דרום אפריקה', 'جنوب أفريقيا'], 'mali': ['מאלי', 'مالي'], 'world': ['עולם', 'العالم'], 'europe': ['אירופה', 'أوروبا'],
  'asia': ['אסיה', 'آسيا'], 'africa': ['אפריקה', 'أفريقيا'], 'south america': ['דרום אמריקה', 'أمريكا الجنوبية'], 'north america': ['צפון אמריקה', 'أمريكا الشمالية']
};
export const COUNTRIES: Record<NameLang, Map<string, string>> = { he: new Map(), ar: new Map() };
for (const [k, [he, ar]] of Object.entries(C)) { COUNTRIES.he.set(k, he); COUNTRIES.ar.set(k, ar); }

/* ---------- words inside names (club words, cities, nicknames) ---------- */
const W: Record<string, Pair> = {
  'united': ['יונייטד', 'يونايتد'], 'city': ['סיטי', 'سيتي'], 'town': ['טאון', 'تاون'], 'county': ['קאונטי', 'كاونتي'], 'rovers': ['רוברס', 'روفرز'],
  'wanderers': ['וונדררס', 'واندررز'], 'athletic': ['אתלטיק', 'أتلتيك'], 'atletico': ['אתלטיקו', 'أتلتيكو'], 'real': ['ריאל', 'ريال'], 'sporting': ['ספורטינג', 'سبورتينغ'],
  'olympique': ['אולימפיק', 'أولمبيك'], 'olympic': ['אולימפיק', 'أولمبيك'], 'club': ['קלוב', 'كلوب'], 'union': ['אוניון', 'أونيون'], 'albion': ['אלביון', 'ألبيون'],
  'villa': ['וילה', 'فيلا'], 'palace': ['פאלאס', 'بالاس'], 'forest': ['פורסט', 'فورست'], 'rangers': ['ריינג\'רס', 'رينجرز'], 'hotspur': ['הוטספר', 'هوتسبير'],
  'inter': ['אינטר', 'إنتر'], 'dynamo': ['דינמו', 'دينامو'], 'dinamo': ['דינמו', 'دينامو'], 'saint': ['סן', 'سان'], 'st': ['סנט', 'سانت'], 'san': ['סן', 'سان'],
  'santa': ['סנטה', 'سانتا'], 'sao': ['סאו', 'ساو'], 'new': ['ניו', 'نيو'], 'york': ['יורק', 'يورك'], 'los': ['לוס', 'لوس'], 'las': ['לאס', 'لاس'], 'la': ['לה', 'لا'],
  'le': ['לה', 'لو'], 'de': ['דה', 'دي'], 'del': ['דל', 'ديل'], 'golden': ['גולדן', 'غولدن'], 'state': ['סטייט', 'ستيت'], 'young': ['יאנג', 'يونغ'], 'boys': ['בויז', 'بويز'],
  'red': ['רד', 'ريد'], 'star': ['סטאר', 'ستار'], 'bull': ['בול', 'بول'], 'bulls': ['בולס', 'بولز'], 'maccabi': ['מכבי', 'مكابي'], 'hapoel': ['הפועל', 'هبوعيل'],
  'beitar': ['בית"ר', 'بيتار'], 'bnei': ['בני', 'أبناء'], 'ironi': ['עירוני', 'عيروني'], 'sektzia': ['סקציה', 'سيكتسيا'], 'al': ['אל', 'ال'], 'el': ['אל', 'ال'],
  // cities
  'madrid': ['מדריד', 'مدريد'], 'barcelona': ['ברצלונה', 'برشلونة'], 'manchester': ['מנצ\'סטר', 'مانشستر'], 'london': ['לונדון', 'لندن'], 'paris': ['פריז', 'باريس'],
  'munich': ['מינכן', 'ميونخ'], 'munchen': ['מינכן', 'ميونخ'], 'milan': ['מילאן', 'ميلان'], 'milano': ['מילאנו', 'ميلانو'], 'rome': ['רומא', 'روما'], 'roma': ['רומא', 'روما'],
  'berlin': ['ברלין', 'برلين'], 'hamburg': ['המבורג', 'هامبورغ'], 'lisbon': ['ליסבון', 'لشبونة'], 'lisboa': ['ליסבון', 'لشبونة'], 'amsterdam': ['אמסטרדם', 'أمستردام'],
  'istanbul': ['איסטנבול', 'إسطنبول'], 'athens': ['אתונה', 'أثينا'], 'vienna': ['וינה', 'فيينا'], 'wien': ['וינה', 'فيينا'], 'prague': ['פראג', 'براغ'], 'praha': ['פראג', 'براغ'],
  'belgrade': ['בלגרד', 'بلغراد'], 'beograd': ['בלגרד', 'بلغراد'], 'zagreb': ['זאגרב', 'زغرب'], 'kyiv': ['קייב', 'كييف'], 'moscow': ['מוסקבה', 'موسكو'], 'moskva': ['מוסקבה', 'موسكو'],
  'tel': ['תל', 'تل'], 'aviv': ['אביב', 'أبيب'], 'haifa': ['חיפה', 'حيفا'], 'jerusalem': ['ירושלים', 'القدس'], 'beer': ['באר', 'بئر'], 'sheva': ['שבע', 'السبع'],
  'netanya': ['נתניה', 'نتانيا'], 'ashdod': ['אשדוד', 'أشدود'], 'petah': ['פתח', 'بيتاح'], 'tikva': ['תקווה', 'تكفا'], 'hadera': ['חדרה', 'الخضيرة'], 'sakhnin': ['סכנין', 'سخنين'],
  'herzliya': ['הרצליה', 'هرتسليا'], 'holon': ['חולון', 'حولون'], 'rishon': ['ראשון', 'ريشون'], 'lezion': ['לציון', 'لتسيون'], 'ramat': ['רמת', 'رمات'], 'gan': ['גן', 'غان'],
  'eilat': ['אילת', 'إيلات'], 'galil': ['גליל', 'الجليل'], 'elyon': ['עליון', 'الأعلى'], 'nahariya': ['נהריה', 'نهاريا'], 'kiryat': ['קריית', 'كريات'], 'shmona': ['שמונה', 'شمونة'],
  'riyadh': ['ריאד', 'الرياض'], 'jeddah': ['ג\'דה', 'جدة'], 'doha': ['דוחה', 'الدوحة'], 'dubai': ['דובאי', 'دبي'], 'cairo': ['קהיר', 'القاهرة'], 'casablanca': ['קזבלנקה', 'الدار البيضاء'],
  'tunis': ['תוניס', 'تونس'], 'algiers': ['אלג\'יר', 'الجزائر'], 'amman': ['עמאן', 'عمان'], 'beirut': ['ביירות', 'بيروت'], 'baghdad': ['בגדאד', 'بغداد'],
  'boston': ['בוסטון', 'بوسطن'], 'chicago': ['שיקגו', 'شيكاغو'], 'miami': ['מיאמי', 'ميامي'], 'angeles': ['אנג\'לס', 'أنجلوس'], 'francisco': ['פרנסיסקו', 'فرانسيسكو'],
  'philadelphia': ['פילדלפיה', 'فيلادلفيا'], 'dallas': ['דאלאס', 'دالاس'], 'houston': ['יוסטון', 'هيوستن'], 'denver': ['דנוור', 'دنفر'], 'phoenix': ['פיניקס', 'فينيكس'],
  'atlanta': ['אטלנטה', 'أتلانتا'], 'detroit': ['דטרויט', 'ديترويت'], 'cleveland': ['קליבלנד', 'كليفلاند'], 'milwaukee': ['מילווקי', 'ميلووكي'], 'toronto': ['טורונטו', 'تورونتو'],
  'brooklyn': ['ברוקלין', 'بروكلين'], 'orleans': ['אורלינס', 'أورليانز'], 'orlando': ['אורלנדו', 'أورلاندو'], 'memphis': ['ממפיס', 'ممفيس'], 'sacramento': ['סקרמנטו', 'ساكرامنتو'],
  'portland': ['פורטלנד', 'بورتلاند'], 'utah': ['יוטה', 'يوتا'], 'minnesota': ['מינסוטה', 'مينيسوتا'], 'oklahoma': ['אוקלהומה', 'أوكلاهوما'], 'indiana': ['אינדיאנה', 'إنديانا'],
  'charlotte': ['שארלוט', 'شارلوت'], 'washington': ['וושינגטון', 'واشنطن'], 'antonio': ['אנטוניו', 'أنطونيو'], 'seattle': ['סיאטל', 'سياتل'], 'kansas': ['קנזס', 'كانساس'],
  'pittsburgh': ['פיטסבורג', 'بيتسبرغ'], 'baltimore': ['בולטימור', 'بالتيمور'], 'buffalo': ['באפלו', 'بافالو'], 'green': ['גרין', 'غرين'], 'bay': ['ביי', 'باي'],
  'las vegas': ['לאס וגאס', 'لاس فيغاس'], 'vegas': ['וגאס', 'فيغاس'], 'tampa': ['טמפה', 'تامبا'], 'carolina': ['קרוליינה', 'كارولاينا'], 'jacksonville': ['ג\'קסונוויל', 'جاكسونفيل'],
  'cincinnati': ['סינסינטי', 'سينسيناتي'], 'tennessee': ['טנסי', 'تينيسي'], 'arizona': ['אריזונה', 'أريزونا'], 'england': ['אינגלנד', 'إنجلترا'],
  // NBA / NFL nicknames
  'lakers': ['לייקרס', 'ليكرز'], 'celtics': ['סלטיקס', 'سيلتكس'], 'warriors': ['ווריורס', 'ووريورز'], 'knicks': ['ניקס', 'نيكس'], 'nets': ['נטס', 'نتس'],
  'heat': ['היט', 'هيت'], 'bucks': ['באקס', 'باكس'], 'nuggets': ['נאגטס', 'ناغتس'], 'suns': ['סאנס', 'صنز'], 'clippers': ['קליפרס', 'كليبرز'], 'mavericks': ['מאבריקס', 'مافريكس'],
  'rockets': ['רוקטס', 'روكتس'], 'spurs': ['ספרס', 'سبيرز'], 'grizzlies': ['גריזליס', 'غريزليز'], 'pelicans': ['פליקנס', 'بيليكانز'], 'thunder': ['ת\'אנדר', 'ثاندر'],
  'jazz': ['ג\'אז', 'جاز'], 'kings': ['קינגס', 'كينغز'], 'trail': ['טרייל', 'تريل'], 'blazers': ['בלייזרס', 'بليزرز'], 'timberwolves': ['טימברוולבס', 'تمبروولفز'],
  'pacers': ['פייסרס', 'بيسرز'], 'pistons': ['פיסטונס', 'بيستونز'], 'cavaliers': ['קאבלירס', 'كافالييرز'], 'raptors': ['ראפטורס', 'رابتورز'], 'magic': ['מג\'יק', 'ماجيك'],
  'hawks': ['הוקס', 'هوكس'], 'hornets': ['הורנטס', 'هورنتس'], 'wizards': ['וויזארדס', 'ويزاردز'], '76ers': ['פילדלפיה 76', 'سيكسرز'], 'sixers': ['סיקסרס', 'سيكسرز'],
  'patriots': ['פטריוטס', 'باتريوتس'], 'cowboys': ['קאובויס', 'كاوبويز'], 'chiefs': ['צ\'יפס', 'تشيفس'], 'eagles': ['איגלס', 'إيغلز'], 'packers': ['פאקרס', 'باكرز'],
  'giants': ['ג\'איינטס', 'جاينتس'], 'jets': ['ג\'טס', 'جتس'], 'steelers': ['סטילרס', 'ستيلرز'], 'ravens': ['רייבנס', 'رافينز'], 'bills': ['בילס', 'بيلز'], '49ers': ['49ers', '49ers'],
  'dolphins': ['דולפינס', 'دولفينز'], 'bears': ['ברס', 'بيرز'], 'lions': ['ליונס', 'لايونز'], 'vikings': ['ויקינגס', 'فايكنغز'], 'saints': ['סיינטס', 'ساينتس'],
  'falcons': ['פלקונס', 'فالكونز'], 'panthers': ['פנת\'רס', 'بانثرز'], 'buccaneers': ['באקנירס', 'باكانيرز'], 'seahawks': ['סיהוקס', 'سيهوكس'], 'rams': ['ראמס', 'رامز'],
  'cardinals': ['קרדינלס', 'كاردينالز'], 'broncos': ['ברונקוס', 'برونكوز'], 'raiders': ['ריידרס', 'رايدرز'], 'chargers': ['צ\'רג\'רס', 'تشارجرز'], 'texans': ['טקסנס', 'تكسانز'],
  'colts': ['קולטס', 'كولتس'], 'jaguars': ['ג\'גוארס', 'جاغوارز'], 'titans': ['טייטנס', 'تايتنز'], 'browns': ['בראונס', 'براونز'], 'bengals': ['בנגלס', 'بنغالز'],
  'commanders': ['קומנדרס', 'كوماندرز'], 'basket': ['בסקט', 'باسكت'], 'basketball': ['כדורסל', 'كرة السلة'], 'baloncesto': ['', ''], 'women': ['נשים', 'سيدات'],
  'u21': ['עד גיל 21', 'تحت 21'], 'u23': ['עד גיל 23', 'تحت 23'], 'u20': ['עד גיל 20', 'تحت 20'], 'u19': ['עד גיל 19', 'تحت 19'], 'u17': ['עד גיל 17', 'تحت 17'], 'ii': ['ב\'', 'الثاني'], 'b': ['ב\'', 'ب']
};
export const WORDS: Record<NameLang, Map<string, string>> = { he: new Map(), ar: new Map() };
for (const [k, [he, ar]] of Object.entries(W)) { WORDS.he.set(k, he); WORDS.ar.set(k, ar); }
/** club-form tokens left out when other words remain ("FC Barcelona" → "Barcelona") */
const DROP = new Set(['fc', 'cf', 'sc', 'afc', 'fk', 'cd', 'sd', 'ud', 'ac', 'as', 'ss', 'ssc', 'us', 'sk', 'bk', 'if', 'osc', 'losc', 'bsc', 'vfb', 'vfl', 'tsg', 'sv', 'fsv',
  'rcd', 'rc', 'cfc', 'sl', 'kv', 'krc', 'nk', 'hnk', 'gnk', 'fco', 'ogc', 'sco', 'sm', 'ca', 'se', 'ec', 'cr', 'aek', 'paok', 'kf', 'ofk', 'pfc', 'jk', 'ik', 'aik', 'ifk', 'bc', 'kk', 'cb', 'bk', 'sad', 'calcio', '1899', '1909', '1846', '1860', '1900', '1907', '1913', '04', '05', '96', '1']);
const KEEP_IF_ALONE = new Set(['aek', 'paok', 'psv', 'az', 'aik']);

/* ---------- letter rules ---------- */
type Rules = { cons: [string, string][]; v: (g: string, at: 'start' | 'mid' | 'end') => string; finals?: Record<string, string>; join?: string };
const HE: Rules = {
  cons: [['sch', 'ש'], ['tch', 'צ\''], ['sh', 'ש'], ['ch', 'צ\''], ['zh', 'ז\''], ['th', 'ת\''], ['ph', 'פ'], ['kh', 'ח'], ['gh', 'ג'], ['ck', 'ק'], ['qu', 'קו'],
    ['tz', 'צ'], ['ts', 'צ'], ['zz', 'צ'], ['dj', 'ג\''], ['dz', 'דז'], ['x', 'קס'], ['b', 'ב'], ['d', 'ד'], ['f', 'פ'], ['g', 'ג'], ['h', 'ה'], ['j', 'ג\''], ['k', 'ק'],
    ['l', 'ל'], ['m', 'מ'], ['n', 'נ'], ['p', 'פ'], ['q', 'ק'], ['r', 'ר'], ['s', 'ס'], ['t', 'ט'], ['v', 'ו'], ['w', 'וו'], ['z', 'ז'], ['y', 'י'], ['ce', 'ס'], ['ci', 'ס'], ['cy', 'ס'], ['c', 'ק']],
  v: (g, at) => {
    if (at === 'start') return /^(o|u|ou|oo|au)/.test(g) ? 'או' : /^(i|ee|ie)/.test(g) ? 'אי' : /^(ai|ay|ei|ey)/.test(g) ? 'איי' : 'א';
    if (at === 'end') return /^(a|ah|ia|ea)$/.test(g) ? (g.length > 1 ? 'יה' : 'ה') : /^(e)$/.test(g) ? 'ה' : /(i|y|ee|ie|ey)$/.test(g) ? 'י' : /(o|u|ou|oo)$/.test(g) ? 'ו' : /(ai|ay|ei)$/.test(g) ? 'יי' : '';
    if (/^(ai|ay|ei|ey)$/.test(g)) return 'יי';
    if (/^(ee|ie|ea|i|y)$/.test(g)) return 'י';
    if (/^(ou|oo|o|u|oa|oe|ue)$/.test(g)) return 'ו';
    if (/^(au|ao)$/.test(g)) return 'או';
    if (/^(ia|io|iu)$/.test(g)) return g === 'ia' ? 'יא' : 'יו';
    if (g === 'aa') return 'א';
    if (g.length > 1) return g.replace(/a|e/g, '').replace(/[iy]/g, 'י').replace(/[ou]/g, 'ו') || 'א';
    return '';
  },
  finals: { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' }
};
const AR: Rules = {
  cons: [['sch', 'ش'], ['tch', 'تش'], ['sh', 'ش'], ['ch', 'تش'], ['zh', 'ج'], ['th', 'ث'], ['ph', 'ف'], ['kh', 'خ'], ['gh', 'غ'], ['ck', 'ك'], ['qu', 'كو'],
    ['tz', 'تس'], ['ts', 'تس'], ['zz', 'تس'], ['dj', 'ج'], ['dz', 'دز'], ['x', 'كس'], ['b', 'ب'], ['d', 'د'], ['f', 'ف'], ['g', 'غ'], ['h', 'ه'], ['j', 'ج'], ['k', 'ك'],
    ['l', 'ل'], ['m', 'م'], ['n', 'ن'], ['p', 'ب'], ['q', 'ك'], ['r', 'ر'], ['s', 'س'], ['t', 'ت'], ['v', 'ف'], ['w', 'و'], ['z', 'ز'], ['y', 'ي'], ['ce', 'س'], ['ci', 'س'], ['cy', 'س'], ['c', 'ك']],
  v: (g, at) => {
    if (at === 'start') return /^(o|u|ou|oo|au)/.test(g) ? 'أو' : /^(i|ee|ie)/.test(g) ? 'إي' : /^(ai|ay|ei|ey)/.test(g) ? 'آي' : 'أ';
    if (at === 'end') return /^(a|ah|ia|ea)$/.test(g) ? (g.length > 1 ? 'يا' : 'ا') : /(e|i|y|ee|ie|ey|ai|ay|ei)$/.test(g) ? 'ي' : /(o|u|ou|oo)$/.test(g) ? 'و' : '';
    if (/^(a|aa)$/.test(g)) return 'ا';
    if (/^(ai|ay|ei|ey)$/.test(g)) return 'اي';
    if (/^(ee|ie|ea|i|y)$/.test(g)) return 'ي';
    if (/^(ou|oo|o|u|oa|oe|ue)$/.test(g)) return 'و';
    if (/^(au|ao)$/.test(g)) return 'او';
    if (/^(ia|io|iu)$/.test(g)) return g === 'ia' ? 'يا' : 'يو';
    if (g.length > 1) return g.replace(/e/g, '').replace(/a/g, 'ا').replace(/[iy]/g, 'ي').replace(/[ou]/g, 'و');
    return '';
  }
};
const RULES: Record<NameLang, Rules> = { he: HE, ar: AR };
const VOWEL = /[aeiouy]/;
const MAGIC: Record<NameLang, Record<string, string>> = { he: { a: 'יי', i: 'יי', o: 'ו' }, ar: { a: 'ي', i: 'اي', o: 'و' } };

/** one Latin word (already nameKey'd: a–z) by the letter rules */
export function translitWord(word: string, lang: NameLang): string {
  const r = RULES[lang];
  const w = word.replace(/([bcdfghjklmnpqrstvwxz])\1+/g, '$1'); // doubled consonants once
  let out = '';
  let i = 0;
  while (i < w.length) {
    const ch = w[i];
    // y between vowels or at the start before a vowel is a consonant
    const yCons = ch === 'y' && (i === 0 || /[aeiou]/.test(w[i - 1])) && /[aeiou]/.test(w[i + 1] || '');
    if (VOWEL.test(ch) && !yCons) {
      let j = i;
      while (j < w.length && VOWEL.test(w[j]) && !(j > i && w[j] === 'y' && VOWEL.test(w[j + 1] || ''))) j++;
      const g = w.slice(i, j);
      let at: 'start' | 'mid' | 'end' = i === 0 ? 'start' : j >= w.length ? 'end' : 'mid';
      // English "magic e" (Kane, Rice, Stone): a final e after one consonant after a vowel is silent
      if (at === 'end' && g === 'e' && i >= 2 && !VOWEL.test(w[i - 1]) && VOWEL.test(w[i - 2]) && w.length > 3) { i = j; continue; }
      // ... and the vowel before it is long: Kane → קיין, Rice → רייס, Stone → סטון
      const magic = at === 'mid' && j === w.length - 2 && w[w.length - 1] === 'e' && !VOWEL.test(w[j]) && w.length > 3 && /^[aio]$/.test(g);
      out += magic ? (MAGIC[lang][g] ?? r.v(g, at)) : r.v(g, at);
      i = j;
      continue;
    }
    const hit = r.cons.find(([lat]) => w.startsWith(lat, i));
    if (!hit) { i++; continue; }
    // "ce" / "ci" / "cy": only the c is a consonant (the vowel is read next)
    if (/^c[eiy]$/.test(hit[0])) { out += hit[1]; i += 1; continue; }
    // a word-final h after a vowel is not written ("Sarah" → שרה)
    if (hit[0] === 'h' && i === w.length - 1 && i > 0 && VOWEL.test(w[i - 1])) { i++; continue; }
    // "ts" is one sound at the start ("Tsonga"), two inside a word ("Roberts")
    if (hit[0] === 'ts' && i > 0) { out += r.cons.find(c => c[0] === 't')![1] + r.cons.find(c => c[0] === 's')![1]; i += 2; continue; }
    out += hit[1];
    i += hit[0].length;
  }
  // fix283: "w" + a vowel o / u wrote three vavs ("Bowling" → בווולינג): two at most
  if (lang === 'he') out = out.replace(/ו{3,}/g, 'וו');
  if (r.finals && out) {
    const last = out[out.length - 1];
    if (r.finals[last]) out = out.slice(0, -1) + r.finals[last];
  }
  return out;
}

/** a whole name in the local script by the rules (no PRESS lookup); null when nothing of it can be written */
export function translit(name: string, lang: NameLang): string | null {
  const raw = String(name || '').replace(/\b(al|el)-/gi, '$1 ').trim();
  if (!raw) return null;
  const words = WORDS[lang];
  // tokens: words, initials ("E."), numbers, acronyms; hyphens kept
  const toks = raw.split(/\s+/).filter(Boolean);
  const keyed = toks.map(t => nameKey(t));
  const keep = keyed.filter(k => k && !DROP.has(k));
  const useToks = keep.length ? toks.filter((_, i) => keyed[i] && !DROP.has(keyed[i])) : toks.filter((_, i) => KEEP_IF_ALONE.has(keyed[i]));
  if (!useToks.length) return null;
  const parts: string[] = [];
  let changed = false;
  for (let i = 0; i < useToks.length; i++) {
    const t = useToks[i];
    // two-word city / phrase in WORDS ("las vegas")
    const two = i + 1 < useToks.length ? nameKey(`${t} ${useToks[i + 1]}`) : '';
    if (two && words.has(two)) { parts.push(words.get(two)!); i++; changed = true; continue; }
    if (/^\d+$/.test(t)) { parts.push(t); continue; }
    if (/^\p{Lu}{2,5}$/u.test(t) && !words.has(nameKey(t))) { parts.push(t); continue; } // an acronym stays
    // fix283: initials stay Latin ("E." , "D.J."): a Hebrew final letter (ן.) or a lost dot read wrong ("N. Touliatos" → "ן.")
    if (/^(\p{L}\.)+$/u.test(t)) { parts.push(t.toUpperCase()); continue; }
    const pieces = t.split('-').map(p => {
      const k = nameKey(p);
      if (!k) return '';
      if (words.has(k)) return words.get(k)!;
      const country = COUNTRIES[lang].get(k);
      if (country) return country;
      return translitWord(k.replace(/[^a-z]/g, ''), lang);
    });
    const out = pieces.filter(Boolean).join('-');
    if (out) { parts.push(out); changed = true; }
  }
  const s = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return changed && s ? (lang === 'ar' ? joinAl(s) : s) : null;
}
/** Arabic writes the article on the word: "ال هلال" → "الهلال" */
const joinAl = (s: string) => s.replace(/(^|\s)ال\s+/g, '$1ال');

/** league names other countries use too ("Premier League" in Ukraine, Egypt …): the press spelling only for its country */
const PRESS_COUNTRY: Record<string, string> = {
  'premier league': 'england', 'championship': 'england', 'league one': 'england', 'league two': 'england', 'fa cup': 'england', 'league cup': 'england',
  'efl cup': 'england', 'community shield': 'england', 'serie a': 'italy', 'serie b': 'italy', 'coppa italia': 'italy', 'bundesliga': 'germany',
  '2 bundesliga': 'germany', 'dfb pokal': 'germany', 'ligue 1': 'france', 'ligue 2': 'france', 'coupe de france': 'france', 'primera division': 'spain',
  'segunda division': 'spain', 'copa del rey': 'spain', 'la liga': 'spain', 'premiership': 'scotland', 'super lig': 'turkey', 'eredivisie': 'netherlands',
  'primeira liga': 'portugal', 'state cup': 'israel', 'liga leumit': 'israel', 'stars league': 'qatar', 'pro league': 'saudi arabia', 'super league': 'greece'
};

/** the press spelling of a whole name, a country, or null (`country`: the league's country, for the shared league names) */
export function pressName(name: string, lang: NameLang, kind?: string, country?: string | null): string | null {
  const bound = kind === 'league' ? PRESS_COUNTRY[nameKey(name)] : undefined;
  if (bound && nameKey(country || '').replace(/-/g, ' ') !== bound) return null;
  const k = nameKey(String(name || '').replace(/\b(al|el)-/gi, '$1 '));
  if (!k) return null;
  if (kind === 'country' || kind === 'city' || !kind) { const c = COUNTRIES[lang].get(k); if (c) return c; }
  // the name as written, then without its club-form tokens ("Al-Hilal Saudi FC" → "al hilal")
  const bare = k.split(' ').filter(x => !DROP.has(x)).join(' ');
  for (const v of [k, bare, bare.replace(/ (saudi|club|sfc|cairo|sc)$/, '')]) { const p = v && PRESS[lang].get(v); if (p) return p; }
  if (kind === 'city' && WORDS[lang].has(k)) return WORDS[lang].get(k)!;
  return null;
}

/** what the dictionary job writes when Wikidata has nothing: { name, source } or null (the name stays Latin) */
export function fallbackName(name: string, lang: NameLang, kind?: string, country?: string | null): { name: string; source: 'press' | 'translit' } | null {
  const p = pressName(name, lang, kind, country);
  if (p) return { name: p, source: 'press' };
  const t = translit(name, lang);
  return t ? { name: t, source: 'translit' } : null;
}

/* ---------- fix283: name order, the checks that block a spelling, what visitors may see ---------- */

/**
 * A person's name as people write it (first name first), before any spelling: the provider's own first / last fields
 * when it sends them; "Surname, First" → "First Surname"; API-Basketball writes every player surname first
 * ("Lillard Damian", "Jackson Jr. Jaren", "Harper D.") → the given name (the last word) goes first, as utils/personName.ts
 * bbCommonName does for the pages and slugs. Everything else is already first-last.
 */
export function personOrder(latin: string, opts: { sport?: string; kind?: string; first?: string | null; last?: string | null } = {}): string {
  const n = String(latin || '').trim().replace(/\s+/g, ' ');
  if (opts.kind && opts.kind !== 'player') return n;
  const f = String(opts.first || '').trim(), l = String(opts.last || '').trim();
  if (f && l && !/^\p{L}\.?$/u.test(f)) return `${f} ${l}`;
  const comma = /^([^,]+),\s*(.+)$/.exec(n);
  if (comma) return `${comma[2]} ${comma[1]}`;
  if (opts.sport === 'basketball') {
    const w = n.split(' ');
    if (w.length < 2 || /^(\p{Lu}\.)+$/u.test(w[0])) return n;
    return [w[w.length - 1], ...w.slice(0, -1)].join(' ');
  }
  return n;
}

/**
 * Words of the language that are places or plain words: a person's name never contains them, and a team / league name
 * only when its Latin name means that place ("Jordan Washington" → "ירדן וושינגטון": ירדן is the country / river, the
 * person is "ג'ורדן"). Value = the Latin words that may produce it. Countries are added from COUNTRIES below.
 */
const DICT_EXTRA: Record<NameLang, Record<string, string[]>> = {
  he: {
    'ירדן': ['jordan'], 'אביב': ['aviv'], 'שבע': ['sheva'], 'תל': ['tel'], 'גן': ['gan'], 'ים': [], 'הר': [], 'עיר': ['city'], 'בית': ['beit', 'bet'], 'שער': [],
    'דרך': [], 'חוף': ['coast'], 'מלך': ['king'], 'שלום': ['shalom'], 'כרמל': ['carmel'], 'גליל': ['galil'], 'נגב': ['negev'], 'לבן': ['white'], 'אדום': ['red', 'crvena'], 'עמאן': ['oman', 'amman'],
    'ירוק': ['green'], 'שחור': ['black'], 'זהב': ['gold', 'golden'], 'כסף': ['silver'], 'שמש': ['sun', 'shemesh'], 'ערב': ['arab', 'arabia'], 'אור': ['or', 'light'],
    'יום': [], 'לילה': ['night'], 'לב': ['heart'], 'אש': ['fire'], 'מים': ['water'], 'אבן': ['stone', 'even'], 'ברק': ['barak', 'lightning'], 'נמר': ['tiger'], 'אריה': ['lion', 'arie', 'aryeh']
  },
  ar: {
    'الأردن': ['jordan'], 'مصر': ['egypt', 'misr'], 'الملك': ['king'], 'البحر': ['sea'], 'المدينة': ['city', 'madina'], 'الذهب': ['gold', 'golden'], 'الشمس': ['sun'],
    'عمان': ['oman', 'amman'], 'تونس': ['tunisia', 'tunis'], 'الجزائر': ['algeria', 'algiers'], 'الأبيض': ['white'], 'الأحمر': ['red', 'crvena'], 'الأخضر': ['green'], 'الأسود': ['black', 'lions'], 'النور': ['nour', 'noor'], 'الجبل': ['mountain'], 'النهر': ['river']
  }
};
let dictCache: Record<NameLang, Map<string, Set<string>>> | null = null;
function dict(lang: NameLang): Map<string, Set<string>> {
  if (!dictCache) {
    dictCache = { he: new Map(), ar: new Map() };
    for (const l of NAME_LANGS) {
      const m = dictCache[l];
      for (const [lat, loc] of COUNTRIES[l]) if (!loc.includes(' ')) { const set = m.get(loc) || new Set(); for (const w of lat.split(' ')) set.add(w); m.set(loc, set); }
      for (const [loc, lats] of Object.entries(DICT_EXTRA[l])) { const set = m.get(loc) || new Set(); for (const w of lats) set.add(w); m.set(loc, set); }
    }
  }
  return dictCache[lang];
}

export type NameFlag = 'dictionary' | 'final-inside' | 'triple' | 'initials-lost' | 'latin-left' | 'other-script' | 'empty';
export const FLAG_TEXT: Record<NameFlag, string> = {
  dictionary: 'a dictionary / place word that is not this name',
  'final-inside': 'a final letter (ך ם ן ף ץ) inside a word',
  triple: 'the same letter three times in a row',
  'initials-lost': 'an initial of the Latin name is missing',
  'latin-left': 'Latin letters left inside the name',
  'other-script': 'letters of another alphabet (Cyrillic, Greek, Arabic in Hebrew, Hebrew in Arabic …)',
  empty: 'no letters of the language'
};
const INITIAL_RX = /(?<=^|[\s.])\p{L}\.(?=\s|\p{L}\.|$)/gu;
const LATIN_INITIAL_RX = /(?<=^|[\s.])[A-Z]\.(?=\s|\p{L}\.|$)/gu;
const initialsOf = (s: string, rx = INITIAL_RX) => [...String(s || '').matchAll(rx)].length;

/**
 * fix283: what is wrong with a spelling (empty = fine). A flagged spelling is never shown to visitors (back to the Latin
 * name) and is listed for review in Admin → Data & feeds → "Names in Hebrew / Arabic"; an admin's own spelling or
 * "approve" overrides it.
 */
export function spellingFlags(latin: string, local: string, lang: NameLang, kind?: string): NameFlag[] {
  const out: NameFlag[] = [];
  const s = String(local || '').trim();
  if (!LOCAL_SCRIPT.test(s)) return /\p{L}/u.test(s) ? [] : ['empty']; // an acronym as it is ("NBA", "MLS")
  const latWords = new Set(nameKey(latin).split(' '));
  const words = s.split(/[\s\-–־]+/).map(w => w.replace(/^["'׳״(]+|["'׳״).,]+$/g, '')).filter(Boolean);
  const d = dict(lang);
  // a person: no word of the name may be one; a team / league / place: the whole name may not be one it does not mean
  // ("Coppa Italia" → "גביע איטליה" is right)
  if (kind === 'player') { if (words.some(w => d.has(w))) out.push('dictionary'); }
  else { const means = d.get(words.join(' ')); if (means && ![...means].some(m => latWords.has(m))) out.push('dictionary'); }
  if (lang === 'he' && /[ךםןףץ](?=[א-ת])/.test(s)) out.push('final-inside');
  if (/(\p{L})\1\1/u.test(s)) out.push('triple');
  // initials stay the Latin capitals ("N. טוליאטוס"): "ן." / "ג' ריד" lost them
  if (initialsOf(latin) > initialsOf(s, LATIN_INITIAL_RX)) out.push('initials-lost');
  // Latin letters next to local ones: only Latin initials ("N.") and an acronym the Latin name has ("NBA") may stay
  const rest = s.replace(LATIN_INITIAL_RX, '').split(/\s+/).filter(w => !(/^[A-Z0-9]{2,6}$/.test(w) && String(latin).split(/\s+/).includes(w))).join(' ');
  if (/[A-Za-z]/.test(rest)) out.push('latin-left');
  // fix286: "Brayden" came back "ברייдן" — a letter of any other alphabet (Latin is the check above)
  if (otherScript(s, lang)) out.push('other-script');
  return out;
}
const OWN_SCRIPT: Record<NameLang, RegExp> = { he: /\p{Script=Hebrew}|\p{Script=Latin}/u, ar: /\p{Script=Arabic}|\p{Script=Latin}/u };
/** fix286: a letter that is neither the language's own nor Latin (Cyrillic, Greek, Arabic in Hebrew, Hebrew in Arabic …) */
export function otherScript(s: string, lang: NameLang): boolean {
  for (const ch of String(s || '')) if (/\p{L}/u.test(ch) && !OWN_SCRIPT[lang].test(ch)) return true;
  return false;
}

/** the sources, most trusted first ('translit' = letter rules; 'latin' = nothing shown, the provider's name stays) */
export const NAME_SOURCES = ['admin', 'press', 'wikidata', 'ai', 'translit'] as const;
/** the AI's confidence a spelling needs before visitors see it (NAMES_AI_MIN_CONF, 0–1) */
export const aiMinConf = () => { const v = Number(process.env.NAMES_AI_MIN_CONF); return v > 0 && v <= 1 ? v : 0.8; };
/**
 * fix283: may visitors see this row? Admin spellings and approved rows always; press / Wikidata / AI (confident) when no
 * check flagged them; letter rules never (they are the review list's starting point only).
 */
export function visibleName(r: { source: string; conf?: number | null; flags?: string | null; approved?: number | null }): boolean {
  if (r.source === 'admin' || r.approved) return true;
  if (r.flags) return false;
  if (r.source === 'press' || r.source === 'wikidata') return true;
  if (r.source === 'ai') return (r.conf ?? 0) >= aiMinConf();
  return false;
}

/* ---------- the AI's batch (services/namesAi.ts sends it) ---------- */
export type AiItem = { sport: string; kind: string; name: string; country?: string | null; team?: string | null };
export const AI_SYSTEM = `You write sports names in Hebrew and Arabic the way the sports press writes them (Hebrew: ONE, Sport5, Walla Sport; Arabic: Kooora, beIN Sports).
Rules:
- Persons: first name, then last name, as given. Keep an initial as the Latin capital with a dot ("N. Touliatos" → "N. טוליאטוס"; "D.J. Reed" → "D.J. ריד").
- Spell the sound of the name in its own language (Spanish, Serbian, Greek, Turkish …), not the English letters. Never translate a name into a word ("Jordan" the person is "ג'ורדן", never "ירדן").
- Teams and leagues: the established press name (city names as the press writes them; club-form letters like FC dropped).
- Hebrew: final letters (ך ם ן ף ץ) only at the end of a word; use ג' צ' ז' ת' for j / ch / zh / th sounds.
- confidence: 0.0–1.0, how sure you are this is the spelling the press uses (≥ 0.9 only when you have seen it written that way).
Answer with one line per input line and nothing else (no JSON, no notes): index|hebrew|confidence|arabic|confidence
e.g. 0|ברנדון נייט|0.9|براندون نايت|0.85 — leave a spelling empty when you do not know it (0|||براندون نايت|0.6).`;
/** fix286: asked again once when a spelling had letters of another alphabet */
export const AI_RETRY_NOTE = 'Your last answer for these names had letters of another alphabet (Cyrillic, Greek …) inside a name. Hebrew spellings use Hebrew letters only, Arabic spellings Arabic letters only (Latin initials / acronyms as given may stay).';
export function aiPrompt(items: AiItem[]): string {
  return items.map((it, i) => `${i}\t${it.sport || '-'}\t${it.kind}\t${it.name}${it.country ? `\tcountry: ${it.country}` : ''}${it.team ? `\tteam: ${it.team}` : ''}`).join('\n');
}
/** fix286: the AI's compact answer ("i|he|conf|ar|conf" per line) → per index { he, ar } (anything malformed is left out) */
export function parseAi(text: string, n: number): Map<number, Partial<Record<NameLang, { name: string; conf: number }>>> {
  const out = new Map<number, Partial<Record<NameLang, { name: string; conf: number }>>>();
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.replace(/^[\s`*-]+|[\s`]+$/g, '').split('|').map(x => x.trim());
    if (f.length < 3 || !/^\d+$/.test(f[0])) continue;
    const i = Number(f[0]);
    if (i >= n || out.has(i)) continue;
    const e: Partial<Record<NameLang, { name: string; conf: number }>> = {};
    NAME_LANGS.forEach((lang, k) => {
      const name = String(f[1 + 2 * k] ?? '').slice(0, 80), conf = Math.max(0, Math.min(1, Number(f[2 + 2 * k]) || 0));
      if (name && LOCAL_SCRIPT.test(name)) e[lang] = { name, conf };
    });
    out.set(i, e);
  }
  return out;
}

/* ---------- fix286: whose names the AI is asked for ---------- */
/** a player viewed this many days back is asked (a view queues the name for the next run) */
export const AI_VIEW_DAYS = 60;
/**
 * API-Football league ids of the top 2 divisions of the 10 biggest football countries: England, Spain, Germany, Italy,
 * France, Portugal, Netherlands, Brazil, Argentina, Turkey
 */
export const AI_TOP_FOOTBALL = [39, 40, 140, 141, 78, 79, 135, 136, 61, 62, 94, 95, 88, 89, 71, 72, 128, 129, 203, 204];
/** basketball leagues whose every player is asked */
export const AI_TOP_BASKETBALL = ['NBA', 'EL'];
/** tennis: every player ranked this high or better (ATP / WTA) */
export const AI_TENNIS_RANK = 200;
/** players per league and stat that make its leaders / top-scorer list */
export const AI_LEADERS = 20;
/**
 * fix286: is the AI asked for this name? Every team / league / country / city; a player only when the collector picked
 * them (name_items.ai_pick: top divisions, NBA / EuroLeague, NFL, tennis top 200, a leaders list) or they were viewed in
 * the last AI_VIEW_DAYS days. Everyone else stays Latin until viewed.
 */
export function aiWanted(r: { kind: string; ai_pick?: string | null; viewed_at?: string | null }, now = Date.now()): boolean {
  if (r.kind !== 'player') return true;
  if (r.ai_pick) return true;
  return !!r.viewed_at && Date.parse(r.viewed_at) >= now - AI_VIEW_DAYS * 86400000;
}

/**
 * Tennis crawler pages (fix193c), built like basketball's: the page's own language for titles, descriptions and
 * headings (the written preview is English only, like the other sports), never the pick or a percentage, never market
 * prices. Until TENNIS_PUBLIC=1 every tennis URL is a "coming soon" page with noindex and nothing is in the sitemaps.
 * Pages: home / matches, today, rankings, match (with its own preview text), player, tournament, weekly tournament hub.
 */
import { db } from '../db';
import { slModel } from '../utils/modelNames';
import { moreSentence } from './morePredictions';
import { tennisPublic, tennisMatchesBetween, tennisMatch, tennisPlayer, tennisTournament, tennisRankings, tennisWriteup, tierLabel, levelRank, type TMatch } from './tennisSite';
import type { Lang } from './seoText';

const BRAND = 'SportLikely';
const SITE = 'https://sportlikely.com';
const LOC: Record<Lang, string> = { en: 'en-GB', es: 'es-ES', pt: 'pt-PT', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', tr: 'tr-TR', id: 'id-ID', hi: 'hi-IN', pl: 'pl-PL', el: 'el-GR', ru: 'ru-RU' };
const link = (lang: Lang, p: string) => (lang === 'en' ? p : `/${lang}${p === '/' ? '' : p}`);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fill = (s: string, ...a: (string | number)[]) => s.replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)] ?? ''));
const day = (iso: string, l: Lang) => new Date(iso).toLocaleDateString(LOC[l], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const when = (iso: string, l: Lang) => new Date(iso).toLocaleString(LOC[l], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

interface Words {
  soonTitle: string; soonDesc: string
  homeTitle: string; homeDesc: string; homeH1: string; homeIntro: string
  todayTitle: string; todayDesc: string; todayH1: string
  rankTitle: string; rankDesc: string; rankH1: string
  matchTitle: string; matchDesc: string; matchH1: string
  playerTitle: string; playerDesc: string
  tourTitle: string; tourDesc: string
  next: string; results: string; meetings: string; form: string; champions: string; draw: string; preview: string; noMatches: string; rank: string; points: string; tournaments: string; firstMeeting: string
}
/** {0}… = facts filled in; every description stays a full sentence */
const W: Record<Lang, Words> = {
  en: {
    soonTitle: 'Tennis predictions · coming soon', soonDesc: 'Tennis predictions for every ATP, WTA and Challenger match are coming soon to SportLikely.',
    homeTitle: 'Tennis predictions: ATP, WTA and Challenger', homeDesc: 'Tennis predictions for every ATP, WTA and Challenger match: each player’s chance, the likely set score and total games, saved before the first serve.',
    homeH1: 'Tennis predictions', homeIntro: 'Who wins every ATP, WTA and Challenger match, with the chance of each player, the likely set score and the reasons behind each pick. Every prediction is saved before the first serve and checked in public.',
    todayTitle: 'Tennis predictions today', todayDesc: 'Today’s ATP, WTA and Challenger matches by tournament, with the players’ ranks, recent form and last meeting. Updated every day.', todayH1: 'Tennis predictions today',
    rankTitle: 'ATP and WTA rankings', rankDesc: 'The ATP and WTA singles rankings: the top players with their points and how far they moved since the last update, with links to every player.', rankH1: 'ATP and WTA rankings',
    matchTitle: '{0} vs {1} prediction · {2}', matchDesc: '{0} vs {1}, {2}, {3}: ranks, recent form, serve and return numbers and head-to-head. Free preview and our pick.', matchH1: '{0} vs {1} prediction',
    playerTitle: '{0}: ranking, results and next match', playerDesc: '{0}{1}: recent results, form, serve and return numbers, titles and the next match, with our prediction for it.',
    tourTitle: '{0} {1}: draw, results and predictions', tourDesc: '{0} {1}: the draw, results, past champions and our prediction for every match of the tournament.',
    next: 'Next matches', results: 'Results', meetings: 'Last meetings', form: 'Recent form', champions: 'Past champions', draw: 'Draw', preview: 'Match preview', noMatches: 'No matches scheduled.', rank: 'Rank', points: 'Points', tournaments: 'Tournaments', firstMeeting: 'First meeting in our data.'
  },
  es: {
    soonTitle: 'Pronósticos de tenis · muy pronto', soonDesc: 'Los pronósticos de tenis para cada partido ATP, WTA y Challenger llegan muy pronto a SportLikely.',
    homeTitle: 'Pronósticos de tenis: ATP, WTA y Challenger', homeDesc: 'Pronósticos de tenis para cada partido ATP, WTA y Challenger: la probabilidad de cada jugador, el marcador de sets y los juegos totales.',
    homeH1: 'Pronósticos de tenis', homeIntro: 'Quién gana cada partido ATP, WTA y Challenger, con la probabilidad de cada jugador, el marcador de sets más probable y los motivos de cada pronóstico. Cada pronóstico se guarda antes del primer saque y se comprueba en público.',
    todayTitle: 'Pronósticos de tenis para hoy', todayDesc: 'Los partidos ATP, WTA y Challenger de hoy por torneo, con el ranking de los jugadores, su forma reciente y el último duelo. Cada día.', todayH1: 'Pronósticos de tenis para hoy',
    rankTitle: 'Ranking ATP y WTA', rankDesc: 'Los rankings individuales ATP y WTA: los mejores jugadores con sus puntos y cuánto han subido o bajado desde la última actualización.', rankH1: 'Ranking ATP y WTA',
    matchTitle: 'Pronóstico {0} vs {1} · {2}', matchDesc: '{0} vs {1}, {2}, {3}: ranking, forma reciente, saque y resto, y cara a cara. Previa gratis y nuestro pronóstico.', matchH1: 'Pronóstico {0} vs {1}',
    playerTitle: '{0}: ranking, resultados y próximo partido', playerDesc: '{0}{1}: resultados recientes, forma, saque y resto, títulos y el próximo partido, con nuestro pronóstico.',
    tourTitle: '{0} {1}: cuadro, resultados y pronósticos', tourDesc: '{0} {1}: el cuadro, los resultados, los campeones anteriores y nuestro pronóstico para cada partido del torneo.',
    next: 'Próximos partidos', results: 'Resultados', meetings: 'Últimos duelos', form: 'Forma reciente', champions: 'Campeones anteriores', draw: 'Cuadro', preview: 'Previa', noMatches: 'No hay partidos programados.', rank: 'Ranking', points: 'Puntos', tournaments: 'Torneos', firstMeeting: 'Primer duelo en nuestros datos.'
  },
  pt: {
    soonTitle: 'Palpites de ténis · em breve', soonDesc: 'Os palpites de ténis para cada jogo ATP, WTA e Challenger chegam em breve ao SportLikely.',
    homeTitle: 'Palpites de ténis: ATP, WTA e Challenger', homeDesc: 'Palpites de ténis para cada jogo ATP, WTA e Challenger: a chance de cada jogador, o resultado em sets e o total de games.',
    homeH1: 'Palpites de ténis', homeIntro: 'Quem vence cada jogo ATP, WTA e Challenger, com a chance de cada jogador, o resultado em sets mais provável e os motivos de cada palpite. Cada palpite é guardado antes do primeiro saque e verificado em público.',
    todayTitle: 'Palpites de ténis para hoje', todayDesc: 'Os jogos ATP, WTA e Challenger de hoje por torneio, com o ranking dos jogadores, a forma recente e o último confronto. Todos os dias.', todayH1: 'Palpites de ténis para hoje',
    rankTitle: 'Ranking ATP e WTA', rankDesc: 'Os rankings de simples ATP e WTA: os melhores jogadores com os pontos e quanto subiram ou desceram desde a última atualização.', rankH1: 'Ranking ATP e WTA',
    matchTitle: 'Palpite {0} vs {1} · {2}', matchDesc: '{0} vs {1}, {2}, {3}: ranking, forma recente, saque e devolução, e confronto direto. Antevisão grátis e o nosso palpite.', matchH1: 'Palpite {0} vs {1}',
    playerTitle: '{0}: ranking, resultados e próximo jogo', playerDesc: '{0}{1}: resultados recentes, forma, saque e devolução, títulos e o próximo jogo, com o nosso palpite.',
    tourTitle: '{0} {1}: quadro, resultados e palpites', tourDesc: '{0} {1}: o quadro, os resultados, os campeões anteriores e o nosso palpite para cada jogo do torneio.',
    next: 'Próximos jogos', results: 'Resultados', meetings: 'Últimos confrontos', form: 'Forma recente', champions: 'Campeões anteriores', draw: 'Quadro', preview: 'Antevisão', noMatches: 'Sem jogos marcados.', rank: 'Ranking', points: 'Pontos', tournaments: 'Torneios', firstMeeting: 'Primeiro confronto nos nossos dados.'
  },
  de: {
    soonTitle: 'Tennis-Prognosen · bald verfügbar', soonDesc: 'Tennis-Prognosen für jedes ATP-, WTA- und Challenger-Match kommen bald zu SportLikely.',
    homeTitle: 'Tennis-Prognosen: ATP, WTA und Challenger', homeDesc: 'Tennis-Prognosen für jedes ATP-, WTA- und Challenger-Match: die Chance jedes Spielers, das wahrscheinliche Satzergebnis und die Spiele insgesamt.',
    homeH1: 'Tennis-Prognosen', homeIntro: 'Wer jedes ATP-, WTA- und Challenger-Match gewinnt, mit der Chance jedes Spielers, dem wahrscheinlichsten Satzergebnis und den Gründen für jeden Tipp. Jede Prognose wird vor dem ersten Aufschlag gespeichert und öffentlich geprüft.',
    todayTitle: 'Tennis-Prognosen für heute', todayDesc: 'Die heutigen ATP-, WTA- und Challenger-Matches nach Turnier, mit Weltranglistenplatz, aktueller Form und letztem Duell. Jeden Tag neu.', todayH1: 'Tennis-Prognosen für heute',
    rankTitle: 'ATP- und WTA-Weltrangliste', rankDesc: 'Die ATP- und WTA-Einzelweltranglisten: die besten Spieler mit ihren Punkten und wie weit sie seit der letzten Aktualisierung gestiegen oder gefallen sind.', rankH1: 'ATP- und WTA-Weltrangliste',
    matchTitle: '{0} gegen {1} Prognose · {2}', matchDesc: '{0} gegen {1}, {2}, {3}: Ranglistenplätze, Form, Aufschlag und Return sowie direkter Vergleich. Kostenlose Vorschau und unser Tipp.', matchH1: '{0} gegen {1} Prognose',
    playerTitle: '{0}: Ranglistenplatz, Ergebnisse und nächstes Match', playerDesc: '{0}{1}: letzte Ergebnisse, Form, Aufschlag und Return, Titel und das nächste Match mit unserer Prognose.',
    tourTitle: '{0} {1}: Tableau, Ergebnisse und Prognosen', tourDesc: '{0} {1}: das Tableau, die Ergebnisse, frühere Sieger und unsere Prognose für jedes Match des Turniers.',
    next: 'Nächste Matches', results: 'Ergebnisse', meetings: 'Letzte Duelle', form: 'Aktuelle Form', champions: 'Frühere Sieger', draw: 'Tableau', preview: 'Vorschau', noMatches: 'Keine Matches angesetzt.', rank: 'Platz', points: 'Punkte', tournaments: 'Turniere', firstMeeting: 'Erstes Duell in unseren Daten.'
  },
  fr: {
    soonTitle: 'Pronostics tennis · bientôt', soonDesc: 'Les pronostics tennis pour chaque match ATP, WTA et Challenger arrivent bientôt sur SportLikely.',
    homeTitle: 'Pronostics tennis : ATP, WTA et Challenger', homeDesc: 'Pronostics tennis pour chaque match ATP, WTA et Challenger : la chance de chaque joueur, le score en sets probable et le total de jeux.',
    homeH1: 'Pronostics tennis', homeIntro: 'Qui gagne chaque match ATP, WTA et Challenger, avec la chance de chaque joueur, le score en sets le plus probable et les raisons de chaque pronostic. Chaque pronostic est enregistré avant le premier service et vérifié en public.',
    todayTitle: 'Pronostics tennis du jour', todayDesc: 'Les matchs ATP, WTA et Challenger du jour par tournoi, avec le classement des joueurs, leur forme récente et la dernière confrontation.', todayH1: 'Pronostics tennis du jour',
    rankTitle: 'Classements ATP et WTA', rankDesc: 'Les classements simple ATP et WTA : les meilleurs joueurs avec leurs points et leur évolution depuis la dernière mise à jour, avec un lien vers chaque joueur.', rankH1: 'Classements ATP et WTA',
    matchTitle: 'Pronostic {0} - {1} · {2}', matchDesc: '{0} - {1}, {2}, {3} : classements, forme récente, service et retour, face-à-face. Avant-match gratuit et notre pronostic.', matchH1: 'Pronostic {0} - {1}',
    playerTitle: '{0} : classement, résultats et prochain match', playerDesc: '{0}{1} : résultats récents, forme, service et retour, titres et le prochain match, avec notre pronostic.',
    tourTitle: '{0} {1} : tableau, résultats et pronostics', tourDesc: '{0} {1} : le tableau, les résultats, les anciens vainqueurs et notre pronostic pour chaque match du tournoi.',
    next: 'Prochains matchs', results: 'Résultats', meetings: 'Dernières confrontations', form: 'Forme récente', champions: 'Anciens vainqueurs', draw: 'Tableau', preview: 'Avant-match', noMatches: 'Aucun match prévu.', rank: 'Rang', points: 'Points', tournaments: 'Tournois', firstMeeting: 'Première confrontation dans nos données.'
  },
  it: {
    soonTitle: 'Pronostici tennis · in arrivo', soonDesc: 'I pronostici tennis per ogni partita ATP, WTA e Challenger arrivano presto su SportLikely.',
    homeTitle: 'Pronostici tennis: ATP, WTA e Challenger', homeDesc: 'Pronostici tennis per ogni partita ATP, WTA e Challenger: la probabilità di ogni giocatore, il punteggio in set probabile e i game totali.',
    homeH1: 'Pronostici tennis', homeIntro: 'Chi vince ogni partita ATP, WTA e Challenger, con la probabilità di ogni giocatore, il punteggio in set più probabile e i motivi di ogni pronostico. Ogni pronostico è salvato prima del primo servizio e verificato in pubblico.',
    todayTitle: 'Pronostici tennis di oggi', todayDesc: 'Le partite ATP, WTA e Challenger di oggi per torneo, con la classifica dei giocatori, la forma recente e l’ultimo precedente. Ogni giorno.', todayH1: 'Pronostici tennis di oggi',
    rankTitle: 'Classifiche ATP e WTA', rankDesc: 'Le classifiche singolare ATP e WTA: i migliori giocatori con i loro punti e quanto sono saliti o scesi dall’ultimo aggiornamento.', rankH1: 'Classifiche ATP e WTA',
    matchTitle: 'Pronostico {0} - {1} · {2}', matchDesc: '{0} - {1}, {2}, {3}: classifica, forma recente, servizio e risposta, precedenti. Anteprima gratuita e il nostro pronostico.', matchH1: 'Pronostico {0} - {1}',
    playerTitle: '{0}: classifica, risultati e prossima partita', playerDesc: '{0}{1}: risultati recenti, forma, servizio e risposta, titoli e la prossima partita, con il nostro pronostico.',
    tourTitle: '{0} {1}: tabellone, risultati e pronostici', tourDesc: '{0} {1}: il tabellone, i risultati, l’albo d’oro e il nostro pronostico per ogni partita del torneo.',
    next: 'Prossime partite', results: 'Risultati', meetings: 'Ultimi precedenti', form: 'Forma recente', champions: 'Albo d’oro', draw: 'Tabellone', preview: 'Anteprima', noMatches: 'Nessuna partita in programma.', rank: 'Posizione', points: 'Punti', tournaments: 'Tornei', firstMeeting: 'Primo precedente nei nostri dati.'
  },
  tr: {
    soonTitle: 'Tenis tahminleri · yakında', soonDesc: 'Her ATP, WTA ve Challenger maçı için tenis tahminleri yakında SportLikely’de.',
    homeTitle: 'Tenis tahminleri: ATP, WTA ve Challenger', homeDesc: 'Her ATP, WTA ve Challenger maçı için tenis tahminleri: her oyuncunun şansı, olası set skoru ve toplam oyun sayısı.',
    homeH1: 'Tenis tahminleri', homeIntro: 'Her ATP, WTA ve Challenger maçını kimin kazanacağı, her oyuncunun şansı, en olası set skoru ve her tahminin nedenleriyle. Her tahmin ilk servisten önce kaydedilir ve herkese açık olarak kontrol edilir.',
    todayTitle: 'Bugünün tenis tahminleri', todayDesc: 'Bugünün ATP, WTA ve Challenger maçları turnuvaya göre, oyuncuların sıralaması, son formu ve son karşılaşmasıyla. Her gün güncellenir.', todayH1: 'Bugünün tenis tahminleri',
    rankTitle: 'ATP ve WTA sıralamaları', rankDesc: 'ATP ve WTA tekler sıralamaları: en iyi oyuncular, puanları ve son güncellemeden bu yana ne kadar yükselip düştükleri.', rankH1: 'ATP ve WTA sıralamaları',
    matchTitle: '{0} - {1} tahmini · {2}', matchDesc: '{0} - {1}, {2}, {3}: sıralama, son form, servis ve karşılama, karşılaşma geçmişi. Ücretsiz önizleme ve tahminimiz.', matchH1: '{0} - {1} tahmini',
    playerTitle: '{0}: sıralama, sonuçlar ve sonraki maç', playerDesc: '{0}{1}: son sonuçlar, form, servis ve karşılama, şampiyonluklar ve sonraki maç, tahminimizle birlikte.',
    tourTitle: '{0} {1}: kura, sonuçlar ve tahminler', tourDesc: '{0} {1}: kura, sonuçlar, önceki şampiyonlar ve turnuvadaki her maç için tahminimiz.',
    next: 'Sonraki maçlar', results: 'Sonuçlar', meetings: 'Son karşılaşmalar', form: 'Son form', champions: 'Önceki şampiyonlar', draw: 'Kura', preview: 'Maç önizlemesi', noMatches: 'Planlanmış maç yok.', rank: 'Sıra', points: 'Puan', tournaments: 'Turnuvalar', firstMeeting: 'Verilerimizde ilk karşılaşma.'
  },
  id: {
    soonTitle: 'Prediksi tenis · segera hadir', soonDesc: 'Prediksi tenis untuk setiap pertandingan ATP, WTA dan Challenger segera hadir di SportLikely.',
    homeTitle: 'Prediksi tenis: ATP, WTA dan Challenger', homeDesc: 'Prediksi tenis untuk setiap pertandingan ATP, WTA dan Challenger: peluang tiap pemain, skor set yang paling mungkin dan total game, disimpan sebelum servis pertama.',
    homeH1: 'Prediksi tenis', homeIntro: 'Siapa yang menang di setiap pertandingan ATP, WTA dan Challenger, dengan peluang tiap pemain, skor set yang paling mungkin dan alasan di balik setiap pilihan. Setiap prediksi disimpan sebelum servis pertama dan diperiksa secara terbuka.',
    todayTitle: 'Prediksi tenis hari ini', todayDesc: 'Pertandingan ATP, WTA dan Challenger hari ini per turnamen, dengan peringkat pemain, performa terakhir dan pertemuan terakhir. Diperbarui setiap hari.', todayH1: 'Prediksi tenis hari ini',
    rankTitle: 'Peringkat ATP dan WTA', rankDesc: 'Peringkat tunggal ATP dan WTA: pemain teratas dengan poin mereka dan seberapa jauh mereka bergerak sejak pembaruan terakhir, dengan tautan ke setiap pemain.', rankH1: 'Peringkat ATP dan WTA',
    matchTitle: 'Prediksi {0} vs {1} · {2}', matchDesc: '{0} vs {1}, {2}, {3}: peringkat, performa terakhir, angka servis dan return serta head-to-head. Pratinjau gratis dan pilihan kami.', matchH1: 'Prediksi {0} vs {1}',
    playerTitle: '{0}: peringkat, hasil dan pertandingan berikutnya', playerDesc: '{0}{1}: hasil terakhir, performa, angka servis dan return, gelar dan pertandingan berikutnya, dengan prediksi kami.',
    tourTitle: '{0} {1}: undian, hasil dan prediksi', tourDesc: '{0} {1}: undian, hasil, juara sebelumnya dan prediksi kami untuk setiap pertandingan di turnamen ini.',
    next: 'Pertandingan berikutnya', results: 'Hasil', meetings: 'Pertemuan terakhir', form: 'Performa terakhir', champions: 'Juara sebelumnya', draw: 'Undian', preview: 'Pratinjau pertandingan', noMatches: 'Tidak ada pertandingan terjadwal.', rank: 'Peringkat', points: 'Poin', tournaments: 'Turnamen', firstMeeting: 'Pertemuan pertama dalam data kami.'
  },
  hi: {
    soonTitle: 'टेनिस भविष्यवाणियाँ · जल्द आ रही हैं', soonDesc: 'हर ATP, WTA और Challenger मैच की टेनिस भविष्यवाणियाँ जल्द ही SportLikely पर।',
    homeTitle: 'टेनिस भविष्यवाणियाँ: ATP, WTA और Challenger', homeDesc: 'हर ATP, WTA और Challenger मैच की टेनिस भविष्यवाणियाँ: हर खिलाड़ी का मौका, संभावित सेट स्कोर और कुल गेम, पहली सर्व से पहले सहेजे गए।',
    homeH1: 'टेनिस भविष्यवाणियाँ', homeIntro: 'हर ATP, WTA और Challenger मैच कौन जीतेगा, हर खिलाड़ी के मौके, संभावित सेट स्कोर और हर पिक के कारणों के साथ। हर भविष्यवाणी पहली सर्व से पहले सहेजी जाती है और सबके सामने जाँची जाती है।',
    todayTitle: 'आज की टेनिस भविष्यवाणियाँ', todayDesc: 'आज के ATP, WTA और Challenger मैच टूर्नामेंट के अनुसार, खिलाड़ियों की रैंक, हाल की फ़ॉर्म और पिछली भिड़ंत के साथ। हर दिन अपडेट।', todayH1: 'आज की टेनिस भविष्यवाणियाँ',
    rankTitle: 'ATP और WTA रैंकिंग', rankDesc: 'ATP और WTA सिंगल्स रैंकिंग: शीर्ष खिलाड़ी, उनके अंक और पिछले अपडेट के बाद वे कितना ऊपर-नीचे हुए, हर खिलाड़ी के लिंक के साथ।', rankH1: 'ATP और WTA रैंकिंग',
    matchTitle: '{0} बनाम {1} भविष्यवाणी · {2}', matchDesc: '{0} बनाम {1}, {2}, {3}: रैंक, हाल की फ़ॉर्म, सर्व और रिटर्न के आँकड़े और आमने-सामने। मुफ़्त प्रीव्यू और हमारा पिक।', matchH1: '{0} बनाम {1} भविष्यवाणी',
    playerTitle: '{0}: रैंकिंग, नतीजे और अगला मैच', playerDesc: '{0}{1}: हाल के नतीजे, फ़ॉर्म, सर्व और रिटर्न के आँकड़े, खिताब और अगला मैच, उसके लिए हमारी भविष्यवाणी के साथ।',
    tourTitle: '{0} {1}: ड्रॉ, नतीजे और भविष्यवाणियाँ', tourDesc: '{0} {1}: ड्रॉ, नतीजे, पिछले चैंपियन और टूर्नामेंट के हर मैच के लिए हमारी भविष्यवाणी।',
    next: 'अगले मैच', results: 'नतीजे', meetings: 'पिछली भिड़ंतें', form: 'हाल की फ़ॉर्म', champions: 'पिछले चैंपियन', draw: 'ड्रॉ', preview: 'मैच प्रीव्यू', noMatches: 'कोई मैच तय नहीं है।', rank: 'रैंक', points: 'अंक', tournaments: 'टूर्नामेंट', firstMeeting: 'हमारे डेटा में पहली भिड़ंत।'
  },
  pl: {
    soonTitle: 'Prognozy tenisowe · wkrótce', soonDesc: 'Prognozy tenisowe na każdy mecz ATP, WTA i Challenger już wkrótce w SportLikely.',
    homeTitle: 'Prognozy tenisowe: ATP, WTA i Challenger', homeDesc: 'Prognozy tenisowe na każdy mecz ATP, WTA i Challenger: szanse każdego zawodnika, najbardziej prawdopodobny wynik w setach i liczba gemów, zapisane przed pierwszym serwisem.',
    homeH1: 'Prognozy tenisowe', homeIntro: 'Kto wygra każdy mecz ATP, WTA i Challenger, z szansami każdego zawodnika, najbardziej prawdopodobnym wynikiem w setach i powodami każdego typu. Każda prognoza jest zapisywana przed pierwszym serwisem i sprawdzana publicznie.',
    todayTitle: 'Prognozy tenisowe na dziś', todayDesc: 'Dzisiejsze mecze ATP, WTA i Challenger według turniejów, z rankingiem zawodników, ostatnią formą i ostatnim spotkaniem. Aktualizowane codziennie.', todayH1: 'Prognozy tenisowe na dziś',
    rankTitle: 'Rankingi ATP i WTA', rankDesc: 'Rankingi singlowe ATP i WTA: najlepsi zawodnicy z punktami i zmianą od ostatniej aktualizacji, z linkami do każdego zawodnika.', rankH1: 'Rankingi ATP i WTA',
    matchTitle: '{0} – {1}: prognoza · {2}', matchDesc: '{0} – {1}, {2}, {3}: ranking, ostatnia forma, liczby serwisu i returnu oraz bezpośrednie mecze. Darmowa zapowiedź i nasz typ.', matchH1: '{0} – {1}: prognoza',
    playerTitle: '{0}: ranking, wyniki i następny mecz', playerDesc: '{0}{1}: ostatnie wyniki, forma, liczby serwisu i returnu, tytuły i następny mecz, z naszą prognozą.',
    tourTitle: '{0} {1}: drabinka, wyniki i prognozy', tourDesc: '{0} {1}: drabinka, wyniki, dawni mistrzowie i nasza prognoza na każdy mecz turnieju.',
    next: 'Następne mecze', results: 'Wyniki', meetings: 'Ostatnie spotkania', form: 'Ostatnia forma', champions: 'Dawni mistrzowie', draw: 'Drabinka', preview: 'Zapowiedź meczu', noMatches: 'Brak zaplanowanych meczów.', rank: 'Miejsce', points: 'Punkty', tournaments: 'Turnieje', firstMeeting: 'Pierwsze spotkanie w naszych danych.'
  },
  el: {
    soonTitle: 'Προβλέψεις τένις · έρχονται σύντομα', soonDesc: 'Προβλέψεις τένις για κάθε αγώνα ATP, WTA και Challenger έρχονται σύντομα στο SportLikely.',
    homeTitle: 'Προβλέψεις τένις: ATP, WTA και Challenger', homeDesc: 'Προβλέψεις τένις για κάθε αγώνα ATP, WTA και Challenger: η πιθανότητα κάθε παίκτη, το πιθανό σκορ σετ και τα συνολικά γκέιμ, αποθηκευμένα πριν από το πρώτο σερβίς.',
    homeH1: 'Προβλέψεις τένις', homeIntro: 'Ποιος κερδίζει κάθε αγώνα ATP, WTA και Challenger, με την πιθανότητα κάθε παίκτη, το πιθανό σκορ σετ και τους λόγους πίσω από κάθε επιλογή. Κάθε πρόβλεψη αποθηκεύεται πριν από το πρώτο σερβίς και ελέγχεται δημόσια.',
    todayTitle: 'Προβλέψεις τένις σήμερα', todayDesc: 'Οι σημερινοί αγώνες ATP, WTA και Challenger ανά τουρνουά, με την κατάταξη των παικτών, την πρόσφατη φόρμα και την τελευταία αναμέτρηση. Ενημερώνεται καθημερινά.', todayH1: 'Προβλέψεις τένις σήμερα',
    rankTitle: 'Κατατάξεις ATP και WTA', rankDesc: 'Οι κατατάξεις μονού ATP και WTA: οι κορυφαίοι παίκτες με τους πόντους τους και πόσο κινήθηκαν από την τελευταία ενημέρωση, με συνδέσμους για κάθε παίκτη.', rankH1: 'Κατατάξεις ATP και WTA',
    matchTitle: '{0} - {1}: πρόβλεψη · {2}', matchDesc: '{0} - {1}, {2}, {3}: κατάταξη, πρόσφατη φόρμα, αριθμοί σερβίς και επιστροφής και αναμετρήσεις. Δωρεάν προεπισκόπηση και η επιλογή μας.', matchH1: '{0} - {1}: πρόβλεψη',
    playerTitle: '{0}: κατάταξη, αποτελέσματα και επόμενος αγώνας', playerDesc: '{0}{1}: πρόσφατα αποτελέσματα, φόρμα, αριθμοί σερβίς και επιστροφής, τίτλοι και ο επόμενος αγώνας, με την πρόβλεψή μας.',
    tourTitle: '{0} {1}: ταμπλό, αποτελέσματα και προβλέψεις', tourDesc: '{0} {1}: το ταμπλό, τα αποτελέσματα, οι παλιοί πρωταθλητές και η πρόβλεψή μας για κάθε αγώνα του τουρνουά.',
    next: 'Επόμενοι αγώνες', results: 'Αποτελέσματα', meetings: 'Τελευταίες αναμετρήσεις', form: 'Πρόσφατη φόρμα', champions: 'Παλιοί πρωταθλητές', draw: 'Ταμπλό', preview: 'Προεπισκόπηση αγώνα', noMatches: 'Δεν υπάρχουν προγραμματισμένοι αγώνες.', rank: 'Κατάταξη', points: 'Πόντοι', tournaments: 'Τουρνουά', firstMeeting: 'Πρώτη αναμέτρηση στα δεδομένα μας.'
  },
  ru: {
    soonTitle: 'Прогнозы на теннис · скоро', soonDesc: 'Прогнозы на каждый матч ATP, WTA и Challenger скоро появятся на SportLikely.',
    homeTitle: 'Прогнозы на теннис: ATP, WTA и Challenger', homeDesc: 'Прогнозы на каждый матч ATP, WTA и Challenger: шансы каждого игрока, вероятный счёт по сетам и тотал геймов, сохранённые до первой подачи.',
    homeH1: 'Прогнозы на теннис', homeIntro: 'Кто выиграет каждый матч ATP, WTA и Challenger: шансы каждого игрока, вероятный счёт по сетам и причины каждого выбора. Каждый прогноз сохраняется до первой подачи и проверяется публично.',
    todayTitle: 'Прогнозы на теннис сегодня', todayDesc: 'Сегодняшние матчи ATP, WTA и Challenger по турнирам, с рейтингом игроков, последней формой и последней встречей. Обновляется каждый день.', todayH1: 'Прогнозы на теннис сегодня',
    rankTitle: 'Рейтинги ATP и WTA', rankDesc: 'Одиночные рейтинги ATP и WTA: лучшие игроки, их очки и изменение с последнего обновления, со ссылками на каждого игрока.', rankH1: 'Рейтинги ATP и WTA',
    matchTitle: '{0} – {1}: прогноз · {2}', matchDesc: '{0} – {1}, {2}, {3}: рейтинг, последняя форма, цифры подачи и приёма и личные встречи. Бесплатный обзор и наш выбор.', matchH1: '{0} – {1}: прогноз',
    playerTitle: '{0}: рейтинг, результаты и следующий матч', playerDesc: '{0}{1}: последние результаты, форма, цифры подачи и приёма, титулы и следующий матч с нашим прогнозом.',
    tourTitle: '{0} {1}: сетка, результаты и прогнозы', tourDesc: '{0} {1}: сетка, результаты, прошлые чемпионы и наш прогноз на каждый матч турнира.',
    next: 'Следующие матчи', results: 'Результаты', meetings: 'Последние встречи', form: 'Последняя форма', champions: 'Прошлые чемпионы', draw: 'Сетка', preview: 'Обзор матча', noMatches: 'Матчей не запланировано.', rank: 'Место', points: 'Очки', tournaments: 'Турниры', firstMeeting: 'Первая встреча в наших данных.'
  }
};

export interface TennisSeo { title: string; description: string; body: string; noindex?: boolean; canonicalEn?: boolean; jsonld?: object[] }

const event = (m: TMatch, url: string, desc?: string) => ({
  '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${m.home.name} vs ${m.away.name}`, startDate: m.start, sport: 'Tennis',
  url, eventStatus: 'https://schema.org/EventScheduled', ...(desc ? { description: desc } : {}),
  competitor: [{ '@type': 'Person', name: m.home.name }, { '@type': 'Person', name: m.away.name }],
  location: { '@type': 'Place', name: m.tournament.city || m.tournament.name }, superEvent: { '@type': 'SportsEvent', name: m.tournament.name }
});
const pub = (m: TMatch) => m.tour !== 'itf';
/** "ATP Vienna" when we know the city, else the tournament's name (the weekly hub's name) */
export const hubName = (t: { tour: string; name: string; city: string | null }) => (t.city ? `${t.tour === 'wta' ? 'WTA' : t.tour === 'challenger' ? 'Challenger' : 'ATP'} ${t.city}` : t.name);

export function tennisSeoPage(path: string, lang: Lang): TennisSeo | null {
  if (path !== '/tennis' && !path.startsWith('/tennis/')) return null;
  const w = W[lang];
  if (!tennisPublic()) return { title: `${w.soonTitle} | ${BRAND}`, description: w.soonDesc, body: `<h1>${esc(w.soonTitle)}</h1>`, noindex: true };
  const L = (p: string) => link(lang, p);
  const nav = `<p><a href="${L('/tennis')}">${esc(w.homeH1)}</a> · <a href="${L('/tennis/today')}">${esc(w.todayH1)}</a> · <a href="${L('/tennis/rankings')}">${esc(w.rankH1)}</a></p>`;
  const row = (m: TMatch) => `<li><a href="${L(`/tennis/match/${m.id}`)}">${esc(m.home.name)} vs ${esc(m.away.name)}</a> · <a href="${L(`/tennis/tournament/${m.tournament.key}`)}">${esc(m.tournament.name)}</a>${m.round ? ` · ${esc(m.round)}` : ''} · ${esc(when(m.start, lang))}${m.score && m.state === 'done' ? ` · ${m.score.sets.map(s => `${s[0]}-${s[1]}`).join(' ')}` : ''}</li>`;
  const list = (ms: TMatch[]) => (ms.length ? `<ul>${ms.map(row).join('')}</ul>` : `<p>${esc(w.noMatches)}</p>`);
  const byLevel = (a: TMatch, b: TMatch) => levelRank(a.tournament.tier, a.tour, a.tournament.name) - levelRank(b.tournament.tier, b.tour, b.tournament.name) || a.start.localeCompare(b.start);
  let m: RegExpMatchArray | null;
  const now = Date.now();

  if (/^\/tennis\/(favorites|accuracy|past|upset-watch)$/.test(path)) return { title: `${w.homeH1} | ${BRAND}`, description: w.homeDesc, body: '', noindex: true };
  if (path === '/tennis' || path === '/tennis/matches') {
    const ms = tennisMatchesBetween(new Date(now - 3 * 3600e3).toISOString(), new Date(now + 3 * 86400e3).toISOString(), 'all', false, 2000).filter(x => pub(x) && x.state === 'upcoming').sort(byLevel).slice(0, 80);
    return {
      title: `${w.homeTitle} | ${BRAND}`, description: w.homeDesc,
      body: `${nav}<h1>${esc(w.homeH1)}</h1><p>${esc(w.homeIntro)}</p><h2>${esc(w.next)}</h2>${list(ms)}`,
      jsonld: ms.slice(0, 20).map(x => event(x, SITE + L(`/tennis/match/${x.id}`)))
    };
  }
  if (path === '/tennis/today') {
    const d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
    const ms = tennisMatchesBetween(d0.toISOString(), new Date(d0.getTime() + 86400e3).toISOString(), 'all', false, 2000).filter(x => pub(x) && x.state !== 'off');
    const groups = new Map<string, TMatch[]>();
    for (const x of ms.sort(byLevel)) groups.set(x.tournament.key, [...(groups.get(x.tournament.key) || []), x]);
    return {
      title: `${w.todayTitle} · ${day(d0.toISOString(), lang)} | ${BRAND}`, description: w.todayDesc,
      body: `${nav}<h1>${esc(w.todayH1)}</h1><p>${esc(day(d0.toISOString(), lang))}</p>${[...groups.values()].map(g => `<h2><a href="${L(`/tennis/tournament/${g[0].tournament.key}`)}">${esc(g[0].tournament.name)}</a> · ${esc(tierLabel(g[0].tournament.tier, g[0].tour))}</h2>${list(g)}`).join('') || `<p>${esc(w.noMatches)}</p>`}`
    };
  }
  if (path === '/tennis/rankings') {
    const tbl = (tour: 'atp' | 'wta') => {
      const r = tennisRankings(tour, 100);
      return r.rows.length ? `<h2>${tour.toUpperCase()}</h2><table><thead><tr><th>${esc(w.rank)}</th><th></th><th>${esc(w.points)}</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${x.rank}</td><td>${x.id ? `<a href="${L(`/tennis/player/${x.id}`)}">${esc(x.name)}</a>` : esc(x.name)}</td><td>${x.points ?? ''}</td></tr>`).join('')}</tbody></table>` : '';
    };
    return { title: `${w.rankTitle} | ${BRAND}`, description: w.rankDesc, body: `${nav}<h1>${esc(w.rankH1)}</h1>${tbl('atp')}${tbl('wta')}` };
  }
  if ((m = path.match(/^\/tennis\/match\/(\d+)$/))) {
    const d = tennisMatch(Number(m[1]), false, false);
    if (!d) return { title: `Not found | ${BRAND}`, description: 'This match does not exist.', body: '', noindex: true };
    const x = d.match;
    const where = [x.tournament.name, x.round].filter(Boolean).join(' ');
    const pv = lang === 'en' ? tennisWriteup(d) : null;
    const desc = fill(w.matchDesc, x.home.name, x.away.name, where, day(x.start, lang));
    const formList = (name: string, ps: typeof d.form.home) => ps.length ? `<h3>${esc(name)}</h3><ul>${ps.slice(0, 5).map(p => `<li>${p.won ? 'W' : 'L'} · ${p.opponent.id ? `<a href="${L(`/tennis/player/${p.opponent.id}`)}">${esc(p.opponent.name)}</a>` : esc(p.opponent.name)} · ${esc(p.tournament)} · ${esc(p.score)}</li>`).join('')}</ul>` : '';
    return {
      title: `${fill(w.matchTitle, x.home.name, x.away.name, where)} · ${day(x.start, lang)} | ${BRAND}`, description: desc,
      body: `${nav}<h1>${esc(fill(w.matchH1, x.home.name, x.away.name))}</h1><p><a href="${L(`/tennis/tournament/${x.tournament.key}`)}">${esc(x.tournament.name)}</a> · ${esc(tierLabel(x.tournament.tier, x.tour))}${x.round ? ` · ${esc(x.round)}` : ''}${x.tournament.surface ? ` · ${esc(x.tournament.surface)}` : ''} · ${esc(day(x.start, lang))} · ${slModel('tennis')}</p>`
        + (x.state === 'done' && x.score ? `<p>${x.score.sets.map(s => `${s[0]}-${s[1]}`).join(' ')}</p>` : '')
        + (pv ? `<section><h2>${esc(w.preview)}</h2><p>${esc(pv)}</p></section>` : '')
        // fix204: the most likely set score (when that output is public), in the page's language
        + (() => { try { const t = moreSentence('tennis', x.id, lang); return t ? `<p>${esc(t)}</p>` : ''; } catch { return ''; } })()
        + (d.form.home.length || d.form.away.length ? `<h2>${esc(w.form)}</h2>${formList(x.home.name, d.form.home)}${formList(x.away.name, d.form.away)}` : '')
        + `<h2>${esc(w.meetings)}</h2>${d.h2h.list.length ? list(d.h2h.list.slice(0, 8)) : `<p>${esc(w.firstMeeting)}</p>`}`
        + `<ul>${[x.home, x.away].filter(s => s.id).map(s => `<li><a href="${L(`/tennis/player/${s.id}`)}">${esc(s.name)}</a></li>`).join('')}</ul>`,
      jsonld: [event(x, SITE + L(path), pv ? pv.split('. ')[0] + '.' : undefined)]
    };
  }
  if ((m = path.match(/^\/tennis\/player\/(\d+)$/))) {
    const d = tennisPlayer(Number(m[1]), false, false, false);
    if (!d) return { title: `Not found | ${BRAND}`, description: 'This player does not exist.', body: '', noindex: true };
    const p = d.player;
    const facts = [p.rank ? `${p.tour.toUpperCase()} #${p.rank}` : null, p.country].filter(Boolean).join(', ');
    return {
      title: `${fill(w.playerTitle, p.name)} | ${BRAND}`, description: fill(w.playerDesc, p.name, facts ? ` (${facts})` : ''),
      body: `${nav}<h1>${esc(p.name)}</h1><p>${esc(facts)}${d.season.won + d.season.lost ? ` · ${d.season.year}: ${d.season.won}-${d.season.lost}` : ''}</p>`
        + (d.upcoming.length ? `<h2>${esc(w.next)}</h2>${list(d.upcoming)}` : '')
        + (d.recent.length ? `<h2>${esc(w.results)}</h2><ul>${d.recent.slice(0, 10).map(r => `<li>${r.won ? 'W' : 'L'} · ${r.opponent.id ? `<a href="${L(`/tennis/player/${r.opponent.id}`)}">${esc(r.opponent.name)}</a>` : esc(r.opponent.name)} · <a href="${L(`/tennis/tournament/${r.tkey}`)}">${esc(r.tournament)}</a> · <a href="${L(`/tennis/match/${r.id}`)}">${esc(r.score)}</a></li>`).join('')}</ul>` : '')
        + (d.titles.length ? `<h2>${esc(w.tournaments)}</h2><ul>${d.titles.slice(0, 10).map(t => `<li>${t.year} · <a href="${L(`/tennis/tournament/${t.key}`)}">${esc(t.tournament)}</a></li>`).join('')}</ul>` : ''),
      jsonld: [{ '@context': 'https://schema.org', '@type': 'Person', name: p.name, ...(p.country ? { nationality: p.country } : {}), url: SITE + L(path) }]
    };
  }
  if ((m = path.match(/^\/tennis\/(tournament|predictions)\/([a-z0-9-]{3,90})$/))) {
    const d = tennisTournament(m[2], false, false);
    if (!d) return { title: `Not found | ${BRAND}`, description: 'This tournament does not exist.', body: '', noindex: true };
    const all = d.draw.flatMap(r => r.matches);
    const year = (d.start || all[0]?.start || new Date().toISOString()).slice(0, 4);
    if (m[1] === 'predictions') {
      // the weekly hub (English text, canonical to English, like the other sports' hubs): this week's matches with previews
      const name = hubName(d);
      const wk = all.filter(x => Date.parse(x.start) >= now - 86400e3 && Date.parse(x.start) <= now + 7 * 86400e3 && x.state !== 'off').slice(0, 40);
      const sec = wk.map(x => {
        const dd = x.state === 'upcoming' ? tennisMatch(x.id, false, false) : null;
        const pv = dd ? tennisWriteup(dd) : null;
        return `<section><h2><a href="/tennis/match/${x.id}">${esc(x.home.name)} vs ${esc(x.away.name)}</a></h2><p>${esc([x.round, when(x.start, 'en')].filter(Boolean).join(' · '))}</p>${pv ? `<p>${esc(pv)}</p>` : ''}</section>`;
      }).join('');
      return {
        title: `${name} predictions this week | ${BRAND}`,
        description: `${name} predictions for every match this week: each player’s chance, the likely set score and total games, with a preview of form, serve and head-to-head.`,
        body: `${nav}<h1>${esc(name)} predictions this week</h1><p>${esc(d.name)} · ${esc(tierLabel(d.tier, d.tour))}${d.surface ? ` · ${esc(d.surface)}` : ''}</p>${sec || `<p>${esc(W.en.noMatches)}</p>`}<p><a href="/tennis/tournament/${d.key}">${esc(d.name)}: draw and results</a></p>`,
        canonicalEn: true, jsonld: wk.slice(0, 20).map(x => event(x, `${SITE}/tennis/match/${x.id}`))
      };
    }
    const done = all.filter(x => x.state === 'done').sort((a, b) => b.start.localeCompare(a.start)).slice(0, 30);
    const next = all.filter(x => x.state === 'upcoming').slice(0, 30);
    return {
      title: `${fill(w.tourTitle, d.name, year)} | ${BRAND}`, description: fill(w.tourDesc, d.name, year),
      body: `${nav}<h1>${esc(d.name)} ${year}</h1><p>${esc([tierLabel(d.tier, d.tour), d.surface, d.indoor ? 'indoor' : null, [d.city, d.country].filter(Boolean).join(', '), d.start ? day(d.start, lang) : null].filter(Boolean).join(' · '))}</p>`
        + (next.length ? `<h2>${esc(w.next)}</h2>${list(next)}` : '') + (done.length ? `<h2>${esc(w.results)}</h2>${list(done)}` : '')
        + (d.champions.length ? `<h2>${esc(w.champions)}</h2><ul>${d.champions.map(c => `<li>${c.year} · ${c.winner.id ? `<a href="${L(`/tennis/player/${c.winner.id}`)}">${esc(c.winner.name)}</a>` : esc(c.winner.name)} · ${esc(c.score)}</li>`).join('')}</ul>` : '')
    };
  }
  return { title: `${w.homeH1} | ${BRAND}`, description: w.homeDesc, body: nav, noindex: true };
}

/* ---------- sitemaps (only when TENNIS_PUBLIC=1) ---------- */

export interface TennisUrl { loc: string; freq: string; pri: string; mod: string; enOnly?: boolean }
const isoDay = (iso?: string | null) => (iso || new Date().toISOString()).slice(0, 10);
/** sitemap-tennis.xml: lists, matches of the last 14 / next 10 days, tournaments in play or just played, this week's hubs */
export function tennisSitemapUrls(): TennisUrl[] {
  if (!tennisPublic()) return [];
  const today = isoDay(), now = Date.now();
  const urls: TennisUrl[] = ['/tennis', '/tennis/matches', '/tennis/today', '/tennis/rankings'].map(loc => ({ loc, freq: 'daily', pri: loc === '/tennis' ? '0.8' : '0.7', mod: today }));
  const ms = tennisMatchesBetween(new Date(now - 14 * 86400e3).toISOString(), new Date(now + 10 * 86400e3).toISOString(), 'all', false, 6000).filter(m => pub(m) && m.state !== 'off');
  const tours = new Map<string, { last: string; on: boolean }>();
  for (const m of ms) {
    const up = Date.parse(m.start) >= now;
    urls.push({ loc: `/tennis/match/${m.id}`, freq: up ? 'hourly' : 'weekly', pri: up ? '0.7' : '0.4', mod: isoDay(m.start) });
    const t = tours.get(m.tournament.key) || { last: m.start, on: false };
    if (m.start > t.last) t.last = m.start;
    if (up || Math.abs(Date.parse(m.start) - now) < 2 * 86400e3) t.on = true;
    tours.set(m.tournament.key, t);
  }
  for (const [key, t] of tours) {
    urls.push({ loc: `/tennis/tournament/${key}`, freq: 'daily', pri: '0.6', mod: isoDay(t.last) });
    if (t.on) urls.push({ loc: `/tennis/predictions/${key}`, freq: 'daily', pri: '0.7', mod: today, enOnly: true });
  }
  return urls;
}
/** players for sitemap-players.xml: the ranked top 300 of each tour + everyone with a match in the last 60 days (≤ 2,500) */
export function tennisPlayerUrls(): TennisUrl[] {
  if (!tennisPublic()) return [];
  const ids = new Set<number>();
  for (const tour of ['atp', 'wta']) {
    const d = (db.prepare(`SELECT MAX(date) AS d FROM tennis_rankings WHERE tour = ?`).get(tour) as any)?.d;
    if (d) for (const r of db.prepare(`SELECT player_id FROM tennis_rankings WHERE tour = ? AND date = ? AND rank <= 300 AND player_id IS NOT NULL`).all(tour, d) as any[]) ids.add(r.player_id);
  }
  const since = new Date(Date.now() - 60 * 86400e3).toISOString();
  for (const r of db.prepare(`SELECT pid FROM (SELECT p1_id AS pid, scheduled_at, tour, source, draw FROM tennis_matches WHERE scheduled_at >= ? UNION ALL SELECT p2_id, scheduled_at, tour, source, draw FROM tennis_matches WHERE scheduled_at >= ?)
      WHERE pid IS NOT NULL AND COALESCE(tour, '') IN ('atp', 'wta', 'challenger') AND source <> 'archive' AND COALESCE(draw, 'singles') = 'singles' GROUP BY pid ORDER BY COUNT(*) DESC LIMIT 2500`).all(since, since) as any[]) {
    if (ids.size >= 2500) break;
    ids.add(r.pid);
  }
  const today = isoDay();
  return [...ids].map(id => ({ loc: `/tennis/player/${id}`, freq: 'weekly', pri: '0.3', mod: today }));
}

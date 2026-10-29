/**
 * fix244: the Quick check — what a browser on a VPN / proxy network sees when the proxy rules (services/proxyGuard.ts)
 * would refuse it: a small SportLikely page (no app, so no API calls), 9 languages (ar / he right to left), with Cloudflare Turnstile. Passing it
 * (POST /api/auth/quick-check) sets the signed sl_pass cookie, then the page reloads (or, at /quick-check, goes back to
 * the page the app was on). Without Turnstile keys: the plain "try again later, or sign in" line. Pure: no imports.
 */

export const QC_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'] as const;
/** Written right to left (= utils/langs.ts RTL_LANGS; this file stays import-free). */
const QC_RTL: readonly QcLang[] = ['ar', 'he'];
export type QcLang = (typeof QC_LANGS)[number];

type Words = { title: string; vpn: string; why: string; swarm: string; swarmWhy: string; checking: string; done: string; failed: string; signin: string; signinWhy: string; later: string; footer: string };

export const QC_WORDS: Record<QcLang, Words> = {
  en: {
    title: 'Quick check', vpn: "You're on a VPN or proxy network.",
    swarm: 'Many visits that look like yours come from scripts right now.', swarmWhy: 'So we check that you are a person. It takes a second.',
    why: 'Many pages are opened from this network, so we check that you are a person. It takes a second.',
    checking: 'Checking…', done: 'Done. Opening the page…', failed: "That didn't work. Please try again.",
    signin: 'Sign in', signinWhy: 'Signed in with a confirmed email, you are never asked.',
    later: 'Too many pages opened from this network. Please try again later, or sign in.',
    footer: 'Sports predictions · probabilities, not promises · 18+'
  },
  de: {
    title: 'Kurze Prüfung', vpn: 'Du bist in einem VPN- oder Proxy-Netzwerk.',
    swarm: 'Gerade kommen viele Besuche, die wie deiner aussehen, von Skripten.', swarmWhy: 'Daher prüfen wir, ob du ein Mensch bist. Das dauert eine Sekunde.',
    why: 'Aus diesem Netzwerk werden viele Seiten geöffnet, daher prüfen wir, ob du ein Mensch bist. Das dauert eine Sekunde.',
    checking: 'Wird geprüft…', done: 'Fertig. Die Seite wird geöffnet…', failed: 'Das hat nicht geklappt. Bitte versuche es noch einmal.',
    signin: 'Anmelden', signinWhy: 'Angemeldet mit bestätigter E-Mail wirst du nie gefragt.',
    later: 'Aus diesem Netzwerk wurden zu viele Seiten geöffnet. Bitte versuche es später noch einmal oder melde dich an.',
    footer: 'Sportprognosen · Wahrscheinlichkeiten, keine Versprechen · 18+'
  },
  es: {
    title: 'Comprobación rápida', vpn: 'Estás en una red VPN o proxy.',
    swarm: 'Ahora mismo muchas visitas que parecen la tuya vienen de scripts.', swarmWhy: 'Por eso comprobamos que eres una persona. Tarda un segundo.',
    why: 'Desde esta red se abren muchas páginas, así que comprobamos que eres una persona. Tarda un segundo.',
    checking: 'Comprobando…', done: 'Listo. Abriendo la página…', failed: 'No ha funcionado. Inténtalo de nuevo.',
    signin: 'Iniciar sesión', signinWhy: 'Con la sesión iniciada y el correo confirmado, nunca se te pregunta.',
    later: 'Se han abierto demasiadas páginas desde esta red. Inténtalo más tarde o inicia sesión.',
    footer: 'Predicciones deportivas · probabilidades, no promesas · 18+'
  },
  fr: {
    title: 'Vérification rapide', vpn: 'Vous êtes sur un réseau VPN ou proxy.',
    swarm: 'En ce moment, beaucoup de visites qui ressemblent à la vôtre viennent de scripts.', swarmWhy: 'Nous vérifions donc que vous êtes une personne. Cela prend une seconde.',
    why: 'Beaucoup de pages sont ouvertes depuis ce réseau, nous vérifions donc que vous êtes une personne. Cela prend une seconde.',
    checking: 'Vérification…', done: 'C’est fait. Ouverture de la page…', failed: 'Cela n’a pas marché. Veuillez réessayer.',
    signin: 'Se connecter', signinWhy: 'Connecté avec un e-mail confirmé, vous n’êtes jamais vérifié.',
    later: 'Trop de pages ouvertes depuis ce réseau. Réessayez plus tard ou connectez-vous.',
    footer: 'Pronostics sportifs · des probabilités, pas des promesses · 18+'
  },
  it: {
    title: 'Controllo rapido', vpn: 'Sei su una rete VPN o proxy.',
    swarm: 'In questo momento molte visite simili alla tua arrivano da script.', swarmWhy: 'Quindi controlliamo che tu sia una persona. Ci vuole un secondo.',
    why: 'Da questa rete vengono aperte molte pagine, quindi controlliamo che tu sia una persona. Ci vuole un secondo.',
    checking: 'Controllo in corso…', done: 'Fatto. Apertura della pagina…', failed: 'Non ha funzionato. Riprova.',
    signin: 'Accedi', signinWhy: 'Se hai effettuato l’accesso con un’email confermata, non ti viene mai chiesto.',
    later: 'Troppe pagine aperte da questa rete. Riprova più tardi o accedi.',
    footer: 'Pronostici sportivi · probabilità, non promesse · 18+'
  },
  pt: {
    title: 'Verificação rápida', vpn: 'Você está em uma rede VPN ou proxy.',
    swarm: 'Agora mesmo muitas visitas parecidas com a sua vêm de scripts.', swarmWhy: 'Por isso verificamos se você é uma pessoa. Leva um segundo.',
    why: 'Muitas páginas são abertas a partir desta rede, então verificamos se você é uma pessoa. Leva um segundo.',
    checking: 'Verificando…', done: 'Pronto. Abrindo a página…', failed: 'Não funcionou. Tente novamente.',
    signin: 'Entrar', signinWhy: 'Com sessão iniciada e e-mail confirmado, você nunca é verificado.',
    later: 'Muitas páginas abertas a partir desta rede. Tente mais tarde ou entre na sua conta.',
    footer: 'Previsões esportivas · probabilidades, não promessas · 18+'
  },
  tr: {
    title: 'Hızlı kontrol', vpn: 'Bir VPN veya proxy ağındasınız.',
    swarm: 'Şu anda sizinkine benzeyen birçok ziyaret betiklerden geliyor.', swarmWhy: 'Bu yüzden bir insan olduğunuzu kontrol ediyoruz. Bir saniye sürer.',
    why: 'Bu ağdan çok sayıda sayfa açılıyor, bu yüzden bir insan olduğunuzu kontrol ediyoruz. Bir saniye sürer.',
    checking: 'Kontrol ediliyor…', done: 'Tamam. Sayfa açılıyor…', failed: 'Olmadı. Lütfen tekrar deneyin.',
    signin: 'Giriş yap', signinWhy: 'Onaylı e-postayla giriş yaptığınızda size hiç sorulmaz.',
    later: 'Bu ağdan çok fazla sayfa açıldı. Lütfen daha sonra tekrar deneyin veya giriş yapın.',
    footer: 'Spor tahminleri · olasılıklar, vaat değil · 18+'
  },
  id: {
    title: 'Pemeriksaan singkat', vpn: 'Anda menggunakan jaringan VPN atau proxy.',
    swarm: 'Saat ini banyak kunjungan yang mirip dengan Anda berasal dari skrip.', swarmWhy: 'Jadi kami memeriksa bahwa Anda manusia. Hanya butuh sedetik.',
    why: 'Banyak halaman dibuka dari jaringan ini, jadi kami memeriksa bahwa Anda manusia. Hanya butuh sedetik.',
    checking: 'Memeriksa…', done: 'Selesai. Membuka halaman…', failed: 'Tidak berhasil. Silakan coba lagi.',
    signin: 'Masuk', signinWhy: 'Jika masuk dengan email yang sudah dikonfirmasi, Anda tidak pernah ditanya.',
    later: 'Terlalu banyak halaman dibuka dari jaringan ini. Silakan coba lagi nanti, atau masuk.',
    footer: 'Prediksi olahraga · probabilitas, bukan janji · 18+'
  },
  hi: {
    title: 'त्वरित जाँच', vpn: 'आप VPN या प्रॉक्सी नेटवर्क पर हैं।',
    swarm: 'अभी आपकी जैसी दिखने वाली कई विज़िट स्क्रिप्ट से आ रही हैं।', swarmWhy: 'इसलिए हम जाँचते हैं कि आप इंसान हैं। इसमें एक सेकंड लगता है।',
    why: 'इस नेटवर्क से कई पेज खोले जाते हैं, इसलिए हम जाँचते हैं कि आप इंसान हैं। इसमें एक सेकंड लगता है।',
    checking: 'जाँच हो रही है…', done: 'हो गया। पेज खुल रहा है…', failed: 'यह काम नहीं किया। कृपया फिर से कोशिश करें।',
    signin: 'साइन इन करें', signinWhy: 'पुष्टि किए गए ईमेल से साइन इन होने पर आपसे कभी नहीं पूछा जाता।',
    later: 'इस नेटवर्क से बहुत ज़्यादा पेज खोले गए। कृपया बाद में फिर कोशिश करें, या साइन इन करें।',
    footer: 'खेल भविष्यवाणियाँ · संभावनाएँ, वादे नहीं · 18+'
  },
  pl: {
    title: 'Szybkie sprawdzenie', vpn: 'Korzystasz z sieci VPN lub proxy.',
    swarm: 'Teraz wiele wizyt podobnych do Twojej pochodzi od skryptów.', swarmWhy: 'Dlatego sprawdzamy, czy jesteś człowiekiem. To potrwa sekundę.',
    why: 'Z tej sieci otwiera się wiele stron, więc sprawdzamy, czy jesteś człowiekiem. To potrwa sekundę.',
    checking: 'Sprawdzanie…', done: 'Gotowe. Otwieramy stronę…', failed: 'Nie udało się. Spróbuj ponownie.',
    signin: 'Zaloguj się', signinWhy: 'Po zalogowaniu z potwierdzonym e-mailem nigdy nie pytamy.',
    later: 'Z tej sieci otwarto zbyt wiele stron. Spróbuj ponownie później albo zaloguj się.',
    footer: 'Prognozy sportowe · prawdopodobieństwa, nie obietnice · 18+'
  },
  el: {
    title: 'Γρήγορος έλεγχος', vpn: 'Είσαι σε δίκτυο VPN ή proxy.',
    swarm: 'Αυτή τη στιγμή πολλές επισκέψεις που μοιάζουν με τη δική σου έρχονται από σενάρια (scripts).', swarmWhy: 'Γι’ αυτό ελέγχουμε ότι είσαι άνθρωπος. Παίρνει ένα δευτερόλεπτο.',
    why: 'Από αυτό το δίκτυο ανοίγουν πολλές σελίδες, οπότε ελέγχουμε ότι είσαι άνθρωπος. Παίρνει ένα δευτερόλεπτο.',
    checking: 'Έλεγχος…', done: 'Έτοιμο. Ανοίγει η σελίδα…', failed: 'Δεν πέτυχε. Δοκίμασε ξανά.',
    signin: 'Σύνδεση', signinWhy: 'Αν συνδεθείς με επιβεβαιωμένο email, δεν σε ρωτάμε ποτέ.',
    later: 'Άνοιξαν πάρα πολλές σελίδες από αυτό το δίκτυο. Δοκίμασε ξανά αργότερα ή συνδέσου.',
    footer: 'Αθλητικές προβλέψεις · πιθανότητες, όχι υποσχέσεις · 18+'
  },
  ru: {
    title: 'Быстрая проверка', vpn: 'Вы в сети VPN или прокси.',
    swarm: 'Сейчас много посещений, похожих на ваше, идут от скриптов.', swarmWhy: 'Поэтому мы проверяем, что вы человек. Это займёт секунду.',
    why: 'Из этой сети открывают много страниц, поэтому мы проверяем, что вы человек. Это займёт секунду.',
    checking: 'Проверяем…', done: 'Готово. Открываем страницу…', failed: 'Не получилось. Попробуйте ещё раз.',
    signin: 'Войти', signinWhy: 'Если вы вошли с подтверждённым email, мы никогда не спрашиваем.',
    later: 'Из этой сети открыто слишком много страниц. Попробуйте позже или войдите.',
    footer: 'Спортивные прогнозы · вероятности, а не обещания · 18+',
  },
  ar: {
    title: 'تحقق سريع', vpn: 'أنت متصل عبر شبكة VPN أو بروكسي.',
    swarm: 'الكثير من الزيارات التي تشبه زيارتك تأتي الآن من برامج آلية.', swarmWhy: 'لذلك نتحقق من أنك شخص حقيقي. الأمر يستغرق ثانية.',
    why: 'تُفتح صفحات كثيرة من هذه الشبكة، لذلك نتحقق من أنك شخص حقيقي. الأمر يستغرق ثانية.',
    checking: 'جارٍ التحقق…', done: 'تم. جارٍ فتح الصفحة…', failed: 'لم ينجح ذلك. حاول مرة أخرى.',
    signin: 'تسجيل الدخول', signinWhy: 'عند تسجيل الدخول ببريد إلكتروني مؤكد، لن يُطلب منك ذلك أبدًا.',
    later: 'فُتحت صفحات كثيرة جدًا من هذه الشبكة. حاول لاحقًا، أو سجّل الدخول.',
    footer: 'توقعات رياضية · احتمالات، لا وعود · 18+'
  },
  he: {
    title: 'בדיקה מהירה', vpn: 'נראה שאתם מחוברים דרך VPN או פרוקסי.',
    swarm: 'כרגע הרבה כניסות שנראות כמו שלכם מגיעות מתוכנות אוטומטיות.', swarmWhy: 'אז אנחנו בודקים שמדובר באדם. זה לוקח שנייה.',
    why: 'מהרשת הזו נפתחים הרבה עמודים, אז אנחנו בודקים שמדובר באדם. זה לוקח שנייה.',
    checking: 'בודקים…', done: 'זהו. פותחים את העמוד…', failed: 'זה לא הצליח. נסו שוב.',
    signin: 'התחברות', signinWhy: 'מי שמחובר עם אימייל מאומת לא נשאל אף פעם.',
    later: 'נפתחו יותר מדי עמודים מהרשת הזו. נסו שוב מאוחר יותר, או התחברו.',
    footer: 'תחזיות ספורט · הסתברויות, לא הבטחות · 18+'
  }
};

/** The language of an address (/es/…), else English. */
const QC_PREFIX = new RegExp(`^\\/(${QC_LANGS.filter(l => l !== 'en').join('|')})(\\/|$)`);
export const qcLangOf = (path: string): QcLang => ((QC_PREFIX.exec(path)?.[1] as QcLang) || 'en');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * The page. siteKey null = Turnstile is off: the plain line with Sign in. fix277: kind 'swarm' = a scraper swarm's
 * challenge (services/swarmGuard.ts): the same check, its own reason line.
 */
export function quickCheckPage(lang: QcLang, siteKey: string | null, kind: 'proxy' | 'swarm' = 'proxy'): string {
  const w = QC_WORDS[lang] || QC_WORDS.en;
  const pre = lang === 'en' ? '' : `/${lang}`;
  const check = siteKey
    ? `<div id="ts" class="ts"></div><p id="st" class="st" role="status" aria-live="polite"></p>`
    : `<p class="st">${esc(w.later)}</p>`;
  const script = siteKey ? `<script>
(function () {
  var W = ${js({ checking: w.checking, done: w.done, failed: w.failed })}, home = ${js(pre || '/')};
  var st = document.getElementById('st');
  function back() {
    var r = null;
    try { r = sessionStorage.getItem('sl-qc-return'); sessionStorage.removeItem('sl-qc-return'); } catch (e) {}
    if (!/\\/quick-check\\/?$/.test(location.pathname)) return location.reload();
    location.replace(r && r.charAt(0) === '/' && r.charAt(1) !== '/' ? r : home);
  }
  window.slQc = function () {
    window.turnstile.render('#ts', {
      sitekey: ${js(siteKey)},
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      callback: function (token) {
        st.textContent = W.checking;
        fetch('/api/auth/quick-check', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) })
          .then(function (r) { if (!r.ok) throw 0; st.textContent = W.done; setTimeout(back, 300); })
          .catch(function () { st.textContent = W.failed; try { window.turnstile.reset('#ts'); } catch (e) {} });
      },
      'error-callback': function () { st.textContent = W.failed; }
    });
  };
})();
</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=slQc&amp;render=explicit" async defer></script>` : '';
  return `<!doctype html>
<html lang="${lang}"${QC_RTL.includes(lang) ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(w.title)} · SportLikely</title><link rel="icon" href="/favicon.svg">
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#11151d;--muted:#5b6475;--line:#e3e6ec;--accent:#4d7c0f;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#07090d;--card:#11151d;--ink:#eef1f6;--muted:#9aa3b5;--line:#232a36;--accent:#c8ff3d;--on:#07090d}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.01em;color:var(--ink);text-decoration:none;margin-bottom:18px}
.brand img{width:32px;height:32px;border-radius:8px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px;text-align:center}
h1{font-size:22px;margin:0 0 6px}.vpn{font-weight:600;margin:0 0 6px}.why{color:var(--muted);font-size:14px;margin:0 0 18px}
.ts{min-height:65px;display:flex;justify-content:center}.st{min-height:22px;font-size:14px;color:var(--muted);margin:10px 0 0}
.or{margin:18px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.btn{display:inline-block;margin-top:8px;padding:10px 18px;border-radius:12px;background:var(--accent);color:var(--on);font-weight:700;text-decoration:none}
.foot{margin-top:18px;font-size:12px;color:var(--muted)}
</style></head>
<body><a class="brand" href="${pre || '/'}"><img src="/logo-mark.png" alt="">SportLikely</a>
<main class="card"><h1>${esc(w.title)}</h1><p class="vpn">${esc(kind === 'swarm' ? w.swarm : w.vpn)}</p><p class="why">${esc(kind === 'swarm' ? w.swarmWhy : w.why)}</p>${check}
<div class="or">${esc(w.signinWhy)}<br><a class="btn" href="${pre}/login">${esc(w.signin)}</a></div></main>
<p class="foot">${esc(w.footer)}</p>${script}</body></html>`;
}

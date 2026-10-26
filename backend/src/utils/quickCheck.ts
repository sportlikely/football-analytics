/**
 * fix244: the Quick check — what a browser on a VPN / proxy network sees when the proxy rules (services/proxyGuard.ts)
 * would refuse it: a small SportLikely page (no app, so no API calls), 7 languages, with Cloudflare Turnstile. Passing it
 * (POST /api/auth/quick-check) sets the signed sl_pass cookie, then the page reloads (or, at /quick-check, goes back to
 * the page the app was on). Without Turnstile keys: the plain "try again later, or sign in" line. Pure: no imports.
 */

export const QC_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr'] as const;
export type QcLang = (typeof QC_LANGS)[number];

type Words = { title: string; vpn: string; why: string; checking: string; done: string; failed: string; signin: string; signinWhy: string; later: string; footer: string };

export const QC_WORDS: Record<QcLang, Words> = {
  en: {
    title: 'Quick check', vpn: "You're on a VPN or proxy network.",
    why: 'Many pages are opened from this network, so we check that you are a person. It takes a second.',
    checking: 'Checking…', done: 'Done. Opening the page…', failed: "That didn't work. Please try again.",
    signin: 'Sign in', signinWhy: 'Signed in with a confirmed email, you are never asked.',
    later: 'Too many pages opened from this network. Please try again later, or sign in.',
    footer: 'Sports predictions · probabilities, not promises · 18+'
  },
  de: {
    title: 'Kurze Prüfung', vpn: 'Du bist in einem VPN- oder Proxy-Netzwerk.',
    why: 'Aus diesem Netzwerk werden viele Seiten geöffnet, daher prüfen wir, ob du ein Mensch bist. Das dauert eine Sekunde.',
    checking: 'Wird geprüft…', done: 'Fertig. Die Seite wird geöffnet…', failed: 'Das hat nicht geklappt. Bitte versuche es noch einmal.',
    signin: 'Anmelden', signinWhy: 'Angemeldet mit bestätigter E-Mail wirst du nie gefragt.',
    later: 'Aus diesem Netzwerk wurden zu viele Seiten geöffnet. Bitte versuche es später noch einmal oder melde dich an.',
    footer: 'Sportprognosen · Wahrscheinlichkeiten, keine Versprechen · 18+'
  },
  es: {
    title: 'Comprobación rápida', vpn: 'Estás en una red VPN o proxy.',
    why: 'Desde esta red se abren muchas páginas, así que comprobamos que eres una persona. Tarda un segundo.',
    checking: 'Comprobando…', done: 'Listo. Abriendo la página…', failed: 'No ha funcionado. Inténtalo de nuevo.',
    signin: 'Iniciar sesión', signinWhy: 'Con la sesión iniciada y el correo confirmado, nunca se te pregunta.',
    later: 'Se han abierto demasiadas páginas desde esta red. Inténtalo más tarde o inicia sesión.',
    footer: 'Predicciones deportivas · probabilidades, no promesas · 18+'
  },
  fr: {
    title: 'Vérification rapide', vpn: 'Vous êtes sur un réseau VPN ou proxy.',
    why: 'Beaucoup de pages sont ouvertes depuis ce réseau, nous vérifions donc que vous êtes une personne. Cela prend une seconde.',
    checking: 'Vérification…', done: 'C’est fait. Ouverture de la page…', failed: 'Cela n’a pas marché. Veuillez réessayer.',
    signin: 'Se connecter', signinWhy: 'Connecté avec un e-mail confirmé, vous n’êtes jamais vérifié.',
    later: 'Trop de pages ouvertes depuis ce réseau. Réessayez plus tard ou connectez-vous.',
    footer: 'Pronostics sportifs · des probabilités, pas des promesses · 18+'
  },
  it: {
    title: 'Controllo rapido', vpn: 'Sei su una rete VPN o proxy.',
    why: 'Da questa rete vengono aperte molte pagine, quindi controlliamo che tu sia una persona. Ci vuole un secondo.',
    checking: 'Controllo in corso…', done: 'Fatto. Apertura della pagina…', failed: 'Non ha funzionato. Riprova.',
    signin: 'Accedi', signinWhy: 'Se hai effettuato l’accesso con un’email confermata, non ti viene mai chiesto.',
    later: 'Troppe pagine aperte da questa rete. Riprova più tardi o accedi.',
    footer: 'Pronostici sportivi · probabilità, non promesse · 18+'
  },
  pt: {
    title: 'Verificação rápida', vpn: 'Você está em uma rede VPN ou proxy.',
    why: 'Muitas páginas são abertas a partir desta rede, então verificamos se você é uma pessoa. Leva um segundo.',
    checking: 'Verificando…', done: 'Pronto. Abrindo a página…', failed: 'Não funcionou. Tente novamente.',
    signin: 'Entrar', signinWhy: 'Com sessão iniciada e e-mail confirmado, você nunca é verificado.',
    later: 'Muitas páginas abertas a partir desta rede. Tente mais tarde ou entre na sua conta.',
    footer: 'Previsões esportivas · probabilidades, não promessas · 18+'
  },
  tr: {
    title: 'Hızlı kontrol', vpn: 'Bir VPN veya proxy ağındasınız.',
    why: 'Bu ağdan çok sayıda sayfa açılıyor, bu yüzden bir insan olduğunuzu kontrol ediyoruz. Bir saniye sürer.',
    checking: 'Kontrol ediliyor…', done: 'Tamam. Sayfa açılıyor…', failed: 'Olmadı. Lütfen tekrar deneyin.',
    signin: 'Giriş yap', signinWhy: 'Onaylı e-postayla giriş yaptığınızda size hiç sorulmaz.',
    later: 'Bu ağdan çok fazla sayfa açıldı. Lütfen daha sonra tekrar deneyin veya giriş yapın.',
    footer: 'Spor tahminleri · olasılıklar, vaat değil · 18+'
  }
};

/** The language of an address (/es/…), else English. */
export const qcLangOf = (path: string): QcLang => ((/^\/(de|es|fr|it|pt|tr)(\/|$)/.exec(path)?.[1] as QcLang) || 'en');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

/** The page. siteKey null = Turnstile is off: the plain line with Sign in. */
export function quickCheckPage(lang: QcLang, siteKey: string | null): string {
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
      sitekey: ${js(siteKey)}, appearance: 'managed',
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
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
<main class="card"><h1>${esc(w.title)}</h1><p class="vpn">${esc(w.vpn)}</p><p class="why">${esc(w.why)}</p>${check}
<div class="or">${esc(w.signinWhy)}<br><a class="btn" href="${pre}/login">${esc(w.signin)}</a></div></main>
<p class="foot">${esc(w.footer)}</p>${script}</body></html>`;
}

/**
 * fix168: throw-away email providers. A sign-up with one of these domains (or a subdomain of one) is refused with
 * "Please use a permanent email address". Add new ones here, lower case.
 */
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator.org', '10minutemail.com', '10minutemail.net', '10minutemail.co.uk', '20minutemail.com',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  'temp-mail.org', 'temp-mail.io', 'tempmail.com', 'tempmail.net', 'tempmail.dev', 'tempmailo.com', 'tempmail.plus', 'tempr.email', 'temp-mail.ru', 'tmpmail.org', 'tmpmail.net', 'tmail.ws',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf', 'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf',
  'trashmail.com', 'trashmail.de', 'trashmail.net', 'trashmail.me', 'wegwerfmail.de', 'wegwerfmail.net', 'einrot.com', 'byom.de',
  'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'fakeinbox.com', 'fakemail.net',
  'throwawaymail.com', 'trash-mail.com', 'mailcatch.com', 'mytemp.email', 'mailpoof.com', 'inboxkitten.com', 'burnermail.io', 'spamgourmet.com', 'spambox.us', 'spamex.com',
  'discard.email', 'discardmail.com', 'dropmail.me', 'emailfake.com', 'fakemailgenerator.com', 'generator.email', 'harakirimail.com', 'linshiyouxiang.net', 'mail.tm', 'mail.gw',
  'mailtemp.net', 'moakt.com', 'mt2015.com', 'tempinbox.com', 'tempmailaddress.com', 'temporary-mail.net', 'tempemail.co', 'easytrashmail.com', 'anonbox.net', 'meltmail.com',
  'mailnull.com', 'incognitomail.org', 'kurzepost.de', 'objectmail.com', 'proxymail.eu', 'rcpt.at', 'spamfree24.org', 'zetmail.com', 'zoemail.org', 'emltmp.com', 'vomoto.com', 'qiott.com'
])

export function isDisposable(email: string): boolean {
  const domain = String(email || '').toLowerCase().split('@')[1] || ''
  if (!domain) return false
  if (DISPOSABLE_DOMAINS.has(domain)) return true
  const parts = domain.split('.')
  for (let i = 1; i < parts.length - 1; i++) if (DISPOSABLE_DOMAINS.has(parts.slice(i).join('.'))) return true
  return false
}

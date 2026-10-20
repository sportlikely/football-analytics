/**
 * fix195: tennis player names. Twin of `surname()` in frontend/src/lib/tennis.ts — change both together.
 * The short name in tight rows is the real surname: particles keep the rest of the name ("de Minaur", "Dalla Valle",
 * "van de Zandschulp"), hyphenated names stay whole ("Auger-Aliassime"), and known two-word surnames stay whole
 * ("Bautista Agut", "Haddad Maia"). The API's own last name wins when the player profile has one.
 */

const PARTICLE = /^(de|del|della|dalla|delle|dello|di|da|das|dos|do|du|van|von|der|den|ter|ten|le|la|lo|mc|st\.?|al|el|ben|bin|y)$/i;
/** two-word surnames (lower case, accents removed): the last two words stay together */
export const COMPOUND_SURNAMES = new Set([
  'bautista agut', 'carreno busta', 'davidovich fokina', 'ramos vinolas', 'haddad maia', 'sorribes tormo', 'carballes baena',
  'zapata miralles', 'martinez portero', 'diaz acosta', 'seyboth wild', 'mpetshi perricard', 'barrios vera', 'ugo carabelli',
  'pacheco mendez', 'bouzas maneiro', 'riera sanchez', 'garcia lopez', 'munar clar', 'mena garcia', 'bolelli tabilo', 'galan riveros',
  'varillas patino', 'nava torres', 'gomez lopez', 'blanch serrano', 'romero gormaz', 'sanchez izquierdo', 'llamas ruiz', 'moro canas',
  'vallejo ferreira', 'ramirez gonzalez', 'hernandez vazquez', 'lopez montagud', 'alvarez varona', 'castro vallejo', 'rodriguez taverna',
  'tirante baena', 'cid subervi', 'gonzalez caceres', 'olivieri menendez', 'rincon lopez', 'perez sanchez', 'herrero gonzalez',
  'bueno gonzalez', 'pellegrino martinez', 'meligeni rodrigues', 'ribeiro monteiro', 'trungelliti marchesi', 'garcia perez',
  'osorio serrano', 'vidal azorin', 'parrizas diaz', 'bassols ribera', 'sierra mendoza', 'gonzalez vaquero'
]);
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "D. E. Galan", "J.P. Varillas": a name that starts with initials */
export const isAbbreviated = (name: string | null | undefined) => /^(\p{Lu}\.\s*)+\S/u.test(String(name || '').trim());

/** the surname of a full name ("Carlos Alcaraz" → "Alcaraz"); `last` = the profile's last name when the API has it */
export function shortName(name: string | null | undefined, last?: string | null): string {
  if (last && String(last).trim()) return String(last).trim();
  const n = String(name || '').trim();
  if (!n) return 'TBD';
  const w = n.split(/\s+/);
  if (w.length === 1) return n;
  // a particle after the first name starts the surname
  const i = w.findIndex((x, k) => k > 0 && k < w.length - 1 && PARTICLE.test(x));
  if (i > 0) return w.slice(i).join(' ');
  if (w.length >= 3 && COMPOUND_SURNAMES.has(plain(w.slice(-2).join(' ')))) return w.slice(-2).join(' ');
  return w[w.length - 1];
}

/** the display name from the profile's first / last fields, else the stored name */
export function fullName(name: string | null | undefined, first?: string | null, last?: string | null): string {
  const f = String(first || '').trim(), l = String(last || '').trim();
  if (f && l) return `${f} ${l}`;
  return String(name || '').trim();
}

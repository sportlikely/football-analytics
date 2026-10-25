/**
 * fix226: Web Push without a library — VAPID (RFC 8292, an ES256 JWT) and the message encryption (RFC 8291, aes128gcm)
 * with Node's own crypto. Pure functions: the keys come in as arguments (services/pushAlerts.ts reads VAPID_PUBLIC /
 * VAPID_PRIVATE from the environment and never logs them).
 *
 * Keys are base64url: the public key = the 65-byte uncompressed P-256 point (what the browser's subscribe() takes as
 * applicationServerKey), the private key = the 32-byte scalar. `npx web-push generate-vapid-keys` prints this format,
 * and so does generateVapidKeys() below.
 */
import crypto from 'crypto';

export const b64u = (b: Buffer) => b.toString('base64url');
export const fromB64u = (s: string) => Buffer.from(String(s).replace(/=+$/, ''), 'base64url');

/** A new key pair in the VAPID format (the admin runs this once; the values go into Railway variables). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

/** True when the pair is a usable P-256 key pair (the private key gives the public one). */
export function vapidKeysValid(publicKey: string, privateKey: string): boolean {
  try {
    const pub = fromB64u(publicKey), priv = fromB64u(privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    const e = crypto.createECDH('prime256v1');
    e.setPrivateKey(priv);
    return e.getPublicKey().equals(pub);
  } catch { return false; }
}

function signingKey(publicKey: string, privateKey: string): crypto.KeyObject {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(fromB64u(privateKey)) },
    format: 'jwk'
  });
}

/** The Authorization header for one push service (aud = the endpoint's origin), valid 12 hours. */
export function vapidAuth(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: signingKey(keys.publicKey, keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/**
 * The encrypted body for one subscription (RFC 8291 + RFC 8188, one record): salt(16) | rs(4) | idlen(1) | our
 * public key(65) | AES-128-GCM(payload | 0x02).
 */
export function encryptPayload(payload: string | Buffer, sub: { p256dh: string; auth: string }, rnd: { salt?: Buffer; ecdh?: crypto.ECDH } = {}): Buffer {
  const uaPublic = fromB64u(sub.p256dh), authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = rnd.ecdh || crypto.createECDH('prime256v1');
  if (!rnd.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = rnd.salt || crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, data]);
}

/** The receiving side (tests only: what a browser does with the body). */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), data = body.subarray(21 + idlen);
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(uaPrivate);
  const shared = e.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

/**
 * Only real push services get our requests (a stored endpoint is a URL the browser gave us: never an address of
 * our own network). Chrome / Edge / Opera (FCM), Firefox, Safari / iOS, Windows.
 */
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/i;
export function pushEndpointOk(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.test(u.hostname);
  } catch { return false; }
}

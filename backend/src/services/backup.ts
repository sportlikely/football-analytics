/**
 * Daily database backups (Oct 2026).
 *
 * - Every day at BACKUP_HOUR_UTC (default 02:40 UTC), and at start-up when the last good backup is older than 26 h,
 *   the whole SQLite database is copied with `VACUUM INTO` (a consistent snapshot while the site keeps running),
 *   gzipped, and kept on the Railway volume (the last BACKUP_LOCAL_KEEP copies, default 3) for a quick restore.
 * - Off-site copy: when BACKUP_S3_* is set (Cloudflare R2 or any S3-compatible storage), the backup is ENCRYPTED with
 *   BACKUP_KEY (AES-256-GCM) and uploaded; copies older than BACKUP_KEEP_DAYS (default 30) are deleted there.
 *   No off-site upload without BACKUP_KEY: the database holds emails and password hashes.
 *   Decrypt a downloaded copy with:  node scripts/decrypt-backup.js <file.sqlite.gz.enc>  (BACKUP_KEY in the env)
 * - A failed backup emails the admin. The Users page (Overview) shows the status, the copies and "Back up now".
 *
 * Env: BACKUP_S3_ENDPOINT (e.g. https://<account-id>.r2.cloudflarestorage.com), BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID,
 *      BACKUP_S3_SECRET, BACKUP_S3_REGION (default 'auto'), BACKUP_KEY (never change or lose it — old copies need it).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import https from 'https';
import crypto from 'crypto';
import os from 'os';
import { pipeline } from 'stream/promises';
import { once } from 'events';
import { Worker } from 'worker_threads';
import { db } from '../db';
import logger from '../utils/logger';
import { sendAdminMail, adminUrl } from './adminMail';
import { after } from './perf';
import { longRead } from './longReads';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LOCAL_KEEP = Math.max(1, parseInt(process.env.BACKUP_LOCAL_KEEP || '3', 10));
const KEEP_DAYS = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10));
const HOUR = Math.min(23, Math.max(0, parseInt(process.env.BACKUP_HOUR_UTC || '2', 10)));
const MINUTE = 40;

db.exec(`CREATE TABLE IF NOT EXISTS backup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ok INTEGER NOT NULL, trigger TEXT, file TEXT,
  db_bytes INTEGER, gz_bytes INTEGER, ms INTEGER, remote TEXT, error TEXT
)`);

/* ---------- off-site storage (S3 API, signature v4, no extra packages) ---------- */

const S3 = {
  endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  keyId: process.env.BACKUP_S3_KEY_ID || '',
  secret: process.env.BACKUP_S3_SECRET || '',
  region: process.env.BACKUP_S3_REGION || 'auto'
};
const KEY = process.env.BACKUP_KEY ? crypto.createHash('sha256').update(process.env.BACKUP_KEY).digest() : null;
export const remoteConfigured = () => !!(S3.endpoint && S3.bucket && S3.keyId && S3.secret);
export const remoteReady = () => remoteConfigured() && !!KEY;

const hmac = (k: Buffer | string, s: string) => crypto.createHmac('sha256', k).update(s).digest();
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function s3Request(method: string, key: string, query: Record<string, string>, body?: { file: string; size: number }): Promise<{ status: number; text: string }> {
  const url = new URL(S3.endpoint);
  const canonPath = `/${enc(S3.bucket)}${key ? '/' + key.split('/').map(enc).join('/') : ''}`;
  const qs = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const amz = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amz.slice(0, 8);
  const payload = body ? 'UNSIGNED-PAYLOAD' : sha('');
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payload, 'x-amz-date': amz };
  if (body) { headers['content-length'] = String(body.size); headers['content-type'] = 'application/octet-stream'; }
  const signed = Object.keys(headers).sort();
  const canon = [method, canonPath, qs, signed.map(h => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payload].join('\n');
  const scope = `${day}/${S3.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const kSig = hmac(hmac(hmac(hmac('AWS4' + S3.secret, day), S3.region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${S3.keyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${hmac(kSig, toSign).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ method, host: url.hostname, port: url.port || 443, path: canonPath + (qs ? `?${qs}` : ''), headers, timeout: 10 * 60000 }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('storage timeout')));
    req.on('error', reject);
    if (body) fs.createReadStream(body.file).on('error', reject).pipe(req);
    else req.end();
  });
}

/** Encrypted copy: "SLBK1" + 12-byte IV + AES-256-GCM ciphertext + 16-byte tag. */
async function encryptFile(src: string, dst: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY!, iv);
  const out = fs.createWriteStream(dst);
  try {
    out.write(Buffer.concat([Buffer.from('SLBK1'), iv]));
    const input = fs.createReadStream(src);
    input.on('error', e => c.destroy(e));
    input.pipe(c);
    for await (const chunk of c) if (!out.write(chunk)) await once(out, 'drain');
    out.end(c.getAuthTag());
    await once(out, 'finish');
  } catch (e) { out.destroy(); throw e; }
}

async function upload(file: string, name: string) {
  const tmp = file + '.enc';
  try {
    await encryptFile(file, tmp);
    const size = fs.statSync(tmp).size;
    const r = await s3Request('PUT', `db/${name}.enc`, {}, { file: tmp, size });
    if (r.status < 200 || r.status >= 300) throw new Error(`storage answered ${r.status}: ${r.text.slice(0, 200)}`);
    return size;
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Off-site copies (newest first). */
export async function remoteList(): Promise<{ key: string; size: number; at: string }[]> {
  const out: { key: string; size: number; at: string }[] = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const q: Record<string, string> = { 'list-type': '2', prefix: 'db/' };
    if (token) q['continuation-token'] = token;
    const r = await s3Request('GET', '', q);
    if (r.status !== 200) throw new Error(`storage list answered ${r.status}: ${r.text.slice(0, 200)}`);
    for (const m of r.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const get = (t: string) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || '';
      out.push({ key: get('Key'), size: Number(get('Size')) || 0, at: get('LastModified') });
    }
    token = (r.text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1] || '';
    if (!token) break;
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

async function pruneRemote() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const list = await remoteList();
  // never delete the newest 3, whatever their age
  for (const o of list.slice(3)) if (new Date(o.at).getTime() < cutoff) await s3Request('DELETE', o.key, {});
}

/* ---------- local copies ---------- */

const NAME_RE = /^sportlikely-\d{8}-\d{6}\.sqlite\.gz$/;
export function localList() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(n => NAME_RE.test(n))
    .map(n => { const st = fs.statSync(path.join(BACKUP_DIR, n)); return { name: n, size: st.size, at: st.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}
export const localPath = (name: string) => (NAME_RE.test(name) && fs.existsSync(path.join(BACKUP_DIR, name)) ? path.join(BACKUP_DIR, name) : null);

/* ---------- run ---------- */

let running: Promise<any> | null = null;
export const backupRunning = () => !!running;

export function runBackup(trigger: 'daily' | 'startup' | 'manual') {
  if (running) return running;
  running = doBackup(trigger).finally(() => { running = null; });
  return running;
}

/** Free / total bytes of the disk holding a folder (null when the platform can't tell). */
function diskOf(dir: string): { free: number; total: number } | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = (fs as any).statfsSync(dir);
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
  } catch { return null; }
}
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'bet-to-beat.sqlite');
function dbSize() {
  let n = 0;
  for (const f of [DB_FILE, DB_FILE + '-wal']) try { n += fs.statSync(f).size; } catch { /* none */ }
  return n;
}
const sameDisk = (a: string, b: string) => { try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return false; } };
/** Disk space picture for the admin card (and for the backup itself). */
export function diskStatus() {
  const tmp = path.join(os.tmpdir(), 'sl-backup');
  return { dbBytes: dbSize(), volume: diskOf(DATA_DIR), temp: diskOf(tmp), tempDir: tmp };
}
const GB = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

/*
 * fix159: VACUUM INTO of the ~1 GB database took 5.5 s on the main thread (17 Oct 02:40:05 UTC, "Event loop blocked
 * 5562 ms"). It now runs in a worker thread on its own read-only connection; WAL mode gives it a consistent snapshot
 * while the site keeps writing.
 */
function vacuumInto(src: string, dst: string): Promise<void> {
  const code = `
    const { workerData, parentPort } = require('worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.src, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 15000');
      db.exec("VACUUM INTO '" + workerData.dst.replace(/'/g, "''") + "'");
    } finally { db.close(); }
    parentPort.postMessage('ok');`;
  // fix273: one read snapshot for the whole copy — the WAL can't start over meanwhile (named in data health "Disk";
  // the WAL is asked to start over as soon as it ends)
  const end = longRead('backup (VACUUM INTO)');
  return new Promise<void>((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { src, dst } });
    let done = false;
    w.once('message', () => { done = true; resolve(); });
    w.once('error', e => { done = true; reject(e); });
    w.once('exit', c => { if (!done) reject(new Error(`backup worker stopped (${c})`)); });
  }).finally(end);
}

async function doBackup(trigger: string) {
  const t0 = Date.now();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `sportlikely-${stamp}.sqlite.gz`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Work where there is room for a full copy: the container's temp disk first (not the volume, which holds the live
  // database and must never fill up), the volume only when it has plenty of space left.
  const d = diskStatus();
  const need = d.dbBytes * 1.5 + 50e6;
  const tempSeparate = !sameDisk(d.tempDir, DATA_DIR);
  const work = d.temp && d.temp.free > need && tempSeparate ? d.tempDir
    : d.volume && d.volume.free > need + 500e6 ? BACKUP_DIR
    : d.temp && d.temp.free > need ? d.tempDir
    : null;
  const raw = path.join(work || d.tempDir, `tmp-${stamp}.sqlite`);
  const gzWork = path.join(work || d.tempDir, `work-${name}`);
  const gzKeep = path.join(BACKUP_DIR, name);
  let dbBytes = 0, gzBytes = 0, remote: string | null = null, local = false;
  try {
    if (!work) throw new Error(`Not enough disk space for a copy: the database is ${GB(d.dbBytes)}, the volume has ${d.volume ? GB(d.volume.free) : '?'} free, the temp disk ${d.temp ? GB(d.temp.free) : '?'}.`);
    await fs.promises.rm(raw, { force: true });
    await vacuumInto(DB_FILE, raw); // consistent snapshot in a worker thread, the live file is not touched
    dbBytes = fs.statSync(raw).size;
    await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 6 }), fs.createWriteStream(gzWork));
    gzBytes = fs.statSync(gzWork).size;
    await fs.promises.rm(raw, { force: true });
    if (remoteReady()) {
      try {
        await upload(gzWork, name);
        remote = 'uploaded';
        await pruneRemote().catch(e => logger.warn(`backup: pruning old off-site copies failed: ${e.message}`));
      } catch (e: any) {
        remote = `failed: ${e.message}`;
      }
    } else remote = remoteConfigured() ? 'skipped: BACKUP_KEY not set' : 'not set up';
    // server copy on the volume only while it keeps a safe margin (old copies are removed first)
    for (const old of localList().slice(LOCAL_KEEP - 1)) await fs.promises.rm(path.join(BACKUP_DIR, old.name), { force: true });
    const vol = diskOf(DATA_DIR);
    // fix159: async copy (copyFileSync of the 120 MB file blocked the event loop ~2 s)
    if (work === BACKUP_DIR) { await fs.promises.rename(gzWork, gzKeep); local = true; }
    else if (vol && vol.free > gzBytes + 1e9) { await fs.promises.copyFile(gzWork, gzKeep); local = true; }
    await fs.promises.rm(gzWork, { force: true });
    const ok = remote === 'uploaded' || (local && !remote.startsWith('failed'));
    const note = local ? remote : `${remote}; server copy skipped (volume nearly full)`;
    db.prepare('INSERT INTO backup_log (at, ok, trigger, file, db_bytes, gz_bytes, ms, remote, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), ok ? 1 : 0, trigger, local ? name : null, dbBytes, gzBytes, Date.now() - t0, note, ok ? null : note);
    logger.info(`backup ${name}: ${(dbBytes / 1e6).toFixed(1)} MB → ${(gzBytes / 1e6).toFixed(1)} MB gz in ${Date.now() - t0} ms, off-site ${remote}, server copy ${local}`);
    if (!ok) await alert(`The database backup did not complete: ${note}`);
    // our own "volume almost full" email (Railway's usage alerts need the Pro plan)
    const v2 = diskOf(DATA_DIR);
    if (v2 && (v2.free < 500e6 || v2.free / v2.total < 0.15))
      await alert(`The Railway volume is almost full: ${GB(v2.free)} free of ${GB(v2.total)}. The site stores everything there — make the volume bigger (volume → Settings → Live resize).`);
    return { ok, name, dbBytes, gzBytes, remote, local };
  } catch (e: any) {
    fs.rmSync(raw, { force: true });
    fs.rmSync(gzWork, { force: true });
    const msg = /full/i.test(String(e.message)) ? `${e.message} — disk: database ${GB(d.dbBytes)}, volume free ${d.volume ? GB(d.volume.free) : '?'}, temp free ${d.temp ? GB(d.temp.free) : '?'}` : String(e.message || e);
    db.prepare('INSERT INTO backup_log (at, ok, trigger, file, db_bytes, gz_bytes, ms, remote, error) VALUES (?, 0, ?, NULL, ?, NULL, ?, NULL, ?)')
      .run(new Date().toISOString(), trigger, dbBytes || null, Date.now() - t0, msg);
    logger.error(`backup failed: ${msg}`);
    await alert(`The database backup failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// fix239: a real problem → its own email in the admin template
async function alert(msg: string) {
  await sendAdminMail(/fail/i.test(msg) ? 'Site problem: the database backup failed' : 'Site problem: database / disk warning', {
    label: 'Backups', tone: 'fail',
    title: /fail/i.test(msg) ? 'The database backup failed' : 'Database / disk warning',
    what: msg.replace(/\s+$/, '').replace(/([^.])$/, '$1.'),
    todo: 'Open Admin → Site health → Database backups and press "Back up now"; if it fails again, tell Claude.',
    buttons: [{ text: 'Open backups in Admin', href: adminUrl('site') }]
  });
}

export function backupStatus() {
  const last = db.prepare('SELECT * FROM backup_log ORDER BY id DESC LIMIT 1').get() as any;
  const lastOk = db.prepare('SELECT * FROM backup_log WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as any;
  const history = db.prepare('SELECT at, ok, trigger, file, db_bytes AS dbBytes, gz_bytes AS gzBytes, ms, remote, error FROM backup_log ORDER BY id DESC LIMIT 14').all();
  const lastOkAgeH = lastOk ? (Date.now() - new Date(lastOk.at).getTime()) / 3600000 : null;
  return {
    running: backupRunning(),
    healthy: lastOkAgeH !== null && lastOkAgeH < 36,
    lastOkAt: lastOk?.at || null,
    lastError: last && !last.ok ? last.error : null,
    remote: { configured: remoteConfigured(), encrypted: !!KEY, ready: remoteReady(), keepDays: KEEP_DAYS },
    schedule: `daily at ${String(HOUR).padStart(2, '0')}:${MINUTE} UTC`,
    local: localList(),
    localKeep: LOCAL_KEEP,
    disk: diskStatus(),
    history
  };
}

/** Daily timer + catch-up at start-up. */
export function startBackups() {
  if (process.env.BACKUP_OFF === '1') { logger.info('backups off (BACKUP_OFF=1)'); return; }
  const lastOk = db.prepare('SELECT at FROM backup_log WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as any;
  if (!lastOk || Date.now() - new Date(lastOk.at).getTime() > 26 * 3600000)
    after('backup', () => runBackup('startup').catch(() => undefined), 10 * 60000).unref();
  const schedule = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR, MINUTE));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(() => { runBackup('daily').catch(() => undefined).finally(schedule); }, next.getTime() - now.getTime()).unref();
  };
  schedule();
}

/**
 * fix239: every email to the admin / staff in one look, with buttons that work from the email, and fewer of them.
 *
 *  - adminEmail(): the fix216 frame (dark header with the logo, white card, lime button), a clear title, one sentence
 *    "what happened", one sentence "what to do" (or "Fixed automatically, nothing to do"), optional rows and buttons.
 *    Light and dark mode (Gmail / Apple Mail), times in Israel time, game names linked to the game page (clean links).
 *  - Action buttons ("Swap scores", "Keep as is"): signed one-time links /admin/act/<token> — stored here with what they
 *    do, valid 72 h, admin only (the page posts the token from a signed-in admin session; a link scanner opening the URL
 *    changes nothing), every use logged in the security log. "Open in Admin" buttons are plain clean admin paths.
 *  - Fewer emails: anything fixed automatically is noted (noteAutoFix) and sent once a day in one summary at 07:00 Israel
 *    time ("Fixed automatically: 3 results (daily summary)"); a separate email only when a person must decide or the
 *    site has a real problem ("Needs you: 1 basketball result").
 * Runs in the worker (the jobs that send); the action route is under /api/admin (answered by the worker).
 */
import crypto from 'crypto';
import { db } from '../db';
import logger from '../utils/logger';
import { emailEnabled, sendMail, esc, SITE } from './email';
import { pubPath } from './slugs';
import { stepAlert, wantsEmail, alertClass, RED_MS, type AlertRow } from '../utils/alertRules';

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_email_actions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    used_at TEXT, used_by TEXT, result TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_auto_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, area TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, href TEXT, summary_day TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_auto_fixes_day ON admin_auto_fixes(summary_day);
  CREATE TABLE IF NOT EXISTS admin_summary_log (day TEXT PRIMARY KEY, sent_at TEXT NOT NULL, items INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_alert_once (key TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (key, day));
  CREATE TABLE IF NOT EXISTS admin_mail_limit (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_alert_state (id TEXT PRIMARY KEY, label TEXT NOT NULL, red_since INTEGER NOT NULL, emailed_at INTEGER, green_since INTEGER);
`);

const LIME = '#c6f432', INK = '#0b0e13', TEXT = '#111419', MUTED = '#5d6573', LINE = '#e3e6eb', SOFT = '#f3f5f7';
const TONE = { ok: '#10a35a', warn: '#d98a06', fail: '#d64545', info: '#5d6573' } as const;
export type Tone = keyof typeof TONE;
export const ACTION_TTL_MS = 72 * 3600 * 1000;
const TZ = 'Asia/Jerusalem';

export const adminTo = () => (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);

/* ---------- times and links ---------- */

/** "26 Oct, 11:58" in Israel time */
export function israelTime(t: string | number | Date, withDay = true): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const o: Intl.DateTimeFormatOptions = { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, ...(withDay ? { day: 'numeric', month: 'short' } : {}) };
  return `${new Intl.DateTimeFormat('en-GB', o).format(d)}`;
}
/** Israel date + hour now (the 07:00 summary) */
export function israelParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(now));
  const get = (t: string) => parts.find(p => p.type === t)?.value || '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}
/** a clean admin address: /admin/needs-you, /admin/data … */
export const adminUrl = (tab = 'needs-you') => `${SITE}/admin/${tab}`;
/** a site page by its old in-app path, turned into its clean slug address (/basketball/game/123 → /basketball/match/<slug>) */
export function siteUrl(p: string): string {
  let clean = p;
  try { clean = pubPath(p); } catch { /* slugs not loaded: the old path still 301s */ }
  return clean.startsWith('http') ? clean : `${SITE}${clean}`;
}

/* ---------- signed one-time action links ---------- */

type Handler = (payload: any, by: string) => { message: string; open?: string };
const handlers = new Map<string, Handler>();
/** a service registers what a kind of link does (bbResults: 'bb-result') */
export const onEmailAction = (kind: string, fn: Handler) => { handlers.set(kind, fn); };

let KEY: Buffer | null = null;
function key(): Buffer {
  if (KEY) return KEY;
  db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  let row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'admin_action_key'`).get() as any;
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('admin_action_key', ?)`).run(crypto.randomBytes(32).toString('hex'));
    row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'admin_action_key'`).get();
  }
  return (KEY = Buffer.from(row.value, 'hex'));
}
const sig = (id: string) => crypto.createHmac('sha256', key()).update(`admin-action:${id}`).digest('base64url').slice(0, 22);

/** A one-time link that does `kind` with `payload` once an admin opens it (valid 72 h). */
export function actionLink(kind: string, payload: unknown, label: string, now = Date.now()): string {
  const id = crypto.randomBytes(12).toString('base64url');
  db.prepare(`INSERT INTO admin_email_actions (id, kind, payload, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, kind, JSON.stringify(payload ?? null), label.slice(0, 120), new Date(now).toISOString(), new Date(now + ACTION_TTL_MS).toISOString());
  return `${SITE}/admin/act/${id}.${sig(id)}`;
}

export interface ActionInfo { state: 'ready' | 'used' | 'expired' | 'invalid'; label?: string; usedAt?: string; usedBy?: string; result?: string; expiresAt?: string }
function lookup(token: unknown, now: number): { row: any | null; info: ActionInfo } {
  const m = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/.exec(String(token ?? ''));
  if (!m) return { row: null, info: { state: 'invalid' } };
  const a = Buffer.from(sig(m[1])), b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { row: null, info: { state: 'invalid' } };
  const row = db.prepare(`SELECT * FROM admin_email_actions WHERE id = ?`).get(m[1]) as any;
  if (!row) return { row: null, info: { state: 'invalid' } };
  const base = { label: row.label, expiresAt: row.expires_at };
  if (row.used_at) return { row, info: { ...base, state: 'used', usedAt: row.used_at, usedBy: row.used_by, result: row.result } };
  if (Date.parse(row.expires_at) <= now) return { row, info: { ...base, state: 'expired' } };
  return { row, info: { ...base, state: 'ready' } };
}
/** what a link would do (the page shows it before / after) */
export const actionInfo = (token: unknown, now = Date.now()) => lookup(token, now).info;

/** Run a link once. The caller (app.ts) has checked the admin session and writes the security-log line. */
export function runAction(token: unknown, by: string, now = Date.now()): ActionInfo & { message?: string; open?: string; payloadGame?: number | null } {
  const { row, info } = lookup(token, now);
  if (!row || info.state !== 'ready') return info;
  const fn = handlers.get(row.kind);
  if (!fn) return { ...info, state: 'invalid' };
  // claim it first: a second click (or a second tab) can never run it twice
  const claimed = db.prepare(`UPDATE admin_email_actions SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL`).run(new Date(now).toISOString(), by, row.id);
  if (!claimed.changes) return lookup(token, now).info;
  let out: { message: string; open?: string };
  try { out = fn(JSON.parse(row.payload), by); }
  catch (e: any) { out = { message: `Could not do it: ${e?.message || e}` }; }
  db.prepare(`UPDATE admin_email_actions SET result = ? WHERE id = ?`).run(out.message.slice(0, 300), row.id);
  // old links are kept 30 days after they expire (the page can still say "already used by …")
  db.prepare(`DELETE FROM admin_email_actions WHERE expires_at < ?`).run(new Date(now - 30 * 86400000).toISOString());
  const payload = (() => { try { return JSON.parse(row.payload); } catch { return null; } })();
  return { ...info, state: 'used', usedAt: new Date(now).toISOString(), usedBy: by, result: out.message, message: out.message, open: out.open, payloadGame: row.kind === 'bb-result' ? payload?.game ?? null : null };
}

/* ---------- the template ---------- */

export interface Btn { text: string; href: string; kind?: 'primary' | 'secondary' }
export interface MailRow { title: string; titleHref?: string | null; detail?: string; when?: string | null; buttons?: Btn[]; tone?: Tone }
export interface AdminMail {
  /** short tag top right: "Basketball results", "Model report" … */
  label: string;
  title: string;
  /** one sentence: what happened */
  what: string;
  /** one sentence: what to do — null = "Fixed automatically, nothing to do." */
  todo: string | null;
  tone?: Tone;
  rows?: MailRow[];
  /** a block of pre-formatted text (the model report) */
  pre?: string;
  buttons?: Btn[];
  footer?: string;
}
export const NOTHING_TO_DO = 'Fixed automatically, nothing to do.';

const button = (b: Btn) => b.kind === 'secondary'
  ? `<a href="${esc(b.href)}" class="sl-btn2" style="display:inline-block;background:#ffffff;color:${TEXT};border:1px solid ${LINE};font-weight:700;font-size:13px;text-decoration:none;padding:9px 14px;border-radius:10px;margin:4px 6px 0 0">${esc(b.text)}</a>`
  : `<a href="${esc(b.href)}" style="display:inline-block;background:${LIME};color:${INK};border:1px solid ${LIME};font-weight:800;font-size:13px;text-decoration:none;padding:9px 14px;border-radius:10px;margin:4px 6px 0 0">${esc(b.text)}</a>`;

export function renderAdminMail(m: AdminMail): { html: string; text: string } {
  const tone = TONE[m.tone || (m.todo ? 'warn' : 'ok')];
  const todo = m.todo ?? NOTHING_TO_DO;
  const rows = (m.rows || []).map(r => `<tr><td class="sl-row" style="padding:12px 24px;border-top:1px solid ${LINE}">
      ${r.when ? `<div class="sl-muted" style="font-size:12px;color:${MUTED};margin-bottom:3px">${esc(r.when)}</div>` : ''}
      <div class="sl-text" style="font-size:15px;font-weight:700;color:${TEXT}">${r.tone ? `<span style="color:${TONE[r.tone]}">●</span>&nbsp;` : ''}${r.titleHref ? `<a href="${esc(r.titleHref)}" class="sl-text" style="color:${TEXT};text-decoration:underline">${esc(r.title)}</a>` : esc(r.title)}</div>
      ${r.detail ? `<div class="sl-muted" style="font-size:13px;line-height:1.5;color:${MUTED};margin-top:3px">${esc(r.detail)}</div>` : ''}
      ${r.buttons?.length ? `<div style="margin-top:6px">${r.buttons.map(button).join('')}</div>` : ''}
    </td></tr>`).join('');
  const pre = m.pre ? `<tr><td class="sl-row" style="padding:12px 24px;border-top:1px solid ${LINE}"><pre class="sl-text" style="margin:0;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;color:${TEXT}">${esc(m.pre)}</pre></td></tr>` : '';
  const btns = m.buttons?.length ? `<tr><td class="sl-row" style="padding:16px 24px 24px;border-top:1px solid ${LINE}">${m.buttons.map(button).join('')}</td></tr>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(m.title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .sl-bg { background:#0b0e13 !important } .sl-card { background:#151a21 !important; border-color:#262d37 !important }
  .sl-text { color:#e8eaee !important } .sl-muted { color:#9aa1ad !important } .sl-row { border-color:#262d37 !important }
  .sl-btn2 { background:#151a21 !important; color:#e8eaee !important; border-color:#3a4350 !important }
}
@media (max-width: 620px) { .sl-row { padding-left:16px !important; padding-right:16px !important } }
</style></head>
<body class="sl-bg" style="margin:0;padding:0;background:${SOFT};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${TEXT};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`${m.what} ${todo}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="sl-bg" style="background:${SOFT}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="sl-card" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
  <tr><td style="background:${INK};padding:18px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><a href="${esc(adminUrl())}" style="text-decoration:none"><img src="${SITE}/logo-mark.png" width="26" height="26" alt="" style="vertical-align:middle;border:0;border-radius:6px">
        <span style="vertical-align:middle;font-weight:800;font-size:19px;color:#ffffff;margin-left:6px">Sport<span style="color:${LIME}">Likely</span></span></a></td>
      <td align="right" style="font-size:12px;font-weight:700;color:${LIME}">${esc(m.label)}</td>
    </tr></table>
  </td></tr>
  <tr><td class="sl-row" style="padding:22px 24px 6px;border-left:4px solid ${tone}">
    <h1 class="sl-text" style="margin:0 0 10px;font-size:20px;line-height:1.3;color:${TEXT}">${esc(m.title)}</h1>
    <p class="sl-text" style="margin:0 0 8px;font-size:15px;line-height:1.55;color:${TEXT}">${esc(m.what)}</p>
    <p class="sl-text" style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${TEXT}"><b>${m.todo ? 'What to do: ' : ''}</b>${esc(todo)}</p>
  </td></tr>
  ${rows}${pre}${btns}
</table>
<p class="sl-muted" style="max-width:560px;font-size:11px;line-height:1.55;color:${MUTED};margin:16px auto 0;text-align:left">
  ${m.footer ? `${esc(m.footer)}<br>` : ''}Times are Israel time. Buttons that change something work once, for 72 hours, from a signed-in admin account.<br>
  SportLikely admin · <a href="${esc(adminUrl())}" style="color:${MUTED}">Open Admin</a>
</p>
</td></tr></table></body></html>`;
  const text = [
    m.title, '', m.what, m.todo ? `What to do: ${todo}` : todo, '',
    ...(m.rows || []).flatMap(r => [`- ${r.when ? `${r.when} · ` : ''}${r.title}${r.titleHref ? ` (${r.titleHref})` : ''}`, ...(r.detail ? [`  ${r.detail}`] : []), ...(r.buttons || []).map(b => `  ${b.text}: ${b.href}`)]),
    ...(m.pre ? ['', m.pre] : []),
    ...(m.buttons?.length ? ['', ...m.buttons.map(b => `${b.text}: ${b.href}`)] : []),
    '', '—', ...(m.footer ? [m.footer] : []), 'Times are Israel time. SportLikely admin: ' + adminUrl()
  ].join('\n');
  return { html, text };
}

/** Send to every address in ADMIN_EMAILS (no-op without email). Never throws. */
export async function sendAdminMail(subject: string, m: AdminMail): Promise<boolean> {
  const to = adminTo();
  if (!emailEnabled || !to.length) return false;
  const { html, text } = renderAdminMail(m);
  let ok = false;
  for (const addr of to) {
    try { await sendMail({ to: addr, subject, html, text }); ok = true; }
    catch (e: any) { logger.warn(`admin email "${subject}": ${e?.message || e}`); }
  }
  return ok;
}

/** A real problem that can repeat every few minutes (push / email delivery): one email per kind and Israel day. */
export async function alertOncePerDay(key: string, subject: string, m: AdminMail, now = Date.now()): Promise<boolean> {
  const day = israelParts(now).day;
  try {
    const r = db.prepare(`INSERT OR IGNORE INTO admin_alert_once (key, day, at) VALUES (?, ?, ?)`).run(key, day, new Date(now).toISOString());
    if (!r.changes) return false;
  } catch { return false; }
  return sendAdminMail(subject, m);
}

/* ---------- fix279: limits that survive a restart ---------- */

/**
 * true (and the clock restarts) when nothing under `key` was sent in the last `gapMs`; false otherwise. Stored in the
 * database, so a deploy never resets it (the 6-hour data-alert clock lived in memory: every deploy could send again).
 */
export function limitOk(key: string, gapMs: number, now = Date.now()): boolean {
  try {
    const r = db.prepare(`INSERT INTO admin_mail_limit (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at WHERE admin_mail_limit.at <= ?`)
      .run(key, now, now - gapMs);
    return r.changes > 0;
  } catch { return false; }
}
/** when `key` was last sent (null = never) */
export function limitAt(key: string): number | null {
  try { return (db.prepare(`SELECT at FROM admin_mail_limit WHERE key = ?`).get(key) as any)?.at ?? null; } catch { return null; }
}

/* ---------- fix279: one email per problem (data health) ---------- */

const rowOf = (r: any): AlertRow => ({ id: r.id, label: r.label, redSince: r.red_since, emailedAt: r.emailed_at ?? null, greenSince: r.green_since ?? null });
export function alertRows(): AlertRow[] {
  try { return (db.prepare(`SELECT * FROM admin_alert_state`).all() as any[]).map(rowOf); } catch { return []; }
}

/**
 * Every run of the checks: each check's stored state moves on (red since / emailed / green since) and the checks this
 * run may email come back (a feed red for 2 h+, a failed deploy or a disk filling within 3 days, red for 30 min+, not
 * emailed yet for this problem). The caller sends them and calls markEmailed.
 */
export function trackAlerts<C extends { id: string; label: string; level: string; detail?: string; items?: string[] }>(checks: C[], now = Date.now()): C[] {
  const prev = new Map(alertRows().map(r => [r.id, r]));
  const due: C[] = [];
  const put = db.prepare(`INSERT OR REPLACE INTO admin_alert_state (id, label, red_since, emailed_at, green_since) VALUES (?, ?, ?, ?, ?)`);
  const del = db.prepare(`DELETE FROM admin_alert_state WHERE id = ?`);
  const seen = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const p = prev.get(c.id) || null;
    const next = stepAlert(p, c, now);
    if (!next) { if (p) del.run(c.id); continue; }
    if (!p || p.label !== next.label || p.redSince !== next.redSince || p.emailedAt !== next.emailedAt || p.greenSince !== next.greenSince)
      put.run(next.id, next.label, next.redSince, next.emailedAt, next.greenSince);
    if (wantsEmail(next, c, now)) due.push(c);
  }
  return due;
}
export function markEmailed(ids: string[], now = Date.now()) {
  const up = db.prepare(`UPDATE admin_alert_state SET emailed_at = ? WHERE id = ?`);
  for (const id of ids) up.run(now, id);
}
/** red right now: emailed ones ("still red since") and the quiet ones (For Claude), red for 30 min+ */
export function redNow(now = Date.now()) {
  const rows = alertRows().filter(r => r.greenSince == null && now - r.redSince >= RED_MS).sort((a, b) => a.redSince - b.redSince);
  return {
    stillRed: rows.filter(r => r.emailedAt != null).map(r => ({ id: r.id, label: r.label, since: new Date(r.redSince).toISOString(), emailedAt: new Date(r.emailedAt!).toISOString() })),
    forClaude: rows.filter(r => r.emailedAt == null).map(r => ({ id: r.id, label: r.label, since: new Date(r.redSince).toISOString(), quiet: alertClass(r.id) === 'quiet' }))
  };
}

/* ---------- the daily summary of what fixed itself ---------- */

/** Something fixed itself: it goes into tomorrow morning's summary instead of its own email. */
export function noteAutoFix(area: string, title: string, detail?: string | null, href?: string | null, at = new Date()) {
  try {
    db.prepare(`INSERT INTO admin_auto_fixes (at, area, title, detail, href) VALUES (?, ?, ?, ?, ?)`)
      .run(at.toISOString(), area.slice(0, 40), title.slice(0, 200), detail ? detail.slice(0, 400) : null, href || null);
  } catch (e: any) { logger.warn(`auto-fix note: ${e?.message || e}`); }
}

/** fix279: a check with nothing for a person to do: one line in the next 07:00 summary ("For Claude"), never an email */
export const noteForClaude = (title: string, detail?: string | null) => noteAutoFix('For Claude', title, detail, adminUrl('needs-you'));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** fix253: three lines per kind (in the order the kinds first happened), then "+N more" for that kind */
export function summaryRows(items: { at: string; area: string; title: string; detail: string | null; href: string | null }[], per = 3): MailRow[] {
  const by = new Map<string, typeof items>();
  for (const i of items) { const l = by.get(i.area) || []; l.push(i); by.set(i.area, l); }
  const rows: MailRow[] = [];
  for (const [area, l] of by) {
    const tone: Tone = area === 'Still red' ? 'fail' : area === 'For Claude' ? 'info' : 'ok'; // fix279
    for (const i of l.slice(0, per)) rows.push({ when: `${israelTime(i.at)} · ${area}`, title: i.title, titleHref: i.href, detail: i.detail || undefined, tone });
    if (l.length > per) rows.push({ when: area, title: `+${l.length - per} more ${area.toLowerCase()}`, titleHref: adminUrl('needs-you'), tone });
  }
  return rows;
}

/** what the summary says (also used by the test and the admin preview) */
/** fix279: summary lines that are not fixes (red checks listed once a day), not counted as fixes */
export const NOT_FIX_AREAS = new Set(['Still red', 'For Claude']);
export function buildSummary(all: { at: string; area: string; title: string; detail: string | null; href: string | null }[]): { subject: string; mail: AdminMail } {
  const items = all.filter(i => !NOT_FIX_AREAS.has(i.area));
  const other = all.length - items.length;
  const results = items.filter(i => /result/.test(i.area)).length;
  const what = !items.length ? `${plural(other, 'check')} to know about` : results === items.length ? plural(results, 'result') : results ? `${plural(results, 'result')} and ${plural(items.length - results, 'other fix', 'other fixes')}` : plural(items.length, 'fix', 'fixes');
  const head = items.length ? 'Fixed automatically' : 'Daily summary';
  return {
    subject: items.length ? `${head}: ${what} (daily summary)` : `${head}: ${what}`,
    mail: {
      label: 'Daily summary', tone: 'ok',
      title: `${head}: ${what}`,
      what: `${items.length ? `Since the last summary the site found and fixed ${plural(items.length, 'problem')} by itself` : 'Nothing needed fixing since the last summary'}${other ? `; ${plural(other, 'check')} ${other === 1 ? 'is' : 'are'} red with nothing for you to do (listed once here, never their own email)` : ''}; each one is listed below.`,
      todo: null,
      rows: summaryRows(all),
      buttons: [{ text: 'Open Done for you in Admin', href: adminUrl('needs-you') }],
      footer: 'One summary a day at 07:00: three lines per kind, the rest (with Undo) in Admin → Needs you → Done for you.'
    }
  };
}

/**
 * fix277: lines the summary always carries when they have something to say (e.g. "Swarms challenged today: …"), added
 * by the service that knows them; not stored as fixes (no Undo).
 */
type SummaryLine = { area: string; title: string; href?: string | null };
const summaryLines: (() => SummaryLine | SummaryLine[] | null)[] = [];
export const addSummaryLine = (fn: () => SummaryLine | SummaryLine[] | null) => { summaryLines.push(fn); };
// fix279: what was emailed and is still red, and the red checks with nothing to do (For Claude) — listed once a day
addSummaryLine(() => {
  const r = redNow();
  return [
    ...r.stillRed.map(x => ({ area: 'Still red', title: `${x.label}: still red since ${israelTime(x.since)} (emailed ${israelTime(x.emailedAt)})`, href: adminUrl('needs-you') })),
    ...r.forClaude.map(x => ({ area: 'For Claude', title: `${x.label}: red since ${israelTime(x.since)}`, href: adminUrl('needs-you') }))
  ];
});

/** 07:00 Israel time (checked every 5 minutes): one email with everything that fixed itself since the last one. */
export async function dailySummaryTick(now = Date.now()): Promise<{ sent: boolean; items: number } | null> {
  const p = israelParts(now);
  if (p.hour < 7) return null;
  if (db.prepare(`SELECT 1 FROM admin_summary_log WHERE day = ?`).get(p.day)) return null;
  const items = db.prepare(`SELECT id, at, area, title, detail, href FROM admin_auto_fixes WHERE summary_day IS NULL ORDER BY at`).all() as any[];
  db.prepare(`INSERT OR IGNORE INTO admin_summary_log (day, sent_at, items) VALUES (?, ?, ?)`).run(p.day, new Date(now).toISOString(), items.length);
  const extra = summaryLines.flatMap(f => { try { return f() ?? []; } catch { return []; } })
    .map(x => ({ at: new Date(now).toISOString(), area: x.area, title: x.title, detail: null, href: x.href || null }));
  if (!items.length && !extra.length) return { sent: false, items: 0 };
  const { subject, mail } = buildSummary([...items, ...extra]);
  const sent = await sendAdminMail(subject, mail);
  if (items.length) db.prepare(`UPDATE admin_auto_fixes SET summary_day = ? WHERE summary_day IS NULL AND id <= ?`).run(p.day, items[items.length - 1].id);
  db.prepare(`DELETE FROM admin_auto_fixes WHERE at < ?`).run(new Date(now - 90 * 86400000).toISOString());
  logger.info(`admin daily summary: ${items.length} automatic fix(es)${sent ? ' emailed' : ''}`);
  return { sent, items: items.length };
}

/**
 * fix259: "Copy for Claude to fix" — the plain-English text an admin pastes into a Claude session. Pure (no database):
 * services/forClaude.ts gathers the item(s) and their context, this file writes the text, hides anything secret and
 * keeps it under 12 KB. Tested by scripts/fix259.test.ts.
 *
 * Format:
 *   SportLikely · <page / card> · <Israel time> · build <index hash> · main <commit short>
 *   (blank line, then one block per section: "## title", its lines)
 *   Related fixes: fixNNN, …
 */

export const FOR_CLAUDE_MAX = 12 * 1024;
export type Level = 'ok' | 'warn' | 'fail';
export interface Section { title: string; lines: string[] }
export interface CheckLike { id: string; label: string; level: Level; detail: string; items?: string[] }
export interface HistPoint { at: string; level: Level; detail: string }

const LEVEL_WORD: Record<Level, string> = { ok: 'green (OK)', warn: 'yellow (look)', fail: 'red (problem)' };
export const levelWord = (l: string) => LEVEL_WORD[l as Level] || l;

/** "28 Oct 14:05" in Israel time (the admin's clock) */
export function ilTime(t: string | number | Date): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

export function header(o: { place: string; at: number | Date | string; build: string | null; commit: string | null }): string {
  return `SportLikely · ${o.place} · ${ilTime(o.at)} Israel time · build ${o.build || 'unknown'} · main ${o.commit ? o.commit.slice(0, 7) : 'unknown'}`;
}

/* ---------------- secrets ---------------- */

/** a card number passes the Luhn check (so long counts and timestamps stay readable) */
function luhn(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) { let x = +d[d.length - 1 - i]; if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  return sum % 10 === 0;
}

const SECRET_NAME = /(api[_-]?key|apikey|access[_-]?key|secret|token|passw(?:or)?d|pwd|authori[sz]ation|cookie|session[_-]?id|totp|backup[_-]?key|vapid[_-]?private|private[_-]?key|client[_-]?secret|signature|sig)/i;

/**
 * Hides anything secret: the values of the server's secret variables (exact), "name=value" / "name: value" pairs with a
 * secret-sounding name, Bearer / Basic tokens, JWTs, long key-like strings (32+ letters and digits), email addresses,
 * card numbers, and the last part of IP addresses.
 */
export function scrubSecrets(text: string, secretValues: string[] = []): string {
  let s = text;
  for (const v of secretValues) if (v && v.length >= 8) s = s.split(v).join('[hidden]');
  s = s.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[hidden]');
  s = s.replace(new RegExp(`(["']?[A-Za-z0-9_-]*${SECRET_NAME.source}[A-Za-z0-9_-]*["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s"',;&}]+)`, 'gi'), (_m, k) => `${k}[hidden]`);
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  s = s.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[hidden]');
  s = s.replace(/\b[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9])/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[hidden]' : m));
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, m => (luhn(m.replace(/\D/g, '')) ? '[number hidden]' : m));
  s = s.replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, '$1.x');
  s = s.replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f:]{2,}\b/gi, '$1::x');
  return s;
}

/* ---------------- size ---------------- */

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const cutLine = (l: string, n: number) => (l.length > n ? `${l.slice(0, n)}… (${l.length - n} more characters)` : l);

/** Header, sections and footer in one text of at most `max` bytes; what does not fit ends with "… (N more)". */
export function assemble(head: string, sections: Section[], footer: string, opts: { max?: number; secrets?: string[] } = {}): string {
  const max = opts.max ?? FOR_CLAUDE_MAX;
  const clean = (x: string) => scrubSecrets(x, opts.secrets);
  const h = clean(head), f = clean(footer);
  let budget = max - bytes(h) - bytes(f) - 4;
  const out: string[] = [h, ''];
  const secs = sections.filter(x => x.lines.length);
  for (let si = 0; si < secs.length; si++) {
    const sec = secs[si];
    const title = clean(`## ${sec.title}`);
    if (bytes(title) + 1 + 24 > budget) { out.push(`… (${secs.length - si} more section${secs.length - si === 1 ? '' : 's'})`); budget = 0; break; }
    out.push(title); budget -= bytes(title) + 1;
    for (let i = 0; i < sec.lines.length; i++) {
      const line = clean(cutLine(sec.lines[i], 1500));
      const rest = sec.lines.length - i;
      if (bytes(line) + 1 + 24 > budget) { out.push(`… (${rest} more)`); budget -= 16; break; }
      out.push(line); budget -= bytes(line) + 1;
    }
    out.push(''); budget -= 1;
  }
  out.push(f);
  let text = out.join('\n');
  while (bytes(text) > max) text = text.slice(0, -64); // safety net; the budget above keeps it from happening
  return text;
}

/* ---------------- the item types ---------------- */

/** a data-health check: id, label, level, the full detail and every item, the last 3 values, when measured */
export function checkSection(c: CheckLike, o: { measuredAt?: string | null; history?: HistPoint[]; plain?: { title?: string; what?: string; todo?: string } | null } = {}): Section {
  const lines = [
    `Check id: ${c.id}`,
    `Label: ${c.label}${o.plain?.title && o.plain.title !== c.label ? ` (shown as "${o.plain.title}")` : ''}`,
    `Level: ${levelWord(c.level)}`,
    `Detail: ${c.detail}`,
    ...(o.measuredAt ? [`Measured: ${ilTime(o.measuredAt)} Israel time (${o.measuredAt})`] : []),
    ...(o.plain?.what ? [`What this check is: ${o.plain.what}`] : []),
    ...(c.items?.length ? [`Items (${c.items.length}):`, ...c.items.map(x => `- ${x}`)] : [])
  ];
  if (o.history?.length) {
    lines.push('Last values (newest first):');
    for (const p of o.history.slice(0, 3)) lines.push(`- ${ilTime(p.at)}: ${levelWord(p.level)} — ${p.detail}`);
  }
  return { title: `Check: ${o.plain?.title || c.label}`, lines };
}

export interface SiteErrorLike { message: string; pageKind: string; pages?: string[]; where?: string | null; builds?: string[]; browsers?: string[]; count: number; firstAt: string; lastAt: string; resolvedAt?: string | null }
/** site errors: the newest groups (message, page, where, build, browser family, time) and the stored stack */
export function siteErrorSection(rows: SiteErrorLike[], title = 'Site errors (newest first)'): Section {
  const lines: string[] = [];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.count}× "${r.message}"${r.resolvedAt ? ' (marked fixed)' : ''}`);
    lines.push(`   page ${r.pageKind}${r.pages?.length ? ` (${r.pages.slice(0, 5).join(', ')}${r.pages.length > 5 ? `, +${r.pages.length - 5} more` : ''})` : ''}`);
    lines.push(`   last ${ilTime(r.lastAt)} · first ${ilTime(r.firstAt)} Israel time · builds ${r.builds?.length ? r.builds.join(', ') : 'unknown'} · browsers ${r.browsers?.length ? r.browsers.join(', ') : 'unknown'}`);
    if (r.where) lines.push(...String(r.where).split('\n').map((l, j) => `   ${j ? '   ' : 'stack: '}${l.trim()}`));
  });
  return { title, lines };
}

export interface DeployRowLike { started_at: string; requests: number; files: number; pages: number; api: number; health: number; statuses: string; loading?: number | null; loading_late?: number | null; loading_paths?: string | null }
/** the deploys: start time, the 5xx counts by kind, the status codes and the "Loading" lists */
export function deploySection(rows: DeployRowLike[]): Section {
  return {
    title: 'Deploys (newest first: 5xx answers in the 5 minutes after each start)',
    lines: rows.map(x => `${ilTime(x.started_at)} Israel time (${x.started_at}): ${x.requests} requests — files ${x.files}, pages ${x.pages}, API ${x.api}, /health ${x.health} (expected while loading) · status codes ${x.statuses}`
      + (x.loading ? ` · lists answered "Loading" ${x.loading} (${x.loading_late || 0} after 60 s: ${x.loading_paths || '{}'})` : ''))
  };
}

const sg = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(4)}` : '–');
/** the football self-learning candidate table (Admin → Predictions & models → daily learning) */
export function candidatesSection(day: { date: string; decision?: string | null; reason?: string | null; candidates: any[] }): Section {
  const rows = [...day.candidates].sort((a, b) => (a.id === 'champion' ? -1 : b.id === 'champion' ? 1 : (a.close ?? 0) - (b.close ?? 0)));
  return {
    title: `Candidate table ${day.date}${day.decision ? ` · decision ${day.decision}` : ''}`,
    lines: [
      ...(day.reason ? [`Reason: ${day.reason}`] : []),
      'candidate | Δ log loss last 60 days | previous 60 | games | better in resamples | verdict',
      ...rows.map(c => `${c.label || c.id} (${c.id}) | ${sg(c.dW)} | ${sg(c.dWp)} | ${c.n ? `${c.n.W}/${c.n.Wp}` : '–'} | ${c.boot?.pBetter != null ? `${Math.round(c.boot.pBetter * 100)}%` : '–'} | ${c.id === 'champion' ? 'champion' : c.pass ? 'passed' : `kept out: ${c.gap || c.why || '?'}`}`)
    ]
  };
}

export interface ThreadLike {
  message: { id: number; at: string; topic: string; message: string; page?: string | null; status: string; userId: number | null }
  replies: { at: string; byName?: string | null; kind: string; body: string; sent?: boolean }[]
  account?: { id: number; plan: string; premiumUntil?: string | null; createdAt?: string; lastLoginAt?: string | null; cancelAt?: string | null } | null
  others?: { id: number; at: string; topic: string; status: string }[]
}
/** a CRM support message and its thread — the customer by id, never their email or name */
export function crmThreadSection(t: ThreadLike): Section {
  const who = t.message.userId ? `customer #${t.message.userId}` : 'a visitor without an account';
  const lines = [
    `Message #${t.message.id} from ${who} · ${ilTime(t.message.at)} Israel time · topic ${t.message.topic} · status ${t.message.status}${t.message.page ? ` · sent from ${t.message.page}` : ''}`,
    ...String(t.message.message).split('\n').map(l => `> ${l}`)
  ];
  if (t.account) lines.push(`Account #${t.account.id}: plan ${t.account.plan}${t.account.premiumUntil ? ` until ${t.account.premiumUntil.slice(0, 10)}` : ''}${t.account.cancelAt ? ` · cancels ${t.account.cancelAt.slice(0, 10)}` : ''} · joined ${String(t.account.createdAt || '').slice(0, 10)} · last sign-in ${t.account.lastLoginAt ? ilTime(t.account.lastLoginAt) : 'never'}`);
  for (const r of t.replies) {
    lines.push(`${r.kind === 'note' ? 'Internal note' : 'Reply'} by ${r.byName || 'staff'} · ${ilTime(r.at)}${r.kind === 'reply' && r.sent === false ? ' (not sent)' : ''}:`);
    lines.push(...String(r.body).split('\n').map(l => `> ${l}`));
  }
  if (t.others?.length) lines.push(`Other messages from the same person: ${t.others.map(o => `#${o.id} ${o.topic} (${o.status}, ${String(o.at).slice(0, 10)})`).join(', ')}`);
  return { title: `Support message #${t.message.id}`, lines };
}

/** a customer profile (CRM) — by id, no email, no name, no addresses */
export function customerSection(p: any): Section {
  return {
    title: `Customer #${p.id}`,
    lines: [
      `Plan ${p.plan}${p.premiumUntil ? ` until ${String(p.premiumUntil).slice(0, 10)}` : ''}${p.cancelAt ? ` · cancels ${String(p.cancelAt).slice(0, 10)}` : ''} · role ${p.role || 'none'}`,
      `Joined ${String(p.createdAt || '').slice(0, 10)} · last sign-in ${p.lastLoginAt ? ilTime(p.lastLoginAt) : 'never'} · email confirmed ${p.emailVerified ? 'yes' : 'no'} · two-step ${p.twoFactor ? 'on' : 'off'} · devices signed in ${p.devices}`,
      `Unlocks this month ${p.unlocksThisMonth} · favourites ${p.favorites}`,
      ...(p.planHistory || []).slice(0, 10).map((h: any) => `Plan change ${String(h.at).slice(0, 16)}: ${h.fromPlan || '?'} → ${h.toPlan || '?'}${h.until ? ` until ${String(h.until).slice(0, 10)}` : ''} (${h.source || '?'})`),
      ...(p.messages || []).slice(0, 10).map((m: any) => `Message #${m.id} ${String(m.at).slice(0, 10)} · ${m.topic} · ${m.status}`),
      ...(p.security || []).slice(0, 10).map((s: any) => `Security ${ilTime(s.at)}: ${s.event}${s.ip ? ` from ${s.ip}` : ''}`)
    ]
  };
}

const short = (x: unknown, n = 220) => { const s = typeof x === 'string' ? x : JSON.stringify(x); return s && s.length > n ? `${s.slice(0, n)}…` : s ?? ''; };
const stallLine = (s: any) => `${s.at ? ilTime(s.at) : '?'} · ${s.ms} ms · ${short(s.job || 'no job named', 200)}${Array.isArray(s.cpu) ? ` · code: ${s.cpu.slice(0, 3).join('; ')}` : s?.cpu?.top ? ` · code: ${s.cpu.top.slice(0, 3).map((f: any) => `${f.fn} ${f.at} ${f.ms} ms`).join('; ')}` : ''}`;
/** the /api/perf summary lines about speed: freezes, profiled freezes (diagStalls), short blocks, slow requests, slowest reads */
export function perfSection(perf: any): Section {
  const p = perf?.data ?? perf ?? {};
  const web = p.web || {}, w = p.worker || {};
  const lines: string[] = [
    `Website: ${web.stallsLastHour ?? '–'} freezes in the last hour, worst ${web.worstLastHour ?? '–'} ms, up ${web.uptimeMin ?? '–'} min, memory ${web.memoryMb ?? '–'} MB`,
    `Background (worker): ${w.stallsLastHour ?? '–'} freezes, worst ${w.worstLastHour ?? '–'} ms, heap ${w.heapMb ?? '–'} of ${w.heapLimitMb ?? '–'} MB, restarts 24 h ${w.restarts24h ?? w.restarts ?? '–'}${w.lastExit ? ` · last exit: ${short(w.lastExit.reason, 160)}` : ''}`
  ];
  const list = (title: string, xs: any[] | undefined, n: number, f: (x: any) => string) => { if (xs?.length) lines.push(`${title}:`, ...xs.slice(0, n).map(x => `- ${f(x)}`)); };
  // fix274: every web stall since the process was ready (the last 50, newest first): time, length, what ran, the code
  if (web.stallsSinceReady != null) lines.push(`Website since ready: ${web.stallsSinceReady} stall(s) over 500 ms, ${web.slowSinceReady ?? '–'} request(s) over 500 ms`);
  list('Recent web stalls (since ready, newest first)', web.readyStalls, 50, s => `${s.at ? ilTime(s.at) : '?'} · ${s.ms} ms${s.admin ? ' (admin)' : s.counted ? '' : ' (under 500 ms)'} · ${short(s.running || 'nothing named', 160)}${s.code?.length ? ` · code: ${s.code.slice(0, 3).join('; ')}` : ''}`);
  list('Website worst freezes (last hour)', web.topStalls, 5, stallLine);
  list('Website freezes with the code that ran (diagStalls)', web.diagStalls, 5, stallLine);
  list('Website short blocks (shortBlocks)', web.shortBlocks, 5, stallLine);
  list('Slow requests', p.slowRequests?.rows ?? p.slowRequests?.last ?? (Array.isArray(p.slowRequests) ? p.slowRequests : undefined), 8, x => short(x));
  const reader = p.pageReader;
  if (reader) list('Slowest reads', reader.slowest ?? reader.slow ?? reader.top, 6, x => short(x));
  list('Background worst freezes', w.topStalls, 5, stallLine);
  return { title: 'Speed (from /api/perf)', lines };
}

/** what the card showed (its text as on the screen) */
export function shownSection(title: string, text: string): Section {
  const lines = text.split('\n').map(l => l.trimEnd()).filter((l, i, a) => l.trim() && !(i && a[i - 1] === l));
  return { title: `${title} — as shown on the page`, lines };
}

/* ---------------- related fixes ---------------- */

/**
 * The fix numbers the docs/notes name next to this item (within 300 characters of a mention of one of the keys: a check
 * id in `backticks` or "quotes", or a distinctive id / label / title of 8+ characters), newest fix first, at most 10.
 */
export function relatedFixes(notes: { file: string; text: string }[], keys: string[]): string[] {
  const k = [...new Set(keys.filter(Boolean).flatMap(x => [x.trim(), x.replace(/\s*\(.*\)\s*$/, '').trim()]))];
  const plain = k.filter(x => x.length >= 8 && !/^[a-z]+$/.test(x)).map(x => x.toLowerCase());
  const quoted = k.map(x => x.replace(/[:-]$/, '')).filter(x => x.length >= 3);
  const found = new Set<string>();
  for (const n of notes) {
    for (const line of n.text.split('\n')) {
      // where the item is named (a long notes paragraph names many fixes: only those within 300 characters count)
      const low = line.toLowerCase();
      const at: number[] = [];
      for (const x of plain) for (let i = low.indexOf(x); i >= 0; i = low.indexOf(x, i + 1)) at.push(i);
      for (const x of quoted) for (const q of [`\`${x}`, `"${x}"`, `“${x}”`]) for (let i = line.indexOf(q); i >= 0; i = line.indexOf(q, i + 1)) at.push(i);
      if (!at.length) continue;
      for (const m of line.matchAll(/\bfix(\d{2,3}[a-z]?)\b/g)) if (at.some(i => Math.abs(i - m.index!) <= 300)) found.add(`fix${m[1]}`);
    }
  }
  return [...found].sort((a, b) => parseInt(b.slice(3), 10) - parseInt(a.slice(3), 10) || b.localeCompare(a)).slice(0, 10);
}

export const footerLine = (fixes: string[]) => `Related fixes: ${fixes.length ? fixes.join(', ') : 'none named in docs/notes'}`;

/** speed checks get the /api/perf lines */
export const isSpeedCheck = (id: string) => /^perf:|stall|slow|speed|freeze|memory|heap/i.test(id);

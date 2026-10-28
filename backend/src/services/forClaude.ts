/**
 * fix259: "Copy for Claude to fix" on every admin and CRM card. The browser sends what it shows (the card's text, the
 * check ids of the card / tab, the /api/perf summary for speed); this adds what the server knows (each check's full
 * detail and its last 3 values, the newest site errors with their stacks, the deploy rows, the model's candidate table,
 * a CRM thread by customer id) and writes the text (utils/forClaude.ts: header, secrets hidden, 12 KB at most).
 * Answered by the worker (admin / staff routes are forwarded).
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import {
  assemble, header, checkSection, siteErrorSection, deploySection, candidatesSection, crmThreadSection, customerSection,
  perfSection, shownSection, relatedFixes, footerLine, isSpeedCheck, type Section, type CheckLike
} from '../utils/forClaude';
import { storedDataHealth, dataHealthHistory } from './dataHealth';
import { clientErrorList, currentBuild } from './clientErrors';
import { modelDailyLog } from './modelDaily';
import { auditForClaude } from './dataAudit';
import { inboxThread, customerProfile, type Viewer } from './crm';

export interface ForClaudeBody {
  /** the page / card name for the header ("Admin → Site health → Speed") */
  place?: string
  /** check: one data-health check · card: one card · tab: everything red / yellow of a tab · item: one row · site-error · crm-message · crm-customer */
  scope?: string
  /** data-health checks with the page's plain title / explanation (lib/adminTabs.ts) */
  checks?: { id: string; title?: string; what?: string; todo?: string }[]
  /** the cards (id, title, the text the page shows) */
  cards?: { id: string; title?: string; text?: string }[]
  /** a row or block as shown (security log row, network, search engines …) */
  shown?: { title?: string; text?: string }[]
  /** /api/perf summary, sent for speed cards and checks (the web process answers it) */
  perf?: unknown
  /** the build the admin's tab runs */
  build?: string | null
  sig?: string
  id?: number
}

const str = (x: unknown, n: number) => String(x ?? '').slice(0, n);
const commit = () => process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || process.env.SOURCE_COMMIT || null;

/** the values of the server's secret variables: never in the copied text, whatever it quotes */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env).filter(([k, v]) => v && v.length >= 8 && /KEY|TOKEN|SECRET|PASS|PRIVATE|DSN|WEBHOOK|SMTP|AUTH|COOKIE|SALT|VAPID|TOTP/i.test(k)).map(([, v]) => v as string);
}

let notesCache: { file: string; text: string }[] | null = null;
function notes(): { file: string; text: string }[] {
  if (notesCache) return notesCache;
  for (const dir of [process.env.NOTES_DIR, path.resolve(__dirname, '../../../docs/notes'), path.resolve(process.cwd(), '../docs/notes'), '/app/docs/notes'].filter(Boolean) as string[]) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      if (files.length) { notesCache = files.map(f => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') })); return notesCache; }
    } catch { /* next */ }
  }
  notesCache = [];
  return notesCache;
}

function deployRows(n: number): any[] {
  try { return db.prepare(`SELECT * FROM deploy_errors ORDER BY started_at DESC LIMIT ?`).all(n) as any[]; } catch { return []; }
}

/** the text for one request (throws a CrmError-like 404 through inboxThread / customerProfile) */
export function forClaudeText(b: ForClaudeBody, who: { viewer?: Viewer; security?: boolean } = {}, now = Date.now()): string {
  const scope = str(b.scope || 'card', 20);
  const sections: Section[] = [];
  const keys: string[] = [];
  const report = storedDataHealth();
  const byId = new Map(report.checks.map(c => [c.id, c as CheckLike]));
  const cards = (Array.isArray(b.cards) ? b.cards : []).slice(0, 30).map(c => ({ id: str(c?.id, 60), title: str(c?.title, 120), text: str(c?.text, 16000) }));
  const checks = (Array.isArray(b.checks) ? b.checks : []).slice(0, 120).map(c => ({ id: str(c?.id, 120), title: str(c?.title, 160), what: str(c?.what, 400), todo: str(c?.todo, 300) }));
  let speed = false;

  if (scope === 'crm-message') {
    const t = inboxThread(Number(b.id), who.viewer);
    sections.push(crmThreadSection(t as any));
    keys.push('support inbox');
  } else if (scope === 'crm-customer') {
    const p: any = customerProfile(Number(b.id), !!who.security);
    sections.push(customerSection(p));
    keys.push('customer profile');
  }

  // the checks: the full stored detail and items, the last 3 values, the page's explanation
  for (const c of checks) {
    const stored = byId.get(c.id);
    if (!stored) { sections.push({ title: `Check: ${c.title || c.id}`, lines: [`Check id: ${c.id}`, 'Not in the latest data-health report (renamed or not run yet).'] }); continue; }
    sections.push(checkSection(stored, { measuredAt: report.at, history: dataHealthHistory(c.id), plain: { title: c.title, what: c.what, todo: c.todo } }));
    keys.push(c.id, stored.label, c.title);
    if (isSpeedCheck(c.id)) speed = true;
  }

  // the cards: their own server-side context, then the text as shown
  for (const c of cards) {
    keys.push(c.id, c.title);
    if (c.id === 'speed') speed = true;
    if (c.id === 'site-errors' || c.id === 'for-claude') {
      const rows = clientErrorList(30).rows.filter(r => !r.resolvedAt).sort((x, y) => (x.lastAt < y.lastAt ? 1 : -1)).slice(0, 10);
      sections.push(rows.length ? siteErrorSection(rows) : { title: 'Site errors', lines: ['No open site errors.'] });
      let dc: ReturnType<typeof auditForClaude> | null = null;
      try { dc = c.id === 'for-claude' ? auditForClaude() : null; } catch { /* no check yet */ }
      if (dc?.differences.length) sections.push({
        title: `Top-scorer check ${dc.at}: ${dc.matched} of ${dc.checked} match`,
        lines: [...dc.differences.map(x => `- ${x.league}${x.player ? ` · ${x.player}` : ''}: ${x.detail}${x.reason ? ` (why: ${x.reason})` : ''}`),
          ...(dc.more ? [`… and ${dc.more} more`] : []), ...(dc.under.length ? [`Under 90% for 7+ days: ${dc.under.map(u => `${u.name} ${u.share}%`).join(', ')}`] : [])]
      });
    }
    if (c.id === 'deploy-errors') {
      const rows = deployRows(5);
      if (rows.length) sections.push(deploySection(rows));
    }
    if (c.id === 'model-daily') {
      const day = modelDailyLog(14).days.find(d => d.challengers?.candidates?.length);
      if (day) sections.push(candidatesSection({ date: day.date, decision: day.decision, reason: day.reason, candidates: day.challengers.candidates }));
    }
    if (c.text) sections.push(shownSection(c.title || c.id, c.text));
  }

  if (scope === 'site-error' && b.sig) {
    const all = clientErrorList(30).rows;
    const one = all.find(r => r.sig === str(b.sig, 16));
    if (one) { sections.unshift(siteErrorSection([one], 'This site error')); keys.push('site errors'); }
    const newest = all.filter(r => r.sig !== one?.sig && !r.resolvedAt).sort((x, y) => (x.lastAt < y.lastAt ? 1 : -1)).slice(0, 9);
    if (newest.length) sections.push(siteErrorSection(newest, 'The other newest open site errors'));
  }

  for (const s of (Array.isArray(b.shown) ? b.shown : []).slice(0, 20)) if (s?.text) sections.push(shownSection(str(s.title, 120) || 'Item', str(s.text, 8000)));

  if (speed && b.perf) sections.push(perfSection(b.perf));
  if (!sections.length) sections.push({ title: 'Nothing red or yellow', lines: ['Everything on this page is green.'] });

  const build = currentBuild();
  const tabBuild = str(b.build, 40) || null;
  const head = header({ place: str(b.place, 160) || 'Admin', at: now, build: build && tabBuild && tabBuild !== build ? `${build} (this tab runs ${tabBuild})` : build || tabBuild, commit: commit() });
  return assemble(head, sections, footerLine(relatedFixes(notes(), keys)), { secrets: secretValues() });
}

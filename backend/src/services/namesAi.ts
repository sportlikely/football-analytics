/**
 * fix283: Hebrew / Arabic spellings by the AI for the names nobody else spells (no press spelling, no Wikidata label, or
 * only a flagged one). Only when ANTHROPIC_API_KEY is set (Railway variable; never in the code) — without it nothing is
 * sent anywhere.
 *
 * Batches of 100 names (sport, kind, the name in first-last order, country, team), most opened first; the model is asked
 * for the spelling the Israeli / Arab sports press uses (utils/nameScript.ts AI_SYSTEM) and a confidence per language.
 * Each answer is stored per item and language (names.source = 'ai', conf) and goes through the same checks as every
 * other spelling; visitors see it only at NAMES_AI_MIN_CONF (default 0.8) or above with no check flagged
 * (nameScript.visibleName). A name is asked once (names_ai_tried) and again only when its Latin name changes.
 * Daily cost cap NAMES_AI_DAILY_USD (default $2): the run stops before a call that could pass it; usage per day in
 * names_ai_usage, on the admin card. NAMES_AI_MODEL overrides the model.
 *
 * fix286 (30 Oct: the first batch cost $0.119 for 100 names = ~$100 for all 85k; "Brayden" came back "ברייдן"): only the
 * names people see — every team / league / country / city, and the players nameScript.aiWanted picks (top divisions,
 * NBA / EuroLeague, NFL, tennis top 200, leaders lists, or viewed in the last 60 days; a view queues the name for the
 * next run). A compact answer line per name ("i|he|conf|ar|conf"), no JSON. A spelling with letters of another alphabet
 * is asked again once; still wrong = flagged ('other-script'), the page keeps the Latin name. The card shows the names
 * left to do and their estimated cost at the current price (usage per name of the last 30 days).
 */
import { db, DB_READ_ONLY } from '../db';
import logger from '../utils/logger';
import { AI_SYSTEM, AI_VIEW_DAYS, aiPrompt, aiRetryNote, blockedWords, parseAi, personOrder, otherScript, NAME_LANGS, type AiItem, type NameLang } from '../utils/nameScript';

const KEY = () => process.env.ANTHROPIC_API_KEY || '';
export const namesAiModel = () => process.env.NAMES_AI_MODEL || 'claude-opus-5-5';
export const namesAiCap = () => { const v = process.env.NAMES_AI_DAILY_USD; const n = Number(v); return v != null && v !== '' && isFinite(n) && n >= 0 ? n : 2; };
const BATCH = 100;
const BATCHES_PER_RUN = () => Number(process.env.NAMES_AI_BATCHES) || 4;
/** $ per million tokens (input, output), list prices; an unknown model is priced high so the cap still holds */
const PRICE: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-1': [10, 50]
};
const priceOf = (m: string) => PRICE[m] || [10, 50];
/** what one batch may cost at most (≈ 4k tokens in, MAX_OUT out) — the run stops before a call that could pass the cap */
const MAX_OUT = 8000;
const callCeiling = (m: string) => { const [i, o] = priceOf(m); return (4000 * i + MAX_OUT * o) / 1e6; };
/** tokens per name before the first answers (compact line in and out) — the estimate's start */
const GUESS_PER_NAME = { in: 30, out: 35 };
/** the models that take the server-side refusal fallback (`fallbacks: "default"`) */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);

if (!DB_READ_ONLY) {
  db.exec(`CREATE TABLE IF NOT EXISTS names_ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, in_tok INTEGER NOT NULL DEFAULT 0,
    out_tok INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0, names INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS names_ai_tried (sport TEXT NOT NULL, kind TEXT NOT NULL, latin TEXT NOT NULL, basis TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY (sport, kind, latin))`);
}

type Fetcher = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
let fetcher: Fetcher = (url, init) => fetch(url, init) as any;
/** tests: a fake API (and a count of the calls) */
export function setNamesAiFetcher(f: Fetcher | null) { fetcher = f || ((url, init) => fetch(url, init) as any); }

const today = () => new Date().toISOString().slice(0, 10);
function usage(day = today()) {
  try { return (db.prepare(`SELECT calls, in_tok, out_tok, usd, names, errors FROM names_ai_usage WHERE day = ?`).get(day) as any) || { calls: 0, in_tok: 0, out_tok: 0, usd: 0, names: 0, errors: 0 }; }
  catch { return { calls: 0, in_tok: 0, out_tok: 0, usd: 0, names: 0, errors: 0 }; }
}
const addUsage = (u: { in_tok: number; out_tok: number; usd: number; names: number; errors: number }) => db.prepare(`INSERT INTO names_ai_usage (day, calls, in_tok, out_tok, usd, names, errors) VALUES (?, 1, ?, ?, ?, ?, ?)
  ON CONFLICT(day) DO UPDATE SET calls = calls + 1, in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, usd = usd + excluded.usd, names = names + excluded.names, errors = errors + excluded.errors`)
  .run(today(), u.in_tok, u.out_tok, u.usd, u.names, u.errors);

/** the card / health line: on or off, today's spend against the cap, the last 30 days */
export function namesAiStatus() {
  const t = usage();
  let month = { calls: 0, usd: 0, names: 0 };
  try { month = db.prepare(`SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(names), 0) AS names FROM names_ai_usage WHERE day >= ?`).get(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) as any; } catch { /* none */ }
  let asked = 0;
  try { asked = (db.prepare(`SELECT COUNT(*) AS n FROM names_ai_tried`).get() as any).n; } catch { /* none */ }
  // fix286: usage per name (30 days; a first guess before any answer) → the names left to do at the current price
  let tok = { in_tok: 0, out_tok: 0, names: 0 };
  try { tok = db.prepare(`SELECT COALESCE(SUM(in_tok), 0) AS in_tok, COALESCE(SUM(out_tok), 0) AS out_tok, COALESCE(SUM(names), 0) AS names FROM names_ai_usage WHERE day >= ?`).get(since30()) as any; } catch { /* none */ }
  const per = tok.names ? { in: tok.in_tok / tok.names, out: tok.out_tok / tok.names } : GUESS_PER_NAME;
  const [pin, pout] = priceOf(namesAiModel());
  const usdPerName = (per.in * pin + per.out * pout) / 1e6;
  const left = leftToDo();
  return {
    configured: !!KEY(), model: namesAiModel(), capUsd: namesAiCap(), today: { calls: t.calls, usd: Math.round(t.usd * 1000) / 1000, names: t.names, errors: t.errors, inTok: t.in_tok, outTok: t.out_tok }, last30d: { calls: month.calls, usd: Math.round(month.usd * 100) / 100, names: month.names }, asked,
    perName: { inTok: Math.round(per.in), outTok: Math.round(per.out), usd: Math.round(usdPerName * 1e5) / 1e5, measured: !!tok.names },
    left: { ...left, estUsd: Math.round(left.names * usdPerName * 1000) / 1000 }
  };
}
const since30 = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

/**
 * fix286: the names the AI is asked for (nameScript.aiWanted in SQL): every team / league / country / city; a player
 * picked by the collector or viewed in the last AI_VIEW_DAYS days
 */
const WANTED = `(i.kind != 'player' OR i.ai_pick IS NOT NULL OR i.viewed_at >= ?)`;
const viewedSince = () => new Date(Date.now() - AI_VIEW_DAYS * 86400000).toISOString();
/** no spelling visitors may see in every language */
const UNSPELLED = `(SELECT COUNT(*) FROM names n WHERE n.sport = i.sport AND n.kind = i.kind AND n.latin = i.latin
        AND (n.source = 'admin' OR n.approved = 1 OR (n.source IN ('press', 'wikidata') AND n.flags IS NULL))) < ${NAME_LANGS.length}`;
/** the card: names the AI will still be asked for, and players waiting for a view */
function leftToDo(): { names: number; waiting: number } {
  try {
    const r = db.prepare(`SELECT SUM(CASE WHEN ${WANTED} THEN 1 ELSE 0 END) AS names, SUM(CASE WHEN ${WANTED} THEN 0 ELSE 1 END) AS waiting FROM name_items i
      LEFT JOIN names_ai_tried t ON t.sport = i.sport AND t.kind = i.kind AND t.latin = i.latin
      WHERE (t.basis IS NULL OR t.basis != COALESCE(i.display, i.latin)) AND ${UNSPELLED}`).get(viewedSince(), viewedSince()) as any;
    return { names: r?.names || 0, waiting: r?.waiting || 0 };
  } catch { return { names: 0, waiting: 0 }; }
}

type Row = { sport: string; kind: string; latin: string; id: string | null; country: string | null; display: string | null; team: string | null };
/** names without a spelling visitors may see in both languages, not asked yet for this Latin name; most opened first */
function todo(limit: number): Row[] {
  const rows = (db.prepare(`SELECT i.sport, i.kind, i.latin, i.id, i.country, i.display, i.team, t.basis AS tried FROM name_items i
      LEFT JOIN names_ai_tried t ON t.sport = i.sport AND t.kind = i.kind AND t.latin = i.latin
      WHERE ${WANTED} AND (t.basis IS NULL OR t.basis != COALESCE(i.display, i.latin)) AND ${UNSPELLED}
      ORDER BY i.views DESC, i.weight DESC LIMIT ?`).all(viewedSince(), limit * 2) as any[]);
  return rows.filter(r => r.tried !== basisOf(r)).slice(0, limit);
}
const basisOf = (r: { sport: string; kind: string; latin: string; display?: string | null }) => r.display || personOrder(r.latin, { sport: r.sport, kind: r.kind });

/** one batch to the API → { in, out, text } (throws on an HTTP error) */
async function ask(items: AiItem[], note = ''): Promise<{ inTok: number; outTok: number; text: string; refused: boolean }> {
  const model = namesAiModel();
  const fallback = FALLBACK_MODELS.has(model);
  const res = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY(), 'anthropic-version': '2023-06-01', ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
    body: JSON.stringify({
      model, max_tokens: MAX_OUT, system: AI_SYSTEM, output_config: { effort: 'low' }, ...(fallback ? { fallbacks: 'default' } : {}),
      messages: [{ role: 'user', content: `${note ? `${note}\n` : ''}Index, sport, kind, name, country, team:\n${aiPrompt(items)}` }]
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${String(j?.error?.message || '').slice(0, 160)}`);
  const text = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  return { inTok: j.usage?.input_tokens || 0, outTok: j.usage?.output_tokens || 0, text, refused: j.stop_reason === 'refusal' };
}

let running = false;
/** the names job's AI step: up to NAMES_AI_BATCHES batches, within the day's cap; nothing at all without the key */
export async function namesAiTick(opts: { batches?: number } = {}): Promise<{ written: number; asked: number; skipped?: string; error?: string }> {
  if (!KEY()) return { written: 0, asked: 0, skipped: 'no ANTHROPIC_API_KEY' };
  if (DB_READ_ONLY || running) return { written: 0, asked: 0, skipped: 'busy' };
  running = true;
  let written = 0, asked = 0;
  try {
    const model = namesAiModel();
    const [pin, pout] = priceOf(model);
    for (let b = 0; b < (opts.batches ?? BATCHES_PER_RUN()); b++) {
      if (usage().usd + callCeiling(model) > namesAiCap()) return { written, asked, skipped: 'daily cap' };
      const rows = todo(BATCH);
      if (!rows.length) break;
      const items: AiItem[] = rows.map(r => ({ sport: r.sport, kind: r.kind, name: basisOf(r), country: r.country && r.country !== '*' ? r.country : null, team: r.team }));
      let out;
      try { out = await ask(items); }
      catch (e: any) { addUsage({ in_tok: 0, out_tok: 0, usd: 0, names: 0, errors: 1 }); return { written, asked, error: String(e?.message || e) }; }
      const usd = (out.inTok * pin + out.outTok * pout) / 1e6;
      const got = out.refused ? new Map() : parseAi(out.text, items.length);
      addUsage({ in_tok: out.inTok, out_tok: out.outTok, usd, names: got.size, errors: out.refused ? 1 : 0 });
      // fix286: a spelling with letters of another alphabet ("ברייдן") — those names asked again once; still wrong =
      // written flagged ('other-script': the page keeps the Latin name, the row waits on the admin card)
      // fix289: a spelling a review blocked ("גזטפה" for Goztepe, "וסט" for West) too — asked again with the press examples
      const wrong = (i: number, l: NameLang, name: string) => otherScript(name, l) || blockedWords(items[i].name, name, l).length > 0;
      const bad = [...got].filter(([i, e]) => NAME_LANGS.some(l => e[l] && wrong(i, l, e[l]!.name))).map(([i]) => i);
      if (bad.length && usage().usd + callCeiling(model) <= namesAiCap()) {
        try {
          const note = aiRetryNote({
            otherScript: bad.some(i => NAME_LANGS.some(l => { const e = got.get(i)?.[l]; return !!e && otherScript(e.name, l); })),
            blocked: bad.flatMap(i => NAME_LANGS.flatMap(l => { const e = got.get(i)?.[l]; return e ? blockedWords(items[i].name, e.name, l) : []; }))
          });
          const again = await ask(bad.map(i => items[i]), note);
          addUsage({ in_tok: again.inTok, out_tok: again.outTok, usd: (again.inTok * pin + again.outTok * pout) / 1e6, names: 0, errors: again.refused ? 1 : 0 });
          const fixed = again.refused ? new Map() : parseAi(again.text, bad.length);
          for (const [k, e] of fixed) {
            const cur = got.get(bad[k]);
            for (const l of NAME_LANGS) if (cur?.[l] && wrong(bad[k], l, cur[l]!.name) && e[l]) cur[l] = e[l];
          }
        } catch (e: any) { addUsage({ in_tok: 0, out_tok: 0, usd: 0, names: 0, errors: 1 }); logger.warn(`names AI (again): ${e?.message || e}`); }
      }
      const write: { it: Row; lang: NameLang; name: string; conf: number }[] = [];
      for (const [i, e] of got) for (const lang of NAME_LANGS) if (e[lang]) write.push({ it: rows[i], lang, name: e[lang]!.name, conf: e[lang]!.conf });
      // asked once per Latin name, answered or not (never re-asked unless the name changes)
      const mark = db.prepare(`INSERT OR REPLACE INTO names_ai_tried (sport, kind, latin, basis, at) VALUES (?, ?, ?, ?, ?)`);
      const now = new Date().toISOString();
      for (const r of rows) mark.run(r.sport, r.kind, r.latin, basisOf(r), now);
      const { writeAiNames } = require('./names') as typeof import('./names');
      written += writeAiNames(write);
      asked += rows.length;
    }
  } catch (e: any) {
    logger.warn(`names AI: ${e?.message || e}`);
    return { written, asked, error: String(e?.message || e) };
  } finally { running = false; }
  return { written, asked };
}

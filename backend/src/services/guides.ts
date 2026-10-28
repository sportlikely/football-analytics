/**
 * Guide pages (fix125, Oct 2026): plain-English explainers at /guides/<slug>, written as markdown in
 * frontend/src/content/guides/<slug>.md (front matter: slug, title, description, related). The server renders them
 * once for both the app (GET /api/guides/:slug) and the crawler HTML (seo.ts), so visitors and search engines read
 * the same text. English only for now.
 *
 * Live numbers: {{dc_30d}} and {{dc_90}} become one sentence each from publicRecord() (football, last 30 days); a
 * sentence whose number rests on fewer than 30 games is left out entirely. Rendered pages are kept for 30 minutes.
 */
import fs from 'fs';
import path from 'path';
import { publicRecord } from './tracking';

const DIRS = [process.env.GUIDES_DIR, path.resolve(__dirname, '../../../frontend/src/content/guides')].filter(Boolean) as string[];
const MIN_GAMES = 30;
const TTL = 30 * 60 * 1000;

export interface GuideMeta { slug: string; title: string; description: string; related: string[]; updated: string }
export interface Guide extends GuideMeta { h1: string; html: string; text: string; relatedGuides: { slug: string; title: string }[] }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const guideDir = () => DIRS.find(d => fs.existsSync(d)) || null;

function readAll(): { meta: GuideMeta; body: string }[] {
  const dir = guideDir();
  if (!dir) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const fm: Record<string, string> = {};
    for (const line of (m?.[1] || '').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const slug = fm.slug || f.replace(/\.md$/, '');
    return {
      meta: {
        slug, title: fm.title || slug, description: fm.description || '',
        related: (fm.related || '').split(',').map(s => s.trim()).filter(Boolean),
        updated: fs.statSync(path.join(dir, f)).mtime.toISOString()
      },
      body: m ? m[2] : raw
    };
  }).filter(g => /^[a-z0-9-]+$/.test(g.meta.slug));
}

/** Live-number sentences; null when the number rests on too few games. */
function liveSentences(): Record<string, string | null> {
  let hl: any = null;
  try { hl = publicRecord(30, undefined, 0).highlights; } catch { hl = null; }
  const all = hl?.dcAll, top = hl?.dc90;
  return {
    dc_30d: all && all.n >= MIN_GAMES && all.pct != null ? `Over the last 30 days our double chance was right in ${all.hits} of ${all.n} matches (${all.pct}%).` : null,
    dc_90: top && top.n >= MIN_GAMES && top.pct != null ? `When we were 90% sure or more, it was right ${top.pct}% of the time (${top.n} matches).` : null
  };
}

/** Inline markdown: **bold**, *italic*, [text](/internal-link). Everything else is escaped. */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((\/[^)\s]*|https:\/\/sportlikely\.com[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

/** Minimal markdown for our own guide files: # / ## / ### headings, "- " lists, paragraphs. */
function render(md: string): { h1: string; html: string; text: string } {
  let h1 = '';
  const out: string[] = [], text: string[] = [];
  let para: string[] = [], list: string[] = [];
  const flush = () => {
    if (para.length) { const p = para.join(' ').replace(/\s+/g, ' ').trim(); if (p) { out.push(`<p>${inline(p)}</p>`); text.push(p); } para = []; }
    if (list.length) { out.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join('')}</ul>`); text.push(...list); list = []; }
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      if (h[1].length === 1 && !h1) { h1 = h[2].trim(); continue; }
      const lv = Math.max(2, h[1].length);
      out.push(`<h${lv}>${inline(h[2].trim())}</h${lv}>`); text.push(h[2].trim());
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) { const l = list; list = []; flush(); list = l; }
      list.push(line.replace(/^\s*[-*]\s+/, ''));
    } else if (!line.trim()) flush();
    else { if (list.length) { const p = para; para = []; flush(); para = p; } para.push(line.trim()); }
  }
  flush();
  return { h1, html: out.join('\n'), text: text.join(' ') };
}

let cache: { at: number; list: GuideMeta[]; pages: Map<string, Guide> } | null = null;
function build() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const files = readAll();
  const live = files.some(f => /\{\{\w+\}\}/.test(f.body)) ? liveSentences() : {};
  const titleOf = new Map(files.map(f => [f.meta.slug, f.meta.title.replace(/\s*\|\s*SportLikely\s*$/, '')]));
  const pages = new Map<string, Guide>();
  for (const f of files) {
    const body = f.body.replace(/\{\{(\w+)\}\}/g, (_, k) => live[k] || '');
    const r = render(body);
    pages.set(f.meta.slug, {
      ...f.meta, ...r, h1: r.h1 || titleOf.get(f.meta.slug)!,
      // only guides that exist (the others are linked once they are written)
      relatedGuides: f.meta.related.filter(s => titleOf.has(s) && s !== f.meta.slug).map(s => ({ slug: s, title: titleOf.get(s)! }))
    });
  }
  cache = { at: Date.now(), list: files.map(f => f.meta).sort((a, b) => a.title.localeCompare(b.title)), pages };
  return cache;
}

export const listGuides = (): GuideMeta[] => build().list;
/** fix263: the guides' slugs from the file names alone (no rendering, no record read): the web's 404 check */
export const guideSlugs = (): string[] => readAll().map(g => g.meta.slug);
export const getGuide = (slug: string): Guide | null => build().pages.get(slug) || null;

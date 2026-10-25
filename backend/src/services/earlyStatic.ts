/**
 * fix227: the built site's files answered before the web process is ready. On 25 Oct (14:48 UTC, the restart after the
 * VAPID keys) an iPhone got the page but its app file came back 503 from the ready gate: the crawler text stayed on
 * screen with no app. The files on disk need no model state, so they are sent at once, before the state load:
 * /assets/* (hashed, a year), sw.js, the manifest, icons and the other files in the build, and index.html (the plain
 * app page, no crawler text) for every other page address. The ready gate keeps answering 503 only for /health and
 * the API (those need the state). Also used by boot.ts, the listener that answers while the modules load.
 */
import fs from 'fs';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

export const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../../frontend/dist');

const TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.mp4': 'video/mp4'
};

let indexCache: Buffer | null = null;
const indexHtml = () => (indexCache ??= fs.readFileSync(path.join(STATIC_DIR, 'index.html')));
export const hasBuild = () => { try { return fs.existsSync(path.join(STATIC_DIR, 'index.html')); } catch { return false; } };

/** the paths that need the model state (answered 503 until ready): the API, the live socket and the health check */
export const needsState = (p: string) => p.startsWith('/api/') || p === '/api' || p.startsWith('/socket.io/') || p === '/health';

/** the main app file's name in this build (/assets/index-<hash>.js): a stored page made for another build has another */
let mainScript: string | null | undefined;
export function currentMainScript(): string | null {
  if (mainScript !== undefined) return mainScript;
  try { mainScript = (/src="(\/assets\/index-[^"]+\.js)"/.exec(indexHtml().toString('utf8')) || [])[1] || null; } catch { mainScript = null; }
  return mainScript;
}

function send(res: ServerResponse, status: number, type: string, cache: string, body: Buffer | string, head: boolean) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(body) });
  res.end(head ? undefined : body);
}

/**
 * Answer a GET / HEAD for a page or a file from the build; false when it is not one (the caller answers it). Never
 * throws. A file under /assets that is not there is a plain 404 (never the page: the browser would run it as a script).
 */
export function serveEarly(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p: string;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch { return false; }
  if (needsState(p) || !hasBuild()) return false;
  const head = req.method === 'HEAD';
  try {
    const file = path.normalize(path.join(STATIC_DIR, p));
    const inside = file.startsWith(path.normalize(STATIC_DIR + path.sep));
    const isFile = inside && p !== '/' && fs.existsSync(file) && fs.statSync(file).isFile();
    if (p.startsWith('/assets/')) {
      if (!isFile) { send(res, 404, 'text/plain; charset=utf-8', 'no-store', 'Not found', head); return true; }
      send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'public, max-age=31536000, immutable', fs.readFileSync(file), head);
      return true;
    }
    if (isFile && path.basename(file) !== 'index.html') {
      const cache = p === '/sw.js' ? 'no-cache' : p === '/manifest.webmanifest' ? 'public, max-age=86400' : 'public, max-age=604800';
      if (p === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
      send(res, 200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', cache, fs.readFileSync(file), head);
      return true;
    }
    // a file-like address that is not in the build (an old sitemap, robots …): not the page
    if (/\.[a-z0-9]{2,5}$/i.test(p) && !p.endsWith('.html')) { send(res, 404, 'text/plain; charset=utf-8', 'no-store', 'Not found', head); return true; }
    send(res, 200, 'text/html; charset=utf-8', 'no-cache', indexHtml(), head);
    return true;
  } catch {
    return false;
  }
}

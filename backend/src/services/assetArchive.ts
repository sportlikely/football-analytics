/**
 * fix252: the last builds' app files kept for open tabs. A deploy replaces the container, and with it frontend/dist:
 * a tab opened before the deploy (or a browser / CDN copy of the old page) then asks for /assets/<name>-<old hash>.js
 * and gets a 404 — "app file failed 3 times" and "Cannot destructure property 'default' of 'undefined'" (≈20 reports
 * on 26–27 Oct). Each start copies its own /assets files to the data volume (DATA_DIR/old-assets) and notes, in
 * builds.json, when a file stopped being part of the running build; a file is kept KEEP_MS (48 h, at least 24 h asked)
 * after that, and the oldest are dropped first above MAX_BYTES. /assets requests the build doesn't have are answered
 * from here (earlyStatic.serveEarly before the app is up, app.ts after); hashed names, so a year's cache stays right.
 */
import fs from 'fs';
import path from 'path';

export const KEEP_MS = 48 * 3600 * 1000;
export const MAX_BYTES = 300 * 1024 * 1024;
export const ARCHIVE_DIR = process.env.ASSET_ARCHIVE_DIR || path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'old-assets');
const MANIFEST = 'builds.json';
/** a built file's name: no folders, no dots-only tricks */
const SAFE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** what the archive knows: per file its size and when it left the running build (null = still in it) */
export interface Manifest { files: Record<string, { size: number; gone: number | null }> }

function readManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    if (m && typeof m.files === 'object' && m.files) return m;
  } catch { /* first start, or a broken file: start again */ }
  return { files: {} };
}

/**
 * Pure: the manifest after a start with `current` (name → size) as the running build's files, and which archived files
 * to delete (gone for more than keepMs, then the oldest gone ones while the archive is over maxBytes).
 */
export function planArchive(m: Manifest, current: Record<string, number>, now: number, keepMs = KEEP_MS, maxBytes = MAX_BYTES): { manifest: Manifest; drop: string[] } {
  const files: Manifest['files'] = {};
  for (const [name, size] of Object.entries(current)) files[name] = { size, gone: null };
  for (const [name, f] of Object.entries(m.files || {})) if (!(name in files)) files[name] = { size: Number(f?.size) || 0, gone: typeof f?.gone === 'number' ? f.gone : now };
  const drop: string[] = [];
  for (const [name, f] of Object.entries(files)) if (f.gone !== null && now - f.gone > keepMs) { drop.push(name); delete files[name]; }
  let total = Object.values(files).reduce((a, f) => a + f.size, 0);
  const old = Object.entries(files).filter(([, f]) => f.gone !== null).sort((a, b) => (a[1].gone as number) - (b[1].gone as number));
  for (const [name, f] of old) {
    if (total <= maxBytes) break;
    drop.push(name); delete files[name]; total -= f.size;
  }
  return { manifest: { files }, drop };
}

/** copy the running build's /assets into the archive, note what left it, drop what is past its time; never throws */
export async function archiveBuild(staticDir: string, dir = ARCHIVE_DIR, now = Date.now()): Promise<{ copied: number; kept: number; dropped: number } | null> {
  try {
    const src = path.join(staticDir, 'assets');
    if (!fs.existsSync(src)) return null;
    await fs.promises.mkdir(dir, { recursive: true });
    const current: Record<string, number> = {};
    let copied = 0;
    for (const name of await fs.promises.readdir(src)) {
      if (!SAFE.test(name)) continue;
      const st = await fs.promises.stat(path.join(src, name));
      if (!st.isFile()) continue;
      current[name] = st.size;
      const to = path.join(dir, name);
      const have = await fs.promises.stat(to).catch(() => null);
      if (have?.size === st.size) continue;
      // a temporary name first: a half-written file is never served
      await fs.promises.copyFile(path.join(src, name), `${to}.part`);
      await fs.promises.rename(`${to}.part`, to);
      copied++;
    }
    const { manifest, drop } = planArchive(readManifest(dir), current, now);
    for (const name of drop) await fs.promises.rm(path.join(dir, name), { force: true });
    // files on disk the manifest doesn't know (a crash between copy and write): gone from now
    for (const name of await fs.promises.readdir(dir)) {
      if (name === MANIFEST || name.endsWith('.tmp')) continue;
      if (name.endsWith('.part')) { await fs.promises.rm(path.join(dir, name), { force: true }); continue; }
      if (!manifest.files[name]) manifest.files[name] = { size: (await fs.promises.stat(path.join(dir, name))).size, gone: now };
    }
    await fs.promises.writeFile(path.join(dir, `${MANIFEST}.tmp`), JSON.stringify(manifest));
    await fs.promises.rename(path.join(dir, `${MANIFEST}.tmp`), path.join(dir, MANIFEST));
    return { copied, kept: Object.keys(manifest.files).length, dropped: drop.length };
  } catch {
    return null;
  }
}

/** the archived copy of /assets/<name> (an older build's file), or null */
export function archivedAsset(name: string, dir = ARCHIVE_DIR): string | null {
  if (!SAFE.test(name) || name === MANIFEST || name.endsWith('.part') || name.endsWith('.tmp')) return null;
  const f = path.join(dir, name);
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

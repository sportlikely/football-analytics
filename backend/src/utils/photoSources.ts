/**
 * fix241: player photos only from an official / licensed source (Yarin, 26 Oct 2026: "I prefer no pictures if it's
 * not official"). A photo URL is shown only when its source is on this list; anything else (Wikimedia / Wikidata
 * files, any other host) → initials + flag. Twin of frontend/src/lib/photoSources.ts — keep the two identical.
 * A licensed headshot provider later = one more entry here (and in the twin).
 */
export interface PhotoSource { id: string; label: string; host: RegExp }
export const OFFICIAL_PHOTO_SOURCES: PhotoSource[] = [
  // API-Football / API-Sports (our licensed data provider): football and American football player images
  { id: 'api-football', label: 'API-Football (API-Sports)', host: /^media(-\d+)?\.api-sports\.io$/ }
];

/** the official source a photo URL comes from, or null (relative paths, other hosts, junk) */
export function photoSourceOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return OFFICIAL_PHOTO_SOURCES.find(s => s.host.test(host))?.id ?? null;
}
/** the URL when its source is allowed, else null (the page shows initials + flag) */
export const officialPhoto = (url: string | null | undefined): string | null => (photoSourceOf(url) ? (url as string) : null);

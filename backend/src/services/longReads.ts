/**
 * fix273: the long reads of this process — each one keeps a read snapshot open for its whole length, and while it does
 * the WAL cannot start over (29 Oct: WAL 2,350 MB, "Last WAL truncate: blocked by a reader (8 in a row)"). The backup's
 * VACUUM INTO (one snapshot for the whole copy of a 2.8 GB file) and the job threads' builds register here; a TRUNCATE
 * that was blocked records who was reading (data health "Disk"), and when the last long read ends the WAL is asked to
 * start over at once (services/dbSpace.ts) instead of at the next 5-minute tick.
 */
type Open = { name: string; since: number };
const open = new Map<number, Open>();
let seq = 0;
const ended: (() => void)[] = [];

/** a long read starts; call the returned function when it ends (twice is harmless) */
export function longRead(name: string): () => void {
  const id = ++seq;
  open.set(id, { name, since: Date.now() });
  return () => {
    const r = open.get(id);
    if (!r) return;
    open.delete(id);
    // a read of a minute or more held the WAL: let it start over now
    if (Date.now() - r.since >= 60_000 && !open.size) for (const f of ended) { try { f(); } catch { /* the next tick */ } }
  };
}
/** the reads open now, longest first */
export function longReadsNow(now = Date.now()): { name: string; since: string; forMin: number }[] {
  return [...open.values()].sort((a, b) => a.since - b.since)
    .map(r => ({ name: r.name, since: new Date(r.since).toISOString(), forMin: Math.round((now - r.since) / 6000) / 10 }));
}
/** called when the last long read (≥ 1 min) ends */
export function onLongReadsEnded(f: () => void) { ended.push(f); }

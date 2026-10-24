/**
 * fix210: one model build in a worker thread (services/threadJob.ts starts it, one thread per build). Every state the
 * build publishes goes back to the worker's main thread one message at a time (services/shared.ts captures them here),
 * then the result; the main thread ends the thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { onCaptured } from '../services/shared';

async function run(): Promise<unknown> {
  const { job, args } = workerData as { job: string; args: unknown[] };
  if (job === 'bb model') return (await import('../services/bbModel')).buildLeaguesHere(args[0] as string[]);
  if (job === 'national elo') return (await import('../services/nationalElo')).buildNationalEloHere();
  throw new Error(`unknown thread job ${job}`);
}

if (parentPort) {
  const port = parentPort;
  onCaptured((key, value) => port.postMessage({ t: 'state', key, value }));
  run().then(result => port.postMessage({ t: 'done', result }), e => port.postMessage({ t: 'error', error: e?.message || String(e) }));
}

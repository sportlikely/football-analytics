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
  // fix219: the bb-v4 grid tuner (reads the stored rows; apply = stored + published from here)
  if (job === 'bb tune') return (await import('../services/bbTuner')).runTune(args[0] as any);
  // fix223: the per-league settings on top of the stored shared tune
  if (job === 'bb league tune') return (await import('../services/bbTuner')).runLeagueTune(args[0] as any);
  // fix222: the basketball calibration layer (reads the stored rows; stored + published from here)
  if (job === 'bb calib') return (await import('../services/sportCalibration')).buildBbCalibrationHere(args[0] as string);
  if (job === 'national elo') return (await import('../services/nationalElo')).buildNationalEloHere();
  if (job === 'sitemap') { const seo = await import('../services/seo'); return seo.SITEMAPS[args[0] as string]?.() ?? null; }
  // fix212: one player photo's crop (sharp) — the buffer comes back as a plain byte array
  if (job === 'photo crop') { const r = await (await import('../services/playerPhotos')).faceSquare(Buffer.from(args[0] as Uint8Array)); return r ? { ...r, data: new Uint8Array(r.data) } : null; }
  if (job === 'more backtest') return (await import('../services/morePredictions')).moreBacktestHere(args[0] as any, args[1], args[2] as any);
  // fix215: season forecast — a batch of league simulations, or one past season's replay (pure, no database)
  // fix218: + the noise fit of one past season (args[2] === 'fit')
  if (job === 'season sim') { const f = await import('../utils/seasonFit'); return args[0] ? f.simulateHere(args[0] as any) : args[2] === 'fit' ? f.fitNoiseHere(args[1] as any) : f.replayHere(args[1] as any); }
  throw new Error(`unknown thread job ${job}`);
}

if (parentPort) {
  const port = parentPort;
  onCaptured((key, value) => port.postMessage({ t: 'state', key, value }));
  run().then(result => port.postMessage({ t: 'done', result }), e => port.postMessage({ t: 'error', error: e?.message || String(e) }));
}

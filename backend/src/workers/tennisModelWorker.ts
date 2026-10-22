/**
 * fix200: the tennis model's worker thread (services/tennisModel.ts starts it). The report, the weekly re-tune, the
 * ratings replay, new results and the predictions run here, on a database connection in read mode (db/index.ts:
 * workerData.readOnlyDb); every write goes back to the main thread, which applies it in one short transaction.
 * The perf stall monitor and the schedulers stay on the main thread.
 */
import { parentPort } from 'worker_threads';
import { runTennisWorker } from '../services/tennisModel';

if (parentPort) runTennisWorker(parentPort);

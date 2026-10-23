/**
 * fix202: messages between the web process and its worker (Node's child-process IPC channel). Short messages only
 * ("state X changed", "live games changed", "page built", "build this page"); the data itself goes through SQLite.
 * In one process (WORKER=0) nothing is sent: callers do the work in place.
 */
import type { ChildProcess } from 'node:child_process';
import logger from '../utils/logger';
import { isWeb, isWorker } from './role';

export type IpcMessage = { t: string; [k: string]: unknown };
type Handler = (m: IpcMessage) => void;

const handlers = new Map<string, Handler[]>();
let child: ChildProcess | null = null;

/** handle messages of type `t` from the other process */
export function onIpc(t: string, fn: Handler) {
  let l = handlers.get(t);
  if (!l) handlers.set(t, (l = []));
  l.push(fn);
}

function dispatch(m: unknown) {
  if (!m || typeof m !== 'object' || typeof (m as IpcMessage).t !== 'string') return;
  for (const fn of handlers.get((m as IpcMessage).t) || []) {
    try { fn(m as IpcMessage); } catch (e: any) { logger.warn(`ipc ${(m as IpcMessage).t}: ${e?.message || e}`); }
  }
}

if (isWorker) process.on('message', dispatch);

/** web: the worker child (or null while it restarts) */
export function attachWorker(c: ChildProcess | null) {
  child = c;
  c?.on('message', dispatch);
}
export const workerConnected = () => !!child?.connected;

/** send to the other process; false when there is none (one process, or the worker is restarting) */
export function sendIpc(m: IpcMessage): boolean {
  try {
    if (isWorker && process.send && process.connected) { process.send(m); return true; }
    if (isWeb && child?.connected) { child.send(m); return true; }
  } catch (e: any) { logger.warn(`ipc send ${m.t}: ${e?.message || e}`); }
  return false;
}

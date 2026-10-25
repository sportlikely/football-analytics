/**
 * fix227: while the server restarts (a deploy) the API answers 503 "Starting up" with Retry-After for a few seconds
 * (the web process is loading its state; services/readiness on the server). A GET that gets it is asked again, up to
 * 4 times, 1.5–3 s apart — the page fills in instead of showing an error. Other 503s (e.g. "more details soon") and
 * every write are left as they are.
 */
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'

const MAX_TRIES = 4

export function watchStartupRetry() {
  axios.interceptors.response.use(undefined, async (err: AxiosError) => {
    const cfg = err.config as (InternalAxiosRequestConfig & { _startTries?: number }) | undefined
    const r = err.response
    const starting = r?.status === 503 && (r.data as { ready?: boolean } | undefined)?.ready === false
    if (!cfg || !starting || (cfg.method || 'get').toLowerCase() !== 'get' || (cfg._startTries || 0) >= MAX_TRIES) throw err
    cfg._startTries = (cfg._startTries || 0) + 1
    const after = Number(r.headers?.['retry-after']) || 2
    await new Promise(res => setTimeout(res, Math.min(3000, Math.max(1500, after * 1000 / 2))))
    return axios(cfg)
  })
}

/**
 * fix250: a game page asks for its game bundle first (/api/game-bundle/<sport>/<id>: the prediction, extras, season
 * forecast and more predictions in one answer, server services/gameBundle.ts); the sections' own calls are answered
 * from it (lib/apiCache.ts) — one request instead of five. The part list is the server's bundleParts.
 */
import axios from 'axios'
import { API_URL } from './socket'
import { expectFromBundle } from './apiCache'

export type BundleSport = 'football' | 'basketball' | 'nfl' | 'tennis'

/** the addresses as the sections ask for them */
export function bundleParts(sport: BundleSport, id: number): string[] {
  const game = sport === 'football' ? `${API_URL}/matches/${id}/details` : sport === 'basketball' ? `${API_URL}/basketball/game/${id}`
    : sport === 'nfl' ? `${API_URL}/nfl/game/${id}` : `${API_URL}/tennis/match/${id}`
  return [game, `${API_URL}/extras/${sport}/game/${id}`, ...(sport !== 'tennis' && id > 0 ? [`${API_URL}/season-forecast/${sport}/game/${id}`] : []), `${API_URL}/more/${sport}/${id}`]
}

const asked = new Map<string, number>()
/** call while rendering the game page (before its sections' effects run); once per game every 20 s */
export function primeGame(sport: BundleSport, id: number) {
  if (!id) return
  const k = `${sport}/${id}`
  if (Date.now() - (asked.get(k) || 0) < 20_000) return
  asked.set(k, Date.now())
  if (asked.size > 50) asked.delete(asked.keys().next().value as string)
  const parts = axios.get(`${API_URL}/game-bundle/${sport}/${id}`, { headers: { 'X-SL-Once': '1' } })
    .then(r => (r.data?.data?.parts as Record<string, unknown> | undefined) || null, () => null)
  expectFromBundle(bundleParts(sport, id).map(url => axios.getUri({ url })), parts)
}

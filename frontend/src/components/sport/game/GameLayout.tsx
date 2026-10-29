import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'

/**
 * fix284: the game page's frame on every sport (Yarin, 29 Oct: "the space left and right of the centre column is empty").
 *  - 1280 px and wider: three columns — "Game preview" left (300 px), the game (hero, tabs, the open tab) in the centre,
 *    "Your picks" right (300 px); both sides sticky under the header while the centre scrolls, stopping at the footer.
 *    A page without a preview (the preview is English only) keeps the right column only.
 *  - 1024–1279 px: the game, then one right column with the preview above "Your picks".
 *  - under 1024 px: one column as before — the preview above the tabs (GamePage), "Your picks" right after the prediction block
 *    (where the sport's page puts <GamePicksSlot />).
 * Every tab keeps the same side columns. GamePage renders this; `npm run parity` (scripts/game-layout-check.ts) fails
 * when a sport's game page does not go through it.
 */
export type GameCols = 1 | 2 | 3

const QUERIES: [GameCols, string][] = [[3, '(min-width: 1280px)'], [2, '(min-width: 1024px)']]
const colsNow = (): GameCols => {
  if (typeof window === 'undefined' || !window.matchMedia) return 1
  for (const [n, q] of QUERIES) if (window.matchMedia(q).matches) return n
  return 1
}
const subscribe = (fn: () => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
  const lists = QUERIES.map(([, q]) => window.matchMedia(q))
  lists.forEach(l => l.addEventListener('change', fn))
  return () => lists.forEach(l => l.removeEventListener('change', fn))
}
/** 3 (≥ 1280 px), 2 (1024–1279 px) or 1 column */
export const useGameCols = () => useSyncExternalStore(subscribe, colsNow, () => 1 as GameCols)

const Slots = createContext<{ cols: GameCols; picks: ReactNode }>({ cols: 1, picks: null })

/** One column: "Your picks" right after the prediction block; wider: nothing (it is in the right column). */
export function GamePicksSlot() {
  const s = useContext(Slots)
  return s.cols === 1 && s.picks ? <>{s.picks}</> : null
}

const SIDE = 'min-w-0 space-y-6 lg:sticky lg:top-[88px] lg:self-start lg:max-h-[calc(100vh-104px)] lg:overflow-y-auto no-scrollbar'

export default function GameLayout({ preview, picks, children }: { preview?: ReactNode; picks?: ReactNode; children: ReactNode }) {
  const cols = useGameCols()
  const value = { cols, picks: picks || null }
  const three = cols === 3 && !!preview
  // one tree shape for every width (left slot, the game, right slot): the game is never re-mounted when the preview
  // arrives or the window is resized (a re-mount closed the live socket mid-handshake)
  return (
    <Slots.Provider value={value}>
      <div data-game-layout={three ? '3' : cols === 1 ? '1' : '2'}
        className={three ? 'grid grid-cols-[300px_minmax(0,1fr)_300px] gap-6 items-start' : cols === 2 || cols === 3 ? 'grid grid-cols-[minmax(0,1fr)_300px] gap-6 items-start' : ''}>
        {three ? <aside className={SIDE} data-game-side="left">{preview}</aside> : null}
        <div className="min-w-0" data-game-main>{children}</div>
        {cols > 1 ? <aside className={SIDE} data-game-side="right">{three ? null : preview}{picks}</aside> : null}
      </div>
    </Slots.Provider>
  )
}

import SportHome from '../../components/SportHome'
import { useTennisAdapter } from '../../components/SportHome/tennis'
import { TennisTourChips } from './parts'

/** Tennis home (fix193): the shared sport home (football's layout) with the tennis adapter; the tour chips on top. */
export default function TennisHome() {
  return (
    <>
      <div className="max-w-7xl 2xl:max-w-[1760px] mx-auto px-4 sm:px-6 pt-4"><TennisTourChips /></div>
      <SportHome adapter={useTennisAdapter()} />
    </>
  )
}

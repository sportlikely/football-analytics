import { useTabPath } from '../../../lib/tabPath'
import { TOPIC_IDS, type TopicId } from './questions'
import type { MoreSport } from './more'

/**
 * fix281: the page's tabs plus the prediction tab's topics, all sub-paths (fix235, no #): the prediction tab is the
 * page itself and its Result topic; …/goals, …/score, …/half-time (football), …/points, …/halves (basketball, NFL),
 * …/sets, …/games (tennis) open the prediction tab on that topic. The names are in MATCH_TABS (lib/slugRules).
 */
export function useGameTopics(sport: MoreSport, ids: readonly string[], aliases: Record<string, string> = {}) {
  const extra = TOPIC_IDS[sport].slice(1) as string[]
  const [tab, pick] = useTabPath([...ids, ...extra.filter(x => !ids.includes(x))], aliases)
  const isTopic = extra.includes(tab)
  return {
    tab: isTopic ? ids[0] : tab,
    pickTab: (id: string) => pick(id),
    topic: (isTopic ? tab : 'result') as TopicId,
    pickTopic: (id: TopicId) => pick(id === 'result' ? ids[0] : id)
  }
}

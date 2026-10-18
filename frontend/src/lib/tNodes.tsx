import { Fragment, type ReactNode } from 'react'
import { t } from './i18n'

/**
 * fix174: a translated sentence whose {0}, {1}… slots hold React nodes (a team name as a link), in the word order of
 * the language. Plain values work too.
 */
export function tNodes(key: string, vars: Record<string | number, ReactNode>): ReactNode {
  const marks: Record<string, string> = {}
  for (const k of Object.keys(vars)) marks[k] = `\u0001${k}\u0002`
  const text = t(key, marks)
  return text.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => {
    const m = /^\u0001([^\u0002]*)\u0002$/.exec(part)
    return <Fragment key={i}>{m ? vars[m[1]] : part}</Fragment>
  })
}

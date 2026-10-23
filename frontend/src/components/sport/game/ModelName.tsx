import { Link } from 'react-router-dom'
import { slModel, slVersionLine, type ModelSport } from '../../../lib/modelNames'
import { howPath } from '../../../lib/howItWorks'
import { t } from '../../../lib/i18n'

/**
 * fix191: the public model name with its info line ("SL Football 3.0" / "Version 3.0 · updated 19 Oct 2026"), every sport.
 * fix206: + "How does this work?" to the sport's how-it-works page (under every prediction and on the Accuracy page).
 */
export function ModelName({ sport, className = '' }: { sport: ModelSport; className?: string }) {
  const how = howPath(sport)
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs ${className}`}>
      <span className="font-bold text-ink">{slModel(sport)}</span>
      <span className="text-faint">{slVersionLine(sport)}</span>
      {how && <Link to={how} className="font-semibold text-accent hover:underline">{t('How does this work?')}</Link>}
    </div>
  )
}

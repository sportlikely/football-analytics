import { slModel, slVersionLine, type ModelSport } from '../../../lib/modelNames'

/** fix191: the public model name with its info line ("SL Football 3.0" / "Version 3.0 · updated 19 Oct 2026"), every sport. */
export function ModelName({ sport, className = '' }: { sport: ModelSport; className?: string }) {
  return (
    <div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs ${className}`}>
      <span className="font-bold text-ink">{slModel(sport)}</span>
      <span className="text-faint">{slVersionLine(sport)}</span>
    </div>
  )
}

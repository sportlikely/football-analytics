/**
 * fix250: what a page shows before its first data (a few hundred ms at most): the shape of a page, never an empty
 * screen under the header.
 */
import { t } from '../lib/i18n'

const Bar = ({ w, h = 'h-4' }: { w: string; h?: string }) => <div className={`${h} ${w} rounded bg-surface2 animate-pulse`} />

export default function PageSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5" aria-busy="true" aria-label={t('Loading…')}>
      <Bar w="w-2/3 sm:w-1/3" h="h-7" />
      <div className="rounded-2xl border border-line bg-surface p-4 space-y-3">
        <div className="flex items-center justify-between gap-4"><Bar w="w-1/3" h="h-6" /><Bar w="w-16" h="h-8" /><Bar w="w-1/3" h="h-6" /></div>
        <div className="grid grid-cols-3 gap-2"><Bar w="w-full" h="h-12" /><Bar w="w-full" h="h-12" /><Bar w="w-full" h="h-12" /></div>
        <Bar w="w-1/2" />
      </div>
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-2xl border border-line bg-surface p-4 space-y-2"><Bar w="w-1/4" /><Bar w="w-full" /><Bar w="w-5/6" /></div>
      ))}
    </div>
  )
}

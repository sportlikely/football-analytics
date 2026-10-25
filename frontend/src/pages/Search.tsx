import { useSearchParams } from 'react-router-dom'
import SearchBox from '../components/SearchBox'
import { t } from '../lib/i18n'

/** fix229: /search?q=… — an unknown slug lands here with its words (never a dead end) */
export default function Search() {
  const [sp] = useSearchParams()
  const q = (sp.get('q') || '').slice(0, 60)
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-8 pb-24 min-h-[70vh]">
      <h1 className="text-2xl font-extrabold text-ink">{t("Search")}</h1>
      {q && <p className="mt-2 text-sm text-muted">{t("We couldn't find that page. Here is what matches its name.")}</p>}
      <div className="mt-5"><SearchBox key={q} initial={q} compact /></div>
    </div>
  )
}

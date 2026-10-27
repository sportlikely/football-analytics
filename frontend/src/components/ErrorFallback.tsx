import { Component, type ReactNode } from 'react'
import { t } from '../lib/i18n'
import { storedHtml } from '../lib/storedHtml'
import { reportError } from '../lib/report'
import { isReloading, isTwoReacts, reloadForNewVersion } from '../lib/chunkReload'

/**
 * fix252c: what an error box shows — the message, "Try again" (a reload) and, on the address the tab was opened on, the
 * page's stored copy from the server (lib/storedHtml.ts), so an error is never a blank page.
 */
export function ErrorFallback({ home }: { home?: string }) {
  const html = storedHtml()
  return (
    <div className="px-4 py-8 space-y-6" role="alert">
      <div className="card p-6 text-center space-y-3 max-w-md mx-auto">
        <div className="font-display text-lg font-bold text-ink">{t("Something went wrong on this page")}</div>
        <p className="text-sm text-muted">{html ? t("This is the last saved copy of the page.") : t("The rest of the site works. Try again, or go back to the home page.")}</p>
        <div className="flex justify-center gap-2 pt-1">
          <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-xl bg-accent text-bg font-semibold text-sm">{t("Try again")}</button>
          {home && <a href={home} className="px-4 py-2 rounded-xl border border-line text-ink font-semibold text-sm">{t("Home")}</a>}
        </div>
      </div>
      {html && <div className="sl-stored text-ink" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  )
}

/**
 * fix252c: the outermost safety net (main.tsx, around the whole app): a crash in the header / menus / router used to
 * unmount everything — a blank page. Two copies of React on the page (the signature of mixed app files) reload once.
 */
export class AppBoundary extends Component<{ children?: ReactNode; home?: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: unknown) {
    if (isReloading() || (isTwoReacts(err) && reloadForNewVersion())) return
    console.error('app error', err)
    reportError(err, 'uncaught')
  }
  render() {
    if (!this.state.failed) return this.props.children
    return isReloading() ? null : <ErrorFallback home={this.props.home} />
  }
}

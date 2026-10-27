import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { loadLocale, redirectToPreferred } from './lib/i18n'
import { watchErrors } from './lib/report'
import { watchChunkErrors, isChunkError, isReloading, reloadForNewVersion, moduleDefault, dropReloadParam } from './lib/chunkReload'
import { watchSeen } from './lib/seen'
import { watchStartupRetry } from './lib/startupRetry'
import { watchProxyCheck } from './lib/proxyCheck'
import { installApiCache } from './lib/apiCache'

// fix227: the loader in index.html retries the app file and shows the 'Updating SportLikely…' card if it never starts
type Boot = { started: () => void; mounted: () => void; fail: (why: string) => void }
const boot = (window as unknown as { __slBoot?: Boot }).__slBoot
boot?.started()

// Broken pictures (Oct 2026): some teams and players have no image at our data provider. Instead of the browser's
// broken-image icon, every picture that fails to load is swapped for a neutral badge, once.
const NO_IMAGE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 4 8 12v18c0 15 10 25 24 30 14-5 24-15 24-30V12L32 4z" fill="#8a93a6" fill-opacity=".22" stroke="#8a93a6" stroke-opacity=".55" stroke-width="3"/><circle cx="32" cy="30" r="9" fill="none" stroke="#8a93a6" stroke-opacity=".6" stroke-width="3"/></svg>'
)
window.addEventListener('error', e => {
  const img = e.target
  if (img instanceof HTMLImageElement && img.dataset.noimg !== '1') {
    img.dataset.noimg = '1'
    img.srcset = ''
    img.src = NO_IMAGE
  }
}, true)

watchErrors()
watchChunkErrors()
watchSeen()
watchStartupRetry()
watchProxyCheck()
installApiCache() // fix250: last known data, 4 s time-out, { pending: true } asked again — never a blank page

// The language comes from the address (/es/...). First visit without one: follow the browser's language.
// The dictionary is loaded before the app's modules run, so labels built at module level are translated too.
if (!redirectToPreferred()) {
  // fix252: the import can come back empty (Vite's loader returns nothing once its vite:preloadError was handled) or
  // without its default export ("Cannot destructure property 'default' of 'undefined'", 26–27 Oct): a failed load —
  // one hard reload for the new version (lib/chunkReload.ts), the loader's card only when that was already tried
  loadLocale().then(() => import('./App')).then(m => {
    if (isReloading()) return
    const App = moduleDefault(m)
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
    boot?.mounted()
    dropReloadParam()
  }).catch(err => {
    // the app file itself from an old version (a cached page): load the new version once
    if (isReloading() || (isChunkError(err) && reloadForNewVersion())) return
    boot?.fail(String((err as Error)?.message || err).slice(0, 200))
    throw err
  })
}

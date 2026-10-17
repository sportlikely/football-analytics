import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { loadLocale, redirectToPreferred } from './lib/i18n'
import { watchErrors } from './lib/report'
import { watchChunkErrors, isChunkError, reloadForNewVersion } from './lib/chunkReload'

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

// The language comes from the address (/es/...). First visit without one: follow the browser's language.
// The dictionary is loaded before the app's modules run, so labels built at module level are translated too.
if (!redirectToPreferred()) {
  loadLocale().then(() => import('./App')).then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  }).catch(err => {
    // the app file itself from an old version (a cached page): load the new version once
    if (!(isChunkError(err) && reloadForNewVersion())) throw err
  })
}

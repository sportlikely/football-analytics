import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { adminPath } from '../lib/adminTabs'

/**
 * fix239: a button from an admin email (/admin/act/<token>): the link is signed, works once, for 72 h, admin only
 * (AdminOnly + the console gate in App.tsx: a signed-out admin is sent to sign in first and comes back here).
 * Opening the page runs it once from this signed-in session; a mail scanner fetching the URL changes nothing.
 * Every use is written to the security log by the server.
 */
interface Result { state: 'ready' | 'used' | 'expired' | 'invalid'; label?: string; usedAt?: string; usedBy?: string; result?: string; message?: string; open?: string }

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }) : '')

export default function AdminAction() {
  const { token = '' } = useParams()
  const [r, setR] = useState<Result | null>(null)
  const [err, setErr] = useState('')
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    axios.post(`${API_URL}/admin/email-action/${encodeURIComponent(token)}`, {})
      .then(x => setR(x.data.data))
      .catch(e => (e?.response?.status === 404 ? setR({ state: 'invalid' }) : setErr(errorText(e))))
  }, [token])

  const done = !!r?.message
  const title = err ? 'Something went wrong' : !r ? 'Working…' : done ? 'Done' : r.state === 'used' ? 'This link was already used' : r.state === 'expired' ? 'This link has expired' : 'This link does not work'
  const text = err || (!r ? '' : done ? r.message : r.state === 'used' ? `${r.label ? `${r.label}: ` : ''}${r.result || 'done'}${r.usedBy ? ` (${r.usedBy}, ${fmt(r.usedAt)} Israel time)` : ''}.`
    : r.state === 'expired' ? 'Email buttons work for 72 hours. Decide it in Admin → Needs you instead.' : 'The link is incomplete or was not made by SportLikely. Open Admin → Needs you instead.')
  return (
    <div className="max-w-md mx-auto px-4 py-16 text-center space-y-4">
      <h1 className={`font-display text-2xl font-extrabold ${done ? 'text-win' : 'text-ink'}`}>{title}</h1>
      {text && <p className="text-sm text-muted">{text}</p>}
      {r && (
        <div className="flex flex-wrap justify-center gap-2">
          <Link to={adminPath('needs-you')} className="inline-block rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">Open in Admin</Link>
          {r.open && <Link to={r.open} className="inline-block rounded-xl border border-line text-ink font-semibold px-4 py-2 text-sm">Open the game</Link>}
        </div>
      )}
    </div>
  )
}

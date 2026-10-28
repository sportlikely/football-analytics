import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { copyLater, forClaudeText, type ForClaudeReq } from '../../lib/forClaude'

/**
 * fix259: the "Copy for Claude" button on every admin / CRM card header and next to every red / yellow item. Click →
 * the self-contained text (backend services/forClaude.ts) on the clipboard, "Copied ✓" for a second. Admin and staff
 * pages only (never imported by a public page: scripts/fix259.test.ts); renders nothing for anyone else.
 */
export default function CopyForClaude({ req, api = 'admin', label = 'Copy for Claude', size = 'md', className = '' }: {
  /** built on click (so it reads the card's text as it is now) */
  req: () => ForClaudeReq
  api?: 'admin' | 'crm'
  label?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const { access, staff: staffOf } = useAuth()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [err, setErr] = useState('')
  const staff = access === 'admin' || (api === 'crm' && !!staffOf)
  if (!staff) return null
  const click = () => {
    if (state === 'busy') return
    setState('busy'); setErr('')
    const text = forClaudeText(req(), api)
    copyLater(text)
      .then(() => { setState('done'); setTimeout(() => setState('idle'), 1000) })
      .catch(e => { setState('error'); setErr(e?.response?.data?.error || e?.message || 'Copy failed'); setTimeout(() => setState('idle'), 4000) })
  }
  const words = state === 'busy' ? 'Copying…' : state === 'done' ? 'Copied ✓' : state === 'error' ? `Copy failed: ${err}` : label
  const cls = size === 'sm'
    ? 'h-6 px-2 rounded-md text-[11px]'
    : 'h-8 px-3 rounded-lg text-xs'
  return (
    <button type="button" onClick={click} data-copy-for-claude="" title="Copies this, with everything Claude needs to fix it, to paste into a Claude chat"
      className={`${cls} shrink-0 font-semibold whitespace-nowrap border transition-colors ${state === 'done' ? 'border-win/50 text-win bg-win/10' : state === 'error' ? 'border-loss/50 text-loss' : 'border-line bg-surface2 text-ink hover:border-accent/50'} ${className}`}>
      {words}
    </button>
  )
}

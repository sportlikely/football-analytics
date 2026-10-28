import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { useAuth } from '../lib/auth'
import { t, lang } from '../lib/i18n'
import { SPORTS, type SportId } from '../lib/sports'

const PLAN: Record<Exclude<SportId, 'football'>, { leagues: string[]; picks: string[] }> = {
  basketball: {
    leagues: ['NBA', 'EuroLeague', 'EuroCup', 'Liga ACB (Spain)', 'Basketbol Süper Ligi (Turkey)', 'Lega Basket Serie A (Italy)', 'LNB Pro A (France)', 'Greek Basket League', 'Basketball Bundesliga', 'Basketball Champions League', 'ABA League', 'LKL (Lithuania)', 'FIBA Europe Cup', 'NBL (Australia)', 'B.League (Japan)', 'CBA (China)', 'NBB (Brazil)', 'BSN (Puerto Rico)'],
    picks: [t('Who wins, with the chance of each side'), t('Point spread and total points'), t('Player form, injuries and rest days')]
  },
  tennis: {
    leagues: ['ATP', 'WTA', 'Grand Slams'],
    picks: [t('Who wins, with the chance of each player'), t('Number of sets and games'), t('Form on each surface: hard, clay and grass')]
  },
  'american-football': {
    leagues: ['NFL', 'College football (NCAA)'],
    picks: [t('Who wins, with the chance of each side'), t('Point spread and total points'), t('Quarterback and key-player availability')]
  },
  // fix186
  baseball: {
    leagues: ['MLB', 'NPB (Japan)', 'KBO (Korea)', 'CPBL (Taiwan)', 'Liga Mexicana de Béisbol', t('Winter leagues: Dominican Republic, Venezuela, Mexico, Puerto Rico'), 'Australian Baseball League'],
    picks: [t('Who wins, with the chance of each side'), t('Run line and total runs'), t('Starting pitchers, bullpen rest and line-ups')]
  }
}

/** "Coming soon" page of a sport we are still building, with a "tell me when it opens" sign-up. */
export default function SportSoon({ sport }: { sport: Exclude<SportId, 'football'> }) {
  const info = SPORTS.find(s => s.id === sport)!
  const plan = PLAN[sport]
  const { user } = useAuth()
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (user?.email) setEmail(user.email) }, [user?.email])
  useEffect(() => { setState('idle'); setError(null) }, [sport])
  useEffect(() => { document.title = t('{0} · SportLikely', { 0: t('{0} predictions', { 0: info.name }) }) }, [info.name])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setState('busy')
    setError(null)
    try {
      await axios.post(`${API_URL}/waitlist`, { email, sport, lang })
      setState('done')
    } catch (err: any) {
      setError(err?.response?.data?.error ? t(err.response.data.error) : t('Something went wrong. Please try again.'))
      setState('error')
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
      <div className="card relative overflow-hidden p-6 sm:p-10">
        <div className="pointer-events-none absolute -end-16 -top-16 text-[180px] sm:text-[240px] leading-none opacity-[0.07] select-none" aria-hidden>{info.icon}</div>
        <span className="inline-block px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-accent/15 text-accent">{t('Coming soon')}</span>
        <h1 className="mt-4 font-display text-3xl sm:text-5xl font-extrabold tracking-tight text-ink">
          <span aria-hidden className="me-2">{info.icon}</span>{t('{0} predictions', { 0: info.name })}
        </h1>
        <p className="mt-3 text-muted max-w-xl">
          {t('We are building a model for {0}, the same way we built football: tested on past seasons first, then every prediction saved before the game and checked in public.', { 0: info.name })}
        </p>

        <div className="mt-8 grid sm:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-line/70 bg-surface2/40 p-4">
            <div className="label mb-2">{t('Competitions')}</div>
            <ul className="space-y-1.5 text-sm text-ink">
              {plan.leagues.map(l => <li key={l} className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />{l}</li>)}
            </ul>
          </div>
          <div className="rounded-2xl border border-line/70 bg-surface2/40 p-4">
            <div className="label mb-2">{t('What you will get')}</div>
            <ul className="space-y-1.5 text-sm text-ink">
              {plan.picks.map(p => <li key={p} className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />{p}</li>)}
            </ul>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-accent/40 bg-accent/5 p-5">
          <div className="font-display font-bold text-ink">{t('Tell me when it opens')}</div>
          <p className="text-sm text-muted mt-1">{t('One email on the day it opens. Nothing else.')}</p>
          {state === 'done' ? (
            <p className="mt-4 text-sm font-semibold text-win">{t("You're on the list. We'll email you when {0} opens.", { 0: info.name })}</p>
          ) : (
            <form onSubmit={submit} className="mt-4 flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('Your email')}
                aria-label={t('Your email')}
                className="flex-1 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
              <button type="submit" disabled={state === 'busy'} className="rounded-xl bg-accent text-bg font-semibold px-5 py-2.5 text-sm disabled:opacity-60">
                {state === 'busy' ? t('Saving…') : t('Notify me')}
              </button>
            </form>
          )}
          {error && <p className="mt-2 text-sm text-loss">{error}</p>}
        </div>

        <div className="mt-8 text-sm">
          <Link to="/" className="font-semibold text-accent">{t('⚽ Football predictions are live now →')}</Link>
        </div>
      </div>
    </div>
  )
}

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import axios from 'axios'
import { API_URL, socket } from './socket'
import { t, noteLangs, initialMenuLangs, type Lang } from './i18n'
import { setLinkAdmin } from './links'
import { resetApiCache } from './apiCache'
import { tg } from './genText'

// Same-origin cookies are sent by default; this also covers a separate API host
axios.defaults.withCredentials = true

export type Access = 'anon' | 'free' | 'premium' | 'pro' | 'admin'

export interface User {
  id: number
  email: string
  name: string | null
  plan: 'free' | 'premium' | 'pro'
  premiumUntil: string | null
  isAdmin: boolean
  emailVerified: boolean
  marketingOptIn: boolean
  createdAt: string
  cancelAt?: string | null
  /** two-step login is on */
  twoFactor?: boolean
  /** this session passed two-step login */
  mfa?: boolean
  /** staff role key (Team & roles in the CRM) */
  role?: string | null
}

/** CRM: 'admin', the staff member's role key, or null */
export type Staff = string | null
/** staff permission keys (backend services/roles.ts) */
export type Perm = 'inbox.read' | 'inbox.reply' | 'inbox.manage' | 'customers.view' | 'customers.plan' | 'customers.security' | 'campaigns' | 'revenue' | 'security' | 'activity' | 'model' | 'team'

/** Sign-in step result: a ticket means a two-step code is still needed. */
export interface SignInStep { ticket?: string }

interface SessionPayload {
  user: User | null
  access: Access
  staff?: Staff
  perms?: Perm[]
  tester?: { until: string } | null
  verificationRequired?: boolean
  /** fix257: the language menu (admins: every language; everyone else: the public ones) */
  langs?: string[]
}

/** fix216: the picks emails opt-in (unchecked by default) and the browser's time zone and language */
export interface SignupExtra { picksOptIn: boolean; tz: string; lang: string }

interface AuthState {
  user: User | null
  /** fix257: languages in the menu for this visitor */
  langs: Lang[]
  access: Access
  staff: Staff
  /** beta tester (invite link): Pro until this date */
  tester: { until: string } | null
  /** what this staff member may do (empty for customers) */
  can: (p: Perm) => boolean
  loading: boolean
  /** Pro or admin: every prediction in full, no counting */
  full: boolean
  /** any paid plan (Premium $15 with unlocks, Pro, admin) */
  paid: boolean
  /** signed in but the email is not confirmed yet */
  needsVerification: boolean
  /** fix168: guard = the hidden field, the form token and the Turnstile token (bot checks) */
  login: (email: string, password: string, guard?: AuthGuard) => Promise<SignInStep>
  /** two-step login: the ticket from login / reset + a 6-digit code or a recovery code */
  loginCode: (ticket: string, code: string) => Promise<void>
  signup: (email: string, password: string, name?: string, optIn?: boolean, adult?: boolean, guard?: AuthGuard, extra?: SignupExtra) => Promise<void>
  verify: (code: string) => Promise<void>
  resendCode: () => Promise<void>
  resetPassword: (email: string, code: string, password: string) => Promise<SignInStep>
  setOptIn: (on: boolean) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/** Readable message from an axios error. */
export function errorText(e: any, fallback = t("Something went wrong. Please try again.")) {
  // fix261: the server's message in the page language when it is in the dictionary (lib/genText.ts)
  const m = e?.response?.data?.error || e?.response?.data?.message
  return m ? tg(String(m)) : fallback
}

// Socket rooms are chosen at connect time from the session cookie — reconnect after sign-in / sign-out
function reconnectSocket() {
  socket.disconnect()
  socket.connect()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [access, setAccess] = useState<Access>('anon')
  const [staff, setStaff] = useState<Staff>(null)
  const [perms, setPerms] = useState<Perm[]>([])
  const [tester, setTester] = useState<{ until: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [verificationRequired, setVerificationRequired] = useState(false)
  const [langs, setLangs] = useState<Lang[]>(initialMenuLangs)

  const apply = (d: SessionPayload) => {
    // fix250: the kept API answers (lib/apiCache.ts) belong to one person and plan
    const who = `${(d.user as { id?: number } | null)?.id ?? 'anon'}:${d.access}`
    try { if (localStorage.getItem('sl-api-who') !== who) { resetApiCache(); localStorage.setItem('sl-api-who', who) } } catch { resetApiCache() }
    setUser(d.user)
    setAccess(d.access)
    setStaff(d.staff ?? null)
    setPerms(d.perms ?? [])
    setTester(d.tester ?? null)
    setLangs(noteLangs(d.langs, d.access === 'admin'))
    if (typeof d.verificationRequired === 'boolean') setVerificationRequired(d.verificationRequired)
  }

  const refresh = useCallback(async () => {
    try {
      const r = await axios.get(`${API_URL}/auth/me`)
      apply(r.data as SessionPayload)
    } catch {
      apply({ user: null, access: 'anon' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // pick up changes made elsewhere (Premium granted/expired, signed out in another tab)
    const onFocus = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [refresh])

  // Live-score rooms (full / teaser) are chosen at connect time: reconnect when the access level changes
  const firstAccess = useRef(true)
  useEffect(() => {
    if (firstAccess.current) {
      firstAccess.current = false
      return
    }
    reconnectSocket()
  }, [access])

  const login = async (email: string, password: string, guard?: AuthGuard): Promise<SignInStep> => {
    const r = await axios.post(`${API_URL}/auth/login`, { email, password, ...(guard || {}) })
    if (r.data?.twoFactor) return { ticket: r.data.ticket }
    apply(r.data)
    return {}
  }

  const loginCode = async (ticket: string, code: string) => {
    const r = await axios.post(`${API_URL}/auth/2fa/login`, { ticket, code })
    apply(r.data)
  }

  const signup = async (email: string, password: string, name?: string, optIn?: boolean, adult?: boolean, guard?: AuthGuard, extra?: SignupExtra) => {
    const r = await axios.post(`${API_URL}/auth/signup`, { email, password, name, optIn: !!optIn, adult: !!adult, ...(guard || {}), ...(extra || {}) })
    apply(r.data)
  }

  const verify = async (code: string) => {
    const r = await axios.post(`${API_URL}/auth/verify`, { code })
    apply(r.data)
  }

  const resendCode = async () => {
    await axios.post(`${API_URL}/auth/verify/resend`)
  }

  const resetPassword = async (email: string, code: string, password: string): Promise<SignInStep> => {
    const r = await axios.post(`${API_URL}/auth/reset`, { email, code, password })
    if (r.data?.twoFactor) return { ticket: r.data.ticket }
    apply(r.data)
    return {}
  }

  const setOptIn = async (on: boolean) => {
    const r = await axios.post(`${API_URL}/auth/preferences`, { optIn: on })
    apply(r.data)
  }

  const logout = async () => {
    try {
      await axios.post(`${API_URL}/auth/logout`)
    } catch {
      /* signed out locally anyway; the next /auth/me call shows the real state */
    }
    apply({ user: null, access: 'anon' })
  }

  // fix243: admins get links to past seasons' matches (lib/links.ts)
  useEffect(() => { setLinkAdmin(access === 'admin') }, [access])
  const full = access === 'pro' || access === 'admin'
  const paid = full || access === 'premium'
  const needsVerification = !!user && verificationRequired && !user.emailVerified

  return (
    <AuthContext.Provider
      value={{ user, langs, access, staff, tester, can: (p: Perm) => perms.includes(p), loading, full, paid, needsVerification, login, loginCode, signup, verify, resendCode, resetPassword, setOptIn, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  )
}

/** fix168: the bot checks a sign-in / sign-up form sends (website = the hidden honeypot field). */
export interface AuthGuard { website?: string; formToken?: string | null; turnstile?: string | null }

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

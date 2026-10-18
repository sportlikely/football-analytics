import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'

const CONTACT = 'contact@sportlikely.com'
const UPDATED = '13 October 2026'
// Operator details: fill in once the company is registered (legal name, registration number, address)
const OPERATOR: string | null = null

// the country data actually in use (DB-IP normally; iptoasn.com when the server had to fall back to it)
const GEO_DEFAULT = { name: 'IP Geolocation by DB-IP', url: 'https://db-ip.com', licence: 'CC BY 4.0' }
function GeoCredit() {
  const [g, setG] = useState(GEO_DEFAULT)
  useEffect(() => {
    axios.get(`${API_URL}/public/geo-source`).then(r => { const d = r.data?.data; if (d?.name && /^https:\/\//.test(d.url)) setG(d) }).catch(() => undefined)
  }, [])
  return <><a href={g.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{g.name}</a> ({g.licence})</>
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{title}</h1>
      <p className="text-xs text-faint mt-2">Last updated {UPDATED}</p>
      <div className="mt-8 space-y-7 text-[15px] leading-relaxed text-muted">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-lg font-bold text-ink mb-2">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}

const Mail = () => (
  <a href={`mailto:${CONTACT}`} className="text-accent hover:underline">
    {CONTACT}
  </a>
)

export function Terms() {
  return (
    <Page title="Terms of use">
      <Section title="What SportLikely is">
        <p>
          SportLikely publishes football and basketball statistics and match predictions made by our own models, together with live
          scores and match statistics from third-party data providers. Predictions are probabilities, not promises: any match can end in
          any result.
        </p>
      </Section>
      <Section title="Not betting advice">
        <p>
          Everything on the site is information and analysis. It is not financial or betting advice, and we do not take bets or pass bets
          to anyone. If you choose to bet, you do so at your own risk and under the laws where you live. Our accuracy record, tests on
          past seasons and any return figures describe the past and do not guarantee future results.
        </p>
      </Section>
      <Section title="18+ only">
        <p>
          You must be at least 18 years old (or the legal age for gambling where you live, if higher) to create an account. If gambling
          stops being fun, stop, and get help, for example from{' '}
          <a href="https://www.begambleaware.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            BeGambleAware
          </a>{' '}
          or a local support service.
        </p>
      </Section>
      <Section title="Your account">
        <p>
          Keep your password to yourself; you are responsible for what happens under your account. We may suspend accounts that abuse the
          service. You can delete your account at any time from your{' '}
          <Link to="/account" className="text-accent hover:underline">account page</Link> (or by writing to <Mail />).
        </p>
      </Section>
      <Section title="Premium">
        <p>
          Paid plans (Premium, Pro) open extra features: full probabilities, the model breakdown, draw picks and the track record.
          Premium includes a monthly number of match unlocks; Pro is unlimited. Every paid plan has a 3-day money-back guarantee: ask
          within 3 days of a payment and we refund it in full. Plans renew automatically until you cancel; cancelling stops the next
          renewal. Payments are handled by a payment provider; we never see or store your card details.
        </p>
      </Section>
      <Section title="Fair use">
        <p>
          Do not copy, scrape, resell or republish our predictions or data in bulk, and do not try to break or overload the site. Personal
          use and sharing the odd screenshot with friends is fine.
        </p>
      </Section>
      <Section title="Data from others">
        <p>
          Fixtures, scores, statistics and lineups come from third-party providers and can be late or wrong. Team names and crests
          belong to their owners and are shown only to identify the teams.
        </p>
      </Section>
      <Section title="Liability">
        <p>
          The service is provided "as is". To the extent the law allows, we are not liable for losses from using the site or relying on
          its content, including betting losses.
        </p>
      </Section>
      <Section title="Who we are">
        <p>{OPERATOR || 'SportLikely is run by its founders. The legal name and registered address of the company operating the site will be added here once it is registered.'}</p>
      </Section>
      <Section title="Changes and contact">
        <p>
          We may update these terms; the date above shows the latest version. Questions: <Mail />. See also our{' '}
          <Link to="/privacy" className="text-accent hover:underline">
            privacy policy
          </Link>
          .
        </p>
      </Section>
    </Page>
  )
}

export function Privacy() {
  return (
    <Page title="Privacy policy">
      <Section title="Who is responsible">
        <p>
          {OPERATOR || 'SportLikely (the legal name and address of the operating company will be added here once it is registered).'} Contact for
          anything about your data: <Mail />.
        </p>
      </Section>
      <Section title="What we collect">
        <p>
          <span className="text-ink font-semibold">Account:</span> your email address, an optional name, and a scrambled (hashed) version of
          your password. We never store the password itself. We also store whether you confirmed your email, your plan, when you joined
          and last signed in, and whether you asked for update emails (with the date you chose it).
        </p>
        <p>
          <span className="text-ink font-semibold">What you do in your account:</span> your favorite teams, leagues and players, the matches
          you unlocked, and the sports you asked to be told about. If you cancel a plan or delete your account, we ask why and keep
          your answer to improve the service (for deleted accounts, without your email or anything that links it to you). Signed-in devices are kept as a list with the browser name, so we can
          sign you out everywhere when you change your password.
        </p>
        <p>
          <span className="text-ink font-semibold">Messages to us:</span> when you use the{' '}
          <Link to="/contact" className="text-accent hover:underline">contact form</Link> or email us, we keep your email address, name
          (if given) and message to answer you and to improve the service. Messages linked to an account are deleted with it.
        </p>
        <p>
          <span className="text-ink font-semibold">Security:</span> when you sign in, use two-step login or change your password or
          security settings, we record the time, your IP address and your browser in a security log, to protect accounts from
          break-ins. It is kept for 90 days and included in "Download my data". Failed sign-in attempts are also counted in memory for
          about 15 minutes to stop password guessing. Server logs keep the pages requested, for troubleshooting. Creating an
          account (and signing in after several failed attempts) uses Cloudflare Turnstile to prevent automated accounts.
        </p>
        <p>
          <span className="text-ink font-semibold">Visitor counts:</span> to know how many people use the site, we count visits per day using
          a scrambled version of the IP address (a one-way code with a secret key). It cannot be turned back into the IP address, is not
          linked to your account, and is deleted after 90 days. We also note which country the visit came from, looked up from the IP
          address at the moment of the visit (the address itself is not kept). Country data:{' '}
          <GeoCredit />.
        </p>
        <p>
          <span className="text-ink font-semibold">Cookies and browser storage:</span> one cookie keeps you signed in (needed for accounts to
          work). Your settings (theme, language, accessibility options, pinned leagues, favorites before you sign in, the predictions you
          revealed, "guess first", and your chat with the assistant) are saved in your own browser and never sent to us unless you sign in. We use no advertising or tracking cookies and no analytics
          services, so there is nothing to consent to.
        </p>
      </Section>
      <Section title="What we use it for">
        <p>
          To run your account, send the codes that confirm your email or reset your password, show your favorites and unlocked matches,
          keep the site secure, count visitors, and, only if you ticked the box, send occasional updates. You can switch updates off in
          your account at any time. Legal basis: running the service you signed up for, our legitimate interest in security and simple
          statistics, and your consent for update emails.
        </p>
      </Section>
      <Section title="Who else handles it">
        <p>
          Our hosting provider (Railway) runs the servers and database. Our email provider (Resend) sends the confirmation and reset
          emails. When payments launch, the payment provider will handle billing and card details; we never see your card. Fonts and
          pictures of teams come from our own server or from our sports-data providers, which receive no data about you beyond what any
          website receives when an image loads. These providers may process data outside your country; we only use providers that
          protect it with the safeguards the law requires. If the AI assistant is switched on and you use it, your questions and the
          match you are looking at are sent to our AI provider (Anthropic) to write the answer; we keep only counts of how much it is
          used. We do not sell your data or share it with advertisers.
        </p>
      </Section>
      <Section title="How long we keep it">
        <p>
          For as long as your account exists. Confirmation and reset codes expire within minutes; signed-in sessions expire on their own.
          Visitor counts are deleted after 90 days. If you delete your account, we delete your details and everything linked to them,
          except where the law requires us to keep records (for example, payment records).
        </p>
      </Section>
      <Section title="Your rights">
        <p>
          You can see, correct, download or delete your data, or object to how we use it. Two of these work by yourself on your{' '}
          <Link to="/account" className="text-accent hover:underline">account page</Link>: <span className="text-ink">Download my data</span> gives you
          a file with everything we store about your account, and <span className="text-ink">Delete my account</span> removes it. For anything
          else, write to <Mail /> or use the <Link to="/contact" className="text-accent hover:underline">contact form</Link>; we answer within 30 days. You can also complain to the data protection authority where you live.
        </p>
      </Section>
      <Section title="Children">
        <p>SportLikely is for adults. Accounts are for people aged 18 or over, and we do not knowingly collect data about children.</p>
      </Section>
      <Section title="Changes">
        <p>
          If we change this policy, the date above changes; for important changes we will tell signed-in users. See also our{' '}
          <Link to="/terms" className="text-accent hover:underline">
            terms of use
          </Link>
          .
        </p>
      </Section>
    </Page>
  )
}

export function NotFound() {
  return (
    <div className="max-w-xl mx-auto px-4 py-20 text-center">
      <div className="font-display text-6xl font-extrabold text-accent">404</div>
      <h1 className="text-ink font-semibold mt-3">This page doesn't exist.</h1>
      <p className="text-sm text-muted mt-1">The link may be old, or the match may have been removed.</p>
      <Link to="/" className="inline-block mt-6 px-4 py-2 rounded-xl bg-accent text-bg font-semibold text-sm">
        Back to home
      </Link>
    </div>
  )
}

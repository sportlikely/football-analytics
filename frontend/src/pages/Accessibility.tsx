import { Link } from 'react-router-dom'

const UPDATED = '6 October 2026'
const CONTACT = 'accessibility@sportlikely.com' // the accessibility contact (set up the inbox or change the address)

/** Accessibility statement (Israeli regulations / IS 5568, EU Accessibility Act). */
export default function Accessibility() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-10">
      <section className="space-y-4">
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">Accessibility statement</h1>
        <p className="text-muted">
          SportLikely wants every visitor to be able to use the site, including people with disabilities. We work to the Israeli
          accessibility regulations (Equal Rights for Persons with Disabilities, service accessibility regulations 2013, Israeli
          Standard 5568) and to WCAG 2.1 level AA, which also covers the EU Accessibility Act.
        </p>
        <h2 className="font-display text-xl font-bold text-ink">What the site offers</h2>
        <ul className="list-disc ps-5 space-y-1.5 text-muted">
          <li>An accessibility menu on every page (the blue button at the bottom left): larger text in three steps, high contrast, inverted colours, grayscale, a readable font, highlighted links, more line spacing, stopped animations and a bigger cursor. Your choices are remembered on your device.</li>
          <li>Light and dark mode (the sun / moon button at the top).</li>
          <li>Keyboard use: every link, tab and button can be reached with Tab and activated with Enter or Space; the focused element is clearly outlined; a "Skip to content" link appears on the first Tab press.</li>
          <li>Screen readers: headings on every page, descriptive labels on icon buttons and the search box, images of crests and flags marked as decorative, tables with proper headers, the page language declared.</li>
          <li>Text can be enlarged with the browser's zoom up to 200% without losing content; the site works on phones and tablets.</li>
          <li>No content flashes; animations are short and can be switched off at any time with "Stop animations" in the accessibility menu.</li>
        </ul>
        <h2 className="font-display text-xl font-bold text-ink">Known limitations</h2>
        <ul className="list-disc ps-5 space-y-1.5 text-muted">
          <li>The football pitch view of line-ups is a picture built from player names; the same line-ups are listed as text under it.</li>
          <li>Team crests, player photos and news pictures come from outside data providers and may have no description.</li>
          <li>Video highlights are embedded from YouTube and follow YouTube's accessibility.</li>
        </ul>
        <h2 className="font-display text-xl font-bold text-ink">Contact</h2>
        <p className="text-muted">
          If something on the site is hard to use, or you need information in another form, write to{' '}
          <a href={`mailto:${CONTACT}`} className="font-semibold text-accent">{CONTACT}</a>. Please say which page and what happened; we answer
          within 7 working days. The accessibility coordinator is responsible for this statement.
        </p>
        <p className="text-xs text-faint">Last updated {UPDATED}. We review this statement whenever the site changes significantly, and at least once a year.</p>
      </section>


      <p className="text-sm">
        <Link to="/" className="font-semibold text-accent"><span aria-hidden className="rtl-flip">←</span> Back to the site</Link>
      </p>
    </div>
  )
}

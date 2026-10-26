import type { ComponentProps } from 'react'
import { Link } from 'react-router-dom'

/**
 * fix243: a link when there is an address, else the same content without one — a past season's match has no public
 * page (lib/links.ts matchHref gives null for non-admins), so a list row of it (head-to-head, form, game log) is text.
 */
export function MaybeLink({ to, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { to: string | null | undefined }) {
  if (to) return <Link to={to} {...rest} />
  const { className, title, children, style } = rest
  return <span className={className} title={title} style={style}>{children}</span>
}

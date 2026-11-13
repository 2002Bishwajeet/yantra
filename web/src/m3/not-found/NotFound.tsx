import { useEffect, useId, type ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { SearchX } from 'lucide-react'
import { useScreenTitle } from '@/shell/title'
import { Button } from '../button/Button'
import { Page } from '../page/Page'
import { PageHeader } from '../page/PageHeader'
import { Text } from '../text/Text'
import './NotFound.css'

export type NotFoundProps = Pick<LinkProps, 'to' | 'params'> & {
  /** Names what the address carried: "No machine is called box". */
  headline: string
  /** One sentence on what to do instead. */
  children: ReactNode
  /** The way out, as a word: "Machines". */
  label: string
}

/** Every missing name or path draws this and nothing else. `web.rs` answers an
 *  unknown path with the app, so the page is a 200; it is not an alert, because
 *  a missing page is not a failure the live region must announce. */
export function NotFound(props: NotFoundProps) {
  const { headline, children, label, to, params } = props
  const id = useId()
  useScreenTitle('Not found')
  useEffect(() => {
    const before = document.title
    document.title = 'Not found · Yantra'
    return () => {
      document.title = before
    }
  }, [])
  return (
    <Page>
      <PageHeader title="Not found" />
      <section className="m3-not-found" aria-labelledby={id}>
        <span className="m3-not-found__mark" aria-hidden="true">
          <SearchX />
        </span>
        <div className="m3-not-found__text">
          <h2 className="m3-not-found__headline m3-wrap" id={id}>
            {headline}
          </h2>
          <Text render={<p />} scale="body-medium" tone="variant" className="m3-not-found__sentence">
            {children}
          </Text>
        </div>
        <Button className="m3-not-found__way" render={<Link params={params} to={to} />} role="link" variant="tonal">
          {label}
        </Button>
      </section>
    </Page>
  )
}

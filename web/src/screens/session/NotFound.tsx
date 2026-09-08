import { Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { State } from '@/m3/mark/Mark'
import { Text } from '@/m3/text/Text'

/** The WorkspaceNotFound board: the name the URL carried, and the way to the
 *  list. A 200, not a 404 — `web.rs` answers every path with the app. */
export function NotFound(props: { name: string }) {
  const { name } = props
  return (
    <>
      <Text render={<h1 />} scale="display-small" emphasized clip>
        {name}
      </Text>
      <Card className="session__notfound">
        <State state="unknown">not found</State>
        <div>
          <Text render={<h2 />} scale="title-large">
            No workspace is called {name}.
          </Text>
          <Text render={<p />} scale="body-medium" tone="variant">
            The fleet lists the ones there are.
          </Text>
        </div>
        <div>
          <Button icon={<ArrowRight />} role="link" render={<Link to="/fleet" />} variant="tonal">
            Fleet
          </Button>
        </div>
      </Card>
    </>
  )
}

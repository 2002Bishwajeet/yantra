import type { ApiError } from '@/api/errors'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'

/** Each way the Y-368 trigger can fail is a different thing to fix. */
export function refused(error: ApiError, unanswered = 'The daemon did not answer, so no update was asked for'): string {
  if (error.kind === 'network') return unanswered
  switch (error.status) {
    case 403:
      return 'This device may not update the daemon'
    case 409:
      return 'This box cannot update itself'
    case 503:
      return 'The daemon could not tell who is asking'
    default:
      return 'The update was refused'
  }
}

/** The page's chunks belong to the old build, so a new version needs a reload. */
export function Reload(props: { running: string; asked: string }) {
  const { running, asked } = props
  return (
    <div className="settings__update" role="status">
      <Text render={<p />} scale="body-medium">
        yantrad <Mono>{running}</Mono> is running. This page is still the <Mono>{asked}</Mono> dashboard.
      </Text>
      <Button onClick={() => location.reload()} type="button" variant="tonal">
        Reload
      </Button>
    </div>
  )
}

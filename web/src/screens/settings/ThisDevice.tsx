import { BellRing, Send } from 'lucide-react'
import type { ApiError } from '@/api/errors'
import { askPermission, type PushState, usePush, useTestPush, useTurnOffPush, useTurnOnPush } from '@/api/push'
import { Button } from '@/m3/button/Button'
import { Lead } from '@/m3/lead/Lead'
import { ListItem } from '@/m3/list/List'
import { Text } from '@/m3/text/Text'
import { Group, Note } from './Group'

/** What the row says under its headline, for each thing a browser can be. */
function supporting(state: PushState | undefined): string {
  if (!state) return 'Checking this browser'
  if (state.kind === 'on') return 'On · alerts arrive on this device'
  if (state.kind === 'off') return 'Off'
  if (state.kind === 'blocked') return "Blocked · allow notifications for Yantra in this device's settings"
  if (state.why === 'install') return 'Add Yantra to the Home Screen first: tap Share, then Add to Home Screen. Turn notifications on there.'
  if (state.why === 'insecure') return 'Open Yantra at its https address to get notifications on this device.'
  return 'This browser cannot get notifications from Yantra.'
}

/** One sentence per way a tap can fail; the daemon's own words go under it. */
function sentence(error: ApiError, doing: 'on' | 'off' | 'test'): string {
  if (error.kind === 'network') return 'Yantra did not answer. Try again.'
  if (doing === 'test') {
    if (error.kind === 'missing') return 'Yantra no longer lists this device. Turn notifications on again.'
    if (error.status === 502) return 'The test alert did not reach this device.'
  }
  if (doing === 'on') {
    if (error.status === 409) return 'Yantra could not add this device.'
    if (error.status === 500) return 'Yantra could not save its notification key, so notifications stay off.'
  }
  return error.describe()
}

/** ADR-0047: Web Push for the browser that shows this page. The tap starts
 *  the browser's prompt before anything else, because iOS allows the prompt
 *  only from a tap. */
export function ThisDevice() {
  const push = usePush()
  const on = useTurnOnPush()
  const off = useTurnOffPush()
  const test = useTestPush()
  // A browser that cannot say is one that cannot be subscribed.
  const state: PushState | undefined = push.error ? { kind: 'unsupported', why: 'browser' } : push.data
  const busy = on.isPending || off.isPending

  const turnOn = () => {
    off.reset()
    test.reset()
    on.mutate(askPermission())
  }
  const turnOff = (endpoint: string) => {
    on.reset()
    test.reset()
    off.mutate(endpoint)
  }

  const failed = on.error
    ? { error: on.error, doing: 'on' as const }
    : off.error
      ? { error: off.error, doing: 'off' as const }
      : test.error
        ? { error: test.error, doing: 'test' as const }
        : null

  return (
    <>
      <Group label="This device">
        <ListItem
          headline="Notifications"
          leading={
            <Lead>
              <BellRing />
            </Lead>
          }
          stack
          supporting={supporting(state)}
          trailing={
            state?.kind === 'on' ? (
              <Button disabled={busy} onClick={() => turnOff(state.endpoint)} variant="text">
                {off.isPending ? 'Turning off…' : 'Turn off'}
              </Button>
            ) : state?.kind === 'off' ? (
              <Button disabled={busy} onClick={turnOn} variant="tonal">
                {on.isPending ? 'Turning on…' : 'Turn on'}
              </Button>
            ) : null
          }
        />
        {state?.kind === 'on' ? (
          <ListItem
            headline="Test alert"
            leading={
              <Lead>
                <Send />
              </Lead>
            }
            stack
            supporting={test.isSuccess ? 'Sent · look for it on this device' : 'Sends one alert to this device'}
            trailing={
              <Button disabled={test.isPending || busy} onClick={() => test.mutate(state.endpoint)} variant="text">
                {test.isPending ? 'Sending…' : 'Send a test'}
              </Button>
            }
          />
        ) : null}
      </Group>
      {failed ? (
        <div className="settings__outcome" role="alert">
          <Text render={<p />} scale="body-medium" tone="error" emphasized>
            {sentence(failed.error, failed.doing)}
          </Text>
          {failed.error.said ? (
            <Text className="settings__said" scale="body-small">
              {failed.error.said}
            </Text>
          ) : null}
        </div>
      ) : null}
      <Note>
        Yantra alerts this device when an agent needs you or a session ends. A tap opens that session. It stays quiet
        while a dashboard is open.
      </Note>
    </>
  )
}

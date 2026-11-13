import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, Smartphone } from 'lucide-react'
import { aboutQuery } from '@/api/queries'
import { OriginMismatch, RESTART, useSignIn } from '@/api/passkey'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Eyebrow, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import './SignIn.css'

const NAME = 'yantra.device'

/** A first guess at what the owner calls this device; they can change it. */
function guessed(): string {
  try {
    const kept = localStorage.getItem(NAME)
    if (kept) return kept
  } catch {
    // Private mode: the guess below is enough.
  }
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  if (/Android/.test(agent)) return 'Android phone'
  if (/Mac/.test(agent)) return 'Mac'
  return 'This computer'
}

function keep(name: string) {
  try {
    localStorage.setItem(NAME, name)
  } catch {
    // Only a convenience.
  }
}

/** The two ways out of a page that is under the wrong name. The address is the
 *  daemon's own `https` origin when it carries the passkeys' host, because a
 *  bare host opens on :443 and the dashboard sits on :8443 (ADR-0044). */
function OriginFix({ error }: { error: OriginMismatch }) {
  const about = useQuery(aboutQuery())
  const known = about.data?.https
  const open = known?.startsWith(`https://${error.rpId}:`) ? known : `https://${error.rpId}`
  return (
    <ol className="sign-in__fix">
      <li>
        <Eyebrow>Option 1 · Open the right address</Eyebrow>
        <Button variant="tonal" render={<a href={open} />} role="link" className="sign-in__fix-link">
          {open}
        </Button>
      </li>
      <li>
        <Eyebrow>Option 2 · Keep this address</Eyebrow>
        <Text scale="body-small" tone="variant">
          On the hub, add this line to /etc/yantra/daemon.env, then restart. Every device sets up its passkey again.
        </Text>
        <Copyable text={error.line} what="the YANTRA_ORIGIN line" line />
        <Copyable text={RESTART} what="the restart command" line />
      </li>
    </ol>
  )
}

/** ADR-0044's sign-in screen, drawn in place of every route while the daemon
 *  answers 401. The ceremony starts only on a tap, because Safari refuses a
 *  passkey prompt that no gesture started. */
export function SignIn() {
  const [device, setDevice] = useState(guessed)
  const [enrolling, setEnrolling] = useState(false)
  const [code, setCode] = useState('')
  const sign = useSignIn()
  const named = device.trim()

  const go = (withCode: boolean) => {
    keep(named)
    sign.mutate({ device: named, code: withCode ? code.trim() : undefined })
  }

  return (
    <main className="sign-in">
      <div className="sign-in__card">
        <span className="sign-in__mark" aria-hidden="true">
          <KeyRound />
        </span>
        <h1 className="sign-in__title">Sign in to Yantra</h1>
        <Text render={<p />} scale="body-medium" tone="variant" className="sign-in__lead">
          Yantra opens only for your passkey. Use the passkey on this device, or the phone that holds it.
        </Text>

        <TextField
          label="This device's name"
          value={device}
          onValueChange={setDevice}
          autoComplete="off"
          enterKeyHint="done"
          maxLength={40}
          supporting="Devices in Settings lists it under this name."
        />

        {enrolling ? (
          <form
            className="sign-in__enrol"
            onSubmit={(event) => {
              event.preventDefault()
              go(true)
            }}
          >
            <TextField
              label="Code"
              value={code}
              onValueChange={(value) => setCode(value.toUpperCase())}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              maxLength={8}
              className="sign-in__code"
              supporting="Run yantra passkey code on the hub, or open Settings → Devices on a signed-in device."
            />
            <Button
              type="submit"
              size="m"
              icon={<Smartphone />}
              disabled={sign.isPending || code.trim().length !== 8 || named === ''}
            >
              {sign.isPending ? 'Waiting for the passkey…' : 'Set up this device'}
            </Button>
            <Button variant="text" onClick={() => setEnrolling(false)} disabled={sign.isPending}>
              I already have a passkey
            </Button>
          </form>
        ) : (
          <div className="sign-in__actions">
            <Button size="m" icon={<KeyRound />} onClick={() => go(false)} disabled={sign.isPending || named === ''}>
              {sign.isPending ? 'Waiting for the passkey…' : 'Sign in with a passkey'}
            </Button>
            <Button variant="text" onClick={() => setEnrolling(true)} disabled={sign.isPending}>
              Set up this device with a code
            </Button>
          </div>
        )}

        {sign.error ? (
          <ErrorSurface.Inline
            title={enrolling ? 'This device is not set up' : 'This device is not signed in'}
            error={sign.error}
            action={
              sign.error instanceof OriginMismatch ? (
                <OriginFix error={sign.error} />
              ) : (
                <Button variant="tonal" onClick={() => go(enrolling)}>
                  Try again
                </Button>
              )
            }
          />
        ) : null}
      </div>
    </main>
  )
}

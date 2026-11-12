import { lazy, type ReactNode, type RefObject, Suspense, useRef, useState } from 'react'
import { useSshIdentity } from '@/api/hooks'
import { asApiError } from '@/api/errors'
import { BottomSheet, BottomSheetPopup } from '@/m3/bottom-sheet/BottomSheet'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { Copyable } from '@/m3/copyable/Copyable'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { SideSheet } from '@/m3/side-sheet/SideSheet'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { useFormFactor } from '@/shell/formFactor'
import { adminProblem, problemWords, rememberAdmin, rememberedAdmin } from './owner'
import './SudoSheet.css'
import './OwnerTerminal.css'

// xterm.js is a third of a chunk, and only an open owner terminal needs it.
const Terminal = lazy(() => import('@/screens/session/Terminal').then((module) => ({ default: module.Terminal })))

function ended(exit: number | null, machine: string, admin: string): string {
  if (exit === 255) {
    return `ssh ended it with status 255: ${machine} refused the key or could not be reached. Check that the line is in ~${admin}/.ssh/authorized_keys.`
  }
  if (exit === null) return 'The shell ended with no status to read.'
  return exit === 0 ? 'The shell ended.' : `The shell ended with status ${exit}.`
}

export function Shell(props: { machine: string; admin: string; height: string; typeIn?: string }) {
  const { machine, admin, height, typeIn } = props
  const [exit, setExit] = useState<number | null | undefined>(undefined)
  return (
    <div className="sudo-sheet__body">
      <Text render={<p />} scale="body-medium">
        You are {admin} on {machine}. Your sudo password goes there as keystrokes; Yantra does not keep it.
      </Text>
      <Text render={<p />} scale="body-small" tone="variant">
        Closing this hangs up the shell.
      </Text>
      {typeIn ? (
        <Text render={<p />} scale="body-medium">
          The command is typed in. Read it, press Enter, then type your password.
        </Text>
      ) : null}
      {/* Escape belongs to the shell: the sheet closing on it would hang up
          sudo in the middle of a password. */}
      <div
        className="sudo-sheet__pane"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation()
        }}
      >
        <Suspense fallback={<Skeleton shape="block" style={{ height }} />}>
          <Terminal
            height={height}
            label={`${admin} on ${machine}`}
            onExit={setExit}
            target={{ machine, owner: admin }}
            typeIn={typeIn}
          />
        </Suspense>
      </div>
      {exit === undefined ? null : (
        <Text render={<p />} className="sudo-sheet__said" scale="body-medium">
          {ended(exit, machine, admin)}
        </Text>
      )}
    </div>
  )
}

/** ADR-0046 §2: a side sheet beside the page, and the full height on the
 *  phone, as the sudo step's is. The shell is mounted only while the sheet is
 *  open, so closing it closes the socket. */
export function OwnerSheet(props: {
  machine: string
  admin: string
  open: boolean
  opener: RefObject<HTMLButtonElement | null>
  onClose: () => void
  typeIn?: string
  /** Drawn in place of the shell, for a sheet that has no account yet. */
  ask?: ReactNode
}) {
  const { machine, admin, open, opener, onClose, typeIn, ask } = props
  const phone = useFormFactor() === 'phone'
  const title = ask ? `Owner terminal on ${machine}` : `${admin} on ${machine}`
  const body = ask ?? <Shell admin={admin} height={phone ? '45dvh' : '55vh'} machine={machine} typeIn={typeIn} />
  if (phone) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
      >
        <BottomSheetPopup
          actions={
            <Button onClick={onClose} variant="text">
              Close
            </Button>
          }
          className="sudo-sheet sudo-sheet--phone"
          finalFocus={opener}
          title={title}
        >
          {open ? body : null}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }
  return (
    <SideSheet actions={null} className="sudo-sheet sudo-sheet--side" onClose={onClose} open={open} title={title}>
      {open ? body : null}
    </SideSheet>
  )
}

/** The `authorized_keys` line. `null` is a hub with no key yet (a 404), which
 *  is a state of the card; a failed read is drawn inline. */
function KeyLine(props: { machine: string; admin: string }) {
  const { machine, admin } = props
  const identity = useSshIdentity()
  if (identity.error) {
    return (
      <ErrorSurface.Inline
        error={asApiError(identity.error)}
        reset={() => void identity.refetch()}
        title="The hub's key could not be read"
      />
    )
  }
  const key = identity.data
  if (key === undefined) return <Skeleton shape="text" style={{ width: '72%' }} />
  if (key === null) {
    return (
      <div className="owner-terminal__key">
        <Text render={<p />} className="owner-terminal__note" scale="body-medium">
          The hub has no ssh key yet. Run this on the hub, and the line to add shows here.
        </Text>
        <Copyable text="yantra ssh-identity" what="the command" />
      </div>
    )
  }
  return (
    <div className="owner-terminal__key">
      <Text render={<p />} className="owner-terminal__note" scale="body-medium">
        Add this line once to <strong className="owner-terminal__path">~{admin || '<admin>'}/.ssh/authorized_keys</strong>{' '}
        on {machine}. It lets the hub's key in from the hub's own address.
      </Text>
      <Copyable text={key.owner_line} what="the authorized_keys line" />
    </div>
  )
}

/** Y-701, ADR-0046 §2: a login shell as the owner's admin account, where sudo
 *  asks for the owner's password. The name is kept per machine in this
 *  browser; the daemon keeps nothing. */
export function OwnerTerminal(props: { machine: string }) {
  const { machine } = props
  const phone = useFormFactor() === 'phone'
  const [admin, setAdmin] = useState(() => rememberedAdmin(machine))
  const [asked, setAsked] = useState(false)
  // The account the open sheet logged in as: an edit to the field while it is
  // open must not reopen the socket as someone else.
  const [openAs, setOpenAs] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const problem = adminProblem(admin)
  const error = problem && (admin !== '' || asked) ? problemWords[problem] : undefined

  const start = () => {
    setAsked(true)
    if (problem) field.current?.focus()
    else setOpenAs(admin)
  }

  return (
    <Card aria-labelledby="machine-owner" className="machine__card owner-terminal">
      <div className="machine__head">
        <Text render={<h2 />} emphasized id="machine-owner" scale="title-large">
          Owner terminal
        </Text>
      </div>
      <Text render={<p />} className="owner-terminal__note" scale="body-medium" tone="variant">
        A shell as your admin account on {machine}, for the commands that need sudo. The agent never gets it.
      </Text>
      <TextField
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="go"
        error={error}
        label="Admin account"
        onKeyDown={(event) => {
          if (event.key === 'Enter') start()
        }}
        onValueChange={(value: string) => {
          setAdmin(value)
          rememberAdmin(machine, value)
        }}
        ref={field}
        spellCheck={false}
        supporting="The account you use sudo as. Kept in this browser."
        value={admin}
      />
      {phone ? (
        <Disclosure summary="The authorized_keys line">
          <KeyLine admin={admin} machine={machine} />
        </Disclosure>
      ) : (
        <KeyLine admin={admin} machine={machine} />
      )}
      <div className="owner-terminal__actions">
        <Button onClick={start} ref={opener} variant="tonal">
          Open owner terminal
        </Button>
      </div>
      <OwnerSheet
        admin={openAs ?? admin}
        machine={machine}
        onClose={() => setOpenAs(null)}
        open={openAs !== null}
        opener={opener}
      />
    </Card>
  )
}

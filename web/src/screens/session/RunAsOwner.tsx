import { type RefObject, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { adminProblem, type OwnerRun, ownerRun, problemWords, rememberAdmin } from '@/screens/machine/owner'
import { OwnerSheet } from '@/screens/machine/OwnerTerminal'
import { spelled, type Sudo } from './sudo'
import './RunAsOwner.css'

function Ask(props: { machine: string; onOpen: (admin: string) => void }) {
  const { machine, onOpen } = props
  const [name, setName] = useState('')
  const [asked, setAsked] = useState(false)
  const problem = adminProblem(name)
  const error = problem && (name !== '' || asked) ? problemWords[problem] : undefined
  const go = () => {
    setAsked(true)
    if (problem) return
    rememberAdmin(machine, name)
    onOpen(name)
  }
  return (
    <div className="run-owner__ask">
      <Text render={<p />} scale="body-medium">
        Name the admin account you use sudo as on {machine}. Yantra keeps the name in this browser.
      </Text>
      <TextField
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="go"
        error={error}
        label="Admin account"
        onKeyDown={(event) => {
          if (event.key === 'Enter') go()
        }}
        onValueChange={setName}
        spellCheck={false}
        value={name}
      />
      <Text render={<p />} scale="body-small" tone="variant">
        The hub's key must be in that account's authorized_keys.{' '}
        <Link className="m3-hit" params={{ machine }} to="/m/$machine">
          Get the line on {machine}
        </Link>
      </Text>
      <Button className="run-owner__button" onClick={go} variant="tonal">
        Open owner terminal
      </Button>
    </div>
  )
}

/** The owner terminal with a command typed in, never sent. It asks for the
 *  admin account first when this browser keeps none. It is drawn on the body,
 *  so what hides or redraws around its button cannot take an open shell away. */
export function OwnerRunSheet(props: {
  machine: string
  run: OwnerRun | null
  opener: RefObject<HTMLElement | null>
  onRun: (next: OwnerRun | null) => void
}) {
  const { machine, run, opener, onRun } = props
  const admin = run?.admin ?? null
  return createPortal(
    <OwnerSheet
      admin={admin ?? ''}
      ask={admin === null ? <Ask machine={machine} onOpen={(named) => run && onRun({ ...run, admin: named })} /> : undefined}
      machine={machine}
      onClose={() => onRun(null)}
      open={run !== null}
      opener={opener}
      typeIn={run?.command}
    />,
    document.body,
  )
}

/** ADR-0046 decision 3: a sudo command from Claude, typed into the owner's own
 *  shell for the owner to read and send. Nothing it prints goes back to the agent. */
export function RunAsOwner(props: { machine: string; sudo: Sudo }) {
  const { machine, sudo } = props
  const opener = useRef<HTMLButtonElement>(null)
  const [run, setRun] = useState<OwnerRun | null>(null)

  if (sudo.refused) {
    return (
      <div className="run-owner">
        <Text render={<p />} scale="body-medium">
          This command holds a hidden character, so Yantra will not type it or copy it. Each hidden
          character shows as an escape. Copy it by hand if you trust it.
        </Text>
        <Mono className="run-owner__command" translate="no">
          {spelled(sudo.command).map((part, at) =>
            part.escape ? (
              <span className="run-owner__escape" key={at}>
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )}
        </Mono>
      </div>
    )
  }

  return (
    <div className="run-owner">
      <Button
        className="run-owner__button"
        disabled={machine === ''}
        onClick={() => setRun(ownerRun(machine, sudo.command))}
        ref={opener}
        variant="tonal"
      >
        Run in owner terminal
      </Button>
      <OwnerRunSheet machine={machine} onRun={setRun} opener={opener} run={run} />
    </div>
  )
}

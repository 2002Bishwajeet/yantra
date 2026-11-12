import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button } from '@/m3/button/Button'
import { Copyable } from '@/m3/copyable/Copyable'
import { Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { adminProblem, problemWords, rememberAdmin, rememberedAdmin } from '@/screens/machine/owner'
import { OwnerSheet } from '@/screens/machine/OwnerTerminal'
import type { Sudo } from './sudo'
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

/** ADR-0046 decision 3: a sudo command from Claude, typed into the owner's own
 *  shell for the owner to read and send. Nothing it prints goes back to the agent. */
export function RunAsOwner(props: { machine: string; sudo: Sudo }) {
  const { machine, sudo } = props
  const opener = useRef<HTMLButtonElement>(null)
  const [asking, setAsking] = useState(false)
  const [openAs, setOpenAs] = useState<string | null>(null)

  if (sudo.refused) {
    return (
      <div className="run-owner">
        <Text render={<p />} scale="body-medium">
          This command holds a control character, so Yantra will not type it. Copy it by hand.
        </Text>
        <Copyable text={sudo.command} what="the command" />
      </div>
    )
  }

  const start = () => {
    const kept = rememberedAdmin(machine)
    if (adminProblem(kept)) setAsking(true)
    else setOpenAs(kept)
  }
  const close = () => {
    setAsking(false)
    setOpenAs(null)
  }

  return (
    <div className="run-owner">
      <Button className="run-owner__button" disabled={machine === ''} onClick={start} ref={opener} variant="tonal">
        Run in owner terminal
      </Button>
      <OwnerSheet
        admin={openAs ?? ''}
        ask={openAs === null ? <Ask machine={machine} onOpen={setOpenAs} /> : undefined}
        machine={machine}
        onClose={close}
        open={asking || openAs !== null}
        opener={opener}
        typeIn={sudo.command}
      />
    </div>
  )
}

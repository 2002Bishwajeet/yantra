import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '@/m3/button/Button'
import { TextField } from '@/m3/text-field/TextField'
import { crumbs } from './dirs'
import { typing } from './keys'

/** The crumbs from `/` to the folder you are in. Given `onEdit`, `/` or
 *  Ctrl+L, and the Edit button, swap them for a field that holds the path:
 *  Enter hands it to `onEdit`, Escape gives the crumbs back. */
export function PathBar(props: {
  here: string | null
  home: string | null
  /** The listing failed: the field is then the only way in (D4 §4.2). */
  failed?: boolean
  onGo: (path: string | null) => void
  onEdit?: (path: string) => Promise<void>
}) {
  const { here, home, onGo, onEdit } = props
  const failed = props.failed ?? false
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bad, setBad] = useState(false)
  // Set only when the user leaves an edit, so a field that closes for another reason keeps focus where it is.
  const leaving = useRef(false)
  const field = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const was = useRef(false)
  const editing = text !== null || failed

  const open = useEffectEvent(() => setText((held) => held ?? here ?? ''))
  useEffect(() => {
    if (!onEdit) return
    const listen = (event: KeyboardEvent) => {
      if (event.defaultPrevented || typing(event.target)) return
      // A key pressed in another overlay (the command palette) is not ours.
      const mine = (field.current ?? bar.current)?.closest('[role="dialog"]') ?? null
      const target = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null
      if (target !== null && target !== mine) return
      const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey
      const location = event.key.toLowerCase() === 'l' && event.ctrlKey
      if (!slash && !location) return
      event.preventDefault()
      open()
    }
    document.addEventListener('keydown', listen)
    return () => document.removeEventListener('keydown', listen)
  }, [onEdit])
  useEffect(() => {
    if (editing) field.current?.querySelector('input')?.select()
    else if (was.current && leaving.current) bar.current?.querySelector<HTMLElement>('button[data-edit]')?.focus()
    if (!editing) leaving.current = false
    was.current = editing
  }, [editing])

  const submit = async () => {
    const path = (text ?? '').trim()
    if (!onEdit) return
    if (!path.startsWith('/')) {
      setBad(true)
      return
    }
    setBusy(true)
    await onEdit(path)
    setBusy(false)
    leaving.current = true
    setText(null)
  }

  if (editing) {
    return (
      <div className="ns__pathfield" ref={field}>
        <TextField
          autoComplete="off"
          disabled={busy}
          error={bad ? 'A path starts with /, like /home/you/project' : undefined}
          label="Path"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape' && !failed) {
              // The dialog around this form closes on Escape; this one press is the field's.
              event.stopPropagation()
              leaving.current = true
              setText(null)
            }
          }}
          onValueChange={(value) => {
            setBad(false)
            setText(value)
          }}
          supporting={busy ? 'checking…' : 'absolute, on this machine; checked before anything is written. Escape goes back'}
          value={text ?? ''}
        />
      </div>
    )
  }

  const parts = here === null ? [] : crumbs(here, home)
  return (
    <div className="ns__pathbar" ref={bar}>
      <nav aria-label="Where you are" className="ns__crumbs">
        <ol>
          {parts.map((part, index) => {
            const last = index === parts.length - 1
            return (
              <li key={part.path}>
                {last ? (
                  <span aria-current="location" className="ns__crumb">
                    {part.label}
                  </span>
                ) : (
                  <button
                    className="ns__crumb m3-interactive"
                    onClick={() => onGo(part.path === home ? null : part.path)}
                    type="button"
                  >
                    {part.label}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
      {onEdit ? (
        <Button data-edit="" onClick={() => setText(here ?? '')} type="button" variant="text">
          Edit path
        </Button>
      ) : null}
    </div>
  )
}

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Button } from '@/m3/button/Button'
import { TextField } from '@/m3/text-field/TextField'
import { crumbs } from './dirs'
import { typing } from './keys'

/** The crumbs from `/` to the folder you are in. Given `onEdit`, `/` or
 *  Ctrl+L, and the Edit button, swap them for a field that holds the path:
 *  Enter hands it to `onEdit`, Escape gives the crumbs back. */
export function PathBar(props: {
  here: string
  home: string | null
  onGo: (path: string | null) => void
  onEdit?: (path: string) => Promise<void>
}) {
  const { here, home, onGo, onEdit } = props
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const was = useRef(false)
  const editing = text !== null

  const open = useEffectEvent(() => setText(here))
  useEffect(() => {
    if (!onEdit) return
    const listen = (event: KeyboardEvent) => {
      const slash = event.key === '/' && !typing(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey
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
    else if (was.current) bar.current?.querySelector<HTMLElement>('button[data-edit]')?.focus()
    was.current = editing
  }, [editing])

  const submit = async () => {
    const path = (text ?? '').trim()
    if (!onEdit || !path.startsWith('/')) return
    setBusy(true)
    await onEdit(path)
    setBusy(false)
    setText(null)
  }

  if (editing) {
    return (
      <div className="ns__pathfield" ref={field}>
        <TextField
          autoComplete="off"
          disabled={busy}
          label="Path"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              // The dialog around this form closes on Escape; this one press is the field's.
              event.stopPropagation()
              setText(null)
            }
          }}
          onValueChange={setText}
          supporting={busy ? 'checking…' : 'absolute, on this machine; checked before anything is written. Escape goes back'}
          value={text}
        />
      </div>
    )
  }

  const parts = crumbs(here, home)
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
        <Button data-edit="" onClick={() => setText(here)} type="button" variant="text">
          Edit path
        </Button>
      ) : null}
    </div>
  )
}

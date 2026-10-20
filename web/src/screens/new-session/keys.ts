import type { KeyboardEvent } from 'react'

export const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

export const FOLDER_KEYS =
  'Up and Down move between folders, Home and End go to the first and last, Enter opens the folder, Right shows its subfolders, Left hides them or goes to the parent, Backspace goes up one folder.'

/** The arrow-key model over the rows drawn under `event.currentTarget`.
 *  Enter needs nothing: a row is a button. */
export function folderKeys(event: KeyboardEvent<HTMLElement>) {
  const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-row]') : null
  if (!row || event.altKey || event.ctrlKey || event.metaKey) return
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-row]'))
  const at = rows.indexOf(row)
  const toggle = row.parentElement?.querySelector<HTMLElement>('.ns__toggle[aria-expanded]')
  const go = (to: HTMLElement | undefined) => {
    event.preventDefault()
    to?.focus()
  }
  switch (event.key) {
    case 'ArrowDown':
      return go(rows[at + 1])
    case 'ArrowUp':
      return go(rows[at - 1])
    case 'Home':
      return go(rows[0])
    case 'End':
      return go(rows[rows.length - 1])
    case 'ArrowRight':
      if (toggle?.getAttribute('aria-expanded') === 'false') {
        event.preventDefault()
        toggle.click()
      } else if (toggle) go(row.closest('li')?.querySelector<HTMLElement>('.ns__sub [data-row]') ?? undefined)
      return
    case 'ArrowLeft':
      if (toggle?.getAttribute('aria-expanded') === 'true') {
        event.preventDefault()
        toggle.click()
      } else {
        const parent = row.closest('li')?.parentElement?.previousElementSibling
        go(parent?.querySelector<HTMLElement>('[data-row]') ?? undefined)
      }
  }
}

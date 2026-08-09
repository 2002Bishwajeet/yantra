import type { RefObject } from 'react'
import { Link } from '@tanstack/react-router'
import type { Workspace } from '@/api'
import type { Verb } from '@/components/Act'
import type { Chosen } from '@/columns'
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
} from '@/components/ui/menu'

/** The verbs the row's state is not for, plus the two that were columns before
 *  Y-167. Its own module because it is the only thing on `/` that pulls Base
 *  UI's positioning in — 29 kB gzip, measured — and `Act.tsx` loads it on the
 *  first tap rather than on the first paint. That is also why there is no
 *  `MenuTrigger` here: the trigger stays eager and is anchored to. */
export function Overflow({
  workspace,
  chosen,
  terminal,
  anchor,
  open,
  onOpenChange,
  acting,
  onVerb,
  edit,
}: {
  workspace: Workspace
  chosen: Chosen
  terminal: boolean
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  acting: boolean
  onVerb: (verb: Verb) => void
  edit: ((name: string) => void) | null
}) {
  const primary = (verb: Verb) => chosen.does === 'post' && chosen.verb === verb

  return (
    <Menu onOpenChange={onOpenChange} open={open}>
      <MenuPopup align="end" anchor={anchor}>
        {!primary('up') && (
          <MenuItem disabled={acting} onClick={() => onVerb('up')}>
            {workspace.startup === null ? 'Start claude' : 'Start'}
          </MenuItem>
        )}
        <MenuItem disabled={acting} onClick={() => onVerb('down')}>
          Stop
        </MenuItem>
        {/* ADR-0015 refuses a workspace that starts something of its own, so the
            verb is not offered where it could only ever be refused. */}
        {workspace.startup === null && !primary('resume') && (
          <MenuItem disabled={acting} onClick={() => onVerb('resume')}>
            Resume
          </MenuItem>
        )}
        {terminal && chosen.does !== 'open' && (
          <MenuItem
            render={<Link params={{ name: workspace.name }} to="/w/$name" />}
          >
            Open terminal
          </MenuItem>
        )}
        {edit && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => edit(workspace.name)}>Edit</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}

import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { joinFixes, reachWords, type ReachableFailure } from '@/lib/checks'
import { joinCommand } from '@/lib/join'
import { Copyable } from '@/m3/copyable/Copyable'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { Text } from '@/m3/text/Text'

/** ssh's own words, one press away from every surface that fails on them. */
export function SshSaid(props: { detail: string; children?: ReactNode }) {
  return (
    <Disclosure summary="What ssh said">
      <div className="m3-mono m3-wrap">{props.detail}</div>
      {props.children}
    </Disclosure>
  )
}

/** Why Yantra cannot reach a machine and what fixes it. `children` go behind
 *  the disclosure with the raw text. */
export function ReachFailure(props: {
  kind: ReachableFailure
  name: string
  detail: string
  join: string | null
  children?: ReactNode
}) {
  const { kind, name, detail, join, children } = props
  const { cause, next } = reachWords(kind, name)
  return (
    <div className="readiness__left">
      <Text render={<p />} scale="body-medium">
        {cause}
      </Text>
      <Text render={<p />} scale="body-small" tone="variant">
        {next}
        {kind === 'unjoined' ? (
          <>
            {' '}
            <Link to="/machines/add">Add a device</Link> shows it for each platform.
          </>
        ) : null}
      </Text>
      {join && joinFixes(kind) ? <Copyable text={joinCommand(join)} what="the join command" /> : null}
      <SshSaid detail={detail}>{children}</SshSaid>
    </div>
  )
}

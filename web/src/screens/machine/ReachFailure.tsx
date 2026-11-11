import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { forgetHostKey, joinFixes, reachWords, withoutSignIn, type AnswerFailure, type ReachableFailure } from '@/lib/checks'
import { joinCommand } from '@/lib/join'
import { Copyable } from '@/m3/copyable/Copyable'
import { Disclosure } from '@/m3/disclosure/Disclosure'
import { Text } from '@/m3/text/Text'

/** The raw error, one press away from every surface that fails on it. Only
 *  ssh's own words are called ssh's (Y-585), and never a dead sign-in link (Y-621). */
export function SshSaid(props: { detail: string; kind?: AnswerFailure; children?: ReactNode }) {
  return (
    <Disclosure summary={props.kind === 'listing' ? 'The full error' : 'What ssh said'}>
      <Text className="m3-wrap" render={<div />} scale="body-small">
        {withoutSignIn(props.detail)}
      </Text>
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
            <Link className="m3-hit" to="/machines/add">Add a device</Link> shows it for each platform.
          </>
        ) : null}
      </Text>
      {join && joinFixes(kind) ? <Copyable text={joinCommand(join)} what="the join command" /> : null}
      {kind === 'changed' ? (
        <Copyable text={forgetHostKey(name)} what="the command that forgets the host key" />
      ) : null}
      <SshSaid detail={detail}>{children}</SshSaid>
    </div>
  )
}

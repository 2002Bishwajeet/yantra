/*
 * Adapted from T3 Code, apps/web/src/components/chat/ComposerPendingApprovalActions.tsx
 * (an approval answered at the composer, with Decline and Approve as the two main buttons).
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/chat/ComposerPendingApprovalActions.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Ellipsis } from 'lucide-react'
import { ChatError } from '@/api/chat'
import type { Decision, RequestOpened, RequestType } from '@/api/thread'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'
import { Copyable } from '@/m3/copyable/Copyable'
import { Text } from '@/m3/text/Text'
import { useAnswer } from './useAnswer'

const ASKS: Record<RequestType, string> = {
  exec_command_approval: 'asks to run',
  file_change_approval: 'asks to change',
  file_read_approval: 'asks to read',
  dynamic_tool_call: 'asks to use a tool',
}

/** The agent asks to run a tool. Decline and Approve sit in the composer; "Always allow this session" is in More. */
export function PendingApproval(props: {
  request: RequestOpened
  agent: string
  /** The chat's latest error: a new one after an answer means the daemon refused it. */
  error: ChatError | null
  onAnswer: (decision: Decision) => boolean
  more?: number
}) {
  const { request, agent, error, onAnswer, more } = props
  const { disabled, refused, answer } = useAnswer(error, onAnswer)
  const always = request.options.some((option) => option.decision === 'acceptAlways')
  return (
    <section aria-label="Waiting for your answer" className="pending">
      <div className="pending__head">
        <Text render={<h3 />} scale="title-small">{`${agent} ${ASKS[request.requestType]}`}</Text>
        {request.title ? (
          <div className="pending__command">
            <Copyable text={request.title} what="the command" />
          </div>
        ) : (
          <Text render={<p />} scale="body-large">
            {request.detail ?? 'a tool'}
          </Text>
        )}
        {request.title && request.detail ? (
          <Text render={<p />} scale="body-medium">
            {request.detail}
          </Text>
        ) : null}
        {more ? <Text scale="body-small">{`${more} more waiting`}</Text> : null}
      </div>
      {refused ? <ErrorSurface.Inline error={refused} title="The answer was not sent" /> : null}
      <div className="pending__actions">
        <Button disabled={disabled} onClick={() => answer('decline')} variant="outlined">
          Decline
        </Button>
        {always ? (
          <Menu>
            <MenuTrigger disabled={disabled} render={<IconButton disabled={disabled} label="More answers" />}>
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem onClick={() => answer('acceptAlways')}>Always allow this session</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        <Button disabled={disabled} onClick={() => answer('accept')}>
          Approve
        </Button>
      </div>
    </section>
  )
}

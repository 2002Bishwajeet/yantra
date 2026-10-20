/*
 * The grouping and the status marks adapt T3 Code's thread list: a sidebar
 * that sorts threads by what is still open, and marks each with its PR:
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/Sidebar.logic.ts
 * https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ThreadStatusIndicators.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { useThreads } from '@/api/mutations'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import type { View } from '@/views'
import { groupThreads, prMark } from './threads'

const branchTail = (branch: string) => branch.split('/').pop() ?? branch

/** Y-489: the workspace's threads. It reads on mount and on Refresh, and
 *  never polls: each read is an ssh to the machine and a call to GitHub. */
export function ThreadList(props: { name: string; view: View; thread?: string }) {
  const { name, view, thread } = props
  const threads = useThreads(name)
  const { mutate } = threads
  useEffect(() => mutate(), [mutate, name])

  return (
    <section aria-labelledby="session-threads" className="threads">
      <div className="threads__head">
        <Text render={<h2 />} emphasized id="session-threads" scale="title-small">
          Threads
        </Text>
        <Button disabled={threads.isPending} onClick={() => mutate()} type="button" variant="text">
          Refresh
        </Button>
      </div>
      {threads.isPending ? (
        <div aria-busy="true" className="threads__pending">
          <Skeleton shape="text" style={{ width: '50%' }} />
          <Skeleton shape="text" style={{ width: '35%' }} />
        </div>
      ) : null}
      {threads.error ? (
        <ErrorSurface.Inline
          action={
            <Button onClick={() => mutate()} type="button" variant="text">
              Try again
            </Button>
          }
          error={threads.error}
          title="The threads could not be listed"
        />
      ) : null}
      {threads.data && threads.data.length === 0 ? (
        <Text render={<p />} className="threads__empty" scale="body-medium" tone="variant">
          No threads yet. Send a message in Chat to start one.
        </Text>
      ) : null}
      {threads.data
        ? groupThreads(threads.data).map((group) => (
            <div className="threads__group" key={group.title}>
              <Text render={<h3 />} scale="body-small" tone="variant">
                {group.title}
              </Text>
              <ul className="threads__list">
                {group.items.map((one) => {
                  const mark = prMark(one.pr)
                  return (
                    <li key={one.id}>
                      <Link
                        aria-current={one.id === thread ? 'true' : undefined}
                        className="threads__row m3-interactive"
                        params={{ name }}
                        replace
                        search={{ view, thread: one.id }}
                        to="/w/$name"
                      >
                        <Mono className="threads__branch">{branchTail(one.branch)}</Mono>
                        {one.issue ? <Mono className="threads__issue">{one.issue}</Mono> : null}
                        <State className="threads__pr" state={mark.state}>
                          {mark.word}
                        </State>
                        {one.pr.state === 'unknown' ? (
                          <Text className="threads__said" scale="body-small" tone="variant">
                            {one.pr.said}
                          </Text>
                        ) : null}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        : null}
    </section>
  )
}

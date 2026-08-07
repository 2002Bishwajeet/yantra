import { useState } from 'react'
import type { Opened, Resumed, Stopped, Workspace } from '@/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export type Verb = 'up' | 'down' | 'resume'

type Acted =
  | { acted: 'no' }
  | { acted: 'acting'; verb: Verb }
  | { acted: 'done'; said: string }
  // `null` is a request that never got an answer, which is not a refusal.
  | { acted: 'refused'; status: number | null; said: string }

/** Each code the three routes answer means a different thing, and collapsing
 *  them into "it failed" sends the operator hunting a mistake they may not have
 *  made — a `tailscale` that could not answer least of all. */
const refusals: Record<number, string> = {
  400: 'That workspace name is not one the daemon accepts.',
  403: "This browser is not on a node this tailnet's owner holds.",
  404: 'The daemon knows no workspace by that name.',
  // Y-135: a state the daemon named correctly — an agent holding at the trust
  // dialog (I-49), one that is not logged in (I-44) — is not a crash.
  409: 'Nothing broke and nothing ran: the machine already answers this, and the sentence below says what has to change first.',
  422: 'The dashboard sent a field the daemon does not know.',
  500: 'The verb ran and failed. What it says below is the whole chain.',
  // Both halves, since Y-135: the tailnet could not say who is calling, or the
  // workspace's own machine could not be asked.
  503: 'Nothing could be asked, so nothing about you or that machine was decided and nothing ran.',
}

function refusal(status: number | null): string {
  if (status === null) return 'The daemon did not answer.'
  return refusals[status] ?? 'The daemon refused.'
}

/** I-30 and §B4: a second `up` attaches, so an already-open session and nothing
 *  launched is the idempotent success rather than a failure to report.
 *
 *  `launched` reports an *agent*, and a workspace's own `startup` is not one —
 *  measured 2026-08-03 against a `startup` that really was running. */
function opened(workspace: Workspace, report: Opened): string {
  if (report.session === 'attached') {
    return `That session was already open on ${report.machine}, so this attached to it rather than starting a second.`
  }
  if (report.launched) return `Started on ${report.machine}.`
  return workspace.startup === null
    ? `Opened a session on ${report.machine}, holding a plain shell.`
    : `Opened a session on ${report.machine}, running the workspace's own startup.`
}

function stopped(report: Stopped): string {
  if (!report.stopped) {
    return `Nothing was running on ${report.machine}, so there was nothing to stop.`
  }
  return report.ending
    ? `Stopped on ${report.machine}. The agent ended: ${report.ending}.`
    : `Stopped on ${report.machine}.`
}

/** ADR-0015's one unknowable, said rather than papered over: `--continue` in a
 *  repo with no earlier conversation starts a fresh one and exits 0. */
function resumed(report: Resumed): string {
  return report.resumed
    ? `Resumed on ${report.machine}. Nothing tells a continued conversation from a fresh one, so a first resume starts one.`
    : `An agent is already working on ${report.machine}, so the session was left exactly as it is.`
}

function said(workspace: Workspace, verb: Verb, report: unknown): string {
  switch (verb) {
    case 'up':
      return opened(workspace, report as Opened)
    case 'down':
      return stopped(report as Stopped)
    case 'resume':
      return resumed(report as Resumed)
  }
}

// Outside the component for the reason `useLooked`'s `look` is: the React
// Compiler bails out of a function whose try/catch holds a conditional.
async function act(workspace: Workspace, verb: Verb): Promise<Acted> {
  const path = `/api/workspaces/${encodeURIComponent(workspace.name)}/${verb}`
  // Only `up` reads a body, and the machine is not in it: the target is
  // `workspace.machine`, chosen when the workspace was written (Y-117).
  const start =
    verb === 'up'
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            workspace.startup === null ? { agent: 'claude' } : {},
          ),
        }
      : {}

  try {
    const response = await fetch(path, { method: 'POST', ...start })
    if (!response.ok) {
      return {
        acted: 'refused',
        status: response.status,
        said: await response.text(),
      }
    }
    return {
      acted: 'done',
      said: said(workspace, verb, await response.json()),
    }
  } catch (cause) {
    return { acted: 'refused', status: null, said: String(cause) }
  }
}

export const button =
  'border-input rounded-md border px-2 py-1 text-xs disabled:opacity-50'

/** The three verbs as buttons, so a phone needs no terminal. They await ssh —
 *  ten seconds against a machine that is asleep — so every one of them is
 *  disabled while one is in flight rather than reading as already done.
 *
 *  `verb` narrows it to one, for a caller that read the agent's state and knows
 *  which verb that state is for (Y-136). Absent, all three are offered and the
 *  daemon decides, which is what a caller with no state to read must do. */
export function Act({
  workspace,
  verb,
}: {
  workspace: Workspace
  verb?: Verb
}) {
  const [outcome, setOutcome] = useState<Acted>({ acted: 'no' })
  const acting = outcome.acted === 'acting'
  const offers = (one: Verb) => verb === undefined || verb === one

  const tap = async (verb: Verb) => {
    setOutcome({ acted: 'acting', verb })
    setOutcome(await act(workspace, verb))
  }

  return (
    <div className="flex max-w-xs flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {offers('up') && (
          <button
            type="button"
            className={button}
            disabled={acting}
            onClick={() => void tap('up')}
          >
            {outcome.acted === 'acting' && outcome.verb === 'up'
              ? 'starting…'
              : workspace.startup === null
                ? 'Start claude'
                : 'Start'}
          </button>
        )}
        {offers('down') && (
          <button
            type="button"
            className={button}
            disabled={acting}
            onClick={() => void tap('down')}
          >
            {outcome.acted === 'acting' && outcome.verb === 'down'
              ? 'stopping…'
              : 'Stop'}
          </button>
        )}
        {/* ADR-0015 refuses a workspace that starts something of its own, so
            the button is not offered where it could only ever be refused. */}
        {offers('resume') && workspace.startup === null && (
          <button
            type="button"
            className={button}
            disabled={acting}
            onClick={() => void tap('resume')}
          >
            {outcome.acted === 'acting' && outcome.verb === 'resume'
              ? 'resuming…'
              : 'Resume'}
          </button>
        )}
      </div>

      {acting && (
        <span className="text-muted-foreground text-xs">
          waiting on {workspace.machine} — ssh gives it ten seconds
        </span>
      )}

      {outcome.acted === 'done' && (
        <Alert>
          <AlertTitle className="text-xs">{outcome.said}</AlertTitle>
        </Alert>
      )}

      {outcome.acted === 'refused' && (
        // A refusal the daemon reasoned about is not a crash, and the `409` is
        // the one that reads as one if it is painted like a failure.
        <Alert variant={outcome.status === 409 ? 'default' : 'destructive'}>
          <AlertTitle className="text-xs">
            {refusal(outcome.status)}
          </AlertTitle>
          {/* The daemon's own chain, whole: it names the machine, the command
              and what ssh said, which is the actionable half. */}
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {outcome.said}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

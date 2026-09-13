import { lazy, type ReactNode, Suspense, useState } from 'react'
import { BottomSheet, BottomSheetPopup } from '@/m3/bottom-sheet/BottomSheet'
import { Button } from '@/m3/button/Button'
import { SideSheet } from '@/m3/side-sheet/SideSheet'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { useFormFactor } from '@/shell/formFactor'
import './SudoSheet.css'

// xterm.js is a third of a chunk, and only a sudo step needs it on this page.
const Terminal = lazy(() => import('@/screens/session/Terminal').then((module) => ({ default: module.Terminal })))

/** A step an install left: its place in the list and the `at` of the install
 *  event it came from, which are what the socket names, and the command, which
 *  is what the person reads. The daemon refuses a step whose install is no
 *  longer the latest, so the two cannot disagree (ADR-0030 §2). */
export type Step = { index: number; command: string; at: number }

function Run(props: { machine: string; step: Step; height: string; onDone: () => void }) {
  const { machine, step, height, onDone } = props
  const [exit, setExit] = useState<number | null | undefined>(undefined)
  return (
    <div className="sudo-sheet__body">
      <Text render={<p />} scale="body-medium">
        This runs <Mono className="sudo-sheet__command">{step.command}</Mono> on {machine}. Your password goes to{' '}
        {machine} as keystrokes; Yantra does not keep it.
      </Text>
      <Text render={<p />} scale="body-small" tone="variant">
        Closing this stops the command there.
      </Text>
      {/* Escape belongs to the terminal here: the sheet closing on it would
          stop sudo in the middle of a password. */}
      <div
        className="sudo-sheet__pane"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation()
        }}
      >
        <Suspense fallback={<Skeleton shape="block" style={{ height }} />}>
          <Terminal
            height={height}
            label={`install step on ${machine}`}
            onEnd={onDone}
            onExit={(code) => {
              setExit(code)
              onDone()
            }}
            target={{ machine, step: step.index, at: step.at }}
          />
        </Suspense>
      </div>
      {exit === undefined ? null : (
        <Text render={<p />} className="sudo-sheet__said" scale="body-medium">
          {exit === 0
            ? `It finished on ${machine}. Readiness asks ${machine} again now.`
            : `It exited ${exit ?? 'with no status'}. The output above says why; Install again asks what is still missing.`}
        </Text>
      )}
    </div>
  )
}

/** Y-394, ADR-0030: a sudo-blocked step, run in a terminal of its own. A side
 *  sheet beside the page on the desktop and the tablet, and the full height on
 *  the phone (D7 §4.3). The terminal is mounted only while the sheet is open,
 *  so closing it closes the socket and stops the command.
 *
 *  `onDone` is the command ending, or its socket dropping. `fallback` is the id
 *  focus goes to when the step's own button went with the verdict it changed. */
export function SudoSheet(props: {
  machine: string
  step: Step | null
  fallback: string
  onClose: () => void
  onDone: () => void
}) {
  const { machine, step, fallback, onClose, onDone } = props
  const factor = useFormFactor()
  const title = `Run it on ${machine}`
  const back = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-sudo-opener]') ?? document.getElementById(fallback)
  const close = () => {
    onClose()
    // The side sheet gives focus back only to an opener still on the page; with
    // none, focus is on the body or still on the now-hidden sheet's title.
    setTimeout(() => {
      const active = document.activeElement
      if (active === null || active === document.body || active.closest('[hidden]')) back()?.focus()
    }, 0)
  }
  const closer: ReactNode = (
    <Button onClick={close} variant="text">
      Close
    </Button>
  )

  if (factor === 'phone') {
    return (
      <BottomSheet
        open={step !== null}
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <BottomSheetPopup actions={closer} className="sudo-sheet sudo-sheet--phone" finalFocus={back} title={title}>
          {step ? <Run height="45dvh" key={step.index} machine={machine} onDone={onDone} step={step} /> : null}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }

  return (
    <SideSheet actions={null} className="sudo-sheet sudo-sheet--side" onClose={close} open={step !== null} title={title}>
      {step ? <Run height="55vh" key={step.index} machine={machine} onDone={onDone} step={step} /> : null}
    </SideSheet>
  )
}

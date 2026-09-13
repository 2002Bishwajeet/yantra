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

/** A step an install left: its place in the list, which is what the socket
 *  names, and the command, which is what the person reads. */
export type Step = { index: number; command: string }

function Run(props: { machine: string; step: Step; height: string; onExit: (exit: number | null) => void }) {
  const { machine, step, height, onExit } = props
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
            onExit={(code) => {
              setExit(code)
              onExit(code)
            }}
            target={{ machine, step: step.index }}
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
 *  so closing it closes the socket and stops the command. */
export function SudoSheet(props: {
  machine: string
  step: Step | null
  onClose: () => void
  onExit: (exit: number | null) => void
}) {
  const { machine, step, onClose, onExit } = props
  const factor = useFormFactor()
  const title = `Run it on ${machine}`
  const close: ReactNode = (
    <Button onClick={onClose} variant="text">
      Close
    </Button>
  )

  if (factor === 'phone') {
    return (
      <BottomSheet
        open={step !== null}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <BottomSheetPopup actions={close} className="sudo-sheet sudo-sheet--phone" title={title}>
          {step ? <Run height="45dvh" key={step.index} machine={machine} onExit={onExit} step={step} /> : null}
        </BottomSheetPopup>
      </BottomSheet>
    )
  }

  return (
    <SideSheet actions={null} className="sudo-sheet sudo-sheet--side" onClose={onClose} open={step !== null} title={title}>
      {step ? <Run height="55vh" key={step.index} machine={machine} onExit={onExit} step={step} /> : null}
    </SideSheet>
  )
}

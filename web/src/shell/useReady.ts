import { useEffect, useState } from 'react'

/** True two frames after mount: the closed popup must be styled once, or the spring has no start. */
export function useReady() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let b = 0
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setReady(true))
    })
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [])
  return ready
}

export type PopupProps = {
  anchor: React.RefObject<HTMLButtonElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** A press on the trigger toggles through its own onClick, so the outside-press must not also close. */
export function guardOutsidePress(props: PopupProps) {
  return (next: boolean, details: { reason: string; event: Event }) => {
    const target = details.event.target
    if (
      !next &&
      details.reason === 'outside-press' &&
      target instanceof Node &&
      props.anchor.current?.contains(target)
    )
      return
    props.onOpenChange(next)
  }
}

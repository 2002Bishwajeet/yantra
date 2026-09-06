import { useParams } from '@tanstack/react-router'

/** Y-345 stub. The screen row replaces this body; the route keeps the name. */
export function SessionTerminal() {
  const { machine, session } = useParams({ from: '/m/$machine/s/$session' })
  return (
    <>
      <h1>{session} on {machine}</h1>
      <p>not built yet</p>
    </>
  )
}

import { useParams } from '@tanstack/react-router'

/** Y-345 stub. The screen row replaces this body; the route keeps the name. */
export function Machine() {
  const { machine } = useParams({ from: '/m/$machine' })
  return (
    <>
      <h1>{machine}</h1>
      <p>not built yet</p>
    </>
  )
}

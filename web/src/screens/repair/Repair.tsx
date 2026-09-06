import { useParams } from '@tanstack/react-router'

/** Y-345 stub. The screen row replaces this body; the route keeps the name. */
export function Repair() {
  const { name } = useParams({ from: '/w/$name/repair' })
  return (
    <>
      <h1>Repair {name}</h1>
      <p>not built yet</p>
    </>
  )
}

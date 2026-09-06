import { useParams } from '@tanstack/react-router'

/** Y-345 stub. The screen row replaces this body; the route keeps the name. */
export function Session() {
  const { name } = useParams({ from: '/w/$name' })
  return (
    <>
      <h1>{name}</h1>
      <p>not built yet</p>
    </>
  )
}

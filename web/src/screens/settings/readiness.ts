import type { Readiness } from '@/api'
import type { Reading } from '@/api/hooks'

/** How many machines a doctor check is `present` on, out of those the sweep
 *  reported. Null while nothing has been read. */
export function presentOn(
  readiness: Reading<Readiness[]>,
  check: string,
): { present: number; of: number } | null {
  if (readiness.looked !== 'ok') return null
  const of = readiness.data.length
  const present = readiness.data.filter((one) =>
    one.checks.some((c) => c.check === check && c.state === 'present'),
  ).length
  return { present, of }
}

/** The sentence a row draws for a count, or for the lack of one. */
export function onMachines(count: { present: number; of: number } | null, verb: string): string {
  if (count === null) return `${verb} on the machines is still being read`
  return `${verb} on ${count.present} of ${count.of} machines`
}

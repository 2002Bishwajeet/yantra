import type { Machine } from '@/api'
import { NewWorkspace } from '@/components/NewWorkspace'
import { Section } from '@/components/Section'
import { Title } from '@/components/Title'
import { useLooked } from '@/useLooked'

/** D3 §3 and §14: the create form was parked permanently between two tables on
 *  the work page. A route rather than a card also takes `ui/field` off the first
 *  paint, which is what §9.1's budget needed (Y-194).
 *
 *  The machines reading is the picker, so the form draws only where there is
 *  really something to choose from. */
export function New() {
  const machines = useLooked<Machine[]>('/api/machines')

  return (
    <>
      <Title>New workspace</Title>
      <Section title="Where it runs" query={machines}>
        {(rows) => <NewWorkspace machines={rows} />}
      </Section>
    </>
  )
}

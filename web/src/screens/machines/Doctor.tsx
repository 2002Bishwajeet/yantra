import { useRecheckReadiness } from '@/api/mutations'
import { Button, type ButtonProps } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'

/** `POST …/readiness` asks the machine again now — a full ssh round trip, so a
 *  button and never a timer (ADR-0019). The answer lands in the same key the
 *  sweep fills, which is why nothing here holds a result. */
export function Doctor(props: { machine: string; variant?: ButtonProps['variant'] }) {
  const { machine, variant } = props
  const recheck = useRecheckReadiness()
  return (
    <>
      <Button
        disabled={recheck.isPending}
        onClick={() => recheck.mutate(machine)}
        variant={variant ?? 'text'}
      >
        {recheck.isPending ? 'asking…' : 'Doctor'}
      </Button>
      {recheck.error ? (
        <ErrorSurface.Inline
          className="machines__said"
          error={recheck.error}
          reset={() => recheck.mutate(machine)}
          title="Doctor was refused"
        />
      ) : null}
    </>
  )
}

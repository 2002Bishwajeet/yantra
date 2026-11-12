import './Reconnecting.css'

/** Y-744: the mark a page wears while it is drawn from readings the daemon has
 *  stopped renewing. The ages on the page stop with them, and this is what
 *  says so (R-23). It stays mounted and `hidden`, so it can leave in a
 *  transition and is no `status` while it is off. */
export function Reconnecting({ on }: { on: boolean }) {
  return (
    <div className="reconnecting" hidden={!on} role="status">
      <span aria-hidden="true" className="reconnecting__spinner" />
      Reconnecting
    </div>
  )
}

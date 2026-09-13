import './Busy.css'

/** D7 §3.7: an indeterminate bar while an install runs. `Track` draws a
 *  measured value, and an install reports none until it ends. */
export function Busy(props: { label: string }) {
  return (
    <div aria-label={props.label} className="add-device__busy" role="progressbar">
      <span />
    </div>
  )
}

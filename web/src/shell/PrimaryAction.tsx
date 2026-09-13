import { usePrimaryAction, type Primary } from './primary'

/** Hands the page's one next action to the shell's FAB while this is drawn
 *  (D7 §3.6). `null` says the page has none, which hides the route's own. A
 *  component, so a branch can publish without a conditional hook. */
export function PrimaryAction(props: { action: Primary | null }) {
  usePrimaryAction(props.action)
  return null
}

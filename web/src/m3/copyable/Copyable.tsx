import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'
import './Copyable.css'

export const hints = {
  selected: 'this page has no clipboard, so the text is selected · copy it with Ctrl+C, ⌘C or a long press',
  manual: 'this page has no clipboard · select the text and copy it yourself',
}

/** `navigator.clipboard` needs a secure context, and plain HTTP to a tailnet
 *  address is not one, so a refused copy selects the text and says so rather
 *  than failing silently. */
export function useCopy(text: string) {
  const ref = useRef<HTMLSpanElement>(null)
  const [said, setSaid] = useState<'copied' | 'selected' | 'manual' | null>(null)
  const [seen, setSeen] = useState(text)
  // A new text is not the one that was copied; a stale 'Copied' would mislead.
  if (seen !== text) {
    setSeen(text)
    setSaid(null)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid('copied')
    } catch {
      const selection = window.getSelection()
      if (ref.current && selection) {
        selection.selectAllChildren(ref.current)
        setSaid('selected')
      } else {
        setSaid('manual')
      }
    }
  }
  return { ref, said, copy }
}

/** Text a person copies. A caller that needs the same copy elsewhere passes
 *  its own `useCopy` result as `copier`. `line` keeps a command on one line that scrolls sideways. */
export function Copyable(props: { text: string; what: string; line?: boolean; copier?: ReturnType<typeof useCopy> }) {
  const { text, what } = props
  const own = useCopy(text)
  const { ref, said, copy } = props.copier ?? own
  return (
    <div className="m3-copyable">
      <div className="m3-copyable__row">
        <Mono
          className={clsx('m3-copyable__text', props.line && 'm3-copyable__text--line')}
          ref={ref}
          // A scrolling region needs keyboard access (axe scrollable-region-focusable).
          {...(props.line ? { tabIndex: 0, role: 'group', 'aria-label': what } : {})}
          translate="no"
        >
          {text}
        </Mono>
        <Button
          aria-label={`${said === 'copied' ? 'Copied' : 'Copy'} ${what}`}
          icon={said === 'copied' ? <Check /> : <Copy />}
          onClick={copy}
          variant="text"
        >
          {said === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {/* Always mounted, so a screen reader hears the hint arrive; empty
          otherwise, so `:empty` drops its margin. */}
      <Text aria-live="polite" className="m3-copyable__hint" scale="body-small" tone="variant">
        {said === 'selected' || said === 'manual' ? hints[said] : null}
      </Text>
    </div>
  )
}

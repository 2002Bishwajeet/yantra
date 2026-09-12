import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/m3/button/Button'
import { Mono, Text } from '@/m3/text/Text'
import './Copyable.css'

const hints = {
  selected: 'this page has no clipboard, so the text is selected · copy it with Ctrl+C, ⌘C or a long press',
  manual: 'this page has no clipboard · select the text and copy it yourself',
}

/** Text a person copies. `navigator.clipboard` needs a secure context, and
 *  plain HTTP to a tailnet address is not one, so a refused copy selects the
 *  text and says so rather than failing silently. */
export function Copyable(props: { text: string; what: string }) {
  const { text, what } = props
  const code = useRef<HTMLSpanElement>(null)
  const [said, setSaid] = useState<'copied' | 'selected' | 'manual' | null>(null)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid('copied')
    } catch {
      const selection = window.getSelection()
      if (code.current && selection) {
        selection.selectAllChildren(code.current)
        setSaid('selected')
      } else {
        setSaid('manual')
      }
    }
  }
  return (
    <div className="m3-copyable">
      <div className="m3-copyable__row">
        <Mono className="m3-copyable__text" ref={code} translate="no">
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

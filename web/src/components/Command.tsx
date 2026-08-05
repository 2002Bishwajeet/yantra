import { useRef, useState } from 'react'

const labels = {
  ready: 'copy',
  copied: 'copied',
  selected: 'selected — copy it yourself',
} as const

function selectContents(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** `navigator.clipboard` is secure-context only and `yantrad` serves plain HTTP
 *  on a 100.64.0.0/10 address, so the selection is what always works. */
async function copyText(text: string, node: Node): Promise<boolean> {
  selectContents(node)
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    )
  }
  return typeof document.execCommand === 'function' && document.execCommand('copy')
}

/** What is left where no write exists: `attach` puts a TUI in *this* terminal
 *  (ADR-0011), and a browser has none. Everything with a route behind it is a
 *  button — the workspace row's since Y-113, the agent row's since Y-136. */
export function Command({ command }: { command: string }) {
  const text = useRef<HTMLElement>(null)
  const [outcome, setOutcome] = useState<keyof typeof labels>('ready')

  const copy = async () => {
    const node = text.current
    if (node) setOutcome((await copyText(command, node)) ? 'copied' : 'selected')
  }

  return (
    <span className="flex items-baseline gap-2">
      <code ref={text} className="font-mono text-xs select-all">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="text-muted-foreground hover:text-foreground shrink-0 text-xs underline-offset-4 hover:underline"
      >
        {labels[outcome]}
      </button>
    </span>
  )
}

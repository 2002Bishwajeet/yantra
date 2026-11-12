/*
 * The frame follows T3 Code's markdown code block: a header with the language or
 * file name, a copy button, then the code:
 * https://github.com/pingdotgg/t3code/blob/67eebaca/apps/web/src/components/chat/MarkdownCodeBlock.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { lazy, Suspense, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { ErrorBoundary } from 'react-error-boundary'
import { Button } from '@/m3/button/Button'
import { hints, useCopy } from '@/m3/copyable/Copyable'
import { Mono, Text } from '@/m3/text/Text'
import './CodeBlock.css'

// Shiki and its grammars arrive with this import, never with `/` or the Chat chunk.
const load = () => import('./Highlighted')

function Plain(props: { code: string }) {
  return (
    <pre className="chat__code-body">
      <code>{props.code}</code>
    </pre>
  )
}

export function CodeBlock(props: { code: string; language: string; title: string | null }) {
  const { language, title } = props
  const { ref, said, copy, clean: code } = useCopy(props.code)
  const [Body, setBody] = useState(() => lazy(load))
  return (
    <figure className="chat__code" data-language={language}>
      <figcaption className="chat__code-head">
        <Mono className="chat__code-name">{title ?? language}</Mono>
        <Button
          aria-label={said === 'copied' ? 'Copied' : 'Copy code'}
          className="chat__code-copy"
          icon={said === 'copied' ? <Check /> : <Copy />}
          onClick={copy}
          variant="text"
        />
      </figcaption>
      <span className="chat__code-frame" ref={ref}>
        <ErrorBoundary
          fallback={<Plain code={code} />}
          // A failed import is remembered by the module that asked for it.
          onError={() => setBody(() => lazy(load))}
          resetKeys={[code, language]}
        >
          <Suspense fallback={<Plain code={code} />}>
            <Body code={code} language={language} />
          </Suspense>
        </ErrorBoundary>
      </span>
      <Text aria-live="polite" className="chat__code-hint" scale="body-small" tone="variant">
        {said === 'selected' || said === 'manual' ? hints[said] : null}
      </Text>
    </figure>
  )
}

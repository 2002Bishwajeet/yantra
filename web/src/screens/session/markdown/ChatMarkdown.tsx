/*
 * The pre, code and a renderers follow T3 Code's chat markdown:
 * https://github.com/pingdotgg/t3code/blob/67eebaca/apps/web/src/components/ChatMarkdown.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { memo, type ComponentProps, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { EDITORS, editorUrl, recallEditor } from '../diff/editors'
import { CodeBlock } from './CodeBlock'
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  fileTarget,
  linkTarget,
  nodeToPlainText,
  type FilePathPosition,
} from './markdown.logic'

// Module constants, so the renderer is not handed new plugin lists per delta.
const REMARK = [remarkGfm]
const REHYPE = [rehypeSanitize]

type Components = NonNullable<ComponentProps<typeof Markdown>['components']>

function EditorLink(props: { machine: string; worktree: string; target: FilePathPosition; children: ReactNode; code?: boolean }) {
  const { machine, worktree, target, children, code } = props
  const editor = recallEditor()
  const known = EDITORS.find((one) => one.id === editor)
  const line = known?.line ? target.line : undefined
  return (
    <a
      aria-label={`Open ${target.path} in ${known?.label}`}
      className={code ? 'chat__file' : undefined}
      href={editorUrl(editor, machine, worktree, target.path, line)}
    >
      {children}
    </a>
  )
}

function componentsFor(machine: string, worktree: string | null): Components {
  return {
    pre({ node, children }) {
      const block = extractCodeBlock(children)
      if (block === null) return <pre>{children}</pre>
      return (
        <CodeBlock
          code={block.code.replace(/\n$/, '')}
          language={extractFenceLanguage(block.className)}
          title={extractFenceTitle(extractPreCodeMeta(node))}
        />
      )
    },
    code({ node: _node, className, children, ...rest }) {
      // A fenced block's code is drawn by `pre`; only inline code is a candidate here.
      if (className) return <code className={className} {...rest}>{children}</code>
      const text = nodeToPlainText(children)
      const target = text.includes('\n') ? null : fileTarget(text, worktree)
      const plain = <code {...rest}>{children}</code>
      return target === null || worktree === null ? (
        plain
      ) : (
        <EditorLink code machine={machine} target={target} worktree={worktree}>
          {plain}
        </EditorLink>
      )
    },
    a({ node: _node, href, children, ...rest }) {
      const target = href === undefined ? null : linkTarget(href, worktree)
      if (target !== null && worktree !== null) {
        return (
          <EditorLink machine={machine} target={target} worktree={worktree}>
            {children}
          </EditorLink>
        )
      }
      return (
        <a {...rest} href={href} rel="noreferrer" target="_blank">
          {children}
        </a>
      )
    },
  }
}

/** An agent's reply: GFM, sanitised, no raw HTML (ADR-0026 decision 4), with code
 *  blocks that copy and file paths that open in the editor. */
export const ChatMarkdown = memo(function ChatMarkdown(props: { text: string; machine: string; worktree: string | null }) {
  return (
    <Markdown components={componentsFor(props.machine, props.worktree)} rehypePlugins={REHYPE} remarkPlugins={REMARK}>
      {props.text}
    </Markdown>
  )
})

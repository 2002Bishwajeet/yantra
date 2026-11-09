/*
 * The fence and path rules follow T3 Code's chat markdown:
 * https://github.com/pingdotgg/t3code/blob/67eebaca/apps/web/src/components/chat/MarkdownCodeBlock.logic.ts
 * https://github.com/pingdotgg/t3code/blob/67eebaca/packages/shared/src/markdownLinks.ts
 * https://github.com/pingdotgg/t3code/blob/67eebaca/packages/shared/src/fileLinks.ts
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Children, isValidElement, type ReactNode } from 'react'

const FENCE_LANGUAGE = /(?:^|\s)language-([^\s]+)/

export function extractFenceLanguage(className: string | undefined): string {
  const raw = className?.match(FENCE_LANGUAGE)?.[1] ?? 'text'
  // Shiki has no gitignore grammar; ini is a close match.
  return raw === 'gitignore' ? 'ini' : raw
}

const FENCE_TITLE_ATTR = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i
const FENCE_FILENAME_TOKEN = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/

export function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null
  const attr = FENCE_TITLE_ATTR.exec(meta)
  const title = attr?.[1] ?? attr?.[2] ?? attr?.[3]
  if (title) return title
  return meta.split(/\s+/).find((one) => FENCE_FILENAME_TOKEN.test(one)) ?? null
}

type CodeNode = { type?: string; tagName?: string; data?: { meta?: unknown }; properties?: { dataCodeMeta?: unknown } }

export function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (node as { children?: CodeNode[] } | undefined)?.children
  const code = children?.find((child) => child?.type === 'element' && child.tagName === 'code')
  const meta = code?.properties?.dataCodeMeta ?? code?.data?.meta
  return typeof meta === 'string' && meta.trim().length > 0 ? meta.trim() : undefined
}

export function nodeToPlainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToPlainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeToPlainText(node.props.children)
  return ''
}

export function extractCodeBlock(children: ReactNode): { className: string | undefined; code: string } | null {
  const nodes = Children.toArray(children)
  if (nodes.length !== 1) return null
  const only = nodes[0]
  if (!isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(only)) return null
  // With a custom `code` component the child's type is that component; the hast node still names the tag.
  if (only.type !== 'code' && only.props.node?.tagName !== 'code') return null
  return { className: only.props.className, code: nodeToPlainText(only.props.children) }
}

const RELATIVE_PREFIX = /^(~\/|\.{1,2}\/)/
const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/
const POSITION_HASH = /^#L(\d+)(?:C(\d+))?$/i
const DISQUALIFIER = /[\s`]/
const FILE_EXTENSION = /\.[A-Za-z0-9_-]+$/
const VERSION_SUFFIX = /\d\.\d[^.]*$/
const NUMERIC_DOTTED = /^\d+(?:\.\d+)+$/
const EXTERNAL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/
const POSITION_ONLY = /^\d+(?::\d+)?$/
// Names may use any script and routing punctuation (`posts.$id.tsx`, `(group)/[id]/+page.svelte`).
const RELATIVE_FILE_PATH =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+){0,2})?$/u
// No `@`: `me@example.com` is an address.
const RELATIVE_FILE_NAME =
  /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2}$/u
const HOSTNAME_TLDS = new Set(
  'com net org io dev app ai co edu gov mil info biz xyz me tv cc gg chat cloud site online tech store link'.split(' '),
)
const COUNTRY_TLDS = new Set(
  'uk de fr nl se no fi dk pl ch at be es it pt eu us ca au nz jp kr cn br ru mx ie cz tr sg hk'.split(' '),
)
const EXTENSIONLESS = new Set(
  'Makefile makefile GNUmakefile Dockerfile Containerfile Justfile justfile Rakefile Gemfile Procfile LICENSE README CHANGELOG'.split(
    ' ',
  ),
)

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith('.')) return false
  const lowered = segment.toLowerCase()
  if (lowered === 'localhost' || NUMERIC_DOTTED.test(segment)) return true
  const labels = lowered.split('.')
  const last = labels.at(-1)
  if (labels.length < 2 || last === undefined) return false
  return HOSTNAME_TLDS.has(last) || (!hasPosition && COUNTRY_TLDS.has(last))
}

/** The path an inline code span names, or null when it is not shaped like a file. */
export function inlineCodeFilePathCandidate(text: string): string | null {
  const candidate = text.trim().replaceAll('\\', '/')
  if (candidate.length === 0 || DISQUALIFIER.test(candidate)) return null
  const hasPosition = POSITION_SUFFIX.test(candidate)
  if (!hasPosition && !candidate.includes('/')) return null
  if (!RELATIVE_PREFIX.test(candidate) && !candidate.startsWith('/')) {
    const bare = candidate.replace(POSITION_SUFFIX, '')
    // `patches/` is a folder, and inline code needs a file-shaped last segment.
    if (bare.endsWith('/')) return null
    if (looksLikeHostname(bare.split('/')[0] ?? bare, hasPosition)) return null
    const base = bare.split('/').at(-1) ?? ''
    if (VERSION_SUFFIX.test(base)) return null
    if (!hasPosition && !FILE_EXTENSION.test(base)) return null
  }
  return candidate
}

export type FilePathPosition = { path: string; line?: number }

export function splitFilePathPosition(path: string, hash = ''): FilePathPosition {
  const suffix = path.match(POSITION_SUFFIX)
  const match = suffix ?? hash.match(POSITION_HASH)
  if (!match?.[1]) return { path }
  const line = Number.parseInt(match[1], 10)
  return { path: suffix ? path.slice(0, -suffix[0].length) : path, ...(line > 0 ? { line } : {}) }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function looksLikeFilePath(path: string, authored: string): boolean {
  if (RELATIVE_PREFIX.test(path)) return true
  if (path.startsWith('/')) {
    return POSITION_SUFFIX.test(authored) || EXTENSIONLESS.has(path.slice(path.lastIndexOf('/') + 1)) || FILE_EXTENSION.test(path)
  }
  return EXTENSIONLESS.has(path) || RELATIVE_FILE_PATH.test(authored) || RELATIVE_FILE_NAME.test(path)
}

/** The file a markdown destination names, or null for a URL or an anchor. */
export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const trimmed = href.trim()
  const normalized = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed
  if (normalized.length === 0 || normalized.startsWith('#') || normalized.startsWith('//')) return null
  const hashAt = normalized.indexOf('#')
  const beforeHash = hashAt >= 0 ? normalized.slice(0, hashAt) : normalized
  const hash = hashAt >= 0 ? decode(normalized.slice(hashAt)) : ''
  const queryAt = beforeHash.indexOf('?')
  const path = decode((queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash).trim())
  if (path.length === 0) return null
  const scheme = path.match(EXTERNAL_SCHEME)
  if (scheme && ((scheme[2] ?? '').startsWith('//') || !POSITION_ONLY.test(scheme[2] ?? ''))) return null
  const position = splitFilePathPosition(path, hash)
  return looksLikeFilePath(position.path, path) ? position : null
}

/** A path the worktree holds, relative to it. Anything outside it, `~/` and `../` give null. */
function inside(path: string, worktree: string): string | null {
  const root = worktree.replace(/\/+$/, '')
  const rest = path.startsWith('/') ? (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null) : path.replace(/^\.\//, '')
  return rest === null || rest === '' || rest.startsWith('~/') || rest.startsWith('../') ? null : rest
}

function resolve(found: FilePathPosition | null, worktree: string | null): FilePathPosition | null {
  if (found === null || worktree === null) return null
  const path = inside(found.path, worktree)
  return path === null ? null : { ...found, path }
}

/** Where inline code points, relative to the worktree, or null when it is not a file in it. */
export function fileTarget(text: string, worktree: string | null): FilePathPosition | null {
  const candidate = inlineCodeFilePathCandidate(text)
  return resolve(candidate === null ? null : splitFilePathPosition(candidate), worktree)
}

export function linkTarget(href: string, worktree: string | null): FilePathPosition | null {
  return resolve(parseMarkdownFileLink(href), worktree)
}

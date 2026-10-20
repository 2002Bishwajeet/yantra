// Stands in for `shiki` in the build (vite.config.ts). The package's entry
// points at every grammar it ships, and each became a file in the daemon's
// embedded dashboard; Pierre reaches them only by name, so this lists the few
// a diff of this repository shows. Any other file draws as plain text.
import { createBundledHighlighter, createSingletonShorthands } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export { createCssVariablesTheme, getTokenStyleObject, stringifyTokenStyle } from 'shiki/core'
export { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
export { createOnigurumaEngine } from 'shiki/engine/oniguruma'

const languages = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
}

/** The names Pierre's extension table gives, beside the grammars' own. */
export const bundledLanguages = {
  ...languages,
  ts: languages.typescript,
  js: languages.javascript,
  rs: languages.rust,
  md: languages.markdown,
  yml: languages.yaml,
  sh: languages.shellscript,
  bash: languages.shellscript,
  shell: languages.shellscript,
  zsh: languages.shellscript,
  py: languages.python,
  docker: languages.dockerfile,
}

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: {},
  engine: () => createJavaScriptRegexEngine(),
})

export const { codeToHtml } = createSingletonShorthands(createHighlighter)

/** Whether a grammar is built in. A file in any other language is drawn as text. */
export const knows = (lang: string): boolean => Object.hasOwn(bundledLanguages, lang)

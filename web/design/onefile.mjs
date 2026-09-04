// Folds design/dist into one HTML file with no server behind it, so the page
// can be opened from a phone as a file or published as an artifact.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist')
let html = readFileSync(join(dist, 'index.html'), 'utf8')

html = html.replace(
  /<script type="module" crossorigin src="\.\/(assets\/[^"]+)"><\/script>/,
  (_, file) => `<script type="module">${readFileSync(join(dist, file), 'utf8')}</script>`,
)
html = html.replace(
  /<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+)">/,
  (_, file) => `<style>${readFileSync(join(dist, file), 'utf8')}</style>`,
)
if (/assets\//.test(html)) throw new Error('an asset was not inlined')

writeFileSync(join(dist, 'options.html'), html)

// The artifact host wraps a fragment in its own document, so the same page
// without the doctype, html, head and body tags.
const fragment = html
  .replace(/^[\s\S]*?<head>/, '')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<\/body>\s*<\/html>\s*$/, '')
  .replace(/<meta [^>]+>\s*/g, '')
writeFileSync(join(dist, 'fragment.html'), fragment)
console.log(`${(html.length / 1024).toFixed(0)} KiB`)

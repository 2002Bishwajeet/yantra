// D3 §9.1 as a test that fails: the first load of `/` — index.html, the entry
// script, every modulepreload and every stylesheet it names — gzip -9, which is
// what yantrad sends since Y-357; and the woff2 those stylesheets reference,
// raw. Both ceilings are binary KiB, per the 2026-09-03 note.
//
// 200 KiB is a target, not a high-water mark (Y-370, R16 §6): the dashboard is
// interactive within 2 s on a cold load on Lighthouse's mobile preset —
// 1.6 Mbit/s, 150 ms RTT, 4× CPU. Measured there, `/` is interactive at 1,606 ms
// and a kilobyte costs 5.25 ms, so 394 ms of headroom is 75 KiB; the ceiling
// spends 52 of that and keeps the rest for a slower phone. It still refuses
// xterm in the entry by 33 KiB and every screen eager by 47 KiB, which is what
// the route split exists for.
//
// The diff panel (Y-491) is a lazy chunk `/` never loads, so it has its own ceiling.
// It counts the viewer, Pierre's diffs and tree, and the shared chunks only it needs.
//
//   npm run budget            builds, then measures
//   npm run budget -- --no-build   measures the dist that is there
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const KIB = 1024
const DIFF_CEILING_KIB = 270
const FIRST_LOAD_CEILING = 200 * KIB
const FONTS_CEILING = 80 * KIB
const DIFF_CEILING = DIFF_CEILING_KIB * KIB

const web = resolve(import.meta.dirname, '..')
const dist = join(web, 'dist')

if (!process.argv.includes('--no-build')) {
  execSync('npx vite build', { cwd: web, stdio: 'inherit' })
}

const html = readFileSync(join(dist, 'index.html'), 'utf8')
// index.html is served too, and every other request waits behind it (R16 §3).
const named = [
  '/index.html',
  ...[...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => /\.(js|css)$/.test(url)),
]

const gz = (buffer) => gzipSync(buffer, { level: 9 }).length
const kib = (bytes) => (bytes / KIB).toFixed(1)
const headroomLine = (ceiling, total) => {
  const [label, n] = total <= ceiling ? ['headroom', ceiling - total] : ['over by', total - ceiling]
  return `  ${label.padEnd(44)} ${String(n).padStart(8)} B  (${kib(n)} KiB)`
}

const chunks = named.map((url) => {
  const file = join(dist, url)
  const bytes = readFileSync(file)
  return { url, raw: bytes.length, gzip: gz(bytes) }
})

const fonts = new Map()
for (const { url } of chunks.filter((c) => c.url.endsWith('.css'))) {
  const css = readFileSync(join(dist, url), 'utf8')
  for (const [, ref] of css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)) {
    const file = ref.startsWith('/') ? join(dist, ref) : resolve(dirname(join(dist, url)), ref)
    fonts.set(file, statSync(file).size)
  }
}

// Vite names the lazy diff chunk after its file, `DiffViewer-<hash>.js`. Its static imports
// that the first load did not fetch count too.
const diffEntry = readdirSync(join(dist, 'assets')).find((name) => /^DiffViewer-[\w-]+\.js$/.test(name))
if (!diffEntry) {
  console.error('\nno DiffViewer chunk in dist/assets: the diff panel is no longer lazy-loaded')
  process.exit(1)
}
const inFirstLoad = new Set(named.map((url) => url.replace(/^\//, '')))
const diffChunks = []
const pending = [`assets/${diffEntry}`]
while (pending.length > 0) {
  const url = pending.pop()
  if (diffChunks.some((c) => c.url === url) || inFirstLoad.has(url)) continue
  const bytes = readFileSync(join(dist, url))
  diffChunks.push({ url, raw: bytes.length, gzip: gz(bytes) })
  const code = bytes.toString('utf8')
  for (const [, dep] of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) pending.push(`assets/${dep}`)
}
const diffBytes = diffChunks.reduce((sum, c) => sum + c.gzip, 0)

const firstLoad = chunks.reduce((sum, c) => sum + c.gzip, 0)
const fontBytes = [...fonts.values()].reduce((sum, n) => sum + n, 0)

console.log('first load of /  (gzip -9, which is the wire since Y-357)')
for (const c of chunks) {
  console.log(`  ${c.url.padEnd(44)} ${String(c.gzip).padStart(8)} B  (${kib(c.gzip)} KiB)`)
}
console.log(`  ${'total'.padEnd(44)} ${String(firstLoad).padStart(8)} B  (${kib(firstLoad)} KiB, ceiling ${kib(FIRST_LOAD_CEILING)} KiB = ${FIRST_LOAD_CEILING} B)`)
console.log(headroomLine(FIRST_LOAD_CEILING, firstLoad))
console.log('fonts the stylesheet names (raw woff2)')
for (const [file, size] of fonts) {
  console.log(`  ${file.slice(dist.length + 1).padEnd(44)} ${String(size).padStart(8)} B  (${kib(size)} KiB)`)
}
console.log(`  ${'total'.padEnd(44)} ${String(fontBytes).padStart(8)} B  (${kib(fontBytes)} KiB, ceiling ${kib(FONTS_CEILING)} KiB = ${FONTS_CEILING} B)`)
console.log(headroomLine(FONTS_CEILING, fontBytes))

console.log('diff panel, lazy (gzip -9; the chunk, and the chunks only it needs)')
for (const c of diffChunks) {
  console.log(`  ${c.url.padEnd(44)} ${String(c.gzip).padStart(8)} B  (${kib(c.gzip)} KiB)`)
}
console.log(`  ${'total'.padEnd(44)} ${String(diffBytes).padStart(8)} B  (${kib(diffBytes)} KiB, ceiling ${kib(DIFF_CEILING)} KiB = ${DIFF_CEILING} B)`)
console.log(headroomLine(DIFF_CEILING, diffBytes))

let failed = false
if (firstLoad > FIRST_LOAD_CEILING) {
  console.error(`\nfirst load is ${firstLoad - FIRST_LOAD_CEILING} B over the ${kib(FIRST_LOAD_CEILING)} KiB ceiling`)
  failed = true
}
if (fontBytes > FONTS_CEILING) {
  console.error(`\nfonts are ${fontBytes - FONTS_CEILING} B over the ${kib(FONTS_CEILING)} KiB ceiling`)
  failed = true
}
if (diffBytes > DIFF_CEILING) {
  console.error(`\nthe diff panel is ${diffBytes - DIFF_CEILING} B over the ${kib(DIFF_CEILING)} KiB ceiling`)
  failed = true
}
process.exit(failed ? 1 : 0)

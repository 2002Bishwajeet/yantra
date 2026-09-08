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
//   npm run budget            builds, then measures
//   npm run budget -- --no-build   measures the dist that is there
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const KIB = 1024
const FIRST_LOAD_CEILING = 200 * KIB
const FONTS_CEILING = 80 * KIB

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

const firstLoad = chunks.reduce((sum, c) => sum + c.gzip, 0)
const fontBytes = [...fonts.values()].reduce((sum, n) => sum + n, 0)

console.log('first load of /  (gzip -9, which is the wire since Y-357)')
for (const c of chunks) {
  console.log(`  ${c.url.padEnd(44)} ${String(c.gzip).padStart(8)} B  (${kib(c.gzip)} KiB)`)
}
console.log(`  ${'total'.padEnd(44)} ${String(firstLoad).padStart(8)} B  (${kib(firstLoad)} KiB, ceiling 200 KiB = ${FIRST_LOAD_CEILING} B)`)
console.log('fonts the stylesheet names (raw woff2)')
for (const [file, size] of fonts) {
  console.log(`  ${file.slice(dist.length + 1).padEnd(44)} ${String(size).padStart(8)} B  (${kib(size)} KiB)`)
}
console.log(`  ${'total'.padEnd(44)} ${String(fontBytes).padStart(8)} B  (${kib(fontBytes)} KiB, ceiling 80 KiB = ${FONTS_CEILING} B)`)

let failed = false
if (firstLoad > FIRST_LOAD_CEILING) {
  console.error(`\nfirst load is ${firstLoad - FIRST_LOAD_CEILING} B over the 200 KiB ceiling`)
  failed = true
}
if (fontBytes > FONTS_CEILING) {
  console.error(`\nfonts are ${fontBytes - FONTS_CEILING} B over the 80 KiB ceiling`)
  failed = true
}
process.exit(failed ? 1 : 0)

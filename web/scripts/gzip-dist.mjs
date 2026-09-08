// The wire, written once at build time: yantrad answers `Accept-Encoding:
// gzip` with the `.gz` beside each file, so the appliance never compresses the
// same bytes twice (Y-357). Fonts and images are left alone, because woff2 and
// png carry their own compression.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = resolve(import.meta.dirname, '..', 'dist')

let count = 0
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(js|css|svg|html)$/.test(entry.name)) continue
  const file = join(entry.parentPath, entry.name)
  writeFileSync(`${file}.gz`, gzipSync(readFileSync(file), { level: 9 }))
  count += 1
}
console.log(`gzipped ${count} files beside dist`)

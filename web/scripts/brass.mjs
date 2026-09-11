// Y-383: writes the brass scheme into src/m3/tokens.css and
// docs/design/palette-brass.json. Run from web/: `node scripts/brass.mjs`.
// The engine goes through Vite because its imports lack `.js` (R14 §2.1).
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  ssr: { noExternal: ['@material/material-color-utilities'] },
})
const { BRASS, OWNER, roles, schemeFor, states } = await vite.ssrLoadModule('/src/m3/theme/scheme.ts')
await vite.close()

const light = schemeFor(BRASS, false)
const dark = schemeFor(BRASS, true)
const title = (role) => role.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
const named = (scheme) => Object.fromEntries(roles.map((role) => [title(role), scheme[role]]))

writeFileSync(
  '../docs/design/palette-brass.json',
  `${JSON.stringify(
    {
      name: 'Yantra / M3 scheme, brass',
      note: "Y-383. The owner's dark palette of 2026-09-10 is `inputs`; light and dark are what web/scripts/brass.mjs builds from it. Regenerate, never edit.",
      inputs: OWNER,
      light: named(light),
      dark: named(dark),
      states: { light: states(false), dark: states(true) },
    },
    null,
    2,
  )}\n`,
)

let css = readFileSync('src/m3/tokens.css', 'utf8')
const swap = (pattern, value) => {
  if (!pattern.test(css)) throw new Error(`tokens.css has no ${pattern}`)
  css = css.replace(pattern, value)
}
for (const role of roles) {
  swap(
    new RegExp(`(  --md-sys-color-${role}: )light-dark\\([^)]*\\);`),
    `$1light-dark(${light[role]}, ${dark[role]});`,
  )
  swap(new RegExp(`(    --md-sys-color-${role}: )#[0-9A-F]{6};`), `$1${light[role]};`)
}
const [day, night] = [states(false), states(true)]
for (const state of Object.keys(day)) {
  swap(
    new RegExp(`(  --yantra-state-${state}: )light-dark\\([^)]*\\);`),
    `$1light-dark(${day[state]}, ${night[state]});`,
  )
  swap(new RegExp(`(    --yantra-state-${state}: )#[0-9A-F]{6};`), `$1${day[state]};`)
}
writeFileSync('src/m3/tokens.css', css)

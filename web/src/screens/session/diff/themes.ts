// Stands in for `@pierre/theming/themes` in the build (vite.config.ts): the real entry
// bundles every Shiki theme, and the panel draws Pierre's two.
export { pierreThemes } from '../../../../node_modules/@pierre/theming/dist/collections/pierre.js'
export { createTheme } from '../../../../node_modules/@pierre/theming/dist/modules/createTheme.js'

export const shikiThemes = { getTheme: (): undefined => undefined }

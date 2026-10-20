// Stands in for `@pierre/theming/themes` in the build (vite.config.ts). The
// real entry bundles every Shiki theme as a file of its own; the diff panel
// draws Pierre's two. A theme this does not know is an error, as it is upstream.
export { pierreThemes } from '../../../../node_modules/@pierre/theming/dist/collections/pierre.js'
export { createTheme } from '../../../../node_modules/@pierre/theming/dist/modules/createTheme.js'

export const shikiThemes = { getTheme: (): undefined => undefined }

// Stands in for `shiki/wasm` in the build (vite.config.ts). Pierre loads it
// only when asked for the `shiki-wasm` highlighter, which this panel never is.
throw new Error('The wasm highlighter is not part of this build.')

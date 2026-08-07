import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// A bail-out is otherwise silent: panicThreshold defaults to "none", so a
// component the compiler declined builds, exits 0, and is emitted unchanged.
const logger = {
  logEvent(
    filename: string | null,
    event: { kind: string; detail?: { reason?: string } },
  ) {
    if (event.kind !== 'CompileSuccess') {
      console.warn(
        `react-compiler: ${event.kind} in ${filename ?? '<unknown>'}: ${event.detail?.reason ?? ''}`,
      )
    }
  },
}

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset({ logger })] }),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // yantrad binds this machine's Tailscale addresses and refuses loopback
  // (R-22), so `npm run dev` supplies the real target.
  server: {
    proxy: {
      // `ws`, because the terminal is an upgrade on this same prefix and the
      // string form of a proxy entry forwards only the plain requests.
      '/api': {
        target: process.env.YANTRA_API ?? 'http://127.0.0.1:7717',
        ws: true,
      },
    },
  },
  test: { environment: 'jsdom' },
})

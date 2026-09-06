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
    // A phone or a Mac on the tailnet opens the dev server by its MagicDNS
    // name, which Vite refuses unless the host is listed.
    allowedHosts: ['.ts.net'],
    proxy: {
      // `ws`, because the terminal is an upgrade on this same prefix and the
      // string form of a proxy entry forwards only the plain requests.
      '/api': {
        target: process.env.YANTRA_API ?? 'http://127.0.0.1:7717',
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    // Playwright's specs live under e2e/ and refuse Vitest's runner.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'design/**'],
    // R14 §2.1: the colour package's own imports lack `.js`, so Node refuses
    // them and only Vite's resolver loads it.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// D0 §7: the options round renders candidate stylesheets on the real fleet
// page. A second Vite root, so nothing here reaches the production bundle.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // One file, so `onefile.mjs` can fold it into a page with no server behind
    // it: fonts inline as data URIs and the route chunks stay in the one script.
    assetsInlineLimit: 1e9,
    rolldownOptions: { output: { codeSplitting: false } },
  },
})

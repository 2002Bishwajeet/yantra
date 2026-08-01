// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    // design/tokens.css lives at the repo root so the M4 dashboard can import the same
    // file; Vite needs permission to read above the Astro project root to serve it in dev.
    server: { fs: { allow: ['..'] } },
  },
});

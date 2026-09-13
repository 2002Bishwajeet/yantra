// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Production, never a preview URL: canonical and og:url are built from this.
  site: 'https://yantra.cloudx.run',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});

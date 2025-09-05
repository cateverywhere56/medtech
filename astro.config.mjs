import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://medtech-interventional-news.netlify.app/',
  build: {
    outDir: 'dist' // <-- on force le dossier de sortie
  },
});


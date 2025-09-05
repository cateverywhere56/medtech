import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://hightech-news.netlify.app/',
  build: {
    outDir: 'dist' // <-- on force le dossier de sortie
  },
});


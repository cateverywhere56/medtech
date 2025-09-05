import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://cateverywhere56.github.io/medtech',
  build: {
    outDir: 'dist' // <-- on force le dossier de sortie
  },
});


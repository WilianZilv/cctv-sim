import { defineConfig } from 'vite';

// generated output (tens of thousands of dataset images, captures) is no source:
// watching it made the dev server stall while tools/dataset.mjs kept writing
export default defineConfig({
  server: {
    watch: { ignored: ['**/dataset/**', '**/shots/**', '**/*.log'] },
  },
});

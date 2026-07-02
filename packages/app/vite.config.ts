import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' keeps built asset URLs relative so the same build works
// standalone AND embedded in a WordPress page or iframe.
export default defineConfig({
  plugins: [react()],
  base: './',
  // The engine is a linked workspace package whose entry imports a CJS
  // artifact (vendor/orkengine.cjs). Prebundle it so dev mode gets the same
  // CJS->ESM interop the production build gets from rollup-commonjs.
  optimizeDeps: {
    include: ['@online-openrocket/engine'],
  },
  build: {
    commonjsOptions: {
      // Separator-agnostic: on Windows resolved ids may use backslashes.
      include: [/vendor[\\/]orkengine\.cjs$/, /node_modules/],
    },
  },
});

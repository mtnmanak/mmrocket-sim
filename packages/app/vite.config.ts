import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base './' keeps built asset URLs relative so the same build works
// standalone AND embedded in a WordPress page or iframe.
export default defineConfig({
  plugins: [react()],
  base: './',
});

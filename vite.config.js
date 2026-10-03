import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs let the UI work at "/" and behind a prefix-stripping proxy such as "/wgg/".
  base: './',
  build: {
    outDir: './ui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9998',
    },
  },
});

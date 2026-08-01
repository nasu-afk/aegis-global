import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:4000',
        changeOrigin: true
      },
      '/ws': {
        target: process.env.VITE_WS_URL || 'ws://localhost:4000',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      external: [],
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]react-router-dom[\\/]|[\\/]react-router[\\/]|[\\/]react-dom[\\/]|[\\/]react[\\/]/.test(id)) return 'vendor';
          if (/[\\/]zustand[\\/]|[\\/]@tanstack[\\/]react-query[\\/]/.test(id)) return 'state';
          if (/[\\/]axios[\\/]|[\\/]date-fns[\\/]|[\\/]zod[\\/]/.test(id)) return 'utils';
        }
      }
    },
    commonjsOptions: {
      transformMixedEsModules: true
    }
  },
  define: {
    'process.env': {}
  }
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The proof verifier (bb.js) ships WebAssembly and workers that must not be pre-bundled.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { exclude: ['@aztec/bb.js'] },
  build: { target: 'esnext' },
  worker: { format: 'es' },
  resolve: { dedupe: ['react', 'react-dom'] },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverTarget = `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the game server runs on its own port; forward socket traffic to it.
    proxy: {
      '/socket.io': { target: serverTarget, ws: true },
      '/healthz': { target: serverTarget }
    }
  },
  build: {
    outDir: 'dist/client'
  }
});

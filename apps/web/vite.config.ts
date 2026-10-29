import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Share FRIDAY_PORT / FRIDAY_WEB_PORT with the server. Only these two variables are read here;
// nothing from .env is exposed to client code.
const rootEnv = path.resolve(import.meta.dirname, '../../.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const apiPort = process.env.FRIDAY_PORT || '4317';
const webPort = Number(process.env.FRIDAY_WEB_PORT || 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: 'localhost',
    port: webPort,
    strictPort: true,
    proxy: {
      // The browser only talks to Vite; the API key stays in the server process.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});

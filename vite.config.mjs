import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist', sourcemap: false, manifest: true,
    rolldownOptions: {input: {
      desktop: fileURLToPath(new URL('./index.html', import.meta.url)),
      remote: fileURLToPath(new URL('./remote.html', import.meta.url))
    }}
  },
  server: {host: '127.0.0.1', port: 5173, strictPort: true}
});

import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'url';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        app:  fileURLToPath(new URL('./app.html',  import.meta.url)),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});

import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/cdn': 'http://localhost:8787',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        adminPanel: 'admin-panel.html',
      },
    },
  },
})
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4174',
      '/workspace': 'http://127.0.0.1:4174',
    },
  },
  build: {
    // The read-only Showcase is a separate deployable. Building it must not
    // overwrite the production Agent bundle whose bytes are fingerprinted by
    // release evidence and served by the local Agent server.
    outDir: mode === 'showcase' ? 'dist-showcase' : 'dist-client',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/')) return 'vendor'
        },
      },
    },
  },
}))

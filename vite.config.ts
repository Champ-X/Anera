import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { ANERA_DEV_PROXY } from './src/shared/dev-proxy'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: ANERA_DEV_PROXY,
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

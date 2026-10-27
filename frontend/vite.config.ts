import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    // fix252c: test:paint makes a second build with every file renamed (SL_BUILD_SALT) to open a page from it while the
    // server runs this one (a tab left open across a deploy); never set for the real build
    process.env.SL_BUILD_SALT ? { name: 'sl-build-salt', renderChunk: (code: string) => `${code}\n// build ${process.env.SL_BUILD_SALT}\n` } : null,
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // fix252c: one React on the page, ever
    dedupe: ['react', 'react-dom'],
  },
  build: {
    rollupOptions: {
      output: {
        // fix252c: React, react-dom, the router and the module helpers they share in exactly one vendor chunk (checked
        // after every build: scripts/chunks-check.mjs)
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router)[\\/]/.test(id)) return 'react'
          if (id.includes('commonjsHelpers') || id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) return 'react'
          return undefined
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})

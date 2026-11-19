import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
export default defineConfig({
  main: { build: { externalizeDeps: false } },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    resolve: { alias: { '@design': resolve('design') } },
    plugins: [react()],
    build: { minify: 'esbuild', assetsInlineLimit: 0, rollupOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]' } } }
  }
})

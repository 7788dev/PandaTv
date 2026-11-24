import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: { build: { externalizeDeps: false } },
  preload: { build: { externalizeDeps: false } },
  renderer: {
    plugins: [react()],
    build: { minify: 'esbuild', assetsInlineLimit: 0, rollupOptions: { output: { assetFileNames: 'assets/[name]-[hash][extname]' } } }
  }
})

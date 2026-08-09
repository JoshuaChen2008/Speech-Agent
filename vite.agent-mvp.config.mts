import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(import.meta.dirname, 'src/agent-mvp/renderer')

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'src/agent-mvp/renderer-dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, 'index.html') }
  }
})

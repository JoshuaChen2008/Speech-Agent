import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const sourceRoot = resolve(import.meta.dirname, 'src')

export default defineConfig({
  root: sourceRoot,
  base: './',
  plugins: [
    react(),
    {
      name: 'loopback-only-development-csp',
      apply: 'serve',
      transformIndexHtml (html) {
        return html.replace(
          "default-src 'none';",
          "default-src 'none'; connect-src 'self' ws://127.0.0.1:5173;"
        )
      }
    }
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: resolve(sourceRoot, 'renderer-dist'),
    emptyOutDir: true,
    manifest: 'manifest.json',
    rollupOptions: {
      input: {
        caption: resolve(sourceRoot, 'caption/index.html'),
        toolbar: resolve(sourceRoot, 'toolbar/index.html'),
        settings: resolve(sourceRoot, 'settings/settings.html'),
        history: resolve(sourceRoot, 'history/index.html')
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
})

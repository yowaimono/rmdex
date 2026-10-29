import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'pc',
  plugins: [vue()],
  build: { outDir: resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist-pc'), emptyOutDir: true },
})

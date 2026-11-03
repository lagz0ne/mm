import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  // dev only: PORT for vite, BOARD_URL = a running board server to proxy the API to
  server: { port: Number(process.env.PORT) || undefined, proxy: { '/api': { target: process.env.BOARD_URL || 'http://127.0.0.1:' + (process.env.BOARD_PORT || '') } } },
})

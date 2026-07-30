import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '')

  const apiTarget = environment.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000'

  return {
    envDir: '../..',

    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
      }),

      react(),

      tailwindcss(),
    ],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,

      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },

        '/health': {
          target: apiTarget,
          changeOrigin: true,
        },

        '/ready': {
          target: apiTarget,
          changeOrigin: true,
        },

        '/metrics': {
          target: apiTarget,
          changeOrigin: true,
        },

        '/docs': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
    },
  }
})

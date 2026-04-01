import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const desktopMode = process.env.VITE_DESKTOP_MODE === '1'

// https://vite.dev/config/
export default defineConfig({
  // Desktop packaged webview/file serving needs relative asset paths.
  base: desktopMode ? './' : '/',
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
      "/screenshots": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
      "/screenshots": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
})

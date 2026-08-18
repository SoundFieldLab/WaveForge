import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { splitCityData } from './scripts/split-city-data.mjs'

// 安卓专用构建：只打 index.html 单入口（桌面多入口构建不受影响）。
// 产物输出到 android/app/src/main/assets/nodejs-project/dist/，
// 由设备内置 Node 的 android-server.mjs 静态托管。
const splitCityDataPlugin = (): Plugin => ({
  name: 'split-city-data',
  buildStart() {
    splitCityData()
  },
  configureServer() {
    splitCityData()
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), splitCityDataPlugin()],
  // 服务端从 http://localhost:3001/ 提供页面，相对路径即可。
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'android/app/src/main/assets/nodejs-project/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    // Android 电视盒子 WebView 可能停留在 Chromium 51~76：把现代语法（??/?./可选链等）
    // 全部转译到 ES2017，避免老内核解析失败整页白屏。
    target: 'es2017',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
})

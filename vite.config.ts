import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { splitCityData } from './scripts/split-city-data.mjs'

// 在 build/dev 启动前把 country-state-city 的城市数据按国家/地区拆分为独立 JSON 文件，
// locationHierarchy.ts 通过 import.meta.glob 按国家懒加载，避免 8MB 巨型 chunk。
const splitCityDataPlugin = (): Plugin => ({
  name: 'split-city-data',
  buildStart() {
    splitCityData()
  },
  configureServer() {
    splitCityData()
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), splitCityDataPlugin()],
  // 打包版用 loadFile()（file:// 协议）加载 dist/index.html；
  // base 必须是 './'，否则资源以 /assets/... 绝对路径引用，file:// 下会 404 导致整窗黑屏。
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
    watch: {
      ignored: ['**/dist/**', '**/release/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 大块数据均已改为懒加载：最大的常规 chunk 约 500KB，最大的懒加载数据 chunk（城市数据）约 2MB。
    // 阈值设为 2000 让构建输出不再误报（>2MB 仍会告警，便于发现新的体积回归）。
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // 生产入口显式白名单；开发诊断/预览 HTML 不进入发布产物。
      input: [
        path.resolve(__dirname, 'index.html'),
        path.resolve(__dirname, 'desktop-player.html'),
        path.resolve(__dirname, 'desktop-lyrics.html'),
      ],
      output: {
        // 将稳定的大体量第三方依赖拆为独立 vendor chunk：
        // 1) 提升浏览器并行加载（虽然桌面版用 file:// 串行加载，但 chunk 尺寸更小、更利于缓存命中与懒加载）。
        // 2) React 生态（react/react-dom/scheduler）与动画库（framer-motion + motion-dom/motion-utils）
        //    在主应用与两个桌面窗口入口之间共享；leaflet 目前只在天气地图懒加载路径使用。
        // 注意：base 保持 './'，Vite 会自动生成相对路径，拆 chunk 不影响 file:// 下资源定位。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('leaflet')) return 'vendor-leaflet'
          if (id.includes('framer-motion') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) return 'vendor-motion'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-is/') || id.includes('/scheduler/')) return 'vendor-react'
        },
      },
    },
  },
})

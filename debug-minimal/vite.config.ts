/**
 * 调试平台 Vite 配置。
 *
 * 关键点：`@` 别名直接指向主仓库的 src/，所以调试平台加载的就是**主程序同一份**
 * DG-LAB 组件与客户端代码。在这里改 UI / 改映射逻辑，主程序（WaveForge）立刻同步；
 * 反过来也一样——不存在需要「改回去」的第二份副本。
 *
 * 端口 3100 与主程序的 3000 错开，两个前端可同时开着对比。
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // 复用主仓库源码（DG-LAB 插件本体就在这里）
      '@': path.resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 3100,
    host: '127.0.0.1',
    strictPort: true,
    // 监视主仓库 src/：改插件代码即时热更新（否则跨出 root 的改动不触发）
    fs: { allow: [path.resolve(__dirname, '..')] },
    watch: {
      ignored: ['**/dist/**', '**/release/**', '**/node_modules/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

/**
 * Android 端后端入口（由 nodejs-mobile 以 node <nodejs-project>/main.cjs 启动）。
 *
 * local-server.mjs 在 import 时即绑定 127.0.0.1:3001 并注册全部 API 路由，
 * 这里拿到同一个 express 实例后追加前端静态资源托管：
 *   - API 路由先注册，/api/* 优先命中；
 *   - 其余 GET 请求回退到打包好的 SPA（dist/）。
 * 页面与 API 同源（http://localhost:3001），无需 CORS，也没有 http 音频 CDN 的混合内容问题。
 * TV 扩展（壁纸扫码上传 + 25567 远程遥控器 + /api/tv/*）来自 tv-extensions.mjs。
 *
 * 桌面端不受影响：桌面直接 `node local-server.mjs`，本文件不会被引用。
 * 注意：打包为 CJS（nodejs-mobile 以 require 方式加载），不能用 import.meta.url；
 * 资源根目录由进程入口参数 argv[1]（main.cjs 路径）推导。
 */
// ── 后端日志环形缓冲（TV 调试面板轮询展示）：必须先于 local-server 的 import，捕获其启动日志 ──
const serverLogs = []
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[method].bind(console)
  console[method] = (...args) => {
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.stack || a.message
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
    serverLogs.push({
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level: method,
      text,
    })
    if (serverLogs.length > 300) serverLogs.splice(0, serverLogs.length - 300)
    orig(...args)
  }
}

import localApp from './local-server.mjs'
import express from 'express'
import { dirname, join } from 'path'
import { installTvExtensions, getLanIPv4Addresses } from './tv-extensions.mjs'

const serverRoot = dirname(process.argv[1] || process.cwd())
const distDir = join(serverRoot, 'dist')
const indexPath = join(distDir, 'index.html')

// 壁纸存储目录：放在 nodejs-project 的上级（filesDir 层），应用更新不会清空
const wallpapersDir = join(dirname(serverRoot), 'waveforge-wallpapers')

localApp.use(express.static(distDir))

// SPA 回退：非 /api/ 的 GET 请求交给前端路由。
localApp.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next()
  }
  res.sendFile(indexPath)
})

// TV 扩展：壁纸扫码上传（25567）+ 远程遥控器（25567）+ /api/tv/* 路由
// （含局域网调试服务 :3002：日志/崩溃/热更新/远程控制，按持久化的开发者模式状态启停）
installTvExtensions({ app: localApp, wallpapersDir, serverName: 'WaveForge TV', serverLogs, distDir })

console.log('[WaveForge Android] API + SPA 已就绪: http://localhost:3001')
console.log(`[WaveForge Android] 远程遥控器: http://0.0.0.0:25567（${getLanIPv4Addresses().length} 个网卡）`)

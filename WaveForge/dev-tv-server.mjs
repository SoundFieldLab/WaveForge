/**
 * Dev 测试后端：在 local-server.mjs（127.0.0.1:3001）基础上加载 TV 扩展端点，
 * 让浏览器 ?tv=1 也能测试壁纸扫码上传与手机远程遥控器（25567）。
 * 仅用于开发调试，正式发行版本不引用本文件（Electron 直接 fork local-server.mjs）。
 *
 * 用法：node dev-tv-server.mjs  （即 npm run dev:api）
 *
 * 壁纸扫码上传流程（同真机）：
 *   手机浏览器打开 http://<本机局域网IP>:25567/wallpaper → 上传 → 存项目根 waveforge-wallpapers/
 *   → 前端从 http://localhost:3001/api/tv/wallpapers 拉回并导入 IndexedDB。
 */
// 后端日志环形缓冲：必须在本文件动态 import local-server 之前捕获 console，
// 才能记下 local-server 的启动日志（dev 调试面板后端日志可用）。
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

const { default: localApp } = await import('./local-server.mjs')
const { installTvExtensions, getLanIPv4Addresses } = await import('./tv-extensions.mjs')
const { fileURLToPath } = await import('url')
const { dirname, join } = await import('path')
const { mkdirSync } = await import('fs')

const ROOT = dirname(fileURLToPath(import.meta.url))
const wallpapersDir = join(ROOT, 'waveforge-wallpapers')
mkdirSync(wallpapersDir, { recursive: true })

installTvExtensions({ app: localApp, wallpapersDir, serverName: 'WaveForge Dev', serverLogs })

console.log(`[WaveForge Dev] 远程遥控器: http://0.0.0.0:25567（${getLanIPv4Addresses().length} 个网卡）`)
console.log(`[WaveForge Dev] 壁纸扫码上传目录: ${wallpapersDir}`)

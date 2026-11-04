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
import { randomBytes } from 'crypto'
import { installTvExtensions, getLanIPv4Addresses } from './tv-extensions.mjs'

// 本机 API 鉴权令牌：MainActivity 每次启动随机生成、经 argv 传入
// （--waveforge-local-token=<hex>）。此前未设置 → local-service-auth fail-open，
// 本机任意 App 都能调用 3001 的全部读写路由（读登录态/写歌单/触发调试服务）。
// WebView 侧由 MainActivity.shouldInterceptRequest 统一注入同名请求头。
const argvToken = process.argv.slice(2).find((a) => a.startsWith('--waveforge-local-token='))
const localToken = argvToken ? argvToken.slice('--waveforge-local-token='.length) : randomBytes(32).toString('base64url')
if (localToken) process.env.WAVEFORGE_LOCAL_TOKEN = localToken

const serverRoot = dirname(process.argv[1] || process.cwd())
const distDir = join(serverRoot, 'dist')
const indexPath = join(distDir, 'index.html')

// 壁纸存储目录：放在 nodejs-project 的上级（filesDir 层），应用更新不会清空
const wallpapersDir = join(dirname(serverRoot), 'waveforge-wallpapers')

localApp.use(express.static(distDir))

// ── QQ 音乐 App 扫码登录（移动端专属通道）──
// 官方网页二维码（ptlogin2/ptqrshow）已被腾讯风控封锁（实测 403 → 跳腾讯网首页），
// PC 与移动端同因失效。这里把桌面端同源的 App 扫码协议（musicu CreateQRCode + MQTT
// 推送，desktop/qqMusicQrLogin.cjs）打包进 nodejs-mobile 后端，暴露 3 个路由给
// MainActivity 原生轮询：start 生成二维码 base64 → poll 等扫码/拿 cookie → cancel 清理。
// cookie 与 PC 登录同口径（qm_keyst/uin），拿到后走既有 /api/qq/cookie 落库。
// 注意：必须用静态 import——createRequire 的运行时 require 无法被 esbuild 追踪打包，
// 设备端 assets 里没有 desktop/ 目录会导致启动时 MODULE_NOT_FOUND。
import { createQqMusicQrLogin } from './desktop/qqMusicQrLogin.cjs'
const qqAppLogin = createQqMusicQrLogin({ statePath: join(dirname(serverRoot), 'waveforge-qq-qr-device.json') })

localApp.post('/api/qq/app-qr/start', async (_req, res) => {
  try {
    qqAppLogin.cancel() // 幂等清理上一会话
    const { image, expiresInMs } = await qqAppLogin.start()
    res.json({ ok: true, image, expiresInMs })
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : '二维码生成失败' })
  }
})
localApp.get('/api/qq/app-qr/poll', async (_req, res) => {
  try {
    const result = await qqAppLogin.poll()
    // 成功即把 cookie 落到既有全局登录态（与手动粘贴同一入口）
    if (result?.status === 'success' && result.cookie) {
      try {
        const cookieResp = await fetch('http://127.0.0.1:3001/api/qq/cookie', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie: result.cookie }),
        })
        console.log('[QQ App 扫码] cookie 已落库:', cookieResp.status)
      } catch (e) {
        console.warn('[QQ App 扫码] cookie 落库失败:', e instanceof Error ? e.message : e)
      }
    }
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : '轮询失败' })
  }
})
localApp.post('/api/qq/app-qr/cancel', (_req, res) => {
  try { qqAppLogin.cancel() } catch { /* ignore */ }
  res.json({ ok: true })
})

// ── 汽水音乐 App 扫码登录（移动端专属通道，2026-11-05）──────────────────────
// 协议族与桌面端 qishui-auth-v6 相同（官方 Passport QR：get_qrcode → check_qrconnect
// → .qishui.com 会话 Cookie）。签名执行宿主是 MainActivity 的 1×1 离屏 WebView
// （加载本模块代理的 security_host.html，bdms SDK 在页面里照常工作）——替代
// 桌面端的隐藏 BrowserWindow。旧方案（开抖音首页抓 .douyin.com Cookie）已废弃：
// 抓到的抖音 Cookie 在汽水 luna Web API 一律 403，登录永远不闭环（实机事故）。
import { createQishuiAuthNode } from './server/qishui-auth-node.cjs'
const sodaAppLogin = createQishuiAuthNode({
  configFile: join(dirname(serverRoot), 'waveforge-userdata', 'soda-qr-login.json'),
  log: (message) => console.log(message),
})

localApp.post('/api/soda/app-qr/start', async (_req, res) => {
  try {
    sodaAppLogin.cancel()
    const envelope = await sodaAppLogin.getQrCode()
    const data = envelope.data || {}
    res.json({ ok: true, image: data.qrcode, token: data.token, expiresInMs: 3 * 60 * 1000 })
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : '二维码生成失败' })
  }
})

// 离屏签名 WebView 的入口页：跳转到运行时 assetBase（token 前缀随机，不可硬编码）。
// getQrCode 前资产服务可能未启动——这里先懒启动保证 assetBase 有效。
localApp.get('/api/soda/app-qr/sign-page', async (_req, res) => {
  try {
    await sodaAppLogin.startAssetServer()
    res.redirect(sodaAppLogin.assetBase + '/security_host.html')
  } catch (err) {
    res.status(502).send('sign page unavailable: ' + (err instanceof Error ? err.message : 'unknown'))
  }
})

localApp.get('/api/soda/app-qr/poll', async (req, res) => {
  try {
    const token = String(req.query.token || '')
    if (!token) return res.json({ ok: true, status: 'error', message: '缺少 token' })
    const envelope = await sodaAppLogin.checkQrConnect(token)
    const data = envelope.data || {}
    const errorCode = Number(data.error_code)
    const statusCode = String(data.status || '')
    if (errorCode === 0 && (statusCode === '3' || statusCode === 'confirmed' || data.session_cookie)) {
      const cookie = sodaAppLogin.readSessionCookie()
      // 与手动粘贴同链路验证 + 回传资料（/api/soda/status 校验 cookie 有效性）
      let profile = null
      try {
        const statusResp = await fetch(`http://127.0.0.1:3001/api/soda/status?cookie=${encodeURIComponent(cookie)}`, {
          headers: { 'X-WaveForge-Local-Token': String(process.env.WAVEFORGE_LOCAL_TOKEN || '') },
        })
        const statusData = await statusResp.json().catch(() => null)
        if (statusData?.loggedIn) profile = statusData.profile || null
      } catch { /* 资料获取失败不阻塞登录回传 */ }
      return res.json({ ok: true, status: 'success', cookie, profile })
    }
    if (errorCode === 2046) {
      return res.json({ ok: true, status: 'scanned', message: '需要二次验证，请在手机上确认' })
    }
    // status: 1=已生成待扫 2=已扫描待确认 5=过期
    if (statusCode === '5') return res.json({ ok: true, status: 'expired' })
    if (statusCode === '2') return res.json({ ok: true, status: 'scanned' })
    return res.json({ ok: true, status: 'waiting' })
  } catch (err) {
    const message = err instanceof Error ? err.message : '轮询失败'
    if (err && err.code === 'QISHUI_MFA_CANCELLED') {
      return res.json({ ok: true, status: 'scanned', message })
    }
    res.status(500).json({ ok: false, error: message })
  }
})

localApp.post('/api/soda/app-qr/cancel', (_req, res) => {
  try { sodaAppLogin.cancel() } catch { /* ignore */ }
  res.json({ ok: true })
})

// SPA 回退：非 /api/ 的 GET 请求交给前端路由。
localApp.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next()
  }
  res.sendFile(indexPath)
})

// TV 扩展：壁纸扫码上传（25567）+ 远程遥控器（25567）+ /api/tv/* 路由
// （含局域网调试服务 :3008（:3002-3004 是 Python 服务）：日志/崩溃/热更新/远程控制，
// 按持久化的开发者模式状态启停，默认关；开启后须配对令牌访问）
installTvExtensions({ app: localApp, wallpapersDir, serverName: 'WaveForge TV', serverLogs, distDir })

console.log('[WaveForge Android] API + SPA 已就绪: http://localhost:3001')
console.log(`[WaveForge Android] 远程遥控器: http://0.0.0.0:25567（${getLanIPv4Addresses().length} 个网卡）`)

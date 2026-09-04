/**
 * 代理自动配置管理器
 *
 * 网络环境不佳时（模型下载/应用更新），用户打开代理软件后开启「代理自动配置」：
 * - 扫描本机常用代理端口（Clash 7890/7897、v2ray 10808/10809、SS 1080、8080/8888 等）
 * - 对每个端口发 CONNECT 探测（能建连 = 可用 HTTP 代理），隧道内做真实 TLS 握手测延迟
 * - 选中后把软件内部的模型下载/更新请求显式路由到该代理（独立 Electron session）
 * - 配置持久化到应用安装目录（proxy-config.json，与模型同位置，不占系统用户目录）
 */

const { app, BrowserWindow, net, session } = require('electron')
const netMod = require('net')
const tls = require('tls')
const fs = require('fs')
const path = require('path')

const COMMON_PORTS = [7890, 7897, 7891, 1080, 10808, 10809, 8080, 8888, 8118, 2080, 8889, 1087]
const CONFIG_PATH = () => path.join(path.dirname(app.getPath('exe')), 'proxy-config.json')

let state = { enabled: false, proxy: null }
let proxySession = null
let healthTimer = null
/** 启动时待消费的提示（渲染进程挂载后读取）：'startup-unavailable' 等 */
let pendingNotice = null
/** ping 谷歌结果：null=未测 / {status:'testing'} / {status:'done', result} */
let latencyState = null

const PING_COUNT = 8
/** 联通测试目标：网络联通（百度）/ GitHub / Google，三个并行测 */
const PING_HOSTS = [
  { key: 'baidu', label: '网络联通', host: 'www.baidu.com' },
  { key: 'github', label: 'GitHub 联通', host: 'github.com' },
  { key: 'google', label: 'Google 联通', host: 'www.gstatic.com' },
]

/** 经代理向 PING_HOST:443 发一次 CONNECT，隧道建立后在隧道内完成一次真实 TLS 握手；
 *  返回握手耗时 ms（即经代理到目标站的真实网络延迟），失败返回 null。
 *  只有代理真的把隧道打通到目标站，握手才能完成——CONNECT 秒回 200 但隧道不通的假代理会全部超时。 */
function connectThroughProxy(port, host, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false
    const socket = netMod.connect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      if (!done) { done = true; try { socket.destroy() } catch { /* ignore */ } resolve(null) }
    }, timeoutMs)
    socket.on('connect', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
    })
    let buf = ''
    let tunneled = false
    socket.on('data', (d) => {
      if (tunneled) return // 隧道后的字节交给 tls 层处理
      buf += d.toString()
      if (buf.includes(' 200 ')) {
        tunneled = true
        // 隧道已建立：向目标站发起真实 TLS 握手（关闭证书校验，只测连通与 RTT）
        const tlsStart = Date.now()
        const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
          if (!done) { done = true; clearTimeout(timer); try { tlsSocket.destroy() } catch { /* ignore */ } resolve(Date.now() - tlsStart) }
        })
        tlsSocket.on('error', () => {
          if (!done) { done = true; clearTimeout(timer); try { socket.destroy() } catch { /* ignore */ } resolve(null) }
        })
      } else if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(buf)) {
        if (!done) { done = true; clearTimeout(timer); try { socket.destroy() } catch { /* ignore */ } resolve(null) }
      }
    })
    socket.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
    socket.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
  })
}

/** 快速可用性验证：经代理对三个目标各做一次真实 TLS 握手（短超时、并行），
 *  至少一个成功即视为可用（部分目标不可达不代表代理整体失效） */
async function verifyUsable(port) {
  const deadline = Date.now() + 3000
  const results = await Promise.all(
    PING_HOSTS.map((h) => connectThroughProxy(port, h.host, Math.max(300, deadline - Date.now())))
  )
  return results.some((t) => t !== null)
}

/** 单个目标联通测试（最多 8 次）：整体超过 1 分钟则停止——
 *  有返回就按已完成次数计算；一次都没返回则标记连接超时。 */
async function probeHost(port, host, deadline) {
  const times = []
  let loss = 0
  let attempts = 0
  while (attempts < PING_COUNT) {
    if (Date.now() >= deadline) break
    const t = await connectThroughProxy(port, host, Math.min(5000, Math.max(200, deadline - Date.now())))
    attempts += 1
    if (t === null) loss += 1
    else times.push(t)
  }
  if (attempts === 0) {
    return { timeout: true, total: 0, loss: 0, lossRate: 100, avgLatency: 0, minLatency: 0, maxLatency: 0 }
  }
  return {
    timeout: false,
    total: attempts,
    loss,
    lossRate: Math.round((loss / attempts) * 100),
    avgLatency: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    minLatency: times.length ? Math.round(Math.min(...times)) : 0,
    maxLatency: times.length ? Math.round(Math.max(...times)) : 0,
  }
}

/** 三个目标并行联通测试，共享 1 分钟截止；返回按 key 分组的统计 */
async function probeAll(port) {
  const deadline = Date.now() + 60_000
  const results = {}
  await Promise.all(PING_HOSTS.map(async (h) => {
    results[h.key] = await probeHost(port, h.host, deadline)
  }))
  return results
}

/** 运行联通测试并广播结果（每次开关开启/启动仍开启时后台测一次）；任何异常都落到 done */
async function runProbe() {
  if (!state.enabled || !state.proxy) return
  latencyState = { status: 'testing' }
  broadcastLatency()
  try {
    const result = await probeAll(state.proxy.port)
    latencyState = { status: 'done', result }
  } catch (error) {
    logProxy(`联通测试异常: ${error instanceof Error ? error.message : String(error)}`)
    latencyState = { status: 'done', result: null }
  }
  broadcastLatency()
}

function broadcastLatency() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send('proxy-manager:latency', latencyState) } catch { /* 忽略 */ }
      }
    }
  } catch { /* 广播失败不阻断联通测试 */ }
}

function broadcastNotice(kind) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send('proxy-manager:notice', { kind }) } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
}

/** 关闭并广播通知（运行中断开 / 启动时无代理 / 启动时代理不可用） */
async function autoDisable(kind) {
  const wasEnabled = state.enabled
  state.enabled = false
  state.proxy = null
  saveConfig()
  if (proxySession) { proxySession.setProxy({ mode: 'direct' }).catch(() => {}) }
  if (wasEnabled) {
    if (kind === 'startup') {
      pendingNotice = 'startup-unavailable'
      logProxy(`代理自动关闭（启动时无代理端口）`)
    } else if (kind === 'startup-unusable') {
      pendingNotice = 'startup-unusable'
      logProxy(`代理自动关闭（启动时代理不可用：端口在但隧道不通）`)
    } else {
      logProxy(`代理自动关闭（运行中代理断开）`)
      broadcastNotice('disconnected')
    }
  }
}

/** 渲染进程加载完成后取走启动提示（确定性下发，避免时序竞态） */
function takePendingNotice() {
  const n = pendingNotice
  pendingNotice = null
  return n
}

function logProxy(message) {
  try {
    // 写入 automix 日志（主进程注入的 logger）
    if (typeof proxyLogger === 'function') proxyLogger('proxy', message)
  } catch { /* 忽略 */ }
}
let proxyLogger = null
function setProxyLogger(fn) { proxyLogger = fn }

/** 周期性健康检查：代理端口失效即自动关闭并通知（启动即检查一次，之后每 10s） */
function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer)
  logProxy(`代理健康检查启动（每 10s，端口 ${state.proxy ? state.proxy.port : '?'}）`)
  const check = async () => {
    if (!state.enabled || !state.proxy) { clearInterval(healthTimer); healthTimer = null; return }
    const alive = await testPort(state.proxy.port)
    if (!alive) {
      logProxy(`代理健康检查失败（端口 ${state.proxy.port} 不可用），自动关闭`)
      clearInterval(healthTimer)
      healthTimer = null
      await autoDisable('runtime')
    }
  }
  void check() // 立即检查一次，不用等第一个 10s
  healthTimer = setInterval(check, 10000)
  if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref()
}

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
    state = { enabled: saved.enabled === true, proxy: saved.proxy || null }
  } catch { /* 无配置，默认关闭 */ }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(state, null, 2)) } catch { /* 忽略 */ }
}

/** 探测单个端口是否是可用 HTTP 代理（CONNECT 握手），返回 {host, port, type, latency} 或 null */
function testPort(port) {
  return new Promise((resolve) => {
    let done = false
    const started = Date.now()
    const socket = netMod.connect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      if (!done) { done = true; try { socket.destroy() } catch { /* ignore */ } resolve(null) }
    }, 2500)
    socket.on('connect', () => {
      socket.write('CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\n\r\n')
    })
    let buf = ''
    socket.on('data', (d) => {
      buf += d.toString()
      if (buf.includes(' 200 ')) {
        if (!done) { done = true; clearTimeout(timer); try { socket.destroy() } catch { /* ignore */ }
          resolve({ host: '127.0.0.1', port, type: 'http', latency: Date.now() - started }) }
      } else if (/HTTP\/1\.[01] (4\d\d|5\d\d)/.test(buf)) {
        if (!done) { done = true; clearTimeout(timer); try { socket.destroy() } catch { /* ignore */ } resolve(null) }
      }
    })
    socket.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
    socket.on('close', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
  })
}

/** 扫描常用端口，返回按延迟升序的可用代理列表 */
async function scan() {
  const results = []
  for (const port of COMMON_PORTS) {
    const r = await testPort(port)
    if (r) results.push(r)
  }
  return results.sort((a, b) => a.latency - b.latency)
}

/** 代理会话：下载/更新请求显式路由到本机代理（enabled 时） */
async function getProxySession() {
  try {
    if (!proxySession) proxySession = session.fromPartition('ai-model-proxy', { cache: false })
    if (state.enabled && state.proxy) {
      await proxySession.setProxy({
        proxyRules: `http=127.0.0.1:${state.proxy.port};https=127.0.0.1:${state.proxy.port}`,
      })
    } else {
      await proxySession.setProxy({ mode: 'direct' })
    }
  } catch { /* 忽略 */ }
  return proxySession
}

async function enable(port) {
  state.enabled = true
  state.proxy = { host: '127.0.0.1', port: Number(port), type: 'http' }
  saveConfig()
  // 先启动健康检查（不依赖会话配置成功——会话异常不能导致检测失效），再配会话
  startHealthCheck()
  try { await getProxySession() } catch { /* 会话失败不阻断 */ }
  void runProbe() // 开关开启即测一次 ping
  return { ...state }
}

function disable() {
  state.enabled = false
  state.proxy = null
  saveConfig()
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
  if (proxySession) { proxySession.setProxy({ mode: 'direct' }).catch(() => {}) }
  return { ...state }
}

function getState() { return { ...state } }

function setupProxyIPC(ipcMain, automixLogFn) {
  if (automixLogFn) setProxyLogger(automixLogFn)
  loadConfig()
  // 启动检测：上次开着自动代理 → 验证代理是否真的可用。
  // 端口能回 CONNECT 200 不代表可用（残留进程/假代理会占着端口），再做一次真实 TLS 握手验证；
  // 端口不在 / 隧道不通都会自动关闭，并留待渲染进程消费的启动提示
  if (state.enabled && state.proxy) {
    testPort(state.proxy.port).then((r) => {
      if (r) {
        verifyUsable(state.proxy.port).then((usable) => {
          if (usable) {
            startHealthCheck()
            void runProbe() // 重启后功能仍开启：后台再测一次 ping 并填入
          } else {
            void autoDisable('startup-unusable')
          }
        })
      } else {
        void autoDisable('startup')
      }
    }).catch(() => { void autoDisable('startup') })
  }
  ipcMain.handle('proxy-manager:scan', () => scan())
  ipcMain.handle('proxy-manager:enable', (_e, port) => enable(port))
  ipcMain.handle('proxy-manager:disable', () => disable())
  ipcMain.handle('proxy-manager:get-state', () => getState())
  ipcMain.handle('proxy-manager:set-enabled', (_e, v) => {
    if (!v && state.enabled) return disable()
    return getState()
  })
  // 联通状态结果：一次性/轮询读取；probe = 立即重测（任何异常都返回 done，绝不悬挂）
  ipcMain.handle('proxy-manager:get-latency', () => latencyState)
  ipcMain.handle('proxy-manager:probe', async () => {
    if (!state.enabled || !state.proxy) return { status: 'done', result: null }
    latencyState = { status: 'testing' }
    broadcastLatency()
    try {
      const result = await probeAll(state.proxy.port)
      latencyState = { status: 'done', result }
    } catch (error) {
      logProxy(`联通测试异常: ${error instanceof Error ? error.message : String(error)}`)
      latencyState = { status: 'done', result: null }
    }
    broadcastLatency()
    return latencyState
  })
  // 渲染进程挂载后消费启动提示（一次性）
  ipcMain.handle('proxy-manager:consume-notice', () => {
    const n = pendingNotice
    pendingNotice = null
    return n
  })
}

module.exports = { setupProxyIPC, getProxySession, getState, takePendingNotice }
/**
 * TV 扩展端点（壁纸扫码上传 + 远程遥控器），供不同后端复用：
 *  - android-server.mjs（真机）：壁纸存设备存储，25567 遥控；
 *  - dev-tv-server.mjs（dev 测试后端）：壁纸存项目根，让浏览器 ?tv=1 也能测扫码上传/遥控。
 *
 * 端口用 25567 而非 PC 端的 25566：同一局域网内 PC 与 TV 同时开遥控时不冲突。
 *
 * 注意：本文件会被 esbuild 打包进 android 的 CJS bundle，不能用 import.meta.url；
 * 所有路径（壁纸目录）由调用方传入。
 */
import { createRemoteServer, getLanIPv4Addresses } from './desktop/remote-server.cjs'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, appendFileSync } from 'fs'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { dirname, join, sep } from 'path'
import { verifyCode } from './desktop/device-license.cjs'

// ── 局域网调试服务（:3008，仅开发者模式开启时运行） ──
// 电脑浏览器访问 http://<设备IP>:3008 查看后端日志/崩溃记录/前端错误，并可直接控制 App。
// 前端页面（localhost:3001）在开发者模式开启时连 ws://localhost:3008/ws 接收控制命令。
const DEBUG_PORT = 3008
let debugServer = null // { server, wss }
let debugPageClients = new Set() // 前端页面 WS 客户端

function setDebugServerEnabled(enabled, { serverLogs, crashFile, distDir = null }) {
  if (enabled && !debugServer) {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const sendJson = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(DEBUG_PANEL_HTML)
        return
      }
      if (url.pathname === '/logs') {
        sendJson({ lines: serverLogs.slice(-300), total: serverLogs.length })
        return
      }
      if (url.pathname === '/crash') {
        try {
          sendJson({ exists: existsSync(crashFile), content: readFileSync(crashFile, 'utf8') })
        } catch {
          sendJson({ exists: false, content: '' })
        }
        return
      }
      // 热更新：上传 dist 前端资源（index.html + assets/*）→ 替换 → 广播 reload 刷新页面
      if (url.pathname === '/update' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          try {
            const { files } = JSON.parse(body)
            if (!Array.isArray(files) || !files.length || !distDir) {
              sendJson({ ok: false, error: '缺少文件或 dist 目录不可用' })
              return
            }
            const distRoot = join(distDir) + sep
            let count = 0
            for (const f of files) {
              const rel = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
              const full = join(distDir, rel)
              if (!full.startsWith(distRoot) || rel.includes('..')) {
                sendJson({ ok: false, error: `非法路径: ${rel}` })
                return
              }
              mkdirSync(dirname(full), { recursive: true })
              writeFileSync(full, Buffer.from(String(f.data || ''), 'base64'))
              count++
            }
            // 通知前端页面刷新（新 bundle 生效）
            const reloadMsg = JSON.stringify({ type: 'reload' })
            for (const c of debugPageClients) {
              if (c.readyState === 1) {
                try { c.send(reloadMsg) } catch { /* ignore */ }
              }
            }
            console.log(`[调试服务] 热更新 ${count} 个文件`)
            sendJson({ ok: true, count })
          } catch (err) {
            sendJson({ ok: false, error: err?.message || '更新失败' })
          }
        })
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    })
    const wss = new WebSocketServer({ server, path: '/ws' })
    wss.on('connection', (ws) => {
      debugPageClients.add(ws)
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data))
          if (msg.type === 'command') {
            // 调试面板发出的控制命令 → 转发给前端页面执行
            const payload = JSON.stringify({ type: 'control', action: msg.action, value: msg.value })
            for (const c of debugPageClients) {
              if (c.readyState === 1) {
                try { c.send(payload) } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore */ }
      })
      ws.on('close', () => debugPageClients.delete(ws))
    })
    wss.on('error', () => {}) // 端口冲突等静默
    server.on('error', (err) => {
      console.error('[调试服务] 启动失败:', err?.message || err)
      debugServer = null
    })
    server.listen(DEBUG_PORT, '0.0.0.0')
    debugServer = { server, wss }
    console.log(`[调试服务] 已开启: http://0.0.0.0:${DEBUG_PORT}（局域网可访问）`)
  } else if (!enabled && debugServer) {
    try { debugServer.wss.close() } catch { /* ignore */ }
    try { debugServer.server.close() } catch { /* ignore */ }
    debugServer = null
    debugPageClients = new Set()
    console.log('[调试服务] 已关闭')
  }
}

// ── 局域网调试面板（开发者模式开启后，电脑浏览器访问 http://<设备IP>:3008） ──
const DEBUG_PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WaveForge TV 调试台</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0a0f14; color: #e6edf3; margin: 0; padding: 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; } .sub { color: #8b9bb4; font-size: 12px; margin-bottom: 16px; }
  .card { background: #11161f; border: 1px solid #1f2836; border-radius: 12px; padding: 14px; margin-bottom: 14px; }
  .card h2 { font-size: 13px; margin: 0 0 10px; color: #7ee787; }
  .btn { background: #1b2430; color: #e6edf3; border: 1px solid #2a3546; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; margin: 0 6px 6px 0; }
  .btn:hover { background: #243043; } .btn:active { transform: scale(.96); }
  .btn.primary { background: #4fc3f7; color: #06222e; border-color: transparent; font-weight: 600; }
  .log { font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.6; background: #0d1117; border-radius: 8px; padding: 10px; max-height: 280px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .log .warn { color: #ffd28a; } .log .error { color: #ff7b72; }
  .badge { display: inline-block; background: #2a3546; border-radius: 999px; padding: 2px 10px; font-size: 11px; color: #9db2cc; }
</style></head><body>
<h1>WaveForge TV 调试台</h1>
<div class="sub">本机调试服务 · 仅开发者模式开启时可用 · <span class="badge" id="wsState">未连接</span></div>

<div class="card">
  <h2>热更新（改完代码直接部署，无需重装）</h2>
  <p class="sub" style="margin:0 0 8px">选择 vite 构建产物（index.html + dist/assets/*）上传，设备自动替换并刷新页面。</p>
  <input type="file" id="fileInput" multiple webkitdirectory style="margin-bottom:8px;color:#9db2cc;font-size:12px">
  <button class="btn primary" id="uploadBtn">上传并刷新</button>
  <span id="uploadStatus" style="margin-left:8px;font-size:12px;color:#9db2cc"></span>
</div>

<div class="card">
  <h2>遥控 App（直接控制 TV 上的软件）</h2>
  <div>
    <button class="btn primary" data-a="toggle">播放/暂停</button>
    <button class="btn" data-a="prev">上一首</button>
    <button class="btn" data-a="next">下一首</button>
    <button class="btn" data-a="stop">停止</button>
    <button class="btn" data-a="rewind">快退10s</button>
    <button class="btn" data-a="fast-forward">快进10s</button>
    <button class="btn" data-a="volume" data-v="0.1">音量+</button>
    <button class="btn" data-a="volume" data-v="-0.1">音量-</button>
    <button class="btn" data-a="mute">静音</button>
  </div>
  <div style="margin-top:6px">
    <button class="btn" data-a="nav" data-v="up">▲ 上</button>
    <button class="btn" data-a="nav" data-v="down">▼ 下</button>
    <button class="btn" data-a="nav" data-v="left">◀ 左</button>
    <button class="btn" data-a="nav" data-v="right">▶ 右</button>
    <button class="btn primary" data-a="ok">OK 确定</button>
    <button class="btn" data-a="back">返回</button>
    <button class="btn" data-a="home">主页</button>
    <button class="btn" data-a="open-search">搜索</button>
    <button class="btn" data-a="open-settings">设置</button>
    <button class="btn" data-a="menu">菜单</button>
  </div>
</div>

<div class="card">
  <h2>后端日志 <button class="btn" style="padding:2px 8px;font-size:11px" id="clearLog">清屏</button></h2>
  <div class="log" id="logBox"></div>
</div>

<div class="card">
  <h2>崩溃记录（node 崩溃堆栈） <button class="btn" style="padding:2px 8px;font-size:11px" id="refreshCrash">刷新</button></h2>
  <div class="log" id="crashBox">（无崩溃记录）</div>
</div>

<script>
  var ws = new WebSocket('ws://' + location.host + '/ws');
  var wsState = document.getElementById('wsState');
  ws.onopen = function () { wsState.textContent = '已连接'; wsState.style.color = '#31e68b'; };
  ws.onclose = function () { wsState.textContent = '已断开'; wsState.style.color = '#ff6b81'; };
  ws.onerror = function () { wsState.textContent = '连接失败'; wsState.style.color = '#ff6b81'; };

  // 控制按钮 → 发命令（由 TV 前端页面执行）
  document.querySelectorAll('[data-a]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var action = btn.getAttribute('data-a');
      var value = btn.getAttribute('data-v') || undefined;
      if (action === 'nav') {
        // 方向键：走 D-pad（TV 空间导航）
        ws.send(JSON.stringify({ type: 'command', action: 'nav', value: value }));
        return;
      }
      ws.send(JSON.stringify({ type: 'command', action: action, value: value }));
    });
  });

  var logBox = document.getElementById('logBox');
  function loadLogs() {
    fetch('/logs').then(function (r) { return r.json(); }).then(function (d) {
      logBox.innerHTML = (d.lines || []).map(function (l) {
        var cls = l.level === 'error' ? 'error' : (l.level === 'warn' ? 'warn' : '');
        return '<span class="' + cls + '">[' + l.time + ' ' + l.level + '] ' + l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>';
      }).join('\\n');
      logBox.scrollTop = logBox.scrollHeight;
    }).catch(function () {});
  }
  loadLogs(); setInterval(loadLogs, 2000);
  document.getElementById('clearLog').addEventListener('click', function () { logBox.innerHTML = ''; });

  // 热更新：读取所选文件 → 上传到设备 dist → 自动刷新
  var fileInput = document.getElementById('fileInput');
  var uploadStatus = document.getElementById('uploadStatus');
  document.getElementById('uploadBtn').addEventListener('click', function () {
    var files = Array.prototype.slice.call(fileInput.files || []);
    if (!files.length) { uploadStatus.textContent = '请先选择构建产物文件'; return; }
    var payload = [];
    var done = 0;
    files.forEach(function (f) {
      // 只传相对路径（保留目录结构），base64 编码
      var rel = f.webkitRelativePath || f.name;
      var reader = new FileReader();
      reader.onload = function () {
        var data = reader.result.split(',')[1] || '';
        payload.push({ path: rel, data: data });
        done++;
        if (done === files.length) doUpload(payload);
      };
      reader.readAsDataURL(f);
    });
  });
  function doUpload(payload) {
    uploadStatus.textContent = '上传中…';
    fetch('/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payload }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      uploadStatus.textContent = d.ok ? ('已更新 ' + d.count + ' 个文件，页面即将刷新') : ('失败: ' + (d.error || ''));
    }).catch(function (e) { uploadStatus.textContent = '上传失败: ' + e.message; });
  }

  function loadCrash() {
    fetch('/crash').then(function (r) { return r.json(); }).then(function (d) {
      document.getElementById('crashBox').textContent = d.content ? ('最后崩溃（' + new Date().toLocaleString() + '）：\\n\\n' + d.content) : '（无崩溃记录）';
    }).catch(function () {});
  }
  loadCrash();
  document.getElementById('refreshCrash').addEventListener('click', loadCrash);
</script></body></html>`

// ── TV 壁纸扫码上传：手机浏览器 → 25567 上传页 → 存本地/设备存储 ──
// 手机上传的图片由 SPA 从 /api/tv/wallpapers 拉回并导入 wallpaperManager（IndexedDB）。
const UPLOAD_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>上传壁纸</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0a0f14; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100dvh; margin: 0; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 6px; }
  p { color: rgba(255,255,255,.6); font-size: 14px; }
  input[type=file] { margin: 20px 0; }
  button { background: #4fc3f7; color: #06222e; border: none; border-radius: 999px;
    padding: 12px 28px; font-size: 16px; font-weight: 700; cursor: pointer; }
  #status { margin-top: 16px; font-size: 14px; min-height: 20px; }
  .ok { color: #31e68b; } .err { color: #ff6b81; }
</style></head><body>
<h1>上传壁纸</h1>
<p>选择一张图片，上传后会出现在壁纸列表中</p>
<input type="file" id="file" accept="image/*">
<button id="btn">上传</button>
<div id="status"></div>
<script>
  document.getElementById('btn').addEventListener('click', async function () {
    var f = document.getElementById('file').files[0];
    var st = document.getElementById('status');
    if (!f) { st.className = 'err'; st.textContent = '请先选择图片'; return; }
    var fd = new FormData();
    fd.append('file', f);
    st.className = ''; st.textContent = '上传中…';
    try {
      var r = await fetch('/wallpaper/upload', { method: 'POST', body: fd });
      var j = await r.json();
      if (j.ok) { st.className = 'ok'; st.textContent = '上传成功，可在壁纸列表查看'; }
      else { st.className = 'err'; st.textContent = '上传失败：' + (j.error || '未知'); }
    } catch (e) { st.className = 'err'; st.textContent = '上传失败：' + e.message; }
  });
</script></body></html>`

function sanitizeFileName(name) {
  return String(name || 'wallpaper.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
}

function makeWallpaperHttpHandler(wallpapersDir) {
  return function handleWallpaperHttp(req, res, url) {
    if (url.pathname === '/wallpaper') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(UPLOAD_PAGE)
      return true
    }
    if (url.pathname === '/wallpaper/upload' && req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks)
          const contentType = req.headers['content-type'] || ''
          const boundary = String(contentType).match(/boundary=(.+)$/)?.[1]
          if (!boundary) throw new Error('请求格式错误')
          const delimiter = Buffer.from('--' + boundary)
          let start = buf.indexOf(delimiter)
          if (start === -1) throw new Error('请求格式错误')
          start += delimiter.length
          let headerEnd = buf.indexOf('\r\n\r\n', start)
          if (headerEnd === -1) throw new Error('请求格式错误')
          const headerStr = buf.subarray(start, headerEnd).toString('utf8')
          const filenameMatch = headerStr.match(/filename="([^"]*)"/)
          let dataStart = headerEnd + 4
          let dataEnd = buf.indexOf('\r\n--' + boundary, dataStart)
          if (dataEnd === -1) dataEnd = buf.length
          const image = buf.subarray(dataStart, dataEnd)
          if (!image || image.length < 100) throw new Error('未收到有效图片')
          mkdirSync(wallpapersDir, { recursive: true })
          const name = Date.now() + '-' + sanitizeFileName(filenameMatch?.[1] || 'wallpaper.jpg')
          writeFileSync(join(wallpapersDir, name), image)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, name }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: err?.message || '上传失败' }))
        }
      })
      return true
    }
    if (url.pathname.startsWith('/wallpapers/')) {
      const name = url.pathname.split('/').pop() || ''
      const file = join(wallpapersDir, name)
      if (!existsSync(file)) {
        res.writeHead(404)
        res.end('Not Found')
        return true
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      createReadStream(file).pipe(res)
      return true
    }
    return false
  }
}

/**
 * 在 express app 上安装 TV 扩展：
 *  - 25567 远程遥控器（WS 命令广播 → SPA 控制器）
 *  - 25567 壁纸扫码上传页（手机浏览器直接上传）
 *  - /api/tv/remote-status、/api/tv/wallpapers、/api/tv/wallpapers/:name
 *  - /api/tv/logs（提供 serverLogs 环形缓冲时）
 */
export function installTvExtensions({
  app,
  wallpapersDir,
  serverName = 'WaveForge TV',
  serverLogs = null,
  remotePort = 25567,
  distDir = null,
}) {
  const handleWallpaperHttp = makeWallpaperHttpHandler(wallpapersDir)

  // TV 远程遥控器（复用 PC 端同一套 remote-server：手机控制页 + WS 命令）
  // 命令链路：手机 → remote-server(:25567) → broadcast → SPA 控制器(WS 客户端)
  // → DOM 事件 waveforge:remote-control → App 的 desktopControlHandlerRef 执行。
  const tvRemoteServer = createRemoteServer({
    getComputerName: () => serverName,
    getSettings: () => ({ theme: 'dark' }),
    getState: () => ({}), // 播放状态由 SPA 侧自行维护，v1 不推送到手机页
    sendControl: () => {}, // 命令经 broadcast 直达 SPA 控制器
    sendCursor: () => {}, // 光标命令同样经 broadcast 直达 SPA（remoteBridge → RemoteCursor）
    onClientsChange: () => {},
    onHttpRequest: handleWallpaperHttp, // 25567 上同时承载壁纸扫码上传
  })
  tvRemoteServer.start(remotePort).catch((err) => {
    console.error('[WaveForge TV] 遥控器服务启动失败:', err?.message || err)
  })

  // SPA 读取遥控状态（token/端口/IP 列表），用于展示二维码与连接地址。
  // local-server.mjs 只绑定 127.0.0.1，该接口仅本机可访问，token 不外泄到局域网。
  app.get('/api/tv/remote-status', (req, res) => {
    res.json(tvRemoteServer.status())
  })

  // SPA 读取已上传壁纸列表（手机上传 → 本地存储 → 这里列出，SPA 导入 IndexedDB）
  app.get('/api/tv/wallpapers', (req, res) => {
    try {
      if (!existsSync(wallpapersDir)) {
        res.json({ wallpapers: [] })
        return
      }
      const wallpapers = readdirSync(wallpapersDir)
        .filter((name) => /\.(jpe?g|png|webp|gif)$/i.test(name))
        .map((name) => ({
          name,
          url: '/api/tv/wallpapers/' + encodeURIComponent(name),
          uploadTime: statSync(join(wallpapersDir, name)).mtimeMs,
        }))
        .sort((a, b) => a.uploadTime - b.uploadTime)
      res.json({ wallpapers })
    } catch (err) {
      res.status(500).json({ wallpapers: [], error: err?.message })
    }
  })

  // SPA 读取已上传壁纸图片内容（导入 IndexedDB 用）
  app.get('/api/tv/wallpapers/:name', (req, res) => {
    const name = req.params.name || ''
    const file = join(wallpapersDir, name)
    if (!existsSync(file) || !/\.(jpe?g|png|webp|gif)$/i.test(name)) {
      res.status(404).end('Not Found')
      return
    }
    res.type('image/jpeg')
    createReadStream(file).pipe(res)
  })

  // ── 开发者模式调试服务开关（受开发者模式开关约束；调试阶段默认开，前端可关） ──
  const tvCrashFile = join(dirname(wallpapersDir), 'tv-crash.log')
  const tvDebugStateFile = join(dirname(wallpapersDir), 'tv-debug-state.json')
  const readDebugState = () => {
    try {
      const raw = JSON.parse(readFileSync(tvDebugStateFile, 'utf8'))
      if (typeof raw?.enabled === 'boolean') return raw.enabled
    } catch { /* ignore */ }
    // 无记录：调试阶段默认开（正式发布改 false）
    return true
  }
  app.post('/api/tv/debug-mode', (req, res) => {
    const enabled = req.body?.enabled === true
    setDebugServerEnabled(enabled, { serverLogs, crashFile: tvCrashFile, distDir })
    try {
      writeFileSync(tvDebugStateFile, JSON.stringify({ enabled }))
    } catch { /* ignore */ }
    res.json({ ok: true, enabled, port: DEBUG_PORT })
  })
  // 后端启动时按持久化状态启停（默认开；用户关掉后重启保持关闭，受开关约束）
  setDebugServerEnabled(readDebugState(), { serverLogs, crashFile: tvCrashFile, distDir })
  // 前端日志/错误上报（页面 console 批量日志 + window.onerror/unhandledrejection）
  app.post('/api/tv/debug-report', (req, res) => {
    const { logs } = req.body || {}
    if (Array.isArray(logs)) {
      // 前端 console 日志批量上报 → 追加到后端日志（调试台可见）
      if (serverLogs) {
        for (const l of logs.slice(-100)) {
          serverLogs.push({
            time: l?.time || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            level: l?.level || 'log',
            text: `[前端] ${l?.text || ''}`,
          })
        }
      }
      res.json({ ok: true })
      return
    }
    const { source, message, stack, url } = req.body || {}
    const text = `[前端${source || 'error'}] ${message || ''} @ ${url || ''}${stack ? '\n' + stack : ''}`
    if (serverLogs) {
      serverLogs.push({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'error', text })
    }
    try {
      appendFileSync(tvCrashFile, `[${new Date().toISOString()}] ${text}\n`)
    } catch { /* ignore */ }
    res.json({ ok: true })
  })

  // 后端日志环形缓冲（TV 调试面板轮询展示，本机接口）
  if (serverLogs) {
    app.get('/api/tv/logs', (req, res) => {
      res.json({ lines: serverLogs.slice(-100), total: serverLogs.length })
    })
  }

  // ── TV 设备识别码 / 隐藏功能兑换（复用桌面端 RSA 公钥签名校验） ──
  // 识别码 = Android ANDROID_ID（前端从 WaveForgeNative.getDeviceId() 取，随请求带上；
  // 浏览器 ?tv=1 调试时前端用本地模拟 ID）。
  // 兑换码由开发者用 license-private-key.pem 生成（payload.deviceHash = sha256(识别码)），
  // 本端点用 license-public-key.pem 验证后把已兑换码存入 tv-license.json（应用更新不清空）。
  const tvLicenseFile = join(dirname(wallpapersDir), 'tv-license.json')
  const readTvLicense = () => {
    try {
      return JSON.parse(readFileSync(tvLicenseFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const writeTvLicense = (partial) => {
    const next = { ...readTvLicense(), ...partial }
    mkdirSync(dirname(tvLicenseFile), { recursive: true })
    writeFileSync(tvLicenseFile, JSON.stringify(next, null, 2))
  }
  const collectTvGrants = (deviceId) => {
    const codes = Array.isArray(readTvLicense().redeemedCodes) ? readTvLicense().redeemedCodes : []
    const grants = []
    for (const code of codes) {
      try {
        grants.push(verifyCode(code, deviceId))
      } catch {
        // 过期/失效码静默跳过
      }
    }
    return grants
  }
  app.get('/api/tv/license/status', (req, res) => {
    const deviceId = String(req.query.deviceId || '').trim()
    if (!deviceId) {
      res.json({ ok: false, error: '缺少设备识别码' })
      return
    }
    res.json({ ok: true, deviceId, grants: collectTvGrants(deviceId) })
  })
  app.post('/api/tv/license/redeem', (req, res) => {
    const deviceId = String(req.body?.deviceId || '').trim()
    const code = String(req.body?.code || '').trim()
    if (!deviceId) {
      res.json({ ok: false, error: '缺少设备识别码' })
      return
    }
    try {
      const grant = verifyCode(code, deviceId)
      const stored = readTvLicense()
      const codes = Array.isArray(stored.redeemedCodes) ? stored.redeemedCodes : []
      if (!codes.includes(code)) codes.push(code)
      writeTvLicense({ redeemedCodes: codes.slice(-50) })
      res.json({
        ok: true,
        message: `已解锁：${grant.label}`,
        grant,
        grants: collectTvGrants(deviceId),
      })
    } catch (err) {
      res.json({ ok: false, error: err?.message || '兑换失败' })
    }
  })

  return tvRemoteServer
}

export { getLanIPv4Addresses, setDebugServerEnabled }

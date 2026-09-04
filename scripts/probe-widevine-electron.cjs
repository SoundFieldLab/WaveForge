/**
 * Widevine 注入探针：验证 Electron 环境能否通过 --widevine-cdm-* 开关
 * 注册 Widevine CDM（Apple Music 原生音源的 EME 前置条件）。
 *
 * 用法：
 *   npx electron scripts/probe-widevine-electron.cjs          # 带注入（与 main.cjs 同逻辑）
 *   npx electron scripts/probe-widevine-electron.cjs --no-cdm # 不带注入（对照组）
 *
 * 输出：Electron/Chromium 版本、开关状态、requestMediaKeySystemAccess 结果。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const withCdm = !process.argv.includes('--no-cdm')

function findWidevineCdm() {
  const candidates = []
  const roots = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env.LOCALAPPDATA]
  for (const base of roots) {
    if (!base) continue
    for (const appDir of ['Microsoft/Edge/Application', 'Google/Chrome/Application']) {
      const versionsDir = path.join(base, appDir)
      let entries = []
      try { entries = fs.readdirSync(versionsDir) } catch { continue }
      for (const version of entries) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue
        candidates.push({
          version,
          root: path.join(versionsDir, version, 'WidevineCdm'),
          manifestPath: path.join(versionsDir, version, 'WidevineCdm', 'manifest.json'),
          dllDir: path.join(versionsDir, version, 'WidevineCdm', '_platform_specific', 'win_x64'),
        })
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  for (const c of candidates) {
    try {
      if (!fs.existsSync(path.join(c.dllDir, 'widevinecdm.dll')) || !fs.existsSync(c.manifestPath)) continue
      const manifest = JSON.parse(fs.readFileSync(c.manifestPath, 'utf8'))
      const v = manifest && typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : ''
      if (!v) continue
      return { path: c.root, version: v }
    } catch { /* 继续 */ }
  }
  return null
}

if (withCdm) {
  const wv = findWidevineCdm()
  if (wv) {
    app.commandLine.appendSwitch('widevine-cdm-path', wv.path)
    app.commandLine.appendSwitch('widevine-cdm-version', wv.version)
    console.log(`[probe] 注入: version=${wv.version} path=${wv.path}`)
  } else {
    console.log('[probe] 本机未找到 Widevine CDM')
  }
} else {
  console.log('[probe] 对照组：不注入 CDM')
}

// ── 离线播种测试模式 ──────────────────────────────────────────────────
// electron.exe probe --seed-from <系统CDM根目录> --user-data <全新userData>
// 意义：把系统 Chrome/Edge 的 CDM 复制成 ECS 期望的 <userData>/WidevineCdm/<v>/…
// 布局，并禁用组件更新器（任何情况都不联网）。若 EME 依然 OK，即证明
// 「完全离线」方案可行（打包机/用户机均可照此预置）。
const probeArgs = process.argv.slice(2)
const seedFromArg = (() => { const i = probeArgs.indexOf('--seed-from'); return i >= 0 ? probeArgs[i + 1] : null })()
const userDataArg = (() => { const i = probeArgs.indexOf('--user-data'); return i >= 0 ? probeArgs[i + 1] : null })()
if (userDataArg) {
  try { app.setPath('userData', path.resolve(userDataArg)) } catch { /* 忽略 */ }
}
if (probeArgs.includes('--disable-cus')) {
  app.commandLine.appendSwitch('disable-component-update')
  console.log('[probe] 已禁用组件更新器（CUS off）')
}
if (seedFromArg) {
  // 注：是否禁用组件更新由 --disable-cus 独立控制；本模式只负责播种文件+注册
  try {
    const root = path.resolve(seedFromArg)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    const version = String(manifest.version || '')
    if (!version) throw new Error('seed 源 manifest 无版本')
    const userDataDir = userDataArg ? path.resolve(userDataArg) : app.getPath('userData')
    const vdir = path.join(userDataDir, 'WidevineCdm', version)
    fs.mkdirSync(path.join(vdir, '_platform_specific', 'win_x64'), { recursive: true })
    for (const name of ['manifest.json', 'LICENSE']) {
      const src = path.join(root, name)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(vdir, name))
    }
    const licTxt = path.join(root, 'LICENSE.txt')
    if (fs.existsSync(licTxt) && !fs.existsSync(path.join(vdir, 'LICENSE'))) {
      fs.copyFileSync(licTxt, path.join(vdir, 'LICENSE'))
    }
    if (fs.existsSync(path.join(root, '_metadata', 'verified_contents.json'))) {
      fs.mkdirSync(path.join(vdir, '_metadata'), { recursive: true })
      fs.copyFileSync(path.join(root, '_metadata', 'verified_contents.json'), path.join(vdir, '_metadata', 'verified_contents.json'))
    }
    const spSrc = path.join(root, '_platform_specific', 'win_x64')
    const dll = path.join(spSrc, 'widevinecdm.dll')
    if (fs.existsSync(dll)) fs.copyFileSync(dll, path.join(vdir, '_platform_specific', 'win_x64', 'widevinecdm.dll'))
    const sig = path.join(spSrc, 'widevinecdm.dll.sig')
    if (fs.existsSync(sig)) fs.copyFileSync(sig, path.join(vdir, '_platform_specific', 'win_x64', 'widevinecdm.dll.sig'))
    // CUS 组件注册写入 Local State（updateclientdata.apps[appId].pv = 版本）——
    // 这是 ECS 判定「组件已安装」的依据
    const widevineAppId = 'oimompecagnajdejgnnjijobebaeigek'
    const localStatePath = path.join(userDataDir, 'Local State')
    let localState = {}
    try { localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) } catch { localState = {} }
    if (!localState.updateclientdata) localState.updateclientdata = {}
    if (!localState.updateclientdata.apps) localState.updateclientdata.apps = {}
    localState.updateclientdata.apps[widevineAppId] = {
      cohort: '1:3cjr:',
      cohortname: 'Auto',
      fp: '',
      installdate: 7178,
      max_pv: '0.0.0.0',
      pf: '49b89fa4-5266-481b-af73-868305d174b0',
      pv: version,
    }
    fs.writeFileSync(localStatePath, JSON.stringify(localState), 'utf8')
    console.log(`[probe] 已离线播种 CDM -> ${vdir} (version=${version}, 已写 Local State 注册)`)
  } catch (error) {
    console.warn('[probe] 离线播种失败:', error?.message || error)
  }
}

app.whenReady().then(async () => {
  console.log('[probe] electron=', process.versions.electron, 'chrome=', process.versions.chrome)
  console.log('[probe] hasSwitch(widevine-cdm-path)=', app.commandLine.hasSwitch('widevine-cdm-path'))
  let componentsStatus = 'n/a（标准 Electron）'
  try {
    // castlabs ECS：就绪组件（首次会安装 Widevine CDM，需联网）
    const { components } = require('electron')
    if (components && typeof components.whenReady === 'function') {
      await components.whenReady()
      componentsStatus = components.status ? JSON.stringify(components.status()) : 'ready'
    }
  } catch (error) {
    componentsStatus = 'FAIL: ' + (error?.message || error)
  }
  console.log('[probe] components:', componentsStatus)
  // EME API 只在安全上下文暴露（https / 回环地址）。约等于真实应用的
  // http://127.0.0.1:3000，用回环 HTTP 页面测试，避免 about:blank 假阴性。
  const http = require('http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><html><body>probe</body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true },
  })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  const result = await win.webContents.executeJavaScript(`(async () => {
    const out = { isSecureContext: window.isSecureContext, hasEME: typeof navigator.requestMediaKeySystemAccess === 'function' };
    if (!out.hasEME) { out.eme = 'NO-EME-API'; return JSON.stringify(out); }
    try {
      const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc', 'keyids'],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
        distinctiveIdentifier: 'optional',
        persistentState: 'optional',
      }]);
      out.eme = 'OK: ' + access.keySystem;
    } catch (e) {
      out.eme = 'FAIL: ' + e.message;
    }
    try {
      const c = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'] }]);
      out.emeMin = 'OK: ' + c.keySystem;
    } catch (e2) { out.emeMin = 'FAIL: ' + e2.message; }
    return JSON.stringify(out);
  })()`)
  console.log('[probe] 渲染进程检测结果:', result)
  server.close()
  app.exit(0)
})
/* 前后端桥接：真实宿主走 WebView2 postMessage；浏览器里直接打开时启用模拟宿主。 */
(function () {
  'use strict'

  var seq = 0
  var pending = {}
  var listeners = {}

  var raw = window.chrome && window.chrome.webview

  function invoke(method, args) {
    if (!raw) return Promise.reject(new Error('no host'))
    var id = ++seq
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject }
      raw.postMessage(JSON.stringify({ type: 'invoke', id: id, method: method, args: args || {} }))
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('invoke timeout: ' + method)) }
      }, 120000)
    })
  }

  if (raw) {
    raw.addEventListener('message', function (e) {
      var msg = e.data
      // PostWebMessageAsJson 到达时已是对象；PostWebMessageAsString 才是字符串
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg) } catch (err) { return }
      }
      if (!msg || !msg.type) return
      if (msg.type === 'result' && pending[msg.id]) {
        var p = pending[msg.id]
        delete pending[msg.id]
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(msg.error || 'host error'))
      } else if (msg.type === 'event') {
        var cbs = listeners[msg.name] || []
        for (var i = 0; i < cbs.length; i++) cbs[i](msg.data)
      }
    })
  }

  var realHost = {
    isPreview: false,
    bootstrap: function () { return invoke('bootstrap', {}) },
    pickFolder: function (current) { return invoke('pickFolder', { current: current }) },
    getDriveSpace: function (path) { return invoke('getDriveSpace', { path: path }) },
    probeWritable: function (dir) { return invoke('probeWritable', { dir: dir }) },
    startInstall: function (opts) { return invoke('startInstall', opts) },
    cancelInstall: function () { return invoke('cancelInstall', {}) },
    finish: function (opts) { return invoke('finish', opts || {}) },
    openFolder: function (dir) { return invoke('openFolder', { dir: dir }) },
    listDir: function (path) { return invoke('listDir', { path: path }) },
    createDir: function (path, name) { return invoke('createDir', { path: path, name: name }) },
    scanUninstall: function () { return invoke('scanUninstall', {}) },
    runUninstall: function (keep) { return invoke('runUninstall', { keep: keep || [] }) },
    killApp: function () { return invoke('killApp', {}) },
    debugLog: function (msg) { raw.postMessage(JSON.stringify({ type: 'invoke', method: 'log', args: { msg: String(msg) } })) },
    minimize: function () { raw.postMessage(JSON.stringify({ type: 'invoke', method: 'minimize', args: {} })) },
    close: function () { raw.postMessage(JSON.stringify({ type: 'invoke', method: 'close', args: {} })) },
    onUpdate: function (cb) { (listeners['update'] = listeners['update'] || []).push(cb) },
  }

  /* ------- 浏览器预览宿主（模拟全部 OS 交互，进度用估算体积模拟） ------- */
  function previewHost() {
    var fakeTimer = null
    var drives = [
      { root: 'C:', free: 48 * 1024, total: 476 * 1024 },
      { root: 'D:', free: 381.2 * 1024, total: 1024 * 1024 },
      { root: 'E:', free: 96 * 1024, total: 512 * 1024 },
    ]
    return {
      isPreview: true,
      bootstrap: function () {
        return Promise.resolve({
          mode: 'preview',
          productName: 'WaveForge 澜音工坊',
          version: 'preview',
          appExe: 'WaveForge.exe',
          estMb: 1240,
          dirCurrent: 'D:\\WaveForge',
          dirAll: 'C:\\Program Files\\WaveForge 澜音工坊',
          scope: 'current',
          drives: drives,
        })
      },
      pickFolder: function (current) {
        var v = window.prompt('模拟浏览文件夹，输入安装目录：', current || 'D:\\')
        return Promise.resolve(v ? v.replace(/[\\/]+$/, '') : null)
      },
      getDriveSpace: function (path) {
        var root = (path.match(/^[a-zA-Z]:/) || ['C:'])[0].toUpperCase()
        for (var i = 0; i < drives.length; i++) if (drives[i].root === root) return Promise.resolve({ free: drives[i].free, total: drives[i].total })
        return Promise.resolve(null)
      },
      probeWritable: function () { return Promise.resolve(true) },
      startInstall: function (opts) {
        var t0 = Date.now()
        var est = 1240
        fakeTimer = setInterval(function () {
          var sec = (Date.now() - t0) / 1000
          var frac = Math.min(1, sec / 12)
          var eased = frac < 0.9 ? frac * 1.04 : 0.936 + Math.sin((frac - 0.9) * 31) * 0.06
          var mb = Math.max(0, Math.min(est, Math.round(est * eased)))
          window.__emitUpdate({
            phase: frac >= 1 ? 'done' : 'extract',
            percent: Math.min(100, Math.round(eased * 100)),
            copiedMb: mb,
            totalMb: est,
            speedMbps: (mb / Math.max(sec, 0.001)).toFixed(0),
          })
          if (frac >= 1) clearInterval(fakeTimer)
        }, 180)
        return Promise.resolve(true)
      },
      cancelInstall: function () { if (fakeTimer) clearInterval(fakeTimer); return Promise.resolve(true) },
      finish: function () { window.alert('（预览模式）应用启动动作已模拟'); return Promise.resolve() },
      openFolder: function () { window.alert('（预览模式）打开所在文件夹'); return Promise.resolve() },
      killApp: function () { return Promise.resolve(true) },
      scanUninstall: function () {
        return Promise.resolve({
          installDir: 'D:\\WaveForge',
          items: [
            { key: 'dir:install', label: '安装目录（程序本体）', keepable: false, exists: true, size: '1.2 GB' },
            { key: 'dir:cache', label: '音频分析缓存（beat/loudness，可重建）', keepable: false, exists: true, size: '151 MB' },
            { key: 'dir:updater', label: '旧版更新器下载缓存', keepable: false, exists: true, size: '271 MB' },
            { key: 'dir:startmenu', label: '开始菜单快捷方式', keepable: false, exists: true, size: '' },
            { key: 'ud:cache', label: '网页与播放器缓存（Cache / GPUCache / IndexedDB 等）', keepable: false, exists: true, size: '' },
            { key: 'ud:logs', label: '运行日志', keepable: false, exists: true, size: '' },
            { key: 'ud:settings', label: '个性化配置', detail: '偏好设置与功能开关', keepable: true, exists: true, size: '', baseDir: 'C:\Users\YoshinoRinne\AppData\Roaming\WaveForge 澜音工坊' },
            { key: 'ud:creds', label: '登录凭据', detail: '各平台登录状态', keepable: true, exists: true, size: '' },
            { key: 'reg:waveforge', label: '设备识别码', detail: '识别码绑定本机硬件，删除或保留重装后不变', keepable: true, exists: true, size: '' },
            { key: 'lnk:desktop', label: '桌面快捷方式', keepable: false, exists: true, size: '' },
          ],
        })
      },
      runUninstall: function (keep) {
        var keys = ['dir:updater', 'ud:logs', 'dir:startmenu', 'ud:cache', 'lnk:desktop', 'dir:cache', 'dir:install']
        var logs = keys.map(function (k) { return { key: k, ok: true } })
        return new Promise(function (resolve) {
          var i = 0
          var t = setInterval(function () {
            i += 1
            if (i >= logs.length) { clearInterval(t); resolve({ logs: logs }) }
          }, 220)
        })
      },
      listDir: function (path) {
        var tree = {
          'C:': ['Program Files', 'Program Files (x86)', 'Users', 'Windows'],
          'C:\\Program Files': ['Common Files', 'Internet Explorer'],
          'D:': ['Adobe', 'BaiduNetdisk', 'bandizip', 'CloudMusic', 'Documents', 'EPIC', 'WaveForge'],
          'D:\\Adobe': ['Adobe Photoshop 2024'],
          'E:': ['Games', 'Media', 'Backup'],
        }
        var key = (path || '').replace(/[\\/]+$/, '')
        var dirs = (key === '' ? ['C:', 'D:', 'E:'] : tree[key]) || []
        return Promise.resolve({ dirs: dirs, root: key === '' })
      },
      createDir: function () { return Promise.resolve(true) },
      debugLog: function (msg) { console.log('[wf]', msg) },
      minimize: function () { window.alert('（预览模式）最小化') },
      close: function () { window.alert('（预览模式）关闭窗口') },
      onUpdate: function (cb) { window.__emitUpdate = cb },
    }
  }

  window.WaveInstaller = raw ? realHost : previewHost()
})()

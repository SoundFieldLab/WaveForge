// 任务栏迷你播控修复验证壳：模拟 main.cjs 的新光标轮询逻辑，
// 用 PowerShell 移动真实光标并真实点击，验证：
// 1) 悬停 → 交互态稳定切换（不再振荡）
// 2) 点击 → 弹出面板展开
// 3) 移出 → 交互态释放 + 页面收到 hover-leave
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

function ps(cmd) {
  try { execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' }) } catch (e) { return 'ERR ' + e.message.slice(0, 150) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function log(...a) { console.log('[repro]', ...a) }

function getTaskbarWidgetPosition() {
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds
  const workArea = display.workArea
  const width = 340
  const taskbarBottom = Math.round((bounds.y + bounds.height) - (workArea.y + workArea.height))
  if (taskbarBottom > 0) {
    return { x: Math.round(bounds.x + bounds.width - width - 160), y: Math.round(bounds.y + bounds.height - taskbarBottom), width, height: taskbarBottom }
  }
  return { x: Math.round(bounds.x + (bounds.width - width) / 2), y: Math.round(bounds.y + bounds.height - 40), width, height: 40 }
}

const TASKBAR_POPUP_H = 218
let win = null
let interactive = false
let expanded = false
let hoverEvents = []

app.whenReady().then(async () => {
  const pos = getTaskbarWidgetPosition()
  log('pos:', JSON.stringify(pos))
  win = new BrowserWindow({
    ...pos,
    type: 'toolbar', frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/taskbar-widget-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}

  // ---- 新主进程逻辑：光标轮询 ----
  const poll = () => {
    if (!win || win.isDestroyed()) return
    const inside = (() => {
      if (!win.isVisible()) return false
      const pt = screen.getCursorScreenPoint()
      const b = win.getBounds()
      return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height
    })()
    if (inside !== interactive) {
      interactive = inside
      try { win.setIgnoreMouseEvents(!inside, { forward: true }) } catch {}
      win.webContents.send('taskbar-widget:hover', inside === true)
      log('poll: interactive ->', interactive)
    }
  }
  const pollTimer = setInterval(poll, 120)

  ipcMain.on('taskbar-widget:set-expanded', (_e, on) => {
    expanded = on === true
    log('ipc set-expanded ->', expanded)
    try {
      const p = getTaskbarWidgetPosition()
      if (expanded) win.setBounds({ x: p.x, y: p.y - TASKBAR_POPUP_H, width: p.width, height: p.height + TASKBAR_POPUP_H })
      else win.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height })
    } catch (e) { log('setBounds err', e.message) }
  })
  ipcMain.on('taskbar-widget:action', (_e, a, payload) => { log('ipc action ->', a, payload !== undefined ? JSON.stringify(payload) : '') })
  ipcMain.handle('taskbar-widget:get-settings', () => ({ enabled: true, position: 'right', width: 340, mode: 'normal' }))

  win.webContents.on('console-message', (_e, level, message) => {
    if (message.includes('Security Warning') || message.includes('will not show') || message.includes('electronjs.org') || message.includes('Content-Security')) return
    console.log('[console:' + level + ']', message)
  })

  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()
  log('shown, bounds:', JSON.stringify(win.getBounds()))
  await win.webContents.executeJavaScript(`
    (() => {
      for (const ev of ['mousedown', 'mouseup', 'click']) {
        document.addEventListener(ev, (e) => console.log('[page-click] ' + ev + ' at ' + e.clientX + ',' + e.clientY))
      }
      window.addEventListener('blur', () => console.log('[page] blur'))
      window.addEventListener('focus', () => console.log('[page] focus'))
      return 'click probes installed'
    })()
  `)

  // 推送播放状态
  win.webContents.send('taskbar-widget:state', {
    title: '测试歌曲', artist: '歌手', cover: '', playing: true, cur: 10, dur: 240,
    muted: false, accent: '#FB7299', theme: 'dark',
    lyric: { line: '第一句歌词', lineStart: 0, words: [{ word: '第一句', startTime: 0, duration: 800 }] },
  })
  await sleep(400)

  const cx = pos.x + Math.floor(pos.width / 2)
  const cy = pos.y + Math.floor(pos.height / 2)
  const farX = pos.x + pos.width + 300

  // 1) 移入窗口中心
  log('--- cursor INTO widget ---')
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${farX}, 5)`)
  await sleep(600)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`)
  await sleep(800)
  log('after hover: interactive =', interactive)

  // 2) 真实点击（期望弹出面板）
  log('--- real click ---')
  ps(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})
  `)
  ps(`
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }
"@
    [M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  `)
  await sleep(300)
  const cp = screen.getCursorScreenPoint()
  log('cursor at click time:', cp.x, cp.y, 'window bounds:', JSON.stringify(win.getBounds()))
  log('window capture area:', win.getContentBounds ? JSON.stringify(win.getContentBounds()) : '')
  await sleep(400)
  log('after click: interactive =', interactive, 'expanded =', expanded)
  const popup = await win.webContents.executeJavaScript(`({
    open: document.getElementById('popup').classList.contains('open'),
    opacity: getComputedStyle(document.getElementById('popup')).opacity,
  })`)
  log('popup in DOM:', JSON.stringify(popup))

  // 3) 移出窗口（期望 hover-leave 且交互态释放）
  log('--- cursor OUT ---')
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${farX}, 5)`)
  await sleep(700)
  log('after out: interactive =', interactive, 'expanded =', expanded)

  // 4) 窗口移到屏幕中央（非任务栏区域），再次真实点击，排除任务栏 z-order 干扰
  log('--- window moved to screen center, real click ---')
  const disp = screen.getPrimaryDisplay()
  const midX = disp.bounds.x + Math.floor(disp.bounds.width / 2)
  const midY = disp.bounds.y + Math.floor(disp.bounds.height / 2) - 100
  win.setBounds({ x: midX - 150, y: midY, width: 300, height: 48 })
  await sleep(400)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${midX}, ${midY + 24})`)
  await sleep(700)
  log('hover at center: interactive =', interactive)
  ps(`
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }
"@
    [M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  `)
  await sleep(600)
  log('after click at center: interactive =', interactive, 'expanded =', expanded)
  const popup2 = await win.webContents.executeJavaScript(`({
    open: document.getElementById('popup').classList.contains('open'),
  })`)
  log('popup in DOM (center):', JSON.stringify(popup2))

  clearInterval(pollTimer)
  app.exit(0)
}).catch((e) => { console.error('[repro] fatal:', e); app.exit(1) })

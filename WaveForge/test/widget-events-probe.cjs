// 探测：setIgnoreMouseEvents(true,{forward:true}) 下页面能收到哪些鼠标事件。
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')
const ps = (cmd) => { try { execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' }) } catch {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log('[probe]', ...a)

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workArea
  const pos = { x: wa.x + wa.width - 400, y: wa.y + wa.height - 50, width: 340, height: 40 }
  const win = new BrowserWindow({
    ...pos, type: 'toolbar', frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, show: false, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/taskbar-widget-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  ipcMain.handle('taskbar-widget:get-settings', () => ({ enabled: true, position: 'right', width: 340, mode: 'normal' }))
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()

  await win.webContents.executeJavaScript(`
    (() => {
      const evs = ['mousemove', 'mouseover', 'mouseenter', 'mouseleave', 'mouseout', 'click', 'mousedown', 'mouseup']
      for (const ev of evs) {
        document.addEventListener(ev, () => console.log('[page-event] ' + ev))
        window.addEventListener(ev, () => console.log('[win-event] ' + ev))
      }
      document.addEventListener('mouseenter', () => console.log('[page-event] document.mouseenter'))
      document.addEventListener('mouseleave', () => console.log('[page-event] document.mouseleave'))
      return 'event probes installed'
    })()
  `)
  win.webContents.on('console-message', (_e, level, message) => {
    if (message.includes('Security Warning') || message.includes('will not show') || message.includes('electronjs.org') || message.includes('Content-Security')) return
    console.log('[console:' + level + ']', message)
  })

  // 移入窗口中心
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${pos.x + pos.width + 200}, 5)`)
  await sleep(500)
  const cx = pos.x + Math.floor(pos.width / 2)
  const cy = pos.y + Math.floor(pos.height / 2)
  log('moving cursor to', cx, cy)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`)
  await sleep(1500)
  log('--- hover done, now click ---')
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
  await sleep(800)
  log('done')
  app.exit(0)
}).catch((e) => { console.error('[probe] fatal:', e); app.exit(1) })

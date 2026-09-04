// 真实鼠标链路测试：把物理鼠标光标移动到 widget 窗口上，
// 验证 OS 层 setIgnoreMouseEvents(true,{forward:true}) 是否真的把悬停事件送进页面。
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

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

let win = null
let interactive = false
function log(...args) { console.log('[repro]', ...args) }

function moveMouse(x, y) {
  try {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})"`)
    log(`moved real cursor to (${x}, ${y})`)
  } catch (e) { log('moveMouse failed:', e.message) }
}

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
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch (e) { log('setIgnoreMouseEvents err', e.message) }

  ipcMain.on('taskbar-widget:set-interactive', (_e, on) => {
    interactive = on === true
    log('ipc set-interactive ->', interactive)
    try { win.setIgnoreMouseEvents(!interactive, { forward: true }) } catch (e) { log('setIgnoreMouseEvents err', e.message) }
  })
  ipcMain.on('taskbar-widget:set-expanded', (_e, on) => log('ipc set-expanded ->', on === true))
  ipcMain.on('taskbar-widget:action', (_e, a) => log('ipc action ->', a))
  ipcMain.handle('taskbar-widget:get-settings', () => ({ enabled: true, position: 'right', width: 340, mode: 'normal' }))

  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()
  log('shown at', JSON.stringify(win.getBounds()))

  // 先移开鼠标，确保不在窗口内
  moveMouse(pos.x - 200, pos.y + pos.height + 80)
  await new Promise(r => setTimeout(r, 800))
  log('baseline interactive:', interactive)

  // 把真实鼠标移入窗口中心
  moveMouse(pos.x + Math.floor(pos.width / 2), pos.y + Math.floor(pos.height / 2))
  await new Promise(r => setTimeout(r, 1200))
  log('after hover interactive:', interactive, '| bounds:', JSON.stringify(win.getBounds()))

  // 真实点击：按下/松开（鼠标已在窗口内）
  try {
    execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')"`)
  } catch {}
  // 用 SendInput 真实左键点击
  const { execSync: exec2 } = require('child_process')
  try {
    execSync(`powershell -NoProfile -Command "
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class M { [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }';
      [M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero);
      [M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero);
    "`)
    log('real click sent at cursor position')
  } catch (e) { log('click failed:', e.message) }
  await new Promise(r => setTimeout(r, 1200))
  log('after click bounds:', JSON.stringify(win.getBounds()))
  const popup = await win.webContents.executeJavaScript(`({
    open: document.getElementById('popup').classList.contains('open'),
    opacity: getComputedStyle(document.getElementById('popup')).opacity,
  })`)
  log('popup:', JSON.stringify(popup))

  app.exit(0)
}).catch((e) => { console.error('[repro] fatal:', e); app.exit(1) })

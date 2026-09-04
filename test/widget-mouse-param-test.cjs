// 测试不同 BrowserWindow 参数组合下 setIgnoreMouseEvents(true,{forward:true}) 的悬停检测是否可靠。
// 用法：WAVEFORGE_COMBO=base|focusable|notransparent|notoolbar|plain|transparent-skip npx electron test/widget-mouse-param-test.cjs
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

function ps(cmd) {
  try { execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' }) } catch (e) { return 'ERR' }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function log(...a) { console.log('[param]', ...a) }

const COMBOS = {
  base: { type: 'toolbar', transparent: true, focusable: false },
  focusable: { type: 'toolbar', transparent: true },
  notransparent: { type: 'toolbar', focusable: false },
  notoolbar: { transparent: true, focusable: false },
  plain: {},
  transparentskip: { transparent: true, focusable: false, skipTaskbar: true },
}

app.whenReady().then(async () => {
  const comboName = process.env.WAVEFORGE_COMBO || 'base'
  const comboOpts = COMBOS[comboName] || {}
  const noPass = process.env.WAVEFORGE_NOPASS === '1'
  log('combo:', comboName, JSON.stringify(comboOpts), 'noPass:', noPass)
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const pos = { x: workArea.x + workArea.width - 400, y: workArea.y + workArea.height - 50, width: 340, height: 40 }
  const win = new BrowserWindow({
    ...pos,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, show: false, backgroundColor: '#00000000', hasShadow: false,
    ...comboOpts,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/taskbar-widget-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  let enterCount = 0
  let leaveCount = 0
  ipcMain.on('taskbar-widget:set-interactive', (_e, on) => {
    if (on === true) enterCount += 1
    else leaveCount += 1
    try { win.setIgnoreMouseEvents(!on, { forward: true }) } catch {}
  })
  ipcMain.handle('taskbar-widget:get-settings', () => ({ enabled: true, position: 'right', width: 340, mode: 'normal' }))
  if (noPass) {
    try { win.setIgnoreMouseEvents(false) } catch {}
    log('noPass: window is interactive from start')
  } else {
    try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  }
  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()

  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${pos.x + pos.width + 200}, 5)`)
  await sleep(500)
  const cx = pos.x + Math.floor(pos.width / 2)
  const cy = pos.y + Math.floor(pos.height / 2)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`)
  await sleep(300)
  const rb = (() => { try { return execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; \\$p = [System.Windows.Forms.Cursor]::Position; Write-Host (\\$p.X.ToString() + ',' + \\$p.Y.ToString())"`, { stdio: 'pipe' }).toString().trim() } catch (e) { return 'ERR ' + e.message } })()
  log('cursor readback:', rb)
  await sleep(1700)
  log(`RESULT: enter=${enterCount} leave=${leaveCount} => ${enterCount > 0 ? 'hover DETECTED' : 'hover MISSED'}`)
  app.exit(0)
}).catch((e) => { console.error('[param] fatal:', e); app.exit(1) })

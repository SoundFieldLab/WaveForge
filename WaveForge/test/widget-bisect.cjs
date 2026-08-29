// 窗口参数二分（单用例模式，确定性版）：不做悬停，窗口创建后立即 setIgnoreMouseEvents(false)，
// 光标先移到窗口内停留，再真实点击，检查页面是否收到 mousedown/click。对比 focusable 等参数。
const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

const CASE = process.env.CASE || 'prod'

function ps(cmd) {
  try { execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' }) } catch (e) { console.log('ps ERR', e.message.slice(0, 120)) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const CASES = {
  prod: { type: 'toolbar', frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false },
  noFocusableFalse: { type: 'toolbar', frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: true, hasShadow: false },
}

app.whenReady().then(async () => {
  const opts = CASES[CASE] || CASES.prod
  console.log('===== CASE:', CASE, '=====')
  const disp = screen.getPrimaryDisplay()
  const x = disp.bounds.x + Math.floor(disp.bounds.width / 2) - 150
  const y = disp.bounds.y + Math.floor(disp.bounds.height / 2) - 100
  const win = new BrowserWindow({ x, y, width: 300, height: 48, show: false, backgroundColor: '#00000000', ...opts })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 确定性版：不做悬停，直接开启交互
  win.setIgnoreMouseEvents(false)
  win.webContents.on('console-message', (_e, level, message) => {
    if (String(message).includes('[hit]')) console.log('  [page]', message)
  })
  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()
  await win.webContents.executeJavaScript(`
    document.addEventListener('mousedown', (e) => console.log('[hit] mousedown target=' + (e.target && e.target.tagName)))
    document.addEventListener('mouseup', (e) => console.log('[hit] mouseup target=' + (e.target && e.target.tagName)))
    document.addEventListener('click', (e) => {
      const r = document.getElementById('root')
      const pr = r.getBoundingClientRect()
      console.log('[hit] click target=' + (e.target && e.target.tagName) + '.' + (e.target && e.target.id) + ' client=(' + e.clientX + ',' + e.clientY + ') root={' + Math.round(pr.left) + ',' + Math.round(pr.top) + ',' + Math.round(pr.width) + 'x' + Math.round(pr.height) + '}')
    })
    'probes'
  `)
  await sleep(500)

  const cx = x + 150, cy = y + 24
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x + 600}, 5)`)
  await sleep(400)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`)
  await sleep(700)
  console.log('  cursor parked at', cx, cy)
  console.log('  win bounds:', JSON.stringify(win.getBounds()), 'contentBounds:', JSON.stringify(win.getContentBounds ? win.getContentBounds() : null))
  const cp = screen.getCursorScreenPoint()
  console.log('  real cursor now:', cp.x, cp.y)

  // 确保置顶
  win.moveTop()
  win.showInactive()
  await sleep(300)
  console.log('  after moveTop bounds:', JSON.stringify(win.getBounds()))
  console.log('  win.isVisible():', win.isVisible(), '| isFocused:', win.isFocused ? win.isFocused() : 'n/a')

  // Win32 视角：这个点谁在接收输入；同时查询本窗口原生句柄的 EX 样式
  try {
    const hwnd = win.getNativeWindowHandle()
    const hwndNum = hwnd ? hwnd.readInt32LE(0) : 0
    console.log('  native hwnd:', hwndNum)
    const r = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, 'winat.ps1')}" -PX ${cx} -PY ${cy} -HWND ${hwndNum}`, { encoding: 'utf8' }).trim()
    console.log('  Win32:', r.replace(/\s+/g, ' | '))
  } catch (e) { console.log('  winat ERR', e.message.slice(0, 200)) }

  ps(`
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class M { [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e); }
"@
    [M]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [M]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  `)
  await sleep(600)
  const got = await win.webContents.executeJavaScript(`document.getElementById('popup').classList.contains('open')`)
  console.log('  popup open after real click:', got)
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(5, 5)`)
  app.exit(0)
}).catch((e) => { console.error('fatal', e); app.exit(1) })

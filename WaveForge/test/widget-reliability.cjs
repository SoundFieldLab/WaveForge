// 可靠性对比：focusable:true vs false，反复真实点击统计成功率。
// 模拟生产交互流程：创建窗口 → setIgnoreMouseEvents(true,{forward}) → 光标移入(真实) →
// 页面 mouseenter → setIgnoreMouseEvents(false) → 真实点击 → 检查页面是否收到 click。
const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

const CFG = process.env.CFG || 'focusableTrue'
const TRIALS = Number(process.env.TRIALS || 4)

function ps(cmd) {
  try { execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' }) } catch (e) { return 'ERR' }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function optsFor(cfg) {
  const base = {
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: true, hasShadow: false,
  }
  if (cfg === 'focusableFalse') base.focusable = false
  if (cfg === 'prod') { base.type = 'toolbar'; base.focusable = false }
  return base
}

app.whenReady().then(async () => {
  const disp = screen.getPrimaryDisplay()
  const x = disp.bounds.x + Math.floor(disp.bounds.width / 2) - 150
  const y = disp.bounds.y + Math.floor(disp.bounds.height / 2) - 100
  console.log('===== CFG:', CFG, 'TRIALS:', TRIALS, '=====')
  const win = new BrowserWindow({ x, y, width: 300, height: 48, show: false, backgroundColor: '#00000000', ...optsFor(CFG) })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })

  let hovered = false
  win.webContents.on('console-message', (_e, level, message) => {
    if (String(message).includes('[hit]')) console.log('  [page]', message)
  })
  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  win.showInactive()
  await win.webContents.executeJavaScript(`
    document.addEventListener('mouseenter', () => { if (!window.__hoverLogged) { window.__hoverLogged = true; console.log('[hit] mouseenter') } })
    document.addEventListener('click', () => console.log('[hit] click'))
    'probes'
  `)
  await sleep(400)

  const cx = x + 150, cy = y + 24
  let hits = 0, hovers = 0
  for (let i = 0; i < TRIALS; i++) {
    // 移到远处，再移入窗口
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x + 600}, 5)`)
    await sleep(500)
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`)
    await sleep(600)

    // 悬停：窗口切到可交互
    win.setIgnoreMouseEvents(false)
    win.moveTop()
    await sleep(200)

    // 真实点击
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
    await sleep(400)
    const got = await win.webContents.executeJavaScript(`document.getElementById('popup').classList.contains('open')`)
    const ex = win.getBounds()
    const cp = screen.getCursorScreenPoint()
    console.log(`trial ${i + 1}: popup=${got} cursor=(${cp.x},${cp.y}) win=(${ex.x},${ex.y},${ex.width}x${ex.height})`)
    if (got) hits++
    hovers++
  }
  console.log('RESULT:', CFG, '->', hits + '/' + TRIALS, 'clicks landed')
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(5, 5)`)
  app.exit(0)
}).catch((e) => { console.error('fatal', e); app.exit(1) })

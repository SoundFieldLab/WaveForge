// 基准对照（v2）：普通窗口 + SendInput 真实点击 + 点击前核对原生窗口位置。
const { app, BrowserWindow, screen } = require('electron')
const { execSync } = require('child_process')

function ps(cmd) {
  try { return execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe', encoding: 'utf8' }).trim() } catch (e) { return 'ERR ' + e.message.slice(0, 120) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const disp = screen.getPrimaryDisplay()
  const x = disp.bounds.x + Math.floor(disp.bounds.width / 2) - 150
  const y = disp.bounds.y + Math.floor(disp.bounds.height / 2) - 100
  const win = new BrowserWindow({ x, y, width: 300, height: 200 })
  win.webContents.on('console-message', (_e, level, message) => {
    if (String(message).includes('[hit]')) console.log('  [page]', message)
  })
  await win.loadURL('data:text/html,<div id="box" style="width:100%;height:100%;background:#ccc" onclick="console.log(\'[hit] click body\')"></div><script>document.addEventListener(\'click\',()=>console.log(\'[hit] click doc\'))</script>')
  win.show()
  win.focus()
  await sleep(600)
  const cb = win.getContentBounds()
  const cxm = cb.x + Math.floor(cb.width / 2)
  const cym = cb.y + Math.floor(cb.height / 2)
  console.log('content bounds:', JSON.stringify(cb), 'click at', cxm, cym)

  const hwnd = win.getNativeWindowHandle().readInt32LE(0)
  console.log('native hwnd:', hwnd)

  // 移光标到目标点
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cxm}, ${cym})`)
  await sleep(600)
  const cur = ps(`Add-Type -AssemblyName System.Windows.Forms; "$([System.Windows.Forms.Cursor]::Position)"`)
  console.log('cursor now:', cur)

  // 用 SendInput 发送真实点击（比 mouse_event 更接近真实输入）
  const r = ps(`
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class SI {
      [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
      [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; }
      [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
      [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] pInputs, int cbSize);
      public static void Click() {
        INPUT[] ins = new INPUT[2];
        ins[0].type = 0; ins[0].u.mi.dwFlags = 0x0002; // LEFTDOWN
        ins[1].type = 0; ins[1].u.mi.dwFlags = 0x0004; // LEFTUP
        SendInput(2, ins, Marshal.SizeOf(typeof(INPUT)));
      }
    }
"@
    [SI]::Click()
    "sent"
  `)
  console.log('sendinput:', r)
  await sleep(600)
  console.log('done — check [hit] above')
  app.exit(0)
}).catch((e) => { console.error('fatal', e); app.exit(1) })

// 诊断：屏幕指定点上，Win32 视角下哪个窗口在接收输入。
// 由 widget-bisect.cjs 通过 env 传入点坐标。
const { app, screen } = require('electron')
const { execSync } = require('child_process')

const PX = Number(process.env.PX || 1280)
const PY = Number(process.env.PY || 464)

function ps(cmd) {
  try { return execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe', encoding: 'utf8' }).trim() } catch (e) { return 'ERR' }
}

app.whenReady().then(async () => {
  console.log('point:', PX, PY)
  console.log('primary display:', JSON.stringify(screen.getPrimaryDisplay().bounds), 'workArea:', JSON.stringify(screen.getPrimaryDisplay().workArea))
  const winAtPoint = ps(`
    Add-Type -TypeDefinition '
      using System;
      using System.Runtime.InteropServices;
      using System.Text;
      public class W {
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point p);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      }
    '
    Add-Type -AssemblyName System.Drawing
    $p = New-Object System.Drawing.Point(${PX}, ${PY})
    $h = [W]::WindowFromPoint($p)
    $sb1 = New-Object System.Text.StringBuilder 256
    $sb2 = New-Object System.Text.StringBuilder 256
    [W]::GetWindowText($h, $sb1, 256) | Out-Null
    [W]::GetClassName($h, $sb2, 256) | Out-Null
    $pid2 = 0
    [W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    $vis = [W]::IsWindowVisible($h)
    "hwnd=$h title='$($sb1.ToString())' class='$($sb2.ToString())' pid=$pid2 visible=$vis"
  `)
  console.log('WindowFromPoint:', winAtPoint)
  const underCursor = ps(`
    Add-Type -AssemblyName System.Windows.Forms
    "cursor=" + [System.Windows.Forms.Cursor]::Position
  `)
  console.log('cursor:', underCursor)
  app.exit(0)
}).catch((e) => { console.error('fatal', e); app.exit(1) })

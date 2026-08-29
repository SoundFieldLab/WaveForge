param([int]$PX, [int]$PY, [int]$HWND = 0)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(int x, int y);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr64(IntPtr h, int idx);
  [DllImport("user32.dll", EntryPoint="GetWindowLong")] public static extern int GetWindowLong32(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRgnBox(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
"@
$h = [W]::WindowFromPoint($PX, $PY)
$sb1 = New-Object System.Text.StringBuilder 512
$sb2 = New-Object System.Text.StringBuilder 512
[W]::GetWindowText($h, $sb1, 512) | Out-Null
[W]::GetClassName($h, $sb2, 512) | Out-Null
$pid2 = 0
[W]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
$vis = [W]::IsWindowVisible($h)
Write-Output "at($PX,$PY): hwnd=$h title='$($sb1.ToString())' class='$($sb2.ToString())' pid=$pid2 visible=$vis"

if ($HWND -ne 0) {
  $hi = [IntPtr]$HWND
  $sb3 = New-Object System.Text.StringBuilder 512
  $sb4 = New-Object System.Text.StringBuilder 512
  [W]::GetWindowText($hi, $sb3, 512) | Out-Null
  [W]::GetClassName($hi, $sb4, 512) | Out-Null
  $p3 = 0
  [W]::GetWindowThreadProcessId($hi, [ref]$p3) | Out-Null
  try { $ex = [W]::GetWindowLong64Ptr($hi, -20).ToInt64() } catch { $ex = [W]::GetWindowLong32($hi, -20) }
  try { $st = [W]::GetWindowLong64Ptr($hi, -16).ToInt64() } catch { $st = [W]::GetWindowLong32($hi, -16) }
  $flags = ""
  if (($ex -band 0x20) -ne 0) { $flags += " TRANSPARENT" }
  if (($ex -band 0x08000000) -ne 0) { $flags += " NOACTIVATE" }
  if (($ex -band 0x00080000) -ne 0) { $flags += " LAYERED" }
  if (($ex -band 0x00000080) -ne 0) { $flags += " TOOLWINDOW" }
  if (($ex -band 0x00000008) -ne 0) { $flags += " TOPMOST" }
  if (($st -band 0x40000000) -ne 0) { $flags += " WS_CHILD" }
  if (($st -band 0x80000000) -ne 0) { $flags += " WS_POPUP" }
  $parent = [W]::GetAncestor($hi, 1)  # GA_PARENT
  $owner = [W]::GetWindow($hi, 4)     # GW_OWNER
  $r = New-Object W+RECT
  [W]::GetWindowRect($hi, [ref]$r) | Out-Null
  $en = [W]::IsWindowEnabled($hi)
  $rgn = New-Object W+RECT
  $rgnOk = [W]::GetWindowRgnBox($hi, [ref]$rgn)
  Write-Output "widget(hwnd=$HWND): title='$($sb3.ToString())' class='$($sb4.ToString())' pid=$p3 rect=($($r.L),$($r.T))-($($r.R),$($r.B)) style=0x$('{0:X8}' -f $st) exstyle=0x$('{0:X8}' -f $ex)$flags visible=$([W]::IsWindowVisible($hi)) enabled=$en rgnBox=$rgnOk parent=$parent owner=$owner"
  if ($parent -ne 0) {
    $sb5 = New-Object System.Text.StringBuilder 512
    $sb6 = New-Object System.Text.StringBuilder 512
    [W]::GetWindowText([IntPtr]$parent, $sb5, 512) | Out-Null
    [W]::GetClassName([IntPtr]$parent, $sb6, 512) | Out-Null
    $pr = New-Object W+RECT
    [W]::GetWindowRect([IntPtr]$parent, [ref]$pr) | Out-Null
    $pp = 0
    [W]::GetWindowThreadProcessId([IntPtr]$parent, [ref]$pp) | Out-Null
    Write-Output "  parent(hwnd=$parent): title='$($sb5.ToString())' class='$($sb6.ToString())' pid=$pp rect=($($pr.L),$($pr.T))-($($pr.R),$($pr.B))"
  }
}
Write-Output "cursor=$([System.Windows.Forms.Cursor]::Position)"

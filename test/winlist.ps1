param([int]$TARGETPID = 0)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class L {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public struct RECT { public int L, T, R, B; }
}
"@
$out = @()
$cb = [L+EnumProc]{
  param($h, $l)
  $pid2 = 0
  [L]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($TARGETPID -eq 0 -or $pid2 -eq $TARGETPID) {
    $sb1 = New-Object System.Text.StringBuilder 256
    $sb2 = New-Object System.Text.StringBuilder 256
    [L]::GetWindowText($h, $sb1, 256) | Out-Null
    [L]::GetClassName($h, $sb2, 256) | Out-Null
    $r = New-Object L+RECT
    [L]::GetWindowRect($h, [ref]$r) | Out-Null
    $vis = [L]::IsWindowVisible($h)
    $parent = [L]::GetWindow($h, 4)  # GW_OWNER
    $script:out += "hwnd=$h pid=$pid2 vis=$vis rect=($($r.L),$($r.T))-($($r.R),$($r.B)) class='$($sb2.ToString())' title='$($sb1.ToString())' owner=$parent"
  }
  return $true
}
$script:out = @()
[L]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:out | ForEach-Object { Write-Output $_ }

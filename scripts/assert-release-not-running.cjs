const { spawnSync } = require('node:child_process')
const path = require('node:path')

if (process.platform !== 'win32') process.exit(0)
const releaseRoot = path.resolve('release', 'win-unpacked').toLowerCase()
const escapedReleaseRoot = releaseRoot.replace(/'/g, "''")
const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${escapedReleaseRoot}') } | Select-Object -ExpandProperty ProcessId`
let result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
// PowerShell 不可用（策略禁用/精简系统）时旧实现直接放行 → 可能半删正在使用的
// release/win-unpacked。降级 tasklist 按进程名比对（CLI 恒在；取不到完整路径，
// 但 WaveForge.exe 进程名足够特异，最坏情况只是让用户多关一个别的副本）。
if (result.error || (typeof result.status === 'number' && result.status < 0)) {
  const tl = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  const rows = String(tl.stdout || '').split('\n')
  const pids = []
  for (const row of rows) {
    const m = row.match(/^"([^"]+\.exe)","(\d+)"/i)
    if (!m) continue
    if (m[1].toLowerCase() === 'waveforge.exe') pids.push(m[2])
  }
  if (pids.length) {
    console.error(`[build] release/win-unpacked 可能正在运行（tasklist 检出 WaveForge.exe PID ${pids.join(', ')}；PowerShell 不可用已降级比对进程名），请先关闭再构建。`)
    process.exit(2)
  }
  console.warn('[build] PowerShell 不可用，已用 tasklist 降级检查（按进程名，未比对完整路径）')
  process.exit(0)
}
const pids = String(result.stdout || '').match(/\d+/g) || []
if (pids.length) {
  console.error(`[build] release/win-unpacked 正在运行（PID ${pids.join(', ')}），请先关闭再构建，避免 EXE/.sig 被部分删除。`)
  process.exit(2)
}

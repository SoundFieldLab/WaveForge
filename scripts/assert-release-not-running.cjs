const { spawnSync } = require('node:child_process')
const path = require('node:path')

if (process.platform !== 'win32') process.exit(0)
const releaseRoot = path.resolve('release', 'win-unpacked').toLowerCase()
const escapedReleaseRoot = releaseRoot.replace(/'/g, "''")
const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${escapedReleaseRoot}') } | Select-Object -ExpandProperty ProcessId`
const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
const pids = String(result.stdout || '').match(/\d+/g) || []
if (pids.length) {
  console.error(`[build] release/win-unpacked 正在运行（PID ${pids.join(', ')}），请先关闭再构建，避免 EXE/.sig 被部分删除。`)
  process.exit(2)
}

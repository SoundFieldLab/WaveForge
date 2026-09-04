'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')

const APP_ROOT = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Razer Chroma SDK', 'Apps')
const SDK_REGISTRY = 'HKLM\\SOFTWARE\\WOW6432Node\\Razer Chroma SDK\\Apps'
const STALE_APPS = Object.freeze(['WaveForge澜音工坊', 'WaveForgeProbe', 'WaveForgeMousepadProbe'])
const APP_MANAGER_LOG = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Razer Chroma SDK', 'logs', 'RzSDKServer.exe.log')
const REPAIR_PROTOCOL_VERSION = 1
const DEFAULT_REPAIR_TIMEOUT_MS = 120000

function exists(target) {
  try { return fs.existsSync(target) } catch { return false }
}

function readRecentUtf8Error(now = Date.now()) {
  try {
    const stats = fs.statSync(APP_MANAGER_LOG)
    const length = Math.min(stats.size, 512 * 1024)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(APP_MANAGER_LOG, 'r')
    fs.readSync(fd, buffer, 0, length, stats.size - length)
    fs.closeSync(fd)
    // Razer SDK logs are UTF-16LE despite the .log extension.
    const text = buffer.toString('utf16le')
    const matches = [...text.matchAll(/(\d{4}-\d{2}-\d{2}),(\d{2}:\d{2}:\d{2}):(\d{3})[^\r\n]*invalid UTF-8 byte[^\r\n]*/gi)]
    const latest = matches.at(-1)
    if (!latest) return null
    const timestamp = new Date(`${latest[1]}T${latest[2]}.${latest[3]}`).getTime()
    return Number.isFinite(timestamp) && now - timestamp <= 10 * 60 * 1000 ? latest[0] : null
  } catch {
    return null
  }
}

function queryRegistryApps(execFileImpl = execFile) {
  return new Promise((resolve) => {
    const script = `$root='Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Razer Chroma SDK\\Apps'; if(Test-Path $root){Get-ChildItem $root | ForEach-Object {$v=Get-ItemProperty $_.PSPath; [pscustomobject]@{Name=$_.PSChildName -replace '\\.exe$',''; Title=[string]$v.Title; Path=[string]$v.Path; Enable=[int]$v.Enable}} | ConvertTo-Json -Compress}`
    execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      if (error || !String(stdout || '').trim()) return resolve([])
      try {
        const value = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim())
        resolve(Array.isArray(value) ? value : [value])
      } catch {
        resolve([])
      }
    })
  })
}

async function inspectChromaAppList(options = {}) {
  const registryApps = await queryRegistryApps(options.execFileImpl)
  const staleFolders = STALE_APPS.filter(name => exists(path.join(options.appRoot || APP_ROOT, name)))
  const staleRegistry = STALE_APPS.filter(name => registryApps.some(value => String(value.Name).toLowerCase() === name.toLowerCase()))
  const nonAsciiApps = registryApps.filter(value => /[^\x20-\x7e]/.test(`${value.Name || ''}${value.Title || ''}${value.Path || ''}`))
  const utf8Error = (options.readRecentUtf8ErrorImpl || readRecentUtf8Error)()
  const waveForgeCorrupted = Boolean(utf8Error || staleFolders.length || staleRegistry.length)
  return {
    corrupted: waveForgeCorrupted,
    thirdPartyWarning: nonAsciiApps.length > 0,
    utf8Error,
    staleFolders,
    staleRegistry,
    nonAsciiApps,
    cleanAppRegistered: registryApps.some(value => String(value.Name).toLowerCase() === 'waveforge'),
    appRoot: options.appRoot || APP_ROOT,
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function createRepairScript(outputPath) {
  const stale = STALE_APPS.map(psQuote).join(', ')
  return `$ErrorActionPreference = 'Stop'\n` +
    `$appsRoot = ${psQuote(APP_ROOT)}\n` +
    `$registryRoot = ${psQuote(`Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Razer Chroma SDK\\Apps`)}\n` +
    `$targets = @(${stale})\n` +
    `$services = @('Razer Chroma SDK Server', 'Razer Chroma SDK Service')\n` +
    `$removed = @()\n$errorMessage = $null\n` +
    `try {\n` +
    `  foreach ($service in $services) { Stop-Service -Name $service -Force -ErrorAction SilentlyContinue }\n` +
    `  foreach ($name in $targets) {\n` +
    `    $folder = Join-Path $appsRoot $name\n` +
    `    $key = Join-Path $registryRoot ($name + '.exe')\n` +
    `    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force; $removed += $name }\n` +
    `    if (Test-Path $key) { Remove-Item $key -Recurse -Force }\n` +
    `  }\n` +
    `} catch { $errorMessage = $_.Exception.Message } finally {\n` +
    `  foreach ($service in @('Razer Chroma SDK Service', 'Razer Chroma SDK Server')) { Start-Service -Name $service -ErrorAction SilentlyContinue }\n` +
    `  @{ version = ${REPAIR_PROTOCOL_VERSION}; ok = ($null -eq $errorMessage); repairedAt = (Get-Date).ToString('o'); removed = $removed; error = $errorMessage } | ConvertTo-Json | Set-Content -Encoding UTF8 ${psQuote(outputPath)}\n` +
    `}\n`
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function createElevationCommand(scriptPath) {
  const elevatedPayload = `& ${psQuote(scriptPath)}\nexit $LASTEXITCODE`
  const elevatedArguments = `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(elevatedPayload)}`
  return `$ErrorActionPreference = 'Stop'\n` +
    `try {\n` +
    `  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -ArgumentList ${psQuote(elevatedArguments)} -PassThru -Wait\n` +
    `  Write-Output ('WF_CHROMA_EXIT:' + $process.ExitCode)\n` +
    `} catch {\n` +
    `  $nativeCode = $_.Exception.NativeErrorCode\n` +
    `  if ($null -eq $nativeCode -and $null -ne $_.Exception.InnerException) { $nativeCode = $_.Exception.InnerException.NativeErrorCode }\n` +
    `  $message = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))\n` +
    `  Write-Output ('WF_CHROMA_ERROR:' + $nativeCode + ':' + $message)\n` +
    `  exit 1\n` +
    `}\n`
}

function runPowerShell(command, options = {}) {
  const spawnImpl = options.spawnImpl || spawn
  const timeoutMs = options.timeoutMs || DEFAULT_REPAIR_TIMEOUT_MS
  return new Promise((resolve) => {
    let child
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(command)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ kind: 'spawn-error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-65536) })
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-65536) })
    child.once('error', error => finish({ kind: 'spawn-error', error: error instanceof Error ? error.message : String(error) }))
    child.once('close', code => finish({ kind: 'closed', code: typeof code === 'number' ? code : null }))
    timer = setTimeout(() => {
      try { child.kill() } catch { /* Process may already be gone. */ }
      finish({ kind: 'timeout', error: `管理员修复等待超过 ${Math.ceil(timeoutMs / 1000)} 秒` })
    }, timeoutMs)
  })
}

function readRepairReport(resultPath) {
  if (!exists(resultPath)) return { outcome: 'result-missing', error: '管理员进程已结束，但没有生成修复结果' }
  let report
  try {
    report = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { outcome: 'result-invalid', error: `无法读取修复结果：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!report || report.version !== REPAIR_PROTOCOL_VERSION || typeof report.ok !== 'boolean' || !Array.isArray(report.removed)) {
    return { outcome: 'result-invalid', error: '修复结果格式或版本无效' }
  }
  if (!report.ok) return { outcome: 'script-failed', error: report.error || '管理员修复脚本执行失败', report }
  return { outcome: 'succeeded', report }
}

async function launchChromaAppListRepair(userDataPath, options = {}) {
  if (process.platform !== 'win32' && !options.allowTestPlatform) {
    return { outcome: 'process-failed', error: 'Windows only' }
  }
  const directory = path.join(userDataPath || os.tmpdir(), 'chroma-repair')
  fs.mkdirSync(directory, { recursive: true })
  const scriptPath = path.join(directory, 'repair-chroma-app-list.ps1')
  const resultPath = path.join(directory, 'repair-result.json')
  try { fs.rmSync(resultPath, { force: true }) } catch { /* Ignore an absent previous result. */ }
  fs.writeFileSync(scriptPath, `\uFEFF${createRepairScript(resultPath)}`, 'utf8')
  const processResult = await runPowerShell(createElevationCommand(scriptPath), options)
  if (processResult.kind === 'spawn-error') return { outcome: 'process-failed', error: processResult.error }
  if (processResult.kind === 'timeout') return { outcome: 'timeout', error: processResult.error }
  if (/WF_CHROMA_ERROR:1223:/.test(processResult.stdout)) {
    return { outcome: 'uac-cancelled', error: '已取消 Windows 管理员授权' }
  }
  const wrapperError = processResult.stdout.match(/WF_CHROMA_ERROR:([^:]*):([^\r\n]*)/)
  if (wrapperError) {
    let message = '无法启动管理员修复'
    try { message = Buffer.from(wrapperError[2], 'base64').toString('utf8') || message } catch { /* Keep fallback. */ }
    return { outcome: 'process-failed', error: message }
  }
  const exitMatch = processResult.stdout.match(/WF_CHROMA_EXIT:(-?\d+)/)
  const elevatedExitCode = exitMatch ? Number(exitMatch[1]) : null
  if (processResult.code !== 0 || (elevatedExitCode !== null && elevatedExitCode !== 0)) {
    return {
      outcome: 'process-failed',
      error: processResult.stderr.trim() || `管理员修复进程异常退出（${elevatedExitCode ?? processResult.code ?? 'unknown'}）`,
      exitCode: elevatedExitCode ?? processResult.code,
    }
  }
  return readRepairReport(resultPath)
}

module.exports = {
  APP_ROOT,
  STALE_APPS,
  REPAIR_PROTOCOL_VERSION,
  inspectChromaAppList,
  createRepairScript,
  createElevationCommand,
  runPowerShell,
  readRepairReport,
  launchChromaAppListRepair,
}

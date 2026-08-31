/**
 * AutoMix Enhanced stem model assets.
 * HTDemucs is optional: absence never disables v2 DSP; it only removes stem-aware refinement.
 */
const { app, BrowserWindow, net } = require('electron')
const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const AdmZip = require('adm-zip')
const manifest = require('../shared/automixModelManifest.json')

const RESPONSE_TIMEOUT_MS = 45_000
const PROGRESS_INTERVAL_MS = 200
const state = {
  status: 'idle',
  asset: null,
  received: 0,
  total: 0,
  speed: 0,
  eta: null,
  host: null,
  error: null,
  controller: null,
  running: null,
}

function getModelRoot() {
  return path.join(path.dirname(app.getPath('exe')), 'automix-models')
}
function getModelPath() { return path.join(getModelRoot(), 'htdemucs.onnx') }
function getRuntimeDir() { return path.join(getModelRoot(), 'runtime') }
function getRuntimePath() { return path.join(getRuntimeDir(), process.platform === 'win32' ? 'python.exe' : 'bin/python3') }
function getModelMarkerPath() { return `${getModelPath()}.verified.json` }
function getRuntimeMarkerPath() { return path.join(getRuntimeDir(), '.verified.json') }
function assetByName(name) { return manifest.assets.find(asset => asset.name === name) || null }
function assetSupported(asset) {
  return (!asset.platform || asset.platform === process.platform) && (!asset.arch || asset.arch === process.arch)
}
function fileSize(file) {
  try { return fs.statSync(file).isFile() ? fs.statSync(file).size : 0 } catch { return 0 }
}
function runtimePayloadReady() {
  const root = getRuntimeDir()
  const required = process.platform === 'win32'
    ? [
      getRuntimePath(),
      path.join(root, 'Lib', 'site-packages', 'numpy', '__init__.py'),
      path.join(root, 'Lib', 'site-packages', 'onnxruntime', '__init__.py'),
      path.join(root, 'Lib', 'site-packages', 'onnxruntime', 'capi', 'onnxruntime_pybind11_state.pyd'),
      path.join(root, 'Lib', 'site-packages', 'onnxruntime', 'capi', 'onnxruntime.dll'),
    ]
    : [
      getRuntimePath(),
      path.join(root, 'lib', 'python3.11', 'site-packages', 'numpy', '__init__.py'),
      path.join(root, 'lib', 'python3.11', 'site-packages', 'onnxruntime', '__init__.py'),
    ]
  return required.every(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile())
}
function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
function installedAsset(asset) {
  if (!assetSupported(asset)) return false
  if (asset.kind === 'runtime') {
    const marker = readMarker(getRuntimeMarkerPath())
    return runtimePayloadReady() && marker?.sha256 === asset.sha256 && marker?.bytes === asset.bytes
  }
  const target = path.join(getModelRoot(), asset.file)
  const marker = readMarker(getModelMarkerPath())
  let stat
  try { stat = fs.statSync(target) } catch { return false }
  return stat.isFile() && stat.size === asset.bytes
    && marker?.sha256 === asset.sha256 && marker?.bytes === asset.bytes && marker?.mtimeMs === stat.mtimeMs
}
function snapshot() {
  const model = assetByName('htdemucs')
  const runtime = assetByName('runtime')
  const modelReady = Boolean(model && installedAsset(model))
  const runtimeReady = Boolean(runtime && installedAsset(runtime))
  return {
    installed: modelReady && runtimeReady,
    modelReady,
    runtimeReady,
    supported: Boolean(model && runtime && assetSupported(model) && assetSupported(runtime)),
    modelPath: getModelPath(),
    runtimePath: getRuntimePath(),
    root: getModelRoot(),
    version: manifest.version,
    download: publicProgress(),
  }
}
function publicProgress() {
  return {
    status: state.status,
    asset: state.asset,
    received: state.received,
    total: state.total,
    percent: state.total > 0 ? Math.min(100, state.received / state.total * 100) : 0,
    speed: state.speed,
    eta: state.eta,
    host: state.host,
    error: state.error,
  }
}
function broadcast() {
  const payload = publicProgress()
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('stem-model:progress', payload)
    }
  } catch { /* window may close during shutdown */ }
}
async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
  })
}
async function verify(file, asset) {
  if (fileSize(file) !== asset.bytes) return false
  return (await sha256(file)) === asset.sha256
}
function writeMarker(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}
async function establishInstalledIdentity(asset) {
  if (asset.kind === 'runtime') return installedAsset(asset)
  const target = path.join(getModelRoot(), asset.file)
  if (!await verify(target, asset).catch(() => false)) return false
  const stat = fs.statSync(target)
  writeMarker(getModelMarkerPath(), { bytes: asset.bytes, sha256: asset.sha256, mtimeMs: stat.mtimeMs })
  return true
}
function removeHandlers(ipcMain) {
  for (const channel of ['stem-model:get-status', 'stem-model:download', 'stem-model:pause', 'stem-model:cancel', 'stem-model:delete']) {
    try { ipcMain.removeHandler(channel) } catch { /* first registration */ }
  }
}

async function streamDownload(url, target, asset, signal) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const part = `${target}.part`
  let offset = fileSize(part)
  if (offset > asset.bytes) { await fsp.rm(part, { force: true }); offset = 0 }
  return new Promise((resolve) => {
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    const request = net.request({ url, method: 'GET' })
    if (offset > 0) request.setHeader('Range', `bytes=${offset}-`)
    let deadline = setTimeout(() => request.abort(), RESPONSE_TIMEOUT_MS)
    let stallTimer = null
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => request.abort(), RESPONSE_TIMEOUT_MS)
    }
    const abort = () => request.abort()
    signal.addEventListener('abort', abort, { once: true })
    request.on('response', response => {
      clearTimeout(deadline); deadline = null
      armStallTimer()
      const status = response.statusCode
      if (status !== 200 && status !== 206) { if (stallTimer) clearTimeout(stallTimer); response.resume(); finish(`${new URL(url).host}: HTTP ${status}`); return }
      // Server ignored Range: restart rather than appending duplicate bytes.
      if (offset > 0 && status === 200) { offset = 0; try { fs.rmSync(part, { force: true }) } catch {} }
      const output = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
      let received = offset
      let sampledAt = Date.now()
      let sampledBytes = received
      let announcedAt = 0
      state.host = new URL(url).host
      state.total = asset.bytes
      state.received = received
      const cleanup = () => signal.removeEventListener('abort', abort)
      response.on('data', chunk => {
        armStallTimer()
        received += chunk.length
        state.received = received
        const now = Date.now()
        if (now - sampledAt >= 500) {
          state.speed = Math.round((received - sampledBytes) * 1000 / (now - sampledAt))
          state.eta = state.speed > 0 ? Math.max(0, Math.round((asset.bytes - received) / state.speed)) : null
          sampledAt = now; sampledBytes = received
        }
        if (now - announcedAt >= PROGRESS_INTERVAL_MS) { announcedAt = now; broadcast() }
        if (!output.write(chunk)) { response.pause(); output.once('drain', () => response.resume()) }
      })
      response.on('end', () => output.end(async () => {
        if (stallTimer) clearTimeout(stallTimer)
        cleanup()
        if (signal.aborted) { finish('paused'); return }
        try {
          if (!await verify(part, asset)) { await fsp.rm(part, { force: true }); finish(`${state.host}: size/hash mismatch`); return }
          await fsp.rm(target, { force: true })
          await fsp.rename(part, target)
          finish(null)
        } catch (error) { finish(error?.message || String(error)) }
      }))
      response.on('error', error => { if (stallTimer) clearTimeout(stallTimer); output.destroy(); cleanup(); finish(signal.aborted ? 'paused' : (error?.message || String(error))) })
      output.on('error', error => { if (stallTimer) clearTimeout(stallTimer); request.abort(); cleanup(); finish(error?.message || String(error)) })
    })
    request.on('error', error => {
      if (deadline) clearTimeout(deadline)
      if (stallTimer) clearTimeout(stallTimer)
      signal.removeEventListener('abort', abort)
      finish(signal.aborted ? 'paused' : (error?.message || String(error)))
    })
    request.end()
  })
}

function assertSafeZip(zip, stagingRoot) {
  const root = path.resolve(stagingRoot) + path.sep
  for (const entry of zip.getEntries()) {
    const resolved = path.resolve(stagingRoot, entry.entryName)
    if (!resolved.startsWith(root)) throw new Error(`Unsafe archive entry: ${entry.entryName}`)
  }
}
async function installRuntime(archive, asset) {
  if (!await verify(archive, asset)) throw new Error('Runtime archive verification failed')
  const staging = `${getRuntimeDir()}.staging-${process.pid}-${Date.now()}`
  const backup = `${getRuntimeDir()}.backup-${process.pid}`
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.mkdir(staging, { recursive: true })
  const zip = new AdmZip(archive)
  assertSafeZip(zip, staging)
  zip.extractAllTo(staging, true)
  // Archives may contain one top-level runtime folder; normalize it.
  let runtimeHome = staging
  if (!fs.existsSync(path.join(runtimeHome, process.platform === 'win32' ? 'python.exe' : 'bin/python3'))) {
    const children = await fsp.readdir(staging, { withFileTypes: true })
    const nested = children.find(entry => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, process.platform === 'win32' ? 'python.exe' : 'bin/python3')))
    if (nested) runtimeHome = path.join(staging, nested.name)
  }
  const executable = path.join(runtimeHome, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  if (!fs.existsSync(executable)) throw new Error('Runtime archive has no Python interpreter')
  await fsp.rm(backup, { recursive: true, force: true })
  if (fs.existsSync(getRuntimeDir())) await fsp.rename(getRuntimeDir(), backup)
  try {
    if (runtimeHome === staging) await fsp.rename(staging, getRuntimeDir())
    else { await fsp.rename(runtimeHome, getRuntimeDir()); await fsp.rm(staging, { recursive: true, force: true }) }
    writeMarker(getRuntimeMarkerPath(), { bytes: asset.bytes, sha256: asset.sha256, version: manifest.version })
    await fsp.rm(backup, { recursive: true, force: true })
  } catch (error) {
    await fsp.rm(getRuntimeDir(), { recursive: true, force: true })
    if (fs.existsSync(backup)) await fsp.rename(backup, getRuntimeDir())
    throw error
  } finally {
    await fsp.rm(archive, { force: true })
    await fsp.rm(staging, { recursive: true, force: true })
  }
}
async function downloadAsset(asset, signal) {
  if (installedAsset(asset)) return
  const finalPath = path.join(getModelRoot(), asset.file)
  const partPath = `${finalPath}.part`
  // Crash/pause may happen after the last byte but before rename. Promote a complete verified
  // partial immediately instead of issuing the invalid Range "bytes=size-".
  const partVerified = await verify(partPath, asset).catch(() => false)
  if (partVerified) {
    await fsp.mkdir(path.dirname(finalPath), { recursive: true })
    await fsp.rm(finalPath, { force: true })
    await fsp.rename(partPath, finalPath)
    if (asset.kind === 'runtime') await installRuntime(finalPath, asset)
    else await establishInstalledIdentity(asset)
    return
  }
  if (fileSize(partPath) >= asset.bytes) await fsp.rm(partPath, { force: true })
  let failures = []
  for (const template of manifest.mirrors) {
    if (signal.aborted) throw new Error('paused')
    const url = template.replace('{file}', asset.file)
    const failure = await streamDownload(url, finalPath, asset, signal)
    if (failure === null) {
      if (asset.kind === 'runtime') await installRuntime(finalPath, asset)
      else await establishInstalledIdentity(asset)
      return
    }
    if (failure === 'paused') throw new Error('paused')
    failures.push(failure)
  }
  throw new Error(failures.join('; ') || `All mirrors failed for ${asset.name}`)
}
async function runDownload() {
  if (state.running) return state.running
  const controller = new AbortController()
  state.controller = controller
  state.status = 'downloading'; state.error = null
  state.running = (async () => {
    try {
      for (const asset of manifest.assets) {
        if (!assetSupported(asset) || installedAsset(asset)) continue
        state.asset = asset.name; state.received = 0; state.total = asset.bytes; state.speed = 0; state.eta = null; broadcast()
        await downloadAsset(asset, controller.signal)
      }
      state.status = 'done'; state.asset = null; state.received = 0; state.total = 0; broadcast()
      return { ok: true, status: snapshot() }
    } catch (error) {
      const paused = controller.signal.aborted || error?.message === 'paused'
      state.status = paused ? 'paused' : 'error'
      state.error = paused ? null : (error?.message || String(error))
      broadcast()
      return { ok: false, paused, error: state.error }
    } finally { state.controller = null; state.running = null }
  })()
  return state.running
}
async function waitForRunning() {
  const running = state.running
  if (!running) return
  try { await running } catch { /* operation state carries the error */ }
}
async function pause() {
  state.controller?.abort()
  state.status = 'paused'
  broadcast()
  await waitForRunning()
  state.status = 'paused'
  broadcast()
  return { ok: true }
}
async function cancel() {
  state.controller?.abort()
  await waitForRunning()
  for (const asset of manifest.assets) await fsp.rm(path.join(getModelRoot(), `${asset.file}.part`), { force: true }).catch(() => {})
  state.status = 'idle'; state.asset = null; state.error = null; state.received = 0; state.total = 0; broadcast()
  return { ok: true }
}
async function removeAll() {
  state.controller?.abort()
  await waitForRunning()
  try { await fsp.rm(getModelRoot(), { recursive: true, force: true }); state.status = 'idle'; broadcast(); return { ok: true } }
  catch (error) { return { ok: false, error: error?.message || String(error) } }
}
function setupStemModelIPC(ipcMain, guardHandler = (_capability, handler) => handler) {
  removeHandlers(ipcMain)
  // Upgrade files copied/imported before marker support: verify content once, then future startup
  // uses the marker-bound size/hash/mtime identity without hashing 104MB on the main thread.
  const model = assetByName('htdemucs')
  if (model && !installedAsset(model) && fs.existsSync(getModelPath())) {
    void establishInstalledIdentity(model).then(() => broadcast()).catch(() => undefined)
  }
  ipcMain.handle('stem-model:get-status', guardHandler('models', () => snapshot()))
  ipcMain.handle('stem-model:download', guardHandler('models', () => runDownload()))
  ipcMain.handle('stem-model:pause', guardHandler('models', () => pause()))
  ipcMain.handle('stem-model:cancel', guardHandler('models', () => cancel()))
  ipcMain.handle('stem-model:delete', guardHandler('models', () => removeAll()))
}

module.exports = {
  setupStemModelIPC,
  getModelRoot,
  getModelPath,
  getRuntimePath,
  getRuntimeDir,
  snapshot,
  verify,
  sha256,
  assertSafeZip,
  installRuntime,
  isModelTrusted: () => installedAsset(assetByName('htdemucs')),
  isRuntimeTrusted: () => installedAsset(assetByName('runtime')),
  runDownload,
  pause,
  cancel,
  removeAll,
  _manifest: manifest,
}

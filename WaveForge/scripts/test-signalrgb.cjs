'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SignalRgbEffectManager, sha256 } = require('../desktop/signalrgb-effect-manager.cjs')
const { setupSignalRgbIpc } = require('../desktop/signalrgb-ipc.cjs')
const { startSignalRgbMock } = require('../desktop/signalrgb-mock.cjs')

async function makeApp(root, version) {
  const directory = path.join(root, `app-${version}`, 'Signal-x64', 'Effects', 'Dynamic')
  await fs.promises.mkdir(directory, { recursive: true })
  return directory
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'waveforge-signalrgb-'))
  const tempRoot = path.join(root, 'temp')
  const bundled = path.join(root, 'bundle.html')
  await fs.promises.writeFile(bundled, '<html>bundle-v1</html>')
  const dynamic100 = await makeApp(root, '1.0.0')
  await makeApp(root, '0.9.9')
  const mock = startSignalRgbMock({ localPort: 0, canvasPort: 0 })
  await mock.ready
  let clock = 1000
  const manager = new SignalRgbEffectManager({
    roots: [root], tempRoot, bundledEffectPath: bundled, version: '1.0.0', platformSupported: true,
    localApiBase: mock.localApiBase, canvasApiBase: mock.canvasApiBase,
    eventThrottleMs: 40, eventDedupeMs: 250, now: () => clock,
  })

  try {
    let status = await manager.refresh()
    assert.equal(status.installed, true)
    assert.equal(status.running, true)
    assert.equal(status.localApiAvailable, true)
    assert.equal(status.proAvailable, true)
    assert.equal(status.canvasEventAvailable, true)
    assert.deepEqual(status.layout, mock.state.currentLayout)
    assert.deepEqual(status.layouts, mock.state.layouts)
    assert.equal(status.currentEffect.id, 'previous')

    status = await manager.installEffect()
    const effectPath = path.join(dynamic100, 'WaveForge.html')
    const sidecarPath = path.join(dynamic100, 'WaveForge.waveforge.json')
    assert.equal(status.effectInstalled, true)
    assert.equal(status.hash, sha256(Buffer.from('<html>bundle-v1</html>')))
    assert.equal(status.effectHash, status.hash)
    assert.equal(await fs.promises.readFile(effectPath, 'utf8'), '<html>bundle-v1</html>')
    let sidecar = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'))
    assert.equal(sidecar.owner, 'WaveForge')
    assert.equal(sidecar.sha256, sha256(Buffer.from('<html>bundle-v1</html>')))

    await fs.promises.writeFile(bundled, '<html>bundle-v2</html>')
    manager.version = '2.0.0'
    status = await manager.refreshInstallation().then(() => manager.getStatus())
    assert.equal(status.effectUpdateAvailable, true)
    status = await manager.installEffect()
    assert.equal(status.effectUpdateAvailable, false)
    assert.equal(status.effectVersion, '2.0.0')
    assert.equal(await fs.promises.readFile(effectPath, 'utf8'), '<html>bundle-v2</html>')

    await fs.promises.writeFile(effectPath, '<html>user edit</html>')
    await assert.rejects(manager.installEffect(), /not owned/)
    assert.equal(await fs.promises.readFile(effectPath, 'utf8'), '<html>user edit</html>')
    await assert.rejects(manager.uninstallEffect(), /refusing to remove/)
    assert.equal(await fs.promises.readFile(effectPath, 'utf8'), '<html>user edit</html>')

    await fs.promises.writeFile(effectPath, '<html>bundle-v2</html>')
    sidecar = { owner: 'WaveForge', file: 'WaveForge.html', version: '2.0.0', sha256: sha256(Buffer.from('<html>bundle-v2</html>')) }
    await fs.promises.writeFile(sidecarPath, JSON.stringify(sidecar))
    await manager.uninstallEffect()
    assert.equal(fs.existsSync(effectPath), false)
    assert.equal(fs.existsSync(sidecarPath), false)

    await manager.installEffect()
    const dynamic110 = await makeApp(root, '1.10.0')
    status = await manager.refreshInstallation().then(() => manager.getStatus())
    assert.equal(status.effectPath, path.join(dynamic110, 'WaveForge.html'))
    assert.equal(status.restartRequired, true)
    assert.equal(status.effectInstalled, false)
    await manager.installEffect()
    assert.equal(manager.getStatus().restartRequired, false)

    mock.state.localMode = 'forbidden'
    status = await manager.refresh()
    assert.equal(status.localApiAvailable, true)
    assert.equal(status.running, true)
    assert.equal(status.proAvailable, false)
    assert.equal(status.errors.length, 0, '403 is capability state, not an error')
    mock.state.localMode = 'error'
    status = await manager.refresh()
    assert.equal(status.localApiAvailable, false)
    assert.equal(status.running, false)
    mock.state.localMode = 'ok'

    await manager.applyEffect()
    assert.equal(mock.metrics.applies.at(-1), 'waveforge')
    assert.equal(manager.getStatus().currentEffect.id, 'waveforge')
    await manager.restoreEffect()
    assert.equal(mock.metrics.applies.at(-1), 'previous')

    assert.equal(manager.validateEvent('beat:0'), true)
    assert.equal(manager.validateEvent('beat:100'), true)
    assert.equal(manager.validateEvent('beat:101'), false)
    assert.equal(manager.validateEvent('accent'), true)
    assert.equal(manager.validateEvent('accent:67'), true)
    assert.equal(manager.validateEvent('accent:101'), false)
    assert.equal(manager.validateEvent('style:galaxy'), true)
    assert.equal(manager.validateEvent('style:unknown'), false)
    assert.equal(manager.validateEvent('theme:12ABef:fedCBA'), true)
    assert.equal(manager.validateEvent('section:chorus'), true)
    assert.equal(manager.validateEvent('section:custom'), false)
    await assert.rejects(manager.sendEvent('../bad'), /invalid/)
    const canvasPostsBeforeEvent = mock.metrics.canvasPosts
    assert.ok(canvasPostsBeforeEvent >= 1, 'refresh should probe Canvas Event')
    let sent = await manager.sendEvent('play')
    assert.equal(sent.method, 'POST')
    assert.equal(mock.metrics.canvasPosts, canvasPostsBeforeEvent + 1)
    sent = await manager.sendEvent('play')
    assert.equal(sent.deduplicated, true)
    clock += 10
    sent = await manager.sendEvent('pause')
    assert.equal(sent.throttled, true)
    clock += 50
    await manager.sendEvent('pause')
    assert.equal(mock.metrics.canvasPosts, canvasPostsBeforeEvent + 2)

    mock.state.canvasPostStatus = 405
    clock += 50
    await assert.rejects(manager.sendEvent('accent'), /HTTP 405/)
    clock += 50
    sent = await manager.sendEvent('accent', { getFallback: true })
    assert.equal(sent.method, 'GET')
    assert.equal(mock.metrics.canvasGets, 1)
    assert.equal(mock.metrics.canvasEvents.at(-1).sender, 'waveforge')

    const unavailable = new SignalRgbEffectManager({ roots: [root], localApiBase: 'http://127.0.0.1:1/api/v1', requestTimeoutMs: 100, platformSupported: true })
    status = await unavailable.refresh()
    assert.equal(status.localApiAvailable, false)
    assert.equal(status.proAvailable, null)

    const handlers = new Map()
    const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) }
    const shellCalls = []
    const ipc = setupSignalRgbIpc({ ipcMain, manager, shell: { openPath: async (target) => { shellCalls.push(target); return '' } } })
    assert.deepEqual([...handlers.keys()].sort(), [
      'signalrgb:apply-effect', 'signalrgb:get-status', 'signalrgb:install-effect', 'signalrgb:open-signalrgb',
      'signalrgb:refresh', 'signalrgb:restore-effect', 'signalrgb:send-event', 'signalrgb:uninstall-effect',
    ])
    const opened = await handlers.get('signalrgb:open-signalrgb')()
    assert.equal(opened.opened, true)
    assert.equal(shellCalls.length, 1)
    assert.equal(path.basename(shellCalls[0]).toLowerCase(), 'signalrgb.exe')
    ipc.dispose()
    assert.equal(handlers.size, 0)

    assert.throws(() => manager.managedPath(dynamic110, '../WaveForge.html'), /unsafe/)
    console.log('SignalRGB integration tests passed: installation ownership, updates, conflicts, migration, Local API, apply/restore, Canvas Events, and IPC cleanup.')
  } finally {
    await mock.stop().catch(() => {})
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('SignalRGB integration tests failed.')
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})

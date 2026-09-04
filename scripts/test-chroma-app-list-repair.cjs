'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  inspectChromaAppList,
  createRepairScript,
  createElevationCommand,
  readRepairReport,
  launchChromaAppListRepair,
  REPAIR_PROTOCOL_VERSION,
  STALE_APPS,
} = require('../desktop/chroma-app-list-repair.cjs')

function fakeChild(onSpawn) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true }
  queueMicrotask(() => onSpawn(child))
  return child
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'waveforge-chroma-repair-'))
  try {
    await Promise.all(STALE_APPS.map(name => fs.promises.mkdir(path.join(root, name))))
    const records = [
      { Name: 'WaveForge', Title: 'WaveForge', Path: 'C:\\ProgramData\\Razer Chroma SDK\\Apps\\WaveForge\\WaveForge.exe', Enable: 1 },
      { Name: 'WaveForgeProbe', Title: 'WaveForge Probe', Path: 'C:\\ProgramData\\Razer Chroma SDK\\Apps\\WaveForgeProbe\\WaveForgeProbe.exe', Enable: 1 },
      { Name: 'DeltaForceClient-Win64-Shipping', Title: '三角洲行动', Path: 'E:\\Delta Force\\game.exe', Enable: 1 },
    ]
    const execFileImpl = (_exe, _args, _options, callback) => callback(null, JSON.stringify(records), '')
    const health = await inspectChromaAppList({ appRoot: root, execFileImpl, readRecentUtf8ErrorImpl: () => null })
    assert.equal(health.cleanAppRegistered, true)
    assert.deepEqual(health.staleRegistry, ['WaveForgeProbe'])
    assert.deepEqual(health.staleFolders.sort(), [...STALE_APPS].sort())
    assert.equal(health.nonAsciiApps.length, 1)
    assert.equal(health.nonAsciiApps[0].Title, '三角洲行动')
    assert.equal(health.thirdPartyWarning, true)
    assert.equal(health.corrupted, true)

    const cleanRoot = path.join(root, 'clean')
    await fs.promises.mkdir(cleanRoot)
    const thirdPartyExecFileImpl = (_exe, _args, _options, callback) => callback(null, JSON.stringify([records[0], records[2]]), '')
    const thirdPartyOnly = await inspectChromaAppList({
      appRoot: cleanRoot,
      execFileImpl: thirdPartyExecFileImpl,
      readRecentUtf8ErrorImpl: () => null,
    })
    assert.equal(thirdPartyOnly.thirdPartyWarning, true)
    assert.equal(thirdPartyOnly.corrupted, false)

    const resultPath = path.join(root, 'result.json')
    const script = createRepairScript(resultPath)
    for (const name of STALE_APPS) assert.match(script, new RegExp(name))
    assert.doesNotMatch(script, /DeltaForce|三角洲/)
    assert.match(script, /try \{/)
    assert.match(script, /finally \{/)
    assert.match(script, /Start-Service/)
    assert.match(script, /error = \$errorMessage/)
    assert.match(script, new RegExp(`version = ${REPAIR_PROTOCOL_VERSION}`))
    assert.match(script, /Set-Content -Encoding UTF8/)

    const awkwardPath = "C:\\Users\\Test User\\AppData\\Roaming\\涟漪's Player\\repair.ps1"
    const elevationCommand = createElevationCommand(awkwardPath)
    assert.doesNotMatch(elevationCommand, /Test User|涟漪|repair\.ps1/)
    assert.match(elevationCommand, /-EncodedCommand/)
    assert.match(elevationCommand, /-PassThru -Wait/)

    const successRoot = path.join(root, "User Data 涟漪's")
    let outerArgs = null
    const success = await launchChromaAppListRepair(successRoot, {
      allowTestPlatform: true,
      spawnImpl: (_exe, args) => {
        outerArgs = args
        return fakeChild((child) => {
          const reportPath = path.join(successRoot, 'chroma-repair', 'repair-result.json')
          fs.writeFileSync(reportPath, JSON.stringify({
            version: REPAIR_PROTOCOL_VERSION,
            ok: true,
            repairedAt: new Date().toISOString(),
            removed: ['WaveForgeProbe'],
            error: null,
          }))
          child.stdout.write('WF_CHROMA_EXIT:0\n')
          child.emit('close', 0)
        })
      },
    })
    assert.equal(success.outcome, 'succeeded')
    assert.deepEqual(success.report.removed, ['WaveForgeProbe'])
    assert.equal(fs.readFileSync(path.join(successRoot, 'chroma-repair', 'repair-chroma-app-list.ps1')).subarray(0, 3).toString('hex'), 'efbbbf')
    assert.ok(outerArgs.includes('-EncodedCommand'))
    assert.equal(outerArgs.some(value => value.includes('User Data') || value.includes('涟漪')), false)

    const cancelled = await launchChromaAppListRepair(path.join(root, 'cancelled'), {
      allowTestPlatform: true,
      spawnImpl: () => fakeChild((child) => {
        child.stdout.write(`WF_CHROMA_ERROR:1223:${Buffer.from('cancelled').toString('base64')}\n`)
        child.emit('close', 1)
      }),
    })
    assert.equal(cancelled.outcome, 'uac-cancelled')

    const spawnFailed = await launchChromaAppListRepair(path.join(root, 'spawn-failed'), {
      allowTestPlatform: true,
      spawnImpl: () => fakeChild(child => child.emit('error', new Error('spawn unavailable'))),
    })
    assert.equal(spawnFailed.outcome, 'process-failed')
    assert.match(spawnFailed.error, /spawn unavailable/)

    const missing = await launchChromaAppListRepair(path.join(root, 'missing'), {
      allowTestPlatform: true,
      spawnImpl: () => fakeChild((child) => {
        child.stdout.write('WF_CHROMA_EXIT:0\n')
        child.emit('close', 0)
      }),
    })
    assert.equal(missing.outcome, 'result-missing')

    const timeoutChild = fakeChild(() => {})
    const timedOut = await launchChromaAppListRepair(path.join(root, 'timeout'), {
      allowTestPlatform: true,
      timeoutMs: 10,
      spawnImpl: () => timeoutChild,
    })
    assert.equal(timedOut.outcome, 'timeout')
    assert.equal(timeoutChild.killed, true)

    fs.writeFileSync(resultPath, '{not json')
    assert.equal(readRepairReport(resultPath).outcome, 'result-invalid')
    fs.writeFileSync(resultPath, JSON.stringify({ version: REPAIR_PROTOCOL_VERSION, ok: false, removed: [], error: 'access denied' }))
    const scriptFailed = readRepairReport(resultPath)
    assert.equal(scriptFailed.outcome, 'script-failed')
    assert.equal(scriptFailed.error, 'access denied')

    console.log('Chroma app-list repair tests passed: safe scope, encoded elevation, UAC lifecycle, timeout, and result validation.')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

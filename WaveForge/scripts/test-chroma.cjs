'use strict'

const assert = require('node:assert/strict')
const { startChromaMock } = require('../desktop/chroma-mock.cjs')
const { ChromaRestService, DEVICE_SPECS } = require('../desktop/chroma-ipc.cjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error(`Timed out waiting for ${message}`)
}

function totalDeviceRequests(metrics) {
  return Object.values(metrics.framesByDevice).reduce((sum, count) => sum + count, 0)
}

async function main() {
  const mock = startChromaMock({ port: 0, sessionReadyDelayMs: 100, legacyMousepad15: true })
  await mock.ready
  const statuses = []
  let hardwareScans = 0
  let discoveryDiagnostic = null
  let appListInspections = 0
  let resolveRepair = null
  const repairPromise = new Promise(resolve => { resolveRepair = resolve })
  const hardwareFixture = [{
    id: 'HID\\VID_1532&PID_0098\\TEST',
    name: 'Razer Huntsman V2 Analog',
    type: 'keyboard',
    present: true,
    vid: '1532',
    pid: '0098',
    source: 'test',
  }]
  const service = new ChromaRestService({
    baseUrl: mock.baseUrl,
    timers: {
      heartbeatIntervalMs: 25,
      retryIntervalMs: 25,
      frameIdleMs: 40,
      requestTimeoutMs: 500,
      sessionReadyDelaysMs: [10, 20, 40, 80],
    },
    discoverDevices: async () => {
      hardwareScans += 1
      return { devices: discoveryDiagnostic ? [] : hardwareFixture, diagnostic: discoveryDiagnostic }
    },
    inspectAppList: async () => {
      appListInspections += 1
      return { corrupted: false, cleanAppRegistered: true, staleFolders: [], staleRegistry: [], nonAsciiApps: [] }
    },
    launchRepair: async () => repairPromise,
    onStatus: (status) => statuses.push(status),
  })

  try {
    const activated = await service.activate()
    assert.equal(activated.active, true)
    assert.equal(activated.platformSupported, true)
    assert.equal(activated.synapseFound, true)
    assert.equal(activated.registered, true)
    assert.equal(mock.metrics.registers, 1)
    assert.equal(hardwareScans, 1, 'activate should scan physical hardware')
    assert.deepEqual(activated.hardwareDevices, hardwareFixture)
    assert.equal(activated.deviceDiscoveryError, null)
    assert.ok(activated.lastDeviceScanAt)
    assert.ok(mock.metrics.earlySessionRequests >= 1, 'service should retry while the dynamic session endpoint starts')
    assert.equal(mock.metrics.lastBodies.registration.title, 'WaveForge')
    assert.deepEqual(mock.metrics.lastBodies.registration.device_supported, Object.keys(DEVICE_SPECS))
    assert.equal(appListInspections, 1, 'activate should inspect Chroma app-list health')

    let repairSettled = false
    const repairOperation = service.launchAppListRepair().then(result => {
      repairSettled = true
      return result
    })
    await sleep(10)
    assert.equal(repairSettled, false, 'repair IPC must wait for the elevated operation')
    resolveRepair({
      outcome: 'succeeded',
      report: { version: 1, ok: true, repairedAt: new Date().toISOString(), removed: ['WaveForgeProbe'], error: null },
    })
    const repairResult = await repairOperation
    assert.equal(repairResult.outcome, 'succeeded')
    assert.equal(appListInspections, 2, 'successful repair should refresh app-list health')
    assert.equal(repairResult.status.appListHealth.corrupted, false)
    assert.ok(repairResult.status.logs.some(log => /repair completed/.test(log.message)))

    const keyboardFrame = Array.from({ length: DEVICE_SPECS.keyboard.length }, (_, index) => index)
    assert.equal(service.submitFrame({ device: 'keyboard', colors: keyboardFrame }), true)
    await waitFor(() => mock.metrics.framesByDevice.keyboard === 1, 'first keyboard frame')
    assert.equal(mock.metrics.posts, 0, 'live frames must never use effect-creation POST')
    assert.equal(mock.metrics.puts, 1, 'first live frame must use immediate PUT')
    assert.equal(mock.metrics.lastBodies.keyboard.effect, 'CHROMA_CUSTOM')
    assert.deepEqual(mock.metrics.lastBodies.keyboard.param.map((row) => row.length), [22, 22, 22, 22, 22, 22])

    const clonedTypedArray = Object.fromEntries(Array.from({ length: DEVICE_SPECS.keyboard.length }, (_, index) => [index, 0xff000000 + index]))
    assert.equal(service.submitFrame({ device: 'keyboard', colors: clonedTypedArray }), true)
    await waitFor(() => mock.metrics.framesByDevice.keyboard === 2, 'second keyboard frame')
    assert.equal(mock.metrics.posts, 0)
    assert.equal(mock.metrics.puts, 2, 'subsequent live effect must also use PUT')

    const refreshed = await service.refreshDevices()
    assert.equal(hardwareScans, 2, 'refresh should rescan physical hardware')
    assert.deepEqual(refreshed.hardwareDevices, hardwareFixture)
    for (const device of Object.keys(DEVICE_SPECS)) {
      assert.equal(refreshed.devices[device].available, true, `${device} should be available`)
      assert.equal(refreshed.devices[device].effectCreated, false, `${device} probe must not create a cached effect`)
      assert.equal(refreshed.devices[device].failures, 0)
      assert.equal(mock.metrics.lastBodies[device].effect, 'CHROMA_NONE')
    }
    assert.equal(totalDeviceRequests(mock.metrics), 8, 'two frames plus six side-effect-free probes expected')

    const mouseRequestsBeforeDisable = mock.metrics.framesByDevice.mouse
    const disabled = await service.setDeviceEnabled('mouse', false)
    assert.equal(disabled.devices.mouse.enabled, false)
    assert.equal(mock.metrics.lastBodies.mouse.effect, 'CHROMA_NONE')
    assert.equal(service.submitFrame({ device: 'mouse', colors: new Uint32Array(DEVICE_SPECS.mouse.length).fill(0x00ffffff) }), true)
    await sleep(30)
    assert.equal(mock.metrics.framesByDevice.mouse, mouseRequestsBeforeDisable + 1, 'disable NONE is the only mouse request')

    await service.deactivate()
    assert.equal(service.getStatus().devices.mouse.enabled, false, 'device disabled state must survive session release')
    await service.activate()
    assert.equal(service.getStatus().devices.mouse.enabled, false, 'device disabled state must survive reconnect')
    const mouseBeforeReconnectFrame = mock.metrics.framesByDevice.mouse
    assert.equal(service.submitFrame({ device: 'mouse', colors: new Uint32Array(DEVICE_SPECS.mouse.length).fill(0x00112233) }), true)
    await sleep(30)
    assert.equal(mock.metrics.framesByDevice.mouse, mouseBeforeReconnectFrame, 'disabled device must not send after reconnect')
    await service.setDeviceEnabled('mouse', true)

    const beforeInvalid = totalDeviceRequests(mock.metrics)
    assert.equal(service.submitFrame({ device: 'mouse', colors: [1, 2] }), false)
    assert.equal(service.submitFrame({ device: 'unknown', colors: [] }), false)
    assert.equal(service.submitFrame({ device: 'headset', colors: [1, 2, 3, 4, 5], extra: true }), false)
    await sleep(30)
    assert.equal(totalDeviceRequests(mock.metrics), beforeInvalid, 'invalid frames must not reach HTTP')

    for (const [device, spec] of Object.entries(DEVICE_SPECS)) {
      const colors = new Uint32Array(spec.length).fill(0x00112233)
      assert.equal(service.submitFrame({ device, colors }), true)
    }
    await waitFor(() => totalDeviceRequests(mock.metrics) === beforeInvalid + 6, 'all device frames')
    assert.deepEqual(mock.metrics.lastBodies.mouse.param.map((row) => row.length), Array(9).fill(7))
    assert.deepEqual(mock.metrics.lastBodies.keypad.param.map((row) => row.length), Array(4).fill(5))
    assert.equal(mock.metrics.lastBodies.mousepad.param.length, 15)
    assert.equal(service.getStatus().devices.mousepad.zones, 15, 'mousepad should negotiate the legacy 15-zone layout')
    assert.ok(service.getStatus().logs.some(log => /15-zone layout/.test(log.message)), 'zone negotiation should be visible in diagnostics')
    assert.equal(mock.metrics.lastBodies.headset.param.length, 5)
    assert.equal(mock.metrics.lastBodies.chromalink.param.length, 5)

    await waitFor(() => mock.metrics.heartbeats >= 1, 'heartbeat')
    assert.ok(service.getStatus().lastHeartbeatAt, 'heartbeat timestamp should be recorded')
    assert.ok(statuses.length > 0, 'status changes should be emitted')
    assert.doesNotThrow(() => JSON.stringify(service.getStatus()), 'status must be serializable')

    discoveryDiagnostic = 'PnP test failure'
    const scanFailed = await service.scanHardwareDevices()
    assert.deepEqual(scanFailed.hardwareDevices, [])
    assert.equal(scanFailed.deviceDiscoveryError, discoveryDiagnostic)
    assert.equal(scanFailed.registered, true, 'device discovery failure must not interrupt Chroma')

    await service.deactivate()
    assert.equal(mock.metrics.deletes, 2)
    assert.equal(mock.metrics.registers, 2)
    const inactive = service.getStatus()
    assert.equal(inactive.active, false)
    assert.equal(inactive.registered, false)
    assert.equal(inactive.sessionUri, null)

    console.log(`Chroma integration test passed: ${mock.metrics.registers} registration, ${mock.metrics.heartbeats} heartbeat(s), ${mock.metrics.posts} POST effects, ${mock.metrics.puts} PUT effects, ${mock.metrics.deletes} DELETE.`)
    console.log('Validated six device probes, frame shapes, structured-clone colors, strict length checks, status serialization, and session cleanup.')
  } finally {
    await service.dispose().catch(() => {})
    await mock.stop().catch(() => {})
  }
}

main().catch((error) => {
  console.error('Chroma integration test failed.')
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHseHeadTrackingController } = require('../desktop/hse-head-tracking.cjs')

function fixture(options = {}) {
  const contents = new EventEmitter()
  contents.mainFrame = { url: 'file:///C:/WaveForge/dist/index.html' }
  contents.getURL = () => contents.mainFrame.url
  const win = { webContents: contents }
  const session = new EventEmitter()
  session.setBluetoothPairingHandler = handler => { session.pair = handler }
  const dialogs = []
  let trusted = true
  const controller = createHseHeadTrackingController({
    getWindow: () => win,
    isTrusted: sender => trusted && sender === contents,
    showMessageBox: async (_win, settings) => { dialogs.push(settings); return { response: options.response ?? 0 } },
    createBridge: options.createBridge ?? (async () => ({ close: async () => {} })),
  })
  controller.installSession(session)
  controller.attachWindow(win)
  return { controller, contents, session, dialogs, untrust: () => { trusted = false } }
}

const event = () => ({ prevented: false, preventDefault() { this.prevented = true } })
const flush = () => new Promise(resolve => setImmediate(resolve))

test('串口不自动选首台，只批准用户明确选择的设备；主窗口导航撤销授权', async () => {
  const f = fixture({ response: 2 })
  let selected
  const e = event()
  f.session.emit('select-serial-port', e, [{ portId: 'COM1', displayName: '一号' }, { portId: 'COM2', displayName: '二号' }], f.contents, id => { selected = id })
  await flush()
  assert.equal(e.prevented, true)
  assert.equal(selected, 'COM2')
  assert.equal(f.dialogs[0].defaultId, 0)
  assert.equal(f.controller.canUseSerial({ deviceType: 'serial', origin: 'file://', device: { portId: 'COM1' } }), false)
  assert.equal(f.controller.canUseSerial({ deviceType: 'serial', origin: 'file://', device: { portId: 'COM2' } }), true)
  assert.equal(f.controller.canUseSerial({ deviceType: 'serial', origin: 'https://evil.test', device: { portId: 'COM2' } }), false)
  f.contents.emit('did-start-navigation', {}, 'file:///C:/WaveForge/dist/index.html', false, true)
  assert.equal(f.controller.canUseSerial({ deviceType: 'serial', origin: 'file://', device: { portId: 'COM2' } }), false)
})

test('取消/不可信窗口设备请求不会授权，BLE扫描可由窗口销毁立即取消', async () => {
  const f = fixture()
  let serial
  f.session.emit('select-serial-port', event(), [{ portId: 'COM1' }], f.contents, id => { serial = id })
  await flush()
  assert.equal(serial, '')
  let bluetooth
  const bleEvent = event()
  f.contents.emit('select-bluetooth-device', bleEvent, [{ deviceId: 'ble-1', deviceName: 'Tracker' }], id => { bluetooth = id })
  assert.equal(bleEvent.prevented, true)
  assert.equal(bluetooth, undefined)
  f.contents.emit('destroyed')
  assert.equal(bluetooth, '')
  f.untrust()
  f.session.emit('select-serial-port', event(), [{ portId: 'COM1' }], f.contents, id => { serial = id })
  assert.equal(serial, '')
  let pairing
  await f.session.pair({ deviceId: 'ble-1', frame: f.contents.mainFrame, pairingKind: 'confirm' }, result => { pairing = result })
  assert.deepEqual(pairing, { confirmed: false })
})

test('BLE发现列表更新后仍需显式选择；仅同一主frame和所选设备可确认配对', async () => {
  const f = fixture({ response: 1 })
  let selected
  const callback = id => { selected = id }
  f.contents.emit('select-bluetooth-device', event(), [], callback)
  f.contents.emit('select-bluetooth-device', event(), [{ deviceId: 'ble-2', deviceName: '头追设备' }], callback)
  assert.equal(selected, undefined)
  await new Promise(resolve => setTimeout(resolve, 1550))
  assert.equal(selected, 'ble-2')
  assert.deepEqual(f.dialogs[0].buttons, ['取消', '头追设备', '继续扫描'])
  let pairing
  await f.session.pair({ deviceId: 'ble-2', frame: f.contents.mainFrame, pairingKind: 'confirmPin', pin: '123456' }, result => { pairing = result })
  assert.equal(pairing.confirmed, true)
  assert.match(f.dialogs[1].detail, /123456/)
  await f.session.pair({ deviceId: 'ble-2', frame: {}, pairingKind: 'confirm' }, result => { pairing = result })
  assert.equal(pairing.confirmed, false)
  await f.session.pair({ deviceId: 'other-device', frame: f.contents.mainFrame, pairingKind: 'confirm' }, result => { pairing = result })
  assert.equal(pairing.confirmed, false)
  f.controller.shutdown()
})

test('OSC桥不自动启动；并发启动幂等，停止关闭监听；端口占用回传可读错误', async () => {
  let starts = 0
  let closes = 0
  const f = fixture({ createBridge: async () => { starts++; return { close: async () => { closes++ } } } })
  assert.equal(f.controller.state().running, false)
  assert.equal(starts, 0)
  await Promise.all([f.controller.startBridge(), f.controller.startBridge()])
  assert.equal(starts, 1)
  assert.equal(f.controller.state().running, true)
  await f.controller.stopBridge()
  assert.equal(closes, 1)
  assert.equal(f.controller.state().running, false)
  const conflict = fixture({ createBridge: async () => { throw Object.assign(new Error('address used'), { code: 'EADDRINUSE' }) } })
  assert.match((await conflict.controller.startBridge()).error, /端口已被占用/)
  assert.equal(conflict.controller.state().running, false)
})

test('窗口销毁发生在启动中时，稍后绑定成功的OSC监听仍被关闭', async () => {
  let resolveBridge
  let closes = 0
  const f = fixture({ createBridge: () => new Promise(resolve => { resolveBridge = resolve }) })
  const work = f.controller.startBridge()
  await flush()
  f.contents.emit('destroyed')
  resolveBridge({ close: async () => { closes++ } })
  await work
  assert.equal(closes, 1)
  assert.equal(f.controller.state().running, false)
})

test('真实导出IPC同时写同名WAV/MP3保持不覆盖，并拒绝异常类型及扩展名', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const vm = require('node:vm')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-hse-export-'))
  let handler
  let capability
  const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8')
  const start = source.indexOf("ipcMain.handle('hse-save-rendered-audio'")
  const end = source.indexOf('// ── QQ 音乐扫码登录', start)
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn } },
    guardTrustedIpc: (role, fn) => { capability = role; return fn },
    fs, path, Buffer, ArrayBuffer, Uint8Array, app: { getPath: () => directory }, console: { log() {} },
  })
  try {
    assert.equal(capability, 'privileged')
    const first = Uint8Array.of(1, 2, 3), second = Uint8Array.of(4, 5, 6)
    const results = await Promise.all([handler({}, first, '../同名.wav'), handler({}, second, '../同名.wav')])
    assert.equal(results.every(item => item.ok), true)
    assert.notEqual(results[0].path, results[1].path)
    assert.deepEqual([...fs.readFileSync(results[0].path)], [...first])
    assert.deepEqual([...fs.readFileSync(results[1].path)], [...second])
    assert.equal(path.dirname(results[0].path), directory)
    assert.equal((await handler({}, first, '音乐.mp3')).ok, true)
    assert.equal((await handler({}, first, '程序.exe')).ok, false)
    assert.equal((await handler({}, { length: 100 }, '音乐.wav')).ok, false)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

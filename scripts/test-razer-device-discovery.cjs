'use strict'

const assert = require('node:assert/strict')
const { parsePnpDevices } = require('../desktop/razer-device-discovery.cjs')

const fixture = JSON.stringify([
  {
    FriendlyName: 'Razer Huntsman V2 Analog',
    Manufacturer: 'Razer Inc.',
    Class: 'Keyboard',
    InstanceId: 'HID\\VID_1532&PID_0098&MI_00\\7&AAA&0&0000',
    Present: true,
    Source: 'Get-PnpDevice',
  },
  {
    FriendlyName: 'Razer Huntsman V2 Analog',
    Manufacturer: 'Razer Inc.',
    Class: 'Keyboard',
    InstanceId: 'HID\\VID_1532&PID_0098&MI_01\\7&BBB&0&0000',
    Present: true,
    Source: 'Get-PnpDevice',
  },
  {
    FriendlyName: 'HID-compliant consumer control device',
    Manufacturer: 'Microsoft',
    Class: 'HIDClass',
    InstanceId: 'HID\\VID_1532&PID_0098&MI_02\\7&CCC&0&0000',
    Present: true,
  },
  {
    Name: 'Razer DeathAdder Elite',
    Manufacturer: 'Razer',
    PNPClass: 'Mouse',
    PNPDeviceID: 'HID\\VID_1532&PID_005C\\MOUSE',
    Present: true,
    Source: 'Win32_PnPEntity',
  },
  {
    FriendlyName: 'Razer Firefly V2',
    Manufacturer: 'Razer',
    Class: 'HIDClass',
    InstanceId: 'HID\\VID_1532&PID_0C00\\PAD',
    Present: true,
  },
  {
    FriendlyName: 'Razer Kraken V3',
    Manufacturer: 'Razer',
    Class: 'AudioEndpoint',
    InstanceId: 'USB\\VID_1532&PID_0A00\\HEADSET',
    Present: true,
  },
  {
    FriendlyName: 'Razer Tartarus Pro',
    Manufacturer: 'Razer',
    Class: 'HIDClass',
    InstanceId: 'HID\\VID_1532&PID_0244\\KEYPAD',
    Present: true,
  },
  {
    FriendlyName: 'Razer Chroma Addressable RGB Controller',
    Manufacturer: 'Razer',
    Class: 'USB',
    InstanceId: 'USB\\VID_1532&PID_0F1F\\LINK',
    Present: true,
  },
  {
    FriendlyName: 'Razer Stream Controller',
    Manufacturer: 'Razer',
    Class: 'HIDClass',
    InstanceId: 'HID\\VID_1532&PID_0D06\\STREAM',
    Present: true,
  },
  {
    FriendlyName: 'Logitech G Pro Keyboard',
    Manufacturer: 'Logitech',
    Class: 'Keyboard',
    InstanceId: 'HID\\VID_046D&PID_C339\\LOGI',
    Present: true,
  },
])

const devices = parsePnpDevices(fixture)
assert.equal(devices.length, 7, 'duplicate interfaces, generic HID records, and non-Razer devices should be removed')
assert.deepEqual(devices.map((device) => device.name), [
  'Razer Chroma Addressable RGB Controller',
  'Razer DeathAdder Elite',
  'Razer Firefly V2',
  'Razer Huntsman V2 Analog',
  'Razer Kraken V3',
  'Razer Stream Controller',
  'Razer Tartarus Pro',
])
assert.deepEqual(Object.fromEntries(devices.map((device) => [device.name, device.type])), {
  'Razer Chroma Addressable RGB Controller': 'chromalink',
  'Razer DeathAdder Elite': 'mouse',
  'Razer Firefly V2': 'mousepad',
  'Razer Huntsman V2 Analog': 'keyboard',
  'Razer Kraken V3': 'headset',
  'Razer Stream Controller': 'unknown',
  'Razer Tartarus Pro': 'keypad',
})
assert.ok(devices.every((device) => Object.keys(device).sort().join(',') === 'id,name,pid,present,source,type,vid'))
assert.ok(devices.every((device) => device.vid === '1532' && device.present === true))
assert.equal(devices.find((device) => device.name === 'Razer Huntsman V2 Analog').pid, '0098')
assert.equal(parsePnpDevices(JSON.stringify(fixture ? JSON.parse(fixture)[0] : {})).length, 1, 'single-object JSON should parse')
assert.deepEqual(parsePnpDevices(''), [])

console.log(`Razer discovery parser test passed: ${devices.length} physical models across all supported classifications.`)

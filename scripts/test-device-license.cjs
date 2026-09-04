const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { verifyCode, hashDeviceId } = require('../desktop/device-license.cjs')

const keyPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WaveForge License Studio', 'license-private-key.pem')
if (!fs.existsSync(keyPath)) {
  throw new Error(`Private key not found: ${keyPath}. Initialize keys from the standalone WaveForge-License-Studio directory first.`)
}
const privateKey = fs.readFileSync(keyPath, 'utf8')
const deviceId = 'WF-00112233-4455-4667-8899-AABBCCDDEEFF'
const otherDeviceId = 'WF-FFEEDDCC-BBAA-4998-8877-665544332211'

function makeCode(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    v: 1,
    deviceHash: hashDeviceId(deviceId),
    feature: 'supporter',
    label: 'Supporter',
    issuedAt: now,
    expiresAt: null,
    note: 'automated test',
    nonce: crypto.randomBytes(12).toString('hex'),
    ...overrides,
  }
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = crypto.sign(null, payloadBuffer, privateKey)
  return `WF1.${payloadBuffer.toString('base64url')}.${signature.toString('base64url')}`
}

function rejects(fn, pattern) {
  assert.throws(fn, pattern)
}

const valid = makeCode()
assert.equal(verifyCode(valid, deviceId).feature, 'supporter')
rejects(() => verifyCode(valid, otherDeviceId), /current device|\u5f53\u524d\u8bbe\u5907|\u4e0d\u5c5e\u4e8e/)

const parts = valid.split('.')
const tamperedPayload = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].endsWith('A') ? 'B' : 'A'}.${parts[2]}`
rejects(() => verifyCode(tamperedPayload, deviceId), /signature|\u7b7e\u540d/)
rejects(() => verifyCode('WF1.***.***', deviceId), /format|\u683c\u5f0f/)

const now = Math.floor(Date.now() / 1000)
rejects(() => verifyCode(makeCode({ issuedAt: now - 120, expiresAt: now - 60 }), deviceId), /expired|\u8fc7\u671f/)
rejects(() => verifyCode(makeCode({ issuedAt: now + 600 }), deviceId), /issued|\u7b7e\u53d1/)
rejects(() => verifyCode(makeCode({ feature: 'bad feature' }), deviceId), /feature|\u529f\u80fd/)

console.log('Device license tests passed.')

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { LICENSE_PUBLIC_KEY } = require('./license-public-key.cjs')

const REGISTRY_KEY = 'HKCU\\Software\\WaveForge'
const DEVICE_VALUE = 'DeviceId'
const LEGACY_CODES_VALUE = 'RedeemedCodes'
const DEVICE_ID_PATTERN = /^WF-[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
const CODE_PREFIX = 'WF1'
const MAX_CODE_LENGTH = 4096

function getRegExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
}

function readRegistryValue(name) {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync(getRegExe(), ['QUERY', REGISTRY_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = output.split(/\r?\n/).find(value => value.includes(name) && /REG_\w+/.test(value))
    const match = line && line.match(/\s+REG_\w+\s+(.*)$/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

function writeRegistryValue(name, value) {
  if (process.platform !== 'win32') return false
  execFileSync(getRegExe(), ['ADD', REGISTRY_KEY, '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  return true
}

function fallbackPath(app) {
  return path.join(app.getPath('userData'), 'device-license.json')
}

function readFallback(app) {
  try {
    return JSON.parse(fs.readFileSync(fallbackPath(app), 'utf8'))
  } catch {
    return {}
  }
}

function writeFallback(app, partial) {
  const filePath = fallbackPath(app)
  const next = { ...readFallback(app), ...partial }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

function normalizeDeviceId(value) {
  return String(value || '').trim().toUpperCase()
}

function createDeviceId() {
  return `WF-${crypto.randomUUID().toUpperCase()}`
}

function getOrCreateDeviceId(app) {
  const registryValue = normalizeDeviceId(readRegistryValue(DEVICE_VALUE))
  if (DEVICE_ID_PATTERN.test(registryValue)) {
    return { deviceId: registryValue, storage: 'registry' }
  }

  const fallbackValue = normalizeDeviceId(readFallback(app).deviceId)
  const deviceId = DEVICE_ID_PATTERN.test(fallbackValue) ? fallbackValue : createDeviceId()

  try {
    if (writeRegistryValue(DEVICE_VALUE, deviceId)) return { deviceId, storage: 'registry' }
  } catch (error) {
    console.warn('[DeviceLicense] 无法写入 HKCU 注册表，改用应用数据目录:', error.message)
  }

  writeFallback(app, { deviceId })
  return { deviceId, storage: 'file' }
}

function parseStoredCodeList(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.filter(code => typeof code === 'string') : []
  } catch {
    return []
  }
}

function readStoredCodes(app) {
  // Early development builds stored codes in the registry. Read that value only
  // for migration, while all new redemption records stay in Electron userData.
  const fileCodes = parseStoredCodeList(readFallback(app).redeemedCodes)
  const legacyCodes = parseStoredCodeList(readRegistryValue(LEGACY_CODES_VALUE))
  return Array.from(new Set([...legacyCodes, ...fileCodes])).slice(-50)
}

function writeStoredCodes(app, codes) {
  writeFallback(app, { redeemedCodes: Array.from(new Set(codes)).slice(-50) })
  return 'file'
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('测试码格式不正确')
  }
  return Buffer.from(value, 'base64url')
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(normalizeDeviceId(deviceId), 'utf8').digest('hex')
}

function verifyCode(code, deviceId) {
  const normalized = String(code || '').trim()
  if (!normalized || normalized.length > MAX_CODE_LENGTH) throw new Error('测试码为空或长度不正确')
  const parts = normalized.split('.')
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) throw new Error('测试码格式不正确')

  const payloadBuffer = decodeBase64Url(parts[1])
  const signature = decodeBase64Url(parts[2])
  if (!payloadBuffer.length || payloadBuffer.length > 2048 || signature.length !== 64) throw new Error('测试码格式不正确')
  const verified = crypto.verify(null, payloadBuffer, LICENSE_PUBLIC_KEY, signature)
  if (!verified) throw new Error('测试码签名无效')

  let payload
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'))
  } catch {
    throw new Error('测试码内容损坏')
  }

  if (payload?.v !== 1 || typeof payload.feature !== 'string' || !payload.feature.trim()) {
    throw new Error('测试码版本或功能信息无效')
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(payload.feature)) throw new Error('测试码功能标识无效')
  if (payload.deviceHash !== hashDeviceId(deviceId)) throw new Error('此测试码不属于当前设备')

  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(payload.issuedAt) || payload.issuedAt <= 0 || payload.issuedAt > now + 300) throw new Error('测试码签发时间无效')
  if (payload.expiresAt != null && (!Number.isInteger(payload.expiresAt) || payload.expiresAt <= payload.issuedAt || payload.expiresAt <= now)) {
    throw new Error('测试码已过期')
  }

  return {
    feature: payload.feature,
    label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim().slice(0, 80) : payload.feature,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt ?? null,
    note: typeof payload.note === 'string' ? payload.note.slice(0, 160) : '',
    code: normalized,
  }
}

function collectGrants(app, deviceId) {
  const unique = new Map()
  for (const code of readStoredCodes(app)) {
    try {
      const grant = verifyCode(code, deviceId)
      const previous = unique.get(grant.feature)
      if (!previous || (grant.expiresAt || Number.MAX_SAFE_INTEGER) > (previous.expiresAt || Number.MAX_SAFE_INTEGER)) {
        unique.set(grant.feature, grant)
      }
    } catch {}
  }
  return Array.from(unique.values()).map(({ code, ...grant }) => grant)
}

function getState(app) {
  const identity = getOrCreateDeviceId(app)
  return { ...identity, grants: collectGrants(app, identity.deviceId) }
}

function redeem(app, code) {
  const identity = getOrCreateDeviceId(app)
  const grant = verifyCode(code, identity.deviceId)
  const codes = readStoredCodes(app)
  if (!codes.includes(grant.code)) codes.push(grant.code)
  const storage = writeStoredCodes(app, codes)
  const { code: _code, ...publicGrant } = grant
  return {
    success: true,
    message: `已解锁：${publicGrant.label}`,
    storage,
    grant: publicGrant,
    grants: collectGrants(app, identity.deviceId),
  }
}

function deleteRegistryValue(name) {
  if (process.platform !== 'win32') return
  try {
    execFileSync(getRegExe(), ['DELETE', REGISTRY_KEY, '/v', name, '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // 值不存在时忽略
  }
}

/**
 * 删除设备授权相关全部本地数据（不可逆）：
 * - 注册表：DeviceId（识别码）与 RedeemedCodes（历史测试码，旧版存储）
 * - 应用数据目录：device-license.json（兜底文件，含识别码与已兑换测试码）
 * 下次调用 getState 时会生成全新的设备标识，旧测试码因设备绑定将全部失效。
 */
function resetDeviceLicense(app) {
  const hadRegistry = readRegistryValue(DEVICE_VALUE) !== null || readRegistryValue(LEGACY_CODES_VALUE) !== null
  deleteRegistryValue(DEVICE_VALUE)
  deleteRegistryValue(LEGACY_CODES_VALUE)

  const filePath = fallbackPath(app)
  const hadFile = fs.existsSync(filePath)
  if (hadFile) {
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      console.warn('[DeviceLicense] Failed to remove fallback file:', error.message)
    }
  }
  return { success: true, removed: { registry: hadRegistry, file: hadFile } }
}

module.exports = {
  REGISTRY_KEY,
  getState,
  getOrCreateDeviceId,
  redeem,
  resetDeviceLicense,
  verifyCode,
  hashDeviceId,
}

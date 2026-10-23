'use strict'

/**
 * 设备指纹 v2：硬件绑定的稳定设备身份。
 *
 * 目标（对应旧机制的缺陷）：
 *  - 旧版 DeviceId = 随机 UUID，存 HKCU 注册表 + userData 文件。卸载勾选"清理注册表"
 *    或重装系统后重新生成 → 兑换码随之失效，且与硬件无关，复制文件即可克隆身份。
 *  - 新版 DeviceId = 硬件指纹派生（确定性），同一台机器无论注册表是否被清理、
 *    应用是否重装、系统是否重置（保留磁盘），都会得到同一个 ID。
 *
 * 指纹因子（多因子 + 加权，容忍单点变化）：
 *  - 主板序列号（weight 3）      Win32_BaseBoard.SerialNumber
 *  - BIOS 序号（weight 2）       Win32_BIOS.SerialNumber
 *  - 系统盘序列号（weight 2）    Win32_DiskDrive.SerialNumber
 *  - 主板型号（weight 1）        Win32_BaseBoard.Product
 *
 * 容忍策略：总权重 8，快照比对时剩余匹配权重 ≥5 即视为同一台设备并刷新快照
 * （换硬盘/更新 BIOS 等单点变化不换 ID）；权重不足或首次运行时按纯硬件因子
 * 确定性重算——快照全丢也能得到同一个 ID，这是与随机 UUID 的本质区别。
 *
 * 隐私边界：只取序列号类只读字段的哈希，不采集用户数据；指纹只服务于本地
 * 兑换码绑定，不上传任何服务器。
 */

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const FINGERPRINT_VERSION = 2
const MIN_WEIGHT_TO_KEEP_ID = 5
const REGISTRY_KEY = 'HKCU\\Software\\WaveForge'
const SNAPSHOT_VALUE = 'DeviceFingerprint'

const CIM_FIELDS = Object.freeze([
  { key: 'baseboardSerial', weight: 3, wmi: 'Win32_BaseBoard', prop: 'SerialNumber' },
  { key: 'biosSerial', weight: 2, wmi: 'Win32_BIOS', prop: 'SerialNumber' },
  { key: 'systemDiskSerial', weight: 2, wmi: 'Win32_DiskDrive', prop: 'SerialNumber' },
  { key: 'baseboardProduct', weight: 1, wmi: 'Win32_BaseBoard', prop: 'Product' },
])

// 测试可替换的 CIM 读取器（__setCimReader）。
let cimReader = realReadCimField

function getRegExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
}

function getPowershellExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function normalize(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/(TO BE FILLED BY [A-Z. ]+|DEFAULT STRING|SYSTEM SERIAL NUMBER|NONE|N\/A)/g, '')
    .replace(/^0{2,}$/, '')
}

function realReadCimField(wmiClass, prop) {
  if (process.platform !== 'win32') return ''
  try {
    const output = execFileSync(
      getPowershellExe(),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance ${wmiClass} | Select-Object -First 1).${prop}`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return normalize(output)
  } catch {
    return ''
  }
}

function collectHardwareFactors() {
  // 同一 WMI 类的结果按类缓存，避免重复起 PowerShell 进程。
  const classCache = new Map()
  const factors = {}
  for (const field of CIM_FIELDS) {
    if (!classCache.has(field.wmi)) classCache.set(field.wmi, cimReader(field.wmi, field.prop))
    factors[field.key] = classCache.get(field.wmi)
  }
  return factors
}

function weightOf(key) {
  const field = CIM_FIELDS.find((item) => item.key === key)
  return field ? field.weight : 0
}

function factorsWeightSum(factorMap, keys) {
  return keys.reduce((sum, key) => sum + (factorMap[key] ? weightOf(key) : 0), 0)
}

/** 由因子表确定性导出 UUID v4 形态的设备 ID（DEVICE_ID_PATTERN 兼容）。 */
function fingerprintFrom(factorMap) {
  const present = CIM_FIELDS.filter((field) => factorMap[field.key]).map((field) => field.key)
  if (factorsWeightSum(factorMap, present) < MIN_WEIGHT_TO_KEEP_ID) return null
  const canonical = CIM_FIELDS.map((field) => `${field.key}=${factorMap[field.key] || '-'}`).join('|')
  const seed = crypto.createHash('sha256').update(`WF-FP-v${FINGERPRINT_VERSION}:${canonical}`, 'utf8').digest('hex').toUpperCase()
  return `WF-${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-${'89AB'[parseInt(seed[16], 16) % 4]}${seed.slice(17, 20)}-${seed.slice(20, 32)}`
}

function readRegistryValueSafe(name) {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync(getRegExe(), ['QUERY', REGISTRY_KEY, '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = output.split(/\r?\n/).find((value) => value.includes(name) && /REG_\w+/.test(value))
    const match = line && line.match(/\s+REG_\w+\s+(.*)$/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

function writeRegistryValueSafe(name, value) {
  if (process.platform !== 'win32') return false
  try {
    execFileSync(getRegExe(), ['ADD', REGISTRY_KEY, '/v', name, '/t', 'REG_SZ', '/d', String(value), '/f'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function deleteRegistryValueSafe(name) {
  if (process.platform !== 'win32') return
  try {
    execFileSync(getRegExe(), ['DELETE', REGISTRY_KEY, '/v', name, '/f'], {
      windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { /* 值不存在时忽略 */ }
}

function snapshotPath(app) {
  return path.join(app.getPath('userData'), 'device-fingerprint.json')
}

function readSnapshotFile(app) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(app), 'utf8'))
  } catch {
    return null
  }
}

function writeSnapshotFile(app, payload) {
  try {
    const file = snapshotPath(app)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporaryPath = `${file}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(temporaryPath, file)
    return true
  } catch {
    return false
  }
}

function decodeRegistrySnapshot(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    return parsed && parsed.deviceId && parsed.factors ? parsed : null
  } catch {
    return null
  }
}

function persistSnapshots(app, payload, preferRegistry) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const regOk = writeRegistryValueSafe(SNAPSHOT_VALUE, encoded)
  const fileOk = writeSnapshotFile(app, payload)
  return preferRegistry ? regOk : (regOk || fileOk)
}

/**
 * 解析当前设备身份：优先信任快照（注册表 > 文件），与实时硬件因子比对，
 * 匹配权重 ≥5 即沿用快照 ID 并刷新快照（容忍硬件单点变化）；否则确定性重算。
 * 永不抛错——最坏情况退化为随机 UUID（等同旧行为）。
 */
function resolveHardwareIdentity(app) {
  try {
    const registryRaw = readRegistryValueSafe(SNAPSHOT_VALUE)
    const registrySnapshot = decodeRegistrySnapshot(registryRaw)
    const fileSnapshot = readSnapshotFile(app)
    const snapshot = registrySnapshot || (fileSnapshot && fileSnapshot.deviceId ? fileSnapshot : null)
    const current = collectHardwareFactors()

    if (snapshot && snapshot.factors) {
      const matchedKeys = CIM_FIELDS
        .filter((field) => snapshot.factors[field.key] && snapshot.factors[field.key] === current[field.key])
        .map((field) => field.key)
      const matchedWeight = factorsWeightSum(current, matchedKeys)
      if (matchedWeight >= MIN_WEIGHT_TO_KEEP_ID) {
        // 刷新快照：吸收已变化的因子（例如换系统盘后以其余因子补位续命）。
        const merged = {
          deviceId: snapshot.deviceId,
          factors: { ...snapshot.factors, ...Object.fromEntries(Object.entries(current).filter(([, value]) => value)) },
          version: FINGERPRINT_VERSION,
        }
        persistSnapshots(app, merged, Boolean(registrySnapshot))
        return { deviceId: snapshot.deviceId, storage: registrySnapshot ? 'registry' : 'file', matchedWeight, migrated: false }
      }
    }

    const deviceId = fingerprintFrom(current)
    if (deviceId) {
      const payload = { deviceId, factors: current, version: FINGERPRINT_VERSION }
      const persisted = persistSnapshots(app, payload, Boolean(registrySnapshot))
      return { deviceId, storage: persisted ? 'registry' : 'file', matchedWeight: weightOf('baseboardSerial') + weightOf('biosSerial'), migrated: Boolean(snapshot) }
    }
  } catch { /* 落到兜底 */ }

  // 非 Windows / 全部因子为空 / 异常：退回随机 UUID（等同旧行为，不阻断授权）。
  const { createDeviceIdLegacy } = require('./device-license.cjs')
  return { deviceId: createDeviceIdLegacy(), storage: 'random', matchedWeight: 0, migrated: false }
}

/** 清理指纹快照（resetDeviceLicense 调用）。注意：确定性设计下清除后重算结果不变。 */
function clearFingerprintSnapshots(app) {
  deleteRegistryValueSafe(SNAPSHOT_VALUE)
  try { fs.rmSync(snapshotPath(app), { force: true }) } catch { }
}

module.exports = {
  FINGERPRINT_VERSION,
  MIN_WEIGHT_TO_KEEP_ID,
  CIM_FIELDS,
  collectHardwareFactors,
  fingerprintFrom,
  resolveHardwareIdentity,
  clearFingerprintSnapshots,
  normalize,
  readRegistrySnapshot: () => readRegistryValueSafe(SNAPSHOT_VALUE),
  __testHooks: {
    setCimReader: (reader) => { cimReader = reader },
    resetCimReader: () => { cimReader = realReadCimField },
    readRegistryValueSafe,
    writeRegistryValueSafe,
  },
}

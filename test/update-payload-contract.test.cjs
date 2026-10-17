'use strict'

// 更新载荷契约回归（2026-10-17 P0-1）：
// 渲染层传的是签名清单的包装载荷 { manifest }，主进程此前只认顶层 manifestSignature，
// 且热更下载误用 install 产物字段（spec.urls）→ 打包版在线更新 100% 失败。
// 这里用临时生成的 Ed25519 密钥对签一份与 publish-release.mjs 同构的清单，
// 走真实 setupUpdateIPC 的 IPC handler 验证解包 → 验签 → 产物提取全链路。

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const Module = require('module')

const { signedManifestForTest, PUBLIC_KEY_PEM } = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  // 与 desktop/update-manager.cjs stableStringify / publish-release.mjs stableStringifyJson 同构
  const stableStringify = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  const signManifest = (manifest) => {
    const { manifestSignature: _omitted, ...payload } = manifest
    return crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), privateKey).toString('base64')
  }
  return {
    signedManifestForTest: (overrides = {}) => {
      const manifest = {
        version: '9.9.9',
        notes: 'contract test',
        artifacts: {
          'win-x64': {
            urls: ['https://github.com/SoundFieldLab/WaveForge/releases/download/v9.9.9/WaveForge-Setup.exe'],
            sha256: 'a'.repeat(64),
          },
          'win-x64-hot': {
            urls: [
              'https://ghproxy.net/https://github.com/SoundFieldLab/WaveForge/releases/download/v9.9.9/hot.zip',
              'https://github.com/SoundFieldLab/WaveForge/releases/download/v9.9.9/hot.zip',
            ],
            sha256: 'b'.repeat(64),
          },
        },
        ...overrides,
      }
      manifest.manifestSignature = signManifest(manifest)
      return manifest
    },
    PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
})()

const originalLoad = Module._load
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name) => path.join(os.tmpdir(), 'waveforge-update-contract-test', name),
      },
      BrowserWindow: { getAllWindows: () => [] },
      net: { request: () => { throw new Error('network is not used by this test') } },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const manager = require('../desktop/update-manager.cjs')
Module._load = originalLoad

/** 最小 IPC 假件：走真实 setupUpdateIPC 注册逻辑，只替换 trust 校验与验签公钥 */
function createHarness() {
  const handlers = new Map()
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
  }
  const trustedSender = { __trusted: true }
  manager.setupUpdateIPC(ipcMain, () => null, (event) => event === trustedSender)
  const invoke = (channel, payload, event = trustedSender) => handlers.get(channel)(event, payload)
  return { invoke }
}

// IPC 全链路用测试密钥验签（进程退出时还原，避免影响同进程内其他测试文件）
const restorePublicKey = manager.setManifestPublicKeyForTest(PUBLIC_KEY_PEM)
process.on('exit', () => restorePublicKey())

test('signed manifest payload resolves to install + hot artifacts', () => {
  const manifest = signedManifestForTest()
  assert.equal(manager.verifyManifestSignatureWithKey(manifest, PUBLIC_KEY_PEM), true)
})

test('download-and-install unwraps { manifest } payload and uses the install artifact', async () => {
  const { invoke } = createHarness()
  const result = await invoke('update:download-and-install', { manifest: signedManifestForTest() })
  assert.match(String(result.error || ''), /下载|源|网络|sha256|HTTP/, `应进入下载阶段而不是载荷校验失败: ${JSON.stringify(result)}`)
  assert.doesNotMatch(String(result.error || ''), /manifestSignature|签名无效|缺少有效的地址/)
})

test('tampered manifest payloads are rejected in packaged mode', async () => {
  const { invoke } = createHarness()
  const manifest = signedManifestForTest()
  manifest.artifacts['win-x64-hot'].sha256 = 'c'.repeat(64) // 签名后篡改
  const tampered = await invoke('update:download-background', { manifest })
  assert.equal(tampered.success, false)
  assert.match(tampered.error, /签名无效/)

  const unsigned = await invoke('update:download-background', {
    manifest: { version: '9.9.9', artifacts: { 'win-x64-hot': { urls: ['https://github.com/SoundFieldLab/WaveForge/releases/download/v9.9.9/hot.zip'], sha256: 'b'.repeat(64) } } },
  })
  assert.equal(unsigned.success, false)
  assert.match(unsigned.error, /签名无效|manifestSignature/)

  const bare = await invoke('update:download-background', { urls: ['https://github.com/SoundFieldLab/WaveForge/releases/download/v9.9.9/hot.zip'], sha256: 'b'.repeat(64) })
  assert.equal(bare.success, false)
  assert.match(bare.error, /签名更新清单/)
})

test('untrusted senders are rejected regardless of payload', async () => {
  const { invoke } = createHarness()
  const result = await invoke('update:download-background', { manifest: signedManifestForTest() }, { __trusted: false })
  assert.equal(result.success, false)
  assert.match(result.error, /来源/)
})

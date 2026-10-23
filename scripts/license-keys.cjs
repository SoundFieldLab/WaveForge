#!/usr/bin/env node
/**
 * WaveForge License Studio 密钥管理工具。
 *
 * 背景：兑换码签名（desktop/device-license.cjs）与更新清单签名
 * （scripts/publish-release.mjs → desktop/update-manager.cjs）共用同一把
 * Ed25519 私钥，固定存放于 %APPDATA%\WaveForge License Studio\license-private-key.pem。
 * 私钥对应的公钥内嵌在 desktop/license-public-key.cjs 与
 * desktop/update-manifest-public-key.cjs，换钥必须同步替换。
 *
 * 子命令：
 *   init                     生成新密钥对（私钥缺失时；--force 覆盖已有）
 *   check                    校验现有私钥 + 与两个公钥文件的匹配关系
 *   export                   导出 CI secret 用的 PEM（stdout，--reveal 明文；默认带注释）
 *   rotate                   生成新钥对并就地改写两个公钥文件（旧兑换码即作废）
 *   sign-manifest <file>     用现有私钥签 update.json（publish-release 的独立复现）
 *
 * 环境变量：
 *   LICENSE_STUDIO_DIR       覆盖密钥目录（默认 %APPDATA%\WaveForge License Studio）
 *   LICENSE_PRIVATE_KEY      check/export 允许从环境变量读私钥（CI 场景）
 *
 * 用法示例：
 *   node scripts/license-keys.cjs init
 *   node scripts/license-keys.cjs check
 *   node scripts/license-keys.cjs export --for-ci
 *   node scripts/license-keys.cjs rotate
 */
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const PUBLIC_KEY_MODULE = path.join(PROJECT_ROOT, 'desktop', 'license-public-key.cjs')
const MANIFEST_KEY_MODULE = path.join(PROJECT_ROOT, 'desktop', 'update-manifest-public-key.cjs')

function defaultStudioDir() {
  const appData = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'WaveForge License Studio')
}

function studioDir() {
  return process.env.LICENSE_STUDIO_DIR ? path.resolve(process.env.LICENSE_STUDIO_DIR) : defaultStudioDir()
}

function privateKeyPath() {
  return path.join(studioDir(), 'license-private-key.pem')
}

function readPrivateKeyPem() {
  if (process.env.LICENSE_PRIVATE_KEY && !fs.existsSync(privateKeyPath())) {
    return Buffer.from(process.env.LICENSE_PRIVATE_KEY, 'base64').toString('utf8').trim() + '\n'
  }
  const pem = fs.readFileSync(privateKeyPath(), 'utf8')
  if (!pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error(`私钥文件不是 PEM PRIVATE KEY 格式：${privateKeyPath()}`)
  }
  return pem
}

function extractPublicKeyBlock(source) {
  // 两个公钥文件都是 `const XXX_PUBLIC_KEY = \`-----BEGIN PUBLIC KEY-----\n...-----END PUBLIC KEY-----\`` 形式。
  const match = source.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/)
  if (!match) throw new Error('公钥文件中未找到 PEM PUBLIC KEY 块')
  return match[0]
}

function fail(message, hint) {
  console.error(`✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(1)
}

// ── init ──

function cmdInit({ force }) {
  const target = privateKeyPath()
  if (fs.existsSync(target) && !force) {
    return fail('私钥已存在，拒绝覆盖（换钥请用 rotate，确认丢弃旧钥请加 --force）', target)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.mkdirSync(studioDir(), { recursive: true })
  fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 })
  console.log(`✅ 已生成新私钥：${target}`)
  console.log(`   公钥（PEM，用于核对两个公钥文件）：`)
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).trim())
  console.log(`   下一步：node scripts/license-keys.cjs check`)
  // 0600 在 Windows 上由 NTFS 权限接管，设置不报错即视为尽力而为。
}

// ── check ──

function cmdCheck() {
  let privateKeyPem
  try {
    privateKeyPem = readPrivateKeyPem()
  } catch (error) {
    return fail('私钥不可读', `${privateKeyPath()}；若在 CI/无钥环境，请设置 LICENSE_PRIVATE_KEY（base64）或 LICENSE_STUDIO_DIR。${error.message}`)
  }
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem)
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`密钥类型为 ${privateKey.asymmetricKeyType}，期望 ed25519`)
  } catch (error) {
    return fail('私钥文件无效', error.message)
  }
  const derivedPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim()

  const report = [{ file: privateKeyPath(), ok: true, detail: `ed25519, ${privateKeyPem.length} bytes` }]
  for (const modulePath of [PUBLIC_KEY_MODULE, MANIFEST_KEY_MODULE]) {
    const source = fs.readFileSync(modulePath, 'utf8')
    const embedded = extractPublicKeyBlock(source).trim()
    const match = embedded === derivedPublic
    report.push({
      file: path.relative(PROJECT_ROOT, modulePath),
      ok: match,
      detail: match ? '与私钥匹配' : '与私钥不匹配（换钥后未同步，或私钥已轮换）',
    })
  }

  console.log('License Studio 密钥状态：')
  for (const item of report) {
    console.log(` ${item.ok ? '✓' : '✗'} ${item.file} — ${item.detail}`)
  }
  const allMatch = report.every((item) => item.ok)
  if (!allMatch) {
    console.log('\n修复方式：')
    console.log('  - 私钥是对的、公钥文件旧了 → node scripts/license-keys.cjs rotate（会改写公钥文件）')
    console.log('  - 公钥是对的、私钥丢了 → 从备份恢复私钥到上面列出的路径')
    process.exit(1)
  }
  console.log('\n✅ 全部匹配：兑换码签名与清单签名可用同一把私钥。')
}

// ── export ──

function cmdExport({ forCi }) {
  let pem
  try {
    pem = readPrivateKeyPem().trim()
  } catch (error) {
    return fail('私钥不可读', error.message)
  }
  if (forCi) {
    // CI secret 是 base64（release.yml 用 printf '%s\n' 还原）。
    console.log(Buffer.from(pem, 'utf8').toString('base64'))
  } else {
    console.log('# 以下为 CI secret LICENSE_PRIVATE_KEY 的 base64 值（gh secret set LICENSE_PRIVATE_KEY < 上面这段）：')
    console.log(Buffer.from(pem, 'utf8').toString('base64'))
  }
}

// ── rotate ──

function cmdRotate({ force }) {
  const target = privateKeyPath()
  if (fs.existsSync(target) && !force) {
    return fail('已存在旧私钥。轮换会让所有已发兑换码作废；确认请加 --force')
  }
  console.log('警告：轮换后旧私钥签发的兑换码全部失效，用户需重新兑换。')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).trim()
  fs.mkdirSync(studioDir(), { recursive: true })
  fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 })

  // 公钥文件保持原有代码结构，仅替换 PEM 块本身（避免重排格式引入 diff 噪音）。
  let replaced = 0
  for (const modulePath of [PUBLIC_KEY_MODULE, MANIFEST_KEY_MODULE]) {
    const source = fs.readFileSync(modulePath, 'utf8')
    if (!source.includes('-----BEGIN PUBLIC KEY-----')) {
      console.warn(`⚠️ 跳过（未找到公钥块）：${modulePath}`)
      continue
    }
    const updated = source.replace(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/, publicPem)
    fs.writeFileSync(modulePath, updated, 'utf8')
    replaced += 1
    console.log(`✅ 已更新公钥：${path.relative(PROJECT_ROOT, modulePath)}`)
  }
  console.log(`✅ 新私钥已写入：${target}`)
  console.log(`   共替换 ${replaced} 个公钥文件。请运行 node scripts/license-keys.cjs check 复核，`)
  console.log('   然后跑 npm run test:license 与 npm run test:desktop 确认。')
  console.log('   注意：CI secrets（LICENSE_PRIVATE_KEY）需同步为新值的 base64（export --for-ci）。')
}

// ── sign-manifest ──

function cmdSignManifest(file) {
  const manifestPath = path.resolve(file)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const privateKeyPem = readPrivateKeyPem()
  // 与 publish-release.mjs 的 stableStringifyJson 保持同构：键排序递归序列化。
  // 客户端 verifyManifestSignature 以同样的规范化字节验签。
  const payload = { ...manifest }
  delete payload.manifestSignature
  const signature = crypto.sign(null, Buffer.from(stableStringify(payload), 'utf8'), privateKeyPem)
  manifest.manifestSignature = signature.toString('base64')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`✅ 已签清单：${manifestPath}`)
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

// ── issue（开发者验证门 → 签发兑换码） ──

// 兑换码签发是私钥最高价值操作，因此设置 GitHub 开发者验证门：
// 调用者必须能证明自己是 developers/roster.json 里登记且签名认可的仓库开发者。
// 证明方式（与 App 内 developer-auth 同一信任根）：
//   1. roster.json 最新提交必须 GPG/SSH 签名且签名者为花名册内用户；
//   2. 本机 git 环境 == 开发者本人（GPG 签名 tag 由本地私钥产生，公钥已上传 GitHub）；
//   3. 提供的 GitHub token 对应账号在花名册内，且（有 token 时）仍是仓库协作者。
async function cmdIssue(rest, flags) {
  const args = {}
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--feature') args.feature = rest[++i]
    else if (rest[i] === '--tier') args.tier = rest[++i]
    else if (rest[i] === '--device') args.deviceId = rest[++i]
    else if (rest[i] === '--label') args.label = rest[++i]
    else if (rest[i] === '--expires-days') args.expiresDays = Number(rest[++i])
    else if (rest[i] === '--note') args.note = rest[++i]
    else if (rest[i] === '--device-list') args.deviceList = rest[++i]
  }
  if (!args.deviceId && !args.deviceList) return fail('需要 --device <设备ID> 或 --device-list <文件（每行一个设备ID）>')

  const { loadRosterConfig, extractCommitGithubLogin } = require('./developer-auth.cjs')
  const config = loadRosterConfig()
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  const https = require('node:https')
  const apiGet = (urlPath) => new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com', path: urlPath,
      headers: { 'User-Agent': 'WaveForge-LicenseKeys', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 15000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })

  // 门 1：roster 最新提交的签名与签名者
  const head = await apiGet(`/repos/${config.repository}/commits?sha=${encodeURIComponent(config.branch)}&path=${encodeURIComponent(config.rosterPath)}&per_page=1`)
  if (head.status !== 200) return fail(`拉取 roster 提交失败：HTTP ${head.status}（需要能访问 api.github.com）`)
  const commit = JSON.parse(head.body)[0]
  if (!commit) return fail(`roster 尚无提交：${config.rosterPath} 未推送到 ${config.branch}`)
  if (!(commit.verification && commit.verification.verified)) {
    return fail('roster 最新提交未通过 GitHub 签名校验（verification.verified=false）。请协作者用 GPG/SSH 签名提交维护花名册。')
  }
  const signerLogin = extractCommitGithubLogin(commit)
  if (!signerLogin || !config.developers.includes(signerLogin)) {
    return fail(`签名提交者 ${signerLogin || '(未知)'} 不在花名册：${config.developers.join(', ') || '(空)'}`)
  }

  // 门 2：本机身份（有 token 时校验 token 账号；无 token 时要求签名者==本机 git 用户名作弱校验）
  let localLogin = ''
  if (token) {
    const me = await apiGet('/user')
    if (me.status === 200) localLogin = (JSON.parse(me.body).login || '').toLowerCase()
    else return fail(`GitHub token 无效（HTTP ${me.status}）`)
    if (!config.developers.includes(localLogin)) return fail(`token 账号 ${localLogin} 不在花名册`)
    if (localLogin !== signerLogin) return fail(`token 账号 ${localLogin} 与 roster 签名者 ${signerLogin} 不一致：花名册最近一次修改不是你本人提交？`)
    const collab = await apiGet(`/repos/${config.repository}/collaborators/${encodeURIComponent(localLogin)}`)
    if (collab.status !== 204 && collab.status !== 200) return fail(`${localLogin} 已不是仓库协作者（HTTP ${collab.status}），签发被拒`)
  } else {
    localLogin = require('node:child_process').execSync('git config user.name', { encoding: 'utf8' }).trim().toLowerCase()
    if (localLogin !== signerLogin) {
      return fail(`无 token 时要求本机 git user.name(${localLogin}) == roster 签名者(${signerLogin})，或提供 GH_TOKEN 走强校验`)
    }
  }
  console.log(`✅ 开发者验证通过：${localLogin}（roster HEAD ${commit.sha.slice(0, 10)}，签名者 ${signerLogin}）`)

  // 签发（复用 device-license 的码格式与 deviceHash 口径，保证验证侧可直接验）。
  const deviceIds = args.deviceList
    ? fs.readFileSync(args.deviceList, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [args.deviceId]
  const { hashDeviceId, CODE_TIERS } = require('../desktop/device-license.cjs')
  const tier = args.tier || 'limited'
  if (!CODE_TIERS.includes(tier)) return fail(`未知 tier：${tier}（可用：${CODE_TIERS.join(', ')}）`)
  // 限制级必须指定 feature；universal 忽略 feature（覆盖一切）；test 通道 feature 固定。
  if (tier === 'limited' && !args.feature) return fail('限制级（limited）必须指定 --feature <功能标识>')
  if (tier === 'test' && args.feature && args.feature !== 'update.test-channel') {
    console.warn('⚠️ test 级兑换码的 feature 固定为 update.test-channel，忽略 --feature')
  }
  const featureValue = tier === 'test' ? 'update.test-channel' : (args.feature || 'universal')
  const privateKey = readPrivateKeyPem()
  const now = Math.floor(Date.now() / 1000)
  const codes = []
  for (const deviceId of deviceIds) {
    const payload = {
      v: 1,
      deviceHash: hashDeviceId(deviceId),
      tier,
      feature: featureValue,
      label: args.label || (tier === 'universal' ? '完全开放' : tier === 'test' ? '测试通道' : args.feature),
      issuedAt: now,
      expiresAt: args.expiresDays ? now + args.expiresDays * 86400 : null,
      note: args.note || `issued by ${localLogin}`,
      nonce: crypto.randomBytes(12).toString('hex'),
    }
    const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
    const signature = crypto.sign(null, payloadBuffer, privateKey)
    codes.push({ deviceId, code: `WF1.${payloadBuffer.toString('base64url')}.${signature.toString('base64url')}` })
  }
  for (const item of codes) {
    console.log(`\n设备 ${item.deviceId}\n  兑换码: ${item.code}`)
  }
  console.log(`\n共 ${codes.length} 枚（tier=${tier}）。用户在 设置 → 授权 兑换后生效。`)
}

// ── 入口 ──

const USAGE = `用法：node scripts/license-keys.cjs <init|check|export|rotate|sign-manifest|issue> [参数]

  init                    生成新密钥对（已有私钥时需 --force）
  check                   校验私钥与两个公钥文件的匹配关系
  export [--for-ci]       导出 CI secret 用的 base64（LICENSE_PRIVATE_KEY）
  rotate [--force]        轮换密钥对并就地改写两个公钥文件（旧兑换码作废）
  sign-manifest <file>    用现有私钥签 update.json
  issue                   签发兑换码（需通过 GitHub 开发者验证门）：
                          --feature <id> (--device <设备ID> | --device-list <文件>)
                          [--label <文案>] [--expires-days <N>] [--note <备注>]

环境变量：LICENSE_STUDIO_DIR 覆盖密钥目录；LICENSE_PRIVATE_KEY（base64）供无钥环境
check/export；GH_TOKEN / GITHUB_TOKEN 供 issue 的开发者强校验（协作者身份）。`

const [command, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith('--')))
switch (command) {
  case 'init':
    cmdInit({ force: flags.has('--force') })
    break
  case 'check':
    cmdCheck()
    break
  case 'export':
    cmdExport({ forCi: flags.has('--for-ci') })
    break
  case 'rotate':
    cmdRotate({ force: flags.has('--force') })
    break
  case 'sign-manifest':
    if (!rest[0]) fail('用法：license-keys.cjs sign-manifest <update.json 路径>')
    cmdSignManifest(rest[0])
    break
  case 'issue':
    cmdIssue(rest, flags).catch((error) => fail(error?.message || String(error)))
    break
  default:
    console.log(USAGE)
    process.exit(command ? 1 : 0)
}

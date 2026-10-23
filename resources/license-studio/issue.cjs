#!/usr/bin/env node
'use strict'

/**
 * WaveForge 兑换码签发服务（仅开发者机构内使用）。
 *
 * 安全模型：
 *  - 私钥存放在开发者机的 %APPDATA%\WaveForge License Studio\license-private-key.pem，
 *    **永远不进入 App 包**。本脚本从该路径读取私钥。
 *  - 每次签发都走 GitHub 开发者验证门（developers/roster.json 签名提交 +
 *    协作者强校验，见 desktop/developer-auth.cjs 的信任链描述）。
 *  - App 内管理面板通过 IPC 调起本脚本（main.cjs license-studio:issue），
 *    App 自身拿不到私钥；未安装私钥/未通过验证的机器上本脚本直接拒绝。
 *  - 本目录随 extraResources 进入安装包，但没有私钥的机器上它是哑弹；
 *    泄露脚本本身不泄露任何签发能力（逆向者看到的只是"要私钥+要GitHub验证"的门）。
 *
 * 协议（stdin/stdout JSON）：
 *   输入：{ deviceId, feature, tier, label, expiresDays, note, githubToken }
 *   输出：{ ok: true, code, tier, feature, deviceId } 或 { ok: false, error }
 */

const path = require('path')
const projectRoot = path.resolve(__dirname, '..', '..')

async function main() {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input || '{}')

  const required = ['deviceId', 'tier']
  for (const field of required) {
    if (!request[field]) throw new Error(`缺少参数：${field}`)
  }

  // 复用仓库内的验签/门禁逻辑（打包版此目录结构保持 _up/desktop 可达）。
  const { verifyCode, hashDeviceId, CODE_TIERS } = require(path.join(projectRoot, 'desktop', 'device-license.cjs'))
  void verifyCode
  const crypto = require('crypto')
  const fs = require('fs')
  const os = require('os')

  if (!CODE_TIERS.includes(request.tier)) throw new Error(`未知 tier：${request.tier}`)
  if (request.tier === 'limited' && !request.feature) throw new Error('限制级兑换码必须指定 feature')

  // ── GitHub 开发者验证门 ──
  const token = request.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  const https = require('https')
  const apiGet = (urlPath) => new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: urlPath,
      headers: {
        'User-Agent': 'WaveForge-LicenseStudio',
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 15000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })

  const rosterPath = path.join(projectRoot, 'developers', 'roster.json')
  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'))
  const head = await apiGet(`/repos/${roster.repository}/commits?sha=${encodeURIComponent(roster.branch)}&path=${encodeURIComponent(roster.path)}&per_page=1`)
  if (head.status !== 200) throw new Error(`GitHub API 不可达（HTTP ${head.status}），无法验证开发者身份`)
  const commit = JSON.parse(head.body)[0]
  if (!commit) throw new Error('花名册尚无签名提交')
  const verification = commit.verification || (commit.commit && commit.commit.verification) || {}
  if (!(verification.verified)) throw new Error('花名册最新提交未通过 GitHub 签名校验')

  // 签名者解析（与 desktop/developer-auth.cjs 同规则）
  const commitLogin = ((commit.author && commit.author.login)
    || String((commit.commit.author.email || '').match(/^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[2] || '')).toLowerCase()
  const developers = (roster.developers || []).map((value) => String(value).toLowerCase())
  if (!commitLogin || !developers.includes(commitLogin)) throw new Error(`签名提交者 ${commitLogin || '(未知)'} 不在花名册`)

  if (!token) throw new Error('需要 GitHub token（GH_TOKEN 环境变量或请求参数 githubToken）走协作者强校验')
  const me = await apiGet('/user')
  if (me.status !== 200) throw new Error(`GitHub token 无效（HTTP ${me.status}）`)
  const login = (JSON.parse(me.body).login || '').toLowerCase()
  if (login !== commitLogin) throw new Error(`token 账号 ${login} 与花名册签名者 ${commitLogin} 不一致`)
  const collab = await apiGet(`repos/${roster.repository}/collaborators/${encodeURIComponent(login)}`)
  if (collab.status !== 204 && collab.status !== 200) throw new Error(`${login} 已不是仓库协作者，签发被拒`)

  // ── 私钥（仅在开发者机的 %APPDATA%） ──
  const keyPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WaveForge License Studio', 'license-private-key.pem')
  if (!fs.existsSync(keyPath)) throw new Error('本机未初始化 License Studio 私钥（scripts/license-keys.cjs init）')
  const privateKey = fs.readFileSync(keyPath, 'utf8')

  // ── 签发 ──
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    v: 1,
    deviceHash: hashDeviceId(String(request.deviceId)),
    tier: request.tier,
    feature: request.tier === 'test' ? 'update.test-channel' : (request.tier === 'universal' ? 'universal' : String(request.feature)),
    label: String(request.label || (request.tier === 'universal' ? '完全开放' : request.tier === 'test' ? '测试通道' : request.feature)),
    issuedAt: now,
    expiresAt: request.expiresDays ? now + Number(request.expiresDays) * 86400 : null,
    note: String(request.note || `issued by ${login}`),
    nonce: crypto.randomBytes(12).toString('hex'),
  }
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = crypto.sign(null, payloadBuffer, privateKey)
  const code = `WF1.${payloadBuffer.toString('base64url')}.${signature.toString('base64url')}`

  process.stdout.write(JSON.stringify({
    ok: true,
    code,
    tier: payload.tier,
    feature: payload.feature,
    deviceId: request.deviceId,
    issuedBy: login,
    rosterHead: commit.sha.slice(0, 10),
  }))
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error?.message || String(error) }))
  process.exit(0)
})

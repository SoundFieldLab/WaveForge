'use strict'

/**
 * 开发者身份验证（GitHub 签名提交方案）。
 *
 * 信任根 = GitHub 仓库 `SoundFieldLab/WaveForge` 的 `developers/roster.json`。
 * 验证链条（全部可离线复核，无长期凭据）：
 *
 *   1. 取 roster.json 所在路径的最新提交（GET /repos/{repo}/commits?path=...）。
 *   2. 该提交必须 GPG/SSH 签名（verification.verified === true，GitHub 已用其
 *      已知密钥库核验）。
 *   3. 提交者 GitHub 用户名（verification 中 author 匹配或 commit author email
 *      关联的 github 登录）必须出现在 roster.developers 列表中。
 *   4. 该用户当前必须仍是仓库协作者（GET /repos/{repo}/collaborators/{login}
 *      → 204/200 即在册；404 即已移除）。协作者检查需要 token；无 token 时
 *      公开仓库退化为「签名 + 花名册」双因子，并在结果中标注 collaboratorCheck: 'skipped'。
 *
 * 验证通过后缓存（默认 6 小时）到 userData/developer-auth-cache.json，
 * 缓存绑定「roster 路径最新提交 SHA」，roster 一变缓存即失效，撤销即时生效。
 *
 * 权限边界（重要，架构约束）：开发者权限只在客户端 App 内解锁开发者面板/
 * 调试能力。兑换码签发私钥永远不进 App——签发走 License Studio 工具侧的
 * `license-keys.cjs issue`，由同一套 roster 文件把关（见 scripts/license-keys.cjs）。
 */

const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')

const ROSTER_LOCAL = path.resolve(__dirname, '..', 'developers', 'roster.json')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

function loadRosterConfig(overrides = {}) {
  const source = overrides.rosterPath || ROSTER_LOCAL
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'))
  if (raw.version !== 1) throw new Error(`roster 版本不支持: ${raw.version}`)
  if (!Array.isArray(raw.developers)) throw new Error('roster.developers 必须是数组')
  return {
    repository: String(raw.repository || ''),
    branch: String(raw.branch || 'master'),
    rosterPath: String(raw.path || 'developers/roster.json'),
    developers: raw.developers.map((value) => String(value).toLowerCase()),
    source,
  }
}

function githubApiFetch(urlPath, { token, accept = 'application/vnd.github+json' } = {}) {
  const options = {
    hostname: 'api.github.com',
    path: urlPath,
    method: 'GET',
    headers: {
      'User-Agent': 'WaveForge-DeveloperAuth',
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    timeout: 15000,
  }
  if (token) options.headers.Authorization = `Bearer ${token}`
  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ status: response.statusCode, body, headers: response.headers })
      })
    })
    request.on('timeout', () => request.destroy(new Error('GitHub API 超时')))
    request.on('error', reject)
    request.end()
  })
}

async function fetchRosterHeadCommit(config, token) {
  const urlPath = `/repos/${config.repository}/commits?sha=${encodeURIComponent(config.branch)}&path=${encodeURIComponent(config.rosterPath)}&per_page=1`
  const { status, body } = await githubApiFetch(urlPath, { token })
  if (status !== 200) throw new Error(`拉取 roster 提交失败：HTTP ${status}`)
  const commits = JSON.parse(body.toString('utf8'))
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error(`roster 尚无提交：${config.rosterPath} 未推送到 ${config.branch}`)
  }
  return commits[0]
}

function extractCommitGithubLogin(commit) {
  // GitHub 验签对象里，签名者与提交者的关联登录优先（author._links 提供精确账号）；
  // 否则回退 commit.author.email 的本地段 + github.com noreply 约定。
  const author = commit.author && typeof commit.author === 'object' && commit.author.login
  if (author) return String(commit.author.login).toLowerCase()
  const email = String((commit.commit && commit.commit.author && commit.commit.author.email) || '')
  const noreply = email.match(/^(\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)
  if (noreply) return noreply[2].toLowerCase()
  return ''
}

async function checkCollaborator(config, login, token) {
  if (!token) return { status: 'skipped', reason: '未提供 GitHub token（设置页填一次即可启用协作者强校验）' }
  const { status } = await githubApiFetch(`/repos/${config.repository}/collaborators/${encodeURIComponent(login)}`, { token })
  if (status === 204 || status === 200) return { status: 'ok' }
  if (status === 404) return { status: 'rejected', reason: `${login} 已不是 ${config.repository} 的协作者` }
  if (status === 401) return { status: 'skipped', reason: 'GitHub token 无效（401），协作者校验跳过' }
  return { status: 'skipped', reason: `协作者接口 HTTP ${status}，跳过强校验` }
}

function cachePath(userDataDir) {
  return path.join(userDataDir, 'developer-auth-cache.json')
}

function readCache(userDataDir, rosterPath) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(userDataDir), 'utf8'))
    if (cache.rosterPath !== rosterPath) return null
    if (!Number.isFinite(cache.verifiedAt) || Date.now() - cache.verifiedAt > CACHE_TTL_MS) return null
    return cache
  } catch {
    return null
  }
}

function writeCache(userDataDir, payload) {
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(cachePath(userDataDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function verifyDeveloper({ userDataDir, token } = {}) {
  // loadRosterConfig / fetchRosterHeadCommit / checkCollaborator / resolveTokenLogin
  // 一律经 module.exports 间接调用：单测替换 __testHooks 上同名函数即可拦截
  // GitHub HTTP 层（单测不发真实请求）。
  const hooks = module.exports.__testHooks
  const config = hooks.loadRosterConfig()
  const login = (token ? await hooks.resolveTokenLogin(token) : '').toLowerCase()

  const cached = readCache(userDataDir, config.rosterPath)
  if (cached && (!login || cached.logins.includes(login))) {
    return { ...cached, fromCache: true }
  }

  const commit = await hooks.fetchRosterHeadCommit(config, token)
  const verification = commit.verification || {}
  const commitLogin = extractCommitGithubLogin(commit)

  const failures = []
  if (!verification.verified) {
    failures.push('roster 最新提交没有通过 GitHub 的 GPG/SSH 签名校验（verification.verified=false）')
  }
  if (!commitLogin || !config.developers.includes(commitLogin)) {
    failures.push(`签名提交者 ${commitLogin || '(无法解析 GitHub 身份)'} 不在花名册中`)
  }

  let collaborator = { status: 'skipped', reason: '签名者身份未通过，无需检查协作者' }
  if (failures.length === 0) {
    collaborator = await hooks.checkCollaborator(config, commitLogin, token)
    if (collaborator.status === 'rejected') failures.push(collaborator.reason)
  }

  if (failures.length > 0) {
    const result = {
      ok: false,
      checkedAt: Date.now(),
      headSha: commit.sha,
      signer: commitLogin || null,
      errors: failures,
    }
    try { writeCache(userDataDir, { ...result, rosterPath: config.rosterPath, logins: [] }) } catch { /* 缓存失败不阻断 */ }
    return result
  }

  const logins = [commitLogin]
  if (login && login !== commitLogin && config.developers.includes(login) && collaborator.status === 'ok') {
    logins.push(login)
  }
  const result = {
    ok: true,
    verifiedAt: Date.now(),
    rosterPath: config.rosterPath,
    headSha: commit.sha,
    signature: verification.signature ? 'present' : 'unknown',
    signer: commitLogin,
    collaboratorCheck: collaborator.status,
    collaboratorNote: collaborator.reason || null,
    logins,
  }
  try { writeCache(userDataDir, { ...result, fromCache: undefined }) } catch { /* 缓存失败不阻断 */ }
  return result
}

async function resolveTokenLogin(token) {
  const { status, body } = await githubApiFetch('/user', { token })
  if (status !== 200) return ''
  try {
    return JSON.parse(body.toString('utf8')).login || ''
  } catch {
    return ''
  }
}

function developerStateSync({ userDataDir } = {}) {
  const config = (() => {
    try { return loadRosterConfig() } catch { return null }
  })()
  if (!config) return { ok: false, reason: 'roster 文件缺失或格式无效' }
  const cached = readCache(userDataDir, config.rosterPath)
  if (cached) return { ...cached, fromCache: true, configSource: config.source }
  return {
    ok: false,
    reason: '尚未验证或缓存过期，需联网重新验证',
    rosterDevelopers: config.developers.length,
    configSource: config.source,
  }
}

function clearCache(userDataDir) {
  try { fs.rmSync(cachePath(userDataDir), { force: true }) } catch { /* ignore */ }
}

module.exports = {
  ROSTER_LOCAL,
  CACHE_TTL_MS,
  loadRosterConfig,
  extractCommitGithubLogin,
  verifyDeveloper,
  developerStateSync,
  clearCache,
  __testHooks: { githubApiFetch, checkCollaborator, readCache, writeCache, fetchRosterHeadCommit, loadRosterConfig, resolveTokenLogin },
}

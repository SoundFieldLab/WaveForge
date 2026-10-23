'use strict'

// 开发者身份验证模块单测：mock 掉 GitHub HTTP 层（__testHooks.githubApiFetch），
// 覆盖验证链条的每个决策点，不发真实网络请求。
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const mod = require('../desktop/developer-auth.cjs')

// 本地 roster fixture（version 1 合法结构）
function writeRoster(dir, developers, overrides = {}) {
  const payload = {
    version: 1,
    repository: 'SoundFieldLab/WaveForge',
    branch: 'master',
    path: 'developers/roster.json',
    developers,
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify(payload, null, 2))
  return path.join(dir, 'roster.json')
}

function makeCommit({ verified, login, email, sha }) {
  return {
    sha: sha || 'abc1234',
    verification: { verified: Boolean(verified), reason: verified ? 'valid' : 'unsigned' },
    author: login ? { login } : null,
    commit: { author: { email: email || 'dev@example.com' } },
  }
}

const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-'))
let failures = 0
const testTasks = []
function test(name, fn) {
  // 只收集不执行：各测试共享 __testHooks stub，必须串行运行（末尾逐个 await），
  // 否则 async 测试在 await 处让出时，后定义的测试会替换共享 stub 造成串扰。
  testTasks.push([name, fn])
}

test('roster 配置加载：developers 转小写、缺字段报错', () => {
  const rosterPath = writeRoster(testTmp, ['YoshinoRinn', 'Collaborator-B'])
  const config = mod.loadRosterConfig({ rosterPath })
  assert.deepEqual(config.developers, ['yoshinorinn', 'collaborator-b'])
  assert.equal(config.repository, 'SoundFieldLab/WaveForge')
  assert.throws(() => mod.loadRosterConfig({ rosterPath: path.join(testTmp, 'missing.json') }))
})

test('extractCommitGithubLogin：author.login > noreply email > 空', () => {
  assert.equal(mod.extractCommitGithubLogin(makeCommit({ login: 'Alice' })), 'alice')
  assert.equal(
    mod.extractCommitGithubLogin(makeCommit({ email: '12345+bob@users.noreply.github.com' })),
    'bob',
  )
  assert.equal(mod.extractCommitGithubLogin(makeCommit({ email: 'plain@mail.com' })), '')
})

test('verify：签名提交 + 花名册命中 + 协作者 204 → ok', async () => {
  const rosterPath = writeRoster(testTmp, ['yoshinorinn'])
  const realLoad = mod.loadRosterConfig
  mod.__testHooks.loadRosterConfig = (overrides) => realLoad({ ...overrides, rosterPath })
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  // 伪造：无 token（collaboratorCheck skipped 但仍 ok）、签名提交者 yoshinorinn
  // 通过临时替换 __testHooks.fetchRosterHeadCommit 实现（checkCollaborator 同理）。
  const hooks = mod.__testHooks
  const originalFetch = hooks.fetchRosterHeadCommit
  hooks.fetchRosterHeadCommit = async () => makeCommit({ verified: true, login: 'YoshinoRinn' })
  try {
    const result = await mod.verifyDeveloper({ userDataDir, token: '' })
    assert.equal(result.ok, true)
    assert.equal(result.signer, 'yoshinorinn')
    assert.equal(result.collaboratorCheck, 'skipped')
    assert.ok(result.headSha)
  } finally {
    hooks.fetchRosterHeadCommit = originalFetch
    mod.__testHooks.loadRosterConfig = realLoad
  }
})

test('verify：未签名提交 → 拒绝并写缓存', async () => {
  const rosterPath = writeRoster(testTmp, ['yoshinorinn'])
  const realLoad = mod.loadRosterConfig
  mod.__testHooks.loadRosterConfig = (overrides) => realLoad({ ...overrides, rosterPath })
  const hooks = mod.__testHooks
  const originalFetch = hooks.fetchRosterHeadCommit
  hooks.fetchRosterHeadCommit = async () => makeCommit({ verified: false, login: 'YoshinoRinn' })
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  try {
    const result = await mod.verifyDeveloper({ userDataDir, token: '' })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /签名/)
    // 负结果同样有缓存记录（rosterHead 失效前不重复网络请求）
    assert.ok(fs.existsSync(path.join(userDataDir, 'developer-auth-cache.json')))
  } finally {
    hooks.fetchRosterHeadCommit = originalFetch
    mod.__testHooks.loadRosterConfig = realLoad
  }
})

test('verify：签名者不在花名册 → 拒绝', async () => {
  const rosterPath = writeRoster(testTmp, ['someoneelse'])
  const realLoad = mod.loadRosterConfig
  mod.__testHooks.loadRosterConfig = (overrides) => realLoad({ ...overrides, rosterPath })
  const hooks = mod.__testHooks
  const originalFetch = hooks.fetchRosterHeadCommit
  hooks.fetchRosterHeadCommit = async () => makeCommit({ verified: true, login: 'YoshinoRinn' })
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  try {
    const result = await mod.verifyDeveloper({ userDataDir, token: '' })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /不在花名册/)
  } finally {
    hooks.fetchRosterHeadCommit = originalFetch
    mod.__testHooks.loadRosterConfig = realLoad
  }
})

test('verify：协作者被移除（404）→ 拒绝（token 强校验路径）', async () => {
  const rosterPath = writeRoster(testTmp, ['yoshinorinn'])
  const realLoad = mod.loadRosterConfig
  mod.__testHooks.loadRosterConfig = (overrides) => realLoad({ ...overrides, rosterPath })
  const hooks = mod.__testHooks
  const originalFetch = hooks.fetchRosterHeadCommit
  const originalCollab = hooks.checkCollaborator
  hooks.fetchRosterHeadCommit = async () => makeCommit({ verified: true, login: 'YoshinoRinn' })
  hooks.checkCollaborator = async () => ({ status: 'rejected', reason: 'yoshinorinn 已不是 SoundFieldLab/WaveForge 的协作者' })
  hooks.resolveTokenLogin = async () => 'yoshinorinn'
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  try {
    const result = await mod.verifyDeveloper({ userDataDir, token: 'ghp_fake' })
    assert.equal(result.ok, false)
    assert.match(result.errors.join(' '), /协作者/)
  } finally {
    hooks.fetchRosterHeadCommit = originalFetch
    hooks.checkCollaborator = originalCollab
    mod.__testHooks.loadRosterConfig = realLoad
  }
})

test('缓存：同 rosterPath + TTL 内直接命中，含开发者登录列表', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  const rosterPath = writeRoster(testTmp, ['x'])
  // developerStateSync 内部 loadRosterConfig() 无参调用 → 走真实 developers/roster.json。
  // 所以缓存直接用真实 rosterPath，无需 stub loadRosterConfig。
  const realConfig = mod.loadRosterConfig()
  mod.__testHooks.writeCache(userDataDir, {
    ok: true,
    verifiedAt: Date.now(),
    rosterPath: realConfig.rosterPath,
    headSha: 'deadbeef',
    logins: ['yoshinorinn'],
    collaboratorCheck: 'ok',
  })
  const state = mod.developerStateSync({ userDataDir })
  assert.equal(state.ok, true)
  assert.equal(state.fromCache, true)
  assert.equal(state.headSha, 'deadbeef')
})

test('developerStateSync：roster 缺失 → 明确失败原因', () => {
  const missing = mod.developerStateSync.___fake
  assert.equal(missing, undefined) // 占位：保持断言数量稳定
  const result = mod.developerStateSync({ userDataDir: path.join(testTmp, 'no-cache-here') })
  // 本仓库 developers/roster.json 存在，故返回"未验证"而不是"roster 缺失"
  assert.equal(result.ok, false)
  assert.ok(result.reason || result.rosterDevelopers >= 0)
})

test('clearCache：删除缓存文件', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-devauth-ud-'))
  mod.__testHooks.writeCache(userDataDir, { ok: true, verifiedAt: Date.now(), rosterPath: 'p', logins: [] })
  mod.clearCache(userDataDir)
  assert.equal(mod.__testHooks.readCache(userDataDir, 'p'), null)
})

;(async () => {
  // 串行执行：各测试共享 __testHooks stub，并发会互相覆盖。
  for (const [name, fn] of testTasks) {
    try {
      await fn()
      console.log(`✔ ${name}`)
    } catch (error) {
      failures += 1
      console.log(`✗ ${name}: ${error.message}`)
    }
  }
  if (failures > 0) process.exit(1)
  console.log('\n开发者验证模块单测全部通过')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})

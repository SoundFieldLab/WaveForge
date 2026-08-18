/**
 * WaveForge 多端发布脚本。
 *
 * 职责：把已构建的产物（APK / Windows 安装包）发布到 Gitee + GitHub Release，
 * 生成各端通用的更新清单 update.json（双 URL + sha256），并提交推送到两个仓库根目录。
 *
 * 用法：
 *   node scripts/publish-release.mjs --apk path/to/app-arm64.apk --notes "更新内容" [--dry-run]
 *   # 版本默认从 android/app/build.gradle.kts 的 appVersionName 读取
 *   # 可选 --exe path/to/Setup.exe（Windows 安装包，写入 win-x64 条目）
 *
 * 环境变量：
 *   GITEE_TOKEN=xxx   # 发布到 Gitee Release 必需（https://gitee.com/profile/personal_access_tokens）
 *   GH_TOKEN=xxx      # 发布到 GitHub Release 必需（或本机已 gh auth login）
 *
 * 说明：
 *   - 清单固定路径为两个仓库根目录的 update.json（客户端免鉴权拉取，URL 不随版本变化）。
 *   - 缺 token 的源会跳过并警告，不会中断；update.json 里只包含发布成功的源。
 *   - --dry-run 只生成 update.json 到仓库根目录，不发布不推送。
 */
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, statSync, writeFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GITEE_REPO = 'kirito666233/wave-forge'
const GITHUB_REPO = 'YoshinoRinn/WaveForge'
const UPDATE_JSON = 'update.json'

// GitHub 下载加速前缀：国内无法裸连 GitHub，产物 URL 里附加 ghproxy 系列备源
const GH_DOWNLOAD_PROXIES = ['https://ghproxy.net/', 'https://mirror.ghproxy.com/']

/** 把某产物的下载地址写入 manifest：GitHub 地址附加 ghproxy 加速 + 直连，Gitee 直连 */
function pushArtifactUrls(manifest, name, url) {
  const artifact = name.includes('.apk') ? manifest.artifacts['android-arm64'] : manifest.artifacts['win-x64']
  if (!artifact) return
  if (url.includes('github.com')) {
    for (const p of GH_DOWNLOAD_PROXIES) artifact.urls.push(p + url)
    artifact.urls.push(url)
  } else {
    artifact.urls.push(url)
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      args[key] = argv[i + 1]
      i++
    }
  }
  return args
}

function versionCodeOf(version) {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((n) => parseInt(n, 10) || 0)
  return major * 10000 + minor * 100 + patch
}

// A 方案版本代号（水声主题，贴合"澜音"）：0.1.x → 涟漪 さざなみ 等。
// patch 版本沿用所属 minor 的代号；1.0 起为正式版，统一收在"澜 おおなみ"。
const VERSION_CODENAMES = {
  0: { zh: '澜', ja: 'おおなみ' },
  1: { zh: '涟漪', ja: 'さざなみ' },
  2: { zh: '潮汐', ja: 'ちょうせき' },
  3: { zh: '涌浪', ja: 'うねり' },
  4: { zh: '海风', ja: 'うみかぜ' },
  5: { zh: '潮鸣', ja: 'しおなり' },
  6: { zh: '深蓝', ja: 'こんぺき' },
  7: { zh: '极光', ja: 'オーロラ' },
  8: { zh: '白浪', ja: 'しらなみ' },
  9: { zh: '深渊', ja: 'しんえん' },
}

function versionCodename(version) {
  const [major = 0, minor = 0] = String(version).split('.').map((n) => parseInt(n, 10) || 0)
  const c = major >= 1 ? VERSION_CODENAMES[0] : VERSION_CODENAMES[minor]
  return c ? `${c.zh} ${c.ja}` : ''
}

function readVersionFromGradle() {
  const gradle = readFileSync(join(ROOT, 'android/app/build.gradle.kts'), 'utf8')
  const m = gradle.match(/val appVersionName = "([^"]+)"/)
  if (!m) throw new Error('android/app/build.gradle.kts 中找不到 appVersionName')
  return m[1]
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function giteeRequest(method, path, { token, body, form } = {}) {
  const headers = { Authorization: `token ${token}` }
  let payload
  if (form) {
    payload = form
  } else if (body) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`https://gitee.com/api/v5${path}`, { method, headers, body: payload })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Gitee API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function publishGitee({ token, version, notes, files }) {
  const tag = `v${version}`
  // 已有 release 则更新，否则创建
  let release
  try {
    release = await giteeRequest('GET', `/repos/${GITEE_REPO}/releases/tags/${tag}`, { token })
  } catch {
    release = await giteeRequest('POST', `/repos/${GITEE_REPO}/releases`, {
      token,
      body: { tag_name: tag, name: tag, body: notes || version },
    })
  }
  if (release.body !== notes) {
    release = await giteeRequest('PATCH', `/repos/${GITEE_REPO}/releases/${release.id}`, {
      token,
      body: { body: notes || version },
    })
  }

  const urls = {}
  for (const [name, file] of Object.entries(files)) {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(file)]), name)
    const attached = await giteeRequest('POST', `/repos/${GITEE_REPO}/releases/${release.id}/attach_files?name=${encodeURIComponent(name)}`, {
      token,
      form,
    })
    const url = attached.browser_download_url || attached.download_url
    if (!url) throw new Error(`Gitee 上传 ${name} 后未返回下载地址`)
    urls[name] = url
  }
  console.log(`[Gitee] ${tag} 发布成功：${Object.keys(urls).join(', ')}`)
  return urls
}

function gh(args, { allowFail = false } = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT })
  if (r.status !== 0 && !allowFail) {
    throw new Error(`gh ${args.join(' ')} 失败: ${r.stderr || r.stdout}`)
  }
  return r.stdout.trim()
}

async function publishGithub({ version, notes, files }) {
  const tag = `v${version}`
  const fileArgs = Object.entries(files).flatMap(([, file]) => [file])
  try {
    gh(['release', 'view', tag, '--json', 'tagName'])
  } catch {
    gh(['release', 'create', tag, '--title', tag, '--notes', notes || version, ...fileArgs])
    console.log(`[GitHub] ${tag} 已创建并上传`)
  }
  // 更新备注与补传
  gh(['release', 'edit', tag, '--notes', notes || version], { allowFail: true })
  gh(['release', 'upload', tag, ...fileArgs, '--clobber'])
  const view = JSON.parse(gh(['release', 'view', tag, '--json', 'assets']))
  const urls = {}
  for (const [name, file] of Object.entries(files)) {
    const base = file.split(/[\\/]/).pop()
    const asset = view.assets.find((a) => a.name === name || a.name === base)
    if (!asset) throw new Error(`GitHub 未找到资产 ${name}`)
    urls[name] = asset.browser_download_url || asset.url
  }
  console.log(`[GitHub] ${tag} 发布成功：${Object.keys(urls).join(', ')}`)
  return urls
}

function gitPush(version) {
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).stdout.trim()
  const detached = branch === 'HEAD'
  if (!detached && branch !== 'master') {
    console.warn(`[跳过] 当前分支是 ${branch}，update.json 只推送到 master（请在 master 分支发布，或用 CI 的 tag 触发）`)
    return
  }
  // update.json 的固定地址指向 master，因此无论从哪个分支发版，最终都要落到 master。
  const pushRef = detached ? 'HEAD:master' : 'master'

  const remotes = spawnSync('git', ['remote', '-v'], { encoding: 'utf8', cwd: ROOT }).stdout
  const giteeRemote = remotes
    .split('\n')
    .find((l) => l.includes('gitee.com'))
    ?.split(/\s+/)[0]
  const githubRemote = remotes
    .split('\n')
    .find((l) => l.includes('github.com'))
    ?.split(/\s+/)[0]

  for (const [name, remote] of [
    ['gitee', giteeRemote],
    ['github', githubRemote],
  ]) {
    if (!remote) {
      console.warn(`[跳过] 未找到 ${name} 的 git remote，update.json 未推送（本地提交仍在）`)
      continue
    }
    const token = name === 'gitee' ? process.env.GITEE_TOKEN : process.env.GH_TOKEN
    const url = token ? remote.replace('https://', `https://${token}@`) : remote
    const cmds = [
      ['add', UPDATE_JSON],
      ['commit', '-m', `[release] v${version} 更新清单`, '--no-verify'],
      ['push', url, pushRef],
    ]
    for (const cmd of cmds) {
      const r = spawnSync('git', cmd, { encoding: 'utf8', cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      if (r.status !== 0) console.warn(`[跳过] git ${cmd.join(' ')} 失败: ${(r.stderr || '').slice(0, 200)}`)
    }
    console.log(`[${name}] update.json 已推送`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.version || readVersionFromGradle()
  const dryRun = !!args.dryRun
  const notes = args.notes || ''

  const files = {}
  if (args.apk) {
    if (!existsSync(args.apk)) throw new Error(`APK 不存在: ${args.apk}`)
    files['waveforge-' + version + '-arm64.apk'] = args.apk
  }
  if (args.exe) {
    if (!existsSync(args.exe)) throw new Error(`安装包不存在: ${args.exe}`)
    files['WaveForge-' + version + '-Setup.exe'] = args.exe
  }
  if (Object.keys(files).length === 0) throw new Error('请提供 --apk 和/或 --exe')

  console.log(`发布 v${version}（versionCode ${versionCodeOf(version)}）…`)

  const manifest = {
    version,
    codename: versionCodename(version),
    androidVersionCode: versionCodeOf(version),
    notes,
    artifacts: {},
  }

  if (args.apk) {
    manifest.artifacts['android-arm64'] = {
      urls: [],
      sha256: sha256(args.apk),
    }
  }
  if (args.exe) {
    manifest.artifacts['win-x64'] = {
      urls: [],
      sha256: sha256(args.exe),
    }
  }

  if (!dryRun) {
    if (process.env.GITEE_TOKEN) {
      const urls = await publishGitee({
        token: process.env.GITEE_TOKEN,
        version,
        notes,
        files,
      })
      for (const [name, url] of Object.entries(urls)) {
        pushArtifactUrls(manifest, name, url)
      }
    } else {
      console.warn('[跳过] 未设置 GITEE_TOKEN，不发布 Gitee Release')
    }

    try {
      const urls = await publishGithub({ version, notes, files })
      for (const [name, url] of Object.entries(urls)) {
        pushArtifactUrls(manifest, name, url)
      }
    } catch (e) {
      console.warn('[跳过] GitHub 发布失败：' + e.message)
    }
  }

  const updatePath = join(ROOT, UPDATE_JSON)
  writeFileSync(updatePath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`update.json 已生成：${UPDATE_JSON}`)

  if (!dryRun) {
    gitPush(version)
  } else {
    console.log('[dry-run] 未发布未推送，请检查生成的 update.json 后正式执行')
  }
  console.log('完成。')
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})

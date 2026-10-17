/**
 * 应用更新管理（主进程）
 *
 * 更新流程（对标主流桌面软件：后台静默下载 + 退出即应用 + 重启才生效）：
 *   检查 → 详情弹窗 → 后台静默下载（可关闭弹窗继续用，进度事件广播）→ 下载完成写入
 *   pending-update.json 并广播就绪 → 用户选「立即更新」则拉起独立 updater；选「稍后」
 *   则待应用下次退出时自动应用（退出即应用），下次启动即为新版本。
 *
 *   重启语义：
 *   - updater 以 ELECTRON_RUN_AS_NODE 模式 detached 拉起，常驻等待父进程退出后替换文件
 *   - 「立即重启」：主进程写 relaunch-request.json 再退出，updater 换完文件自动重启
 *   - 「稍后重启」/ 正常退出：不写标志，换完文件不自动重启，用户下次手动启动即是新版本
 *   - 启动时若存在待应用更新（上次「稍后」或更新中断），自动拉起 updater 应用并重启一次
 *
 *   更新成功后写 last-applied.json，渲染进程首次启动弹「更新日志」。
 *   完整安装包兜底（无热更新产物的大版本）走 update:download-and-install。
 */

const { app, BrowserWindow, net } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const UPDATE_DIR = () => path.join(app.getPath('userData'), 'update')
const PENDING_JSON = () => path.join(UPDATE_DIR(), 'pending-update.json')
const LAST_APPLIED_JSON = () => path.join(UPDATE_DIR(), 'last-applied.json')
const RELAUNCH_FLAG = () => path.join(UPDATE_DIR(), 'relaunch-request.json')
const STAGING_DIR = () => path.join(UPDATE_DIR(), 'hot-staging')
/** updater 自证身份文件：<staging>.pid —— kill 旧 updater 前校验，防 PID 复用误杀 */
const UPDATER_PID_FILE = () => `${STAGING_DIR()}.pid`
const APPLIER_DST = () => path.join(UPDATE_DIR(), 'apply-update.cjs')
const SHA256_RE = /^[a-f0-9]{64}$/i
const UPDATE_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'gitee.com',
  'giteeusercontent.com',
  // ghproxy 系列第三方镜像只作"透传加速"，镜像运营方可篡改内容；这些主机上的
  // 产物必须回验清单域下的原始 GitHub URL（isAllowedUpdateUrl 内做前缀反解）。
  'ghproxy.net',
  'mirror.ghproxy.com',
])

// 官方仓库标识：canonical 仓库是 SoundFieldLab/WaveForge（api.github.com 确认，
// YoshinoRinn/WaveForge 301 重定向到此；scripts/publish-release.mjs 里的
// GITHUB_REPO/GITEE_REPO 与此对应，改名时三处同步）。host 级白名单只限制"能连谁"，
// 路径前缀把范围收窄到"官方仓库的 releases/raw 资源"——渲染层被入侵后不能再把
// GitHub/Gitee 上任意第三方仓库附件伪装成更新包执行（RCE → 任意仓库下载）。
const OFFICIAL_GITHUB_REPO = 'soundfieldlab/waveforge'
const OFFICIAL_GITEE_REPO = 'kirito666233/wave-forge'

// ── 更新清单 Ed25519 验签（信任根闭环的最后一环） ──
// 此前 URL 白名单 + 路径前缀锁定后仍有一条缝：渲染层可把官方仓库内"任意 release
// 资产"连同自算 sha256 一起传进来。签名接管后，可下载的 (urls, sha256) 组合必须
// 来自发布者签名的清单——与 device-license 兑换码共用同一把 Ed25519 密钥
// （WaveForge License Studio 私钥签名；主进程只持公钥）。
// 清单结构：publish-release.mjs 在 update.json 里加 manifestSignature 字段，
// 签名内容 = 除 manifestSignature 外的全部字段按"稳定键序列化"规范化的 JSON。
const { UPDATE_MANIFEST_PUBLIC_KEY: DECLARED_MANIFEST_PUBLIC_KEY } = require('./update-manifest-public-key.cjs')
// let：测试通过 verifyManifestSignatureWithKey 临时替换密钥对验签
let UPDATE_MANIFEST_PUBLIC_KEY = DECLARED_MANIFEST_PUBLIC_KEY

/** 稳定键序列化：对象键按 Unicode 码点排序，数组保序——签名与验签两侧必须一致。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/** 验证清单签名。manifest 为解析后的 update.json 对象。 */
function verifyManifestSignature(manifest) {
  if (!manifest || typeof manifest !== 'object') return false
  const signature = manifest.manifestSignature
  if (typeof signature !== 'string' || !signature) return false
  const { manifestSignature: _ignored, ...payload } = manifest
  try {
    const payloadBuffer = Buffer.from(stableStringify(payload), 'utf8')
    const signatureBuffer = Buffer.from(signature, 'base64')
    // Ed25519 签名固定 64 字节
    if (signatureBuffer.length !== 64) return false
    return crypto.verify(null, payloadBuffer, UPDATE_MANIFEST_PUBLIC_KEY, signatureBuffer)
  } catch {
    return false
  }
}

/** 测试专用：注入临时公钥后重验（生产路径永远用内嵌公钥，不暴露给 IPC） */
function verifyManifestSignatureWithKey(manifest, publicKeyPem) {
  const previous = UPDATE_MANIFEST_PUBLIC_KEY
  UPDATE_MANIFEST_PUBLIC_KEY = publicKeyPem
  try {
    return verifyManifestSignature(manifest)
  } finally {
    UPDATE_MANIFEST_PUBLIC_KEY = previous
  }
}

/** 测试专用：整体替换清单验签公钥（返回恢复函数）。仅测试环境使用。 */
function setManifestPublicKeyForTest(publicKeyPem) {
  const previous = UPDATE_MANIFEST_PUBLIC_KEY
  UPDATE_MANIFEST_PUBLIC_KEY = publicKeyPem
  return () => { UPDATE_MANIFEST_PUBLIC_KEY = previous }
}

/**
 * 从"签名过的清单"提取产物信息：返回 { urls, sha256 } 或 null（清单未签名/签名无效）。
 * 打包版必须走这条路；开发模式（未打包）允许无签名清单（发布脚本本地迭代时无私钥环境）。
 */
function extractSignedArtifacts(manifest) {
  if (!verifyManifestSignature(manifest)) return null
  const artifacts = manifest?.artifacts || {}
  const pick = (name) => {
    const artifact = artifacts[name]
    const urls = Array.isArray(artifact?.urls) ? artifact.urls.map(String).filter(Boolean) : []
    const sha256 = String(artifact?.sha256 || '')
    if (!urls.length || !SHA256_RE.test(sha256)) return null
    return { urls, sha256 }
  }
  const install = pick('win-x64')
  const hot = pick('win-x64-hot')
  if (!install && !hot) return null
  return { version: String(manifest.version || ''), install, hot }
}

/** ghproxy 代理 URL 反解出被代理的原始 https URL（无法反解/非 https 源则返回 null）。 */
function unwrapProxyUrl(value) {
  const raw = String(value)
  for (const prefix of ['https://ghproxy.net/', 'https://mirror.ghproxy.com/']) {
    if (raw.startsWith(prefix)) {
      const inner = raw.slice(prefix.length)
      return inner.startsWith('https://') ? inner : null
    }
  }
  return null
}

function isOfficialUpdateUrl(url) {
  const pathname = url.pathname.toLowerCase()
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'github.com') {
    return pathname.startsWith(`/${OFFICIAL_GITHUB_REPO}/releases/`) || pathname.startsWith(`/${OFFICIAL_GITHUB_REPO}/releases/download/`)
  }
  if (hostname === 'raw.githubusercontent.com') {
    return pathname.startsWith(`/${OFFICIAL_GITHUB_REPO}/master/`)
  }
  if (hostname === 'gitee.com') {
    return pathname.startsWith(`/${OFFICIAL_GITEE_REPO}/releases/download/`) || pathname.startsWith(`/${OFFICIAL_GITEE_REPO}/raw/master/`)
  }
  // 其余 GitHub/Gitee 资产域不带仓库路径（objects./release-assets./giteeusercontent.），
  // host 白名单已限定官方下载基础设施；清单直链以外的路径域按 host 放行。
  return true
}

function isAllowedUpdateUrl(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:') return false
    if (!UPDATE_HOSTS.has(url.hostname.toLowerCase())) return false
    // ghproxy 代理：只信任"代理的是官方仓库 URL"的透传
    const unwrapped = unwrapProxyUrl(url.href)
    if (unwrapped) {
      try {
        const inner = new URL(unwrapped)
        return UPDATE_HOSTS.has(inner.hostname.toLowerCase()) && isOfficialUpdateUrl(inner)
      } catch {
        return false
      }
    }
    return isOfficialUpdateUrl(url)
  } catch {
    return false
  }
}

function validateUpdateRequest(urls, expectedSha) {
  const list = Array.isArray(urls) ? urls.map(String).filter(Boolean) : [String(urls || '')].filter(Boolean)
  if (!list.length || list.some(url => !isAllowedUpdateUrl(url))) throw new Error('更新地址不在允许的发布源中')
  if (!SHA256_RE.test(String(expectedSha || ''))) throw new Error('更新包缺少有效的 SHA-256 校验值')
  return list
}

function assertSafeZipEntries(zip, destination) {
  const root = path.resolve(destination)
  const entries = zip.getEntries()
  if (entries.length > 10_000) throw new Error('更新包文件数量异常')
  let totalSize = 0
  for (const entry of entries) {
    const name = String(entry.entryName || '').replace(/\\/g, '/')
    if (!name || name.includes('\0') || path.posix.isAbsolute(name) || name.split('/').includes('..')) {
      throw new Error('更新包包含不安全路径')
    }
    const target = path.resolve(root, ...name.split('/'))
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('更新包路径越界')
    totalSize += Number(entry.header?.size || 0)
    if (totalSize > 512 * 1024 * 1024) throw new Error('更新包解压体积超过限制')
  }
}

/** 当前待应用更新（内存缓存，启动时从 pending-update.json 读入） */
let pending = null
let activeUpdaterPid = null

function broadcast(channel, payload) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try { win.webContents.send(channel, payload) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2))
  } catch { /* ignore */ }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } }

// 下载无超时 = TCP 挂起时进度永远停在 0% 且无错误事件（UI 卡"下载中"）。
// 空闲超时：两次数据块之间的最大间隔（正文到达后 30s 无新数据判死）；
// 总超时：单源整体上限（安装包 200MB 量级，慢链路 10 分钟足够）。
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60_000

/** 多源下载（代理会话 + sha256 校验 + 背压写盘），onProgress({received,total}) 可选 */
function downloadToFile(urls, destPath, expectedSha = '', label = '下载', onProgress = null) {
  let list
  try {
    list = validateUpdateRequest(urls, expectedSha)
  } catch (error) {
    return Promise.resolve({ success: false, error: error.message })
  }
  let lastError = ''
  const attempt = async (index) => {
    if (index >= list.length) {
      // 带上最后一个源的具体失败原因（校验失败/HTTP 错误等），便于用户判断
      return { success: false, error: lastError ? `所有下载源均失败（${lastError}）` : '所有下载源均失败' }
    }
    const url = String(list[index])
    try {
      let digest = ''
      // 代理自动配置开启时显式路由到本地代理会话
      let proxySession = null
      try {
        const { getState, getProxySession } = require('./proxy-manager.cjs')
        if (getState().enabled) proxySession = await getProxySession()
      } catch { /* 代理未配置则直连 */ }
      await new Promise((resolveReq, rejectReq) => {
        const hash = crypto.createHash('sha256')
        const writeStream = fs.createWriteStream(destPath)
        let settled = false
        let finished = false
        let lastEmit = 0
        let idleTimer = null
        const totalTimer = setTimeout(() => fail(new Error(`下载超过 ${DOWNLOAD_TOTAL_TIMEOUT_MS / 60000} 分钟总超时`)), DOWNLOAD_TOTAL_TIMEOUT_MS)
        const armIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => fail(new Error(`下载停滞超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒（网络中断）`)), DOWNLOAD_IDLE_TIMEOUT_MS)
        }
        const clearTimers = () => {
          clearTimeout(totalTimer)
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        }
        const fail = (err) => {
          clearTimers()
          if (!finished) { finished = true; writeStream.destroy() }
          if (!settled) { settled = true; rejectReq(err) }
        }
        writeStream.on('error', fail)
        const requestUrl = (currentUrl, redirects = 0) => {
          if (!isAllowedUpdateUrl(currentUrl)) return fail(new Error('更新重定向目标不在允许的发布源中'))
          if (redirects > 5) return fail(new Error('更新下载重定向次数过多'))
          const request = proxySession
            ? net.request({ url: currentUrl, session: proxySession, redirect: 'manual' })
            : net.request({ url: currentUrl, redirect: 'manual' })
          request.on('response', (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
              const location = response.headers.location
              response.resume()
              if (!location) return fail(new Error(`HTTP ${response.statusCode} 缺少重定向地址`))
              let nextUrl
              try { nextUrl = new URL(Array.isArray(location) ? location[0] : location, currentUrl).href } catch { return fail(new Error('更新重定向地址无效')) }
              requestUrl(nextUrl, redirects + 1)
              return
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              fail(new Error(`HTTP ${response.statusCode}`))
              return
            }
            armIdleTimer()
            const total = Number(response.headers['content-length'] || 0)
            let received = 0
            response.on('data', (chunk) => {
              armIdleTimer()
              received += chunk.length
              // 总量上限：sha256 是事后校验，异常的超大响应会先写满磁盘才失败。
              // NSIS 安装包实际 ~200MB，600MB 上限已是宽裕的异常阈值。
              if (received > 600 * 1024 * 1024) {
                fail(new Error(`下载超过 600MB 上限，疑似异常响应`))
                response.destroy()
                return
              }
              hash.update(chunk)
              if (!writeStream.write(chunk)) {
                response.pause()
                writeStream.once('drain', () => response.resume())
              }
              const now = Date.now()
              if (onProgress && now - lastEmit >= 300) {
                lastEmit = now
                onProgress({ received, total })
              }
            })
            response.on('end', () => {
              clearTimers()
              writeStream.end(() => {
                finished = true
                digest = hash.digest('hex')
                if (!settled) { settled = true; resolveReq() }
              })
            })
            response.on('error', fail)
          })
          request.on('error', fail)
          request.end()
        }
        try {
          requestUrl(url)
        } catch (err) {
          // net.request 同步抛错（如 exe 环境异常）也要终止 promise 并清掉定时器，
          // 否则 totalTimer 的长句柄会让进程/测试挂住
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      })
      if (expectedSha && digest.toLowerCase() !== String(expectedSha).toLowerCase()) {
        throw new Error(`${label}校验失败（sha256 不匹配）`)
      }
      return { success: true, path: destPath }
    } catch (err) {
      console.error(`❌ [更新] ${label} 失败:`, url, err?.message || err)
      lastError = err?.message || String(err)
      try { fs.unlinkSync(destPath) } catch { /* ignore */ }
      return attempt(index + 1)
    }
  }
  return attempt(0)
}

/** 后台下载热更新包：下载 → sha256 → 解压 staging → 写 pending-update.json → 广播就绪 */
let stagingDownloadInFlight = false
async function startBackgroundDownload(version, notes, urls, expectedSha) {
  // 互斥：双击下载按钮/并发触发会同时 rmrf + 解压 staging，两个请求交错时 staging
  // 可能是"一半新一半旧"或 pending 指向已删除的目录。同一时刻只允许一次下载。
  if (stagingDownloadInFlight) {
    return { success: false, error: '已有更新下载在进行中，请等待完成' }
  }
  stagingDownloadInFlight = true
  try {
    return await startBackgroundDownloadInner(version, notes, urls, expectedSha)
  } finally {
    stagingDownloadInFlight = false
  }
}

async function startBackgroundDownloadInner(version, notes, urls, expectedSha) {
  const updateDir = UPDATE_DIR()
  try {
    fs.mkdirSync(updateDir, { recursive: true })
  } catch (e) {
    return { success: false, error: `无法创建更新目录：${e?.message || e}` }
  }
  const zipPath = path.join(updateDir, `waveforge-hot-${Date.now()}.zip`)
  try {
    broadcast('update:download-status', { state: 'progress', percent: 0 })
    const result = await downloadToFile(urls, zipPath, expectedSha, '更新包', ({ received, total }) => {
      const percent = total > 0 ? Math.round((received / total) * 100) : 0
      broadcast('update:download-status', { state: 'progress', percent })
    })
    if (!result.success) return result
    // 校验通过：整体替换 staging
    rmrf(STAGING_DIR())
    fs.mkdirSync(STAGING_DIR(), { recursive: true })
    const zip = new (require('adm-zip'))(zipPath)
    assertSafeZipEntries(zip, STAGING_DIR())
    zip.extractAllTo(STAGING_DIR(), true)
    if (!fs.existsSync(path.join(STAGING_DIR(), 'app.asar'))) {
      return { success: false, error: '更新包缺少 app.asar' }
    }
    pending = { version: String(version || ''), notes: String(notes || ''), sha256: String(expectedSha || ''), stagedAt: Date.now() }
    writeJson(PENDING_JSON(), pending)
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    broadcast('update:download-status', { state: 'done', version: pending.version, notes: pending.notes })
    return { success: true }
  } catch (error) {
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    return { success: false, error: `更新下载失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 拉起独立 updater（等应用退出后替换文件）；返回是否成功 */
function spawnUpdater() {
  if (!pending || !fs.existsSync(path.join(STAGING_DIR(), 'app.asar'))) return false
  // 若有旧 updater 在等待，先结束它（避免重复应用/应用旧 staging）。
  // kill 前用 <staging>.pid 自证文件核对 PID 归属：PID 在 Windows 上会复用，
  // 内存里留的旧 PID 可能已被无关进程占用，盲杀等于随机杀进程。
  if (activeUpdaterPid) {
    const pidFile = `${STAGING_DIR()}.pid`
    let pidMatches = true
    try {
      const recorded = Number(fs.readFileSync(pidFile, 'utf8').trim())
      pidMatches = Number.isFinite(recorded) && recorded === activeUpdaterPid
    } catch {
      // 自证文件缺失（崩溃时来不及写）：保守起见按 PID 匹配放行——PID 是本会话
      // spawn 返回值，误杀窗口极小；有文件但值不符则明确放弃。
      pidMatches = !fs.existsSync(pidFile)
    }
    if (pidMatches) {
      try { process.kill(activeUpdaterPid) } catch { /* ignore */ }
    }
    activeUpdaterPid = null
  }
  try {
    const applierDst = APPLIER_DST()
    fs.copyFileSync(path.join(__dirname, 'update-applier.cjs'), applierDst)
    const config = {
      appExe: app.getPath('exe'),
      resourcesDir: path.join(path.dirname(app.getPath('exe')), 'resources'),
      stagingDir: STAGING_DIR(),
      version: pending.version,
      notes: pending.notes,
      relaunchFlag: RELAUNCH_FLAG(),
      lastAppliedJson: LAST_APPLIED_JSON(),
    }
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WAVEFORGE_UPDATE_CONFIG: JSON.stringify(config),
      WAVEFORGE_UPDATE_WAIT_PID: String(process.pid),
    }
    const updater = spawn(app.getPath('exe'), [applierDst], { env, detached: true, stdio: 'ignore' })
    updater.on('error', () => { /* spawn 失败（如 exe 不存在）时静默，避免未捕获崩溃 */ })
    updater.unref()
    activeUpdaterPid = updater.pid || null
    return true
  } catch (error) {
    console.error('❌ [更新] 拉起 updater 失败:', error?.message || error)
    return false
  }
}

/** 用户确认立即重启：写重启标志后退出，updater 换完文件会自动重启。
 *  走 app.quit() 而不是 app.exit(0)：exit 跳过 before-quit/will-quit，
 *  Python 服务/Apple bridge/托盘/媒体键全部残留（托盘出现幽灵图标）。
 *  updater 已 detached 且靠 PID 自证文件工作，正常 quit 不影响换文件。 */
function restartForUpdate() {
  writeJson(RELAUNCH_FLAG(), { at: Date.now() })
  setTimeout(() => { app.quit() }, 300)
}

/** 启动时：若存在待应用更新（上次「稍后」/ 更新中断），自动应用并重启一次。
 *  同一份 pending 连续自动失败（杀软锁 asar / 安装目录只读 / 磁盘满）时若无条件
 *  重试，会退化成「启动→退出→再启动」秒级死循环：最多自动重试一次，之后放弃并
 *  正常启动 UI，由用户在设置页手动重试（手动重试会重新计数）。 */
const MAX_AUTO_APPLY_ATTEMPTS = 2

function applyPendingAtStartup() {
  pending = readJson(PENDING_JSON(), null)
  if (!pending || !fs.existsSync(path.join(STAGING_DIR(), 'app.asar'))) {
    // 无有效待应用更新：清理崩溃残留的半成品 staging
    rmrf(STAGING_DIR())
    try { fs.unlinkSync(PENDING_JSON()) } catch { /* ignore */ }
    return false
  }
  const attempts = Number(pending.autoApplyAttempts || 0)
  if (attempts >= MAX_AUTO_APPLY_ATTEMPTS) {
    console.warn('[更新] 待应用更新连续自动失败，本次跳过自动应用（可在设置中手动重试）')
    return false
  }
  pending.autoApplyAttempts = attempts + 1
  writeJson(PENDING_JSON(), pending)
  const ok = spawnUpdater()
  if (!ok) return false
  restartForUpdate() // 写标志 + 退出；updater 应用后自动重启到新版本
  return true
}

function getPending() {
  if (!pending) pending = readJson(PENDING_JSON(), null)
  return pending
}

function consumeLastApplied() {
  const info = readJson(LAST_APPLIED_JSON(), null)
  try { fs.unlinkSync(LAST_APPLIED_JSON()) } catch { /* ignore */ }
  return info
}

function setupUpdateIPC(ipcMain, getMainWindow = () => null, isTrustedEvent = null) {
  const trusted = isTrustedEvent || ((event) => {
    const mainWindow = getMainWindow()
    return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame)
  })
  const rejectUntrusted = () => ({ success: false, error: '不允许的更新请求来源' })
  /**
   * 从渲染层提交的更新载荷解析出 (urls, sha256)。
   * 优先路径：载荷是签名清单对象本身，或包了一层的 { manifest }（渲染层直传检查结果）→
   * 验签后取产物，返回统一形状 { version, install, hot }（install/hot 均可为 null）；
   * 兼容路径：载荷是 { urls, sha256 } 裸结构 → 仍走 URL 白名单校验，但打包版
   * （app.isPackaged）拒绝——生产环境必须走签名清单，开发模式豁免。
   */
  const resolveDownloadSpec = (payload) => {
    const manifestSource = payload && typeof payload === 'object' && payload.manifest && typeof payload.manifest === 'object'
      ? payload.manifest
      : payload
    if (manifestSource && typeof manifestSource === 'object' && manifestSource.manifestSignature) {
      const signed = extractSignedArtifacts(manifestSource)
      if (!signed) return { error: '更新清单签名无效，已拒绝下载' }
      return signed
    }
    if (app.isPackaged) {
      return { error: '当前版本要求签名更新清单（manifestSignature 缺失）' }
    }
    const urls = Array.isArray(payload?.urls) ? payload.urls.map(String).filter(Boolean) : []
    const sha256 = String(payload?.sha256 || '')
    if (!urls.length || !SHA256_RE.test(sha256)) return { error: '更新载荷缺少有效的地址或校验值' }
    return { urls, sha256 }
  }
  // 后台下载：立即返回，进度/结果经事件广播（下载期间应用完全可用）
  ipcMain.handle('update:download-background', async (event, payload) => {
    if (!trusted(event)) return rejectUntrusted()
    const spec = resolveDownloadSpec(payload)
    if (spec.error) return { success: false, error: spec.error }
    // 热更新包取清单的 win-x64-hot 产物；签名清单分支的 spec.urls 不存在
    const hot = spec.hot || spec
    return startBackgroundDownload(String(payload?.version || spec.version || ''), String(payload?.notes || ''), hot.urls, hot.sha256)
  })
  // 就绪后：拉起 updater（不退出；由 restart-for-update 决定何时退出重启）
  ipcMain.handle('update:apply-pending', (event) => trusted(event) ? { success: spawnUpdater() } : rejectUntrusted())
  // 立即重启：写重启标志 + 退出，updater 换完文件自动重启
  ipcMain.handle('update:restart-for-update', (event) => {
    if (!trusted(event)) return rejectUntrusted()
    restartForUpdate()
    return { success: true }
  })
  // 查询待应用更新（设置区常驻提示用）
  ipcMain.handle('update:get-pending', (event) => trusted(event) ? getPending() : null)
  // 更新后首次启动的「更新日志」（读取即清除）
  ipcMain.handle('update:consume-last-applied', (event) => trusted(event) ? consumeLastApplied() : null)
  // 完整安装包兜底（改动大、无热更新产物时）。载荷必须是签名清单对象；
  // 开发模式豁免为 { urls, sha256 }（与旧调用兼容）。
  ipcMain.handle('update:download-and-install', async (event, payload) => {
    if (!trusted(event)) return rejectUntrusted()
    const spec = resolveDownloadSpec(payload)
    if (spec.error) return { success: false, error: spec.error }
    const install = spec.install || spec
    const downloadDir = UPDATE_DIR()
    try { fs.mkdirSync(downloadDir, { recursive: true }) } catch (e) { return { success: false, error: `无法创建下载目录：${e?.message || e}` } }
    const destPath = path.join(downloadDir, `WaveForge-Setup-${Date.now()}.exe`)
    const result = await downloadToFile(install.urls, destPath, install.sha256, '更新安装包')
    if (!result.success) return result
    const { shell } = require('electron')
    try {
      const opened = await shell.openPath(destPath)
      if (opened) return { success: false, error: `无法打开安装向导：${opened}` }
      return { success: true, path: destPath }
    } catch (err) {
      return { success: false, error: `无法打开安装向导：${err?.message || err}` }
    }
  })
}

module.exports = {
  setupUpdateIPC,
  applyPendingAtStartup,
  downloadToFile,
  isAllowedUpdateUrl,
  validateUpdateRequest,
  assertSafeZipEntries,
  verifyManifestSignature,
  verifyManifestSignatureWithKey,
  setManifestPublicKeyForTest,
  stableStringify,
}

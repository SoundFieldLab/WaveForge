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
const APPLIER_DST = () => path.join(UPDATE_DIR(), 'apply-update.cjs')

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

/** 多源下载（代理会话 + sha256 校验 + 背压写盘），onProgress({received,total}) 可选 */
function downloadToFile(urls, destPath, expectedSha = '', label = '下载', onProgress = null) {
  const list = Array.isArray(urls) ? urls : [urls]
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
        const request = proxySession ? net.request({ url, session: proxySession }) : net.request(url)
        const hash = crypto.createHash('sha256')
        const writeStream = fs.createWriteStream(destPath)
        let settled = false
        let finished = false
        let lastEmit = 0
        const fail = (err) => {
          // 磁盘写失败 / HTTP 失败时关闭写流，避免句柄泄漏与无监听 stream error 崩溃主进程
          if (!finished) { finished = true; writeStream.destroy() }
          if (!settled) { settled = true; rejectReq(err) }
        }
        writeStream.on('error', fail)
        request.on('response', (response) => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            fail(new Error(`HTTP ${response.statusCode}`))
            return
          }
          const total = Number(response.headers['content-length'] || 0)
          let received = 0
          response.on('data', (chunk) => {
            hash.update(chunk)
            received += chunk.length
            if (!writeStream.write(chunk)) {
              response.pause()
              writeStream.once('drain', () => response.resume())
            }
            // 进度回调限频（约每 300ms 一次，避免 IPC 风暴）
            const now = Date.now()
            if (onProgress && now - lastEmit >= 300) {
              lastEmit = now
              onProgress({ received, total })
            }
          })
          response.on('end', () => {
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
async function startBackgroundDownload(version, notes, urls, expectedSha) {
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
    new (require('adm-zip'))(zipPath).extractAllTo(STAGING_DIR(), true)
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
  // 若有旧 updater 在等待，先结束它（避免重复应用/应用旧 staging）
  if (activeUpdaterPid) {
    try { process.kill(activeUpdaterPid) } catch { /* ignore */ }
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

/** 用户确认立即重启：写重启标志后退出，updater 换完文件会自动重启 */
function restartForUpdate() {
  writeJson(RELAUNCH_FLAG(), { at: Date.now() })
  setTimeout(() => { app.exit(0) }, 300)
}

/** 启动时：若存在待应用更新（上次「稍后」/ 更新中断），自动应用并重启一次 */
function applyPendingAtStartup() {
  pending = readJson(PENDING_JSON(), null)
  if (!pending || !fs.existsSync(path.join(STAGING_DIR(), 'app.asar'))) {
    // 无有效待应用更新：清理崩溃残留的半成品 staging
    rmrf(STAGING_DIR())
    try { fs.unlinkSync(PENDING_JSON()) } catch { /* ignore */ }
    return false
  }
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

function setupUpdateIPC(ipcMain) {
  // 后台下载：立即返回，进度/结果经事件广播（下载期间应用完全可用）
  ipcMain.handle('update:download-background', async (_e, payload) => {
    const { version, notes, urls, sha256 } = payload || {}
    if (!Array.isArray(urls) || !urls.length) return { success: false, error: '缺少下载地址' }
    return startBackgroundDownload(String(version || ''), String(notes || ''), urls, String(sha256 || ''))
  })
  // 就绪后：拉起 updater（不退出；由 restart-for-update 决定何时退出重启）
  ipcMain.handle('update:apply-pending', () => ({ success: spawnUpdater() }))
  // 立即重启：写标志 + 退出，updater 换完文件自动重启
  ipcMain.handle('update:restart-for-update', () => { restartForUpdate(); return { success: true } })
  // 查询待应用更新（设置区常驻提示用）
  ipcMain.handle('update:get-pending', () => getPending())
  // 更新后首次启动的「更新日志」（读取即清除）
  ipcMain.handle('update:consume-last-applied', () => consumeLastApplied())
  // 完整安装包兜底（改动大、无热更新产物时）
  ipcMain.handle('update:download-and-install', async (_e, urls, expectedSha) => {
    const downloadDir = UPDATE_DIR()
    try { fs.mkdirSync(downloadDir, { recursive: true }) } catch (e) { return { success: false, error: `无法创建下载目录：${e?.message || e}` } }
    const destPath = path.join(downloadDir, `WaveForge-Setup-${Date.now()}.exe`)
    const result = await downloadToFile(urls, destPath, expectedSha, '更新安装包')
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

module.exports = { setupUpdateIPC, applyPendingAtStartup, downloadToFile }

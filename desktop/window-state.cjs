/**
 * 主窗口状态记忆：记住用户上次关闭时的窗口大小/位置/状态（窗口化 | 最大化 | 全屏覆盖任务栏）
 * 以及所在显示器，下次启动恢复。
 *
 * 通过"关于 → 检查更新"更新安装后（app 版本号变化），下一次打开恢复为
 * 主屏幕 + 软件默认大小（1400×900）。
 *
 * 存储：userData/window-state.json
 * 字段：
 *   version   — 保存时的 app.getVersion()；与当前版本不一致 = 更新过 → 忽略记录
 *   displayId — 窗口所在显示器 id（screen.getDisplayMatching(bounds).id）
 *   bounds    — 窗口化时的位置与大小（getNormalBounds，最大化/全屏时也是还原后的尺寸）
 *   state     — 'normal' | 'maximized' | 'kiosk'
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 900
const MIN_WIDTH = 1200
const MIN_HEIGHT = 800

function stateFile(app) {
  return path.join(app.getPath('userData'), 'window-state.json')
}

/** 读取窗口状态；文件缺失/损坏/版本已变化（更新过）时返回 null（走默认布局）。 */
function loadWindowState(app) {
  try {
    const file = stateFile(app)
    if (!fs.existsSync(file)) return null
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    // 版本号不一致 = 应用更新过：不恢复旧窗口布局，回到主屏 + 默认大小
    if (String(raw.version) !== String(app.getVersion())) return null
    if (!['normal', 'maximized', 'kiosk'].includes(raw.state)) return null
    const b = raw.bounds
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.width !== 'number' || typeof b.height !== 'number') return null
    return { displayId: raw.displayId, bounds: b, state: raw.state }
  } catch {
    return null
  }
}

/** 把窗口 bounds 钳制进指定显示器的工作区（防止窗口落在屏幕外/分辨率变化后不可见）。 */
function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.max(MIN_WIDTH, Math.min(bounds.width, workArea.width))
  const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, workArea.height))
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/** 保存窗口状态（静默失败：userData 不可写等场景不影响使用）。 */
function saveWindowState(app, mainWindow, screen) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bounds = mainWindow.getNormalBounds()
    const state = mainWindow.isKiosk()
      ? 'kiosk'
      : mainWindow.isMaximized()
        ? 'maximized'
        : 'normal'
    let displayId = null
    try {
      displayId = screen.getDisplayMatching(bounds).id
    } catch {
      // ignore
    }
    const file = stateFile(app)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: app.getVersion(), displayId, bounds, state }, null, 2))
  } catch {
    // ignore
  }
}

module.exports = { loadWindowState, saveWindowState, clampBoundsToWorkArea, DEFAULT_WIDTH, DEFAULT_HEIGHT }

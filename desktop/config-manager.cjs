const fs = require('fs')
const path = require('path')

class ConfigManager {
  constructor(app) {
    this.app = app
    this.configPath = path.join(app.getPath('userData'), 'config.json')
    this.config = this.loadConfig()
    // 仅当配置与默认值有差异时才落盘：config.json 缺失/无效时 loadConfig 返回默认路径，
    // 此时跳过启动期的无谓写入（原来每次启动都会无条件重写 config.json）。
    if (this.config.cachePath !== this.getDefaultCachePath()) this.saveConfig()
  }

  getDefaultCachePath() {
    // 默认缓存跟应用走（大文件不塞 C 盘——音频/分析/分轨等可再生的 GB 级数据）：
    // dev = 项目根 cache\；打包 = exe 所在目录 cache\（NSIS 默认装 D 盘等自定义目录时
    // 缓存随盘）。exe 目录不可写（Program Files 需提权）→ 退回 userData cache（旧默认，
    // 保证可用性优先于位置偏好）。用户显式设置的 cachePath（config.json）恒优先。
    const appDir = this.app.isPackaged
      ? path.dirname(this.app.getPath('exe'))
      : path.resolve(__dirname, '..')
    const portableCache = path.join(appDir, 'cache')
    try {
      fs.mkdirSync(portableCache, { recursive: true })
      fs.accessSync(portableCache, fs.constants.W_OK)
      // 写探针：accessSync 对只读目录挂载点可能误报，真实写一次确认
      const probe = path.join(portableCache, `.write-probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      return portableCache
    } catch {
      return path.join(this.app.getPath('userData'), 'cache')
    }
  }

  /** 历史默认缓存位置（loadConfig 据此识别「未自定义」的旧路径，迁移时也据此找旧数据） */
  getLegacyDefaultCachePaths() {
    const paths = [path.join(this.app.getPath('userData'), 'cache')]
    // 迁移前的旧版默认（exe 目录/项目根）也在列表里：用户从旧版升级且缓存还在老位置时，
    // loadConfig 不把它当「显式自定义」吞掉，启动迁移才能把它搬到新默认位置。
    paths.push(path.join(path.dirname(this.app.getPath('exe')), 'cache'))
    paths.push(path.resolve(__dirname, '..', 'cache'))
    return paths.map(value => path.resolve(value))
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8')
        const parsed = JSON.parse(data)
        const configuredPath = typeof parsed?.cachePath === 'string' ? parsed.cachePath.trim() : ''
        if (configuredPath && path.isAbsolute(configuredPath)) {
          const resolved = path.resolve(configuredPath)
          if (!this.getLegacyDefaultCachePaths().includes(resolved)) return { cachePath: resolved }
        }
      }
    } catch (error) {
      console.error('Failed to load config:', error)
    }
    
    return { cachePath: this.getDefaultCachePath() }
  }

  saveConfig() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
      const temporaryPath = `${this.configPath}.tmp`
      fs.writeFileSync(temporaryPath, JSON.stringify(this.config, null, 2), 'utf8')
      fs.renameSync(temporaryPath, this.configPath)
      return true
    } catch (error) {
      console.error('Failed to save config:', error)
      return false
    }
  }

  getCachePath() {
    return this.config.cachePath
  }

  setCachePath(newPath) {
    if (typeof newPath !== 'string' || !newPath.trim() || !path.isAbsolute(newPath.trim())) return false
    const resolved = path.resolve(newPath.trim())
    fs.mkdirSync(resolved, { recursive: true })
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK)
    this.config.cachePath = resolved
    return this.saveConfig()
  }

  getConfig() {
    return { ...this.config }
  }
}

/**
 * 缓存目录迁移（两阶段：先全量复制、全部成功后才删源）。用于 ① 启动时旧默认位置 →
 * 新默认位置的一次性搬迁；② 用户 selectCachePath 改路径后的现场迁移。
 * 前置条件由调用方判断（旧有数据、新位置为空）；并发防护用 O_EXCL 哨兵锁。
 * 任一环节失败：旧数据原地保留（可重试），返回 { migrated: false, error }。
 */
function migrateCacheDir(legacyPath, newPath) {
  const fsSync = fs
  const lockPath = path.join(path.dirname(newPath), `.cache-migrate-${path.basename(newPath)}.lock`)
  let lockFd = null
  try {
    fsSync.mkdirSync(path.dirname(newPath), { recursive: true })
    try {
      lockFd = fsSync.openSync(lockPath, 'wx')
    } catch {
      return { migrated: false, error: 'another migration in progress' }
    }
    const legacyHasContent = (() => {
      try { return fsSync.readdirSync(legacyPath).some((n) => n !== 'cache-index.json') } catch { return false }
    })()
    if (!legacyHasContent) return { migrated: false, error: 'legacy empty' }
    const newIsEmpty = (() => {
      try { return !fsSync.existsSync(newPath) || fsSync.readdirSync(newPath).length === 0 } catch { return false }
    })()
    if (!newIsEmpty) return { migrated: false, error: 'destination not empty' }
    try {
      fsSync.renameSync(legacyPath, newPath)
      return { migrated: true, method: 'rename' }
    } catch {
      // 跨盘：EXDEV 等 → 两阶段复制
      fsSync.mkdirSync(newPath, { recursive: true })
      const copied = []
      for (const entry of fsSync.readdirSync(legacyPath, { withFileTypes: true })) {
        const from = path.join(legacyPath, entry.name)
        const to = path.join(newPath, entry.name)
        if (entry.isDirectory()) fsSync.cpSync(from, to, { recursive: true })
        else fsSync.copyFileSync(from, to)
        copied.push({ from, isDir: entry.isDirectory() })
      }
      for (const { from } of copied) {
        try { fsSync.rmSync(from, { recursive: true, force: true }) } catch { /* 残留无害，下次重试 */ }
      }
      return { migrated: true, method: 'copy' }
    }
  } catch (error) {
    return { migrated: false, error: error?.message || String(error) }
  } finally {
    if (lockFd != null) { try { fsSync.closeSync(lockFd) } catch {} }
    try { fsSync.rmSync(lockPath, { force: true }) } catch {}
  }
}

/** 音频缓存索引的 filePath 迁移改写：旧索引条目的绝对路径（指向旧缓存位置）重写为相对
 *  文件名（新版索引格式，加载时按新 tempRoot 拼回）。不改写的话 loadCacheIndex 的
 *  tempRoot 校验会把全部条目过滤掉 → 音频文件成孤儿被 cleanupOldFiles 删除（实测丢
 *  125 个音频）。无法映射到新位置的条目清空 filePath（由清理逻辑自然淘汰）。 */
function rewriteAudioCacheIndexPath(newCachePath, legacyCachePath) {
  try {
    const indexPath = path.join(newCachePath, 'temp', 'cache-index.json')
    if (!fs.existsSync(indexPath)) return 0
    const items = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (!Array.isArray(items)) return 0
    const newTempRoot = path.join(newCachePath, 'temp')
    let rewritten = 0
    for (const item of items) {
      if (typeof item.filePath !== 'string' || !item.filePath) continue
      if (!path.isAbsolute(item.filePath)) continue
      const resolved = path.resolve(item.filePath)
      if (legacyCachePath && resolved.toLowerCase().startsWith(legacyCachePath.toLowerCase() + path.sep)) {
        item.filePath = path.relative(newTempRoot, path.join(newTempRoot, path.basename(resolved)))
        rewritten++
      } else {
        item.filePath = ''
        rewritten++
      }
    }
    if (rewritten > 0) fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf8')
    return rewritten
  } catch {
    return 0
  }
}

module.exports = { ConfigManager, migrateCacheDir, rewriteAudioCacheIndexPath }

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
    return path.join(this.app.getPath('userData'), 'cache')
  }

  getLegacyDefaultCachePaths() {
    return [
      path.join(__dirname, '..', 'cache'),
      path.join(path.dirname(this.app.getPath('exe')), 'cache'),
    ].map(value => path.resolve(value))
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

module.exports = { ConfigManager }

/**
 * 热更新执行器：由主进程以 `ELECTRON_RUN_AS_NODE=1 <应用exe> <本文件>` 方式 detached 拉起，
 * 常驻等待应用进程退出后替换 resources/app.asar 与 app.asar.unpacked。
 *
 * 重启语义（对标主流桌面软件「退出即应用」）：
 *   - 主进程「立即重启」会先写 relaunch-request.json 再退出 → 本脚本换完文件后自动重启；
 *   - 「稍后重启」/ 用户正常退出时不写该标志 → 只换文件不自动重启，下次手动启动即是新版本。
 *
 * 仅依赖 node 内置模块（fs/path/child_process），不依赖 electron。
 * 配置经环境变量 WAVEFORGE_UPDATE_CONFIG 传入；完成后自清理（暂存目录、自身、pending 标记）。
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

let config = {}
try { config = JSON.parse(process.env.WAVEFORGE_UPDATE_CONFIG || '{}') } catch { /* ignore */ }
const waitPid = Number(process.env.WAVEFORGE_UPDATE_WAIT_PID || 0)
// 错误日志放暂存目录外（userData/update），避免随暂存清理被一起删掉
const logPath = path.join(path.dirname(config.stagingDir || '.'), 'updater-error.log')

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } }

/** 轮询等待父进程退出（不限时：用户可能选「稍后」长时间不退出，保持常驻等待） */
function waitParentExit() {
  if (!waitPid) return Promise.resolve()
  return new Promise((resolve) => {
    const tick = () => {
      try {
        process.kill(waitPid, 0) // 进程仍存在 → 继续等
        setTimeout(tick, 300)
      } catch {
        resolve() // 进程已退出
      }
    }
    tick()
  })
}

function relaunchIfRequested() {
  if (!config.relaunchFlag || !fs.existsSync(config.relaunchFlag)) return // 稍后重启/正常退出：不自动重启
  try { fs.unlinkSync(config.relaunchFlag) } catch { /* ignore */ }
  if (!config.appExe || !fs.existsSync(config.appExe)) return
  // 关键：去掉 ELECTRON_RUN_AS_NODE，否则重启的应用会以 node 模式运行
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try { spawn(config.appExe, [], { detached: true, stdio: 'ignore', env }).unref() } catch { /* ignore */ }
}

/** 更新成功落盘：供渲染进程首次启动弹「更新日志」 */
function writeLastApplied() {
  if (!config.lastAppliedJson) return
  try {
    fs.mkdirSync(path.dirname(config.lastAppliedJson), { recursive: true })
    fs.writeFileSync(config.lastAppliedJson, JSON.stringify({ version: config.version || '', notes: config.notes || '', appliedAt: Date.now() }, null, 2))
  } catch { /* ignore */ }
}

async function main() {
  try {
    await waitParentExit()
    const { resourcesDir, stagingDir } = config
    if (!resourcesDir || !stagingDir || !fs.existsSync(path.join(stagingDir, 'app.asar'))) {
      throw new Error('更新配置无效或暂存包缺失')
    }
    const asarDst = path.join(resourcesDir, 'app.asar')
    const bakPath = path.join(resourcesDir, 'app.asar.bak')
    const unpackedSrc = path.join(stagingDir, 'app.asar.unpacked')
    const unpackedDst = path.join(resourcesDir, 'app.asar.unpacked')
    // 备份当前 asar（保留一个 .bak 供手动回滚），替换失败可恢复
    try { if (fs.existsSync(asarDst)) fs.copyFileSync(asarDst, bakPath) } catch { /* 备份失败不阻断 */ }
    // 替换 app.asar
    fs.copyFileSync(path.join(stagingDir, 'app.asar'), asarDst)
    // 整体替换 app.asar.unpacked（worker/服务 .py 等解包文件）
    if (fs.existsSync(unpackedSrc)) {
      rmrf(unpackedDst)
      fs.mkdirSync(path.dirname(unpackedDst), { recursive: true })
      fs.cpSync(unpackedSrc, unpackedDst, { recursive: true })
    }
    writeLastApplied()
    relaunchIfRequested()
  } catch (error) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, String((error && error.stack) || error))
    } catch { /* ignore */ }
    // 失败也尝试按标志重启（仍是旧版本），用户可再次检查更新
    relaunchIfRequested()
  } finally {
    rmrf(config.stagingDir)
    rmrf(path.join(path.dirname(config.stagingDir || '.'), 'pending-update.json'))
    rmrf(__filename)
  }
}

main()

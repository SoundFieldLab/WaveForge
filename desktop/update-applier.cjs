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
try {
  if (config.stagingDir) fs.writeFileSync(`${config.stagingDir}.pid`, String(process.pid), 'utf8')
} catch { /* ignore */ }
// 错误日志放暂存目录外（userData/update），避免随暂存清理被一起删掉
const logPath = path.join(path.dirname(config.stagingDir || '.'), 'updater-error.log')
// 自证身份文件（<staging>.pid）：父进程 kill 旧 updater 前校验 PID 归属，防 Windows
// PID 复用误杀无关进程。父进程崩溃来不及写时由这里补写。

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
  let applied = false
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
    const unpackedBakPath = path.join(resourcesDir, 'app.asar.unpacked.bak')
    // 替换顺序「先 unpacked 后 asar」+ 各自 rename 进位/回滚：保证任何中断点上
    // 旧版本完整可启动。此前 unpacked 走 rmrf+cpSync（中途失败 → 新 asar 已就位而
    // unpacked 残缺，worker .py 丢失 → 主进程 require 阶段起不来且无自动恢复）。
    // 1) unpacked：旧目录 rename 成 .bak → staging rename 进位 → 失败回滚
    let unpackedSwapped = false
    if (fs.existsSync(unpackedSrc)) {
      const hadOld = fs.existsSync(unpackedDst)
      try { if (hadOld) fs.renameSync(unpackedDst, unpackedBakPath) } catch { /* 备份失败不阻断 */ }
      try {
        fs.renameSync(unpackedSrc, unpackedDst)
        unpackedSwapped = true
      } catch (error) {
        try { if (hadOld && !fs.existsSync(unpackedDst)) fs.renameSync(unpackedBakPath, unpackedDst) } catch { /* ignore */ }
        throw error
      }
    } else {
      unpackedSwapped = true // 无 unpacked 更新（老版本包）：无中断点
    }
    // 2) asar：旧 asar rename 成 .bak → 新 asar rename 进位 → 失败回滚（且恢复 unpacked）
    try { if (fs.existsSync(asarDst)) fs.renameSync(asarDst, bakPath) } catch { /* 备份失败不阻断 */ }
    try {
      fs.renameSync(path.join(stagingDir, 'app.asar'), asarDst)
    } catch (error) {
      // 新 asar 进位失败：回滚旧 asar + 旧 unpacked，保持应用可启动
      try { if (fs.existsSync(bakPath) && !fs.existsSync(asarDst)) fs.renameSync(bakPath, asarDst) } catch { /* ignore */ }
      if (unpackedSwapped && fs.existsSync(unpackedBakPath)) {
        try { rmrf(unpackedDst); fs.renameSync(unpackedBakPath, unpackedDst) } catch { /* ignore */ }
      }
      throw error
    }
    // 3) 两边都成功：删除备份（成功后不再需要；留着会让 resources 持续膨胀几十 MB）
    try { if (fs.existsSync(bakPath)) fs.rmSync(bakPath, { force: true }) } catch { /* ignore */ }
    try { if (fs.existsSync(unpackedBakPath)) rmrf(unpackedBakPath) } catch { /* ignore */ }
    applied = true
    writeLastApplied()
    relaunchIfRequested()
  } catch (error) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, String((error && error.stack) || error))
    } catch { /* ignore */ }
    // 替换失败时不再按 relaunch 标志自动重启：父进程启动计数已 +1 并写回 pending,
    // 若这里仍按标志重启,会立即触发下一次「自动应用→失败→重启」死循环。
    // （成功路径的 relaunchIfRequested 在上方,不受影响。）
  } finally {
    if (applied) {
      // 成功才清理暂存与 pending 标记；失败时保留，下次启动 applyPendingAtStartup 重试
      rmrf(config.stagingDir)
      try { fs.rmSync(`${config.stagingDir}.pid`, { force: true }) } catch { /* ignore */ }
      rmrf(path.join(path.dirname(config.stagingDir || '.'), 'pending-update.json'))
      rmrf(__filename)
    } else if (config.relaunchFlag && fs.existsSync(config.relaunchFlag)) {
      // 失败时清掉重启标志：留着它，下次用户正常退出也会被误当成「更新后自动重启」
      try { fs.unlinkSync(config.relaunchFlag) } catch { /* ignore */ }
    }
  }
}

main()

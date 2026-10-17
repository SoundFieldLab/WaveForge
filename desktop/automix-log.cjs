const fs = require('fs')
const path = require('path')

const LOG_MAX_BYTES = 5 * 1024 * 1024

let logPath = null
let dirEnsured = false
// 写链串行化：异步 stat→(rename)→appendFile 并发调用会交错行序/双轮转，
// 用尾接尾的 promise 链保证每次写入按调用顺序落盘（与旧同步版语义一致）。
let writeChain = Promise.resolve()

function init(app) {
  if (!app || !app.getPath) return
  try {
    logPath = path.join(app.getPath('userData'), 'automix-backend.log')
  } catch {
    logPath = null
  }
  // 启动即写入首行：确保日志文件一定存在，便于确认应用跑的是含日志的代码
  automixLog('init', `automix log initialized, userData=${logPath || 'unknown'}`)
}

function automixLog(scope, message) {
  // 渲染层可控字段（trackKey/url 等）可能内含换行，原样落盘会伪造独立日志条目
  //（如把 "analysis:fail" 行伪装成 "analysis:ok"）。拍平成单行。
  const flat = String(message).replace(/[\r\n]+/g, ' | ')
  const line = `[${new Date().toISOString()}] [AutoMix-Backend][${scope}] ${flat}`
  console.log(line)
  if (logPath) {
    // 异步追加：渲染 worker stdout 逐行触发本函数，渲染期间高频同步写（statSync+mkdirSync+
    // appendFileSync）会间歇卡主进程事件循环。目录只需建一次；轮转的 stat 也走异步链。
    if (!dirEnsured) {
      dirEnsured = true
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch {}
    }
    const target = logPath
    writeChain = writeChain.then(() =>
      fs.promises.stat(target).then(stat => {
        if (stat.size <= LOG_MAX_BYTES) return
        const oldPath = target + '.old'
        return fs.promises.rm(oldPath, { force: true }).then(() => fs.promises.rename(target, oldPath))
      }).then(() => fs.promises.appendFile(target, line + '\n'))
    ).catch(() => {
      // 日志写入失败不影响主流程
    })
  }
}

function getLogPath() {
  return logPath
}

module.exports = { init, automixLog, log: automixLog, getLogPath }

// desktop/crashLog.cjs
// 应用崩溃时同步写一个文件，并告诉用户它去了哪。
// 刻意独立于任何 opt-in 的运行日志：那些默认关闭、有缓冲——对「没人有第二次机会记录」的
// 崩溃事件来说恰好全错。这里同步写、总是写、只在真的出事时写。
//
// 覆盖面：process.on('uncaughtException') / 'unhandledRejection'（后者只在 Node 侧，
// 渲染层的异常另有 console 与 window.onerror 渠道）；以及 renderer-gone / child-process-gone
// 这类 Electron 进程事件的接线在 main.cjs。
//
// 保留 KEEP_FILES 份，写新的清旧的。报告崩溃时再崩溃不循环：第二个照写但不播报。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/** How many crash files to keep. Old ones go when a new one is written. */
const KEEP_FILES = 20;
/** A crash while reporting a crash must not loop; the second one is written but not announced. */
let isReporting = false;

const stamp = (at = new Date()) => at.toISOString().replace(/[:.]/g, '-');

/** Confirms a directory can actually be written to, rather than trusting that it exists. */
const isWritableDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
};

const describeError = (error) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? '(no stack)'}`;
  }
  return String(error ?? 'unknown');
};

/**
 * 写一份崩溃报告。返回文件路径；目录不可写时返回 null（尽量不抛——崩溃路径上抛错会把
 * 原始异常顶掉）。
 */
function writeCrashLog({ crashDir, kind, error, extra = {} }) {
  if (typeof crashDir !== 'string' || !crashDir) return null;
  if (!isWritableDir(crashDir)) return null;
  try {
    const file = path.join(crashDir, `crash-${stamp()}.log`);
    const payload = [
      `kind: ${kind}`,
      `at: ${new Date().toISOString()}`,
      `app: ${app?.getVersion?.() ?? 'unknown'} (electron ${process.versions.electron}, node ${process.versions.node}, chrome ${process.versions.chrome})`,
      `platform: ${process.platform} ${process.arch}, os ${os.release()}`,
      `uptime: ${Math.round(process.uptime())}s`,
      ...Object.entries(extra).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`),
      '',
      describeError(error),
      '',
    ].join('\n');
    fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    pruneOld(crashDir);
    return file;
  } catch {
    return null;
  }
}

function pruneOld(crashDir) {
  try {
    const files = fs.readdirSync(crashDir)
      .filter(name => /^crash-\d{4}-\d{2}-\d{2}T/.test(name))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      fs.rmSync(path.join(crashDir, name), { force: true });
    }
  } catch { /* 清理失败不影响本次报告 */ }
}

/**
 * 装上全局崩溃钩子。返回最近一次崩溃报告的路径（未崩溃为 null），设置页可以指路。
 * announce(messages)：崩溃后怎么告诉用户（弹窗/托盘通知），由 main.cjs 注入——
 * 崩溃路径上弹窗本身可能失败，所以这里只调用不等待。
 */
function installCrashLog({ crashDir, announce } = {}) {
  let lastReportPath = null;
  const report = (kind, error, extra) => {
    const file = writeCrashLog({ crashDir, kind, error, extra });
    if (file) lastReportPath = file;
    if (file && !isReporting) {
      isReporting = true;
      try { announce?.(file); } catch { /* 播报失败不循环 */ }
      isReporting = false;
    }
    return file;
  };

  process.on('uncaughtException', (error) => {
    report('uncaughtException', error);
    // 不退出：Electron 主进程的 uncaughtException 多数来自单个 IPC 异步链，
    // 闪退比带着一个写好的崩溃日志继续跑更伤害用户。真不可恢复的场景由 Electron 自己崩，
    // 那时这个文件已经在盘上。
  });
  process.on('unhandledRejection', (reason) => {
    report('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  return {
    report,
    get lastReportPath() { return lastReportPath; },
  };
}

module.exports = { installCrashLog, writeCrashLog, KEEP_FILES };

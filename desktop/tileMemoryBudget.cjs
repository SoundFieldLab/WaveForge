// desktop/tileMemoryBudget.cjs
// 渲染进程的 GPU 瓦片内存预算，按屏幕尺寸抬高 Chromium 默认值。
//
// Chromium 按网页场景给 GPU 内存（blink GetGpuMemoryPolicy: 1152MB × 屏幕像素 /
// (2056×1329×4)，至少 512MB，至多 RAM 的四分之一）：4K 屏约 874MB。音乐播放器切歌时
// 会同时持有两张全窗口背景与歌词层；超出预算时 Chromium 会把整层丢出画面——表现为
// 「色块闪烁」。播放器显示期间瓦片池保留已释放的瓦片复用，占用贴近预算；窗口隐藏时归还。
//
// folia 的口径：每像素系数翻倍（仍至少 512MB、至多 RAM/4）。1080p 屏维持 Chromium 的
// 512MB（它的小图层本来就够）；4K 屏拿到约 1748MB。
const SWITCH = 'force-gpu-mem-available-mb';
const MB = 1024 * 1024;
const HEADROOM = 2;

/** Folia 的预算（MB），给定屏幕物理像素数与总内存字节数。 */
function raisedTileBudgetMb(screenPixels, totalMemBytes) {
  const scaled = (1152 * screenPixels) / (2056 * 1329 * 4);
  return Math.round(Math.min(Math.max(scaled * HEADROOM, 512), totalMemBytes / MB / 4));
}

/**
 * 给最大的屏幕设预算。必须在 ready 之后（screen 模块要它）、第一个窗口创建之前调用：
 * 渲染进程启动时复制一次开关。命令行显式传入的值优先（用户自行调优不被覆盖）。
 * 返回是否写入了开关（未写：已有命令行值 / 无 screen 模块）。
 */
function applyTileMemoryBudget({ screen, totalMemBytes = require('node:os').totalmem(), appendSwitch, commandLine }) {
  if (!screen || typeof screen.getPrimaryDisplay !== 'function') return false;
  // 命令行已带该开关（用户/启动参数显式指定）时不覆盖
  if (commandLine?.hasSwitch?.(SWITCH)) return false;
  const display = screen.getPrimaryDisplay();
  const width = display.width ?? display.bounds?.width ?? 0;
  const height = display.height ?? display.bounds?.height ?? 0;
  const pixels = width * height * ((display.scaleFactor ?? 1) ** 2);
  if (!Number.isFinite(pixels) || pixels <= 0) return false;
  appendSwitch(SWITCH, String(raisedTileBudgetMb(pixels, totalMemBytes)));
  return true;
}

module.exports = { raisedTileBudgetMb, applyTileMemoryBudget, SWITCH };

/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Gapless 无缝衔接 —— 常量与类型
 * 从 useAudioPlayer.ts 抽出的独立模块，供控制器与调用方共享。
 */

export interface GaplessSettings {
  enabled: boolean
  albumGapless: boolean
}

/** Gapless 双 deck 极短等功率淡入淡出（消除数字硬切爆音） */
export const GAPLESS_DECK_FADE_MS = 60

// ── 首选无缝拼接（standby 已缓存就绪时）：头尾都不掐，直接拼接 ──
/** source 结束前静音预启动 standby 的提前量（消除 play() 启动延迟） */
export const GAPLESS_SEAMLESS_PREROLL_SECONDS = 0.08
/** 预启动窗口监测间隔（timeupdate 约 250ms 一次，需更高频定位窗口） */
export const GAPLESS_SEAMLESS_PREROLL_POLL_MS = 40
/** 首选兜底：source 异常未 ended 时，超时后强制回退备选 */
export const GAPLESS_SEAMLESS_TIMEOUT_MS = 600
/** 结束前 20s 开始强制预热下一首（保证首选拼接大概率成功） */
export const GAPLESS_SEAMLESS_WARMUP_SECONDS = 20
/** 预热目标：下一首前 10s 完成缓存 */
export const GAPLESS_SEAMLESS_WARMUP_BUFFER_SECONDS = 10
/** 预热缓冲进度轮询间隔 */
export const GAPLESS_SEAMLESS_WARMUP_POLL_MS = 250
/** 预热硬超时：最坏情况也回拨 0 停住（0 已缓冲即可拼接） */
export const GAPLESS_SEAMLESS_WARMUP_TIMEOUT_MS = 13_000

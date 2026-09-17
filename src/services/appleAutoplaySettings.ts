/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music「自动连播」开关（对齐官网/原生客户端的 ∞ 自动连播）。
 * 开启后：Apple 队列临近播完时，用队列末尾歌曲作为种子创建官方连续电台
 * （POST /v1/me/stations/continuous），并以 next-tracks 持续补曲。
 */

const STORAGE_KEY = 'appleAutoplayEnabled'
export const APPLE_AUTOPLAY_CHANGED_EVENT = 'appleAutoplayChanged'

export function readAppleAutoplayEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'
}

export function persistAppleAutoplayEnabled(value: boolean): void {
  localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  try {
    window.dispatchEvent(new CustomEvent<boolean>(APPLE_AUTOPLAY_CHANGED_EVENT, { detail: value }))
  } catch { /* 无 window 环境（测试）忽略 */ }
}

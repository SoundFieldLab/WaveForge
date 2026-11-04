/**
 * App 内不熄屏（Android FLAG_KEEP_SCREEN_ON）：
 *  - 偏好存 localStorage（默认开启），仅安卓原生桥可用时实际生效；
 *  - 桌面端 no-op（窗口由用户自己管理）；TV 由原生侧直接常亮不走本开关。
 *  - initKeepScreenOn 在应用启动时调用一次，把偏好同步给原生。
 */
import { detectPlatform } from '../platform'

const KEY = 'waveforge:keep-screen-on'

export function getKeepScreenOn(): boolean {
  try {
    const v = localStorage.getItem(KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}

export function setKeepScreenOn(enabled: boolean): void {
  try { localStorage.setItem(KEY, enabled ? '1' : '0') } catch { /* ignore */ }
  applyKeepScreenOn(enabled)
}

/** 把当前偏好应用到原生窗口（桥不存在时静默）。 */
export function applyKeepScreenOn(enabled: boolean = getKeepScreenOn()): void {
  const platform = detectPlatform()
  if (platform !== 'android-phone' && platform !== 'android-tablet' && platform !== 'android-tv') return
  try {
    const native = (window as unknown as { WaveForgeNative?: { setKeepScreenOn?: (v: boolean) => void } }).WaveForgeNative
    native?.setKeepScreenOn?.(enabled)
  } catch { /* 桥不可用忽略 */ }
}

/** 应用启动时调用：把持久化偏好同步给原生（默认开，未设置过也发一次确保生效）。 */
export function initKeepScreenOn(): void {
  applyKeepScreenOn(getKeepScreenOn())
}

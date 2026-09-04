/**
 * API 基址配置。默认 http://localhost:3001/api（桌面与安卓内置 Node 都是本机 3001 端口）。
 * 调试时可写入 localStorage['waveforge:apiBase'] 覆盖（例如指向局域网内的开发服务器）。
 * 注意：登录 cookie 会随请求发送到该地址，请只指向可信服务器。
 */
const DEFAULT_API_BASE = 'http://localhost:3001/api'
const OVERRIDE_KEY = 'waveforge:apiBase'

export function getApiBase(): string {
  try {
    const override = localStorage.getItem(OVERRIDE_KEY)
    if (override && override.trim()) {
      return override.trim().replace(/\/+$/, '')
    }
  } catch {
    // localStorage 不可用时退回默认值
  }
  return DEFAULT_API_BASE
}

export function setApiBaseOverride(url: string | null): void {
  try {
    if (url && url.trim()) {
      localStorage.setItem(OVERRIDE_KEY, url.trim().replace(/\/+$/, ''))
    } else {
      localStorage.removeItem(OVERRIDE_KEY)
    }
  } catch {
    // ignore
  }
}

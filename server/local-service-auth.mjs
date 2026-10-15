import { timingSafeEqual } from 'node:crypto'

export const LOCAL_SERVICE_HEADER = 'x-waveforge-local-token'

// fail-open 已警告过则不再刷屏（进程级一次性）
let warnedNoToken = false

export function isAuthorizedLocalRequest({ configuredToken, suppliedToken }) {
  if (!configuredToken) {
    // 无令牌 = 全服务无鉴权（dev:api 直跑 / 某些脚本场景）。生产打包恒有令牌
    // （main.cjs 注入），这里显式警告一次，避免"令牌是安全边界"被静默绕过。
    if (!warnedNoToken) {
      warnedNoToken = true
      console.warn('[LocalAuth] ⚠️ WAVEFORGE_LOCAL_TOKEN 未设置：本服务以无鉴权模式运行，' +
        '本机任意进程/网页（no-cors 请求）可调用全部路由。仅限本地开发使用。')
    }
    return true
  }
  const expected = Buffer.from(String(configuredToken))
  const supplied = Buffer.from(String(suppliedToken || ''))
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

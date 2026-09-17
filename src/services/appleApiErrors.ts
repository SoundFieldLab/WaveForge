/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music amp-api 错误解读（统一面向用户的失败文案）。
 *
 * 背景：amp-api 的失败原因藏在响应体的 `errors[0]` 里，而 HTTP 状态码往往都是 400/403，
 * 光看状态码无法区分「订阅失效」「未登录」「限流」「接口改了」。此前各处只按状态码拼文案，
 * 于是订阅过期会被误报成「暂未返回可展示的个性化推荐」，把人往错误方向带
 * （实测：订阅到期当天，资料库类接口全部 400，首页却提示"推荐未返回"）。
 *
 * 实测错误体（Apple Music 订阅到期，2026-09）：
 * ```
 * { "errors": [{ "id": "...", "title": "Insufficient Privileges",
 *   "detail": "User's subscription tier does not have access to privilege: CloudLibrary",
 *   "status": "400", "code": "40015", "messageForDisplay": "权限不足" }] }
 * ```
 * 缺的权限随接口不同：CloudLibrary（资料库）、ListeningHistory（最近播放）、
 * UserRatings（喜欢/评分）——都属于「需要有效订阅」的能力。
 */

/** Apple 错误体里我们关心的字段 */
export interface AppleApiErrorInfo {
  /** 服务端 code（如 '40015'） */
  code: string
  /** 服务端 title（如 'Insufficient Privileges'） */
  title: string
  /** 服务端 detail（英文长描述，含缺失的权限名） */
  detail: string
  /** 服务端给用户看的文案（实测中文「权限不足」） */
  messageForDisplay: string
}

/** 从任意响应体里取出第一个 Apple 错误项；没有则返回 null。 */
export function extractAppleApiError(data: unknown): AppleApiErrorInfo | null {
  const first = Array.isArray((data as any)?.errors) ? (data as any).errors[0] : null
  if (!first || typeof first !== 'object') return null
  return {
    code: String(first.code ?? ''),
    title: String(first.title ?? ''),
    detail: String(first.detail ?? ''),
    messageForDisplay: String(first.messageForDisplay ?? ''),
  }
}

/** 「权限不足」错误码：账号的订阅档位不包含该能力所需权限。 */
export const APPLE_INSUFFICIENT_PRIVILEGES_CODE = '40015'

/**
 * 订阅失效的「粘性证据」。
 *
 * 为什么需要：订阅到期后，Apple 对**资料库类**接口会明确返回 40015，
 * 但对**个性化推荐**（listen-now）却是 200 + 空数据——不报错，只是没有内容。
 * 只看单次响应无法判断空结果是"订阅失效"还是"暂时没有推荐"，
 * 因此这里记录一次观察到的 40015，让后续拿到空结果的调用方也能给出准确原因。
 * 带 TTL：订阅续费/重新登录后不该永远背着这个结论。
 */
const SUBSCRIPTION_EVIDENCE_TTL_MS = 5 * 60 * 1000
let subscriptionFailureAt = 0

function noteSubscriptionFailure(): void {
  subscriptionFailureAt = Date.now()
}

/** 最近是否观察到过「订阅失效」。用于解释「200 但空数据」这类无错误码的场景。 */
export function hasRecentAppleSubscriptionFailure(): boolean {
  return subscriptionFailureAt > 0 && Date.now() - subscriptionFailureAt < SUBSCRIPTION_EVIDENCE_TTL_MS
}

/** 清除订阅失效证据（重新登录 / 续费后调用，避免误报）。 */
export function clearAppleSubscriptionFailure(): void {
  subscriptionFailureAt = 0
}

/** 从 detail 里提取缺失的权限名（如 CloudLibrary），仅用于日志与细分提示。 */
export function appleMissingPrivilege(info: AppleApiErrorInfo | null): string {
  if (!info) return ''
  const match = info.detail.match(/privilege:\s*([A-Za-z]+)/)
  return match ? match[1] : ''
}

/**
 * 权限名 → 该权限对应的功能描述（用于告诉用户"哪块用不了"）。
 * 未知权限返回空串，调用方回退到通用文案。
 */
const PRIVILEGE_LABELS: Record<string, string> = {
  CloudLibrary: '资料库',
  ListeningHistory: '最近播放',
  UserRatings: '喜欢与评分',
}

export function applePrivilegeLabel(privilege: string): string {
  return PRIVILEGE_LABELS[privilege] || ''
}

/**
 * 统一的 Apple 请求失败文案。
 *
 * @param status HTTP 状态码（0 = 网络不可达）
 * @param data   响应体（用于读取 errors[0]）
 */
export function describeAppleApiFailure(status: number, data?: unknown): string {
  if (status === 0) return '无法连接 Apple Music，请检查网络后重试'

  const info = extractAppleApiError(data)

  // 订阅档位不足：这是最容易被误判成"接口坏了"的一类，必须说清楚是订阅问题。
  if (info?.code === APPLE_INSUFFICIENT_PRIVILEGES_CODE) {
    // 记录证据：后续拿到「200 但空数据」的调用方据此给出准确原因
    noteSubscriptionFailure()
    const label = applePrivilegeLabel(appleMissingPrivilege(info))
    return label
      ? `Apple Music 订阅已失效，暂时无法使用「${label}」，续订后即可恢复`
      : 'Apple Music 订阅已失效，续订后即可恢复'
  }

  // 其他 Apple 明确的错误：优先用服务端给用户的文案
  if (info?.messageForDisplay) return `Apple Music：${info.messageForDisplay}`
  if (info?.title) return `Apple Music：${info.title}`

  if (status === 401 || status === 403) return 'Apple Music 登录已过期，请重新登录'
  if (status === 429) return 'Apple Music 请求过于频繁，请稍后重试'
  if (status >= 500) return `Apple Music 服务暂时不可用（HTTP ${status}）`
  return `Apple Music 请求失败（HTTP ${status}）`
}

/** 该失败是否属于「订阅失效」（调用方据此决定是否显示续订入口）。 */
export function isAppleSubscriptionFailure(status: number, data?: unknown): boolean {
  return extractAppleApiError(data)?.code === APPLE_INSUFFICIENT_PRIVILEGES_CODE
}

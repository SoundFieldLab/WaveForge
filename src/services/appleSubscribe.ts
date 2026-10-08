// Apple Music 订阅购买入口（传统模式 Apple 客户端复刻的「免费试用」按钮 / 未订阅提示条共用）。
//
// 与官方客户端一致：客户端点订阅会打开自己的购买窗口，其内容就是 Apple 商店的
// finance-app.itunes.apple.com/subscribe（客户端 WebView2 会话缓存里该 URL 与
// buy.itunes getSubscriptionOffersSrv 的请求记录都在，2026-10-08 取证）。
// 桌面端用站内窗口打开（IPC apple-subscribe），Web/TV 回落到系统浏览器。
import { openExternalLink } from '../utils/externalLink'

/** Apple 商店订阅页（客户端购买窗口加载的地址）。 */
export const APPLE_SUBSCRIBE_URL = 'https://finance-app.itunes.apple.com/subscribe'

export function openAppleSubscribeWindow(): void {
  const bridge = (window as unknown as { electron?: { appleSubscribe?: () => Promise<unknown> } }).electron?.appleSubscribe
  if (bridge) {
    void bridge().catch(() => openExternalLink(APPLE_SUBSCRIBE_URL))
    return
  }
  openExternalLink(APPLE_SUBSCRIBE_URL)
}

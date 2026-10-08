// 账号会员级别徽章（超级会员 / VIP=绿钻），各模式账号区共用。
//
// 为什么单独一个模块：QQ 音乐有两级付费会员——绿钻（VIP）与超级会员（SVIP，更高一级，
// 独享杜比全景声/臻品母带4.0/臻品音质2.0）。之前各模式账号区写死「VIP」，超级会员用户
// 看到的仍是 VIP（用户实测截图反馈）。超级会员识别来自登录链路（用户详情 lvinfo 的 svip
// 徽章 → qq_svip 落盘），这里统一读取，超级会员优先展示。
import { getPlatformSvipState, getPlatformVipState } from './audioQualitySettings'
import type { MusicPlatform } from './platforms'

export interface AccountTierBadge {
  label: '超级会员' | 'VIP'
  tone: 'svip' | 'vip'
}

/** 账号会员级别：超级会员 > 绿钻 VIP > 无。vipOverride 用于调用方已拿到 vip 布尔值的场景。 */
export function getAccountTierBadge(platform: MusicPlatform, vipOverride?: boolean): AccountTierBadge | null {
  if (getPlatformSvipState(platform)) return { label: '超级会员', tone: 'svip' }
  const vip = vipOverride ?? getPlatformVipState(platform)
  return vip ? { label: 'VIP', tone: 'vip' } : null
}

/** 徽章底色：超级会员用更亮的金橙渐变（与官方客户端的金色徽章同一层级语义），VIP 保持琥珀金。 */
export function accountTierBadgeClass(tone: 'svip' | 'vip'): string {
  return tone === 'svip'
    ? 'bg-gradient-to-r from-amber-300 via-amber-400 to-orange-400 text-black'
    : 'bg-gradient-to-r from-amber-400 to-yellow-500 text-white'
}

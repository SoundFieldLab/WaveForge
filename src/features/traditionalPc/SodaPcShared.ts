// 汽水音乐 PC 客户端复刻 —— 左栏导航契约。
//
// 复刻目标来自客户端源码 src/renderer/layouts/Sidebar.vue：
//   顶部一组：推荐（/player-feed）、听歌模式（/scene-mode）
//   「我的音乐」：我喜欢的音乐、抖音收藏的音乐、历史播放
//   「创建的歌单」：+ 新建，下面是自建歌单
//   （收藏的歌单在客户端是同一区域的后续分组；这里保留独立分组以复用既有歌单数据）
import type { LucideIcon } from 'lucide-react'
import { Compass, Heart, History, ListMusic, Music2, Play } from 'lucide-react'

export type SodaPcNavKey =
  | 'feed'      // 推荐（客户端默认页 /player-feed）
  | 'scene'     // 听歌模式（/scene-mode）
  | 'liked'     // 我喜欢的音乐
  | 'douyin'    // 抖音收藏的音乐
  | 'history'   // 历史播放
  | 'search'    // 搜索（客户端在顶栏，这里保留侧栏入口以复用传统模式搜索页）
  | 'profile'   // 个人中心
  | 'settings'  // 设置

export interface SodaPcNavItem {
  key: SodaPcNavKey
  label: string
  icon: LucideIcon
}

/** 客户端侧栏顶部独立一组（推荐 / 听歌模式） */
export const SODA_PC_NAV_TOP: SodaPcNavItem[] = [
  { key: 'feed', label: '推荐', icon: Play },
  { key: 'scene', label: '听歌模式', icon: Compass },
]

/** 「我的音乐」分组：顺序与客户端一致 */
export const SODA_PC_NAV_MY_MUSIC: SodaPcNavItem[] = [
  { key: 'liked', label: '我喜欢的音乐', icon: Heart },
  { key: 'douyin', label: '抖音收藏的音乐', icon: Music2 },
  { key: 'history', label: '历史播放', icon: History },
]

/**
 * 侧栏底部的次级入口：客户端左栏没有这些（搜索在顶栏、设置在头像菜单），
 * 所以这里留空——搜索移到顶栏中间的搜索框，设置移到底栏「更多」菜单。
 */
export const SODA_PC_NAV_FOOTER: SodaPcNavItem[] = []

/** 客户端侧栏量度（取自 Sidebar.vue 的 SCSS，改这里就等于改整套左栏观感） */
export const SODA_PC_SIDEBAR_METRICS = {
  width: 200,
  logoHeight: 44,
  itemHeight: 40,
  itemRadius: 8,
  itemPaddingX: 10,
  iconSize: 16,
  iconGap: 8,
  labelSize: 14,
  sectionTitleSize: 13,
  sectionTitleLineHeight: 26,
  menuMarginX: 16,
  menuGap: 4,
  groupGap: 24,
} as const

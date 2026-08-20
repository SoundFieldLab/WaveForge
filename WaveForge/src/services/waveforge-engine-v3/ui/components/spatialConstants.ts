/**
 * spatialConstants —— 空间音频 UI 共享常量（O3 审计：消除 SpatialPage 与
 * SpatialStudioLayout 之间的重复定义）
 *
 * 抽出项：
 *  - HEAD_LOCKED_LAYOUTS：模式 B 布局预设选项（立体声 / 5.1 / 7.1.4 / 自定义），
 *    SpatialPage 标准视图 Segmented + SpatialStudioLayout 左面板 Segmented 共用；
 *  - SPATIAL_ROOM_OPTIONS：模式 A 房间模拟选项（RoomPreset 子集：关闭/录音棚/
 *    音乐厅/舞台），两处 Segmented 共用。
 *
 * 单事实源：数值/标签变化只改本文件，两处消费方自动同步。类型从 spatial/types
 * 引入（HeadLockedSettings['layout'] / RoomPreset），不引入运行时依赖。
 */

import type { HeadLockedSettings, RoomPreset } from '../../src/spatial/types'

/** 模式 B 布局预设选项（左面板 / 标准视图共用） */
export const HEAD_LOCKED_LAYOUTS: { value: HeadLockedSettings['layout']; label: string }[] = [
  { value: 'stereo', label: '立体声' },
  { value: '51', label: '5.1' },
  { value: '714', label: '7.1.4' },
  { value: 'custom', label: '自定义' },
]

/** 模式 A 房间模拟选项（RoomPreset 子集：关闭/录音棚/音乐厅/舞台） */
export const SPATIAL_ROOM_OPTIONS: { value: RoomPreset; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'studio', label: '录音棚' },
  { value: 'hall', label: '音乐厅' },
  { value: 'stage', label: '舞台' },
]

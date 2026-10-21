/**
 * layouts —— 模式 B 头锁定环绕布局预设
 *
 * 布局表 + 扬声器解析（fusion 融合层与 UI 共用，单事实源）：
 *  - stereo：L/R 双声道（±30°）
 *  - 51：C/FL/FR/SL/SR 五声道（LFE 无方向性，不参与虚拟扬声器布局）
 *  - 714：7 地面（C/FL/FR/SL/SR/RL/RR）+ 4 顶置（TFL/TFR/TRL/TRR，仰角 +45°）
 *         共 11 只有方向的扬声器；LFE 在离散输入低频管理中处理。
 * 角度约定与 instantSpeakers 一致：az>0 右侧、前方 0°、正后 ±180°；距离单位米。
 * 本模块纯数据/纯函数、无浏览器依赖（AudioWorklet 打包安全）；返回列表均为副本，
 * 调用方修改不影响预设表。
 */

import type { HeadLockedSettings, VirtualSpeakerCfg } from './types'

export function detectMultichannelLayout(channels: number): MultichannelLayoutId {
  if (channels <= 2) return 'stereo'
  if (channels === 4) return 'quad'
  if (channels === 8) return '71'
  if (channels === 12) return '714'
  return '51'
}

export type MultichannelLayoutId = 'stereo' | 'quad' | '51' | '71' | '714'

/** 标准离散输入顺序；LFE 不进入方向性 HRTF，另经低通送入双耳。 */
export function createMultichannelSpeakers(layout: MultichannelLayoutId): Array<VirtualSpeakerCfg & { channel: number }> {
  const speaker = (channel: number, azimuthDeg: number, elevationDeg = 0, gain = 1) => ({
    channel, azimuthDeg, elevationDeg, distance: 1.5, gain, size: 0,
  })
  if (layout === 'stereo') return [speaker(0, -30), speaker(1, 30)]
  if (layout === 'quad') return [
    speaker(0, -30), speaker(1, 30), speaker(2, -110), speaker(3, 110),
  ]
  const ground = layout === '51'
    ? [speaker(0, -30), speaker(1, 30), speaker(2, 0), speaker(3, 0, 0, 0), speaker(4, -110), speaker(5, 110)]
    : [speaker(0, -30), speaker(1, 30), speaker(2, 0), speaker(3, 0, 0, 0),
      speaker(4, -110), speaker(5, 110), speaker(6, -150), speaker(7, 150)]
  if (layout === '714') ground.push(
    speaker(8, -45, 45), speaker(9, 45, 45), speaker(10, -135, 45), speaker(11, 135, 45),
  )
  return ground
}

/** 布局预设表项；514/714 顶置层可由 heightLayer 过滤。 */
export interface LayoutPreset {
  id: 'stereo' | '51' | '514' | '71' | '714'
  name: string
  speakers: VirtualSpeakerCfg[]
}

/** 7.1.4 顶置层扬声器（TFL/TFR/TRL/TRR；heightLayer=false 时从预设过滤，按引用识别） */
const TOP_714: VirtualSpeakerCfg[] = [
  { azimuthDeg: -45, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: 45, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: -135, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: 135, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
]

/** 7.1.4 地面层（顺序即声道表：C FL FR SL SR RL RR） */
const GROUND_714: VirtualSpeakerCfg[] = [
  { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: -140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { azimuthDeg: 140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
]

/** 布局预设表（id 与 HeadLockedSettings.layout 的预设分支一一对应） */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'stereo',
    name: '立体声',
    speakers: [
      { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // L
      { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // R
    ],
  },
  {
    id: '51',
    name: '5.1',
    speakers: [
      { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // C
      { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FL
      { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FR
      { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SL
      { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SR
    ],
  },
  {
    id: '514',
    name: '5.1.4',
    // 9 只：5 地面（同 5.1 表）+ 4 顶置；heightLayer 关闭后过滤顶置 = 5.1
    speakers: [
      { azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // C
      { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FL
      { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FR
      { azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SL
      { azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SR
      ...TOP_714,
    ],
  },
  {
    id: '71',
    name: '7.1',
    // 7 地面（与 714 地面层同表：C/FL/FR/SL/SR/RL/RR），无顶置/底部层
    speakers: [...GROUND_714],
  },
  {
    id: '714',
    name: '7.1.4',
    // 11 只：7 地面 + 4 顶置（地面 0-6、顶置 7-10）。
    speakers: [...GROUND_714, ...TOP_714],
  },
]

function presetById(id: LayoutPreset['id']): LayoutPreset {
  const found = LAYOUT_PRESETS.find((p) => p.id === id)
  return found ?? LAYOUT_PRESETS[1] // 防御：未知 id 回退 5.1
}

/**
 * 取布局预设扬声器列表（副本）。714/514 返回含顶置层——
 * heightLayer/bottomLayer 过滤由 headLockedSpeakers 负责；本函数供 UI 切换布局时
 * 同步 headLocked.speakers（自定义布局的编辑起点 = 当前预设）。
 */
export function createLayoutSpeakers(layout: LayoutPreset['id']): VirtualSpeakerCfg[] {
  return presetById(layout).speakers.map((s) => ({ ...s }))
}

/**
 * HeadLockedSettings → 实际参与渲染的扬声器列表：
 *  - 预设布局 → 预设表副本（714/514 按 heightLayer 过滤顶置层；714 默认 11 只，
 *    关顶置剩 7 地面；514 关顶置剩 5 地面。旧 bottomLayer 字段仅为数据兼容保留）；
 *  - custom → p.speakers 原样返回（空列表回退 5.1 预设，保证后端恒有扬声器）。
 */
export function headLockedSpeakers(p: HeadLockedSettings): VirtualSpeakerCfg[] {
  if (p.layout !== 'custom') {
    const preset = presetById(p.layout)
    // 先按引用过滤（TOP_714 与预设表共享实例），再拷贝。
    let src = preset.speakers
    if (p.layout === '714' || p.layout === '514') {
      if (!p.heightLayer) src = src.filter((s) => !TOP_714.includes(s))
    }
    return src.map((s) => ({ ...s, ...(p.routes[preset.speakers.indexOf(s)] ? { route: p.routes[preset.speakers.indexOf(s)] } : {}) }))
  }
  if (p.speakers.length === 0) return createLayoutSpeakers('51')
  return p.speakers
}

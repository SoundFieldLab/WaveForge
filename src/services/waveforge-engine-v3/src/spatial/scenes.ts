/**
 * scenes —— 模式 D 舞台/影院场景预设
 *
 * 预设表 + 扬声器解析（fusion 融合层与 UI 共用，单事实源，同 layouts.ts 范式）：
 *  - stage   音乐舞台：主唱居中 + 乐队乐器分布 + 环境环绕（room 'stage'）
 *  - cinema  电影院：7.1.4 影院布局（屏幕 3 + 环绕 4 + 顶置 4，room 'hall'）——
 *    方位角/仰角数值与 layouts.ts 的 714 布局一致（C/FL/FR/SL/SR/RL/RR/TFL/TFR/TRL/TRR），
 *    但距离按影院场景独立定义（屏幕 4m / 环绕 7m / 顶置 5m），故不复用 714 表、独立枚举；
 *  - piano   钢琴独奏：独奏钢琴居中 + 音乐厅环境环绕（room 'hall'）
 *  - nature  自然场景：雨（头顶）/雷（身后）/鸟/溪流 户外空间（room 'outdoor'）
 *
 * 角度约定与 layouts 一致：az>0 右侧、0° 正前、±180° 正后；仰角 el>0 上方；距离单位米。
 * channel 语义同模式 B：az<=0 → 0（左源）、az>0 → 1（右源），由 fusion 层按此规则路由。
 * 本模块纯数据/纯函数、无浏览器依赖（AudioWorklet 打包安全）；返回列表均为副本，
 * 调用方修改不影响预设表。
 */

import type { RoomPreset, SeatPosition, StagePreset, StageSettings, VirtualSpeakerCfg } from './types'

/** 座位 → 扬声器距离缩放系数（越靠后声源越远，距离感更强；front 0.8 / middle 1.0 / back 1.35） */
const SEAT_DISTANCE_SCALE: Record<SeatPosition, number> = {
  front: 0.8,
  middle: 1.0,
  back: 1.35,
}

/** 场景预设表项 */
export interface StageScene {
  id: StagePreset
  name: string
  description: string
  speakers: VirtualSpeakerCfg[]
  room: RoomPreset
}

/** 场景预设表（id 与 StageSettings.preset 分支一一对应） */
export const STAGE_SCENES: StageScene[] = [
  {
    id: 'stage',
    name: '音乐舞台',
    description: 'Live 乐队全景：主唱居中，乐器环绕展开，舞台纵深感',
    speakers: [
      { azimuthDeg: 0, elevationDeg: 0, distance: 2.5, gain: 1, size: 0 }, // 主唱：正前居中
      { azimuthDeg: -30, elevationDeg: 0, distance: 4, gain: 1, size: 0 }, // 吉他：左前
      { azimuthDeg: 30, elevationDeg: 0, distance: 4, gain: 1, size: 0 }, // 贝斯：右前
      { azimuthDeg: 10, elevationDeg: 0, distance: 6, gain: 1, size: 0 }, // 鼓：居中偏右稍远
      { azimuthDeg: -20, elevationDeg: 0, distance: 5, gain: 1, size: 0 }, // 键盘：左前偏中
      { azimuthDeg: -110, elevationDeg: 0, distance: 8, gain: 1, size: 0 }, // 环境环绕：左
      { azimuthDeg: 110, elevationDeg: 0, distance: 8, gain: 1, size: 0 }, // 环境环绕：右
    ],
    room: 'stage',
  },
  {
    id: 'cinema',
    name: '电影院',
    description: '7.1.4 影院布局：银幕对白 + 侧后环绕 + 顶置天空声道',
    speakers: [
      { azimuthDeg: 0, elevationDeg: 0, distance: 4, gain: 1, size: 0 }, // C：银幕中央
      { azimuthDeg: -30, elevationDeg: 0, distance: 4, gain: 1, size: 0 }, // FL：银幕左
      { azimuthDeg: 30, elevationDeg: 0, distance: 4, gain: 1, size: 0 }, // FR：银幕右
      { azimuthDeg: -100, elevationDeg: 0, distance: 7, gain: 1, size: 0 }, // SL：左侧环绕
      { azimuthDeg: 100, elevationDeg: 0, distance: 7, gain: 1, size: 0 }, // SR：右侧环绕
      { azimuthDeg: -135, elevationDeg: 0, distance: 7, gain: 1, size: 0 }, // RL：左后环绕
      { azimuthDeg: 135, elevationDeg: 0, distance: 7, gain: 1, size: 0 }, // RR：右后环绕
      { azimuthDeg: -45, elevationDeg: 45, distance: 5, gain: 1, size: 0 }, // TFL：左前顶置
      { azimuthDeg: 45, elevationDeg: 45, distance: 5, gain: 1, size: 0 }, // TFR：右前顶置
      { azimuthDeg: -135, elevationDeg: 45, distance: 5, gain: 1, size: 0 }, // TRL：左后顶置
      { azimuthDeg: 135, elevationDeg: 45, distance: 5, gain: 1, size: 0 }, // TRR：右后顶置
    ],
    room: 'hall',
  },
  {
    id: 'piano',
    name: '钢琴独奏',
    description: '独奏钢琴居中，音乐厅长尾混响环绕，静谧沉浸',
    speakers: [
      { azimuthDeg: 0, elevationDeg: 0, distance: 2, gain: 1, size: 0 }, // 钢琴：正前近场
      { azimuthDeg: -90, elevationDeg: 0, distance: 9, gain: 1, size: 0 }, // 音乐厅环境：左
      { azimuthDeg: 90, elevationDeg: 0, distance: 9, gain: 1, size: 0 }, // 音乐厅环境：右
      { azimuthDeg: 180, elevationDeg: 0, distance: 10, gain: 1, size: 0 }, // 音乐厅环境：正后
    ],
    room: 'hall',
  },
  {
    id: 'nature',
    name: '自然场景',
    description: '雨声头顶、雷声身后、鸟鸣溪流，置身户外旷野',
    speakers: [
      { azimuthDeg: 0, elevationDeg: 50, distance: 7, gain: 1, size: 0 }, // 雨：头顶上方（仰角 50°）
      { azimuthDeg: 180, elevationDeg: 0, distance: 15, gain: 1, size: 0 }, // 雷：正后方远处
      { azimuthDeg: -140, elevationDeg: 20, distance: 8, gain: 1, size: 0 }, // 鸟：左后上方（仰角 20°）
      { azimuthDeg: 110, elevationDeg: 0, distance: 6, gain: 1, size: 0 }, // 溪流：右前方
    ],
    room: 'outdoor',
  },
]

function sceneById(id: StagePreset): StageScene {
  const found = STAGE_SCENES.find((s) => s.id === id)
  return found ?? STAGE_SCENES[0] // 防御：未知 id 回退音乐舞台
}

/** 距离最终钳位区间（米）：过近贴耳 / 过远超出 HRTF 距离感范围 */
const DIST_MIN = 0.5
const DIST_MAX = 10

function clampDistance(d: number): number {
  return Math.min(DIST_MAX, Math.max(DIST_MIN, d))
}

/**
 * StageSettings → 实际参与渲染的扬声器列表（副本）：
 * 距离 = 预设基准距离 × 座位系数（front 0.8 / middle 1.0 / back 1.35）× roomSize，
 * 最终钳位 0.5..10m（房间放大/坐后排时不至于冲出 HRTF 距离感范围）；
 * 方位/仰角/增益不随座位变化。
 */
export function stageSpeakers(p: StageSettings): VirtualSpeakerCfg[] {
  const scene = sceneById(p.preset)
  const seatScale = SEAT_DISTANCE_SCALE[p.seat] ?? 1.0
  const roomScale = Math.min(2, Math.max(0.5, p.roomSize)) // 防御：roomSize 越界钳位
  return scene.speakers.map((s) => ({
    ...s,
    distance: clampDistance(s.distance * seatScale * roomScale),
  }))
}

/** StageSettings → 场景房间预设（混响语义，room.ts 预设表子集） */
export function stageRoom(p: StageSettings): RoomPreset {
  return sceneById(p.preset).room
}

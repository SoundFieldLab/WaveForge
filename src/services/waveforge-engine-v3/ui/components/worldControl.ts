/**
 * worldControl —— 模式 C 世界漫游：键盘 → 移动/转头 纯函数
 *
 * WorldPanel 的 raf 采样循环复用本模块；与引擎侧角度约定严格一致
 * （见 src/spatial/controller.ts 的 computeRelativeDirection）：
 *   - 听者 yaw = 0 时正前方为世界 +Z；yaw 增大朝向 +X 偏转（右转）；
 *   - 由方位角约定 azimuth = atan2(dx, dz) − yaw（右正）推导世界系基向量：
 *       forward = (sin yaw, 0, cos yaw)
 *       right   = (cos yaw, 0, −sin yaw)
 *   （两者即为 +Z / +X 轴绕 Y 旋转 yaw 的右手系结果，见 SpatialWorldView 头标记朝向）。
 *
 * 键位映射（§5.6 快捷键配置）：KeyMap 定义 8 个可配置动作（前进/后退/左移/右移/
 * 上升/下降/切换声源/播放暂停），computeMoveDelta/computeYawDelta 以可选 keymap
 * 参数接收（默认 DEFAULT_KEYMAP → 现有调用零改动）；键比较统一小写（keydown 的
 * e.key 小写化后与 keymap 值小写化比较，Shift 捕获的大写键同样命中）。
 * 转头（←/→）与 R/F 为固定功能键，不在 KeyMap 内（见 WorldPanel 键盘监听）。
 *
 * 本模块无 React/DOM 依赖，可在 node 环境直接单测（worldControl.test.tsx）。
 *
 * KeyMap 接口 + DEFAULT_KEYMAP 常量定义在 src/spatial/keymap.ts（契约层，
 * 消除 types.ts 对 UI 层的反向依赖）；本模块 re-export 保持旧 import 路径
 * （'./worldControl'）向后兼容，既有调用方零改动（WorldPanel /
 * SpatialSettingsModal / worldControl.test.tsx 均从本模块 import）。
 */
import { DEFAULT_KEYMAP } from '../../src/spatial/keymap'
import type { KeyMap } from '../../src/spatial/keymap'
// re-export：保持旧 import 路径（'./worldControl'）向后兼容；KeyMap 为类型，
// isolatedModules 下类型 re-export 必须用 export type。
export { DEFAULT_KEYMAP }
export type { KeyMap }

/** 转头速度（度/秒）：按住 ←/→ 约 2 秒转半圈 */
export const YAW_ROTATE_SPEED_DEG = 90

/** 单帧时间步长上限（秒）：页面卡顿/切后台时不至于瞬移 */
export const MAX_FRAME_DT = 0.05

/** 声源 id → 中文名（未知 id 显示原文，WorldPanel 列表与 3D 标签共用） */
export const SOURCE_NAMES: Record<string, string> = {
  vocal: '人声',
  guitar: '吉他',
  drums: '鼓组',
  ambience: '环境声',
}

/** 声源 id → 显示名 */
export function sourceName(id: string): string {
  return SOURCE_NAMES[id] ?? id
}

/**
 * 按键集 → 位移增量（米）。
 * keys 为小写 e.key 集合（'w'/'a'/'s'/'d' 水平 + 'q'/'e' 升降，可经 keymap 重绑定）；
 * 斜向（如 W+D）先归一化再变换，不叠加速度；Q 升 / E 降为世界 +Y/−Y，
 * 与听者朝向无关。位移 = 朝向相关单位向量 × speed × dt。
 * keymap 可选（默认 DEFAULT_KEYMAP → 现有调用零改动，回归）；键比较统一小写
 * （keymap 值可能含大写，如 Shift 按下捕获的 'W'，比较前 toLowerCase）。
 */
export function computeMoveDelta(
  keys: ReadonlySet<string>,
  yawDeg: number,
  speed: number,
  dt: number,
  keymap: KeyMap = DEFAULT_KEYMAP,
): { x: number; y: number; z: number } {
  // 键比较统一小写（keys 已小写化；keymap 值 toLowerCase 后比较）
  const has = (k: string): boolean => keys.has(k.toLowerCase())
  // 听者局部系水平输入：fx 右正 / fz 前正
  let fx = 0
  let fz = 0
  if (has(keymap.right)) fx += 1
  if (has(keymap.left)) fx -= 1
  if (has(keymap.forward)) fz += 1
  if (has(keymap.back)) fz -= 1
  const len = Math.hypot(fx, fz)
  if (len > 0) {
    fx /= len
    fz /= len
  }
  // 世界系变换（forward / right 见文件头注释）
  const yaw = (yawDeg * Math.PI) / 180
  const fwdX = Math.sin(yaw)
  const fwdZ = Math.cos(yaw)
  const rightX = Math.cos(yaw)
  const rightZ = -Math.sin(yaw)
  const step = speed * dt
  const x = (fz * fwdX + fx * rightX) * step
  const z = (fz * fwdZ + fx * rightZ) * step
  let y = 0
  if (has(keymap.up)) y += 1
  if (has(keymap.down)) y -= 1
  return { x, y: y * step, z }
}

/**
 * 按键集 → 偏航角增量（度）：← 左转 / → 右转（同按抵消）。
 * 正值 = 右转（yaw 增大），与引擎 azimuth = atan2(dx, dz) − yaw 的旋转方向一致。
 * keymap 参数保留与 computeMoveDelta 对称的调用约定：转头键位固定为 ←/→ 方向键
 * （KeyMap 8 个可配置动作不含转头，默认参数下行为与现状逐位一致）。
 */
export function computeYawDelta(
  keys: ReadonlySet<string>,
  dt: number,
  keymap: KeyMap = DEFAULT_KEYMAP,
): number {
  let dir = 0
  if (keys.has('arrowleft')) dir -= 1
  if (keys.has('arrowright')) dir += 1
  return dir * YAW_ROTATE_SPEED_DEG * dt
}

/**
 * Tab 循环选源：返回下一个要选中的声源下标（SpatialWorldView 键盘 Tab 用）。
 * 规则：空列表 → -1（调用方不动作）；无选中（selectedId 不在列表）→ 0（从
 * 第一个开始）；已选中 → (当前下标 + 1) % 长度（循环）；仅 1 个时不变
 * （已选中 → 0，未选中 → -1，调用方按 id 相同跳过）。纯函数可单测。
 */
export function nextSourceIndex(
  sources: readonly { id: string }[],
  selectedId: string | null,
): number {
  if (sources.length === 0) return -1
  const idx = selectedId === null ? -1 : sources.findIndex((s) => s.id === selectedId)
  if (sources.length === 1) return idx // 仅 1 个：保持不变（已选中 0 / 未选中 -1）
  if (idx < 0) return 0 // 无选中：从第一个开始
  return (idx + 1) % sources.length
}

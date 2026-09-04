/**
 * keymap —— 模式 C 世界漫游键盘映射契约（UI 层与空间参数模型共享）
 *
 * 原先 KeyMap 接口定义在 ui/components/worldControl.ts，导致空间参数契约文件
 * types.ts 反向依赖 UI 层（import type 仅为编译期、无运行时影响，但设计气味）。
 * 本文件把 KeyMap 接口 + DEFAULT_KEYMAP 常量下沉到 src/spatial/（契约层），
 * 让 types.ts 与 worldControl.ts 都从此处引用；worldControl.ts re-export
 * 保持旧 import 路径（'./worldControl'）向后兼容，既有调用方零改动。
 *
 * 键位语义详见 worldControl.ts 文件头注释（computeMoveDelta/computeYawDelta
 * 的键比较统一小写、转头键固定不在 KeyMap 内等约定在此不重复）。
 */

/** 键位映射（§5.6 快捷键配置；动作 → 触发键，值为 e.key 原样存储，
 *  比较时统一小写化）。与设置弹窗 8 个动作行一一对应。 */
export interface KeyMap {
  /** 前进（默认 W） */
  forward: string
  /** 后退（默认 S） */
  back: string
  /** 左移（默认 A） */
  left: string
  /** 右移（默认 D） */
  right: string
  /** 上升（默认 Q） */
  up: string
  /** 下降（默认 E） */
  down: string
  /** 切换声源（默认 Tab；WorldPanel 按本键循环选源，SpatialWorldView 另有
   *  硬编码 Tab 监听并存——同一状态计算同一结果，重复触发幂等） */
  tab: string
  /** 播放/暂停（默认 空格） */
  space: string
}

/** 默认键位（与现状一致：WASD 移动 + Q/E 升降 + Tab 切源 + 空格播放/暂停；
 *  设置弹窗「恢复默认」= keymap 置 undefined，行为回退到本表） */
export const DEFAULT_KEYMAP: KeyMap = {
  forward: 'w',
  back: 's',
  left: 'a',
  right: 'd',
  up: 'q',
  down: 'e',
  tab: 'Tab',
  space: ' ',
}

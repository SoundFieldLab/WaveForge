/**
 * HSE 内置场景「发布默认」覆盖层 —— 种子文件
 *
 * 用途：开发者模式里微调的内置场景，经「导出发布种子」生成此文件的替换内容；
 * 替换后 commit/push 随安装包分发，**所有用户**开箱即得到与作者一致的调优结果。
 *
 * 版本规则（revision）：
 *  - 每次导出自动取 max(当前 revision, 用户本地基线) + 1；
 *  - 应用启动时若本文件 revision 高于用户本地存储记录的基线，视为官方发布更新，
 *    用户机器上**基于旧基线的个人微调自动失效**，让位给本文件的新默认值——
 *    这保证老版本升级后官方调优能覆盖旧数据（用户数据目录在 NSIS 升级时不被清除，
 *    因此必须靠 revision 判定而非安装器删除）。
 *  - 手动编辑参数同样可以：只改 overrides 里对应场景的字段即可，保持结构完整。
 */

import type { V3EngineParams } from '../types'

export interface BuiltinSceneSeed {
  revision: number
  overrides: Record<string, V3EngineParams>
}

export const BUILTIN_SCENE_SEED: BuiltinSceneSeed = {
  revision: 0,
  overrides: {},
}

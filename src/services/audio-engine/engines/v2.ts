/**
 * v2 引擎清单 —— 本地增强版音效引擎
 *
 * 可叠加效果 + 场景方案 + 频响补偿 + 响度归一化（外部服务）。
 * 引擎源码：src/services/audio-effects-v2/AudioEffectsEngine.ts
 */

import type { EngineManifest } from '../types'
import { V2Adapter } from '../V2Adapter'

export const v2Manifest: EngineManifest = {
  id: 'v2',
  displayName: 'v2',
  description: '增强版（可叠加 + 场景 + 频响补偿）',
  createAdapter: (opts) => new V2Adapter(opts && { onLowVolumeHint: opts.onLowVolumeHint }),
}

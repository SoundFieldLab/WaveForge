/**
 * v1 引擎清单 —— 远程原版音效引擎
 *
 * 5 效果互斥 + 老式调音室 UI。无系统音量/响度归一化能力。
 * 引擎源码：src/services/audioEffects/AudioEffectsEngine.ts
 */

import type { EngineManifest } from '../types'
import { V1Adapter } from '../V1Adapter'

export const v1Manifest: EngineManifest = {
  id: 'v1',
  displayName: 'v1',
  description: '原版音效（5 效果互斥）',
  createAdapter: () => new V1Adapter(),
}

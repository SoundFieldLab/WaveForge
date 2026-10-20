import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import type { V3EngineParams } from '../src/types'

const FS = 48000
const N = 128

function makeEngine() {
  const engine = new EngineV3(FS, 2)
  const params = createDefaultParams(FS)
  params.spatial.mode = 'headLocked'
  params.spatial.inputFormat = 'channels'
  params.spatial.renderStyle = 'natural'
  params.spatial.instant.amount = 0.7
  params.spatial.instant.room = 'off'
  params.spatial.instant.roomAmount = 0
  params.spatial.ambience.enabled = false
  params.spatial.headLocked = {
    layout: 'custom',
    heightLayer: false,
    bottomLayer: false,
    routes: [],
    speakers: [
      { azimuthDeg: -30, elevationDeg: 0, distance: 1.2, gain: 1, size: 0, route: 'l' },
      { azimuthDeg: 30, elevationDeg: 0, distance: 1.2, gain: 1, size: 0, route: 'r' },
    ],
  }
  engine.setParams(params)
  return { engine, params }
}

function renderRms(engine: EngineV3, seconds = 1) {
  const blocks = Math.ceil(FS * seconds / N)
  const input = [new Float32Array(N), new Float32Array(N)]
  const output = [new Float32Array(N), new Float32Array(N)]
  let sumL = 0, sumR = 0, count = 0
  let phase = 0
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < N; i++) {
      input[0][i] = 0.25 * Math.sin(phase)
      input[1][i] = 0.25 * Math.sin(phase + 0.4)
      phase += 2 * Math.PI * 440 / FS
    }
    engine.process(input, output)
    if (b * N > FS * 0.4) {
      for (let i = 0; i < N; i++) { sumL += output[0][i] ** 2; sumR += output[1][i] ** 2; count++ }
    }
  }
  return { l: Math.sqrt(sumL / count), r: Math.sqrt(sumR / count) }
}

function applySpeakers(engine: EngineV3, params: V3EngineParams, muteL: boolean, muteR: boolean, volL = 1, volR = 1) {
  const speakers = params.spatial.headLocked.speakers.map((speaker, index) => ({
    ...speaker,
    muted: index === 0 ? muteL : muteR,
    gain: index === 0 ? volL : volR,
  }))
  engine.setParams({ ...params, spatial: { ...params.spatial, headLocked: { ...params.spatial.headLocked, speakers } } })
}

describe('空间音频虚拟声源静音', () => {
  it('头锁定模式下静音右声道后右耳干声也静音（不再只静湿声）', () => {
    const { engine, params } = makeEngine()
    const baseline = renderRms(engine)
    expect(baseline.l).toBeGreaterThan(0.02)
    expect(baseline.r).toBeGreaterThan(0.02)

    applySpeakers(engine, params, false, true)
    const rightMuted = renderRms(engine)
    // 右声道节目源消失；左源经 HRTF 仍会有少量交叉声进入右耳，因此不要求绝对 0。
    expect(rightMuted.r).toBeLessThan(baseline.r * 0.6)
    expect(rightMuted.l).toBeGreaterThan(baseline.l * 0.5)

    applySpeakers(engine, params, true, true)
    const allMuted = renderRms(engine)
    expect(allMuted.l).toBeLessThan(baseline.l * 0.05)
    expect(allMuted.r).toBeLessThan(baseline.r * 0.05)

    applySpeakers(engine, params, false, false)
    const restored = renderRms(engine)
    expect(restored.l).toBeGreaterThan(baseline.l * 0.5)
    expect(restored.r).toBeGreaterThan(baseline.r * 0.5)
  })

  it('声源音量拖到 0 与静音等效（干声也跟随）', () => {
    const { engine, params } = makeEngine()
    const baseline = renderRms(engine)
    applySpeakers(engine, params, false, true, 1, 0)
    const zeroVolume = renderRms(engine)
    // 只保留左源经 HRTF 串到右耳的交叉声（约 -20dB），右节目源本身应消失。
    expect(zeroVolume.r).toBeLessThan(baseline.r * 0.15)
  })
})

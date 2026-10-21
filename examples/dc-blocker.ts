import { registerProcessingNodeFactory } from '../src/services/waveforge-engine-v3/src/integration/ProcessingNode'

// 同一个可信 TS 模块由应用 import，并单独打包后交给 AudioWorklet.addModule。
registerProcessingNodeFactory('example/dc-blocker', ({ id, data, sampleRate }) => {
  const cutoff = data && typeof data === 'object' && !Array.isArray(data) ? data.cutoffHz : undefined
  if (typeof cutoff !== 'number' || !Number.isFinite(cutoff) || cutoff < 1 || cutoff > 200) {
    throw new Error('dc-blocker: cutoffHz must be in 1..200')
  }
  const coefficient = Math.exp(-2 * Math.PI * cutoff / sampleRate)
  let xL = 0, xR = 0, yL = 0, yR = 0
  return { id, getLatencySamples: () => 0,
    reset: () => { xL = xR = yL = yR = 0 },
    processStereo: (left, right) => {
      for (let i = 0, n = Math.min(left.length, right.length); i < n; i++) {
        const l = left[i], r = right[i]
        yL = l - xL + coefficient * yL; xL = l
        yR = r - xR + coefficient * yR; xR = r
        left[i] = yL; right[i] = yR
      }
    },
  }
})

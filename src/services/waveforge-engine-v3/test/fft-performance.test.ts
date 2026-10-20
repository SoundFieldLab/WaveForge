import { describe, expect, it } from 'vitest'
import { fft } from '../src/dsp/fft'

// 优化前的独立基-2 DIT 参考；保留每个蝶形写回 Float32 的舍入位置。
// 测试不能用实信号半谱或双精度 DFT 替代这个兼容性契约。
const referenceTwiddles = new Map<number, Float64Array[]>()
function referenceFft(real: Float32Array, imag: Float32Array, inverse: boolean): void {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
    }
  }
  let stages = referenceTwiddles.get(n)
  if (!stages) {
    stages = []
    for (let len = 2; len <= n; len *= 2) {
      const half = len / 2
      const t = new Float64Array(half * 2)
      const step = (2 * Math.PI) / len
      for (let k = 0; k < half; k++) {
        t[2 * k] = Math.cos(step * k)
        t[2 * k + 1] = Math.sin(step * k)
      }
      stages.push(t)
    }
    referenceTwiddles.set(n, stages)
  }
  const sign = inverse ? 1 : -1
  let stageIdx = 0
  for (let len = 2; len <= n; len *= 2) {
    const half = len / 2
    const t = stages[stageIdx++]
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = t[2 * k]
        const wi = sign * t[2 * k + 1]
        const ur = real[i + k]
        const ui = imag[i + k]
        const vr = real[i + k + half]
        const vi = imag[i + k + half]
        const vrW = wr * vr - wi * vi
        const viW = wr * vi + wi * vr
        real[i + k] = ur + vrW
        imag[i + k] = ui + viW
        real[i + k + half] = ur - vrW
        imag[i + k + half] = ui - viW
      }
    }
  }
  if (inverse) {
    const inv = 1 / n
    for (let i = 0; i < n; i++) {
      real[i] *= inv
      imag[i] *= inv
    }
  }
}

function expectBits(actual: Float32Array, expected: Float32Array): void {
  expect(new Uint32Array(actual.buffer, actual.byteOffset, actual.length))
    .toEqual(new Uint32Array(expected.buffer, expected.byteOffset, expected.length))
}

function randomComplex(n: number, seed: number): [Float32Array, Float32Array] {
  let state = seed >>> 0
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return ((state >>> 0) / 0x100000000) * 2 - 1
  }
  return [Float32Array.from({ length: n }, next), Float32Array.from({ length: n }, next)]
}

describe('FFT 等价性能优化', () => {
  it.each([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 16384, 65536])(
    '%i 点正逆复变换与旧算法逐位一致', n => {
      for (const inverse of [false, true]) {
        const [r, i] = randomComplex(n, n + 123)
        const expectedR = r.slice(), expectedI = i.slice()
        referenceFft(expectedR, expectedI, inverse)
        fft(r, i, inverse)
        expectBits(r, expectedR)
        expectBits(i, expectedI)
      }
    },
  )

  it('复数脉冲、正负零、次正规值、有限溢出输入逐位一致', () => {
    const extremes = [0, -0, 2 ** -149, -(2 ** -149), 3.4028234663852886e38, -3.4028234663852886e38]
    for (const n of [1, 2, 4, 8, 32, 256, 1024]) {
      for (const inverse of [false, true]) {
        for (const kind of ['impulse', 'extremes']) {
          const r = new Float32Array(n), i = new Float32Array(n)
          if (kind === 'impulse') { r[n >> 1] = 0.75; i[n >> 1] = -0.25 }
          else for (let k = 0; k < n; k++) { r[k] = extremes[k % extremes.length]; i[k] = extremes[(k + 2) % extremes.length] }
          const expectedR = r.slice(), expectedI = i.slice()
          referenceFft(expectedR, expectedI, inverse)
          fft(r, i, inverse)
          expectBits(r, expectedR)
          expectBits(i, expectedI)
        }
      }
    }
  })

  it('随机有限 Float32 位型跨完整指数范围仍逐位一致', () => {
    let state = 0x6a09e667
    for (const n of [2, 8, 64, 512, 4096]) {
      for (const inverse of [false, true]) {
        const storage = new Uint32Array(2 * n)
        for (let k = 0; k < storage.length; k++) {
          state ^= state << 13; state ^= state >>> 17; state ^= state << 5
          // 把指数 255 映射到 254；保留任意符号、尾数和次正规输入。
          const exponent = Math.min((state >>> 23) & 255, 254)
          storage[k] = (state & 0x807fffff) | (exponent << 23)
        }
        const r = new Float32Array(storage.buffer, 0, n)
        const i = new Float32Array(storage.buffer, 4 * n, n)
        const expectedR = r.slice(), expectedI = i.slice()
        referenceFft(expectedR, expectedI, inverse)
        fft(r, i, inverse)
        expectBits(r, expectedR)
        expectBits(i, expectedI)
      }
    }
  })

  it('复数往返既保持旧算法舍入，也恢复两个非零输入平面', () => {
    for (const n of [1, 2, 4, 16, 256, 1024, 4096]) {
      const [r, i] = randomComplex(n, 0x12345678)
      const originalR = r.slice(), originalI = i.slice()
      const expectedR = r.slice(), expectedI = i.slice()
      referenceFft(expectedR, expectedI, false)
      referenceFft(expectedR, expectedI, true)
      fft(r, i, false)
      fft(r, i, true)
      expectBits(r, expectedR)
      expectBits(i, expectedI)
      let error = 0
      for (let k = 0; k < n; k++) error = Math.max(error, Math.abs(r[k] - originalR[k]), Math.abs(i[k] - originalI[k]))
      expect(error).toBeLessThan(5e-7)
    }
  })

  it('共享及重叠视图也保留旧写回顺序', () => {
    for (const offset of [0, 1, 2, 8]) {
      for (const inverse of [false, true]) {
        const [initial] = randomComplex(24, 53)
        const expected = initial.slice()
        referenceFft(expected.subarray(0, 16), expected.subarray(offset, offset + 16), inverse)
        fft(initial.subarray(0, 16), initial.subarray(offset, offset + 16), inverse)
        expectBits(initial, expected)
      }
    }
  })

  it('非法长度仍在索引和分配前拒绝', () => {
    for (const n of [0, 3, 6, 255]) {
      expect(() => fft(new Float32Array(n), new Float32Array(n), false)).toThrow('length must be a power of two')
    }
    expect(() => fft(new Float32Array(8), new Float32Array(4), false)).toThrow('length mismatch')
    // 不分配数 GB 缓冲：通过真实 TypedArray 的 length getter 模拟超界长度。
    const oversized = new Float32Array(1)
    Object.defineProperty(oversized, 'length', { value: 2 ** 31 })
    expect(() => fft(oversized, oversized, false)).toThrow('length must be a power of two')
  })

  // 手动离线基准，只输出测量值；不把墙钟时间作为抖动敏感的测试门槛。
  it.skipIf(process.env.HSE_FFT_BENCH !== '1')('离线基准：旧实现与新实现交替测量中位数', () => {
    for (const n of [64, 128, 256, 512, 1024, 2048, 4096]) {
      const iterations = Math.floor(8_000_000 / n)
      const samples: number[][] = [[], []]
      const transforms = [referenceFft, fft]
      for (let run = 0; run < 7; run++) {
        for (const index of run % 2 === 0 ? [0, 1] : [1, 0]) {
          const [r, i] = randomComplex(n, 23)
          const transform = transforms[index]
          for (let warm = 0; warm < 1000; warm++) transform(r, i, !!(warm & 1))
          const start = performance.now()
          for (let k = 0; k < iterations; k++) transform(r, i, !!(k & 1))
          samples[index].push(performance.now() - start)
        }
      }
      const medians = samples.map(values => values.sort((a, b) => a - b)[3])
      console.log(JSON.stringify({ n, iterations, oldMs: medians[0], newMs: medians[1], ratio: medians[1] / medians[0] }))
    }
  }, 120_000)
})

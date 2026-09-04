/**
 * convolver-blocklen.test.ts —— Convolver 任意块长回归（验收审计发现：B>L 时湿路损坏）
 * 修复：逐样本放行（completedBlocks·L 记账 + totalOut 位置）+ 突发动态扩容。
 * 验证：B=128/512/1024/4096 下流式湿路与双精度直接卷积一致（延迟 L，无丢块/发散）。
 */
import { describe, it, expect } from 'vitest'
import { Convolver } from '../src/dsp/Convolver'

const FS = 48000
const zeros = (n: number) => new Float32Array(n)
const sine = (n: number, f: number, a: number, fs: number) => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / fs)
  return x
}
/** 参考：直接线性卷积（双精度） */
function directConv(x: Float32Array, ir: Float32Array): Float32Array {
  const y = new Float32Array(x.length + ir.length - 1)
  for (let i = 0; i < x.length; i++) for (let j = 0; j < ir.length; j++) y[i + j] += x[i] * ir[j]
  return y
}

describe('Convolver 任意块长（B ≤ 或 > 分区长 512）', () => {
  for (const B of [128, 512, 1024, 4096]) {
    it('B=' + B + '：流式湿路与直接卷积一致（延迟 L，零 NaN，无丢块/发散）', () => {
      const L = 512
      const cv = new Convolver(FS, { partitionSize: L, dePeriodize: false })
      const M = 800 // IR 长于分区（P=2）
      const ir = new Float32Array(M)
      for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / 200) * 0.5
      cv.loadIR(ir, 'exp')
      cv.setMix(1)
      const n = FS // 1s
      const x = sine(n, 440, 0.5, FS)
      const l = new Float32Array(n + L)
      l.set(x)
      const r = zeros(n + L)
      for (let off = 0; off < n + L; off += B) cv.processStereo(l.subarray(off, off + B), r.subarray(off, off + B))
      const ref = directConv(x, ir)
      let maxErr = 0
      let nan = 0
      for (let i = L; i < n; i++) {
        if (!Number.isFinite(l[i])) nan++
        const expected = i - L < ref.length ? ref[i - L] : 0
        maxErr = Math.max(maxErr, Math.abs(l[i] - expected))
      }
      expect(nan).toBe(0)
      expect(maxErr).toBeLessThan(1e-3)
    })
  }
})

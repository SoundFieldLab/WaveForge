/**
 * mside.test.ts —— MidSide.ts 单元测试
 * 数值容差说明：
 *  - 恒等断言 ±1e-7（物理意义：双精度中间量下 M+S 精确还原 L，浮点误差=0）；
 *  - 侧信号≈0 断言 1e-6（物理意义：vb=+1 时输出退化为单声道中信号）。
 */
import { describe, it, expect } from 'vitest'
import { MidSide } from '../src/dsp/MidSide'

/** 确定性 LCG 生成随机立体声（-1..1） */
function makeStereo(n: number, seed = 7): [Float32Array, Float32Array] {
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  let s = seed >>> 0
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0xffffffff) * 2 - 1
  }
  for (let i = 0; i < n; i++) {
    l[i] = rnd()
    r[i] = rnd()
  }
  return [l, r]
}

describe('MidSide', () => {
  it('width=1, vb=0 恒等：输出与输入逐样本一致（±1e-7）', () => {
    const [l, r] = makeStereo(1024)
    const l0 = Float32Array.from(l)
    const r0 = Float32Array.from(r)
    const ms = new MidSide()
    ms.setParams(1, 0)
    ms.processStereo(l, r)
    for (let i = 0; i < l.length; i++) {
      expect(Math.abs(l[i] - l0[i])).toBeLessThan(1e-7)
      expect(Math.abs(r[i] - r0[i])).toBeLessThan(1e-7)
    }
  })

  it('width=0 → L==R（侧信号置零，输出=中信号，即单声道）', () => {
    const [l, r] = makeStereo(512)
    const ms = new MidSide()
    ms.setParams(0, 0)
    ms.processStereo(l, r)
    for (let i = 0; i < l.length; i++) {
      expect(Math.abs(l[i] - r[i])).toBeLessThan(1e-7)
    }
  })

  it('vb=+1 → 侧信号≈0（输出为单声道中信号；L≈R 输入时输出同相）', () => {
    // 输入 L≈R（近似单声道）
    const n = 512
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = Math.sin(i * 0.1)
      l[i] = x
      r[i] = x * (1 + 1e-4)
    }
    const ms = new MidSide()
    ms.setParams(1, 1)
    ms.processStereo(l, r)
    for (let i = 0; i < n; i++) {
      expect(Math.abs(l[i] - r[i])).toBeLessThan(1e-6)
    }
    // 任意立体声输入 → 输出仍为单声道（S=0）
    const [a, b] = makeStereo(256)
    ms.processStereo(a, b)
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6)
    }
  })

  it('vb=-1 → 中信号≈0（"仅伴奏"：M 分量被移除，审计修复 M-2）', () => {
    // 输入 L≈R（纯中信号）
    const n = 512
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = Math.sin(i * 0.1)
      l[i] = x
      r[i] = x * (1 + 1e-4)
    }
    const ms = new MidSide()
    ms.setParams(1, -1)
    ms.processStereo(l, r)
    // 输出 = 侧信号；输入 L≈R（r=l×(1+1e-4)）→ 侧信号本底 ≈ 5e-5，容差 1e-3
    for (let i = 0; i < n; i++) {
      expect(Math.abs(l[i])).toBeLessThan(1e-3)
      expect(Math.abs(r[i])).toBeLessThan(1e-3)
    }
    // 任意立体声输入：输出中信号分量为 0（L'=S、R'=−S）
    const [a, b] = makeStereo(256)
    const m = new Float32Array(a.length)
    for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2
    ms.processStereo(a, b)
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] + b[i]) / 2).toBeLessThan(1e-6)
    }
  })

  it('width=2 → 侧信号增益×2（宽度增强）', () => {
    const [l, r] = makeStereo(256)
    const inDiff = new Float32Array(l.length) // 输入差 L−R
    for (let i = 0; i < l.length; i++) inDiff[i] = l[i] - r[i]
    const ms = new MidSide()
    ms.setParams(2, 0)
    ms.processStereo(l, r)
    for (let i = 0; i < l.length; i++) {
      // L'=M+2S、R'=M−2S → L'−R' = 4S = 2(L−R)
      expect(Math.abs((l[i] - r[i]) - 2 * inDiff[i])).toBeLessThan(1e-6)
    }
  })

  it('参数 clamp：width>2 等效 2；vb 越界等效 ±1（行为一致性）', () => {
    const [l1, r1] = makeStereo(128)
    const [l2, r2] = makeStereo(128)
    const ms = new MidSide()
    ms.setParams(5, 0)
    ms.processStereo(l1, r1)
    ms.setParams(2, 0)
    ms.processStereo(l2, r2)
    for (let i = 0; i < l1.length; i++) {
      expect(Math.abs(l1[i] - l2[i])).toBeLessThan(1e-7)
      expect(Math.abs(r1[i] - r2[i])).toBeLessThan(1e-7)
    }
  })
})

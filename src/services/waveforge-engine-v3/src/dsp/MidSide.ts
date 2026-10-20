import type { AudioBuffer } from './audioBuffer'
import { Biquad } from './biquad'
/**
 * MidSide.ts —— M/S 立体声编解码 + 宽度 / 人声比例（自研，技术文档 §8）
 *
 * 出处/许可：自研。M/S 变换（M=(L+R)/2、S=(L−R)/2 及逆变换 L=M+S、R=M−S）
 * 为音频处理公有知识，无第三方代码。
 *
 * 语义（API_SPEC 模块 4）：
 *  - width 0..2（1=原始宽度）；voiceBalance -1..1（-1=仅伴奏(侧信号)/ +1=仅人声(中信号)）。
 *  - 人声比例用对称的 "M 衰减 / S 衰减" 线性混合（电平安全，审计修复 M-2）：
 *      vb=0：midGain=1, sideGain=width（仅宽度控制，恒等）
 *      vb>0：midGain=1, sideGain=width·(1−vb)（衰减侧信号 → 人声；vb=+1 完全去侧）
 *      vb<0：midGain=1+vb, sideGain=width（衰减中信号 → 伴奏；vb=−1 完全去中）
 *  - vb=0 且 width=1 时输出与输入逐样本一致（双精度中间量，误差=0）。
 *
 * 约定：确定性；processStereo 内零分配；参数越界自动 clamp。
 */

export class MidSide {
  private midGain = 1
  private sideGain = 1
  private lowMonoTarget = 0
  private lowMonoMix = 0
  private lowMonoCutoffHz = 120
  private readonly lowMonoAlpha: number
  private readonly sideHighpass: Biquad

  constructor(sampleRate = 48000) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.lowMonoAlpha = 1 - Math.exp(-1 / (sampleRate * 0.02))
    this.sideHighpass = new Biquad('highpass', this.lowMonoCutoffHz, Math.SQRT1_2, 0, sampleRate)
  }

  /** width 0..2、voiceBalance -1..1、lowMonoAmount 0..1；低频截止处平滑收窄 Side。 */
  setParams(width: number, voiceBalance: number, lowMonoCutoffHz = 120, lowMonoAmount = 0): void {
    const w = Number.isFinite(width) ? Math.min(Math.max(width, 0), 2) : 1
    const vb = Number.isFinite(voiceBalance) ? Math.min(Math.max(voiceBalance, -1), 1) : 0
    const cutoff = Number.isFinite(lowMonoCutoffHz) ? Math.min(Math.max(lowMonoCutoffHz, 40), 250) : 120
    this.lowMonoTarget = Number.isFinite(lowMonoAmount) ? Math.min(Math.max(lowMonoAmount, 0), 1) : 0
    if (cutoff !== this.lowMonoCutoffHz) {
      this.lowMonoCutoffHz = cutoff
      this.sideHighpass.setParams('highpass', cutoff, Math.SQRT1_2, 0)
    }
    // 对称语义：vb>0 衰减侧信号（仅人声），vb<0 衰减中信号（仅伴奏）
    const mg = 1 + Math.min(0, vb)
    const sg = w * (1 - Math.max(0, vb))
    this.midGain = mg
    this.sideGain = sg
  }

  /** 就地 M/S 编解码；低频侧信号按 20ms 平滑量渐进收窄，不改变中声道。 */
  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    if (l.length !== r.length) throw new Error('midside: L/R length mismatch')
    const mg = this.midGain
    const sg = this.sideGain
    if (mg === 1 && sg === 1 && this.lowMonoTarget === 0 && this.lowMonoMix < 1e-7) return
    if (this.lowMonoTarget === 0 && this.lowMonoMix < 1e-7) {
      for (let i = 0; i < l.length; i++) {
        const m = (l[i] + r[i]) * 0.5
        const s = (l[i] - r[i]) * 0.5
        l[i] = m * mg + s * sg
        r[i] = m * mg - s * sg
      }
      return
    }
    for (let i = 0; i < l.length; i++) {
      const li = l[i]
      const ri = r[i]
      const m = (li + ri) * 0.5 // 中信号（双精度：相加除 2 无舍入）
      const s = (li - ri) * 0.5 // 侧信号（双精度）
      this.lowMonoMix += this.lowMonoAlpha * (this.lowMonoTarget - this.lowMonoMix)
      const highPassedSide = this.sideHighpass.process(s)
      const side = s + this.lowMonoMix * (highPassedSide - s)
      l[i] = m * mg + side * sg
      r[i] = m * mg - side * sg
    }
  }

  reset(): void {
    this.sideHighpass.reset()
    this.lowMonoMix = 0
  }
}


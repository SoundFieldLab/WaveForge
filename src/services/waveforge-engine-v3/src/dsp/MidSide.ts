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

  constructor() {}

  /** width 0..2（1=原始），voiceBalance -1..1（-1=仅伴奏 / +1=仅人声） */
  setParams(width: number, voiceBalance: number): void {
    const w = Math.min(Math.max(width, 0), 2)
    const vb = Math.min(Math.max(voiceBalance, -1), 1)
    // 对称语义：vb>0 衰减侧信号（仅人声），vb<0 衰减中信号（仅伴奏）
    const mg = 1 + Math.min(0, vb)
    const sg = w * (1 - Math.max(0, vb))
    this.midGain = mg
    this.sideGain = sg
  }

  /** 就地 M/S 编解码：输入立体声，输出处理后的立体声（M/S 域增益 → 反变换） */
  processStereo(l: Float32Array, r: Float32Array): void {
    if (l.length !== r.length) throw new Error('midside: L/R length mismatch')
    const mg = this.midGain
    const sg = this.sideGain
    for (let i = 0; i < l.length; i++) {
      const li = l[i]
      const ri = r[i]
      const m = (li + ri) * 0.5 // 中信号（双精度：相加除 2 无舍入）
      const s = (li - ri) * 0.5 // 侧信号（双精度）
      l[i] = m * mg + s * sg
      r[i] = m * mg - s * sg
    }
  }

  /** 无内部状态，保留接口一致性 */
  reset(): void {}
}

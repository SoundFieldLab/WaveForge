// 音频线程时钟：在音频渲染线程上按时基发 tick。
//
// 为什么需要它：页面被隐藏/遮挡时 Chromium 会把主线程的定时器压到 ~1Hz、rAF 完全停止
// （实测：setInterval(16ms) → 2/s，rAF → 0）。而**音频线程不受页面可见性影响**——
// 实测同一页面在被遮挡 + 节流生效时，本 worklet 的消息仍按原速率送达。
//
// 于是「窗口不可见时仍需继续」的后台工作（RGB 氛围灯按 fps 推帧、后台音频分析租约）
// 由这里驱动，而不是靠关掉整个窗口的后台节流（那会让 document.visibilityState 永久
// 停在 'visible'，界面在不可见时仍满速渲染，并让全仓的可见性门控全部失效）。
//
// 计数单位是 process() 调用次数而不是音频帧数：设备缓冲/渲染批次未知，
// 按帧数计数会随缓冲大小整体偏移。主线程会根据观测到的 tick 间隔自行校准节拍容差。
//
// 本文件是 public/ 下的静态资源（同 v3-worklet.js 的做法），不经过打包，
// 以便用同源路径 addModule（blob: 会被 index.html 的 script-src 'self' 拦掉）。
class WaveForgeAudioClockProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.callsSinceTick = 0
    // 2 次 process 一个 tick：既够精细（容差可校准到毫秒级），又不会每批次都发消息
    this.tickEveryCalls = 2
    this.port.onmessage = (event) => {
      const every = event.data && event.data.tickEveryCalls
      if (typeof every === 'number' && every >= 1) this.tickEveryCalls = Math.round(every)
    }
  }

  process(_inputs, outputs) {
    // 本节点只做计时，输出必须显式清零：接了 destination 却不写输出会被判为未初始化
    const out = outputs[0]
    if (out) {
      for (let channel = 0; channel < out.length; channel += 1) out[channel].fill(0)
    }
    this.callsSinceTick += 1
    if (this.callsSinceTick >= this.tickEveryCalls) {
      this.callsSinceTick = 0
      this.port.postMessage(this.tickEveryCalls)
    }
    return true
  }
}

registerProcessor('waveforge-audio-clock', WaveForgeAudioClockProcessor)

'use strict'

// 主窗后台节流 + 后台推送时钟的契约。
//
// 背景（都是实测结论，不是推测）：
//   1. backgroundThrottling:false 会把 Page Visibility API 永久钉在 'visible'——窗口被别的
//      窗口完全盖住时 rAF 仍按 240fps 满速跑（对照组 throttling:true 是 0fps + hidden），
//      且全仓 25+ 处基于可见性的门控变成死代码（含 Chroma 自己的「hidden 且未开后台运行
//      → 释放灯效」）。所以主窗必须默认开启节流。
//   2. 开启节流后，隐藏时主线程定时器被压到 ~1Hz、rAF 归零，后台推送（RGB 推帧、
//      后台音频分析）会停摆。解决办法不是「让窗口一直醒着」，而是换一个不受页面可见性
//      影响的时钟：实测同一页面被遮挡 + 节流生效时，AudioWorklet 的消息仍是 189/s。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const main = read('desktop/main.cjs')

test('主窗默认开启后台节流（关闭会让 Page Visibility API 失效）', () => {
  const createWindowAt = main.indexOf('function createWindow()')
  assert.ok(createWindowAt > 0, '找不到 createWindow')
  const body = main.slice(createWindowAt, createWindowAt + 4000)
  assert.match(body, /backgroundThrottling: true/, '主窗必须默认开启节流')
  assert.doesNotMatch(
    body,
    /backgroundThrottling: false/,
    '主窗不得写死关闭节流——那会让 visibilityState 永远为 visible，门控全部失效',
  )
})

test('「动态关闭窗口节流」的旧机制已彻底移除（它带着释放不生效的缺陷）', () => {
  // 旧方案：插件申请时调 webContents.setBackgroundThrottling(false)。实测运行时再设回 true
  // 不会撤销已放开的帧产出（要等窗口重新显示），所以改用音频线程时钟，相关管线不应残留。
  assert.doesNotMatch(main, /system:set-background-work/, 'main.cjs 不应再有 set-background-work')
  assert.doesNotMatch(main, /mainWindowBackgroundWorkSources/, 'main.cjs 不应再有后台工作来源集合')
  assert.doesNotMatch(read('desktop/preload.cjs'), /setBackgroundWork/, 'preload 不应再有 setBackgroundWork')
  assert.doesNotMatch(read('src/electron.d.ts'), /setBackgroundWork/, 'electron.d.ts 不应再有 setBackgroundWork')
  assert.doesNotMatch(read('src/hooks/useAudioAnalyzer.ts'), /setBackgroundWork/, '渲染层不应再有 setBackgroundWork')
})

test('音频线程时钟：worklet 静态资源在位且用同源相对路径加载', () => {
  const workletPath = path.join(root, 'public/wf-audio-clock-worklet.js')
  assert.ok(fs.existsSync(workletPath), '缺少 public/wf-audio-clock-worklet.js')
  const worklet = read('public/wf-audio-clock-worklet.js')
  assert.match(worklet, /registerProcessor\('waveforge-audio-clock'/, 'worklet 必须注册处理器')
  assert.match(worklet, /out\[channel\]\.fill\(0\)/, '接了 destination 的输出必须显式清零')
  // 按 process() 调用次数计数：设备缓冲/渲染批次未知（实测本机不是 48kHz 的常规批次），
  // 按音频帧数计数会随缓冲大小整体偏移；容差由主线程从观测到的 tick 间隔自校准。
  assert.match(worklet, /this\.callsSinceTick \+= 1/, '应按 process 调用计数')
  assert.doesNotMatch(worklet, /framesSinceTick/, '不应按音频帧计数')

  const clock = read('src/services/audioThreadClock.ts')
  assert.match(clock, /'\.\/wf-audio-clock-worklet\.js'/, 'worklet 需用同源相对路径（blob: 会被 script-src 拦掉）')
  assert.match(clock, /new WeakMap<BaseAudioContext, AudioThreadClock>/, '同一 context 应共享一个时钟')
  assert.match(clock, /STALL_FALLBACK_MS/, '音频图停摆（context 挂起）需要有兜底心跳')
})

test('后台推送改由音频线程时钟驱动', () => {
  const clock = read('src/services/audioThreadClock.ts')
  assert.match(clock, /export function startFrameTicker/, '需要给调用方一个稳定的按帧率心跳')
  assert.match(clock, /const timer = setInterval\(callback/, '取不到时钟时要退回定时器（功能不丢）')
  // 节拍容差必须自校准：设备渲染批次未知，写死推算常数会隔格跳过（实测 30fps 跑成 15.3/s）
  assert.match(clock, /const calibrate = \(gapMs/, '容差必须自校准')

  // 1) 分析器：隐藏 + 有后台租约时换驱动源，而不是让 rAF/setTimeout 空转
  const analyzer = read('src/hooks/useAudioAnalyzer.ts')
  assert.match(analyzer, /ensureHiddenClock/, '分析器需要隐藏时的时钟驱动')
  assert.match(
    analyzer,
    /document\.visibilityState === 'hidden' && store\.hasBackgroundConsumers\(\)/,
    '隐藏 + 后台租约才切时钟',
  )
  assert.match(analyzer, /getAudioThreadClock\(store\.getAudioContext\(\)\)/, '时钟应取自当前音频上下文')
  assert.match(analyzer, /getAudioContext: \(\) => BaseAudioContext \| null/, 'store 需要暴露音频上下文')

  // 2) Chroma 推帧：必须不再用 setInterval
  const chroma = read('src/plugins/clients/ChromaClient.ts')
  assert.match(chroma, /startFrameTicker\(/, 'Chroma 推帧应走音频线程时钟')
  assert.doesNotMatch(chroma, /setInterval\(pushResult/, '不应再留 setInterval 推帧')
  assert.match(chroma, /if \(hidden && releaseSent\) return;/, '已释放时隐藏期间不必每帧重算引擎')
  assert.match(chroma, /if \(!hidden\) releaseSent = false;/, '回到可见要复位释放态，否则灯效停摆')
})

test('副屏覆盖窗保持原样（它们从不 hide、且是 screen-saver 级置顶）', () => {
  // 这两个窗口不会被遮挡，节流与否无差别；改成 true 反而可能因 Windows 遮挡误判冻住歌词
  const playerAt = main.indexOf('function createDesktopPlayerWindow()')
  const lyricsAt = main.indexOf('function createDesktopLyricsWindow()')
  for (const [label, at] of [['桌面播放器', playerAt], ['桌面歌词', lyricsAt]]) {
    assert.ok(at > 0, `找不到 ${label} 窗口创建`)
    assert.match(main.slice(at, at + 2500), /backgroundThrottling: false/, `${label} 应保持不节流`)
  }
})

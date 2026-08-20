/**
 * 空间渲染后端接口（SpatialBackend）
 *
 * 仿照 offline/Separator.ts 的 StemSeparatorAdapter 先例：接口先行、实现可替换。
 *  - TsConvolverBackend：TS 参考实现（复用 dsp/Convolver.ts 分区 FFT 卷积），
 *    兼作数值对拍 ground truth；
 *  - WasmHrtfBackend：rust/hrtf-core（#[no_mangle] extern "C"，无 wasm-bindgen）
 *    性能实现，契约函数见规划书 §3.2（spatial_load_hrtf / spatial_render_objects / ...）。
 *
 * 热路径约束（同 AudioEffectsProcessor）：稳态零分配、不阻塞、
 * processStereo 每块调用一次（128 样本量子），outL/outR 必须完整写入。
 */
import type { HrtfGrid, ListenerState, SpatialRenderConfig } from './types'

export interface SpatialBackend {
  /** 设置 HRTF 网格（可重复调用换数据集）；实现内部预计算分区谱 */
  loadHrtf(grid: HrtfGrid): void
  /** 更新渲染配置（扬声器布局/房间/强度/衰减模型…），参数变化时调用 */
  setConfig(config: SpatialRenderConfig): void
  /** 更新听者状态（波 1 头锁定，实现可忽略） */
  setListener(listener: ListenerState): void
  /**
   * 渲染一个 block：输入立体声 → 双耳输出。
   * 输入声道按 config.speakers[].channel 路由到各虚拟扬声器，HRTF 卷积后求和。
   */
  processStereo(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void
  /**
   * 渲染一个 block（多声道输入，可选方法）：N 路单声道输入 → 双耳输出。
   * 与 processStereo 同算法仅输入侧扩展——按 speaker.channel 索引取源
   * （channel < inputs.length 时取对应输入；越界取 0 号输入）；干路 = 0/1 号输入
   * （立体声下混）。实现方无此方法时 processor 回退 2 路下混（processStereo）。
   */
  processMulti?(inputs: Float32Array[], outL: Float32Array, outR: Float32Array): void
  /** 后端引入的延迟样本数（分区卷积 = 1 分区长度）；0 = 无额外延迟 */
  getLatencySamples(): number
  reset(): void
}

/**
 * WaveForge 音频效果引擎 v3 —— 声源分离任务队列（offline）
 *
 * 出处/许可：模型方案 spleeter(Deezer, MIT) / demucs(Meta, MIT)，浏览器经
 *   ONNX Runtime Web 推理（技术文档 §11 / 映射表 #16 🟢 套用模型 + 🔴 任务队列自研）；
 *   本文件只实现任务队列状态机与适配器接口，ONNX 接入为占位（待实现时抛明确错误）。
 *
 * 语义：FIFO 顺序执行（同一时刻最多一个任务在跑）；enqueue 后若队列空闲立即启动；
 *   cancel 对 queued/running 任务生效（running 任务的结果在返回时被丢弃，不影响后续）；
 *   完成结果仅通过 onComplete 回调交付；进度通过 onProgress(0..1) 上报。
 * 确定性：无随机、无 Date、无 I/O，状态迁移仅由调用序列决定。
 */

export type SeparationStem = 'vocals' | 'drums' | 'bass' | 'other'

/** 分离适配器：接入任意推理后端（ONNX Runtime Web / Web Worker 等） */
export interface StemSeparatorAdapter {
  separate(
    input: Float32Array,
    stems: SeparationStem[],
    onProgress?: (p: number) => void,
  ): Promise<Record<string, Float32Array>>
}

export interface SeparationTask {
  id: number
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'
  stems: SeparationStem[]
  error?: string
}

/** 默认分离声部：人声/鼓/贝斯/其他 */
export const DEFAULT_STEMS: SeparationStem[] = ['vocals', 'drums', 'bass', 'other']

export class SeparationQueue {
  private readonly adapter: StemSeparatorAdapter
  private readonly tasks: SeparationTask[] = []
  private readonly inputs = new Map<number, Float32Array>()
  private nextId = 1
  private running = false

  onProgress?: (taskId: number, p: number) => void
  onComplete?: (taskId: number, stems: Record<string, Float32Array>) => void

  constructor(adapter: StemSeparatorAdapter) {
    this.adapter = adapter
  }

  /** 入队一个分离任务；队列空闲则立即开始执行，返回任务句柄（状态实时可见） */
  enqueue(input: Float32Array, stems: SeparationStem[] = DEFAULT_STEMS): SeparationTask {
    const task: SeparationTask = { id: this.nextId++, state: 'queued', stems: stems.slice() }
    this.tasks.push(task)
    this.inputs.set(task.id, input)
    this.pump()
    return task
  }

  /** 取消任务：queued 直接作废；running 标记取消（结果返回时丢弃） */
  cancel(taskId: number): void {
    const task = this.tasks.find((t) => t.id === taskId)
    if (!task) return
    if (task.state === 'queued' || task.state === 'running') task.state = 'cancelled'
  }

  /** 当前全部任务快照（副本，防外部篡改） */
  getTasks(): SeparationTask[] {
    return this.tasks.map((t) => ({ ...t, stems: t.stems.slice() }))
  }

  /** 调度：取第一个 queued 任务执行；running 期间不并发 */
  private pump(): void {
    if (this.running) return
    const task = this.tasks.find((t) => t.state === 'queued')
    if (!task) return
    this.running = true
    task.state = 'running'
    const input = this.inputs.get(task.id)
    if (!input) {
      // 理论不可达（enqueue 时已存输入）；防御性兜底
      task.state = 'failed'
      task.error = 'missing input buffer'
      this.running = false
      this.pump()
      return
    }
    this.adapter
      .separate(input, task.stems, (p) => {
        // 已取消的任务不再转发进度
        if (task.state === 'running') this.onProgress?.(task.id, p)
      })
      .then(
        (stems) => {
          this.running = false
          this.inputs.delete(task.id)
          if (task.state === 'cancelled') {
            // 取消任务的结果丢弃
          } else {
            task.state = 'done'
            this.onComplete?.(task.id, stems)
          }
          this.pump()
        },
        (err: unknown) => {
          this.running = false
          this.inputs.delete(task.id)
          if (task.state === 'cancelled') {
            // 取消任务的结果丢弃
          } else {
            task.state = 'failed'
            task.error = err instanceof Error ? err.message : String(err)
          }
          this.pump()
        },
      )
  }
}

/** ONNX 分离适配器占位：接 ONNX Runtime Web 后实现（spleeter/demucs 模型推理） */
export class OnnxStemSeparator implements StemSeparatorAdapter {
  separate(
    _input: Float32Array,
    _stems: SeparationStem[],
    _onProgress?: (p: number) => void,
  ): Promise<Record<string, Float32Array>> {
    // 占位：当前明确拒绝，避免静默返回空结果
    throw new Error('ONNX adapter not implemented')
  }
}

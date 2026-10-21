import type { ConvolutionPurpose } from '../types'

export interface ConvolutionIrMetadata {
  id: string
  name: string
  purpose: ConvolutionPurpose
  sampleRate: number
  sampleCount: number
}

interface Entry extends ConvolutionIrMetadata {
  ir: Float32Array
}

/**
 * 运行时 IR 库：集中管理房间、扬声器和耳机校正脉冲响应，避免参数快照复制大数组。
 * 音频数据始终按副本进出；引擎参数只保存 irId/irName，宿主在切换时调用 get() 重新装载。
 */
export class ConvolutionIrLibrary {
  private readonly maxEntries: number
  private readonly entries = new Map<string, Entry>()

  constructor(maxEntries = 32) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('ir library: invalid capacity')
    this.maxEntries = maxEntries
  }

  register(id: string, ir: Float32Array, metadata: Omit<ConvolutionIrMetadata, 'id' | 'sampleCount'>): ConvolutionIrMetadata {
    if (!id.trim()) throw new Error('ir library: empty id')
    if (!(ir instanceof Float32Array) || ir.length === 0) throw new Error('ir library: empty impulse response')
    let nonZero = false
    for (let i = 0; i < ir.length; i++) {
      if (!Number.isFinite(ir[i])) throw new Error('ir library: invalid impulse response')
      if (ir[i] !== 0) nonZero = true
    }
    if (!nonZero) throw new Error('ir library: all-zero impulse response')
    if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate <= 0) throw new Error('ir library: invalid sample rate')
    if (this.entries.size >= this.maxEntries && !this.entries.has(id)) throw new Error('ir library: capacity exceeded')
    const entry: Entry = { id, name: metadata.name.trim() || id, purpose: metadata.purpose, sampleRate: metadata.sampleRate, sampleCount: ir.length, ir: ir.slice() }
    this.entries.set(id, entry)
    return this.metadata(entry)
  }

  get(id: string): Float32Array | null {
    const entry = this.entries.get(id)
    return entry ? entry.ir.slice() : null
  }

  getMetadata(id: string): ConvolutionIrMetadata | null {
    const entry = this.entries.get(id)
    return entry ? this.metadata(entry) : null
  }

  list(): ConvolutionIrMetadata[] {
    return Array.from(this.entries.values(), (entry) => this.metadata(entry))
  }

  remove(id: string): boolean {
    return this.entries.delete(id)
  }

  clear(): void {
    this.entries.clear()
  }

  private metadata(entry: Entry): ConvolutionIrMetadata {
    return { id: entry.id, name: entry.name, purpose: entry.purpose, sampleRate: entry.sampleRate, sampleCount: entry.sampleCount }
  }
}


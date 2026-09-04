/**
 * SeparationQueue 单元测试（API_SPEC 小节 H）
 *
 * 断言语义：FIFO 顺序执行（同一时刻至多一个 running）；取消 queued 任务被跳过；
 * 取消 running 任务结果被丢弃且不触发 onComplete；失败任务记录 error 并继续队列；
 * 进度回调 0..1；结果仅经 onComplete 交付；OnnxStemSeparator 占位明确抛错。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEMS,
  OnnxStemSeparator,
  SeparationQueue,
  type SeparationStem,
  type StemSeparatorAdapter,
} from '../src/offline/Separator'

/** 可控适配器：任务挂起直到测试手动 resolve/reject */
class FakeAdapter implements StemSeparatorAdapter {
  pending: {
    input: Float32Array
    stems: SeparationStem[]
    onProgress?: (p: number) => void
    resolve: (v: Record<string, Float32Array>) => void
    reject: (e: unknown) => void
  }[] = []

  separate(
    input: Float32Array,
    stems: SeparationStem[],
    onProgress?: (p: number) => void,
  ): Promise<Record<string, Float32Array>> {
    return new Promise((resolve, reject) => {
      this.pending.push({ input, stems, onProgress, resolve, reject })
    })
  }
}

/** 让微任务队列排空（Promise.then 回调执行） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function stemsFor(n: number): Record<string, Float32Array> {
  return { vocals: new Float32Array([n]), drums: new Float32Array([n]), bass: new Float32Array([n]), other: new Float32Array([n]) }
}

describe('DEFAULT_STEMS 与适配器占位', () => {
  it('默认声部 = vocals/drums/bass/other', () => {
    expect(DEFAULT_STEMS).toEqual(['vocals', 'drums', 'bass', 'other'])
  })

  it('OnnxStemSeparator 占位：separate 抛 Error(' + "'ONNX adapter not implemented'" + ')', () => {
    const sep = new OnnxStemSeparator()
    expect(() => sep.separate(new Float32Array(0), DEFAULT_STEMS)).toThrow('ONNX adapter not implemented')
  })
})

describe('SeparationQueue 状态机', () => {
  it('入队即启动第一个任务（running），第二个排队（queued），默认声部', () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const t1 = q.enqueue(new Float32Array(4))
    expect(t1.state).toBe('running')
    expect(t1.stems).toEqual(DEFAULT_STEMS)
    const t2 = q.enqueue(new Float32Array(4), ['vocals'])
    expect(t2.state).toBe('queued')
    expect(t2.stems).toEqual(['vocals'])
    expect(q.getTasks().map((t) => t.state)).toEqual(['running', 'queued'])
  })

  it('顺序执行：第一个完成后第二个自动开始，onComplete 收到 stems', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const completed: { id: number; stems: Record<string, Float32Array> }[] = []
    q.onComplete = (taskId, stems) => completed.push({ id: taskId, stems })

    const t1 = q.enqueue(new Float32Array(4))
    const t2 = q.enqueue(new Float32Array(4))
    expect(adapter.pending).toHaveLength(1) // 同一时刻只跑一个

    adapter.pending[0].resolve(stemsFor(1))
    await flush()
    expect(t1.state).toBe('done')
    expect(t2.state).toBe('running')
    expect(completed).toHaveLength(1)
    expect(completed[0].id).toBe(t1.id)
    expect(completed[0].stems.vocals[0]).toBe(1)
    expect(adapter.pending).toHaveLength(2)

    adapter.pending[1].resolve(stemsFor(2))
    await flush()
    expect(t2.state).toBe('done')
    expect(completed).toHaveLength(2)
    expect(completed[1].id).toBe(t2.id)
  })

  it('取消排队任务：被跳过，不执行', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const t1 = q.enqueue(new Float32Array(4))
    const t2 = q.enqueue(new Float32Array(4))
    const t3 = q.enqueue(new Float32Array(4))
    q.cancel(t2.id)
    expect(t2.state).toBe('cancelled')

    adapter.pending[0].resolve(stemsFor(1))
    await flush()
    // t2 被跳过，直接运行 t3
    expect(t1.state).toBe('done')
    expect(t2.state).toBe('cancelled')
    expect(t3.state).toBe('running')
    expect(adapter.pending.map((p) => p.stems)).toHaveLength(2) // t2 从未提交给适配器
  })

  it('取消运行中任务：结果被丢弃，不触发 onComplete，队列继续', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const completed: number[] = []
    q.onComplete = (id) => completed.push(id)

    const t1 = q.enqueue(new Float32Array(4))
    const t2 = q.enqueue(new Float32Array(4))
    q.cancel(t1.id)
    expect(t1.state).toBe('cancelled')

    adapter.pending[0].resolve(stemsFor(1))
    await flush()
    expect(t1.state).toBe('cancelled') // 结果丢弃，状态保持 cancelled
    expect(completed).toHaveLength(0)
    expect(t2.state).toBe('running') // 队列继续

    adapter.pending[1].resolve(stemsFor(2))
    await flush()
    expect(completed).toEqual([t2.id])
    expect(t2.state).toBe('done')
  })

  it('失败任务：state=failed + error，队列继续', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const t1 = q.enqueue(new Float32Array(4))
    const t2 = q.enqueue(new Float32Array(4))

    adapter.pending[0].reject(new Error('model load failed'))
    await flush()
    expect(t1.state).toBe('failed')
    expect(t1.error).toBe('model load failed')
    expect(t2.state).toBe('running')

    adapter.pending[1].resolve(stemsFor(3))
    await flush()
    expect(t2.state).toBe('done')
  })

  it('进度回调：收到 0..1 的进度；取消后不再转发', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const progress: number[] = []
    q.onProgress = (_id, p) => progress.push(p)

    const t1 = q.enqueue(new Float32Array(4))
    q.cancel(t1.id)
    adapter.pending[0].onProgress?.(0.5) // 取消后转发被抑制
    adapter.pending[0].resolve(stemsFor(1))
    await flush()
    expect(progress).toHaveLength(0)

    const t2 = q.enqueue(new Float32Array(4))
    adapter.pending[1].onProgress?.(0.25)
    adapter.pending[1].onProgress?.(0.9)
    adapter.pending[1].resolve(stemsFor(2))
    await flush()
    expect(progress).toEqual([0.25, 0.9])
    expect(t2.state).toBe('done')
  })

  it('getTasks 返回副本：修改不影响内部状态', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const t1 = q.enqueue(new Float32Array(4))
    const snap = q.getTasks()[0]
    snap.state = 'done'
    snap.stems.push('bass')
    expect(t1.state).toBe('running')
    expect(q.getTasks()[0].stems).toHaveLength(4)
  })

  it('队列空闲后新入队立即运行；任务 id 递增', async () => {
    const adapter = new FakeAdapter()
    const q = new SeparationQueue(adapter)
    const t1 = q.enqueue(new Float32Array(4))
    adapter.pending[0].resolve(stemsFor(1))
    await flush()
    expect(t1.id).toBe(1)
    const t2 = q.enqueue(new Float32Array(4))
    expect(t2.id).toBe(2)
    expect(t2.state).toBe('running') // 队列已空闲 → 立即执行
  })
});

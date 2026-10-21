import type { Dataset } from 'h5wasm'
import { sofaDataToGrid } from '../src/spatial/HrtfDataset'
import type { HrtfGrid } from '../src/spatial/types'

/** HDF5/WASM 仅在导入用户本地文件时装载，不进入 AudioWorklet。 */
export async function importSofaFile(file: File, sampleRate: number): Promise<HrtfGrid> {
  if (file.size > 32 * 1024 * 1024) throw new Error('SOFA 文件不能超过 32 MiB')
  const h5 = await import('h5wasm')
  const { FS } = await h5.ready
  const path = `/hrtf-${Date.now()}-${Math.random().toString(36).slice(2)}.sofa`
  FS.writeFile(path, new Uint8Array(await file.arrayBuffer()))
  let input: InstanceType<typeof h5.File> | undefined
  try {
    input = new h5.File(path, 'r')
    const get = (name: string) => {
      const dataset = input!.get(name)
      if (!(dataset instanceof h5.Dataset)) throw new Error(`SOFA 缺少 ${name}`)
      return dataset as Dataset
    }
    const values = (dataset: Dataset): ArrayLike<number> => {
      const value = dataset.value
      // HDF5 的采样率/延迟可能是整数，h5wasm 会返回整型 TypedArray 或标量。
      const raw = typeof value === 'number' || typeof value === 'bigint' ? [value]
        : Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView)) ? Array.from(value as ArrayLike<unknown>) : null
      if (!raw || raw.some(item => (typeof item !== 'number' && typeof item !== 'bigint') || !Number.isFinite(Number(item))
        || (typeof item === 'bigint' && !Number.isSafeInteger(Number(item))))) throw new Error('SOFA 数据必须为有限数值数组')
      return Float64Array.from(raw, item => Number(item))
    }
    const attribute = (object: { attrs: Record<string, { value: unknown }> }, name: string, fallback = '') => String(object.attrs[name]?.value ?? fallback)
    const ir = get('Data.IR'), positions = get('SourcePosition'), rate = values(get('Data.SamplingRate'))
    const shape = ir.shape
    if (!shape || shape.length !== 3 || shape[1] !== 2 || shape[0] > 4096 || shape[2] > 2048) throw new Error('SOFA Data.IR 必须为 M×2×N，且不超过支持容量')
    if (rate.length !== 1 && !Array.from(rate).every(value => value === rate[0])) throw new Error('SOFA 每方向的采样率必须相同')
    const receivers = get('ReceiverPosition'), receiverValues = values(receivers)
    if (attribute(receivers, 'Type', 'cartesian') !== 'cartesian' || receiverValues.length !== 6) throw new Error('SOFA 必须有固定的双耳笛卡尔接收器位置')
    for (const [name, expected] of [['ListenerView', [1, 0, 0]], ['ListenerUp', [0, 0, 1]], ['ListenerPosition', [0, 0, 0]]] as const) {
      const value = input.get(name)
      if (value instanceof h5.Dataset && !Array.from(values(value)).every((v, i) => Math.abs(v - expected[i % 3]) < 1e-5)) throw new Error('请先将 SOFA 听者坐标转换为原点、前 X / 上 Z')
    }
    const delay = input.get('Data.Delay')
    const delays = delay instanceof h5.Dataset ? values(delay) : undefined
    if (delays && delays.length !== 2 && delays.length !== shape[0] * 2) throw new Error('SOFA Data.Delay 维度无效')
    return sofaDataToGrid({ convention: attribute(input, 'SOFAConventions'), rate: rate[0], measurements: shape[0], samples: shape[2],
      positions: values(positions), ir: values(ir), delays, receiverLeft: receiverValues[1] >= receiverValues[4] ? 0 : 1,
      sourceType: attribute(positions, 'Type', 'spherical'), sourceUnits: attribute(positions, 'Units', 'degree, degree, metre'), name: file.name }, sampleRate)
  } finally { input?.close(); FS.unlink(path) }
}

/**
 * wasmSimdKernel —— 自研 WebAssembly SIMD128 复数乘法后端（f32x4 / f64x2）
 *
 * 出处/许可：
 *  - 本文件为自研代码，无任何第三方源码、无第三方构建工具。WASM 二进制由本文件内的
 *    LEB128 编码器 + 段构造器在运行时生成（约 370 字节），不依赖 wabt / binaryen /
 *    emscripten，也不新增任何依赖；不 fetch 外部 .wasm 文件，打包进 Worklet 后是纯常量代码。
 *  - SIMD 指令集为标准 WebAssembly SIMD128（定长 128 位），**不使用** relaxed-simd
 *    扩展；浮点乘加一律用 mul + add/sub 组合，不依赖 FMA。
 *  - 复数乘法语义与 Convolver 频域乘法一致：
 *      outR = xr*hr - xi*hi
 *      outI = xr*hi + xi*hr
 *
 * 为什么自己生成二进制：
 *  - 仓库没有 wabt / binaryen，也不能引入新的 Rust/原生构建链；硬编码十六进制 blob
 *    不可读也不可验证。用几十行编码器生成模块，opcode、段布局与循环结构都在源码里可审。
 *
 * 数值语义（重要）：
 *  - f32x4 的 mul / add / sub 每一步都按 IEEE-754 单精度舍入；TS 回退路径用 Math.fround
 *    逐步舍入与之逐位一致，因此「关闭 WASM」与「启用 WASM」的输出逐样本完全相同
 *    （Float32 精确相等），后端切换不会改变音频结果。
 *  - **与旧版纯 TS 四路展开（本文件引入前）的差异**：旧实现是「double 计算后单次舍入到
 *    Float32」，新实现是「每个乘/加/减都先舍入到 Float32（与 f32x4 一致）」。两者在
 *    Float32 输出上可能有 ≤1 ulp 的差异，因此**不能**声称与旧版逐位相同；这是为了让
 *    WASM 与 TS 两条路径互相逐位一致的必然结果。
 *  - f64x2 / double TS 路径均为 IEEE-754 双精度：与旧 double 实现逐位相同。
 *  - NaN 载荷可能因指令不同而不同（音频链路中非有限值属于非法输入，Convolver 已有
 *    非有限 IR 防护），未把 NaN 位模式作为行为契约。
 */

// —— 阈值 ——
/**
 * f32 路径启用 WASM 的最小可用样本数。
 *
 * 阈值依据（本机 Node v25.4.0 / win32-x64，用 esbuild 打包后的真实内核测；单次调用中位
 * 耗时，5 轮取中位；数据存 .verification/wasm-threshold-bench.json）：
 *
 *  count | WASM（含 6 次 memcpy） | TS 四路展开（fround 严格路径） | 加速比
 *    64  | 0.000260 ms             | 0.000191 ms                     | 0.74×
 *   128  | 0.000297 ms             | 0.000376 ms                     | 1.27×
 *   256  | 0.000346 ms             | 0.000736 ms                     | 2.13×
 *   512  | 0.000476 ms             | 0.001482 ms                     | 3.11×
 *  1024  | 0.000919 ms             | 0.002971 ms                     | 3.23×
 *  2048  | 0.001534 ms             | 0.005914 ms                     | 3.86×
 *  8192  | 0.005624 ms             | 0.024448 ms                     | 4.35×
 *
 * 交叉点约在 64~128 样本：更小时 memcpy 的固定开销（HEAP.set 调用与缓存查找）压过 4 倍
 * 向量吞吐，64 样本上 WASM 反而慢约 26%。阈值取 256（此时约 2.1 倍）给不同 CPU、缓存
 * 大小与 Electron 环境留一倍余量，同时避免为 64/128 的极小分区做无意义拷贝。
 * Convolver 的 fftSize = 2×分区长（64..2048）：分区 ≥ 128 起进入稳定收益区，分区 512/1024
 * 的常用配置分别拿到约 2.1–3.2 倍。
 */
export const WASM_SIMD_THRESHOLD_SAMPLES = 256
/** f64 每样本 8 字节，同样样本数的拷贝量是 f32 的两倍，因此按字节等价取 2 倍阈值。 */
export const WASM_SIMD_THRESHOLD_SAMPLES_F64 = WASM_SIMD_THRESHOLD_SAMPLES * 2

/** WASM 内存初始 1 页（64KiB），之后按需 grow 并复用。 */
const INITIAL_PAGES = 1
const PAGE_BYTES = 65536

// —— LEB128 编码器 ——

/** 无符号整数 → LEB128 变长字节。 */
function encodeU32Leb(value: number): number[] {
  let v = value >>> 0
  const out: number[] = []
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

/** 有符号整数 → LEB128 变长字节（二补码符号扩展）。 */
function encodeI32Leb(value: number): number[] {
  let v = value | 0
  const out: number[] = []
  for (;;) {
    const byte = v & 0x7f
    v >>= 7
    const signBit = (byte & 0x40) !== 0
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

// —— 段构造 ——

function encodeSection(id: number, payload: number[]): number[] {
  return [id, ...encodeU32Leb(payload.length), ...payload]
}

function encodeName(text: string): number[] {
  const bytes = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)
  return [...encodeU32Leb(bytes.length), ...bytes]
}

function encodeModule(sections: number[][]): Uint8Array {
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  for (const section of sections) out.push(...section)
  return Uint8Array.from(out)
}

// —— opcode（核心 MVP 指令 + SIMD 前缀 0xFD 的子操作码）——
// SIMD 子操作码由本机 V8 实测校准：对候选子码逐个编译并比对 1.5*2、1.5+2 等结果，
// 确定 f32x4 / f64x2 的 mul / add / sub 编号，不凭记忆硬写。
const OP = {
  BLOCK: 0x02,
  LOOP: 0x03,
  END: 0x0b,
  BR: 0x0c,
  BR_IF: 0x0d,
  LOCAL_GET: 0x20,
  LOCAL_SET: 0x21,
  I32_CONST: 0x41,
  I32_GE_U: 0x4f,
  I32_ADD: 0x6a,
  I32_AND: 0x71,
  I32_SHL: 0x74,
  SIMD_PREFIX: 0xfd,
} as const

const SIMD = {
  V128_LOAD: 0x00,
  V128_STORE: 0x0b,
  F32X4_ADD: 0xe4,
  F32X4_SUB: 0xe5,
  F32X4_MUL: 0xe6,
  F64X2_ADD: 0xf0,
  F64X2_SUB: 0xf1,
  F64X2_MUL: 0xf2,
} as const

/**
 * 生成一个 SIMD 复数乘法循环体。
 * 参数布局：(xr, xi, hr, hi, outR, outI, n) 全部是 i32 —— 前 6 个是**字节偏移**
 * （指向 WebAssembly.Memory 内部 16 字节对齐的分区），第 7 个是可用样本数。
 * 局部变量：7 = byteOffset，8 = byteLength，9..12 = 四个 v128 暂存。
 * 每轮推进 16 字节（f32 四样本 / f64 两样本）；尾部不足一个向量的样本由 JS 补齐。
 */
function encodeComplexProductBody(options: {
  shift: number
  laneMask: number
  mul: number
  add: number
  sub: number
}): number[] {
  const { shift, laneMask, mul, add, sub } = options
  const OFF = 7
  const LEN = 8
  const XR = 9
  const XI = 10
  const HR = 11
  const HI = 12
  const code: number[] = []
  const simd = (opcode: number): void => {
    code.push(OP.SIMD_PREFIX, ...encodeU32Leb(opcode))
  }
  // memarg：align 指数 4（16 字节自然对齐）、offset 0
  const memarg = (): void => {
    code.push(0x04, 0x00)
  }
  // LEN = (n & laneMask) << shift —— 只覆盖完整 128 位向量的字节数
  code.push(
    OP.LOCAL_GET, 6,
    OP.I32_CONST, ...encodeI32Leb(laneMask),
    OP.I32_AND,
    OP.I32_CONST, ...encodeI32Leb(shift),
    OP.I32_SHL,
    OP.LOCAL_SET, LEN,
    OP.I32_CONST, 0,
    OP.LOCAL_SET, OFF,
  )
  code.push(OP.BLOCK, 0x40, OP.LOOP, 0x40)
  code.push(OP.LOCAL_GET, OFF, OP.LOCAL_GET, LEN, OP.I32_GE_U, OP.BR_IF, 1)
  const loadLane = (param: number, local: number): void => {
    code.push(OP.LOCAL_GET, param, OP.LOCAL_GET, OFF, OP.I32_ADD)
    simd(SIMD.V128_LOAD)
    memarg()
    code.push(OP.LOCAL_SET, local)
  }
  loadLane(0, XR)
  loadLane(1, XI)
  loadLane(2, HR)
  loadLane(3, HI)
  const storeLane = (param: number, emitValue: () => void): void => {
    // v128.store 的栈顺序是「地址先入栈、值后入栈」
    code.push(OP.LOCAL_GET, param, OP.LOCAL_GET, OFF, OP.I32_ADD)
    emitValue()
    simd(SIMD.V128_STORE)
    memarg()
  }
  storeLane(4, () => {
    // outR = xr*hr - xi*hi
    code.push(OP.LOCAL_GET, XR, OP.LOCAL_GET, HR)
    simd(mul)
    code.push(OP.LOCAL_GET, XI, OP.LOCAL_GET, HI)
    simd(mul)
    simd(sub)
  })
  storeLane(5, () => {
    // outI = xr*hi + xi*hr
    code.push(OP.LOCAL_GET, XR, OP.LOCAL_GET, HI)
    simd(mul)
    code.push(OP.LOCAL_GET, XI, OP.LOCAL_GET, HR)
    simd(mul)
    simd(add)
  })
  code.push(OP.LOCAL_GET, OFF, OP.I32_CONST, ...encodeI32Leb(16), OP.I32_ADD, OP.LOCAL_SET, OFF)
  code.push(OP.BR, 0, OP.END, OP.END)
  // 局部变量声明：i32 × 2（7、8），v128 × 4（9..12）
  return [0x02, 0x02, 0x7f, 0x04, 0x7b, ...code, OP.END]
}

let cachedModuleBytes: Uint8Array | null = null

/**
 * 构造（并缓存）复数乘法 WASM 模块：
 *   (memory 1) (func "complexProductF32" (param i32 × 7)) (func "complexProductF64" ...)
 * 内存由模块导出，JS 侧只通过 Memory.buffer 的 Float32Array / Float64Array 视图做 memcpy。
 */
export function getComplexProductWasmModuleBytes(): Uint8Array {
  if (cachedModuleBytes) return cachedModuleBytes
  const typeSection = encodeSection(1, [
    ...encodeU32Leb(1),
    0x60,
    ...encodeU32Leb(7), 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f,
    ...encodeU32Leb(0),
  ])
  const functionSection = encodeSection(3, [...encodeU32Leb(2), 0x00, 0x00])
  const memorySection = encodeSection(5, [...encodeU32Leb(1), 0x00, ...encodeU32Leb(INITIAL_PAGES)])
  const exportSection = encodeSection(7, [
    ...encodeU32Leb(3),
    ...encodeName('complexProductF32'), 0x00, 0x00,
    ...encodeName('complexProductF64'), 0x00, 0x01,
    ...encodeName('memory'), 0x02, 0x00,
  ])
  const bodyF32 = encodeComplexProductBody({
    shift: 2, laneMask: -4, mul: SIMD.F32X4_MUL, add: SIMD.F32X4_ADD, sub: SIMD.F32X4_SUB,
  })
  const bodyF64 = encodeComplexProductBody({
    shift: 3, laneMask: -2, mul: SIMD.F64X2_MUL, add: SIMD.F64X2_ADD, sub: SIMD.F64X2_SUB,
  })
  const codeSection = encodeSection(10, [
    ...encodeU32Leb(2),
    ...encodeU32Leb(bodyF32.length), ...bodyF32,
    ...encodeU32Leb(bodyF64.length), ...bodyF64,
  ])
  cachedModuleBytes = encodeModule([typeSection, functionSection, memorySection, exportSection, codeSection])
  return cachedModuleBytes
}

/** 内核导出（前 6 个参数是 WASM 内存内字节偏移，最后一个是样本数）。 */
interface WasmComplexProductExports {
  complexProductF32(xr: number, xi: number, hr: number, hi: number, outR: number, outI: number, n: number): void
  complexProductF64(xr: number, xi: number, hr: number, hi: number, outR: number, outI: number, n: number): void
  memory: WebAssembly.Memory
}

/** 共享运行时：一块 Memory（复用 + 按需 grow）与刷新后的堆视图。同线程同步调用，可多实例共用。 */
class WasmSimdRuntime {
  readonly instanceExports: WasmComplexProductExports
  readonly memory: WebAssembly.Memory
  heapF32: Float32Array
  heapF64: Float64Array

  constructor(instance: WebAssembly.Instance) {
    this.instanceExports = instance.exports as unknown as WasmComplexProductExports
    this.memory = this.instanceExports.memory
    this.heapF32 = new Float32Array(this.memory.buffer)
    this.heapF64 = new Float64Array(this.memory.buffer)
  }

  /** 保证 memory 至少能放下 bytes 字节；必要时 grow 并重建视图（grow 会 detach 旧 buffer）。 */
  ensureCapacity(bytes: number): void {
    const current = this.memory.buffer.byteLength
    if (current >= bytes) return
    this.memory.grow(Math.ceil((bytes - current) / PAGE_BYTES))
    this.heapF32 = new Float32Array(this.memory.buffer)
    this.heapF64 = new Float64Array(this.memory.buffer)
    // grow 之后旧 buffer 已 detach，缓存里的输出子视图全部失效
    f32OutputViews.clear()
    f64OutputViews.clear()
  }
}

let runtime: WasmSimdRuntime | null = null
let runtimeFailed = false

/** 自检：4 个样本的 f32x4 与 2 个样本的 f64x2 复数乘法必须与 JS 参考逐位一致。 */
function selfTest(created: WasmSimdRuntime): void {
  const region = 16 * 4
  created.ensureCapacity(region * 6)
  const heapF32 = created.heapF32
  const xr = [1.5, -2, 0.25, 3]
  const xi = [0.5, 1, -4, 2]
  const hr = [2, 0.5, 3, -1]
  const hi = [-1, 2, 1, 0.5]
  for (let i = 0; i < 4; i++) {
    heapF32[i] = xr[i]
    heapF32[region / 4 + i] = xi[i]
    heapF32[(region * 2) / 4 + i] = hr[i]
    heapF32[(region * 3) / 4 + i] = hi[i]
  }
  created.instanceExports.complexProductF32(0, region, region * 2, region * 3, region * 4, region * 5, 4)
  for (let i = 0; i < 4; i++) {
    const expectedR = Math.fround(Math.fround(xr[i] * hr[i]) - Math.fround(xi[i] * hi[i]))
    const expectedI = Math.fround(Math.fround(xr[i] * hi[i]) + Math.fround(xi[i] * hr[i]))
    if (heapF32[(region * 4) / 4 + i] !== expectedR || heapF32[(region * 5) / 4 + i] !== expectedI) {
      throw new Error('wasm simd self-test mismatch')
    }
  }
  const heapF64 = created.heapF64
  const region64 = 16 * 8
  created.ensureCapacity(region64 * 6)
  const heap64 = created.heapF64
  const xr64 = [1.5, -2], xi64 = [0.5, 1], hr64 = [2, 0.5], hi64 = [-1, 2]
  for (let i = 0; i < 2; i++) {
    heap64[i] = xr64[i]
    heap64[region64 / 8 + i] = xi64[i]
    heap64[(region64 * 2) / 8 + i] = hr64[i]
    heap64[(region64 * 3) / 8 + i] = hi64[i]
  }
  created.instanceExports.complexProductF64(0, region64, region64 * 2, region64 * 3, region64 * 4, region64 * 5, 2)
  for (let i = 0; i < 2; i++) {
    if (heap64[(region64 * 4) / 8 + i] !== xr64[i] * hr64[i] - xi64[i] * hi64[i]) {
      throw new Error('wasm f64 simd self-test mismatch')
    }
    if (heap64[(region64 * 5) / 8 + i] !== xr64[i] * hi64[i] + xi64[i] * hr64[i]) {
      throw new Error('wasm f64 simd self-test mismatch')
    }
  }
}

/**
 * 构建并自检共享运行时；任何一步失败（无 WebAssembly、无 SIMD128、内存不足、实例化异常）
 * 都返回 null，上层静默回退纯 TypeScript 路径，不影响音频。
 */
function detectRuntime(): WasmSimdRuntime | null {
  try {
    if (typeof WebAssembly !== 'object' || WebAssembly === null) return null
    if (typeof WebAssembly.Module !== 'function' || typeof WebAssembly.Instance !== 'function') return null
    const module = new WebAssembly.Module(getComplexProductWasmModuleBytes())
    const created = new WasmSimdRuntime(new WebAssembly.Instance(module, {}))
    selfTest(created)
    return created
  } catch {
    return null
  }
}

function getRuntime(): WasmSimdRuntime | null {
  if (runtime) return runtime
  if (runtimeFailed) return null
  const created = detectRuntime()
  if (created) runtime = created
  else runtimeFailed = true
  return runtime
}

/**
 * 能力检测（结果缓存）。Node 24+/Electron 42 的 Chromium 与 AudioWorkletGlobalScope 内均返回
 * true；不支持 WebAssembly/SIMD 的环境返回 false，调用方静默回退 TS。
 */
export function isWasmSimdKernelAvailable(): boolean {
  return getRuntime() !== null
}

/** 仅供测试：清空能力检测缓存与共享实例，用于模拟「环境不支持 WASM」或重新检测。 */
export function __resetWasmSimdKernelCacheForTests(): void {
  runtime = null
  runtimeFailed = false
}

function align16(bytes: number): number {
  return (bytes + 15) & ~15
}

// —— 零分配视图缓存 ——
// Convolver 每块按「声道 × 分区数」调用本内核（48kHz 下约 8 万次/秒），若每次调用都
// 用 subarray 现切视图，会在音频线程上产生 6 个新 TypedArray/次（GC 压力 + 违反无分配目标）。
// 因此把输入子视图与 WASM 堆输出子视图都缓存起来：
//  - 输入：WeakMap<源数组, Map<offset, Map<count, view>>>，源数组被回收时自动释放；
//  - 输出：Map<(byteOffset, count), view>，memory.grow 后（buffer detach）整体清空。
// 命中路径只做 Map.get，不分配任何对象。
const VIEW_CACHE_LIMIT_PER_ARRAY = 64
const VIEW_CACHE_LIMIT_PER_OFFSET = 8
const VIEW_CACHE_LIMIT_OUTPUT = 64

const f32InputViews = new WeakMap<Float32Array, Map<number, Map<number, Float32Array>>>()
const f64InputViews = new WeakMap<Float64Array, Map<number, Map<number, Float64Array>>>()
const f32OutputViews = new Map<number, Float32Array>()
const f64OutputViews = new Map<number, Float64Array>()

let viewAllocationCount = 0

/** 诊断用：本进程内为输入/输出拷贝创建的子视图总数（命中缓存不增加）。 */
export function getWasmKernelViewAllocationCount(): number {
  return viewAllocationCount
}

/** 仅供测试：清零视图分配计数。 */
export function __resetWasmKernelViewAllocationCountForTests(): void {
  viewAllocationCount = 0
}

function cachedInputView32(src: Float32Array, offset: number, length: number): Float32Array {
  let byOffset = f32InputViews.get(src)
  if (byOffset === undefined) {
    byOffset = new Map()
    f32InputViews.set(src, byOffset)
  }
  let byLength = byOffset.get(offset)
  if (byLength === undefined) {
    if (byOffset.size >= VIEW_CACHE_LIMIT_PER_ARRAY) byOffset.clear()
    byLength = new Map()
    byOffset.set(offset, byLength)
  }
  let view = byLength.get(length)
  if (view === undefined) {
    if (byLength.size >= VIEW_CACHE_LIMIT_PER_OFFSET) byLength.clear()
    view = src.subarray(offset, offset + length)
    byLength.set(length, view)
    viewAllocationCount++
  }
  return view
}

function cachedInputView64(src: Float64Array, offset: number, length: number): Float64Array {
  let byOffset = f64InputViews.get(src)
  if (byOffset === undefined) {
    byOffset = new Map()
    f64InputViews.set(src, byOffset)
  }
  let byLength = byOffset.get(offset)
  if (byLength === undefined) {
    if (byOffset.size >= VIEW_CACHE_LIMIT_PER_ARRAY) byOffset.clear()
    byLength = new Map()
    byOffset.set(offset, byLength)
  }
  let view = byLength.get(length)
  if (view === undefined) {
    if (byLength.size >= VIEW_CACHE_LIMIT_PER_OFFSET) byLength.clear()
    view = src.subarray(offset, offset + length)
    byLength.set(length, view)
    viewAllocationCount++
  }
  return view
}

/** 堆视图缓存 key：元素起点 × 2^26 + 长度（长度上限 2^26 样本已远超实际分区）。 */
const OUTPUT_VIEW_KEY_STRIDE = 0x4000000

function cachedOutputView32(heap: Float32Array, start: number, length: number): Float32Array {
  const key = start * OUTPUT_VIEW_KEY_STRIDE + length
  let view = f32OutputViews.get(key)
  if (view === undefined || view.buffer !== heap.buffer) {
    if (f32OutputViews.size >= VIEW_CACHE_LIMIT_OUTPUT) f32OutputViews.clear()
    view = heap.subarray(start, start + length)
    f32OutputViews.set(key, view)
    viewAllocationCount++
  }
  return view
}

function cachedOutputView64(heap: Float64Array, start: number, length: number): Float64Array {
  const key = start * OUTPUT_VIEW_KEY_STRIDE + length
  let view = f64OutputViews.get(key)
  if (view === undefined || view.buffer !== heap.buffer) {
    if (f64OutputViews.size >= VIEW_CACHE_LIMIT_OUTPUT) f64OutputViews.clear()
    view = heap.subarray(start, start + length)
    f64OutputViews.set(key, view)
    viewAllocationCount++
  }
  return view
}

/**
 * f32 复数乘法：4 个输入分区 memcpy 进 WASM 内存 → 执行 f32x4 内核 → 2 个输出分区 memcpy
 * 回来；不足 4 个样本的尾部在 JS 里按 fround 语义补齐（与 SIMD 路径逐位一致）。
 * WASM 不可用时返回 false，由调用方决定是否走 TS 路径。
 */
export function wasmComplexProductF32(
  xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
  outR: Float32Array, outI: Float32Array, n: number,
  xrOffset: number, xiOffset: number, hrOffset: number, hiOffset: number,
): boolean {
  const main = n & ~3
  if (main > 0) {
    const created = getRuntime()
    if (!created) return false
    const region = align16(main * 4)
    created.ensureCapacity(region * 6)
    const heap = created.heapF32
    const base = region >> 2
    // memcpy 语义（HEAP.set），输入/输出子视图走缓存，命中路径零分配
    heap.set(cachedInputView32(xr, xrOffset, main), 0)
    heap.set(cachedInputView32(xi, xiOffset, main), base)
    heap.set(cachedInputView32(hr, hrOffset, main), base * 2)
    heap.set(cachedInputView32(hi, hiOffset, main), base * 3)
    created.instanceExports.complexProductF32(0, region, region * 2, region * 3, region * 4, region * 5, main)
    outR.set(cachedOutputView32(heap, base * 4, main))
    outI.set(cachedOutputView32(heap, base * 5, main))
  }
  for (let i = main; i < n; i++) {
    const a = xr[xrOffset + i]
    const b = xi[xiOffset + i]
    const c = hr[hrOffset + i]
    const d = hi[hiOffset + i]
    outR[i] = Math.fround(Math.fround(a * c) - Math.fround(b * d))
    outI[i] = Math.fround(Math.fround(a * d) + Math.fround(b * c))
  }
  return true
}

/** f64 复数乘法（f64x2）：语义同 f32 版本，用双精度 SIMD，结果与 JS double 逐位一致。 */
export function wasmComplexProductF64(
  xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
  outR: Float64Array, outI: Float64Array, n: number,
  xrOffset: number, xiOffset: number, hrOffset: number, hiOffset: number,
): boolean {
  const main = n & ~1
  if (main > 0) {
    const created = getRuntime()
    if (!created) return false
    const region = align16(main * 8)
    created.ensureCapacity(region * 6)
    const heap = created.heapF64
    const base = region >> 3
    heap.set(cachedInputView64(xr, xrOffset, main), 0)
    heap.set(cachedInputView64(xi, xiOffset, main), base)
    heap.set(cachedInputView64(hr, hrOffset, main), base * 2)
    heap.set(cachedInputView64(hi, hiOffset, main), base * 3)
    created.instanceExports.complexProductF64(0, region, region * 2, region * 3, region * 4, region * 5, main)
    outR.set(cachedOutputView64(heap, base * 4, main))
    outI.set(cachedOutputView64(heap, base * 5, main))
  }
  for (let i = main; i < n; i++) {
    const a = xr[xrOffset + i]
    const b = xi[xiOffset + i]
    const c = hr[hrOffset + i]
    const d = hi[hiOffset + i]
    outR[i] = a * c - b * d
    outI[i] = a * d + b * c
  }
  return true
}

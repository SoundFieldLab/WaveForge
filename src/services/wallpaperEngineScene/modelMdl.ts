/**
 * WE .mdl 二进制模型几何解析（客户端版，逻辑与 local-server.mjs parseMdlModel 对齐）：
 *   magic "MDLV00xx"(8B) + 3×u32 + null 结尾材质 json 路径 + …
 *   之后存在 [u32 vertexBytes][顶点数据][u32 indexBytes][uint16 索引] 的几何块。
 *   ⚠️ MDLV0023 材质串与几何块之间有前导数据（u32 meshCount + 6 float 包围盒 + u32 标志，
 *   土星 3589454154 球体01 实测 ~36B）→ 材质串后开近程窗口扫描，不要求紧邻。
 * manifest 不再内联网格几何（土星 陨石单体 / 太阳系 847 对象超 V8 字符串上限 500 实证）
 * ——对象只带 .model.file 引用，渲染端经 /scene/asset 端点拉二进制后在此解析。
 */

export interface ParsedModelMesh {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint16Array | Uint32Array
  vertexCount: number
}

interface MdlBlock {
  blockOffset: number
  vertexBytes: number
  stride: number
  vertexCount: number
  indexBytes: number
  index32: boolean
  uvOffset: number
}

const STRIDES = [64, 56, 52, 48, 44, 40, 36, 32, 28, 24, 20]

/** 在 offset q 处验证 [vb][顶点数据][ib][uint16 索引] 四元组，合法返回块描述 */
function tryQuadAt(
  q: number,
  view: DataView,
  f32: (o: number) => number,
  u16: (o: number) => number,
  byteLength: number,
): MdlBlock | null {
  const vb = view.getUint32(q, true)
  // ⚠️ 上限 256MB：土星 陨石单体 vb=144MB（163MB 文件）实测，64MB 会误拒真块
  if (vb < 20 || vb > 256 * 1024 * 1024 || q + 4 + vb + 6 > byteLength) return null
  const indexBytes = view.getUint32(q + 4 + vb, true)
  if (indexBytes < 6 || indexBytes % 2 !== 0 || indexBytes > 64 * 1024 * 1024 || q + 8 + vb + indexBytes > byteLength) return null
  // 廉价闸门（全局回退扫描每个 offset 都会进来，必须先挡掉顶点/索引 float 数据里的
  // junk 候选，否则全量索引扫描会把加载卡到分钟级——2026-10-24 后端事件循环卡死实测）：
  // ① 首顶点位置须是合理 float；② vb 须能被至少一个候选 stride 整除；③ 真实网格
  // indexBytes/vb ≈ 0.08~0.2（uint16 索引 ≈ 顶点数 2 倍），>8 倍必是 junk。
  const p0 = f32(q + 4)
  if (!Number.isFinite(p0) || Math.abs(p0) > 1e5) return null
  if (!STRIDES.some((s) => vb % s === 0)) return null
  if (indexBytes > vb * 8) return null
  const iStart = q + 8 + vb
  // 索引宽度双重解释：先按 uint16（绝大多数模型），无 stride 候选通过再按 uint32
  // （大网格 meteor 3589454154 实测 u32 索引 maxIndex+1 == vc(stride48) 完全吻合）
  for (const index32 of [false, true]) {
    if (index32 && indexBytes % 4 !== 0) return null
    const step = index32 ? 4 : 2
    let maxIndex = 0
    for (let i = 0; i < indexBytes; i += step) {
      const v = index32 ? view.getUint32(iStart + i, true) : u16(iStart + i)
      if (v > maxIndex) maxIndex = v
    }
    for (const stride of STRIDES) {
      if (vb % stride) continue
      const vertexCount = vb / stride
      if (vertexCount < 3 || vertexCount < maxIndex + 1) continue
      if (vertexCount > (maxIndex + 1) * 1.25) continue
      let floatsOk = true
      for (let k = 0; k < 8 && floatsOk; k++) {
        const vBase = q + 4 + ((k * 7919) % vertexCount) * stride
        for (let c = 0; c < 12 && floatsOk; c += 4) {
          const f = f32(vBase + c)
          if (!Number.isFinite(f) || Math.abs(f) > 1e5) floatsOk = false
        }
      }
      if (!floatsOk) continue
      if (stride >= 28) {
        // normal@12 应近单位长度（错位布局比例骤降）
        let unitGood = 0
        const samples = Math.min(vertexCount, 400)
        for (let i = 0; i < samples; i++) {
          const vIndex = Math.floor((i * 7919) % vertexCount)
          const b = q + 4 + vIndex * stride + 12
          const len = Math.hypot(f32(b), f32(b + 4), f32(b + 8))
          if (len > 0.85 && len < 1.15) unitGood++
        }
        if (unitGood / samples < 0.9) continue
      }
      return { blockOffset: q, vertexBytes: vb, stride, vertexCount, indexBytes, index32, uvOffset: 0 }
    }
  }
  return null
}

/** uv 偏移探测：候选里挑「≈全部落在 [0,1] 且有实际散布」的 float 对（土星 stride48 uv@40 实测） */
function detectUvOffset(block: Omit<MdlBlock, 'uvOffset'>, f32: (o: number) => number): number {
  const vStart = block.blockOffset + 4
  const samples = Math.min(block.vertexCount, 600)
  let bestOffset = -1
  let bestScore = -1
  for (let off = 12; off <= block.stride - 8; off += 4) {
    let in01 = 0
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < samples; i++) {
      const vIndex = Math.floor((i * 7919) % block.vertexCount)
      const u = f32(vStart + vIndex * block.stride + off)
      if (u >= -0.01 && u <= 1.01) in01++
      if (u < min) min = u
      if (u > max) max = u
    }
    if (in01 / samples >= 0.99 && max - min > 0.5) {
      const score = in01 / samples + (max - min)
      if (score > bestScore) {
        bestScore = score
        bestOffset = off
      }
    }
  }
  if (bestOffset >= 0) return bestOffset
  // 回退：历史启发式（beach 等已验证布局）
  return block.stride >= 32 ? 24 : 12
}

export function parseModelMdl(buffer: ArrayBuffer): ParsedModelMesh | null {
  if (buffer.byteLength < 32) return null
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4))
  if (!magic.startsWith('MDLV')) return null
  const view = new DataView(buffer)
  const u32 = (o: number) => view.getUint32(o, true)
  const f32 = (o: number) => view.getFloat32(o, true)
  const u16 = (o: number) => view.getUint16(o, true)

  // 材质 json 路径（null 结尾）：头部第 20 字节起
  let strStart = 20
  while (strStart < buffer.byteLength && view.getUint8(strStart) === 0) strStart++
  let strEnd = strStart
  while (strEnd < buffer.byteLength && view.getUint8(strEnd) !== 0) strEnd++

  let best: MdlBlock | null = null
  // 首选：材质串后的近程窗口扫描（MDLV0023 有 u32 count + bbox + flags 前导，
  // 土星 球体01 实测几何块在串后 ~36B；紧邻布局 beach 等旧文件窗口首格即命中）。
  // 全局特征扫描在标准布局文件上会误命中 float 数据（fantasticcar 实测踩坑）。
  {
    const p = strEnd + 1
    const windowEnd = Math.min(p + 256, buffer.byteLength - 16)
    for (let q = p; q <= windowEnd; q += 4) {
      const hit = tryQuadAt(q, view, f32, u16, buffer.byteLength)
      if (hit) {
        best = hit
        break
      }
    }
  }
  // 回退：全局四重特征扫描（pistols 等非标准布局）。
  // ⚠️ 只对中小文件启用：大文件逐 offset 全量索引扫描会卡事件循环到分钟级
  // （meteor 163MB 418s 实测），而大网格是 MDLV0023 近程窗口可命中的标准布局。
  if (!best && buffer.byteLength <= 64 * 1024 * 1024) {
    // 步长 4：几何块字段都是 u32 对齐（MDLV0023 off=100 等实测），逐字节扫是 4 倍浪费
    for (let off = 24; off < buffer.byteLength - 16; off += 4) {
      const hit = tryQuadAt(off, view, f32, u16, buffer.byteLength)
      if (hit && (!best || hit.vertexCount > best.vertexCount)) best = hit
    }
  }
  if (!best) return null

  best.uvOffset = detectUvOffset(best, f32)
  const vStart = best.blockOffset + 4
  const hasNormals = best.stride >= 28
  const positions = new Float32Array(best.vertexCount * 3)
  const normals = hasNormals ? new Float32Array(best.vertexCount * 3) : new Float32Array(0)
  const uvs = new Float32Array(best.vertexCount * 2)
  for (let i = 0; i < best.vertexCount; i++) {
    const v = vStart + i * best.stride
    positions[i * 3] = f32(v)
    positions[i * 3 + 1] = f32(v + 4)
    positions[i * 3 + 2] = f32(v + 8)
    if (hasNormals) {
      normals[i * 3] = f32(v + 12)
      normals[i * 3 + 1] = f32(v + 16)
      normals[i * 3 + 2] = f32(v + 20)
    }
    uvs[i * 2] = f32(v + best.uvOffset)
    uvs[i * 2 + 1] = f32(v + best.uvOffset + 4)
  }
  const iStart = vStart + best.vertexBytes + 4
  const indexCount = best.indexBytes / (best.index32 ? 4 : 2)
  let indices: Uint16Array | Uint32Array
  if (best.index32) {
    indices = new Uint32Array(indexCount)
    for (let i = 0; i < indexCount; i++) indices[i] = view.getUint32(iStart + i * 4, true)
  } else {
    indices = new Uint16Array(indexCount)
    for (let i = 0; i < indexCount; i++) indices[i] = u16(iStart + i * 2)
  }
  return { positions, normals, uvs, indices, vertexCount: best.vertexCount }
}

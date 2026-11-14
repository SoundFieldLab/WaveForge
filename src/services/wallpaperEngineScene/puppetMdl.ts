/**
 * WE puppet warp（剪纸骨骼动画）.mdl 解析与蒙皮姿态求值。
 *
 * 二进制格式逆向自真实工坊资产并与 linux-wallpaperengine（AzPepoze）实现对照：
 * - 头部：MDLV00XX(8B) + pad u8 + type u32 + subversion u16 + flags u16 + reserved u32
 *   + material path(cstring) + 28B 全零 padding + tag u32(0x0180000F)
 *   + vertexBytes u32 + vertices + indexBytes u32 + indices(u16)
 * - 顶点布局（四种，按索引范围探测）：position 3×f32 恒在 +0；
 *   stride 80/84 带蒙皮（bone indices/weights），48 无蒙皮，52 为 v0013 旧蒙皮
 * - MDLS 骨骼块：每骨 u32 type + u32 parent(0xFFFFFFFF=root) + u32 payload(64=bind matrix)
 *   + 列主序 4×4 bind matrix（平移在最后 4 float）+ info JSON(cstring) + name(cstring)
 * - MDLA 动画块：每 clip：name(cstring) + loopMode(cstring) + fps f32 + frameCount u32
 *   + reserved u32 + trackCount u32，每 track：(frameCount+1) 关键帧 × 36B
 *   （translation xyz + rotation xyz 弧度 + scale xyz）；track 顺序 = 骨骼顺序
 *
 * 姿态求值：bind 世界矩阵级联 → 逆 bind；动画层按 blend 叠加「相对首帧位移量」；
 * R = Rz·Ry·Rx（列主序）；蒙皮矩阵 = animWorld × inverseBindWorld；LBS 每顶点 4 权重。
 */

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface PuppetBone {
  name: string
  /** 父骨骼索引，0xFFFFFFFF(以 Uint32 存) = 根；此处归一为 -1 */
  parent: number
  /** 列主序 4×4 bind 矩阵（磁盘原样，平移在 m[12..14]） */
  bind: Float32Array
  /** info JSON 里的 IK 深度（无 IK = 0） */
  ikDepth: number
}

export interface PuppetClip {
  id: number
  name: string
  loopMode: string
  fps: number
  frameCount: number
  /** tracks[boneIndex] = (frameCount+1) × 9 平铺 [tx,ty,tz, rx,ry,rz, sx,sy,sz] */
  tracks: Float32Array[]
}

export interface PuppetModel {
  version: string
  material: string
  vertexCount: number
  /** puppet 局部空间顶点（中心原点，y 向下），平铺 xyz */
  positions: Float32Array
  /** 图集 UV，平铺 st */
  uvs: Float32Array
  /** 每顶点 4 骨骼索引（无蒙皮模型为空） */
  boneIndices: Uint32Array
  /** 每顶点 4 权重（无蒙皮模型为空） */
  boneWeights: Float32Array
  triangles: Uint16Array
  bones: PuppetBone[]
  clips: PuppetClip[]
  /** 顶点包围盒 [minX,minY,minZ,maxX,maxY,maxZ] */
  bounds: number[]
}

interface VertexLayout {
  stride: number
  boneOffset: number // -1 = 无蒙皮
  weightOffset: number
  uvOffset: number
}

const LAYOUTS: VertexLayout[] = [
  { stride: 80, boneOffset: 40, weightOffset: 56, uvOffset: 72 },
  { stride: 48, boneOffset: -1, weightOffset: -1, uvOffset: 40 },
  { stride: 52, boneOffset: 12, weightOffset: 28, uvOffset: 44 },
  { stride: 84, boneOffset: 44, weightOffset: 60, uvOffset: 76 },
]

/** 读一个 null 结尾字符串 */
function readCString(view: DataView, pos: number): { text: string; next: number } {
  let end = pos
  while (end < view.byteLength && view.getUint8(end) !== 0) end++
  const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, end - pos)
  return { text: new TextDecoder().decode(bytes), next: end + 1 }
}

function parsePuppetMdl(buffer: ArrayBuffer): PuppetModel | null {
  if (buffer.byteLength < 32) return null
  const view = new DataView(buffer)
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4))
  if (!magic.startsWith('MDL')) return null
  const version = new TextDecoder().decode(new Uint8Array(buffer, 0, 8))
  let pos = 8
  pos += 1 // pad
  pos += 4 // type u32
  pos += 2 // subversion u16
  pos += 2 // flags u16
  pos += 4 // reserved u32
  const materialRes = readCString(view, pos)
  const material = materialRes.text
  pos = materialRes.next + 28 // 28B 全零 padding
  // tag u32 固定 0x0180000F（个别资产可能不同，不强制）

  // 顶点/索引块：按「候选 stride 的索引全部在界内」探测（头与 tag 间可能存在字节差）
  const layoutsToTry = LAYOUTS.slice()
  // v0013..v0016 旧蒙皮优先于无蒙皮布局
  if (version >= 'MDLV0013' && version <= 'MDLV0016') {
    const tmp = layoutsToTry[1]
    layoutsToTry[1] = layoutsToTry[2]
    layoutsToTry[2] = tmp
  }
  let layout: VertexLayout | null = null
  let vertexCount = 0
  let verticesOffset = 0
  let indicesOffset = 0
  let indexBytes = 0
  for (let off = pos; !layout && off + 12 <= buffer.byteLength && off < pos + 64; off++) {
    const candidateBytes = view.getUint32(off + 4, true)
    for (const cand of layoutsToTry) {
      if (candidateBytes === 0 || candidateBytes % cand.stride !== 0) continue
      const candVerticesOffset = off + 8
      if (candVerticesOffset + candidateBytes + 4 > buffer.byteLength) continue
      const candIndexBytes = view.getUint32(candVerticesOffset + candidateBytes, true)
      const candIndicesOffset = candVerticesOffset + candidateBytes + 4
      if (candIndexBytes === 0 || candIndexBytes % 6 !== 0 || candIndicesOffset + candIndexBytes > buffer.byteLength) continue
      const candCount = candidateBytes / cand.stride
      let inRange = true
      for (let t = 0; t < candIndexBytes / 6 && inRange; t++) {
        for (let k = 0; k < 3; k++) {
          if (view.getUint16(candIndicesOffset + t * 6 + k * 2, true) >= candCount) { inRange = false; break }
        }
      }
      if (!inRange) continue
      layout = cand
      vertexCount = candCount
      verticesOffset = candVerticesOffset
      indicesOffset = candIndicesOffset
      indexBytes = candIndexBytes
      break
    }
  }
  if (!layout) return null

  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const hasBones = layout.boneOffset >= 0
  const boneIndices = new Uint32Array(hasBones ? vertexCount * 4 : 0)
  const boneWeights = new Float32Array(hasBones ? vertexCount * 4 : 0)
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < vertexCount; i++) {
    const v = verticesOffset + i * layout.stride
    positions[i * 3] = view.getFloat32(v, true)
    positions[i * 3 + 1] = view.getFloat32(v + 4, true)
    positions[i * 3 + 2] = view.getFloat32(v + 8, true)
    if (hasBones) {
      for (let k = 0; k < 4; k++) {
        boneIndices[i * 4 + k] = view.getUint32(v + layout.boneOffset + k * 4, true)
        boneWeights[i * 4 + k] = view.getFloat32(v + layout.weightOffset + k * 4, true)
      }
    }
    uvs[i * 2] = view.getFloat32(v + layout.uvOffset, true)
    uvs[i * 2 + 1] = view.getFloat32(v + layout.uvOffset + 4, true)
    for (let a = 0; a < 3; a++) {
      const val = positions[i * 3 + a]
      if (val < bounds[a]) bounds[a] = val
      if (val > bounds[a + 3]) bounds[a + 3] = val
    }
  }
  const triangleCount = indexBytes / 6
  const triangles = new Uint16Array(triangleCount * 3)
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) triangles[t * 3 + k] = view.getUint16(indicesOffset + t * 6 + k * 2, true)
  }

  // MDLS 骨骼 / MDLA 动画：从索引缓冲之后按 tag 搜索
  const searchFrom = indicesOffset + indexBytes
  const bytes = new Uint8Array(buffer)
  const findTag = (tag: string): number => {
    const needle = new TextEncoder().encode(tag)
    outer: for (let i = searchFrom; i + needle.length <= bytes.length; i++) {
      for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer
      return i
    }
    return -1
  }

  const bones: PuppetBone[] = []
  const bonesOffset = findTag('MDLS')
  if (bonesOffset >= 0) {
    // MDLS 头是带版本号的 cstring（如 "MDLS0004\0"，9B），其后 next_offset u32 +
    // numBones u32 + reserved u8，然后逐骨记录（2026-10-22 凳子猫/人物双文件验证）
    const headRes = readCString(view, bonesOffset)
    let p = headRes.next
    p += 4 // next_offset（下一 section 起点）
    const numBones = view.getUint32(p, true); p += 4
    p += 1 // reserved u8
    if (numBones > 0 && numBones <= 4096) {
      for (let b = 0; b < numBones && p + 12 <= buffer.byteLength; b++) {
        p += 4 // type u32
        const parentRaw = view.getUint32(p, true); p += 4
        const byteLen = view.getUint32(p, true); p += 4
        if (byteLen === 0 || byteLen > 4096 || p + byteLen > buffer.byteLength) break
        // 4×4 bind 矩阵：磁盘即列主序（平移在最后 4 float：tx,ty,tz,1，
        // 2026-10-22 人物骨骼实证：disk[12..15]=[-724,-832,0,1]）→ 直接按序拷贝
        const bind = new Float32Array(16)
        for (let i = 0; i < 16; i++) bind[i] = view.getFloat32(p + i * 4, true)
        p += byteLen
        const infoRes = readCString(view, p)
        p = infoRes.next
        const nameRes = readCString(view, p)
        p = nameRes.next
        let ikDepth = 0
        const ikAt = infoRes.text.indexOf('"ik":true')
        if (ikAt >= 0) {
          const d = infoRes.text.indexOf('"ikd":', ikAt)
          if (d >= 0) ikDepth = parseInt(infoRes.text.slice(d + 6), 10) || 0
        }
        bones.push({ name: nameRes.text, parent: parentRaw === 0xffffffff ? -1 : parentRaw, bind, ikDepth })
      }
    }
  }

  const clips: PuppetClip[] = []
  const animOffset = findTag('MDLA')
  if (animOffset >= 0) {
    // MDLA 头（2026-10-22 凳子猫/人物双文件字节级验证）：cstring header("MDLA0006\0")
    // + end_offset u32 + numAnimations u16 + 2B padding + 首 clip u32 id；
    // clip 记录 = u32 id + name cstring + loopMode cstring + fps f32 + frameCount u32
    //   + reserved u32 + trackCount u32 + tracks[trackCount]；
    // 多 clip 时前一 clip 结束后 skip 补零字节再读 u32 id + u32 skipped。
    const headRes = readCString(view, animOffset)
    let p = headRes.next
    p += 4 // end_offset
    const numAnimations = view.getUint16(p, true); p += 2
    p += 2 // padding（对齐到首 clip 的 u32 id）
    if (numAnimations > 0 && numAnimations <= 64) {
      for (let a = 0; a < numAnimations; a++) {
        let id: number
        // 每个 clip 记录头 = u32 id + u32 zero（首 clip 同样有；多 clip 时
        // 前一 clip 结束后 skip 补零字节对齐到该头）
        if (a > 0) {
          while (p < buffer.byteLength && view.getUint8(p) === 0) p++
          if (p + 8 > buffer.byteLength) break
        }
        id = view.getUint32(p, true); p += 4
        p += 4 // zero 字段
        const nameRes = readCString(view, p); p = nameRes.next
        const modeRes = readCString(view, p); p = modeRes.next
        const fps = view.getFloat32(p, true); p += 4
        const frameCount = view.getUint32(p, true); p += 4
        p += 4 // reserved
        const trackCount = view.getUint32(p, true); p += 4
        const valid =
          modeRes.text.length <= 32 && fps > 0 && fps <= 1000 &&
          frameCount > 0 && frameCount <= 1000000 && trackCount > 0 && trackCount <= 4096
        if (!valid) break
        const expectedBytes = (frameCount + 1) * 36
        const tracks: Float32Array[] = []
        let ok = true
        for (let t = 0; t < trackCount && ok; t++) {
          p += 4 // track reserved
          const kb = view.getUint32(p, true); p += 4
          if (kb !== expectedBytes || p + kb > buffer.byteLength) { ok = false; break }
          const track = new Float32Array((frameCount + 1) * 9)
          for (let f = 0; f <= frameCount; f++) {
            for (let c = 0; c < 9; c++) track[f * 9 + c] = view.getFloat32(p + (f * 36 + c * 4), true)
          }
          p += kb
          tracks.push(track)
        }
        if (!ok) break
        clips.push({ id, name: nameRes.text, loopMode: modeRes.text, fps, frameCount, tracks })
      }
    }
  }

  return { version, material, vertexCount, positions, uvs, boneIndices, boneWeights, triangles, bones, clips, bounds }
}

// ---------------------------------------------------------------------------
// 姿态求值与蒙皮
// ---------------------------------------------------------------------------

export interface PuppetRuntimeLayer {
  animation: number
  blend: number
  rate: number
  visible: boolean
  /** 运行时累计时间（秒），渲染端每帧 advance */
  time: number
}

/** 4×4 列主序（m[col*4+row]） */
export type Mat4 = Float32Array

function mat4Multiply(a: Mat4, b: Mat4, out: Mat4): void {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3]
    }
  }
}

function mat4InverseAffine(m: Mat4, out: Mat4): void {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) { out.fill(0); return }
  const inv = 1 / det
  const r = [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ]
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row * 3 + col]
  }
  for (let row = 0; row < 3; row++) {
    out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14])
  }
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1
}

/** 关键帧 9 分量 [tx,ty,tz,rx,ry,rz,sx,sy,sz] → 列主序局部矩阵（R = Rz·Ry·Rx） */
function composeLocal(k: Float32Array, kOff: number, out: Mat4): void {
  const cx = Math.cos(k[kOff + 3]), sx = Math.sin(k[kOff + 3])
  const cy = Math.cos(k[kOff + 4]), sy = Math.sin(k[kOff + 4])
  const cz = Math.cos(k[kOff + 5]), sz = Math.sin(k[kOff + 5])
  const r00 = cz * cy, r01 = cz * sy * sx - sz * cx, r02 = cz * sy * cx + sz * sx
  const r10 = sz * cy, r11 = sz * sy * sx + cz * cx, r12 = sz * sy * cx - cz * sx
  const r20 = -sy, r21 = cy * sx, r22 = cy * cx
  const s0 = k[kOff + 6], s1 = k[kOff + 7], s2 = k[kOff + 8]
  out[0] = r00 * s0; out[1] = r10 * s0; out[2] = r20 * s0; out[3] = 0
  out[4] = r01 * s1; out[5] = r11 * s1; out[6] = r21 * s1; out[7] = 0
  out[8] = r02 * s2; out[9] = r12 * s2; out[10] = r22 * s2; out[11] = 0
  out[12] = k[kOff]; out[13] = k[kOff + 1]; out[14] = k[kOff + 2]; out[15] = 1
}

function wrapFrame(frame: number, frameCount: number, mode: string): number {
  const length = frameCount
  if (mode === 'single') return Math.min(Math.max(frame, 0), length)
  if (mode === 'mirror') {
    const phase = frame % (length * 2)
    return phase <= length ? phase : length * 2 - phase
  }
  return frame % length
}

export class PuppetPose {
  private model: PuppetModel | null = null
  private inverseBindWorld: Mat4[] = []
  private skinMatrices: Mat4[] = []
  private worldScratch: Mat4[] = []
  private localScratch: Mat4[] = []
  private poseScratch: Float32Array[] = []
  /** 每层运行时状态（time 由 advance/直接积分） */
  layers: PuppetRuntimeLayer[] = []

  init(model: PuppetModel, layerDefs: { animation: number; blend?: number; rate?: number; visible?: boolean }[]): void {
    this.model = model
    const count = model.bones.length
    this.inverseBindWorld = []
    this.skinMatrices = []
    this.worldScratch = []
    this.localScratch = []
    this.poseScratch = []
    const world: Mat4[] = []
    for (let i = 0; i < count; i++) {
      const local = model.bones[i].bind
      const m = new Float32Array(16); m.set(local)
      const parent = model.bones[i].parent
      if (parent >= 0 && parent < i) {
        const w = new Float32Array(16)
        mat4Multiply(world[parent], local, w)
        world.push(w)
      } else {
        world.push(m)
      }
      const inv = new Float32Array(16)
      mat4InverseAffine(world[i], inv)
      this.inverseBindWorld.push(inv)
      this.skinMatrices.push(new Float32Array(16))
      this.worldScratch.push(new Float32Array(16))
      this.localScratch.push(new Float32Array(16))
      this.poseScratch.push(new Float32Array(9))
    }
    this.layers = layerDefs.map((l) => ({
      animation: l.animation, blend: l.blend ?? 1, rate: l.rate ?? 1,
      visible: l.visible !== false, time: 0,
    }))
  }

  /** 每帧推进层时间；dt 秒。返回是否有活动层 */
  advance(dt: number): boolean {
    let any = false
    const model = this.model
    if (!model) return false
    for (const layer of this.layers) {
      if (!layer.visible) continue
      const clip = model.clips.find((c) => c.id === layer.animation)
      layer.time = Math.max(0, layer.time + dt * layer.rate)
      any = true
      if (clip && clip.loopMode === 'single' && clip.fps > 0 && layer.time * clip.fps >= clip.frameCount) {
        layer.time = clip.frameCount / clip.fps
      }
    }
    return any
  }

  /** 采样某层在当前 time 的姿态并叠加到 pose（相对该 track 首帧的位移量） */
  private accumulate(clip: PuppetClip, layer: PuppetRuntimeLayer): void {
    const model = this.model!
    const frame = wrapFrame(layer.time * clip.fps, clip.frameCount, clip.loopMode)
    const boneCount = Math.min(model.bones.length, clip.tracks.length)
    for (let b = 0; b < boneCount; b++) {
      const track = clip.tracks[b]
      if (!track || track.length === 0) continue
      const lower = Math.min(Math.floor(frame), track.length / 9 - 1)
      const upper = Math.min(lower + 1, track.length / 9 - 1)
      const t = frame - lower
      const pose = this.poseScratch[b]
      const isRoot = b < model.bones.length && model.bones[b].parent < 0
      for (let c = 0; c < 9; c++) {
        const now = track[lower * 9 + c] + (track[upper * 9 + c] - track[lower * 9 + c]) * t
        const first = track[c]
        // 根骨骼不叠加平移（root motion 保持关闭，与 lwe 默认一致）
        if (c < 3 && isRoot) continue
        pose[c] += layer.blend * (now - first)
      }
    }
  }

  /** 计算蒙皮矩阵；无任何活动层时用 bind 姿势（skin=identity，顶点原样） */
  private computeSkinMatrices(): boolean {
    const model = this.model!
    const count = model.bones.length
    let seeded = false
    for (let b = 0; b < count; b++) this.poseScratch[b].fill(0)
    for (const layer of this.layers) {
      if (!layer.visible) continue
      const clip = model.clips.find((c) => c.id === layer.animation)
      if (!clip) continue
      if (!seeded) {
        // 参考姿态：优先 clip 各 track 首帧
        for (let b = 0; b < Math.min(count, clip.tracks.length); b++) {
          const track = clip.tracks[b]
          for (let c = 0; c < 9; c++) this.poseScratch[b][c] = track ? track[c] : 0
        }
        seeded = true
      }
      this.accumulate(clip, layer)
    }
    if (!seeded) {
      // bind 姿势：skin = world(bind) × inverseBindWorld = identity
      for (let i = 0; i < count; i++) {
        const m = this.skinMatrices[i]
        m.fill(0); m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1
      }
      return false
    }
    for (let i = 0; i < count; i++) {
      composeLocal(this.poseScratch[i], 0, this.localScratch[i])
      const parent = model.bones[i].parent
      if (parent >= 0 && parent < i) mat4Multiply(this.worldScratch[parent], this.localScratch[i], this.worldScratch[i])
      else this.worldScratch[i].set(this.localScratch[i])
      mat4Multiply(this.worldScratch[i], this.inverseBindWorld[i], this.skinMatrices[i])
    }
    return true
  }

  /** LBS 蒙皮：输出 puppet 局部空间顶点（平铺 xyz）。无蒙皮权重时原样拷贝 */
  skin(out: Float32Array): void {
    const model = this.model!
    this.computeSkinMatrices()
    const hasBones = model.boneWeights.length > 0
    for (let v = 0; v < model.vertexCount; v++) {
      if (!hasBones) {
        out[v * 3] = model.positions[v * 3]
        out[v * 3 + 1] = model.positions[v * 3 + 1]
        out[v * 3 + 2] = model.positions[v * 3 + 2]
        continue
      }
      let sx = 0, sy = 0, sz = 0
      let weightTotal = 0
      const px = model.positions[v * 3], py = model.positions[v * 3 + 1], pz = model.positions[v * 3 + 2]
      for (let k = 0; k < 4; k++) {
        const w = model.boneWeights[v * 4 + k]
        const bi = model.boneIndices[v * 4 + k]
        if (w <= 0 || bi >= this.skinMatrices.length) continue
        const m = this.skinMatrices[bi]
        sx += w * (m[0] * px + m[4] * py + m[8] * pz + m[12])
        sy += w * (m[1] * px + m[5] * py + m[9] * pz + m[13])
        sz += w * (m[2] * px + m[6] * py + m[10] * pz + m[14])
        weightTotal += w
      }
      if (weightTotal > 0) {
        out[v * 3] = sx / weightTotal
        out[v * 3 + 1] = sy / weightTotal
        out[v * 3 + 2] = sz / weightTotal
      } else {
        out[v * 3] = px; out[v * 3 + 1] = py; out[v * 3 + 2] = pz
      }
    }
  }
}

export { parsePuppetMdl }

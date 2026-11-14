/**
 * Wallpaper Engine 场景资产解析库（供 local-server.mjs 使用）
 *
 * 二进制格式来源（已用本机 beach.tex 逐字节核对 + 社区交叉验证文档）：
 * - .tex: "TEXV0005\0" + "TEXI0001\0" + 7×int32 (format/flags/画布宽/画布高/图宽/图高/unk)
 *         + "TEXB0001..0004\0" + imageCount + [TEXB0003/4: imageFormat] + 每 image: mip 数
 *         + 每 mip: width/height/isLZ4/decompressedSize/byteCount + data
 * - .pkg: u32(8) + "PKGV0001/0002" + u32 version + 条目序列
 * - LZ4: 标准 LZ4 block 格式（WE 全部使用 raw block，非 frame 格式）
 *
 * 着色器：HLSL 方言源码随壁纸分发，此处做轻量转译为 GLSL ES 3.0。
 */

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// LightingV1 模块重建（#require LightingV1 注入体）
// ---------------------------------------------------------------------------
// WE 引擎把 LightingV1 模块编译进主程序（assets/shaders 无源码）。上段 GLSL 从
// wallpaper64.exe 二进制字符串碎片逐段还原（偏移 ~4762700）：uniform 接口
// g_LPoint/Spot/Tube/Directional_* + PerformLighting_V1 本体（点光/聚光/管光/平行光
// 四段循环调 common_pbr_2.h 的 ComputePBRLightShadow[Infinite]）。阴影分支依赖
// g_LFeature_Shadow*（需引擎 shadow pass），取 shadowFactor=1.0 无阴影路径。
// 数组长度取 4（渲染端灯光槽位一致）；闲置槽 lightColor=0 → 模块内 if 分支跳过
// （ComputePBRLightShadow 的 L/distance 除法对零向量产 NaN，NaN×0 仍 NaN 会染黑）。
const LIGHTING_V1_MODULE_GLSL = `
uniform vec4 g_LPoint_Origin[4];
uniform vec4 g_LPoint_Color[4];
uniform vec4 g_LSpot_Exponent[4];
uniform vec4 g_LSpot_Direction[4];
uniform vec4 g_LSpot_Origin[4];
uniform vec4 g_LSpot_Color[4];
uniform vec4 g_LDirectional_Color[4];
uniform vec4 g_LDirectional_Direction[4];
uniform vec4 g_LTube_OriginA[4];
uniform vec4 g_LTube_OriginB[4];
uniform vec4 g_LTube_Color[4];
vec3 PerformLighting_V1(vec3 worldPos, vec3 color, vec3 normal, vec3 viewVector, vec3 specularTint, vec3 baseReflectance, float roughness, float metallic)
{
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (g_LPoint_Color[i].rgb == vec3(0.0)) continue;
    vec3 lightDelta = g_LPoint_Origin[i].xyz - worldPos;
    light += ComputePBRLightShadow(normal, lightDelta, viewVector, color, g_LPoint_Color[i].rgb, max(g_LPoint_Color[i].w, 0.001), max(g_LPoint_Origin[i].w, 0.001), specularTint, baseReflectance, roughness, metallic, 1.0);
  }
  for (int i = 0; i < 4; i++) {
    if (g_LSpot_Color[i].rgb == vec3(0.0)) continue;
    vec3 lightDelta = g_LSpot_Origin[i].xyz - worldPos;
    float spotCookie = -dot(normalize(lightDelta), normalize(g_LSpot_Direction[i].xyz + vec3(0.0, -0.0001, 0.0)));
    spotCookie = smoothstep(g_LSpot_Direction[i].w, max(g_LSpot_Origin[i].w, g_LSpot_Direction[i].w + 0.001), spotCookie);
    light += ComputePBRLightShadow(normal, lightDelta, viewVector, color, g_LSpot_Color[i].rgb * spotCookie, max(g_LSpot_Color[i].w, 0.001), max(g_LSpot_Exponent[i].x, 0.001), specularTint, baseReflectance, roughness, metallic, 1.0);
  }
  for (int i = 0; i < 4; i++) {
    if (g_LTube_Color[i].rgb == vec3(0.0)) continue;
    vec3 lightDelta = PointSegmentDelta(worldPos, g_LTube_OriginA[i].xyz, g_LTube_OriginB[i].xyz);
    light += ComputePBRLightShadow(normal, lightDelta, viewVector, color, g_LTube_Color[i].rgb, max(g_LTube_Color[i].w, 0.001), max(g_LTube_OriginA[i].w, 0.001), specularTint, baseReflectance, roughness, metallic, 1.0);
  }
  for (int i = 0; i < 4; i++) {
    if (g_LDirectional_Color[i].rgb == vec3(0.0)) continue;
    light += ComputePBRLightShadowInfinite(normal, g_LDirectional_Direction[i].xyz, viewVector, color, g_LDirectional_Color[i].rgb, specularTint, baseReflectance, roughness, metallic, 1.0);
  }
  return light;
}
`

// ---------------------------------------------------------------------------
// LZ4 block 解压
// ---------------------------------------------------------------------------

/** 解压 LZ4 raw block（WE 的 .tex/.pkg 均使用此格式）。 */
export function lz4DecompressBlock(src, decompressedSize) {
  if (decompressedSize === 0) return Buffer.alloc(0)
  const dst = Buffer.allocUnsafe(decompressedSize)
  let s = 0
  let d = 0
  const srcLen = src.length
  while (s < srcLen && d < decompressedSize) {
    const token = src[s++]
    // 字面量长度
    let literalLength = token >> 4
    if (literalLength === 15) {
      let extra
      do {
        if (s >= srcLen) throw new Error('LZ4: 字面量长度越界')
        extra = src[s++]
        literalLength += extra
      } while (extra === 255)
    }
    if (s + literalLength > srcLen || d + literalLength > decompressedSize) {
      throw new Error('LZ4: 字面量越界')
    }
    src.copy(dst, d, s, s + literalLength)
    s += literalLength
    d += literalLength
    if (s >= srcLen || d >= decompressedSize) break
    // 匹配项（offset + length）
    if (s + 2 > srcLen) throw new Error('LZ4: offset 越界')
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error('LZ4: 非法 offset ' + offset)
    let matchLength = (token & 15) + 4
    if ((token & 15) === 15) {
      let extra
      do {
        if (s >= srcLen) throw new Error('LZ4: 匹配长度越界')
        extra = src[s++]
        matchLength += extra
      } while (extra === 255)
    }
    if (d + matchLength > decompressedSize) throw new Error('LZ4: 输出越界')
    let p = d - offset
    for (let i = 0; i < matchLength; i++) dst[d++] = dst[p++]
  }
  return dst
}

// ---------------------------------------------------------------------------
// DXT (S3TC) 块解码 → RGBA8888
// 目的：WE 的 .tex 画布是 2 的幂填充（如 1536x1024 图存在 2048x1024 画布），
// 直接按画布上传会采到右侧/底部的白色填充区；按图像尺寸上传压缩块又与数据布局不符。
// 在服务端解码裁齐，前端按普通 RGBA8888 上传，UV [0..1] 即图像实际区域。
// ---------------------------------------------------------------------------

function dxtDecodeBlock(src, blockOffset, format, out, x0, y0, width) {
  // DXT1: 8B/block；DXT3/5: 16B/block
  const isDXT1 = format === 7
  let colorOff = blockOffset
  let alphaOff = blockOffset
  if (format === 6) alphaOff = blockOffset      // DXT3: alpha 前 8B
  if (format === 4) alphaOff = blockOffset      // DXT5: alpha 前 8B
  if (!isDXT1) colorOff = blockOffset + 8

  const c0 = src[colorOff] | (src[colorOff + 1] << 8)
  const c1 = src[colorOff + 2] | (src[colorOff + 3] << 8)
  const r0 = ((c0 >> 11) & 31) * 255 / 31
  const g0 = ((c0 >> 5) & 63) * 255 / 63
  const b0 = (c0 & 31) * 255 / 31
  const r1 = ((c1 >> 11) & 31) * 255 / 31
  const g1 = ((c1 >> 5) & 63) * 255 / 63
  const b1 = (c1 & 31) * 255 / 31

  const palette = [
    [r0, g0, b0, 255], [r1, g1, b1, 255], [0, 0, 0, 255], [0, 0, 0, 255],
  ]
  if (isDXT1) {
    // DXT1: code2/3 依 c0>c1 为插值色或透明
    if (c0 > c1) {
      palette[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255]
      palette[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255]
    } else {
      palette[2] = [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255]
      palette[3] = [0, 0, 0, 0]
    }
  } else {
    palette[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255]
    palette[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255]
  }

  // alpha 分量
  const alphas = [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
  if (format === 6) {
    // DXT3：每像素 4 bit 显式 alpha
    for (let i = 0; i < 16; i++) {
      const byte = src[alphaOff + (i >> 1)]
      alphas[i] = ((i % 2 === 0) ? (byte & 15) : (byte >> 4)) * 17
    }
  } else if (format === 4) {
    // DXT5：a0/a1 8bit + 16 个 3bit 索引（标准插值表：a0>a1 → 8 级；a0≤a1 → 6 级 + 0 + 255）
    const a0 = src[alphaOff]
    const a1 = src[alphaOff + 1]
    const table = [a0, a1]
    if (a0 > a1) {
      for (let i = 1; i <= 6; i++) table.push(Math.round(((7 - i) * a0 + i * a1) / 7))
    } else {
      for (let i = 1; i <= 4; i++) table.push(Math.round(((5 - i) * a0 + i * a1) / 5))
      table.push(0, 255)
    }
    // 48-bit 小端 LE 索引数据（6 字节全量）；用 BigInt 拼接避免 <<24 的 int32 符号溢出
    let bits = 0n
    for (let b = 5; b >= 0; b--) bits = (bits << 8n) | BigInt(src[alphaOff + 2 + b])
    for (let i = 0; i < 16; i++) alphas[i] = table[Number((bits >> BigInt(3 * i)) & 7n)] ?? 255
  }

  const indices = src.readUInt32LE(colorOff + 4)
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const dstX = x0 + px
      const dstY = y0 + py
      if (dstX >= width) continue
      const code = (indices >> (2 * (py * 4 + px))) & 3
      const color = palette[code]
      const di = (dstY * width + dstX) * 4
      out[di] = color[0]
      out[di + 1] = color[1]
      out[di + 2] = color[2]
      out[di + 3] = alphas[py * 4 + px]
    }
  }
}

/** DXT1/3/5 mip 数据 → RGBA8888 Buffer（宽高为压缩块的画布尺寸） */
export function dxtDecodeToRGBA(data, width, height, format) {
  const out = Buffer.alloc(width * height * 4)
  const bytesPerBlock = format === 7 ? 8 : 16
  const blocksX = Math.ceil(width / 4)
  const blocksY = Math.ceil(height / 4)
  let offset = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (offset + bytesPerBlock > data.length) return out
      dxtDecodeBlock(data, offset, format, out, bx * 4, by * 4, width)
      offset += bytesPerBlock
    }
  }
  return out
}

/** 从 RGBA/RAW 画布中裁出图像区域（bpp: 每像素字节数，RGBA8888=4 / RG88=2 / R8=1） */
function cropRGBA(src, srcW, srcH, dstW, dstH, bpp = 4) {
  const out = Buffer.alloc(dstW * dstH * bpp)
  const rowBytes = dstW * bpp
  for (let y = 0; y < dstH && y < srcH; y++) {
    src.copy(out, y * rowBytes, y * srcW * bpp, y * srcW * bpp + rowBytes)
  }
  return out
}

// ---------------------------------------------------------------------------
// PKG 容器（PKGV0001/0002）
// ---------------------------------------------------------------------------

/**
 * 解析 scene.pkg → Map<路径, Buffer>。
 * PKGV0001: 条目 = u32 nameLen + name + u32 contentSize + content
 * PKGV0002: 条目 = u32 nameLen + name + u32 storedSize + u32 rawSize + content(可能 LZ4)
 * PKGV0023+（目录式，工坊新工程实测）：u32 count + count×(u32 nameLen + name + u32 offset + u32 size)
 *   + 数据区（offset 相对数据区起点，内容未压缩）——maxEnd 与数据区字节数严丝合缝（3650475846 验证）。
 * 注：0002 分支按社区逆向规格实现，条目解析带启发式防呆。
 */
export function parsePkg(buffer) {
  let off = 0
  const u32 = () => { const v = buffer.readUInt32LE(off); off += 4; return v }
  const magicLength = u32()
  if (magicLength > 32 || magicLength < 4) throw new Error('PKG: 魔数长度异常 ' + magicLength)
  const magic = buffer.slice(off, off + magicLength).toString('latin1').replace(/\0+$/, '')
  off += magicLength
  if (!magic.startsWith('PKGV')) throw new Error('PKG: 魔数不符 ' + magic)
  const version = u32()

  const entries = new Map()
  const isV2 = magic === 'PKGV0002'
  // V3+（0023 实测）：version 字段位置实际是「条目数」，条目表后跟数据区。
  // 结构启发：count 合理（1..10 万）且表总长不超过文件——不匹配再报错。
  if (!isV2 && magic !== 'PKGV0001' && version > 2) {
    const count = version
    if (count < 1 || count > 100000) throw new Error('PKG: 条目数异常 ' + count)
    const table = []
    for (let i = 0; i < count; i++) {
      if (off + 12 > buffer.length) throw new Error('PKG: 目录表越界 @' + i)
      const nameLength = u32()
      if (nameLength === 0 || nameLength > 1024 || off + nameLength + 8 > buffer.length) {
        throw new Error('PKG: 目录条目异常 @' + i + ' nameLen=' + nameLength)
      }
      const name = buffer.slice(off, off + nameLength).toString('utf8').replace(/\0+$/, '')
      off += nameLength
      const fileOffset = u32()
      const size = u32()
      // u32() 已各自推进 off 4 字节，此处不再额外 += 8（曾致第二条起全部错位）
      table.push([name.replace(/\\/g, '/'), fileOffset, size])
    }
    const dataStart = off
    for (const [name, fileOffset, size] of table) {
      if (fileOffset + size > buffer.length - dataStart) {
        throw new Error('PKG: 数据区越界 ' + name + ' +' + fileOffset + '+' + size)
      }
      entries.set(name.toLowerCase(), Buffer.from(buffer.subarray(dataStart + fileOffset, dataStart + fileOffset + size)))
    }
    return { magic, version, entries }
  }
  let guard = 0
  while (off + 4 <= buffer.length && guard++ < 20000) {
    const nameLength = u32()
    if (nameLength === 0 || nameLength > 1024 || off + nameLength > buffer.length) break
    const name = buffer.slice(off, off + nameLength).toString('utf8').replace(/\0+$/, '')
    off += nameLength
    if (isV2) {
      if (off + 8 > buffer.length) break
      const storedSize = u32()
      const rawSize = u32()
      if (storedSize > buffer.length - off) break
      const content = buffer.slice(off, off + storedSize)
      off += storedSize
      try {
        entries.set(name.replace(/\\/g, '/').toLowerCase(), (storedSize < rawSize)
          ? lz4DecompressBlock(content, rawSize)
          : Buffer.from(content))
      } catch {
        entries.set(name.replace(/\\/g, '/').toLowerCase(), Buffer.from(content))
      }
    } else {
      if (off + 4 > buffer.length) break
      const contentSize = u32()
      if (contentSize > buffer.length - off) break
      entries.set(name.replace(/\\/g, '/').toLowerCase(), Buffer.from(buffer.slice(off, off + contentSize)))
      off += contentSize
    }
  }
  return { magic, version, entries }
}

// ---------------------------------------------------------------------------
// TEX 纹理（TEXV0005）
// ---------------------------------------------------------------------------

export const TEX_FORMAT = {
  0: 'RGBA8888',
  4: 'DXT5',
  6: 'DXT3',
  7: 'DXT1',
  8: 'RG88',
  9: 'R8',
  12: 'BC7',
}

export const TEX_FLAG = {
  NO_INTERPOLATION: 1,
  CLAMP_UVS: 2,
  IS_GIF: 4,
  CLAMP_UVS_BORDER: 8,
}

function readCString(buffer, offset) {
  let end = offset
  while (end < buffer.length && buffer[end] !== 0) end++
  return { value: buffer.slice(offset, end).toString('latin1'), next: end + 1 }
}

/**
 * 解析 .tex → 结构化纹理（mip 数据保留原始块，GPU 上传由前端按 WebGL2 压缩扩展处理；
 * LZ4 在 Node 侧解压）。PNG/JPEG 内嵌 mip（ImageFormat 13/2）原样返回，前端用 <img> 解码。
 */
export function parseTex(buffer) {
  let off = 0
  const i32 = () => { const v = buffer.readInt32LE(off); off += 4; return v }

  const magic1 = readCString(buffer, off); off = magic1.next
  const magic2 = readCString(buffer, off); off = magic2.next
  if (!magic1.value.startsWith('TEXV') || magic2.value !== 'TEXI0001') {
    throw new Error('TEX: 魔数不符 ' + magic1.value + ' / ' + magic2.value)
  }

  let format = i32()
  const flags = i32()
  const textureWidth = i32()
  const textureHeight = i32()
  const imageWidth = i32()
  const imageHeight = i32()
  i32() // UnkInt0

  const container = readCString(buffer, off); off = container.next
  if (!container.value.startsWith('TEXB')) {
    throw new Error('TEX: 容器魔数不符 ' + container.value)
  }

  const imageCount = i32()
  let imageFormat = -1 // raw
  if (container.value === 'TEXB0003' || container.value === 'TEXB0004') {
    imageFormat = i32()
    if (container.value === 'TEXB0004') i32() // isVideoMp4
  }

  const images = []
  for (let img = 0; img < imageCount; img++) {
    if (off + 4 > buffer.length) break
    const mipmapCount = Math.min(Math.max(i32(), 1), 32)
    const mipmaps = []
    for (let mip = 0; mip < mipmapCount; mip++) {
      if (off + 20 > buffer.length) break
      const width = i32()
      const height = i32()
      const isLZ4 = i32()
      const decompressedSize = i32()
      const byteCount = i32()
      if (byteCount < 0 || off + byteCount > buffer.length) break
      const raw = Buffer.from(buffer.slice(off, off + byteCount))
      off += byteCount
      let data = raw
      if (isLZ4 === 1) {
        try {
          data = lz4DecompressBlock(raw, decompressedSize)
        } catch (error) {
          mipmaps.push({ width, height, error: 'LZ4 解压失败: ' + error.message })
          break
        }
      }
      mipmaps.push({ width, height, decompressedSize, data })
    }
    images.push({ mipmaps })
    // GIF 动画帧容器（TEXS0002/0003）等附加段：v1 忽略，仅取 mip0 静态帧
    if (flags & TEX_FLAG.IS_GIF) break
  }

  // 2 的幂画布 → 裁剪到图像尺寸（见 cropRGBA/dxtDecodeToRGBA 注释），只处理 mip0。
  // 分支 1：DXT 压缩（解码 + 裁剪）
  if ([4, 6, 7].includes(format) && imageFormat === -1 && images[0]?.mipmaps?.[0]?.data) {
    try {
      const mip0 = images[0].mipmaps[0]
      const rgba = dxtDecodeToRGBA(mip0.data, textureWidth, textureHeight, format)
      const cropped = cropRGBA(rgba, textureWidth, textureHeight, imageWidth, imageHeight)
      images[0].mipmaps = [{
        width: imageWidth,
        height: imageHeight,
        decompressedSize: cropped.length,
        data: cropped,
      }]
      format = 0 // RGBA8888
    } catch (error) {
      console.warn('TEX: DXT 解码失败，保留压缩块:', error.message)
    }
  }
  // 分支 2：非压缩 raw（RGBA8888/RG88/R8）画布 ≠ 图像尺寸 → 直接裁剪，
  // 否则填充区会被采进画面（如 flowmask 512×256 画布装 384×256 图 → UV>0.75 全错）
  else if ([0, 8, 9].includes(format) && imageFormat === -1
    && (textureWidth !== imageWidth || textureHeight !== imageHeight)
    && images[0]?.mipmaps?.[0]?.data) {
    const mip0 = images[0].mipmaps[0]
    const bpp = format === 0 ? 4 : format === 8 ? 2 : 1
    if (mip0.data.length >= textureWidth * textureHeight * bpp) {
      images[0].mipmaps = [{
        width: imageWidth,
        height: imageHeight,
        decompressedSize: imageWidth * imageHeight * bpp,
        data: cropRGBA(mip0.data, textureWidth, textureHeight, imageWidth, imageHeight, bpp),
      }]
    }
  }

  return {
    format,
    formatName: TEX_FORMAT[format] || ('UNKNOWN_' + format),
    flags,
    textureWidth,
    textureHeight,
    width: imageWidth || textureWidth,
    height: imageHeight || textureHeight,
    isGif: Boolean(flags & TEX_FLAG.IS_GIF),
    clampUVs: Boolean(flags & TEX_FLAG.CLAMP_UVS),
    noInterpolation: Boolean(flags & TEX_FLAG.NO_INTERPOLATION),
    imageFormat, // -1=raw 像素块, 13=PNG, 2=JPEG
    images,
  }
}

// ---------------------------------------------------------------------------
// 着色器转译（HLSL 方言 → GLSL ES 3.0）
// ---------------------------------------------------------------------------

// ⚠️ 类型前可有精度限定符（lowp/mediump/highp）：`uniform lowp vec3 g_Tint;` 不允许漏配，
// 否则 meta 丢失 → 渲染端 setConstantUniforms 跳过 → g_Tint 保持 0 → 材质全黑（dna/demon_core 实际踩坑）
const UNIFORM_META_RE = /uniform\s+(?:(?:lowp|mediump|highp)\s+)?(sampler2D|sampler3D|float|int|uint|vec[234]|mat[234])\s+((?:g|u)_\w+)\s*;([^\n]*)/
// combo 与 default 之间可隔着 "type":"options" 等字段（Simple_Audio_Bars.frag 实测），
// 用 [^}\n]*? 限定同一 meta 对象内、不跨行
const COMBO_META_RE = /"combo"\s*:\s*"([^"]+)"[^}\n]*?"default"\s*:\s*(-?\d+)/g

function parseUniformMeta(line) {
  const match = UNIFORM_META_RE.exec(line)
  if (!match) return null
  const meta = { type: match[1], name: match[2] }
  const jsonMatch = /\{[\s\S]*\}/.exec(match[3])
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (typeof parsed.material === 'string') meta.material = parsed.material
      // 贴图槽驱动 combo 名（MASK/TIMEOFFSET/OPACITYMASK…）：编辑器绑定该贴图即置 1，
      // 元数据无 default → 服务端按「槽位绑定 + 源码引用」推导（depthparallax 实证：
      // 槽位硬编码 tex1→MASK 对其失配，combo 名必须从元数据读）
      if (typeof parsed.combo === 'string' && parsed.combo) meta.combo = parsed.combo
      if (parsed.require && typeof parsed.require === 'object') meta.require = parsed.require
      // default 可能是数字（float）或向量字符串（"0.5 0.5 0.5"）——渲染端两种都支持
      if (typeof parsed.default === 'number' || typeof parsed.default === 'string') meta.default = parsed.default
    } catch { /* 注释非 JSON，忽略 */ }
  }
  return meta
}

/**
 * 转译 WE 着色器为 GLSL ES 3.0。
 * @param {string} source HLSL 方言源码
 * @param {object} opts { combos: Record<string, number> }
 * @returns {{ code: string, uniforms: Array, combos: Record<string, number>, defines: string[] }}
 */
export function transpileShader(source, opts = {}) {
  // WE 着色器是 CRLF：ANGLE 预处理器会把 #if MULTI\r 的 \r 当作表达式后的非法 token，
  // 统一规范化为 \n
  source = String(source).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // #if/#elif 表达式尾随分号（D3D 预处理器容忍，GLSL 报
  // "unexpected token after conditional expression"，雪境 Simple_Audio_Bars 实证）
  source = source.replace(/^(\s*#\s*(?:if|elif)\s+[^;\n]*?)\s*;\s*$/gm, '$1')
  const combos = {}
  // 着色器内声明的 combo 默认值（// {"combo":"MULTI","default":1}）
  for (const match of source.matchAll(COMBO_META_RE)) {
    combos[match[1].toUpperCase()] = parseInt(match[2], 10)
  }
  // 兄弟阶段（.vert↔.frag）元数据声明的 combo 默认值：WE 的 combo 是材质级，两个阶段共享。
  // （auto_sway 实测：AA_VERSION 只在 .vert 元数据声明，.frag 也用它 → 不并入则 frag
  //  把 AA_VERSION 视为 0 → #if AA_VERSION==3/2/1 全不成立 → 三个 main 全被剔除 → Missing main()）
  // 本阶段自己的声明优先（同名不同默认值时不被兄弟覆盖）
  if (opts.siblingCombos) {
    for (const [key, value] of Object.entries(opts.siblingCombos)) {
      if (!Object.prototype.hasOwnProperty.call(combos, key)) combos[key] = value
    }
  }
  // 材质 pass 指定的 combos 覆盖默认值（WE combo 大小写不敏感）
  if (opts.combos) {
    for (const [key, value] of Object.entries(opts.combos)) {
      combos[String(key).toUpperCase()] = Number(value) || 0
    }
  }

  // uniform 元数据收集（保留注释不影响编译）
  const uniforms = []
  for (const line of source.split('\n')) {
    const meta = parseUniformMeta(line)
    if (meta) uniforms.push(meta)
  }

  let code = source
  // GLSL 关键字/内建函数替换（varying 按着色器类型由调用方处理：顶点→out / 片段→in）
  code = code.replace(/\battribute\b/g, 'in')
  code = code.replace(/\btexSample2DLod\b/g, 'textureLod')
  code = code.replace(/\btexSample2D\b/g, 'texture')
  code = code.replace(/\btex2Dproj\b/g, 'textureProj')
  code = code.replace(/\btex2D\b/g, 'texture')
  code = code.replace(/\bCAST2\b/g, 'vec2')
  code = code.replace(/\bCAST3\b/g, 'vec3')
  code = code.replace(/\bCAST4\b/g, 'vec4')
  code = code.replace(/\bfrac\b/g, 'fract')
  code = code.replace(/\blerp\b/g, 'mix')
  code = code.replace(/\bddx\b/g, 'dFdx')
  code = code.replace(/\bddy\b/g, 'dFdy')
  // HLSL atan2(y, x) = GLSL atan(y, x)（雪境 lens_flare_sun 实测）
  code = code.replace(/\batan2\b/g, 'atan')

  // HLSL 允许整数字面量直接参与浮点运算（2 * x），GLSL 不允许 →
  // 裸整数补 .0。跳过预处理行（#define FORMAT_* 0 必须保持整型）、数组下标与标识符内部；
  // 科学计数法指数（1e-10 / 1E+5）的整数也不能补（(?<!e-)(?<!E-)…）
  code = code.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return line
    // int 型 for 头整行跳过（for (int i = 0; i < n; i++) 的 0/10 必须保持整型；
    // 雪境 gaussian.frag:397 `int i = 0.0` 实证——此前被千咲 0:35 错误掩盖）
    // const int/uint 声明同样跳过（雪境 shine_cast `const int sampleCount = 4` 被补成
    // 4.0 → "cannot convert from 'const float' to 'const highp int'" 实测）
    if (/\bfor\s*\(\s*(?:int|uint)\b/.test(line)) return line
    if (/\bconst\s+(?:int|uint)\b/.test(line)) return line
    // int/uint 声明行同样跳过（`int spectrumIndex = 0;` 补 .0 → int = float 编译失败）
    if (/^\s*(?:int|uint)\s+[A-Za-z_]\w*\s*=/.test(line)) return line
    // 只对 // 前的代码段补 .0（工坊 audio_base 注释「16位采样」被改成「16.0位采样」实测）
    const cIdx = line.indexOf('//')
    const head = cIdx === -1 ? line : line.slice(0, cIdx)
    const tail = cIdx === -1 ? '' : line.slice(cIdx)
    return (head.replace(/(?<![\w.[\]eE])(?<!e-)(?<!e\+)(?<!E-)(?<!E\+)(\d+)(?![\w.])/g, '$1.0') + tail)
      // GLSL ES 3.00 保留字，HLSL/WE shader 里常作变量名 → 重命名
      // （sample 2026-10；input=custom_user_texture.frag 千咲/伊蕾娜；filter=color_grading.frag 虹夏/雪境）
      .replace(/\bsample\b/g, 'wf_sample')
      .replace(/\binput\b/g, 'wf_input')
      .replace(/\bfilter\b/g, 'wf_filter')
  }).join('\n')

  // HLSL 允许 float/int 标量直接当布尔条件（frame_builder_by_gariam.frag:576
  // `vec4 final = outside ? inSmooth : outSmooth;`，outside 是 float），GLSL ES 三元/if
  // 条件必须 bool → 收集本 shader 声明的标量变量名，把「裸标量当条件」包成 (x != 0.0)。
  // （收集在保留字重命名之后进行；不动函数调用/成员访问/已有比较表达式）
  const scalarType = new Map() // name -> 'float' | 'int'（bool 条件块与 int/float 混合算术块共用）
  {
    for (const m of code.matchAll(/\b(float|int)\b([^;{}]*);/g)) {
      if (!m[2].includes('=')) continue // 排除函数形参（无初始化列表）
      for (const part of m[2].split(',')) {
        const name = part.split('=')[0].trim()
        if (/^[A-Za-z_]\w*$/.test(name)) scalarType.set(name, m[1])
      }
    }
    for (const [name, type] of scalarType) {
      const zero = type === 'int' ? '0' : '0.0'
      // 三元条件：`name ?` → `(name != 0.0) ?`
      code = code.replace(new RegExp('(?<![\\w.])(' + name + ')\\s*\\?', 'g'), `(${name} != ${zero}) ?`)
      // if/while 条件：`if (name)` → `if (name != 0.0)`
      code = code.replace(new RegExp('(?<=\\b(?:if|while)\\s*\\(\\s*)(' + name + ')(?=\\s*\\))', 'g'), `${name} != ${zero}`)
    }
  }

  // D3D 允许 bool 参与算术（雪境 gaussian.frag:363 `depth *= (depth < blurPreciseLimit) * 6.0;`），
  // GLSL ES bool * float 非法 → 把「紧跟/前邻算术运算符的括号比较表达式」包成三目 (… ? 1.0 : 0.0)。
  // 只处理无嵌套括号的简单比较；for 头/if 条件里的比较不被算术符紧邻，天然不受影响。
  // ⚠️ ① 预处理行整行跳过（#if 里包三目 = 浮点字面量进预处理器 = 非法，procedural_noise
  //     vert:195 实测）；② 只处理 `//` 前的代码段（否则注释里的 `/` 被当除号，同处实证）。
  {
    const cmp = '[^()\\n]*?(?:<=|>=|==|!=|<|>)[^()\\n]*?'
    code = code.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return line
      const cIdx = line.indexOf('//')
      const head = cIdx === -1 ? line : line.slice(0, cIdx)
      const tail = cIdx === -1 ? '' : line.slice(cIdx)
      return head
        .replace(new RegExp('\\((' + cmp + ')\\)(\\s*[+\\-*/%])(?!\\s*\\?)', 'g'), '(($1) ? 1.0 : 0.0)$2')
        .replace(new RegExp('(\\s*[+\\-*/%=])\\((' + cmp + ')\\)(?!\\s*\\?)', 'g'), '$1(($2) ? 1.0 : 0.0)') + tail
    }).join('\n')
  }

  // D3D 允许 int 变量直接参与浮点算术（雪境 shine_cast `i / sampleDrop`：i 是 for 计数器、
  // sampleDrop 是 float），GLSL ES 无隐式 int→float → 已知 int 标量与 float 操作数相邻
  // 运算时包 float(int)。仅当对侧「确有 float 线索」（float 字面量/已知 float 名）才改写，
  // 避免把 int/int 算术（除法截断语义）误改成浮点除。
  {
    const floatNames = new Set()
    const intNames = new Set()
    for (const [n, t] of scalarType) (t === 'float' ? floatNames : intNames).add(n)
    for (const m of code.matchAll(/\bfor\s*\(\s*int\s+([A-Za-z_]\w*)/g)) intNames.add(m[1])
    for (const u of uniforms) {
      if (u.type === 'float') floatNames.add(u.name)
      else if (u.type === 'int' || u.type === 'uint') intNames.add(u.name)
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const floatHintRe = floatNames.size
      ? new RegExp('(?<![\\w.])(?:' + [...floatNames].map(esc).join('|') + ')(?![\\w.])')
      : null
    const hasFloatHint = (s) =>
      /\d+\.\d*(?:[eE][+-]?\d+)?/.test(s) || (!!floatHintRe && floatHintRe.test(s))
    for (const n of intNames) {
      if (floatNames.has(n)) continue
      // n op <float 线索> → float(n) op …（rhs 到语句边界；含 '(' 视为复杂调用交回签名感知层）
      code = code.replace(
        new RegExp('(?<![\\w.])(' + n + ')(?![\\w.])(\\s*[+\\-*/%]\\s*)([^;,()\\n]+)', 'g'),
        (m0, v, op, rhs) => (hasFloatHint(rhs) ? 'float(' + v + ')' + op + rhs : m0),
      )
      // <float 线索> op n → … op float(n)（lhs 不跨括号/边界；对整体 lhs 验证 float 线索）
      code = code.replace(
        new RegExp('([^;,()\\n]*?)(\\s*[+\\-*/%]\\s*)(' + n + ')(?![\\w.])', 'g'),
        (m0, lhs, op, v) => (hasFloatHint(lhs) ? lhs + op + 'float(' + v + ')' : m0),
      )
    }
  }

  // 用户函数 int 形参位的实参回包 int()：裸整数补 .0 把 `preCalcNode(2,…)` 变成
  // `preCalcNode(2.0,…)`（int 形参），D3D 隐式转换 GLSL 不认 → int() 包回。
  // out/inout 形参是左值不能包；实参已是 int( 开头跳过；仅处理单行调用。
  {
    const fnSigs = new Map()
    for (const m of code.matchAll(/\b(?:void|float|int|uint|bool|vec[234]|ivec[234]|bvec[234]|uvec[234]|mat[234]|mat[23]x[234])\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
      fnSigs.set(m[1], m[2].split(',').map((p) => {
        const t = p.trim().replace(/^(?:const|in|out|inout)\b/, '').trim()
        return { type: t.split(/\s+/)[0] || '', out: /\b(?:out|inout)\b/.test(p) }
      }))
    }
    for (const [fname, params] of fnSigs) {
      const intIdx = params
        .map((p, i) => ((/(?:^|[^a-z])(?:int|uint|ivec[234]|uvec[234]|bvec[234])$/.test(p.type) && !p.out) ? i : -1))
        .filter((i) => i >= 0)
      if (!intIdx.length) continue
      const callRe = new RegExp('(?<![\\w.])' + fname + '\\(', 'g')
      code = code.split('\n').map((line) => {
        if (!callRe.test(line)) return line
        callRe.lastIndex = 0
        let out = ''
        let pos = 0
        for (const cm of line.matchAll(callRe)) {
          // 函数定义行（前面是返回类型）不是调用 → 跳过整行
          if (/\b(?:void|float|int|uint|bool|vec[234]|ivec[234]|bvec[234]|uvec[234]|mat[234]|mat[23]x[234])\s*$/.test(line.slice(0, cm.index))) return line
          const start = cm.index + cm[0].length
          let depth = 1
          let end = -1
          for (let i = start; i < line.length && depth > 0; i++) {
            if (line[i] === '(') depth++
            else if (line[i] === ')') { depth--; if (depth === 0) { end = i; break } }
          }
          if (end < 0) return line // 多行调用不处理
          const argsRaw = line.slice(start, end)
          const args = []
          let d = 0, s = 0
          for (let i = 0; i < argsRaw.length; i++) {
            if (argsRaw[i] === '(' || argsRaw[i] === '[') d++
            else if (argsRaw[i] === ')' || argsRaw[i] === ']') d--
            else if (argsRaw[i] === ',' && d === 0) { args.push(argsRaw.slice(s, i)); s = i + 1 }
          }
          args.push(argsRaw.slice(s))
          if (args.length !== params.length) return line // 重载歧义不动
          for (const i of intIdx) {
            const a = args[i].trim()
            if (/^int\s*\(/.test(a)) continue
            args[i] = args[i].replace(a, 'int(' + a + ')')
          }
          out += line.slice(pos, cm.index) + fname + '(' + args.join(',') + ')'
          pos = end + 1
        }
        out += line.slice(pos)
        return out
      }).join('\n')
    }
  }

  // float 变量作数组下标（雪境 Simple_Audio_Bars：`float i = floor(...); left[i]`，
  // D3D 隐式转换）→ 下标表达式包 int()。
  {
    const floatScalars = new Set()
    for (const m of code.matchAll(/\bfloat\s+([A-Za-z_]\w*)\s*(?=[=;,)\[])/g)) floatScalars.add(m[1])
    if (floatScalars.size) {
      code = code.replace(/\[\s*([A-Za-z_]\w*)((?:\s*[+\-*/][^\][;]{0,60})?)\s*\]/g, (m, name, rest) => {
        if (!floatScalars.has(name)) return m
        return '[int(' + name + rest + ')]'
      })
    }
  }

  const defines = []
  // ANGLE 对 #if 中未定义的标识符直接报错（GLSL ES 3.00 严格模式）→
  // 把 #if/#elif 表达式里未定义的标识符注入 0（WE 引擎编译时同样注入全部 combo 默认值）。
  // ⚠️ #ifdef/#ifndef 的操作数**绝不注入**：#define X 0 会让 #ifdef 变「已定义」而错误激活分支
  // （如 genericimage2.frag 的 #ifdef GRADIENT_SAMPLER 内部 texture(GRADIENT_SAMPLER) 用宏展开成 texture(0,...)）
  const knownNames = new Set(Object.keys(combos))
  // 源内声明的 uniform 名不能被宏占用（宏展开会替换 texture() 里的 sampler 名）
  const uniformNames = new Set()
  for (const match of source.matchAll(/\buniform\s+\w+\s+(\w+)/g)) uniformNames.add(match[1])
  const ifExprTokens = new Set()
  for (const match of source.matchAll(/#\s*(?:if|elif)\s+(.+)/g)) {
    const expr = match[1]
      .replace(/\bdefined\s*\(\s*\w+\s*\)/g, '')
      .replace(/\bdefined\s+\w+/g, '')
    for (const token of expr.match(/[A-Za-z_]\w*/g) || []) ifExprTokens.add(token)
  }
  // 源内（含已内联的头文件）已有 #define 的名字不允许再注入 0 值，否则宏重定义报错
  for (const match of source.matchAll(/#\s*define\s+(\w+)/g)) {
    knownNames.add(match[1])
  }
  // 用作数组尺寸的标识符不能注入 0（GLSL ES 要求常量尺寸 ≥1），
  // 如 genericimage2.vert 的 g_Bones[BONECOUNT]（骨骼数组始终声明，仅在 SKINNING combo 下参与运算）。
  // ⚠️ 必须限定「声明上下文」（类型 名字[TOKEN]）：裸 /\[TOKEN\]/ 会把索引表达式
  // spectrum[spectrumIndex]、arr[i] 也当尺寸捕获，注入 #define spectrumIndex 1 后
  // 把 `int spectrumIndex = ...` 毁成 `int 1 = ...`（demon_core 实际踩坑）
  const arrayDimTokens = new Set()
  const declDimRe = /\b(?:uniform|attribute|varying|const|float|int|uint|bool|double|vec[234]|ivec[234]|bvec[234]|uvec[234]|dvec[234]|mat[234]|mat[23]x[234]|dmat[234])\s+\w+\s*\[\s*([A-Za-z_]\w*)\s*\]/g
  for (const match of source.matchAll(declDimRe)) arrayDimTokens.add(match[1])
  // 保险：源内以变量声明出现过的标识符（int spectrumIndex =、for (int i = 0) 等）
  // 一律不再注入宏——宏会毁掉同名变量声明
  const declaredNames = new Set()
  for (const match of source.matchAll(/\b(?:int|uint|float|double|bool|vec[234]|ivec[234]|bvec[234]|uvec[234]|mat[234])\s+([A-Za-z_]\w*)\s*(?==|,|;|\[|\))/g)) {
    declaredNames.add(match[1])
  }
  const rewriteTokens = new Set() // 与 uniform 重名的 #if token：不注入宏，行内替换为 0
  // int 常量与 float 字面量混算在 GLSL ES 无隐式转换（D3D 宽松）→ float() 包裹 int 常量。
  // 实证：雪境 3669680904 gaussian.vert:35 `(QUALITY + 1.0) * 0.6`（QUALITY 是 combo 宏）、
  // :386 `albedo.rgb /= kernel + kernel + 2.0`（kernel 是 const int 局部常量）。
  // 只动非预处理行（#if 里须保持整型）；只在「紧邻 float 字面量」时包裹，
  // 纯整型运算/数组下标/整型变量不受影响。uniform/本地声明同名的跳过。
  {
    const floatLit = '(?:(?:\\d+\\.\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)'
    const intConstNames = new Set(Object.keys(combos))
    for (const m of code.matchAll(/\bconst\s+int\s+([A-Za-z_]\w*)/g)) intConstNames.add(m[1])
    for (const m of code.matchAll(/#\s*define\s+([A-Za-z_]\w*)\s+(\d+)\s*(?:\/\/.*)?$/gm)) intConstNames.add(m[1])
    // int 型函数形参（`void preCalcNode(in int nodeNum,…)` 传给 float 形参的
    // linearStep(2.0, float(NODE_COUNT), nodeNum)）→ 同样参与包裹；
    // float(nodeNum) 对已是 float 的值是合法 no-op，签名感知下安全
    for (const m of code.matchAll(/\b(?:int|uint)\s+([A-Za-z_]\w*)\s*[,)]/g)) intConstNames.add(m[1])
    // int 型 uniform 也参与包裹（`linearStep(2.0, float(NODE_COUNT), nodeNum)`
    // 的 int uniform 实参/混算）；float uniform 仍排除
    const floatUniformNames = new Set()
    for (const m of code.matchAll(/\buniform\s+(?!int\b|uint\b)[\w]+\s+([A-Za-z_]\w*)\s*[;,[]/g)) floatUniformNames.add(m[1])
    // combo 与 float uniform/本地声明同名 → 跳过（包裹会破坏其类型语义）；
    // const int / 整型 #define / int uniform 始终参与包裹
    const comboNames = [...intConstNames].filter((n) => {
      if (!Object.prototype.hasOwnProperty.call(combos, n)) return true
      return !floatUniformNames.has(n) && !declaredNames.has(n)
    })
    if (comboNames.length) {
      const nameRes = comboNames.map((name) => ({ name, re: new RegExp('(?<![\\w.\\[])' + name + '(?![\\w.\\[])(?!\\s*\\()', 'g') }))
      const floatRe = new RegExp(floatLit)
      // 签名感知：函数实参的包裹与否取决于形参类型。
      // - 用户函数：解析定义（`vec3 ApplyBlending(const int blendMode, in vec3 A, …)`）
      // - float 族内建（max/mix/…）：GLSL ES 无 int 重载 → 包
      // - 裸算术上下文（不在任何调用内，语句含 float 字面量）：包
      //   （QUALITY + 1.0 / kernel + kernel + 2.0）
      const fnParamTypes = new Map()
      for (const m of code.matchAll(/\b(?:void|float|int|uint|bool|vec[234]|ivec[234]|bvec[234]|uvec[234]|mat[234]|mat[23]x[234])\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
        fnParamTypes.set(m[1], m[2].split(',').map((p) => {
          const t = p.trim().replace(/^(?:const|in|out|inout)\b/, '').trim()
          return t.split(/\s+/)[0] || ''
        }))
      }
      const BUILTIN_FLOAT = new Set(['mix', 'clamp', 'max', 'min', 'smoothstep', 'step', 'mod', 'pow', 'saturate', 'lerp'])
      const isFloatParam = (callee, argIndex) => {
        if (BUILTIN_FLOAT.has(callee)) return true
        const types = fnParamTypes.get(callee)
        if (!types || !types[argIndex]) return null // 未知函数 → 不动
        return /^(?:float|vec[234]|mat[234])/.test(types[argIndex])
      }
      const enclosingCall = (str, pos) => {
        let depth = 0
        for (let i = pos - 1; i >= 0; i--) {
          const ch = str[i]
          if (ch === ')' || ch === ']') depth++
          else if (ch === '(' || ch === '[') {
            if (depth === 0) {
              if (ch === '[') return null
              let j = i - 1
              while (j >= 0 && /\s/.test(str[j])) j--
              let k = j
              while (k >= 0 && /[\w.]/.test(str[k])) k--
              const callee = str.slice(k + 1, j + 1)
              let d = 0, arg = 0
              for (let q = i + 1; q < pos; q++) {
                if (str[q] === '(' || str[q] === '[') d++
                else if (str[q] === ')' || str[q] === ']') d--
                else if (str[q] === ',' && d === 0) arg++
              }
              return { name: callee, argIndex: arg }
            }
            depth--
          }
        }
        return null
      }
      code = code.split('\n').map((line) => {
        if (/^\s*#/.test(line) || /^\s*for\s*\(/.test(line)) return line
        if (!nameRes.some(({ re }) => re.test(line))) return line
        // 按语句切（; 分隔）；语句含 float 字面量才考虑包裹
        return line.split(';').map((st) => {
          // float 声明的初始化器里的 int 常量也要包（`float len = AUDIOSAMPLES;`
          // 无 float 字面量但声明类型就是 float）；int 声明语句不包
          const floatDecl = /\bfloat\s+[A-Za-z_]\w*\s*=/.test(st)
          if (!floatRe.test(st) && !floatDecl) return st
          // int 型声明语句不包（const int N = 16 经裸整数补 .0 后含 16.0，
          // 包裹会毁掉声明本身）
          if (/\b(?:const\s+)?(?:int|uint|ivec[234]|uvec[234])\s+[A-Za-z_]\w*\s*(?:=|,|;|\[)/.test(st)) return st
          for (const { name, re } of nameRes) {
            re.lastIndex = 0
            st = st.replace(re, (m, off) => {
              // 行注释内不包（[COMBO] 元数据注释里的 combo 名要保持原样）
              const comment = st.indexOf('//')
              if (comment >= 0 && off > comment) return m
              // 下标 [] 内不包（float 下标非法）
              let d = 0
              for (let i = off - 1; i >= 0; i--) {
                if (st[i] === ']') d++
                else if (st[i] === '[') { if (d === 0) return m; d-- }
              }
              // 赋值左值不包（float(index) = … 非法；int 截断由下方 D3D 残留修复 pass 处理）
              if (/^\s*=(?![=])/.test(st.slice(off + m.length))) return m
              const ctx = enclosingCall(st, off)
              if (ctx && /^[A-Za-z_]\w*$/.test(ctx.name)) {
                const fp = isFloatParam(ctx.name, ctx.argIndex)
                return fp ? 'float(' + name + ')' : m
              }
              return 'float(' + name + ')'
            })
          }
          return st
        }).join(';')
      }).join('\n')
    }
  }
  // D3D 隐式转换残留修复：int 变量/宏与 float 字面量的比较与赋值（GLSL ES 无隐式转换）。
  // 实测：工坊 3588616811 effects/audio_base `if (index < 0.0) index = 0.0;`（index 是 int 形参）
  // ——上面的包裹 pass 因 if( 调用感知与左值保护双双跳过，此处兜底：
  // 比较侧包 float()（D3D 即按 float 比较）；赋值侧右值包 int()（D3D 赋值即截断）。
  {
    const repairNames = new Set(Object.keys(combos))
    for (const m of code.matchAll(/\b(?:int|uint)\s+([A-Za-z_]\w*)\s*[,)=]/g)) repairNames.add(m[1])
    for (const m of code.matchAll(/\bfor\s*\(\s*(?:int|uint)\s+([A-Za-z_]\w*)/g)) repairNames.add(m[1])
    for (const m of code.matchAll(/\bconst\s+(?:int|uint)\s+([A-Za-z_]\w*)/g)) repairNames.add(m[1])
    for (const m of code.matchAll(/#\s*define\s+([A-Za-z_]\w*)\s+(\d+)/g)) repairNames.add(m[1])
    for (const [n, t] of scalarType) if (t === 'int') repairNames.add(n)
    if (repairNames.size) {
      const alt = [...repairNames].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      const cmpOp = '\\s*(?:<=|>=|==|!=|<|>)\\s*'
      const floatLitRe = /\d+\.\d*(?:[eE][+-]?\d+)?/
      code = code.split('\n').map((line) => {
        if (/^\s*#/.test(line)) return line
        const cIdx = line.indexOf('//')
        let head = cIdx === -1 ? line : line.slice(0, cIdx)
        const tail = cIdx === -1 ? '' : line.slice(cIdx)
        // index <op> 0.5 → float(index) <op> 0.5（对侧到语句边界须真含 float 字面量）
        head = head.replace(
          new RegExp('(?<![\\w.])(' + alt + ')(?![\\w.])(' + cmpOp + ')([^;,()\\n]+)', 'g'),
          (m0, v, op, rhs) => (floatLitRe.test(rhs) ? 'float(' + v + ')' + op + rhs : m0),
        )
        // 0.5 <op> index → 0.5 <op> float(index)（lhs 不跨括号/边界）
        head = head.replace(
          new RegExp('([^;,()\\n]*?\\d+\\.\\d*[^;,()\\n]*?)(' + cmpOp + ')(' + alt + ')(?![\\w.])', 'g'),
          (m0, lhs, op, v) => (floatLitRe.test(lhs) ? lhs + op + 'float(' + v + ')' : m0),
        )
        // index = 0.5 → index = int(0.5)（仅纯赋值；右值已 int( 包裹的跳过）
        head = head.replace(
          new RegExp('(?<![\\w.])(' + alt + ')(?![\\w.])\\s*=(?![=])([^;\\n]+)', 'g'),
          (m0, v, rhs) => (/^\s*int\(/.test(rhs) || !floatLitRe.test(rhs) ? m0 : v + ' = int(' + rhs + ')'),
        )
        return head + tail
      }).join('\n')
    }
  }
  for (const token of ifExprTokens) {
    if (token === 'true' || token === 'false' || knownNames.has(token)) continue
    if (declaredNames.has(token)) continue
    if (uniformNames.has(token)) { rewriteTokens.add(token); knownNames.add(token); continue }
    defines.push('#define ' + token + ' ' + (arrayDimTokens.has(token) ? 1 : 0))
    knownNames.add(token)
  }
  // 裸数组尺寸（不在 #if 里，如 uniform mat4x3 g_Bones[BONECOUNT]）同样需要定义
  for (const token of arrayDimTokens) {
    if (token === 'true' || token === 'false' || knownNames.has(token)) continue
    if (uniformNames.has(token) || declaredNames.has(token)) continue
    defines.push('#define ' + token + ' 1')
    knownNames.add(token)
  }
  // combos 注入也要避开 uniform 名（WE 的机制：combo 只控制编译分支）
  const comboDefines = []
  for (const [name, value] of Object.entries(combos)) {
    if (uniformNames.has(name)) continue
    // ⚠️ 必须保留原值，不能压成 0/1：多值 combo 依赖真实数值参与 #if 判断与算术
    // （genericimage2 的 VERSION 1/2 走不同 uniform 分支、BLENDMODE 1-6 选混合、
    //  HUEMODE options 0/1）。压成 1 曾致 bedroom version:2 材质拿到 VERSION 1 → g_Color4 未赋值
    comboDefines.push('#define ' + name + ' ' + Number(value))
  }
  // 与 uniform 重名的 #if/#elif token：行内替换为 0（等价 WE 默认 combo 值）
  if (rewriteTokens.size > 0) {
    code = code.split('\n').map((line) => {
      if (!/^\s*#\s*(?:if|elif)\s/.test(line)) return line
      for (const token of rewriteTokens) {
        line = line.replace(new RegExp('\\b' + token + '\\b', 'g'), '0')
      }
      return line
    }).join('\n')
  }

  // #if/#ifdef/#ifndef 与 #endif 配平（Simple_Audio_Bars.vert 原始源码就有多余 #endif，
  // WE 自家编译器容忍、ANGLE 报 "unexpected #endif"）→ 深度为 0 的 #endif 丢弃，
  // 收尾仍未闭合的 #if 补 #endif。#else/#elif 仅在栈非空时保留。
  {
    const outLines = []
    let depth = 0
    for (const line of code.split('\n')) {
      const pp = /^\s*#\s*(\w+)/.exec(line)
      const directive = pp ? pp[1] : ''
      if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
        depth++
        outLines.push(line)
      } else if (directive === 'endif') {
        if (depth > 0) { depth--; outLines.push(line) }
        else outLines.push('// [WEScene] dropped extra #endif (源码未配对)')
      } else if ((directive === 'else' || directive === 'elif') && depth === 0) {
        outLines.push('// [WEScene] dropped orphan ' + directive)
      } else {
        outLines.push(line)
      }
    }
    while (depth > 0) { outLines.push('#endif'); depth-- }
    code = outLines.join('\n')
  }

  const header = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    // 片段着色器：显式输出变量声明必须位于 #version 之后（由 transpileFragmentShader 传 fragOut）
    ...(opts.fragOut ? ['layout(location = 0) out highp vec4 wf_fragColor;'] : []),
    ...defines,
    ...comboDefines,
    '#define mul(a, b) ((a) * (b))',
    '#define saturate(x) clamp(x, 0.0, 1.0)',
    '#define lerp(a, b, t) mix(a, b, t)',
    '#define CAST2(x) vec2(x)',
    '#define CAST3(x) vec3(x)',
    '#define CAST4(x) vec4(x)',
    // 模型顶点着色器（generic 等）用 CAST3X3(g_ModelMatrix) 取 3x3 旋转部分；
    // BuildTangentSpace 由引擎 common_vertex.h（#include 展开时已带）原生提供，勿在此重定义。
    '#define CAST3X3(x) mat3(x)',
  ].join('\n')

  return { code: header + '\n' + code, uniforms, combos, defines }
}

/** 顶点着色器转译入口（varying → out）。 */
export function transpileVertexShader(source, opts = {}) {
  const result = transpileShader(source, opts)
  let code = result.code.replace(/\bvarying\b/g, 'out')
  // 末尾 #endif 等指令缺换行会报 "unexpected end of file found in directive"
  if (!code.endsWith('\n')) code += '\n'
  return { ...result, code }
}

/** 片段着色器转译入口（varying → in、gl_FragColor 重定向为显式输出）。 */
export function transpileFragmentShader(source, opts = {}) {
  const result = transpileShader(source, { ...opts, fragOut: true })
  let code = result.code
  code = code.replace(/\bvarying\b/g, 'in')
  code = code.replace(/\bgl_FragColor\b/g, 'wf_fragColor')
  if (!code.endsWith('\n')) code += '\n'
  // D3D 允许给 input varying 赋值（雪境 gaussian 系 shader `v_TexCoord = …`），
  // GLSL ES input 只读 → 被赋值的 varying 改名 + 在 main() 顶部注入局部拷贝。
  // （改名后 helper 函数里仍引用原 input——仅当赋值与使用同在 main 时完全等价，主流场景成立）
  // 检测只认全局作用域声明（行首 in <type> <name>;）；函数形参 in vec3 A 不在列。
  const globalInputs = new Set()
  for (const m of code.matchAll(/(?:^|\n)\s*(?:lowp\s+|mediump\s+|highp\s+)*in\s+(\w+)\s+([A-Za-z_]\w*)\s*;/g)) {
    globalInputs.add(m[2])
  }
  for (const name of globalInputs) {
    if (!new RegExp('(?<![\\w.])' + name + '(?:\\s*\\.\\s*\\w+)?\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|\\+\\+|--)').test(code)) continue
    const copyName = 'wf_lv_' + name
    const typeM = code.match(new RegExp('\\bin\\s+((?:lowp\\s+|mediump\\s+|highp\\s+)?\\w+)\\s+' + name + '\\b'))
    const type = typeM ? typeM[1] : 'vec2'
    code = code.replace(new RegExp('(?<![\\w.])' + name + '\\b', 'g'), copyName)
      .replace(new RegExp('\\bin\\s+(\\w+)\\s+' + copyName + '\\b'), (m0) => m0.replace(copyName, name))
    // 全局可写副本（非局部）：helper 函数也可能引用改名后的标识符（auto_sway calNode 实测
    // `wf_lv_v_TexCoord undeclared`）→ main 内局部声明够不到。GLSL 里 main 启动前不可能有
    // 任何函数调用 → 全局声明 + main 顶部初始化与「局部拷贝」语义完全等价。
    code = code.replace(
      new RegExp('\\bin\\s+(?:lowp\\s+|mediump\\s+|highp\\s+)?\\w+\\s+' + name + '\\s*;'),
      (m0) => m0 + '\n' + type + ' ' + copyName + ';',
    )
    code = code.replace(/void\s+main\s*\(\s*\)\s*\{/, (m0) => m0 + '\n  ' + copyName + ' = ' + name + ';')
  }
  return { ...result, code }
}

// ---------------------------------------------------------------------------
// 工程资产源（磁盘目录 + 可选 scene.pkg 覆盖）
// ---------------------------------------------------------------------------

const JSON_ASSET_RE = /\.(json|frag|vert)$/i

export class WallpaperEngineAssetSource {
  /**
   * @param {string} dir 壁纸目录
   * @param {string|null} engineAssetsDir WE 安装 assets 根目录（models/materials/shaders 兜底）
   */
  constructor(dir, engineAssetsDir = null) {
    this.dir = dir
    this.engineAssetsDir = engineAssetsDir
    this.pkg = null
    this.pkgChecked = false
  }

  #loadPkg() {
    if (this.pkgChecked) return this.pkg
    this.pkgChecked = true
    const pkgPath = path.join(this.dir, 'scene.pkg')
    try {
      if (fs.existsSync(pkgPath)) {
        this.pkg = parsePkg(fs.readFileSync(pkgPath))
      }
    } catch (error) {
      console.warn('[WEScene] scene.pkg 解析失败:', error.message)
      this.pkg = null
    }
    return this.pkg
  }

  /** 读取资产。先磁盘后 pkg，再退 WE 引擎内置资产（models/util 等内置引用）。返回 Buffer 或 null。 */
  read(name) {
    const normalized = String(name).replace(/\\/g, '/').replace(/^\.\//, '')
    // shader 类资产补「shaders/」前缀候选：材质/效果 json 里的 shader 名常不带前缀
    // （如 workshop/<id>/effects/godrays_cast），而 pkg 键与引擎目录都带
    // （shaders/workshop/<id>/effects/godrays_cast.frag）→ 精确匹配落空 → pass 整个
    // error 跳过（女孩与武士 godrays 实证：cast pass 丢失 → 径向光柱消失、画面偏暗）。
    const candidates = [normalized]
    if (/\.(vert|frag|h)$/i.test(normalized) && !/^shaders\//i.test(normalized)) {
      candidates.push('shaders/' + normalized)
    }
    // 磁盘优先（defaultprojects 等解包工程；.tex 缺失时回退同名 .png）
    for (const candidate of candidates) {
      try {
        const full = path.resolve(this.dir, candidate)
        if (full.startsWith(path.resolve(this.dir)) && fs.existsSync(full)) {
          return fs.readFileSync(full)
        }
      } catch { /* 路径非法，忽略 */ }
    }
    const pkg = this.#loadPkg()
    if (pkg) {
      for (const candidate of candidates) {
        const entry = pkg.entries.get(candidate.toLowerCase())
        if (entry) return entry
      }
    }
    if (this.engineAssetsDir) {
      // 引擎内置资产兜底：models/util/fullscreenlayer.json、shaders/genericimage.vert 等
      const engineRoot = path.resolve(this.engineAssetsDir)
      for (const candidate of candidates) {
        for (const withPng of [candidate, candidate.replace(/\.tex$/i, '.png')]) {
          try {
            const full = path.resolve(engineRoot, withPng)
            if (full.startsWith(engineRoot) && fs.existsSync(full)) {
              return fs.readFileSync(full)
            }
          } catch { /* 忽略 */ }
        }
      }
    }
    return null
  }

  /** 读文本资产。 */
  readText(name) {
    const buffer = this.read(name)
    return buffer ? buffer.toString('utf8') : null
  }

  readJson(name) {
    const text = this.readText(name)
    if (text == null) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /** 资产是否存在（不读取内容）。 */
  has(name) {
    return this.read(name) !== null
  }

  /**
   * 解析 #include 指令（递归、带循环守卫 + 按文件名去重）。
   * WE 的 include 可写 "common_vertex.h"（相对 shader 目录）或项目内相对路径。
   * 另处理 #require <Module>（WE 引擎模块系统）：LightingV1 = common_fragment.h
   * （光照 uniform + ComputeLight/ComputeLightSpecular 等，函数与 common_pbr_2.h 零重叠，
   *  工坊 pkg 场景的 genericimage4 PBR 分支实测 18 个 pass 依赖它——不处理则 ANGLE
   * 报 'require' : invalid directive name）。
   * ⚠️ 同文件只内联一次（WE 引擎预处理器按文件名去重）：generic4 同时 #include
   * common_fragment.h 又 #require LightingV1（同文件）→ 两份 DecompressNormal/
   * ComputeLight 函数体，ANGLE 报 'function already has a body'（土星/太阳系实测）。
   */
  resolveIncludes(source, depth = 0, seen = new Set()) {
    if (depth > 8) return source
    let out = source.replace(/#include\s+"([^"]+)"/g, (_, includeName) => {
      if (seen.has(includeName)) return '//#include "' + includeName + '" // [WEScene] 已内联，跳过重复'
      seen.add(includeName)
      const included = this.readText(includeName)
      if (included == null) return '// [WEScene] include 未找到: ' + includeName
      return '//#include "' + includeName + '"\n' + this.resolveIncludes(included, depth + 1, seen)
    })
    out = out.replace(/#require\s+(\w+)/g, (_, moduleName) => {
      if (moduleName === 'LightingV1') {
        if (seen.has('LightingV1')) return '//#require LightingV1 // [WEScene] 已内联，跳过重复'
        seen.add('LightingV1')
        return '//#require LightingV1\n' + LIGHTING_V1_MODULE_GLSL
      }
      return '// [WEScene] require 未支持: ' + moduleName
    })
    return out
  }

  /**
   * 转译并返回 GLSL（type: 'vert'|'frag'）。
   * textureCombos：贴图槽驱动的 combo（tex1→MASK=1、tex2→TIMEOFFSET=1）。这类 combo 在
   * shader 元数据里没有 default（引擎在编辑器绑定遮罩时写入材质实例）→ 不推导恒为 0
   * → 遮罩失效（虹夏衣/发 waterwaves 波浪全对象涂抹实证）。仅当本阶段源码确实引用
   * 该 token 时注入（未用 MASK 的 shader 不受影响），显式 combos 优先。
   */
  buildShader(name, type, combos = {}, textureCombos = null) {
    let raw = this.readText(name)
    if (raw == null) return null
    // 兄弟阶段的 [COMBO] 元数据也是本阶段 combo 默认值的来源（WE combo 材质级共享，
    // auto_sway 的 AA_VERSION 只在 .vert 声明、.frag 也消费——缺它则 frag 三个 main 全灭）
    const siblingName = /\.vert$/i.test(name) ? name.replace(/\.vert$/i, '.frag') : name.replace(/\.frag$/i, '.vert')
    let siblingCombos
    if (siblingName !== name) {
      const siblingRaw = this.readText(siblingName)
      if (siblingRaw != null) {
        const normalized = String(siblingRaw).replace(/\r\n/g, '\n')
        siblingCombos = {}
        for (const match of normalized.matchAll(COMBO_META_RE)) {
          siblingCombos[match[1].toUpperCase()] = parseInt(match[2], 10)
        }
      }
    }
    // common_blur.h 的 blur13a/blur7a/blur3a 引用 g_Texture0/g_Texture1，但工程 frag 的
    // #include 常写在 uniform sampler 声明之前（WE 编译器容忍，GLSL 不行）→ 把 include
    // 移到最后一个 sampler2D 声明之后（2026-10-21 blurprecise 实测）
    if (/#include\s+"common_blur\.h"/.test(raw)) {
      const lines = raw.split('\n')
      const incIdx = lines.findIndex((l) => /#include\s+"common_blur\.h"/.test(l))
      let lastSampler = -1
      lines.forEach((l, i) => { if (/uniform\s+sampler2D\s+g_Texture\d/.test(l)) lastSampler = i })
      if (incIdx !== -1 && lastSampler > incIdx) {
        const [inc] = lines.splice(incIdx, 1)
        lines.splice(lastSampler, 0, inc)
        raw = lines.join('\n')
      }
    }
    const withIncludes = this.resolveIncludes(raw)
    if (textureCombos) {
      for (const [key, value] of Object.entries(textureCombos)) {
        if (Object.prototype.hasOwnProperty.call(combos, key)) continue
        if (!new RegExp('\\b' + key + '\\b').test(raw)) continue
        combos[key] = value
      }
    }
    // KERNEL（blur 系核宽）无 [COMBO] 元数据声明（blur_gaussian/shine_gaussian 的
    // #if KERNEL==0/1/2 由引擎按画质档注入），缺省时三分支全灭 → gl_FragColor 未定义
    // → bloom/blur 缓冲全黑。引擎默认画质 = 8 采样 → KERNEL=1（7-tap）。
    if (!Object.prototype.hasOwnProperty.call(combos, 'KERNEL') && /\bKERNEL\b/.test(raw)) {
      combos.KERNEL = 1
    }
    const result = type === 'vert'
      ? transpileVertexShader(withIncludes, { combos, siblingCombos })
      : transpileFragmentShader(withIncludes, { combos, siblingCombos })
    result.code = normalizeD3dPermissivePatterns(result.code)
    return { name, type, ...result }
  }
}

/** 判断资产名是否为文本型（直接内嵌返回 vs 二进制流）。 */
/**
 * WE shader 是 D3D 语义（隐式截断/重载解析宽松），GLSL ES 严格拒绝的常见模式修正
 * （转译后、编译前调用，2026-10-21 芙莉莲 3622495963 实测）：
 * ① rotateVec2(vec4)：shimmer 等把 vec4 varying 直接传给 vec2 形参（D3D 静默截断）→
 *    注入 vec4 重载（GLSL 按参数类型重载，两种调用点都合法）；
 * ② vec3 x = texture(...)：D3D 隐式 vec4→vec3 截断 → 追加 .rgb；
 * ③ Simple_Audio_Bars 的 uint/%：float % int 在 ES 非法 → mod() 重写；
 *    float * const int 在 ES 无隐式转换 → float() 包裹。
 */
function normalizeD3dPermissivePatterns(code) {
  // ① rotateVec2 的 vec4 重载（有定义、无重载时注入）
  if (/vec2\s+rotateVec2\s*\(\s*vec2/.test(code) && !/rotateVec2\s*\(\s*vec4/.test(code)) {
    code = code.replace(
      /(vec2\s+rotateVec2\s*\(\s*vec2[^{]*\{[^}]*\})/,
      '$1\nvec2 rotateVec2(vec4 v, float r) { return rotateVec2(v.xy, r); }',
    )
  }
  // ② vec2/vec3 声明直接接 texture() 的截断赋值（caustics 的 `vec2 x = texture(...)` 实测）
  code = code.replace(/(vec[23]\s+\w+\s*=\s*texture\(.*?\))\s*;/g, '$1.rgb;')
  // ④ 不匹配向量除法：vec2(...) / vec4 uniform（D3D 把 vec2 提升成 vec4 再按分量除、
  //    赋值时又截断回 vec2——GLSL 无隐式维数匹配直接报错）。雪境 3221939295 波浪
  //    `vec2(500.0) / g_Texture0Resolution` 实测 → 右操作数截到 .xy（xy 分量值不变）。
  code = code.replace(
    /(vec2\s*\((?:[^()]|\([^)]*\))*\))\s*(\/)\s*((?:g|u)_\w*Resolution)\b(?!\s*\.)/g,
    '$1 $2 $3.xy',
  )
  // ⑤ float = vec 表达式：D3D 隐式截断取首分量（雪境 lens_flare_sun
  //    `float pointer = g_PointerPosition.xy * u_pointerSpeed` 实测）。
  //    只认「name.swizzle 起头 + 标量运算尾巴」的安全形态（RHS 里若调 length() 等
  //    返回 float 的函数，整体含 .xy 但不能包——调用形态不匹配此正则，天然跳过）。
  code = code.replace(
    /\bfloat\s+(\w+)\s*=\s*(\w+\s*\.\s*(?:xy|xz|yz|zw|xyz|rgb|rgba))\s*((?:[*/+\-]\s*[\w.]+)*?)\s*;/g,
    (m0, name, vecPart, ops) => 'float ' + name + ' = (' + vecPart + (ops ? ' ' + ops.trim() : '') + ').x;',
  )
  // ③ AudioBars 的 uint/取模习惯写法（仅命中该特征时；两个工坊版本：
  //    旧版 `(barFreq1 + 1.0)`、新版 `(barFreq1 + 1)`——正则兼容两者）
  if (/uint\s+barFreq1/.test(code)) {
    code = code
      .replace(/float\s+frequency\s*=\s*shapeCoord\.x\s*\*\s*RESOLUTION\s*;/,
        'float frequency = shapeCoord.x * float(RESOLUTION);')
      .replace(/uint\s+barFreq1\s*=\s*frequency\s*%\s*RESOLUTION\s*;/,
        'uint barFreq1 = uint(mod(frequency, float(RESOLUTION)));')
      .replace(/uint\s+barFreq2\s*=\s*\(barFreq1\s*\+\s*1(?:\.0)?\)\s*%\s*RESOLUTION\s*;/,
        'uint barFreq2 = uint(mod(float(barFreq1) + 1.0, float(RESOLUTION)));')
  }
  // ⑩ float 声明 = int(...) 表达式（D3D int→float 隐式转换；AudioBars
  //    `float bar = int( smoothstep(...) )` 实测——GLSL ES 报 cannot convert）。
  //    ⚠️ 整个声明区间必须一起替换：replace 回调只能换掉 match 本身，
  //    若只重写前缀会留下 `...))` 残源（2026-10-30 实证）。
  {
    const re10 = /\bfloat\s+(\w+)\s*=\s*int\(/g
    let out = ''
    let last = 0
    let m10
    while ((m10 = re10.exec(code))) {
      const open = m10.index + m10[0].length - 1
      const close = matchParen(code, open)
      if (close < 0) continue
      out += code.slice(last, m10.index) + `float ${m10[1]} = float(int(${code.slice(open + 1, close)}));`
      last = close + 1
    }
    if (last) code = out + code.slice(last)
  }
  // ⑥ g_AudioSpectrum* 双重下标（鸣潮 3615984066 audio-ring 实测）：工坊着色器按 WE 引擎
  //    的 vec4[N/4] 打包语义写 X[barID/4][barID%4]——GLSL 对 float[N] 声明直接编译失败
  //    （% 也非法）。引擎实际按连续 float 上传 → 线性下标 = (e1*4+e2) ≡ barID。
  //    ⚠️ e1 可能已被核心转译包上 int()（float 下标 int 化）→ 先 float() 回来再乘，
  //    否则 int * float 在 ES 又是编译错误。
  code = code.replace(
    /(g_AudioSpectrum\w*)\[([^\[\]]+)\]\[([^\[\]]+)\]/g,
    (m0, name, e1, e2) => {
      const fixMod = (expr) => expr.replace(/([\w.]+)\s*%\s*([\w.]+)/g, 'mod($1, float($2))')
      return `${name}[int(float(${fixMod(e1)}) * 4.0 + float(${fixMod(e2)}))]`
    },
  )
  // ⑦ mix 实参维数不匹配（鸣潮 3615984066 video.frag 实测：
  //    `vec4(mix(u_userNewColor(vec3), col(vec4), step), 1.0)`）——D3D 对内建函数实参做
  //    隐式升维（小→大，补 1.0），构造器按「组件扁平化」取前 N 个（多余实参忽略）；
  //    GLSL 对 mix(vec3,vec4,·) 与 vec4(vec4,float) 都直接编译失败。
  //    等价改写：小维数实参包 vecN(x,1.0)；内层已是 vecN 的构造器剥掉
  //    （扁平化取前 N ≡ 自身，尾参被截掉）。
  code = fixMixDimMismatch(code)
  code = flattenVecConstructor(code)
  // ⑧ return 隐式截断（D3D 允许 vec4 → 声明返回 vec3 的函数静默截前 3 分量，
  //    GLSL 报 return type mismatch）：video.frag `vec3 drawSence() { vec4 col …; return col; }`
  code = fixReturnTruncation(code)
  // ⑨ 声明赋值维数截断（鸣潮 3615984066 caustics 实测）：`vec2 causticsCoords = v_TexCoord;`
  //    （v_TexCoord 是 vec4）——D3D 静默截前 N 分量，GLSL 报 '=' dimension mismatch。
  {
    const dims = new Map()
    for (const m of code.matchAll(/\bvec([234])\s+(\w+)\s*(?==|;|,|\))/g)) {
      if (!dims.has(m[2])) dims.set(m[2], Number(m[1]))
    }
    code = code.replace(/\bvec([234])\s+(\w+)\s*=\s*(\w+)\s*;/g, (m0, dn, name, rhs) => {
      const dd = Number(dn)
      const dr = dims.get(rhs)
      return dr && dr > dd ? `vec${dd} ${name} = ${rhs}${'.xyzw'.slice(0, dd + 1)};` : m0
    })
  }
  return code
}

/** 找 code 中 startIdx 处 openChar 的匹配 closeChar 下标（括号计数，忽略字符串/注释——着色器代码场景足够）。 */
const matchBracket = (code, startIdx, openChar = '(', closeChar = ')') => {
  let depth = 0
  for (let i = startIdx; i < code.length; i++) {
    const c = code[i]
    if (c === openChar) depth++
    else if (c === closeChar) { depth--; if (depth === 0) return i }
  }
  return -1
}

const matchParen = (code, startIdx) => matchBracket(code, startIdx, '(', ')')

/** 把 open..close 区间按顶层逗号拆成实参下标段。 */
const splitArgs = (code, openIdx, closeIdx) => {
  const spans = []
  let depth = 0
  let start = openIdx + 1
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const c = code[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) { spans.push([start, i]); start = i + 1 }
  }
  spans.push([start, closeIdx])
  return spans
}

const argText = (code, span) => code.slice(span[0], span[1]).trim()

/** 规则⑦a：mix(vecN, vecM, ·) 实参升维（D3D 语义：小→大，补 1.0；收集 vec 声明做类型推断）。 */
const fixMixDimMismatch = (code) => {
  const dims = new Map()
  for (const m of code.matchAll(/\bvec([234])\s+(\w+)\s*(?==|;|,|\))/g)) {
    if (!dims.has(m[2])) dims.set(m[2], Number(m[1]))
  }
  let changed = true
  while (changed) {
    changed = false
    for (let i = code.indexOf('mix('); i !== -1; i = code.indexOf('mix(', i + 1)) {
      if (i > 0 && /\w/.test(code[i - 1])) continue // wfMix 之类标识符的一部分
      const open = i + 3
      const close = matchParen(code, open)
      if (close === -1) break
      const spans = splitArgs(code, open, close)
      if (spans.length < 2) continue
      const a0 = argText(code, spans[0])
      const a1 = argText(code, spans[1])
      const d0 = dims.get(a0)
      const d1 = dims.get(a1)
      if (!d0 || !d1 || d0 === d1) continue
      const smallSpan = d0 < d1 ? spans[0] : spans[1]
      const bigDim = Math.max(d0, d1)
      const [s, e] = smallSpan
      const replacement = `vec${bigDim}(${code.slice(s, e)}, 1.0)`
      code = code.slice(0, s) + replacement + code.slice(e)
      changed = true
      break // 重扫（下标已偏移）
    }
  }
  return code
}

/** 规则⑦b：`vecN(mix(...), 尾参…)` —— 内层 mix 升维后已是 vecN，扁平化语义取前 N ≡ 内层自身 → 剥构造器。
 *  内层仍是 vecM<N>（如 vec4(vec3,1.0)）时是合法 GLSL，不动。 */
const flattenVecConstructor = (code) => {
  const dims = new Map()
  for (const m of code.matchAll(/\bvec([234])\s+(\w+)\s*(?==|;|,|\))/g)) {
    if (!dims.has(m[2])) dims.set(m[2], Number(m[1]))
  }
  for (let i = code.indexOf('vec'); i !== -1; ) {
    const ctor = code.slice(i).match(/^vec([234])\s*\(/)
    if (!ctor) { i = code.indexOf('vec', i + 1); continue }
    const n = Number(ctor[1])
    const open = i + ctor[0].length - 1
    const close = matchParen(code, open)
    if (close === -1) break
    const spans = splitArgs(code, open, close)
    if (spans.length >= 2 && /^mix\s*\(/.test(argText(code, spans[0]))) {
      const mixText = argText(code, spans[0])
      const mixOpen = i + ctor[0].length + mixText.indexOf('(')
      const mixClose = matchParen(code, mixOpen)
      const mixSpans = splitArgs(code, mixOpen, mixClose)
      const ds = mixSpans.slice(0, 2).map((sp) => dims.get(argText(code, sp)) ?? 0)
      const resultDim = Math.max(...ds)
      if (resultDim === n) {
        code = code.slice(0, i) + mixText + code.slice(close + 1)
        i = code.indexOf('vec', i + mixText.length)
        continue
      }
    }
    i = code.indexOf('vec', close + 1)
  }
  return code
}

/** 规则⑧：函数体内 `return <高维变量>;` 截断到声明返回维数（`return col;` → `return col.rgb;`）。
 *  逐函数扫描（头 `vecN name(..) {` 可能与 { 跨行）→ 函数体区间内重写 return。 */
const fixReturnTruncation = (code) => {
  const dims = new Map()
  for (const m of code.matchAll(/\bvec([234])\s+(\w+)\s*(?==|;|,|\))/g)) {
    if (!dims.has(m[2])) dims.set(m[2], Number(m[1]))
  }
  let out = ''
  let rest = code
  for (;;) {
    const head = rest.match(/\bvec([234])\s+\w+\s*\([^)]*\)\s*\{/)
    if (!head) { out += rest; break }
    const n = Number(head[1])
    const bodyOpen = head.index + head[0].length - 1
    const bodyClose = matchBracket(rest, bodyOpen, '{', '}')
    if (bodyClose === -1) { out += rest; break }
    const body = rest.slice(bodyOpen, bodyClose + 1)
    const fixed = body.replace(/return\s+(\w+)\s*;/g, (m0, id) => {
      const d = dims.get(id) ?? 0
      return d > n ? `return ${id}${'.xyzw'.slice(0, n + 1)};` : m0
    })
    if (fixed !== body) console.error("[RetFix] n=" + n + " body head=" + JSON.stringify(rest.slice(0, bodyOpen).slice(-60)) + " fixedReturn=" + /return col/.test(fixed))
    out += rest.slice(0, bodyOpen) + (fixed === body ? rest.slice(bodyOpen, bodyClose + 1) : fixed)
    rest = rest.slice(bodyClose + 1)
  }
  return out
}

export const isTextAsset = (name) => JSON_ASSET_RE.test(name)

// 属性绑定拆包：WE 场景属性可为字符串，也可为 {user,value}/{script,value}
// 绑定对象（用户属性/脚本驱动，value 是编辑器快照）。静态回退取 value。
const unwrapBinding = (text) =>
  text && typeof text === 'object' && typeof text.value === 'string' ? text.value : text

export const parseVec3 = (text, fallback = [0, 0, 0]) => {
  const raw = unwrapBinding(text)
  if (typeof raw !== 'string') return fallback
  const parts = raw.trim().split(/\s+/).map(Number)
  if (parts.length < 3 || parts.some((v) => !Number.isFinite(v))) return fallback
  return parts
}

export const parseVec2 = (text, fallback = [0, 0]) => {
  const raw = unwrapBinding(text)
  if (typeof raw !== 'string') return fallback
  const parts = raw.trim().split(/\s+/).map(Number)
  if (parts.length < 2 || parts.some((v) => !Number.isFinite(v))) return fallback
  return parts
}

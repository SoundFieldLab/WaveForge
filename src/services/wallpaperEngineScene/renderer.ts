/**
 * Wallpaper Engine 场景 WebGL2 实时渲染器（v1）
 *
 * 覆盖范围：2D 图层合成（材质多 pass）、正交相机、g_Time 驱动的着色器动画
 * （UV 滚动/闪烁等）、DXT1/3/5 + BC7 压缩纹理（WebGL2 扩展）、RGBA8888/R8/RG88。
 * 不支持：粒子系统、.mdl 3D 网格、效果链 FBO 后处理（清单里标 unsupported，回退静态图）。
 *
 * 着色器契约（与 wallpaper-engine-scene.mjs 转译器对应）：
 * - HLSL mul(v, M) 已转成 GLSL v * M，等价于数学上的 Mᵀ·v → 上传矩阵需先转置
 * - uniform 元数据 {"material":"..."} 绑定材质常量；g_* 引擎 uniform 由渲染器供值
 */

import type { SceneLight, SceneManifest, SceneObject, ScenePass, SceneTextureInfo } from './types'
import { parsePuppetMdl, PuppetPose, type PuppetModel } from './puppetMdl'
import { parseModelMdl, type ParsedModelMesh } from './modelMdl'
import { ParticleSystem, type ParticleTexture } from './particles'
import { loadWallpaperEngineUserProps } from '../wallpaperEngineUserProperties'

// 本地后端地址；调试页可用 ?server= 覆盖（如指向另起的测试实例端口），
// ?server=same 走同源相对路径（配 vite dev proxy 用）。
const SCENE_SERVER_PARAM = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('server')
  : null
const BASE_SERVER = SCENE_SERVER_PARAM === 'same'
  ? ''
  : (SCENE_SERVER_PARAM || 'http://localhost:3001')

/** 全屏效果 pass 的 MVP：[-0.5,0.5] quad 顶点 → [-1,1] clip */
const FULL_SCREEN_MVP = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])

/** 效果纹理投影矩阵兜底（WE 引擎 uniform，g_EffectTextureProjectionMatrix[Inverse]）：
 *  无值时全 0 → depthparallax 等 shader 里 CAST3X3(rot) 后 normalize(0)=NaN → 采样塌缩成纯色 */
const EFFECT_TEX_PROJECTION = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * 装饰效果黑名单：转译产物输出错误/未验证的效果 shader，效果链中跳过这些 pass
 * 只画基底。名单来自实机对照——shine/pulse/twirl/auto_sway/下划线工坊水波已于
 * 2026-10-23 放行（暗影根因 = shine_combine g_Texture1 缺链输入绑定 + gaussian KERNEL
 * combo 缺省全灭，均已修）；depthparallax 已于 2026-10-29 放行（雪境 3669680904 背景
 * 实证：combo 推导改元数据驱动后 MASK 不再被深度图槽误触发，视差通路走既有 FBO 链）。
 * ⚠️ 用黑名单而非白名单：虹夏彩带 blur_precise 等长链的效果链长改变会引发几何状态回归
 * （2026-10-22 白名单制实证），未验证前维持 v2 行为。当前黑名单为空——保留机制本身，
 * 未来发现新的伪影效果时往这里加。
 */
const EFFECT_SHADER_BLOCKLIST: RegExp | null = null

/**
 * puppet「图集正放」例外表（对象名匹配）：这类资产的图集部件在 PNG 里正立摆放
 * （顶点 y 大端 = 图顶），直接取反会倒立（2026-10-22 铃芽「人物」实证）。
 * 芙莉莲晾衣绳 chibi（3622495963，对象名 '1'~'5'、'6 伊芙琳'、'7矮人'、
 * '8 战士'、'9 花'）同病，2026-10-22 用户实证后加入。
 * TODO：倒放/正放无法从 mdl 数据可靠判别（UV-y 相关性两资产相同），
 * 待接入更多工坊资产后找自动判据或改为 per-asset 配置下发。
 */
const PUPPET_UPRIGHT_EXCEPTIONS = new Set([
  '人物',
  '脸',
  'girlbody',
  'boysamurai',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6 伊芙琳',
  '7矮人',
  '8 战士',
  '9 花',
  'rw',
])

/**
 * puppet 输出姿态的 per-asset 校正（倒放/旋转无法从 mdl 数据可靠判别，实证硬编码）：
 * - flip：蒙皮 y 取反（图集摆放方向因作者而异）
 * - rot：整体顺时针旋转角度（度）。虹夏 3650475846 的衣/头发 puppet 输出横躺 90°
 *   （背景 quad 全对、仅 puppet 对象横躺 → mdl 骨骼空间与场景空间差 90°，
 *   2026-10-23 实证：顺时针 90° 后人物正立，头在上、衣纵贯、转经筒回身侧）
 * - 2026-10-23 二次标定（对官方 preview 逐部位比对）：衣 raw=横躺头朝右（rot:90 转正），
 *   头发 raw 头部本就正立（rot:0）但锚点是按未旋转父链算的 → 需要 anchor 平移挂钩到
 *   衣 rot:90 后的领口位置；两层 raw 比例也不同（衣 head/body 与头发 head 不同基）。
 *   scale=0.462 由官方头部宽 484 世界单位反推（0.55×484/576）。
 * - anchor：世界单位锚点偏移（加在 worldMatrix 平移分量上）
 */
const PUPPET_POSE_OVERRIDES = new Map<string, { flip: number; rot: number; scale?: number; anchor?: [number, number] }>([
  ['衣', { flip: 1, rot: 0, scale: 0.69, anchor: [-151, -150] }],
  ['头发', { flip: 1, rot: 0, scale: 0.82, anchor: [154, -14] }],
])

interface UploadedTexture {
  texture: WebGLTexture
  width: number
  height: number
  /** 视频纹理（WE 支持材质直接引用 MP4/WebM，千咲带水印.tex 实测）：每帧 texImage2D 刷新 */
  video?: HTMLVideoElement
}

/** puppet 对象运行时状态（VAO 双缓冲：pos 动态 + uv 静态） */
interface PuppetState {
  model: PuppetModel
  pose: PuppetPose
  /** 蒙皮输出（puppet 局部空间，平铺 xyz） */
  skinned: Float32Array
  /** 映射到场景世界空间后的顶点（上传 GPU） */
  worldPositions: Float32Array
  vao: WebGLVertexArrayObject
  posVbo: WebGLBuffer
  uvVbo: WebGLBuffer
  ebo: WebGLBuffer
  indexCount: number
  /** size 缺省时的显示尺寸（mdl bounds） */
  sizeFallback: [number, number]
}

interface CompiledPass {
  program: WebGLProgram
  uniformLocations: Map<string, WebGLUniformLocation | null>
  attributeLocations: { position: number; texCoord: number }
  uniformMetas: ScenePass['uniforms']
}

const DEG2RAD = Math.PI / 180

// 列主序 4x4 矩阵工具（数学约定：v' = M * v）
function mat4Identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]
      out[col * 4 + row] = sum
    }
  }
  return out
}

function mat4Ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Float32Array {
  const m = mat4Identity()
  m[0] = 2 / (right - left)
  m[5] = 2 / (top - bottom)
  m[10] = -2 / (far - near)
  m[12] = -(right + left) / (right - left)
  m[13] = -(top + bottom) / (top - bottom)
  m[14] = -(far + near) / (far - near)
  return m
}

/** 透视投影（列主序，与文件内其他 mat4 约定一致）；fov 单位度，aspect = 宽/高 */
function mat4Perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovDeg * DEG2RAD) / 2)
  const nf = 1 / (near - far)
  const m = mat4Identity()
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) * nf
  m[11] = -1
  m[14] = 2 * far * near * nf
  return m
}

function mat4RotateX(rad: number): Float32Array {
  const m = mat4Identity()
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  m[5] = c; m[6] = s
  m[9] = -s; m[10] = c
  return m
}

function mat4RotateY(rad: number): Float32Array {
  const m = mat4Identity()
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  m[0] = c; m[2] = -s
  m[8] = s; m[10] = c
  return m
}

function mat4LookAt(eye: number[], center: number[], up: number[]): Float32Array {  let [zx, zy, zz] = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]
  const zLen = Math.hypot(zx, zy, zz) || 1
  zx /= zLen; zy /= zLen; zz /= zLen
  let [xx, xy, xz] = [up[1] * zz - up[2] * zy, up[2] * zx - up[0] * zz, up[0] * zy - up[1] * zx]
  const xLen = Math.hypot(xx, xy, xz) || 1
  xx /= xLen; xy /= xLen; xz /= xLen
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  // 视图矩阵 = 旋转的转置 * 平移
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ])
}

function mat4Translate(x: number, y: number, z: number): Float32Array {
  const m = mat4Identity()
  m[12] = x; m[13] = y; m[14] = z
  return m
}

function mat4Scale(x: number, y: number, z: number): Float32Array {
  const m = mat4Identity()
  m[0] = x; m[5] = y; m[10] = z
  return m
}

function mat4RotateZ(rad: number): Float32Array {
  const c = Math.cos(rad), s = Math.sin(rad)
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

/** 着色器侧 mul(v, M) 等价 Mᵀ·v → 上传前转置（列主序 → 行主序字面翻转） */
function mat4TransposedForUpload(m: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out[r * 4 + c] = m[c * 4 + r]
  }
  return out
}

export class WallpaperEngineSceneRenderer {
  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private manifest: SceneManifest | null = null
  private quadVao: WebGLVertexArrayObject | null = null
  /** v 翻转 UV 的全屏 quad（puppet 效果链专用，见 initQuad 注释） */
  private flipQuadVao: WebGLVertexArrayObject | null = null
  private meshVaoCache = new Map<SceneObject, { vao: WebGLVertexArrayObject; indexCount: number; indexType?: number } | null>()
  private textureCache = new Map<string, UploadedTexture | null>()
  /** 视频纹理清单（renderFrame 每帧刷新） */
  private liveVideos: UploadedTexture[] = []
  private programCache = new Map<ScenePass, CompiledPass | null>()
  private whiteTexture: WebGLTexture | null = null
  /** 调试开关（probe ?debugtex=1）：每帧打印首贴图绑定情况 */
  debugTextures = false
  /** 调试开关（probe ?debugdraw=1）：第 60 帧打印每个对象每个 pass 的绘制要素 */
  debugDraw = false
  /** 调试覆盖（probe ?maxchain=N）：长装饰链降级阈值（默认 8；N=999 关闭降级观察完整链） */
  chainLimit: number | null = null
  private frameIndex = 0
  private startTime = performance.now()
  private rafId = 0
  private disposed = false
  /** 冻结渲染循环（桌面模式被其它模式遮挡时）：资源全保留，恢复后时间继续流（不重播） */
  private paused = false
  /** 当前场景相机位置（generic 等标准材质的 g_EyePosition / 灯光布光基准） */
  private cameraEye: number[] = [0, 0, 0]
  /** mesh 自动取景缓存（key = manifest 引用，load 换场景后自动失效） */
  private meshFocus: { center: [number, number, number]; radius: number } | null = null
  private meshFocusKey: SceneManifest | null = null
  /** 当前场景光源（scene.json 的 light 对象，render() 每帧收集） */
  private sceneLights: SceneLight[] = []
  /** 视口世界尺寸（cover 适配后；composelayer size 缺省层的 quad 尺寸） */
  private viewportWorldSize: [number, number] = [1, 1]
  /** 对象内效果链的离屏 ping-pong 缓冲（工坊 pkg 场景的 waterwaves 等多 pass 效果必需） */
  private effectFbo: { fbs: WebGLFramebuffer[]; texs: WebGLTexture[]; width: number; height: number } | null = null
  /** 链首输入快照（bind "previous" 槽采样用），与 effectFbo 同生命周期 */
  private chainInputSnapshot: { fbo: WebGLFramebuffer; tex: WebGLTexture; width: number; height: number } | null = null
  /** composelayer 帧缓冲快照纹理（每个组合层对象一份；绘制到它时拷贝当前帧缓冲） */
  private composeSnapshots = new Map<SceneObject, { tex: WebGLTexture; fbo: WebGLFramebuffer }>()
  private composeSnapshotSize: { width: number; height: number } | null = null
  /**
   * 主渲染目标（引擎 _rt_FullFrameBuffer 的等价物）：整帧先画进这块离屏 RGBA8
   * FBO，末尾用 present quad 翻转上屏。blend/composelayer 的帧快照从这里 blit。
   * ⚠️ 不能从默认帧缓冲 copyTexImage2D：ANGLE/D3D 下同帧早前绘制的内容读不到
   * （快照恒为 clearColor，Girl and Samurai 雨/godrays 灰罩屏实证 2026-10-29），
   * 且离屏 RT 自带真 alpha 通道（引擎 blend 语义 out.a = screen.a 的前提）。
   */
  private masterFbo: { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer | null; width: number; height: number } | null = null
  /** present 着色器（masterFbo → 默认帧缓冲，v 翻转；惰性编译） */
  private presentProgram: WebGLProgram | null = null
  private presentVao: WebGLVertexArrayObject | null = null
  /** 音频响应频谱（64 bins 0..1 响度；spectrumBus 每帧推送；null=无音频） */
  private audioSpectrum: Float32Array | null = null
  /** g_Audio16/32/64/96 分段缓存（Float32Array 复用，避免每帧分配） */
  private audioBandsCache = new Map<number, Float32Array>()
  /** puppet（剪纸骨骼动画）运行时状态：动态位置 VBO + CPU 蒙皮 */
  private puppetStates = new Map<SceneObject, PuppetState>()
  /** .mdl 模型几何（loadModels 拉取解析；manifest 只带 model.file 引用不内联几何） */
  private modelMeshes = new Map<SceneObject, ParsedModelMesh>()
  /** 粒子系统运行时：每对象 [系统, 纹理] 列表（系统=主系统+children 一层） */
  private particleStates = new Map<SceneObject, { system: ParticleSystem; texture: ParticleTexture | null }[]>()
  /** 粒子 instanced 着色器（惰性编译） */
  private particleProgram: WebGLProgram | null = null
  /** 上一帧时间戳（puppet 层时间积分） */
  private lastFrameTime = performance.now()
  /** 帧率上限（0=不限；frameLoop 按间隔跳帧，时间仍随墙钟流，动画语义不变） */
  private fpsLimit = 0
  private lastRenderAt = 0
  /** 音频响应开关：false 时丢弃频谱推送（g_Audio* uniform 恒零） */
  private audioReactiveEnabled = true
  /** 鼠标视差开关：false 时忽略输入并回中（视差层回静止位） */
  private parallaxEnabled = true
  private lastError: string | null = null

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl
  }

  static isSupported(): boolean {
    try {
      const test = document.createElement('canvas')
      return Boolean(test.getContext('webgl2'))
    } catch {
      return false
    }
  }

  async load(wallpaperId: string): Promise<void> {
    // 透传调试属性覆盖（探针 ?prop.<name>=<value>）→ manifest 求值用户属性时生效；
    // 再叠加设置弹窗保存的用户属性覆盖（localStorage，同名时弹窗值优先）。
    // 注意：属性烤进 manifest 材质常量 → legacy 改属性需重挂生效（WWGL 主链才是热更）。
    const extraParams = new URLSearchParams()
    if (typeof window !== 'undefined') {
      for (const [k, v] of new URLSearchParams(window.location.search)) {
        if (k.startsWith('prop.')) extraParams.set(k, v)
      }
    }
    for (const [name, value] of Object.entries(loadWallpaperEngineUserProps(wallpaperId))) {
      extraParams.set(`prop.${name}`, String(value))
    }
    const extra = extraParams.toString()
    const response = await fetch(
      `${BASE_SERVER}/api/wallpaper-engine/scene/manifest?id=${encodeURIComponent(wallpaperId)}${extra ? '&' + extra : ''}`,
      { cache: 'no-store' },
    )
    const data = await response.json()
    if (!data.success) throw new Error(data.message || '场景清单获取失败')
    this.manifest = data as SceneManifest
    // nullchain 安全场景默认放行链首 tex0=null 全屏后处理（服务端逐场景实证白名单，
    // 见 SceneManifest.nullChainSafe 注释）；探针 ?nullchain=0/1 在 load() 后可覆盖
    if ((this.manifest as SceneManifest).nullChainSafe) this.nullChainEnabled = true
    await this.hydrateShaderSources(wallpaperId)
  }

  /**
   * 着色器源码水合：manifest 的 pass 只带 shaderRef（全文内联会让太阳系 847 对象的
   * manifest 超 V8 字符串上限 500），按场景批量拉回后回填 pass.vert/frag。
   * 拉取失败时把无源码的 pass 标 error（渲染端按既有机制跳过该 pass 继续画）。
   */
  private async hydrateShaderSources(wallpaperId: string): Promise<void> {
    const manifest = this.manifest
    if (!manifest) return
    const refs = new Set<string>()
    for (const obj of manifest.objects) {
      for (const pass of obj.passes || []) {
        if (!pass.error && pass.shaderRef) refs.add(pass.shaderRef)
      }
    }
    if (refs.size === 0) return
    let shaders: Record<string, { vert: string; frag: string }> | null = null
    try {
      const response = await fetch(
        `${BASE_SERVER}/api/wallpaper-engine/scene/shaders?id=${encodeURIComponent(wallpaperId)}`,
        { cache: 'no-store' },
      )
      const data = await response.json()
      if (!data.success || !data.shaders) throw new Error(data.message || '着色器源码获取失败')
      shaders = data.shaders
    } catch (error) {
      console.warn('[WEScene] 着色器源码批量拉取失败:', error)
    }
    for (const obj of manifest.objects) {
      for (const pass of obj.passes || []) {
        if (pass.error || !pass.shaderRef) continue
        const src = shaders?.[pass.shaderRef]
        if (src) {
          pass.vert = src.vert
          pass.frag = src.frag
        } else {
          pass.error = '着色器源码缺失: ' + pass.shaderRef.slice(0, 12)
        }
      }
    }
  }

  /** 返回清单里至少一个可渲染对象（决定前端是否走实时渲染） */
  hasRenderableObjects(): boolean {
    return Boolean(this.manifest?.objects.some((obj) => obj.passes.some((pass) => !pass.error) || obj.particle || obj.puppet || obj.text))
  }

  /** 鼠标归一化位置（0..1，供 g_ParallaxPosition 等视差类效果；默认居中） */
  private pointerPos: [number, number] = [0.5, 0.5]
  private pointerBound = false

  /** 监听鼠标（视差/光晕跟随类效果的输入）；renderLoop 里惰性绑定一次 */
  private bindPointer(): void {
    if (this.pointerBound) return
    this.pointerBound = true
    window.addEventListener('pointermove', (e) => {
      if (!this.parallaxEnabled) return
      const rect = this.canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      this.pointerPos = [
        Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      ]
    }, { passive: true })
  }

  start(): void {
    this.initQuad()
    this.initWhiteTexture()
    this.bindPointer()
    this.rafId = requestAnimationFrame(this.frameLoop)
  }

  /**
   * 冻结/恢复渲染循环（不销毁资源）：桌面模式被切走（suspended）时调用，
   * 被冻结层下的 WebGL 循环纯属浪费算力；恢复后 time = performance.now() - startTime
   * 随墙钟继续流——shader 动画快进到当前时刻而非重播入场动画，puppet 层 dt 有
   * Math.min(0.1) 钳制不会跳变，与真实 Wallpaper Engine「时间继续流动」语义一致。
   */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return
    this.paused = paused
    if (paused) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId)
        this.rafId = 0
      }
    } else {
      // 重置上一帧时间戳：长时间冻结后恢复的首帧 dt 不受钳制前会是一段大间隔
      this.lastFrameTime = performance.now()
      // 帧率节流计时也归零：恢复后首帧立即渲染
      this.lastRenderAt = 0
      this.rafId = requestAnimationFrame(this.frameLoop)
    }
  }

  /** 帧率上限（0 = 不限）；下一帧生效，时间仍随墙钟流、动画语义不变 */
  setFpsLimit(fps: number): void {
    this.fpsLimit = Number.isFinite(fps) && fps > 0 ? fps : 0
  }

  /** 鼠标视差开关：关闭时忽略指针输入并回中（视差层回到静止位） */
  setParallaxEnabled(enabled: boolean): void {
    this.parallaxEnabled = Boolean(enabled)
    if (!this.parallaxEnabled) this.pointerPos = [0.5, 0.5]
  }

  /** 音频响应开关：关闭后丢弃后续频谱推送（g_Audio* 恒零，WE 静置语义） */
  setAudioReactive(enabled: boolean): void {
    this.audioReactiveEnabled = Boolean(enabled)
    if (!this.audioReactiveEnabled) this.audioSpectrum = null
  }

  /** rAF 帧循环成员：paused 时不再排下一帧，由 setPaused(false) 重启；fpsLimit>0 时跳帧节流 */
  private frameLoop = (): void => {
    if (this.disposed || this.paused) return
    const now = performance.now()
    const interval = this.fpsLimit > 0 ? 1000 / this.fpsLimit : 0
    if (interval > 0 && now - this.lastRenderAt < interval - 1) {
      // 未到目标帧间隔：跳过本帧（shader 时间用墙钟差，不丢时间只丢渲染）
      this.rafId = requestAnimationFrame(this.frameLoop)
      return
    }
    this.lastRenderAt = now
    this.renderFrame()
    this.rafId = requestAnimationFrame(this.frameLoop)
  }

  stop(): void {
    this.disposed = true
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.destroyEffectFbo()
    this.destroyComposeSnapshots()
    this.destroyNullChainRegions()
    this.destroyMasterFbo()
    if (this.presentVao) { this.gl.deleteVertexArray(this.presentVao); this.presentVao = null }
    if (this.presentProgram) { this.gl.deleteProgram(this.presentProgram); this.presentProgram = null }
    if (this.chainBlitProgram) { this.gl.deleteProgram(this.chainBlitProgram); this.chainBlitProgram = null }
    for (const runtimes of this.particleStates.values()) {
      for (const runtime of runtimes) runtime.system.dispose()
    }
    this.particleStates.clear()
  }

  /** 效果链离屏 ping-pong 缓冲（惰性创建、尺寸变化重建） */
  private ensureEffectFbo(width: number, height: number): { fbs: WebGLFramebuffer[]; texs: WebGLTexture[]; width: number; height: number } | null {
    const gl = this.gl
    if (this.effectFbo && this.effectFbo.width === width && this.effectFbo.height === height) return this.effectFbo
    this.destroyEffectFbo()
    const fbs: WebGLFramebuffer[] = []
    const texs: WebGLTexture[] = []
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()
      if (!tex) return null
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      const fb = gl.createFramebuffer()
      if (!fb) return null
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      fbs.push(fb)
      texs.push(tex)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.effectFbo = { fbs, texs, width, height }
    return this.effectFbo
  }

  private destroyEffectFbo(): void {
    if (!this.effectFbo) return
    for (const fb of this.effectFbo.fbs) this.gl.deleteFramebuffer(fb)
    for (const tex of this.effectFbo.texs) this.gl.deleteTexture(tex)
    this.effectFbo = null
    // 链首输入快照与 ping-pong 缓冲同生命周期（尺寸/销毁跟随）
    if (this.chainInputSnapshot) {
      this.gl.deleteFramebuffer(this.chainInputSnapshot.fbo)
      this.gl.deleteTexture(this.chainInputSnapshot.tex)
      this.chainInputSnapshot = null
    }
  }

  /**
   * 链首输入快照（bind "previous" 语义）：效果链的第一个 pass 执行前把链 FBO（=基础
   * pass 输出）blit 到这里，供 combine 类 pass 的 previous 槽采样。线性 ping-pong 链中
   * 「当前读缓冲」= 上一 pass 输出，而 previous = 进入整个效果前的图（shine_combine
   * tex1 / blur_combine tex2 / blurprecise pass1 tex1 实证）——两者混用会让
   * blur_combine 变成「模糊图自合成」→ 全屏涂抹（Girl and Samurai 3618986965 实证）。
   */
  private ensureChainInputSnapshot(width: number, height: number): { fbo: WebGLFramebuffer; tex: WebGLTexture; width: number; height: number } | null {
    const gl = this.gl
    if (this.chainInputSnapshot && this.chainInputSnapshot.width === width && this.chainInputSnapshot.height === height) {
      return this.chainInputSnapshot
    }
    if (this.chainInputSnapshot) {
      gl.deleteFramebuffer(this.chainInputSnapshot.fbo)
      gl.deleteTexture(this.chainInputSnapshot.tex)
      this.chainInputSnapshot = null
    }
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.chainInputSnapshot = { fbo, tex, width, height }
    return this.chainInputSnapshot
  }

  /**
   * composelayer 帧缓冲快照：把当前默认帧缓冲拷进纹理（每个组合层对象一份、每帧刷新）。
   * WE 语义 = "_rt_FullFrameBuffer"（到此对象为止的合成画面）；copyTexImage2D 时必须
   * 绑定默认帧缓冲（调用方保证）。尺寸变化时重建。
   */
  private captureComposeSnapshot(object: SceneObject, width: number, height: number): WebGLTexture | null {
    const gl = this.gl
    let entry = this.composeSnapshots.get(object) ?? null
    if (entry && (this.composeSnapshotSize?.width !== width || this.composeSnapshotSize?.height !== height)) {
      gl.deleteTexture(entry.tex)
      gl.deleteFramebuffer(entry.fbo)
      entry = null
      this.composeSnapshots.delete(object)
    }
    if (!entry) {
      const created = gl.createTexture()
      const createdFbo = gl.createFramebuffer()
      if (!created || !createdFbo) return null
      gl.bindTexture(gl.TEXTURE_2D, created)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.bindFramebuffer(gl.FRAMEBUFFER, createdFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, created, 0)
      entry = { tex: created, fbo: createdFbo }
      this.composeSnapshots.set(object, entry)
      this.composeSnapshotSize = { width, height }
    }
    // 从主渲染目标 blit（方向与旧 copyTexImage2D 一致：行 0 = clip 底 = v0）。
    // ⚠️ 不能从默认帧缓冲 copyTexImage2D：ANGLE/D3D 下读不到同帧早前绘制的内容
    // （快照恒为 clearColor；雪境 234、Girl and Samurai rain/godrays 实证 2026-10-29）。
    const master = this.masterFbo
    if (master && master.width === width && master.height === height) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, master.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, entry.fbo)
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.FRAMEBUFFER, master.fbo)
    } else {
      // masterFbo 缺失（理论上不发生）→ 旧 copyTexImage2D 兜底
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 0, 0, width, height, 0)
      gl.getError()
      gl.bindFramebuffer(gl.FRAMEBUFFER, master?.fbo ?? null)
    }
    if (this.debugSnapshotDump && this.debugSnapshotDumpCount < 3) {
      this.debugSnapshotDumpCount += 1
      console.warn('[WEScene][snapdump] frame', this.frameIndex)
      this.dumpSnapshotTexture(object, entry.tex, width, height)
    }
    return entry.tex
  }

  /**
   * 对象级 nullchain 链首输入：帧快照中「对象屏幕矩形区域」的拷贝。
   * WE 语义：对象级效果链（链首 tex0=framebuffer，如雪境 425 opacity/437 blend）的
   * framebuffer 绑定 = 对象区域副本（对象尺寸 RT），shader 用对象局部 UV 0..1 采样
   * （opacity.vert 实证：几何=对象 MVP、v_TexCoord.xy=a_TexCoord）。实现：对象 quad
   * 四角经 MVP → NDC → 快照像素矩形，blit 到独立小纹理（v=0 行=区域顶部，匹配 quad
   * 顶点 v=0 约定）；按对象缓存（尺寸变化重建）。
   */
  private nullChainRegions = new Map<SceneObject, { tex: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number }>()

  private captureNullChainRegion(
    object: SceneObject,
    composeTex: WebGLTexture,
    mvp: Float32Array,
    canvas: HTMLCanvasElement,
  ): UploadedTexture | null {
    void composeTex
    const gl = this.gl
    const snapshot = this.composeSnapshots.get(object)
    if (!snapshot) return null
    // 对象 quad 四角（±0.5）经 MVP（行向量语义：clip_j = Σ v_i·M[i][j]，与
    // mat4TransposedForUpload 上传约定一致）→ NDC → 快照像素（GL 坐标，行 0=底）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]] as const) {
      let clipX = 0, clipY = 0, clipW = 0
      for (let i = 0; i < 4; i++) {
        const vi = i === 0 ? cx : i === 1 ? cy : i === 3 ? 1 : 0
        clipX += vi * mvp[i * 4 + 0]
        clipY += vi * mvp[i * 4 + 1]
        clipW += vi * mvp[i * 4 + 3]
      }
      if (Math.abs(clipW) < 1e-6) return null
      const nx = clipX / clipW, ny = clipY / clipW
      minX = Math.min(minX, nx); maxX = Math.max(maxX, nx)
      minY = Math.min(minY, ny); maxY = Math.max(maxY, ny)
    }
    const W = canvas.width, H = canvas.height
    const x0 = Math.max(0, Math.floor((minX + 1) / 2 * W))
    const x1 = Math.min(W, Math.ceil((maxX + 1) / 2 * W))
    const y0 = Math.max(0, Math.floor((minY + 1) / 2 * H))
    const y1 = Math.min(H, Math.ceil((maxY + 1) / 2 * H))
    const rw = x1 - x0, rh = y1 - y0
    if (rw <= 0 || rh <= 0) return null
    let entry = this.nullChainRegions.get(object)
    if (!entry || entry.width !== rw || entry.height !== rh) {
      if (entry) { gl.deleteTexture(entry.tex); gl.deleteFramebuffer(entry.fbo) }
      const tex = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (!tex || !fbo) return null
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      entry = { tex, fbo, width: rw, height: rh }
      this.nullChainRegions.set(object, entry)
    }
    // 区域 blit（v=0 行 = 区域顶部：dst 翻转 dstY0=rh → dstY1=0，src 底→dst 顶行、
    // src 顶→row 0）。方向实证见 2026-11-02 日志（若上下镜像则交换 src y0/y1）。
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, snapshot.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, entry.fbo)
    gl.blitFramebuffer(x0, y0, x1, y1, 0, rh, rw, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.masterFbo?.fbo ?? null)
    return { texture: entry.tex, width: rw, height: rh }
  }

  private destroyNullChainRegions(): void {
    for (const entry of this.nullChainRegions.values()) {
      this.gl.deleteTexture(entry.tex)
      this.gl.deleteFramebuffer(entry.fbo)
    }
    this.nullChainRegions.clear()
  }

  /** 调试：把快照纹理按网格降采样读回并打日志（v_SnapDump 一次性；验证快照方向/内容用） */
  private debugSnapshotDump = false
  private debugSnapshotDumpCount = 0
  /** 调试：放行链首 tex0=null 的全屏后处理对象（godrays 等；探针 ?nullchain=1） */
  private nullChainEnabled = false
  private dumpSnapshotTexture(object: SceneObject, tex: WebGLTexture, width: number, height: number): void {
    const gl = this.gl
    const fbo = gl.createFramebuffer()
    if (!fbo) return
    const GW = 48
    const GH = 27
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const buf = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      const rows: string[] = []
      for (let gy = 0; gy < GH; gy++) {
        let row = ''
        for (let gx = 0; gx < GW; gx++) {
          // 行序：readPixels 行 0 = 纹理 v=0 行；日志顶部打印 v=1（高 v）行
          const px = Math.min(width - 1, Math.floor(((gx + 0.5) / GW) * width))
          const py = Math.min(height - 1, Math.floor(((GH - 1 - gy + 0.5) / GH) * height))
          const o = (py * width + px) * 4
          const lum = (buf[o] + buf[o + 1] + buf[o + 2]) / 3
          row += lum < 26 ? ' ' : lum < 77 ? '.' : lum < 128 ? '+' : lum < 179 ? '*' : '#'
        }
        rows.push(row)
      }
      console.warn('[WEScene][snapdump] ' + object.name + ' (' + width + 'x' + height + ') 顶行=v1 底行=v0\n' + rows.join('\n'))
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.masterFbo?.fbo ?? null)
      gl.deleteFramebuffer(fbo)
    }
  }

  private destroyComposeSnapshots(): void {
    for (const entry of this.composeSnapshots.values()) {
      this.gl.deleteTexture(entry.tex)
      this.gl.deleteFramebuffer(entry.fbo)
    }
    this.composeSnapshots.clear()
    this.composeSnapshotSize = null
  }

  /** 惰性创建主渲染目标（整帧离屏渲染 + 末尾 present 上屏） */
  private ensureMasterFbo(width: number, height: number): { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer | null; width: number; height: number } | null {
    const gl = this.gl
    if (this.masterFbo && this.masterFbo.width === width && this.masterFbo.height === height) return this.masterFbo
    this.destroyMasterFbo()
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) return null
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    // 深度附件：mesh 场景（demon_core 等）pass 开 depthTest，每帧清深度
    let depth: WebGLRenderbuffer | null = null
    const rb = gl.createRenderbuffer()
    if (rb) {
      depth = rb
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb)
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
    this.masterFbo = { fbo, tex, depth, width, height }
    return this.masterFbo
  }

  private destroyMasterFbo(): void {
    if (!this.masterFbo) return
    this.gl.deleteFramebuffer(this.masterFbo.fbo)
    this.gl.deleteTexture(this.masterFbo.tex)
    if (this.masterFbo.depth) this.gl.deleteRenderbuffer(this.masterFbo.depth)
    this.masterFbo = null
  }

  /** 「屏幕」= 主渲染目标（整帧离屏渲染、末尾 present 上屏）；缺失时退默认帧缓冲 */
  private bindScreenTarget(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.masterFbo ? this.masterFbo.fbo : null)
  }

  /**
   * present：把主渲染目标画到默认帧缓冲。⚠️ 不做 Y 翻转——离屏 FBO 与默认帧缓冲
   * 同为 GL 约定（行 0 = clip 底 = 显示底部），v 直接对应。独立小着色器，
   * 不依赖场景 pass 管线。
   */
  private ensurePresentProgram(): WebGLProgram | null {
    if (this.presentProgram) return this.presentProgram
    const gl = this.gl
    const vs = gl.createShader(gl.VERTEX_SHADER)
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    if (!vs || !fs) return null
    gl.shaderSource(vs, '#version 300 es\nprecision highp float;\nconst vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));\nout vec2 v_Uv;\nvoid main(){ vec2 p = P[gl_VertexID]; v_Uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }')
    gl.shaderSource(fs, '#version 300 es\nprecision highp float;\nuniform sampler2D u_Tex;\nin vec2 v_Uv;\nout vec4 o_Color;\nvoid main(){ o_Color = vec4(texture(u_Tex, v_Uv).rgb, 1.0); }')
    gl.compileShader(vs)
    gl.compileShader(fs)
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[WEScene] present program link 失败:', gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      return null
    }
    // 无顶点属性的 VAO（gl_VertexID 全屏三角形）
    const vao = gl.createVertexArray()
    this.presentProgram = prog
    this.presentVao = vao
    return prog
  }

  private presentToScreen(canvas: HTMLCanvasElement): void {
    const gl = this.gl
    const master = this.masterFbo
    if (!master) return
    const prog = this.ensurePresentProgram()
    if (!prog || !this.presentVao) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.disable(gl.BLEND)
    gl.useProgram(prog)
    gl.bindVertexArray(this.presentVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, master.tex)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_Tex'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  // ---------------------------------------------------------------------------
  // 链末结果上屏（RGBA8 alpha 钳制等价 DX9 混合输入钳制）
  // ---------------------------------------------------------------------------

  /** 链末 blit 程序：与 present 同几何（无属性全屏三角形 + presentVao），fs 保 alpha。 */
  private chainBlitProgram: WebGLProgram | null = null

  private ensureChainBlitProgram(): WebGLProgram | null {
    if (this.chainBlitProgram) return this.chainBlitProgram
    const gl = this.gl
    const vs = gl.createShader(gl.VERTEX_SHADER)
    const fs = gl.createShader(gl.FRAGMENT_SHADER)
    if (!vs || !fs) return null
    gl.shaderSource(vs, '#version 300 es\nprecision highp float;\nconst vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));\nout vec2 v_Uv;\nvoid main(){ vec2 p = P[gl_VertexID]; v_Uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }')
    // ⚠️ 与 presentToScreen 不同：alpha 原样透传（混合由 applyBlendingChain 决定）
    gl.shaderSource(fs, '#version 300 es\nprecision highp float;\nuniform sampler2D u_Tex;\nin vec2 v_Uv;\nout vec4 o_Color;\nvoid main(){ o_Color = texture(u_Tex, v_Uv); }')
    gl.compileShader(vs)
    gl.compileShader(fs)
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[WEScene] chain blit program link 失败:', gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      return null
    }
    this.chainBlitProgram = prog
    return prog
  }

  /**
   * 链末 pass 结果 blit 到 masterFbo（预乘混合）。
   * ⚠️ 链末 pass 先画进 RGBA8 FBO 再经本方法上屏：RGBA8 写入把 >1 的 alpha 钳到 1，
   * 等价 DX9 的混合前输入钳制——工坊 godrays_combine 的 `albedo.a += rays.a`（无
   * saturate）输出 a=1+rays.a，直接混到 masterFbo 时 dst 因子 = 1-a = -rays.a 为负
   * → 原画面被减暗 rays.a 倍（Girl and Samurai 全画面 ×0.45-0.5 实测，2026-10-31）。
   * 正确语义 = out.rgb 直接替换（WE 实机无偏暗）→ 钳制后 dst 因子=0 恰好替换。
   * alpha ≤1 的常规链（模糊/水印等）存储值与直画完全一致，数学恒等零影响。
   */
  private blitChainToMaster(tex: WebGLTexture, blending: string): void {
    const gl = this.gl
    const master = this.masterFbo
    if (!master) return
    const prog = this.ensureChainBlitProgram()
    if (!prog || !this.presentVao) return
    this.bindScreenTarget()
    gl.viewport(0, 0, master.width, master.height)
    gl.disable(gl.DEPTH_TEST)
    this.applyBlendingChain(blending)
    gl.useProgram(prog)
    gl.bindVertexArray(this.presentVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_Tex'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  // ---------------------------------------------------------------------------
  // blend 合成延后（效果链 + colorBlendMode 对象）
  // ---------------------------------------------------------------------------

  /**
   * WE 语义：colorBlendMode 是「对象最终像素与帧缓冲」的合成属性，应在对象输出
   * 上屏时应用。链内基底 pass 先做 ApplyBlending 会把背景快照烤进链 FBO——
   * waterflow/scroll 的 UV 位移/回绕会搬运背景内容（镜像花朵条、全屏涂抹，
   * Girl and Samurai 2026-10-29/30 实证）。因此链对象：链内保存原始内容，
   * 链后用本合成 pass 一次性做 ApplyBlending(mode, 背景, 链结果)。
   */
  private blendCompositeProgram: WebGLProgram | null = null

  private ensureBlendCompositeProgram(): WebGLProgram | null {
    if (this.blendCompositeProgram) return this.blendCompositeProgram
    const gl = this.gl
    const vs = `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
out vec2 v_Uv;
void main(){ vec2 p = P[gl_VertexID]; v_Uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`
    // 公式 1:1 抄引擎 common_blending.h（ApplyBlending 的 A=背景、B=对象、op=对象 alpha）。
    // 链 FBO 内容为预乘 alpha（基底以 translucent 混合画上透明黑）→ 先反预乘出 B/op。
    const fs = `#version 300 es
precision highp float;
uniform sampler2D u_Src;
uniform sampler2D u_Bg;
uniform int u_Mode;
in vec2 v_Uv;
out vec4 o_Color;
vec3 BlendColorBurn(vec3 b, vec3 s){ return vec3((s.r==0.0)?0.0:max((1.0-((1.0-b.r)/s.r)),0.0),(s.g==0.0)?0.0:max((1.0-((1.0-b.g)/s.g)),0.0),(s.b==0.0)?0.0:max((1.0-((1.0-b.b)/s.b)),0.0)); }
vec3 BlendColorDodge(vec3 b, vec3 s){ return vec3((s.r==1.0)?1.0:min(b.r/(1.0-s.r),1.0),(s.g==1.0)?1.0:min(b.g/(1.0-s.g),1.0),(s.b==1.0)?1.0:min(b.b/(1.0-s.b),1.0)); }
vec3 BlendOverlay(vec3 b, vec3 s){ return vec3(b.r<0.5?(2.0*b.r*s.r):(1.0-2.0*(1.0-b.r)*(1.0-s.r)),b.g<0.5?(2.0*b.g*s.g):(1.0-2.0*(1.0-b.g)*(1.0-s.g)),b.b<0.5?(2.0*b.b*s.b):(1.0-2.0*(1.0-b.b)*(1.0-s.b))); }
vec3 BlendReflect(vec3 b, vec3 s){ return vec3((s.r==1.0)?s.r:min(b.r*b.r/(1.0-s.r),1.0),(s.g==1.0)?s.g:min(b.g*b.g/(1.0-s.g),1.0),(s.b==1.0)?s.b:min(b.b*b.b/(1.0-s.b),1.0)); }
vec3 RGBToHSL(vec3 c){ vec3 hsl; float fmin=min(min(c.r,c.g),c.b); float fmax=max(max(c.r,c.g),c.b); float d=fmax-fmin; hsl.z=(fmax+fmin)/2.0; if(d==0.0){hsl.x=0.0;hsl.y=0.0;}else{ hsl.y=hsl.z<0.5?d/(fmax+fmin):d/(2.0-fmax-fmin); float dR=((fmax-c.r)/6.0+d/2.0)/d; float dG=((fmax-c.g)/6.0+d/2.0)/d; float dB=((fmax-c.b)/6.0+d/2.0)/d; if(c.r==fmax)hsl.x=dB-dG; else if(c.g==fmax)hsl.x=(1.0/3.0)+dR-dB; else if(c.b==fmax)hsl.x=(2.0/3.0)+dG-dR; if(hsl.x<0.0)hsl.x+=1.0; if(hsl.x>1.0)hsl.x-=1.0; } return hsl; }
float HueToRGB(float f1,float f2,float h){ if(h<0.0)h+=1.0; if(h>1.0)h-=1.0; float r; if((6.0*h)<1.0)r=f1+(f2-f1)*6.0*h; else if((2.0*h)<1.0)r=f2; else if((3.0*h)<2.0)r=f1+(f2-f1)*((2.0/3.0)-h); else r=f1; return r; }
vec3 HSLToRGB(vec3 hsl){ vec3 rgb; if(hsl.y==0.0)rgb=vec3(hsl.z); else{ float f2=hsl.z<0.5?hsl.z*(1.0+hsl.y):(hsl.z+hsl.y)-hsl.y*hsl.z; float f1=2.0*hsl.z-f2; rgb.r=HueToRGB(f1,f2,hsl.x+(1.0/3.0)); rgb.g=HueToRGB(f1,f2,hsl.x); rgb.b=HueToRGB(f1,f2,hsl.x-(1.0/3.0)); } return rgb; }
vec3 applyBlend(int m, vec3 A, vec3 B, float op){
  if (m==1) return mix(A,min(A,B),op);
  if (m==2) return mix(A,A*B,op);
  if (m==3) return mix(A,BlendColorBurn(A,B),op);
  if (m==4) return mix(A,max(A+B-vec3(1.0),vec3(0.0)),op);
  if (m==5) return min(A,B);
  if (m==6) return mix(A,max(A,B),op);
  if (m==7) return mix(A,vec3(1.0)-(vec3(1.0)-A)*(vec3(1.0)-B),op);
  if (m==8) return mix(A,BlendColorDodge(A,B),op);
  if (m==9) return mix(A,min(A+B,vec3(1.0)),op);
  if (m==10) return max(A,B);
  if (m==11) return mix(A,BlendOverlay(A,B),op);
  if (m==12) return mix(A,BlendOverlay(B,A),op);
  if (m==14) return mix(A,B.r<0.5?BlendColorBurn(A,2.0*B):BlendColorDodge(A,2.0*B-vec3(1.0)),op);
  if (m==15) return mix(A,B.r<0.5?max(A+2.0*B-vec3(1.0),vec3(0.0)):min(A+2.0*(B-vec3(0.5)),vec3(1.0)),op);
  if (m==16) return mix(A,B.r<0.5?min(A,2.0*B):max(A,2.0*B-vec3(1.0)),op);
  if (m==17) { vec3 v=B.r<0.5?BlendColorBurn(A,2.0*B):BlendColorDodge(A,2.0*B-vec3(1.0)); return mix(A,vec3(v.r<0.5?0.0:1.0,v.g<0.5?0.0:1.0,v.b<0.5?0.0:1.0),op); }
  if (m==18) return mix(A,abs(A-B),op);
  if (m==19) return mix(A,A+B-2.0*A*B,op);
  if (m==20) return mix(A,max(A+B-vec3(1.0),vec3(0.0)),op);
  if (m==21) return mix(A,BlendReflect(A,B),op);
  if (m==22) return mix(A,BlendReflect(B,A),op);
  if (m==23) return mix(A,min(A,B)-max(A,B)+vec3(1.0),op);
  if (m==24) return mix(A,(A+B)/2.0,op);
  if (m==25) return mix(A,vec3(1.0)-abs(vec3(1.0)-A-B),op);
  if (m==26) { vec3 bH=RGBToHSL(A); vec3 sH=RGBToHSL(B); return mix(A,HSLToRGB(vec3(sH.r,bH.g,bH.b)),op); }
  if (m==27) { vec3 bH=RGBToHSL(A); vec3 sH=RGBToHSL(B); return mix(A,HSLToRGB(vec3(bH.r,sH.g,bH.b)),op); }
  if (m==28) { vec3 bH=RGBToHSL(A); vec3 sH=RGBToHSL(B); return mix(A,HSLToRGB(vec3(sH.r,sH.g,bH.b)),op); }
  if (m==29) { vec3 bH=RGBToHSL(A); vec3 sH=RGBToHSL(B); return mix(A,HSLToRGB(vec3(bH.r,bH.g,sH.b)),op); }
  if (m==30) return mix(A,vec3(max(A.r,max(A.g,A.b)))*B,op);
  if (m==31) return A+B*op;
  if (m==32) return mix(A,A+A*B,op);
  return mix(A,B,op);
}
void main(){
  vec4 src = texture(u_Src, v_Uv);
  vec4 bg = texture(u_Bg, v_Uv);
  vec3 B = src.a > 0.0001 ? src.rgb / src.a : vec3(0.0);
  o_Color = vec4(applyBlend(u_Mode, bg.rgb, B, src.a), bg.a);
}`
    const vsShader = gl.createShader(gl.VERTEX_SHADER)
    const fsShader = gl.createShader(gl.FRAGMENT_SHADER)
    if (!vsShader || !fsShader) return null
    gl.shaderSource(vsShader, vs)
    gl.shaderSource(fsShader, fs)
    gl.compileShader(vsShader)
    gl.compileShader(fsShader)
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, vsShader)
    gl.attachShader(prog, fsShader)
    gl.linkProgram(prog)
    gl.deleteShader(vsShader)
    gl.deleteShader(fsShader)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[WEScene] blend composite program link 失败:', gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      return null
    }
    this.blendCompositeProgram = prog
    return prog
  }

  /** 链内基底用的「去 BLENDMODE」pass 变体（每原 pass 只克隆一次） */
  private noBlendPassCache = new WeakMap<object, ScenePass>()
  private getNoBlendPass(pass: ScenePass): ScenePass {
    let p = this.noBlendPassCache.get(pass)
    if (!p) {
      // ⚠️ 服务端 combos 已被转译器烤进源码（#define BLENDMODE 31）——只删 combos 无效
      // （only373 全白实证），必须对 vert/frag 源码做字符串改写。BLENDMODE=0 走
      // common_blending.h 的 default 分支 = 纯直通，链 FBO 只存对象自身内容。
      const strip = (src: string | undefined) =>
        src ? src.replace(/#define BLENDMODE \d+/g, '#define BLENDMODE 0') : src
      p = { ...pass, shaderRef: undefined, vert: strip(pass.vert), frag: strip(pass.frag) }
      this.noBlendPassCache.set(pass, p)
    }
    return p
  }

  /**
   * blend 合成延后的最终步骤：链结果（预乘 alpha）× 本对象绘制前的帧快照，
   * 按引擎 ApplyBlending 公式合成并整屏写回主渲染目标。
   */
  private drawBlendComposite(
    srcTex: WebGLTexture,
    bgTex: WebGLTexture,
    mode: number,
    canvas: HTMLCanvasElement,
  ): void {
    const gl = this.gl
    const prog = this.ensureBlendCompositeProgram()
    if (!prog || !this.presentVao) return
    this.bindScreenTarget()
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.disable(gl.BLEND)
    gl.useProgram(prog)
    gl.bindVertexArray(this.presentVao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_Src'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, bgTex)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_Bg'), 1)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_Mode'), mode)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    gl.enable(gl.BLEND)
  }

  getError(): string | null {
    return this.lastError
  }

  /** debugdraw 专用：半透明纯色填充 quad（显示对象几何实际落点，验证 MVP 语义） */
  private debugQuadProgram: WebGLProgram | null = null
  private debugQuadMvps: Float32Array[] = []
  private debugFillQuad(mvp: Float32Array): void {
    const gl = this.gl
    if (!this.debugQuadProgram) {
      const vs = this.compileShader(gl.VERTEX_SHADER, `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform mat4 g_ModelViewProjectionMatrix;
void main() {
  gl_Position = vec4(a_Position, 1.0) * g_ModelViewProjectionMatrix;
}`)
      const fs = this.compileShader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
out vec4 o_Color;
void main() { o_Color = vec4(1.0, 0.0, 0.0, 0.22); }`)
      if (!vs || !fs) return
      const prog = gl.createProgram()!
      gl.attachShader(prog, vs)
      gl.attachShader(prog, fs)
      gl.bindAttribLocation(prog, 0, 'a_Position')
      gl.bindAttribLocation(prog, 1, 'a_TexCoord')
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
      this.debugQuadProgram = prog
    }
    gl.useProgram(this.debugQuadProgram)
    const loc = gl.getUniformLocation(this.debugQuadProgram, 'g_ModelViewProjectionMatrix')
    if (loc) gl.uniformMatrix4fv(loc, false, mat4TransposedForUpload(mvp))
    gl.bindVertexArray(this.quadVao)
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
    gl.bindVertexArray(null)
  }

  /** 当前已加载的清单（调试/探针用） */
  getManifest(): SceneManifest | null {
    return this.manifest
  }

  // ---------------------------------------------------------------------------
  // 几何与基础资源
  // ---------------------------------------------------------------------------

  private initQuad(): void {
    // 全屏单位 quad：中心在原点、宽高 1（模型矩阵给实际尺寸），uv 原点在左上（WE 贴图约定）。
    // 全屏效果 vert（blur/passthrough 等）的 gl_Position = vec4(a_Position,1.0) 已在服务端
    // 转译期改写为 vec4(a_Position * 2.0, 1.0)（-0.5..0.5 → -1..1 clip），无需第二套几何。
    const quadVerts = new Float32Array([
      -0.5, 0.5, 0, 0, 0,
      -0.5, -0.5, 0, 0, 1,
      0.5, -0.5, 0, 1, 1,
      0.5, 0.5, 0, 1, 0,
    ])
    this.quadVao = this.createQuadVao(quadVerts)
    // v 翻转 quad（UV v'=1-v）：puppet 效果链专用。FBO→绘制 每次传递垂直镜像一次，
    // 用翻转 UV 采样自补偿（顶行采顶行），链长奇偶不再影响最终方向（2026-10-22 实证：
    // 人物 6 个 waterwaves pass 常规 quad 输出倒立）
    this.flipQuadVao = this.createQuadVao(new Float32Array([
      -0.5, 0.5, 0, 0, 1,
      -0.5, -0.5, 0, 0, 0,
      0.5, -0.5, 0, 1, 0,
      0.5, 0.5, 0, 1, 1,
    ]))
  }

  private createQuadVao(positions: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3])

    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    const ebo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)

    // 属性布局：a_Position(vec3, offset 0) + a_TexCoord(vec2, offset 12)，步长 20 字节
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)

    return vao
  }

  /**
   * .mdl 模型的 VAO（懒建，随对象缓存）。
   * stride 20（pos3+uv2）：loc0=position、loc1=texCoord；
   * stride 32（pos3+normal3+uv2）：loc0=position、loc2=normal、loc1=texCoord。
   * a_Normal 绑定到 location 2 由 compilePass 的 bindAttribLocation 保证（缺失时绑定空名无害）。
   */
  private ensureMeshVao(object: SceneObject): { vao: WebGLVertexArrayObject; indexCount: number; indexType?: number } | null {
    const cached = this.meshVaoCache.get(object)
    if (cached !== undefined) return cached
    const gl = this.gl
    const mesh = this.modelMeshes.get(object)
    if (!mesh || !mesh.positions?.length || !mesh.indices?.length) {
      this.meshVaoCache.set(object, null)
      return null
    }
    const hasNormals = mesh.normals?.length === mesh.positions.length
    const strideFloats = hasNormals ? 8 : 5 // 32 或 20 字节
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()
    const interleaved = new Float32Array((mesh.positions.length / 3) * strideFloats)
    const vc = mesh.positions.length / 3
    for (let i = 0; i < vc; i++) {
      let o = i * strideFloats
      interleaved[o] = mesh.positions[i * 3]
      interleaved[o + 1] = mesh.positions[i * 3 + 1]
      interleaved[o + 2] = mesh.positions[i * 3 + 2]
      o += 3
      if (hasNormals) {
        interleaved[o] = mesh.normals[i * 3]
        interleaved[o + 1] = mesh.normals[i * 3 + 1]
        interleaved[o + 2] = mesh.normals[i * 3 + 2]
        o += 3
      }
      interleaved[o] = mesh.uvs[i * 2]
      interleaved[o + 1] = mesh.uvs[i * 2 + 1]
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW)
    const ebo = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo)
    // uint32 索引（大网格 meteor 314 万顶点实测）或顶点数 > 65535 → WebGL2 uint32 索引
    const indexType = mesh.indices instanceof Uint32Array || vc > 65535 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT
    if (indexType === gl.UNSIGNED_INT) {
      if (mesh.indices instanceof Uint32Array) {
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
      } else {
        const expanded = new Uint32Array(mesh.indices.length)
        for (let i = 0; i < mesh.indices.length; i++) expanded[i] = mesh.indices[i]
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, expanded, gl.STATIC_DRAW)
      }
    } else {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices instanceof Uint16Array ? mesh.indices : new Uint16Array(mesh.indices), gl.STATIC_DRAW)
    }
    const byteStride = strideFloats * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, byteStride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, byteStride, (hasNormals ? 6 : 3) * 4)
    if (hasNormals) {
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, byteStride, 12)
    } else {
      // stride 20 的 mdl 无法线，而 generic 等标准材质无条件用 a_Normal 算光照——
      // 缺省常量 (0,0,0) 会让 normalize(0)=NaN 把光照输出染黑 → 给朝上法线兜底
      gl.disableVertexAttribArray(2)
      gl.vertexAttrib3f(2, 0, 1, 0)
    }
    // NORMALMAP 材质需要 a_Tangent4（location 3，generic.vert），mdl 顶点无切线 →
    // 禁用该 attribute 并给常量 (1,0,0,1)（引擎 BuildTangentSpace 用它构造退化 TBN）
    gl.disableVertexAttribArray(3)
    gl.vertexAttrib4f(3, 1, 0, 0, 1)
    gl.bindVertexArray(null)
    const result = { vao, indexCount: mesh.indices.length, indexType }
    this.meshVaoCache.set(object, result)
    return result
  }

  private initWhiteTexture(): void {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // 占位纹理：白色（WE 缺省 mask 约定 util/white；调试期可临时改为染色观察绑定）
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    this.whiteTexture = tex
  }

  // ---------------------------------------------------------------------------
  // 纹理加载与上传
  // ---------------------------------------------------------------------------

  private async loadTexture(info: SceneTextureInfo): Promise<UploadedTexture | null> {
    const gl = this.gl
    const cached = this.textureCache.get(info.textureFile)
    if (cached !== undefined) return cached
    // 占位防并发重复拉取
    this.textureCache.set(info.textureFile, null)
    try {
      // 缓存用默认策略（服务端带 ETag 可条件重验证）；force-cache 会跨会话命中
      // 磁盘缓存里的陈旧数据（纹理格式修复前后字节数不同 → 上传报 not big enough）
      const response = await fetch(
        `${BASE_SERVER}${info.url}?id=${encodeURIComponent(this.manifest!.id)}&name=${encodeURIComponent(info.textureFile)}`,
      )
      if (!response.ok) throw new Error('纹理下载失败 ' + response.status)
      const buffer = await response.arrayBuffer()

      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      const wrap = info.clampUVs ? gl.CLAMP_TO_EDGE : gl.REPEAT
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
      const filter = info.noInterpolation ? gl.NEAREST : gl.LINEAR
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)

      let uploaded: UploadedTexture | null = null
      const isPlainImage = info.image === 'png' || info.image === 'jpeg'
      // mipmap 仅限「图像类」纹理：RGBA8888 图片 / png / jpeg。
      // ⚠️ R8/RG88 是 mask/noise 数据纹理（waterwaves 用它扰动 UV）——trilinear 会在
      // UV 高频变化处混入低 mip 层把波形平均掉，产生条带伪影（2026-10-21 用户实机
      // 天空区拉丝实测）→ 数据纹理保持无 mip 原过滤。
      const isImageTexture = info.image === 'png' || info.image === 'jpeg' || (info.image === 'raw' && info.format === 'RGBA8888')
      // 视频纹理（.tex 名下的裸 MP4/WebM）：<video> 解码 → 每帧 texImage2D
      if (info.image === 'video') {
        const video = document.createElement('video')
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.crossOrigin = 'anonymous'
        video.src = `${BASE_SERVER}${info.url}?id=${encodeURIComponent(this.manifest!.id)}&name=${encodeURIComponent(info.textureFile)}`
        uploaded = { texture, width: 0, height: 0, video }
        video.addEventListener('loadeddata', () => {
          uploaded!.width = video.videoWidth
          uploaded!.height = video.videoHeight
        })
        video.play().catch(() => { /* 自动播放被拒时静默（Electron 默认允许） */ })
        this.liveVideos.push(uploaded)
      } else if (isPlainImage || info.image === 'raw') {
        if (isPlainImage) {
          const blob = new Blob([buffer], { type: info.image === 'png' ? 'image/png' : 'image/jpeg' })
          const bitmap = await createImageBitmap(blob)
          // ⚠️ await 期间并发任务的 loadTexture 可能已 bindTexture 到别的纹理对象，
          // texImage2D 写的是「当前绑定」→ 必须重新绑定再上传，否则大 PNG（解码慢）
          // 的内容会写进别人纹理、自己保持黑（2026-10-20 razer_bedroom 主背景黑屏根因）
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
          uploaded = { texture, width: bitmap.width, height: bitmap.height }
          bitmap.close()
        } else {
          uploaded = this.uploadRawTexture(texture, buffer, info)
        }
        // 缩小采样必须走 mipmap：大图（如芙莉莲脸 4718×2175）在小窗里 0.25× 缩小采样，
        // 无 mip 的双线性每屏幕像素只采 1 texel → 高频走样成噪点（用户报「分辨率低」根因，
        // WE 官方 .tex 自带 mip 链 + trilinear）。generateMipmap 失败时保持 LINEAR 不致黑屏。
        if (uploaded && isImageTexture && filter === gl.LINEAR) {
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.generateMipmap(gl.TEXTURE_2D)
          // generateMipmap 失败（如内部格式限制）→ 无 mip 链时 LINEAR_MIPMAP_LINEAR
          // 会让纹理 incomplete → 采样黑屏，必须回退 LINEAR
          if (gl.getError() === gl.NO_ERROR) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
          }
        }
      } else {
        uploaded = this.uploadRawTexture(texture, buffer, info)
      }

      this.textureCache.set(info.textureFile, uploaded)
      return uploaded
    } catch (error) {
      console.warn('[WEScene] 纹理加载失败:', info.textureFile, error)
      this.textureCache.set(info.textureFile, null)
      return null
    }
  }

  private uploadRawTexture(texture: WebGLTexture, buffer: ArrayBuffer, info: SceneTextureInfo): UploadedTexture | null {
    const gl = this.gl
    const width = info.canvasWidth || info.width
    const height = info.canvasHeight || info.height
    const bytes = new Uint8Array(buffer)

    const formats: Record<string, { internal: number, format: number, type: number } | null> = {
      RGBA8888: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
      R8: { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE },
      RG88: { internal: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE },
    }

    try {
      if (info.format === 'DXT1' || info.format === 'DXT3' || info.format === 'DXT5') {
        const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc')
        if (!s3tc) throw new Error('浏览器不支持 S3TC 压缩纹理')
        const internal = info.format === 'DXT1'
          ? s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
          : info.format === 'DXT3' ? s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT : s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT
        gl.compressedTexImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, bytes)
        return { texture, width, height }
      }
      if (info.format === 'BC7') {
        const bptc = gl.getExtension('EXT_texture_compression_bptc')
        if (!bptc) throw new Error('浏览器不支持 BPTC 压缩纹理')
        gl.compressedTexImage2D(gl.TEXTURE_2D, 0, bptc.COMPRESSED_RGBA_BPTC_UNORM_EXT, width, height, 0, bytes)
        return { texture, width, height }
      }
      const standard = formats[info.format]
      if (standard) {
        // ⚠️ 默认 UNPACK_ALIGNMENT=4：R8/RG88 mask（319×369 等行宽非 4 倍数）按对齐行
        // 读取会超出紧缩数据 → "ArrayBufferView not big enough" 静默失败 → mask 全黑。
        // WE 的 .tex 数据一律紧缩布局 → 上传期间对齐设 1（RGBA8888 不受影响）
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        // 画布尺寸 > 图像区尺寸时（WE canvas 语义：图像区居左上、右/下透明 padding，
        // 男漂 750×750 → 画布 768×768 实测），数据只有图像区 → 直接按画布上传会
        // "ArrayBufferView not big enough" 全部静默失败 → 按 RGBA 逐行补零对齐画布
        const bpp = info.format === 'RGBA8888' ? 4 : info.format === 'RG88' ? 2 : 1
        const need = width * height * bpp
        let data = bytes
        if (bytes.length < need && info.width <= width && info.height <= height) {
          const padded = new Uint8Array(need)
          const rowBytes = info.width * bpp
          for (let y = 0; y < info.height; y++) {
            padded.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes), y * width * bpp)
          }
          data = padded
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, standard.internal, width, height, 0, standard.format, standard.type, data)
        // 调试仪器：texImage2D 不抛异常，驱动只发 console 报错 → 主动取错误定位文件
        if (gl.getError() === gl.INVALID_OPERATION) {
          console.warn('[WEScene][tex-debug] 上传失败:', info.textureFile, 'canvas:', width + 'x' + height, 'data:', data.length, 'need:', need, 'info.w:', info.width, 'info.h:', info.height, 'fmt:', info.format)
        }
        return { texture, width, height }
      }
      throw new Error('不支持的纹理格式 ' + info.format)
    } catch (error) {
      console.warn('[WEScene] 原始纹理上传失败:', info.textureFile, error)
      gl.deleteTexture(texture)
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // WE 文本对象（千咲 69/伊蕾娜 69/雪境 8/铃芽 2）：canvas 光栅化 + 简单着色 quad
  // pointsize 为场景单位（时钟 188.7/2160 ≈ 9% 屏高与 WE 实机观感一致）；
  // 1 canvas px = 1 场景单位（画布 = object.size），字体从 pkg 经 FontFace 加载。
  // ---------------------------------------------------------------------------

  private static readonly TEXT_VERT = `#version 300 es
in vec3 a_Position;
in vec2 a_TexCoord;
uniform mat4 u_MVP;
out vec2 v_TexCoord;
void main() {
  v_TexCoord = a_TexCoord;
  gl_Position = u_MVP * vec4(a_Position, 1.0);
}`

  private static readonly TEXT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D g_Texture0;
uniform vec4 u_Color;
in vec2 v_TexCoord;
out vec4 wf_fragColor;
void main() {
  wf_fragColor = texture(g_Texture0, v_TexCoord) * u_Color;
}`

  private textProgram: CompiledPass | null = null
  private textTextures = new Map<number, { texture: WebGLTexture; width: number; height: number }>()
  private textFontPromises = new Map<string, Promise<boolean>>()

  private textFontFamily(path: string): string {
    return 'wfft_' + path.replace(/[^\w]/g, '_')
  }

  /** WE 动态文本占位符静态替换：<Date> → 当前日期（格式对齐竖排日期「15 NOV 2023」） */
  private resolveTextPlaceholders(text: string): string {
    return text.replace(/<date>/gi, () => {
      const d = new Date()
      const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()]
      return `${d.getDate()} ${mon} ${d.getFullYear()}`
    }).replace(/<time>/gi, () => {
      const d = new Date()
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    })
  }

  /** 加载 pkg 内字体（.ttf/.otf）为 FontFace；失败回退 sans-serif（返回 false） */
  private ensureTextFont(path: string): Promise<boolean> {
    let p = this.textFontPromises.get(path)
    if (p) return p
    p = (async () => {
      try {
        const family = this.textFontFamily(path)
        if (document.fonts.check(`16px "${family}"`)) return true
        const resp = await fetch(
          `${BASE_SERVER}/api/wallpaper-engine/scene/asset?id=${encodeURIComponent(this.manifest!.id)}&name=${encodeURIComponent(path)}`,
        )
        if (!resp.ok) return false
        const buf = await resp.arrayBuffer()
        const face = new FontFace(family, buf)
        await face.load()
        document.fonts.add(face)
        return true
      } catch {
        return false
      }
    })()
    this.textFontPromises.set(path, p)
    return p
  }

  /** 光栅化文本对象 → 纹理（异步，完成后写入 textTextures 供渲染帧取用） */
  private buildTextTexture(object: SceneObject): void {
    const gl = this.gl
    const t = object.text!
    const key = object.id
    if (this.textTextures.has(key)) return
    const build = async () => {
      let fontOk = false
      if (t.font) fontOk = await this.ensureTextFont(t.font)
      let w = Math.round(object.size[0])
      let h = Math.round(object.size[1])
      const family = fontOk ? `"${this.textFontFamily(t.font)}"` : ''
      const px = Math.max(4, Math.min(t.pointsize, 4096))
      // size 缺失（部分工程文本层无编辑器测量值）→ 按文本内容自测包围盒
      if (w <= 2 || h <= 2) {
        const probe = document.createElement('canvas').getContext('2d')
        if (probe) {
          probe.font = `${px}px ${family ? family + ', ' : ''}sans-serif`
          const lines = this.resolveTextPlaceholders(t.text).split('\n')
          const maxW = Math.max(1, ...lines.map((ln) => probe.measureText(ln || ' ').width))
          w = Math.ceil(maxW) + t.padding * 2
          h = Math.ceil(lines.length * px * 1.25) + t.padding * 2
        }
      }
      w = Math.max(2, w)
      h = Math.max(2, h)
      // 世界尺寸（quad 用）= 缩放前原始值；超过 GPU 纹理上限 → 等比缩小画布+字号（仅分辨率降低）
      const worldW = w
      const worldH = h
      const overScale = Math.min(1, 4096 / w, 4096 / h)
      const pad = t.padding * overScale
      const drawPx = px * overScale
      w = Math.max(2, Math.min(4096, Math.round(w * overScale)))
      h = Math.max(2, Math.min(4096, Math.round(h * overScale)))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)
      const usePx = Math.max(4, drawPx)
      ctx.font = `${usePx}px ${family ? family + ', ' : ''}sans-serif`
      const c = t.color
      ctx.fillStyle = `rgb(${Math.round((c[0] ?? 1) * 255)}, ${Math.round((c[1] ?? 1) * 255)}, ${Math.round((c[2] ?? 1) * 255)})`
      ctx.textAlign = t.alignH === 'left' ? 'left' : t.alignH === 'right' ? 'right' : 'center'
      ctx.textBaseline = 'middle'
      const x = t.alignH === 'left' ? pad : t.alignH === 'right' ? w - pad : w / 2
      const lines = this.resolveTextPlaceholders(t.text).split('\n')
      const lineH = usePx * 1.25
      const y0 = t.alignV === 'top' ? pad + usePx * 0.6 : t.alignV === 'bottom' ? h - pad - (lines.length - 1) * lineH - usePx * 0.6 : h / 2 - ((lines.length - 1) * lineH) / 2
      lines.forEach((ln, i) => ctx.fillText(ln, x, y0 + i * lineH))
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      // 文本常被大幅缩小（时钟 1952×944 画布 → 屏上 ~60px）：必须 mipmap，
      // 否则 LINEAR 无 mip 高倍缩小会走样成点阵（2026-10-22 实证）。WebGL2 NPOT 可 mipmap。
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this.textTextures.set(key, { texture, width: worldW, height: worldH })
    }
    void build().catch(() => { /* 光栅化失败保持无纹理（不绘制） */ })
  }

  private getTextProgram(): CompiledPass | null {
    if (this.textProgram) return this.textProgram
    const fakePass = {
      shaderName: 'wf-text',
      vert: WallpaperEngineSceneRenderer.TEXT_VERT,
      frag: WallpaperEngineSceneRenderer.TEXT_FRAG,
      blending: 'translucent',
      depthTest: false,
      depthWrite: false,
      constants: {},
      textures: [],
      unsupported: [],
    } as unknown as ScenePass
    try {
      this.textProgram = this.compilePass(fakePass)
    } catch {
      this.textProgram = null
    }
    return this.textProgram
  }

  private renderTextObject(object: SceneObject, viewProjection: Float32Array): void {
    const gl = this.gl
    const uploaded = this.textTextures.get(object.id)
    if (!uploaded) {
      this.buildTextTexture(object) // 未就绪：先触发光栅化，下一帧起绘制
      return
    }
    const compiled = this.getTextProgram()
    if (!compiled) {
      if (this.debugDraw) console.warn(`[WEScene][text] obj=${object.id} 编译失败跳绘`)
      return
    }
    // ⚠️ 必须自绑 quad VAO：前一个对象常是粒子（drawInstances 末尾解绑 VAO=null）
    // 或 mesh（末尾解绑），残留 VAO 无 element array buffer → drawElements 静默失败
    // → 文本层不渲染（Girl and Samurai Clock/Date 实证）
    gl.bindVertexArray(this.quadVao)
    // quad 尺寸 = 光栅化画布实际尺寸（size 缺失自测时 ≠ object.size）
    const [w, h] = [uploaded.width, uploaded.height]
    let model: Float32Array
    if (object.worldMatrix) {
      model = mat4Multiply(new Float32Array(object.worldMatrix), mat4Scale(w, h, 1))
    } else {
      model = mat4Translate(object.origin[0], object.origin[1], object.origin[2])
      const [sx, sy] = [object.scale[0] || 1, object.scale[1] || 1]
      model = mat4Multiply(model, mat4Scale(w * sx, h * sy, 1))
    }
    const mvp = mat4Multiply(viewProjection, model)
    gl.useProgram(compiled.program)
    const mvpLoc = compiled.uniformLocations.get('u_MVP')
    if (mvpLoc) gl.uniformMatrix4fv(mvpLoc, false, mvp)
    const colorLoc = compiled.uniformLocations.get('u_Color')
    if (colorLoc) {
      const c = object.text!.color
      gl.uniform4f(colorLoc, c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, object.text!.alpha)
    }
    const texLoc = compiled.uniformLocations.get('g_Texture0')
    if (texLoc) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, uploaded.texture)
      gl.uniform1i(texLoc, 0)
    }
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    this.applyBlending('translucent')
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }

  // ---------------------------------------------------------------------------
  // 着色器程序
  // ---------------------------------------------------------------------------

  private compilePass(pass: ScenePass): CompiledPass | null {
    const cached = this.programCache.get(pass)
    if (cached !== undefined) return cached
    const gl = this.gl
    if (!pass.vert || !pass.frag) {
      // 源码未水合（批量拉取失败/服务端池淘汰）→ 与编译失败同样按跳过处理
      this.lastError = '着色器源码未水合: ' + pass.shaderName
      this.programCache.set(pass, null)
      return null
    }
    let compiled: CompiledPass | null = null
    try {
      const vertShader = this.compileShader(gl.VERTEX_SHADER, pass.vert)
      const fragShader = this.compileShader(gl.FRAGMENT_SHADER, pass.frag)
      if (vertShader && fragShader) {
        const program = gl.createProgram()!
        gl.attachShader(program, vertShader)
        gl.attachShader(program, fragShader)
        gl.bindAttribLocation(program, 0, 'a_Position')
        gl.bindAttribLocation(program, 1, 'a_TexCoord')
        // 模型顶点着色器（.mdl 场景）可能声明 a_Normal；绑定到 2 与 mesh VAO 布局一致
        gl.bindAttribLocation(program, 2, 'a_Normal')
        gl.linkProgram(program)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          throw new Error('链接失败: ' + gl.getProgramInfoLog(program))
        }
        gl.deleteShader(vertShader)
        gl.deleteShader(fragShader)

        const uniformLocations = new Map<string, WebGLUniformLocation | null>()
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(program, i)
          if (!info) continue
          const name = info.name.replace(/\[0\]$/, '')
          uniformLocations.set(name, gl.getUniformLocation(program, name))
        }
        compiled = {
          program,
          uniformLocations,
          attributeLocations: { position: 0, texCoord: 1 },
          uniformMetas: pass.uniforms,
        }
      }
    } catch (error) {
      console.warn('[WEScene] 着色器编译失败:', pass.shaderName, error)
      this.lastError = String(error)
      compiled = null
    }
    this.programCache.set(pass, compiled)
    return compiled
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      console.warn('[WEScene] 着色器编译错误:', log, '\n', source.slice(0, 400))
      // 调试钩子：探针页可取完整失败源码（__wfShaderDump = 最后一条；__wfShaderDumps = 全部）
      const dump = { log: log ?? '', source }
      ;(window as unknown as Record<string, unknown>).__wfShaderDump = dump
      const w = window as unknown as Record<string, unknown>
      let dumps = w.__wfShaderDumps as { log: string; source: string }[] | undefined
      if (!Array.isArray(dumps)) {
        dumps = []
        w.__wfShaderDumps = dumps
      }
      dumps.push(dump)
      gl.deleteShader(shader)
      throw new Error('着色器编译失败: ' + log)
    }
    return shader
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  private renderFrame(): void {
    const gl = this.gl
    const manifest = this.manifest
    if (!manifest || !this.quadVao) return

    const canvas = this.canvas
    // WE 官方按桌面物理分辨率渲染，无 DPR 钳制；这里放宽到 2.5（覆盖 4K/250%）
    // 避免 125%/150% 以上的高分屏被钳成低清；3 倍以上屏极罕见，钳制防极端性能开销
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    const targetW = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const targetH = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
      // 诊断（只在尺寸变化时打印）：用户报「渲染分辨率低」先看这行——
      // 渲染分辨率 = 窗口 CSS 尺寸 × dpr，窗口未最大化时天然低于桌面全屏
      console.info('[WEScene] 渲染分辨率', targetW + 'x' + targetH, '(CSS', canvas.clientWidth + 'x' + canvas.clientHeight, '@ dpr', dpr + ')')
    }
    gl.viewport(0, 0, canvas.width, canvas.height)

    // 视频纹理逐帧刷新（<video> 已解码帧 → texImage2D；未就绪跳过保留上一帧）
    if (this.liveVideos.length) {
      for (const entry of this.liveVideos) {
        const video = entry.video!
        if (video.readyState >= 2 && video.videoWidth > 0) {
          gl.bindTexture(gl.TEXTURE_2D, entry.texture)
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
          } catch { /* 帧未就绪等瞬态，保留上一帧内容 */ }
        }
      }
    }

    const clear = manifest.scene.clearColor
    // 整帧画进离屏主渲染目标（_rt_FullFrameBuffer 等价物），末尾 presentToScreen 上屏。
    // blend/composelayer 的帧快照也从这里 blit（见 captureComposeSnapshot 的 ANGLE 注释）
    const master = this.ensureMasterFbo(canvas.width, canvas.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, master ? master.fbo : null)
    gl.clearColor(clear[0], clear[1], clear[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // cover 适配：WE 场景坐标为 [0..orthoW]×[0..orthoH]（物体 origin 是图层中心），
    // 画布纵横比不同时围绕场景中心等比放大裁切。
    // pxPerUnit = 每世界单位像素数（取 max 保证覆盖）；视口世界尺寸 = 画布px / pxPerUnit
    const ortho = manifest.scene.ortho
    const pxPerUnit = Math.max(canvas.width / ortho.width, canvas.height / ortho.height)
    const halfW = canvas.width / (2 * pxPerUnit)
    const halfH = canvas.height / (2 * pxPerUnit)
    // 视口世界尺寸（composelayer size 缺省 = 全屏直通层时的 quad 尺寸，见 renderObject）
    this.viewportWorldSize = [halfW * 2, halfH * 2]
    const centerX = ortho.width / 2
    const centerY = ortho.height / 2
    const projection = mat4Ortho(centerX - halfW, centerX + halfW, centerY - halfH, centerY + halfH, -100000, 100000)
    const cam = manifest.scene.camera
    // ⚠️ WE 2D 场景的 camera 是「视差相机」而非 lookAt：正交窗口固定在 ortho 中心，
    // eye 只按每对象 parallaxDepth 平移层级（offset = -eye*depth，depth 0=贴屏幕不动、
    // 1=贴世界）。此前 lookAt(eye) 全局应用 → eye≠0 的场景（虹夏 3650475846
    // eye=(-496,-328)）全场景平移 → 4K 图错位取景成「巨大特写」（2026-10-23）。
    // 雪境等 eye=(0,0,0) 场景不受影响（单位视图）。
    const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    this.cameraEye = cam.eye
    // 场景光源（point light 对象）：供 setBuiltinUniforms 填 g_LightsPosition 体系
    this.sceneLights = manifest.objects
      .filter((o) => o.visible !== false && o.light)
      .map((o) => o.light!)
    const viewProjection = mat4Multiply(projection, view)

    // 3D 模型对象走透视相机（2D 对象仍用正交 cover 投影，两套 VP 并存）。
    // ⚠️ 不能用 manifest.scene.camera 当透视 lookAt 相机：WE scene.json 的 camera
    // 是正交层视差参数（techno 的 eye 在模型内部、demon_core 的视线背离核心、
    // dna 的 eye 贴在模型包围球面上）→ 以顶点数最多的 mesh 主体自动取景
    const hasMesh = manifest.objects.some((o) => this.modelMeshes.has(o))
    let perspectiveViewProjection: Float32Array | null = null
    if (hasMesh) {
      const aspect = canvas.width / Math.max(1, canvas.height)
      const fov = manifest.scene.perspectiveFov || 60
      const focus = this.resolveMeshFocus(manifest)
      const dist = (focus.radius / Math.tan(((fov * Math.PI) / 180) / 2)) * 1.22 + 0.5
      // 正面略仰视（WE 官方模型场景多为近水平视角）
      const eye = [
        focus.center[0],
        focus.center[1] + dist * 0.176,
        focus.center[2] + dist * 0.984,
      ]
      const view = mat4LookAt(eye, focus.center, [0, 1, 0])
      const perspective = mat4Perspective(fov, aspect, 0.1, 100000)
      perspectiveViewProjection = mat4Multiply(perspective, view)
      this.cameraEye = eye
    }

    const time = (performance.now() - this.startTime) / 1000
    // puppet 层时间推进 + 蒙皮（顶点直接映射到场景世界空间）
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000)
    this.lastFrameTime = now
    for (const [object, state] of this.puppetStates) {
      if (object.visible === false) continue
      state.pose.advance(dt)
      state.pose.skin(state.skinned)
      // WE 顶点坐标：对象中心原点、y 向下（屏幕像素）→ 场景空间 y 向上取反；
      // x 缩放到对象 size（编辑器可在 authoring 后缩放显示尺寸）
      const size = object.size && object.size[0] > 0 && object.size[1] > 0
        ? object.size
        : state.sizeFallback
      // 视差层偏移（同 quad 分支：offset = -cameraEye.xy * parallaxDepth）
      let pox = 0, poy = 0
      if (object.parallaxDepth && (object.parallaxDepth[0] || object.parallaxDepth[1])) {
        pox = -this.cameraEye[0] * object.parallaxDepth[0]
        poy = -this.cameraEye[1] * object.parallaxDepth[1]
      }
      // parent 链：puppet 对象也可能挂 parent（虹夏头发 parent=衣 → worldMatrix 平移
      // (2106,959) ≠ 自身 origin (254,96)，忽略会画到屏幕左下角，2026-10-23）。
      // 缩放取 worldMatrix 线性部分的列长（父 scale 0.92 等）。
      const wm = object.worldMatrix
      const poseCfgEarly = PUPPET_POSE_OVERRIDES.get(object.name)
      const ox = (wm ? wm[12] : object.origin[0]) + pox + (poseCfgEarly?.anchor?.[0] ?? 0)
      const oy = (wm ? wm[13] : object.origin[1]) + poy + (poseCfgEarly?.anchor?.[1] ?? 0)
      const smx = wm ? Math.hypot(wm[0], wm[1]) : 1
      const smy = wm ? Math.hypot(wm[4], wm[5]) : 1
      // WE 语义（2026-10-22 铃芽双资产实证）：bind 包围盒中心 → 对象 origin、
      // 包围盒缩放到对象 size 矩形；顶点 y 相对图集 v 反向（WE y 向上）→ 取反。
      // ⚠️ 图集部件摆放方向因作者而异（猫图集倒放/人物图集正放），「取反」只对
      // 倒放图集资产成立——见 PUPPET upright 例外表。
      const cx = (state.model.bounds[0] + state.model.bounds[3]) / 2
      const cy = (state.model.bounds[1] + state.model.bounds[4]) / 2
      const poseCfg = PUPPET_POSE_OVERRIDES.get(object.name)
      const flip = poseCfg ? poseCfg.flip : (PUPPET_UPRIGHT_EXCEPTIONS.has(object.name) ? 1 : -1)
      // ⚠️ 蒙皮输出已是场景空间（横躺是 mdl 数据本身姿态，顺时针 90° 校正即正立），
      // bbox 随姿态对应 → 不做宽高交换（v33 交换实证反而破坏正确映射）
      const targetW = size[0]
      const targetH = size[1]
      const poseScale = poseCfg?.scale ?? 1
      const kx2 = targetW / Math.max(1, state.model.bounds[3] - state.model.bounds[0]) * smx * poseScale
      const ky2 = targetH / Math.max(1, state.model.bounds[4] - state.model.bounds[1]) * smy * poseScale
      // 顺时针 rot（屏幕向）：世界 y 向上坐标系下 θ = -rot
      const rotTheta = -(poseCfg?.rot ?? 0) * DEG2RAD
      const rotCos = Math.cos(rotTheta), rotSin = Math.sin(rotTheta)
      for (let v = 0; v < state.model.vertexCount; v++) {
        const rx0 = (state.skinned[v * 3] - cx) * kx2
        const ry0 = flip * (state.skinned[v * 3 + 1] - cy) * ky2
        state.worldPositions[v * 3] = ox + rx0 * rotCos - ry0 * rotSin
        state.worldPositions[v * 3 + 1] = oy + rx0 * rotSin + ry0 * rotCos
        state.worldPositions[v * 3 + 2] = state.skinned[v * 3 + 2]
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, state.posVbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.worldPositions)
    }
    // 粒子模拟推进（与 puppet 同用帧 dt；挂载时 loadParticles 已做过 warmup 预热）。
    // runtimes[0] 是主系统，其余为 children——先父后子（子粒子从父粒子位置发射）
    for (const [particleObject, runtimes] of this.particleStates) {
      if (particleObject.visible === false) continue
      runtimes[0].system.update(dt)
      for (let i = 1; i < runtimes.length; i += 1) {
        runtimes[i].system.update(dt, runtimes[0].system)
      }
    }
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    if (hasMesh) {
      // 模型 pass 可能开 depthTest：每帧连同深度一起清
      gl.clearDepth(1)
      gl.clear(gl.DEPTH_BUFFER_BIT)
    }

    gl.bindVertexArray(this.quadVao)

    // mesh 对象绘制顺序：background 包围体（backgroundsphere 等）先画，其余保持原序。
    // 双方材质常 depthtest disabled → 按序覆盖，背景排后会把核心盖掉（demon_core 实测）
    const drawOrder = [...manifest.objects].sort((a, b) => {
      const ab = this.modelMeshes.has(a) && /background/i.test(a.name) ? 0 : 1
      const bb = this.modelMeshes.has(b) && /background/i.test(b.name) ? 0 : 1
      return ab - bb
    })
    for (const object of drawOrder) {
      if (object.visible === false) continue
      this.renderObject(object, viewProjection, time, canvas, perspectiveViewProjection)
      // 帧内像素取证（已禁用并移除：readPixels 会触发渲染状态污染 → 画面特写化）
      if (false && this.debugDraw && this.frameIndex === 10) {
        console.warn(`[WEScene][px] after=${object.name || object.id}`)
      }
    }
    gl.bindVertexArray(null)
    // debugdraw：叠加显示本帧所有 quad 的几何落点（画在 masterFbo 内容之上）
    if (this.debugQuadMvps.length) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.DEPTH_TEST)
      for (const mvp of this.debugQuadMvps) this.debugFillQuad(mvp)
      this.debugQuadMvps = []
    }
    // 主渲染目标 → 默认帧缓冲（v 翻转上屏）
    this.presentToScreen(canvas)
    this.frameIndex += 1
    if (this.debugDraw && this.frameIndex === 10) {
      for (const object of manifest.objects) {
        const mesh = this.modelMeshes.get(object)
        const meshInfo = mesh
          ? `mesh verts=${mesh.positions.length / 3} normals=${mesh.normals.length / 3} idx=${mesh.indices.length}`
          : 'quad'
        console.warn(`[WEScene][draw] obj=${object.name || object.id} visible=${object.visible !== false} origin=[${object.origin.join(',')}] scale=[${object.scale.join(',')}] ${meshInfo}`)
        for (const pass of object.passes) {
          const t0 = pass.textures?.[0]?.textureFile ?? 'NO-TEX'
          console.warn(`  pass=${pass.shaderName} error=${pass.error ?? '-'} blend=${pass.blending} depth=${pass.depthTest}/${pass.depthWrite} tex0=${t0}`)
        }
      }
    }
  }

  private renderObject(
    object: SceneObject,
    viewProjection: Float32Array,
    time: number,
    canvas: HTMLCanvasElement,
    perspectiveViewProjection: Float32Array | null = null,
  ): void {
    // puppet（剪纸骨骼动画）：正交 VP + 蒙皮动态网格（顶点已映射到场景世界空间）
    if (object.puppet) {
      this.renderPuppetObject(object, viewProjection, time, canvas)
      return
    }
    // 粒子系统：instanced billboard（CPU 模拟已在 renderFrame 推进）
    if (object.particle) {
      this.renderParticleObject(object, viewProjection)
      return
    }
    // .mdl 模型对象：透视相机 + mesh 几何，与 2D quad 管线分离
    if (object.model) {
      this.renderMeshObject(object, perspectiveViewProjection, time, canvas)
      return
    }
    // WE 文本对象：canvas 光栅化纹理 + 简单着色 quad
    if (object.text) {
      this.renderTextObject(object, viewProjection)
      return
    }
    const gl = this.gl
    let [w, h] = object.size
    // composelayer size 缺省（[0,0]）= WE 的全屏直通层（_rt_FullFrameBuffer）：quad=视口
    // 全屏（origin 在 ortho/视口中心）。⚠️ 零面积 quad 会让 base pass 的 v_ScreenCoord
    // 恒定 → 快照单点采样成全屏纯色盖屏（雪境 234 全组合层实证，2026-10-22）
    if (object.composeLayer && !(w > 0 && h > 0)) {
      w = this.viewportWorldSize[0]
      h = this.viewportWorldSize[1]
    }
    const [sx, sy] = [object.scale[0] || 1, object.scale[1] || 1]
    const [rx, ry, rz] = object.angles.map((a) => a * DEG2RAD)
    // WE 视差层：offset = -cameraEye.xy * parallaxDepth（depth 0=贴屏幕不动、1=贴世界；
    // 虹夏三个 lense 光斑 depth 高达 33=对鼠标极敏感，主体全部缺省 0 不动）
    let pdx = 0, pdy = 0
    if (object.parallaxDepth && (object.parallaxDepth[0] || object.parallaxDepth[1])) {
      pdx = -this.cameraEye[0] * object.parallaxDepth[0]
      pdy = -this.cameraEye[1] * object.parallaxDepth[1]
    }

    // 模型矩阵：平移(origin+视差) * 旋转(ZYX) * 缩放(尺寸)；角度仅取 Z（2D 场景）
    let model: Float32Array
    if (object.worldMatrix) {
      // parent 链世界变换（server 已含对象自身 origin/angles/scale）→ 视差平移在最外层
      model = mat4Multiply(mat4Translate(pdx, pdy, 0), mat4Multiply(new Float32Array(object.worldMatrix), mat4Scale(w, h, 1)))
    } else {
      model = mat4Translate(object.origin[0] + pdx, object.origin[1] + pdy, object.origin[2])
      if (rz) model = mat4Multiply(model, mat4RotateZ(rz))
      if (ry) model = mat4Multiply(model, mat4RotateZ(0)) // Y/X 旋转在 2D 正交场景无意义，占位保持结构
      const sizeMatrix = mat4Scale(w * sx, h * sy, 1)
      model = mat4Multiply(model, sizeMatrix)
    }
    const modelViewProjection = mat4Multiply(viewProjection, model)
    if (this.debugDraw) {
      // 每帧收集（renderFrame 末尾统一叠加填充）；明细日志仅第 10 帧
      this.debugQuadMvps.push(modelViewProjection)
      if (this.frameIndex === 10) {
        const fmt = (m: Float32Array) => '[' + Array.from(m).map((v) => Math.round(v * 1000) / 1000).join(',') + ']'
        console.warn(`  [quad-geo] obj=${object.name} model=${fmt(model)} mvp=${fmt(modelViewProjection)} size=[${w},${h}] scale=[${sx},${sy}] worldVP=${fmt(viewProjection)}`)
      }
    }

    // composelayer（组合层）：此刻默认帧缓冲仍绑定，先快照「到此为止的合成画面」
    // （WE 的 _rt_FullFrameBuffer 语义），供 base pass 作 tex0。快照失败 → 直通层
    // 画不了有意义的内容，整对象跳过（避免空纹理盖屏）
    let composeTex: WebGLTexture | null = null
    if (object.composeLayer) {
      composeTex = this.captureComposeSnapshot(object, canvas.width, canvas.height)
      if (!composeTex) return
    } else if ((object.colorBlendMode ?? 0) > 0) {
      // WE 对象级 colorBlendMode（genericimage BLENDMODE combo，雪境 312 暗角 SoftLight 实证）：
      // frag 在 shader 内采 g_Texture4 = _rt_FullFrameBuffer（到此对象为止的合成画面）
      // 做 ApplyBlending(mode, screen.rgb, fragColor.rgb, fragColor.a)。同 composelayer 语义，
      // 绘制本对象前快照当前帧缓冲。
      composeTex = this.captureComposeSnapshot(object, canvas.width, canvas.height)
    }

    // 对象纹理（效果 pass 的独立贴图缺失时，服务端已注入对象基础贴图，无需渲染端回退）
    const dumpQuad = this.debugDraw && this.frameIndex === 10
    // 先收集全部可编译 pass，再判定 FBO 链。tex0=null（framebuffer 依赖）的语义：
    // 链中后续 pass → 输入 = 上一 pass 的 FBO 输出（修复）；链首 pass = 全屏后处理
    // 层（雪境 3669680904 id538：8-pass 全 tex0=null，downsample→coc→bokeh 景深链）。
    // ⚠️ 景深链需要主帧缓冲+深度输入，当前转译缺深度 → 链输出白雾盖屏（onlyid=538
    // 纯白实证）→ 链首 null 的后处理对象整对象跳过（hideid=538 场景可见且更干净，
    // bokeh 景深留 v2）；composelayer 的快照基准例外照旧保留。
    const candidates: { pass: ScenePass; compiled: CompiledPass; tex0Null: boolean }[] = []
    for (const pass of object.passes) {
      if (pass.error) { if (dumpQuad) console.warn(`  [quad] pass=${pass.shaderName} SKIP: ${pass.error}`); continue }
      if (EFFECT_SHADER_BLOCKLIST?.test(pass.shaderName)) {
        if (dumpQuad) console.warn(`  [quad] pass=${pass.shaderName} SKIP: 装饰效果降级（黑名单）`)
        continue
      }
      const compiled = this.compilePass(pass)
      if (!compiled) { if (dumpQuad) console.warn(`  [quad] pass=${pass.shaderName} SKIP: compile失败`); continue }
      const tex0Null = Boolean(pass.textures && pass.textures.length > 0 && !pass.textures[0])
      if (tex0Null && dumpQuad) console.warn(`  [quad] pass=${pass.shaderName} tex0-null → FBO 链输入`)
      candidates.push({ pass, compiled, tex0Null })
    }
    // 长装饰链降级：效果 pass 总数 >5 的对象（多层叠加的复杂效果链，如虹夏「衣/头发」
    // 的 waterwaves+opacity 长链、雪境 rw 13-pass 链——转译输出放大错位/暗影，实机对照
    // 原版均为错）只画基底保底正确显示。短链（≤5）已实机验证：芙莉莲书页 2 效果、
    // 雪境 234 调色链 4 效果均正确（2026-10-22）。
    // ⚠️ 必须保留 candidates[0]（基底）：雪境等资产的基底 pass 也在 effects/ 命名空间下，
    // 按 effects/ 过滤会把基底一起剔光 → 整对象不画（v12 雪境全空露出 preview 实证）。
    // 长装饰链降级：效果 pass 总数超限的对象只画基底保底。阈值 8 的依据：虹夏「衣/头发」
    // 6×waterwaves（MASK 推导修复后全链实机正确，2026-10-23）、铃芽「人物」6×waterwaves、
    // 雪境 rw 放行 iris×2 均无伪影；雪境 rw 14 效果链仍被拦（shine/pulse/twirl 等黑名单
    // 外剩余也远超 8）。⚠️ 必须保留 candidates[0]（基底）：雪境等资产的基底 pass 也在
    // effects/ 命名空间下，按 effects/ 过滤会把基底一起剔光 → 整对象不画（v12 实证）。
    const effectCount = candidates.filter((c) => /(?:^|\/)effects\//.test(c.pass.shaderName)).length
    const chainLimit = this.chainLimit ?? 8
    if (effectCount > chainLimit && candidates.length > 1) {
      if (dumpQuad) console.warn(`  [quad] obj=${object.name} 效果链 ${effectCount} pass >${chainLimit} → 降级只画首层基底`)
      candidates.splice(1)
    }
    const useFboChain = candidates.length > 1
    // 链首 tex0=null 的效果链：默认整对象跳过（雪境 538 景深链白雾盖屏实证）。
    // nullChainEnabled 时按两类放行（2026-11-02）：
    // ① 全屏后处理对象（size [0,0]，godrays 516）：全屏几何 + 链首输入=整帧快照；
    // ② 对象级效果链（有实际 size，雪境 425 Album Shadow/437 Albuim Art）：保持对象
    //    quad 几何，链首 tex0=快照中「对象屏幕矩形区域」的拷贝——WE 语义：对象级链的
    //    framebuffer 绑定 = 对象区域副本（对象尺寸 RT），局部 UV 0..1 采样（opacity.vert
    //    实证：v_TexCoord.xy=a_TexCoord、几何=对象 MVP）。
    // 深度依赖链（coc/bokeh，景深散焦）：无真实深度/遮罩绑定必全屏雾（coc 深度源=
    // util/white default + mask 全白 → 最大模糊，2026-10-31/11-01 实证）→ 不放行。
    const depthDependentChain = candidates.some((c) => /coc|bokeh/i.test(c.pass.shaderName))
    const nullChainFix = useFboChain && candidates[0].tex0Null && !object.composeLayer
      && this.nullChainEnabled && !depthDependentChain
    const nullChainFullscreen = nullChainFix && !(w > 0 && h > 0)
    if (nullChainFix && !composeTex) {
      composeTex = this.captureComposeSnapshot(object, canvas.width, canvas.height)
    }
    // 对象级链首输入：快照的对象屏幕矩形区域拷贝（局部 UV 采样用，见上方注释②）
    let nullChainRegionTex: UploadedTexture | null = null
    if (nullChainFix && !nullChainFullscreen && composeTex) {
      nullChainRegionTex = this.captureNullChainRegion(object, composeTex, modelViewProjection, canvas)
    }
    // blend 合成延后：链对象不在基底 pass 做 ApplyBlending（背景快照不进链 FBO，
    // waterflow/scroll 的 UV 位移/回绕只搬运对象自身内容），链后统一合成（见循环后）
    const blendActive = (object.colorBlendMode ?? 0) > 0 && !object.composeLayer && Boolean(composeTex)
    let blendDefer = useFboChain && blendActive
    if (blendDefer) {
      const base = candidates[0]
      const nbPass = this.getNoBlendPass(base.pass)
      const nbCompiled = this.compilePass(nbPass)
      if (nbCompiled) candidates[0] = { ...base, pass: nbPass, compiled: nbCompiled }
      else blendDefer = false
    }
    if (useFboChain && candidates[0].tex0Null && !object.composeLayer && !nullChainFix) return
    const drawable = candidates.filter((c, idx) =>
      !(c.tex0Null && (!useFboChain || idx === 0) && !(object.composeLayer && composeTex) && !nullChainFix))
    if (!drawable.length) return
    // 链末 pass 先写 RGBA8 FBO 再 blit 上屏（见 blitChainToMaster 注释：alpha>1 钳制、
    // 等价 DX9 混合输入钳制；a≤1 常规链数学恒等）。blendDefer 时末 pass 本就写 FBO。
    const lastToFbo = useFboChain && !blendDefer && drawable.length > 1
    let lastBlending = 'normal'
    // composelayer 纯直通（只有快照 base、无任何效果 pass）= 恒等操作：跳过。
    // ⚠️ 不跳过会形成反馈回路——每帧快照含上一帧直通输出，运动物体错位残影
    // （铃芽裙摆融化拖尾 + 顶部灰带实证，2026-10-22）。带效果链的组合层（雪境 234
    // 调色链）不受影响：基础直通恒等，效果链做实际处理。
    if (object.composeLayer && composeTex && drawable.length === 1) return
    let fboRead = 0
    let fboWrite = 1
    const identityModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    // 链首输入快照（bind "previous"）：链第一个效果 pass（di=1）时捕获。
    // ⚠️ 必须声明在循环外：combine 常在 di>1（godrays di=4），变量在循环内会每轮
    // 重置 → combine 的 tex1 "previous" 回退绑 fboReadTex（=光柱图 ≈全黑）→
    // out.a=2×rays.a、blit 后 = master×(1-2×rays.a) → 全画面 ×0.5 暗化
    // （Girl and Samurai v53/v54 实证：快照 61,117,125 → master 27,48,52）。
    let chainInput: UploadedTexture | null = null
    for (let di = 0; di < drawable.length; di++) {
      const { pass, compiled, tex0Null } = drawable[di]
      const isLast = di === drawable.length - 1
      if (isLast) lastBlending = pass.blending || 'normal'
      // 效果 pass（tex0=null 链中后续）：全屏后处理——几何切 v 翻转 quad +
      // MVP=2×identity（[-0.5,0.5] → 全屏 clip），FBO 采样与屏幕坐标一一对应。
      // 若沿用对象 quad MVP，效果 frag 的 v_TexCoord(0..1 局部 UV) 会把整张全屏
      // FBO 压缩采样进对象区域，每过一环内容缩小 (对象高/画布高) 倍
      // （芙莉莲「书」5044×557 双 waterwaves 链两次压缩 → 书页变一条细线，2026-10-22 实证）。
      // 基准材质 pass 仍画对象 quad。
      // ⚠️ composelayer 的所有 pass（base 快照直通 + 效果链）一律全屏 MVP：输入/输出
      // 都是全屏画面，沿用对象 MVP 会按对象 scale 缩放全屏内容（雪境 Clouds scale=[2,2]
      // → 全景放大 2 倍成「特写」，2026-10-23 实证）
      const isFullScreenEffect = (tex0Null && (di > 0 || nullChainFullscreen) && !(object.composeLayer && composeTex))
        || Boolean(object.composeLayer && composeTex)
      // composelayer base（快照直通）：vert 用 a_TexCoord 当几何（自扩全屏）、a_Position 的
      // MVP 投影当屏幕映射（v_ScreenCoord 反查快照区域）——两套坐标在我们 quadVao 的
      // UV 约定（v=0 绑 quad 顶部顶点）下互相镜像 → 用 v 翻转 quad 自补偿（同 puppet 链）
      const isComposeBase = object.composeLayer && composeTex && !isFullScreenEffect
      gl.bindVertexArray(isFullScreenEffect || isComposeBase ? this.flipQuadVao : this.quadVao)
      let fboReadTex: UploadedTexture | null = null
      if (useFboChain) {
        const fbo = this.ensureEffectFbo(canvas.width, canvas.height)
        if (fbo) {
          // blendDefer：末 pass 也写 FBO（链结果供合成 pass 采样，不直接上屏）
          // lastToFbo：末 pass 写 FBO 后经 blitChainToMaster 上屏（alpha 钳制）
          if (!isLast || blendDefer || lastToFbo) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbs[fboWrite])
            gl.viewport(0, 0, fbo.width, fbo.height)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
          } else {
            this.bindScreenTarget()
            gl.viewport(0, 0, canvas.width, canvas.height)
          }
          if (di > 0) {
            // 效果 pass 的 g_Texture0 恒为 framebuffer（上一 pass 输出），
            // 覆盖服务端可能填入的基础贴图
            fboReadTex = { texture: fbo.texs[fboRead], width: fbo.width, height: fbo.height }
            // 第一个效果 pass：当前链 FBO = 基础 pass 输出 → blit 到快照
            // （后续 combine 的 previous 槽采样它，而非被链覆盖的 ping-pong 缓冲）
            // ⚠️ nullChainFullscreen 链（godrays 等）没有基底 pass：di=0 就是链首效果，
            // 此时链 FBO = 链首效果输出（downsample2 是 bright-pass，≈全黑！），
            // 绝不能当 previous——previous = 放行时捕获的整帧快照 → 直接绑定，
            // 不做 di===1 的 FBO blit（v54：此前把 bright-pass 当背景 → 全画面 ×0.5 暗化实证）
            // 对象级链（nullChainRegionTex 路径）保持 FBO blit：di=0 输出 = 对象区域的
            // masked 拷贝（对象级链的「基底渲染」），后续 blurprecise 的 previous 槽采它
            if (di === 1 && nullChainFullscreen && composeTex) {
              chainInput = { texture: composeTex, width: canvas.width, height: canvas.height }
            } else if (di === 1) {
              const snap = this.ensureChainInputSnapshot(canvas.width, canvas.height)
              if (snap) {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fbs[fboRead])
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, snap.fbo)
                gl.blitFramebuffer(0, 0, fbo.width, fbo.height, 0, 0, snap.width, snap.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
                // 恢复本 pass 的绘制目标（blit 改写了 DRAW 绑定）
                if (isLast && !blendDefer && !lastToFbo) this.bindScreenTarget()
                else gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbs[fboWrite])
                chainInput = { texture: snap.tex, width: snap.width, height: snap.height }
              }
            }
          }
        }
      }

      gl.useProgram(compiled.program)

      // 引擎 uniform（全屏效果 pass 与 composelayer base 的 MVP=2×identity，model 用
      // identity 占位）。⚠️ composelayer base（快照直通）必须同样走全屏 MVP：快照=当前
      // 全帧缓冲，直通=恒等映射——沿用对象 MVP 会把快照按对象 scale 放大重画
      // （雪境 Clouds scale=[2,2] → 全景放大 2 倍成「特写」，且效果链编译偶发失败时
      // drawable=1 走纯直通跳过 → 时好时坏假象，2026-10-23 实证）
      const useFullScreenPass = isFullScreenEffect || isComposeBase
      this.setBuiltinUniforms(
        compiled,
        useFullScreenPass ? identityModel : model,
        viewProjection,
        useFullScreenPass ? FULL_SCREEN_MVP : modelViewProjection,
        time,
        canvas,
      )
      // 材质常量 uniform（{"material":"..."} 绑定）
      this.setConstantUniforms(compiled, pass, object.alpha ?? 1)

      // 贴图绑定：pass.textures 顺序对应 g_Texture0..N；槽 0 在效果链中替换为 FBO 输出；
      // colorBlendMode 对象的 g_Texture4 = 帧缓冲快照（ApplyBlending 的 A 输入）
      const textures = pass.textures || []
      const blendModeActive = (object.colorBlendMode ?? 0) > 0 && Boolean(composeTex)
      let slotCount = Math.max(textures.length, 1, blendModeActive ? 5 : 0)
      // 链内效果 pass 的槽位上限以编译后活跃 sampler 为准：shine_combine 的
      // g_Texture1 = effect.json bind "previous"（对象基底渲染），服务端 textures 数组
      // 只有 [null] 一槽 → 不扩槽则 tex1 采白图 → combine 把主体混没成暗影
      // （2026-10-23 雪境 rw 实证）
      if (fboReadTex) {
        let needed = slotCount
        while (compiled.uniformLocations.has('g_Texture' + needed)) needed++
        slotCount = Math.max(slotCount, needed)
      }
      let unit = 0
      for (let i = 0; i < slotCount; i++) {
        const location = compiled.uniformLocations.get('g_Texture' + i)
        if (!location) continue
        let uploaded: UploadedTexture | null = null
        if (i === 0 && fboReadTex) {
          uploaded = fboReadTex
        } else if (i === 0 && object.composeLayer && composeTex && !textures[i]) {
          // composelayer base pass：tex0 = 帧缓冲快照（_rt_FullFrameBuffer 直通）
          uploaded = { texture: composeTex, width: canvas.width, height: canvas.height }
        } else if (i === 0 && nullChainFullscreen && composeTex && !textures[i]) {
          // 链首 tex0=null 放行·全屏后处理对象（godrays 等）：tex0 = 绘制前帧快照
          uploaded = { texture: composeTex, width: canvas.width, height: canvas.height }
        } else if (i === 0 && nullChainRegionTex && !textures[i]) {
          // 链首 tex0=null 放行·对象级效果链（雪境 425/437）：tex0 = 快照的对象屏幕
          // 矩形区域拷贝（局部 UV 0..1 采样，WE 对象级链 framebuffer 语义）
          uploaded = nullChainRegionTex
        } else if (i === 4 && blendModeActive && composeTex) {
          // colorBlendMode：g_Texture4 default "_rt_FullFrameBuffer"（genericimage3/4.frag
          // #if BLENDMODE 块）→ 帧缓冲快照；材质 textures 只有 1 槽（雪境 312 实测）
          uploaded = { texture: composeTex, width: canvas.width, height: canvas.height }
        } else {
          const info = textures[i] ?? null
          uploaded = info ? (this.textureCache.get(info.textureFile) || null) : null
          // 效果链内的 null 槽 = effect.json bind 引用。i>0 的 null 槽语义 =
          // "previous"（进入整个效果前的链首输入：shine_combine tex1、blur_combine
          // tex2、blurprecise pass1 tex1）→ 绑链首快照；快照缺失时回退链读缓冲。
          // 不能落白图（blur 的 albedo.a = prev.a 读到 1 → 全屏不透明黑剪影）
          if (!uploaded && fboReadTex && di > 0) uploaded = chainInput ?? fboReadTex
        }
        if (this.debugTextures && i === 0) {
          console.warn('[WEScene][dbg] bind', object.name, i === 0 && fboReadTex ? 'FBO-CHAIN' : (textures[i]?.textureFile ?? 'NO-INFO'), '→', uploaded ? uploaded.width + 'x' + uploaded.height : 'WHITE-PLACEHOLDER')
        }
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, uploaded?.texture || this.whiteTexture!)
        gl.uniform1i(location, unit)
        this.setTextureUniforms(compiled, i, uploaded)
        unit += 1
      }

      // 混合模式：链内缓冲内容 = 预乘 alpha（基准 pass 直通色经 SRC_ALPHA 混合画在
      // 透明黑上恰好预乘）。效果 pass 采样链（预乘）输出仍预乘 → 用预乘混合；
      // 基准 pass 输出直通色 → 保持直通混合（画上黑底即完成预乘）。
      if (useFboChain && di > 0) this.applyBlendingChain(pass.blending)
      else this.applyBlending(pass.blending)

      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)

      if (useFboChain && (!isLast || blendDefer || lastToFbo)) {
        fboRead = fboWrite
        fboWrite = 1 - fboWrite
      }
    }
    if (useFboChain) this.bindScreenTarget()
    // 链末结果 blit 上屏：RGBA8 已钳 alpha（>1 → 1，DX9 混合输入钳制等价），见 lastToFbo
    if (lastToFbo) {
      const fbo = this.ensureEffectFbo(canvas.width, canvas.height)
      if (fbo) this.blitChainToMaster(fbo.texs[fboRead], lastBlending)
    }
    // blend 合成延后：链结果（fboRead=末 pass 输出）× 对象绘制前的帧快照，
    // 按引擎 ApplyBlending(mode) 公式合成上屏（2026-10-30）
    if (blendDefer && composeTex) {
      const fbo = this.ensureEffectFbo(canvas.width, canvas.height)
      if (fbo) this.drawBlendComposite(fbo.texs[fboRead], composeTex, object.colorBlendMode ?? 0, canvas)
    }
  }

  /**
   * puppet 对象绘制：复用 quad 材质 pass 管线（含 FBO 效果链），但几何来自
   * 每帧 CPU 蒙皮的动态 VBO，顶点已在场景世界空间（model = identity）。
   * 绘制完恢复 quad VAO（动态 VAO 与 quad 布局不同，不能让后续 quad 对象沿用）。
   */
  private renderPuppetObject(
    object: SceneObject,
    viewProjection: Float32Array,
    time: number,
    canvas: HTMLCanvasElement,
  ): void {
    const gl = this.gl
    const state = this.puppetStates.get(object)
    if (!state) return
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const modelViewProjection = viewProjection

    const dumpQuad = this.debugDraw && this.frameIndex === 10
    const candidates: { pass: ScenePass; compiled: CompiledPass; tex0Null: boolean }[] = []
    for (const pass of object.passes) {
      if (pass.error) { if (dumpQuad) console.warn(`  [puppet] pass=${pass.shaderName} SKIP: ${pass.error}`); continue }
      if (EFFECT_SHADER_BLOCKLIST?.test(pass.shaderName)) {
        if (dumpQuad) console.warn(`  [puppet] pass=${pass.shaderName} SKIP: 装饰效果降级（黑名单）`)
        continue
      }
      const compiled = this.compilePass(pass)
      if (!compiled) { if (dumpQuad) console.warn(`  [puppet] pass=${pass.shaderName} SKIP: compile失败`); continue }
      const tex0Null = Boolean(pass.textures && pass.textures.length > 0 && !pass.textures[0])
      candidates.push({ pass, compiled, tex0Null })
    }
    // 长装饰链降级（与 quad 分支同策略、同口径）：效果 pass 总数 >5 → 保留首层基底、
    // 剔除其余，规避放大倍率错位等存量 waterwaves 长链问题（雪境 rw 13-pass 实证）。
    // ⚠️ 基底 pass 也可能在 effects/ 命名空间下，只能 splice(1) 不能按名过滤。
    const effectCount = candidates.filter((c) => /(?:^|\/)effects\//.test(c.pass.shaderName)).length
    const chainLimitPuppet = this.chainLimit ?? 8
    if (effectCount > chainLimitPuppet && candidates.length > 1) {
      if (dumpQuad) console.warn(`  [puppet] obj=${object.name} 效果链 ${effectCount} pass >${chainLimitPuppet} → 降级只画首层基底`)
      candidates.splice(1)
    }
    const useFboChain = candidates.length > 1
    const drawable = candidates.filter((c, idx) => !(c.tex0Null && (!useFboChain || idx === 0)))
    if (!drawable.length) return
    // 链末 pass 先写 RGBA8 FBO 再 blit 上屏（同 quad 链 lastToFbo：alpha 钳制等价
    // DX9 混合输入钳制，见 blitChainToMaster）
    const lastToFbo = useFboChain && drawable.length > 1
    let lastBlending = 'normal'
    // 链首输入快照声明在循环外（同 quad 链 chainInput：combine 在 di>1 时也要采样）
    let chainInput: UploadedTexture | null = null
    let fboRead = 0
    let fboWrite = 1
    gl.bindVertexArray(state.vao)
    for (let di = 0; di < drawable.length; di++) {
      const { pass, compiled, tex0Null } = drawable[di]
      const isLast = di === drawable.length - 1
      if (isLast) lastBlending = pass.blending || 'normal'
      // 效果 pass（tex0=null，FBO 链输入）是全屏后处理：几何用 v 翻转 quad +
      // MVP = 2×identity（[-0.5,0.5] → 全屏 clip），基准材质 pass 画 puppet 网格
      gl.bindVertexArray(tex0Null ? this.flipQuadVao : state.vao)
      let fboReadTex: UploadedTexture | null = null
      if (useFboChain) {
        const fbo = this.ensureEffectFbo(canvas.width, canvas.height)
        if (fbo) {
          if (!isLast || lastToFbo) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbs[fboWrite])
            gl.viewport(0, 0, fbo.width, fbo.height)
            gl.clearColor(0, 0, 0, 0)
            gl.clear(gl.COLOR_BUFFER_BIT)
          } else {
            this.bindScreenTarget()
            gl.viewport(0, 0, canvas.width, canvas.height)
          }
          if (di > 0) {
            fboReadTex = { texture: fbo.texs[fboRead], width: fbo.width, height: fbo.height }
            // 第一个效果 pass：链首输入 blit 到快照（previous 槽采样用，同 quad 链）
            if (di === 1) {
              const snap = this.ensureChainInputSnapshot(canvas.width, canvas.height)
              if (snap) {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fbs[fboRead])
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, snap.fbo)
                gl.blitFramebuffer(0, 0, fbo.width, fbo.height, 0, 0, snap.width, snap.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
                if (isLast && !lastToFbo) this.bindScreenTarget()
                else gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbs[fboWrite])
                chainInput = { texture: snap.tex, width: snap.width, height: snap.height }
              }
            }
          }
        }
      }

      gl.useProgram(compiled.program)
      // 效果 pass（全屏 quad 后处理）：把 [-0.5,0.5] quad 顶点放大到全屏 clip
      // （g_ModelViewProjectionMatrix = 2×identity），FBO 采样与屏幕坐标一一对应；
      // 基准材质 pass 画世界空间网格，直接用 viewProjection（model=identity）
      let passMvp = modelViewProjection
      if (tex0Null) {
        // [-0.5,0.5] quad 顶点 → 全屏 clip [-1,1]
        passMvp = FULL_SCREEN_MVP
      }
      this.setBuiltinUniforms(compiled, identity, viewProjection, passMvp, time, canvas)
      this.setConstantUniforms(compiled, pass)

      const textures = pass.textures || []
      // 链内效果 pass 槽位上限以编译后活跃 sampler 为准（同 quad 链：combine 的
      // tex1=previous 必须绑链输入，见 drawObjectQuad 内注释）
      let slotCount = Math.max(textures.length, 1)
      if (fboReadTex) {
        let needed = slotCount
        while (compiled.uniformLocations.has('g_Texture' + needed)) needed++
        slotCount = Math.max(slotCount, needed)
      }
      let unit = 0
      for (let i = 0; i < slotCount; i++) {
        const location = compiled.uniformLocations.get('g_Texture' + i)
        if (!location) continue
        let uploaded: UploadedTexture | null = null
        if (i === 0 && fboReadTex) {
          uploaded = fboReadTex
        } else {
          const info = textures[i] ?? null
          uploaded = info ? (this.textureCache.get(info.textureFile) || null) : null
          // i>0 的 null 槽 = bind "previous"（链首输入，同 quad 链）
          if (!uploaded && fboReadTex && di > 0) uploaded = chainInput ?? fboReadTex
        }
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, uploaded?.texture || this.whiteTexture!)
        gl.uniform1i(location, unit)
        this.setTextureUniforms(compiled, i, uploaded)
        unit += 1
      }

      if (useFboChain && di > 0) this.applyBlendingChain(pass.blending)
      else this.applyBlending(pass.blending)

      gl.drawElements(gl.TRIANGLES, tex0Null ? 6 : state.indexCount, gl.UNSIGNED_SHORT, 0)

      if (useFboChain && (!isLast || lastToFbo)) {
        fboRead = fboWrite
        fboWrite = 1 - fboWrite
      }
    }
    if (useFboChain) this.bindScreenTarget()
    // 链末结果 blit 上屏（同 quad 链：RGBA8 已钳 alpha，见 blitChainToMaster）
    if (lastToFbo) {
      const fbo = this.ensureEffectFbo(canvas.width, canvas.height)
      if (fbo) this.blitChainToMaster(fbo.texs[fboRead], lastBlending)
    }
    // 恢复 quad VAO：后续 quad 对象的绘制依赖它（renderFrame 循环内不重绑）
    gl.bindVertexArray(this.quadVao)
  }

  /**
   * 模型对象绘制：透视 VP × 模型变换（T·Rz·Ry·Rx·S）。
   * 材质 shader（technoglow/technoorbit 等）的顶点级动画（g_Time 驱动）保持原样生效，
   * 几何来自 mdl 顶点缓冲；深度按材质 pass 的 depthtest 开关。
   */
  private renderMeshObject(
    object: SceneObject,
    perspectiveViewProjection: Float32Array | null,
    time: number,
    canvas: HTMLCanvasElement,
  ): void {
    const gl = this.gl
    if (!perspectiveViewProjection) return
    const meshVao = this.ensureMeshVao(object)
    if (!meshVao) return

    // 模型矩阵：server 已按 parent 链算好 worldMatrix（含自身 origin/angles/scale）
    // 时直接用（陨石群/太阳系父子变换）；否则本地 T·Rz·Ry·Rx·S 兜底
    let model: Float32Array
    if (object.worldMatrix) {
      model = new Float32Array(object.worldMatrix)
    } else {
      const [ox, oy, oz] = object.origin
      const [rx, ry, rz] = object.angles.map((a) => a * DEG2RAD)
      const [sx, sy, sz] = object.scale
      model = mat4Translate(ox, oy, oz)
      if (rz) model = mat4Multiply(model, mat4RotateZ(rz))
      if (ry) model = mat4Multiply(model, mat4RotateY(ry))
      if (rx) model = mat4Multiply(model, mat4RotateX(rx))
      model = mat4Multiply(model, mat4Scale(sx || 1, sy || 1, sz || 1))
    }
    const modelViewProjection = mat4Multiply(perspectiveViewProjection, model)

    gl.bindVertexArray(meshVao.vao)
    const dump = this.debugDraw && this.frameIndex === 10
    for (const pass of object.passes) {
      if (pass.error) { if (dump) console.warn(`  [mesh] pass=${pass.shaderName} SKIP: ${pass.error}`); continue }
      if (pass.textures && pass.textures.length > 0 && !pass.textures[0]) { if (dump) console.warn(`  [mesh] pass=${pass.shaderName} SKIP: tex0-null(framebuffer依赖)`); continue }
      const compiled = this.compilePass(pass)
      if (!compiled) { if (dump) console.warn(`  [mesh] pass=${pass.shaderName} SKIP: compile失败`); continue }

      gl.useProgram(compiled.program)
      this.setBuiltinUniforms(compiled, model, perspectiveViewProjection, modelViewProjection, time, canvas)
      this.setConstantUniforms(compiled, pass)
      if (dump) console.warn(`  [mesh] DRAWN pass=${pass.shaderName} idx=${meshVao.indexCount}`)

      const textures = pass.textures || []
      let unit = 0
      for (let i = 0; i < Math.max(textures.length, 1); i++) {
        const info = textures[i] ?? null
        const location = compiled.uniformLocations.get('g_Texture' + i)
        if (!location) continue
        const uploaded = info ? (this.textureCache.get(info.textureFile) || null) : null
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, uploaded?.texture || this.whiteTexture!)
        gl.uniform1i(location, unit)
        this.setTextureUniforms(compiled, i, uploaded)
        unit += 1
      }

      this.applyBlending(pass.blending)
      // 深度状态按材质 pass（WE 模型材质常见 depthtest disabled + additive 的发光壳）
      if (pass.depthTest) {
        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(pass.depthWrite)
      } else {
        gl.disable(gl.DEPTH_TEST)
        gl.depthMask(true)
      }

      gl.drawElements(gl.TRIANGLES, meshVao.indexCount, meshVao.indexType ?? gl.UNSIGNED_SHORT, 0)
    }
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.bindVertexArray(null)
  }

  /**
   * mesh 场景的透视取景：以顶点数最多的 mesh 为主体（dna=螺旋、demon_core=核心、
   * fantasticcar=车身），相机摆在主体前方 distance = radius/tan(fov/2)·1.22 处，
   * 保证任何尺度的模型都充满画面。结果按 manifest 引用缓存。
   */
  private resolveMeshFocus(manifest: SceneManifest): { center: [number, number, number]; radius: number } {
    if (this.meshFocus && this.meshFocusKey === manifest) return this.meshFocus
    let best: SceneObject | null = null
    let bestMesh: ParsedModelMesh | null = null
    for (const object of manifest.objects) {
      const mesh = this.modelMeshes.get(object)
      if (!mesh?.positions?.length) continue
      // 背景包围体（backgroundsphere 等）不能当取景主体：它常比主角顶点更多，
      // 会让相机拉得过远（demon_core 实测：主体 core 缩成小球，2026-10-21）
      if (/background/i.test(object.name)) continue
      if (!bestMesh || mesh.positions.length > bestMesh.positions.length) {
        best = object
        bestMesh = mesh
      }
    }
    let focus: { center: [number, number, number]; radius: number }
    if (!best || !bestMesh) {
      focus = { center: [0, 0, 0], radius: 3 }
    } else {
      const p = bestMesh.positions
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i]
        if (p[i] > maxX) maxX = p[i]
        if (p[i + 1] < minY) minY = p[i + 1]
        if (p[i + 1] > maxY) maxY = p[i + 1]
        if (p[i + 2] < minZ) minZ = p[i + 2]
        if (p[i + 2] > maxZ) maxZ = p[i + 2]
      }
      const scale = best.scale && best.scale.length === 3 ? best.scale : [1, 1, 1]
      const maxScale = Math.max(Math.abs(scale[0]) || 1, Math.abs(scale[1]) || 1, Math.abs(scale[2]) || 1)
      // 模型变换为 T·Rz·Ry·Rx·S，官方模型场景旋转普遍为 0 → 中心缩放+平移近似即可
      focus = {
        center: [
          ((minX + maxX) / 2) * (scale[0] || 1) + best.origin[0],
          ((minY + maxY) / 2) * (scale[1] || 1) + best.origin[1],
          ((minZ + maxZ) / 2) * (scale[2] || 1) + best.origin[2],
        ],
        radius: (Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2) * maxScale,
      }
    }
    this.meshFocus = focus
    this.meshFocusKey = manifest
    return focus
  }

  private applyBlending(blending: string): void {
    const gl = this.gl
    switch (blending) {
      case 'additive':
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
        break
      case 'translucent':
        // WE 纹理为非预乘 RGBA（透明区 RGB 保留原色），预乘语义 (ONE, ...) 会把
        // 透明区颜色全量加进画面 → 用非预乘标准混合
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        break
      case 'multiply':
        gl.blendFunc(gl.DST_COLOR, gl.ZERO)
        break
      case 'normal':
      default:
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        break
    }
  }

  /**
   * FBO 效果链专用混合：链内缓冲内容是「直通混合画在透明黑上」= 恰好预乘 alpha，
   * 高斯模糊后仍是预乘 → 链内所有 pass（含最后画屏的一环）都用预乘混合。
   * 用非预乘直通混合画预乘内容会二次乘 alpha → 模糊边缘发黑（2026-10-21 实测）。
   */
  private applyBlendingChain(blending: string): void {
    const gl = this.gl
    switch (blending) {
      case 'additive':
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE)
        break
      case 'multiply':
        gl.blendFunc(gl.DST_COLOR, gl.ZERO)
        break
      case 'normal':
      case 'translucent':
      default:
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        break
    }
  }

  private setBuiltinUniforms(
    compiled: CompiledPass,
    model: Float32Array,
    viewProjection: Float32Array,
    modelViewProjection: Float32Array,
    time: number,
    canvas: HTMLCanvasElement,
  ): void {
    const gl = this.gl
    const locations = compiled.uniformLocations
    const setMat = (name: string, value: Float32Array) => {
      const loc = locations.get(name)
      if (loc) gl.uniformMatrix4fv(loc, false, mat4TransposedForUpload(value))
    }
    setMat('g_ModelViewProjectionMatrix', modelViewProjection)
    setMat('g_ModelMatrix', model)
    setMat('g_ModelViewMatrix', modelViewProjection)
    setMat('g_ViewProjectionMatrix', viewProjection)

    // 法线矩阵：shader 用行向量 mul(n, g_NormalModelMatrix)（= 列数学 Nᵀ·n）。
    // 要得到标准法线变换 (L⁻¹)ᵀ·n，需 N = L⁻¹（L = 模型线性部分 3×3，列主序）。
    // ⚠️ 缺省全 0 → normalize(0)=NaN → 光照输出 NaN 钳成全黑（土星 3589454154 实测）
    const nmLoc = locations.get('g_NormalModelMatrix')
    if (nmLoc) {
      const a00 = model[0], a01 = model[1], a02 = model[2]
      const a10 = model[4], a11 = model[5], a12 = model[6]
      const a20 = model[8], a21 = model[9], a22 = model[10]
      const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20)
      if (Math.abs(det) > 1e-12) {
        const inv = new Float32Array([
          (a11 * a22 - a12 * a21) / det, (a02 * a21 - a01 * a22) / det, (a01 * a12 - a02 * a11) / det,
          (a12 * a20 - a10 * a22) / det, (a00 * a22 - a02 * a20) / det, (a02 * a10 - a00 * a12) / det,
          (a10 * a21 - a11 * a20) / det, (a01 * a20 - a00 * a21) / det, (a00 * a11 - a01 * a10) / det,
        ])
        gl.uniformMatrix3fv(nmLoc, false, inv)
      } else {
        gl.uniformMatrix3fv(nmLoc, false, [1, 0, 0, 0, 1, 0, 0, 0, 1])
      }
    }

    const timeLoc = locations.get('g_Time')
    if (timeLoc) gl.uniform1f(timeLoc, time)

    const screenLoc = locations.get('g_Screen')
    if (screenLoc) gl.uniform3f(screenLoc, canvas.width, canvas.height, canvas.width / canvas.height)

    // SPRITESHEET(genericimage2) 的 UV 仿射：无动画驱动时给单位变换（显示整张 sheet）
    const transLoc = locations.get('g_Texture0Translation')
    if (transLoc) gl.uniform2f(transLoc, 0, 0)
    const rotLoc = locations.get('g_Texture0Rotation')
    if (rotLoc) gl.uniform4f(rotLoc, 1, 0, 0, 1)

    // WE 效果纹理投影矩阵（视差/投影类效果用，如 depthparallax）：无值时引擎
    // 源码里 CAST3X3(rot)→normalize(0)=NaN → 采样塌缩纯色（雪境背景实证），兜底单位阵
    const etpLoc = locations.get('g_EffectTextureProjectionMatrix')
    if (etpLoc) gl.uniformMatrix4fv(etpLoc, false, mat4TransposedForUpload(EFFECT_TEX_PROJECTION))
    const etpiLoc = locations.get('g_EffectTextureProjectionMatrixInverse')
    if (etpiLoc) gl.uniformMatrix4fv(etpiLoc, false, mat4TransposedForUpload(EFFECT_TEX_PROJECTION))
    // 鼠标视差输入（WE 语义：0..1 归一化，g_ParallaxPosition*2-1 进 shader）
    const parallaxLoc = locations.get('g_ParallaxPosition')
    if (parallaxLoc) gl.uniform2f(parallaxLoc, this.pointerPos[0], this.pointerPos[1])

    const aspect = canvas.width / canvas.height
    const vpLoc = locations.get('g_ViewRight')
    if (vpLoc) gl.uniform3f(vpLoc, aspect, 0, 0)
    const vuLoc = locations.get('g_ViewUp')
    if (vuLoc) gl.uniform3f(vuLoc, 0, 1, 0)

    const eyeLoc = locations.get('g_EyePosition')
    if (eyeLoc) gl.uniform3f(eyeLoc, this.cameraEye[0], this.cameraEye[1], this.cameraEye[2])

    // WE 模型光照系统（generic/core 等标准材质 shader）：
    // 点光 → g_LPoint_Origin/Color 槽；方向光 → g_LDirectional_Direction/Color 槽
    // （WE scene.json ldirectional 的 origin 是光行进方向，shader 取表面→光 = -方向）。
    // 无任何光源 → 「头灯 + 顶部补光」近似布光（相对相机，适配不同场景单位尺度）。
    const [ex, ey, ez] = this.cameraEye
    const fallbackPositions = [ex, ey + 2, ez, ex + 3, ey + 1, ez, ex - 3, ey + 1, ez, ex, ey - 1, ez + 3]
    const fallbackColors = [1, 1, 1, 8, 1, 1, 1, 8, 1, 1, 1, 8, 1, 1, 1, 8]
    const positions = new Float32Array(fallbackPositions)
    const colors = new Float32Array(fallbackColors)
    const dirDirections = new Float32Array(16)
    const dirColors = new Float32Array(16)
    let pointCount = 0
    let dirCount = 0
    if (this.sceneLights.length > 0) {
      positions.fill(0)
      colors.fill(0)
    }
    for (const light of this.sceneLights) {
      if (light.kind === 'ldirectional') {
        if (dirCount >= 4) continue
        const [dx, dy, dz] = light.origin
        const len = Math.hypot(dx, dy, dz) || 1
        dirDirections[dirCount * 4] = -dx / len
        dirDirections[dirCount * 4 + 1] = -dy / len
        dirDirections[dirCount * 4 + 2] = -dz / len
        dirColors[dirCount * 4] = light.color[0] * light.intensity
        dirColors[dirCount * 4 + 1] = light.color[1] * light.intensity
        dirColors[dirCount * 4 + 2] = light.color[2] * light.intensity
        dirCount += 1
      } else {
        if (pointCount >= 4) continue
        positions[pointCount * 3] = light.origin[0]
        positions[pointCount * 3 + 1] = light.origin[1]
        positions[pointCount * 3 + 2] = light.origin[2]
        colors[pointCount * 4] = light.color[0] * light.intensity
        colors[pointCount * 4 + 1] = light.color[1] * light.intensity
        colors[pointCount * 4 + 2] = light.color[2] * light.intensity
        colors[pointCount * 4 + 3] = light.radius
        pointCount += 1
      }
    }
    const lightsLoc = locations.get('g_LightsPosition')
    if (lightsLoc) gl.uniform3fv(lightsLoc, positions)
    const lightColorLoc = locations.get('g_LightsColorRadius')
    if (lightColorLoc) {
      // w = 半径：0 会进 ComputeLightSpecular 的除法产生 NaN → 光照输出黑；给有限值
      gl.uniform4fv(lightColorLoc, colors)
    }
    // LightingV1 模块（PBR 材质 generic4/genericimage4 的 #require LightingV1 注入体，
    // 模块源码自 wallpaper64.exe 二进制还原）：g_LPoint_Origin=(xyz, exponent=1)、
    // g_LPoint_Color=(rgb×intensity, radius)、g_LDirectional_Direction=(xyz, 0)、
    // g_LDirectional_Color=(rgb×intensity, 0)。模块按 lightColor==0 跳过该槽（无 NaN）。
    const pointOriginLoc = locations.get('g_LPoint_Origin')
    if (pointOriginLoc) {
      const pointOrigin = new Float32Array(16)
      for (let i = 0; i < 4; i++) {
        pointOrigin[i * 4] = positions[i * 3]
        pointOrigin[i * 4 + 1] = positions[i * 3 + 1]
        pointOrigin[i * 4 + 2] = positions[i * 3 + 2]
        pointOrigin[i * 4 + 3] = colors[i * 4] || colors[i * 4 + 1] || colors[i * 4 + 2] ? 1 : 0
      }
      gl.uniform4fv(pointOriginLoc, pointOrigin)
      const pointColorLoc = locations.get('g_LPoint_Color')
      if (pointColorLoc) gl.uniform4fv(pointColorLoc, colors)
    }
    const dirDirLoc = locations.get('g_LDirectional_Direction')
    if (dirDirLoc) {
      gl.uniform4fv(dirDirLoc, dirDirections)
      const dirColorLoc = locations.get('g_LDirectional_Color')
      if (dirColorLoc) gl.uniform4fv(dirColorLoc, dirColors)
    }
    const ambientLoc = locations.get('g_LightAmbientColor')
    if (ambientLoc) {
      const a = this.manifest?.scene.ambientColor
      if (a && a.length >= 3) gl.uniform3f(ambientLoc, a[0], a[1], a[2])
      else gl.uniform3f(ambientLoc, 0.3, 0.3, 0.4)
    }
    const skylightLoc = locations.get('g_LightSkylightColor')
    if (skylightLoc) {
      const s = this.manifest?.scene.skylightColor
      if (s && s.length >= 3) gl.uniform3f(skylightLoc, s[0], s[1], s[2])
      else gl.uniform3f(skylightLoc, 1, 1, 1)
    }

    // WE 音频响应 uniform：g_AudioLoudness = 全频均值；g_Audio16/32/64/96 = N 段响度
    // （spectrumBus rAF 每帧推送 64 bins 0..1；无音频时全 0，WE 静置语义一致）
    const audioLoc = locations.get('g_AudioLoudness')
    if (audioLoc) {
      const spectrum = this.audioSpectrum
      let loudness = 0
      if (spectrum && spectrum.length > 0) {
        let sum = 0
        for (let index = 0; index < spectrum.length; index += 1) sum += spectrum[index]
        loudness = sum / spectrum.length
      }
      gl.uniform1f(audioLoc, loudness)
    }
    for (const bandCount of [16, 32, 64, 96]) {
      const bandLoc = locations.get(`g_Audio${bandCount}`)
      if (bandLoc) gl.uniform1fv(bandLoc, this.fillAudioBands(bandCount))
    }
    // 工坊音频可视化着色器的声道频谱数组（g_AudioSpectrum64Left/Right，vec4[N/4] 打包 =
    // 连续 N 个 float；左右声道同源mono 频谱）。鸣潮 3615984066 audio-ring 实测。
    for (const [name, location] of locations) {
      const match = /^g_AudioSpectrum(\d+)(?:Left|Right)?$/.exec(name)
      if (match) gl.uniform1fv(location, this.fillAudioBands(Number(match[1])))
    }
    const userLoudnessLoc = locations.get('g_UserLoudness')
    if (userLoudnessLoc) gl.uniform1f(userLoudnessLoc, 0)
  }

  /** 音频响应入口：WallpaperEngineSceneCanvas 订阅 spectrumBus 后每帧调用 */
  setAudioSpectrum(spectrum: Float32Array | null): void {
    if (!this.audioReactiveEnabled) return
    this.audioSpectrum = spectrum
  }

  /** 64 bin 频谱 → N 段均值重采样（g_AudioN；数组缓存复用） */
  private fillAudioBands(count: number): Float32Array {
    let bands = this.audioBandsCache.get(count)
    if (!bands) {
      bands = new Float32Array(count)
      this.audioBandsCache.set(count, bands)
    }
    const spectrum = this.audioSpectrum
    if (!spectrum || spectrum.length === 0) {
      bands.fill(0)
      return bands
    }
    for (let index = 0; index < count; index += 1) {
      const start = Math.floor((index / count) * spectrum.length)
      const end = Math.max(start + 1, Math.floor(((index + 1) / count) * spectrum.length))
      let sum = 0
      for (let cursor = start; cursor < end; cursor += 1) sum += spectrum[cursor] ?? 0
      bands[index] = sum / (end - start)
    }
    return bands
  }

  /**
   * 材质常量：constants 键 = uniform 注释里的 material 名。
   * objectAlpha = WE 对象级 alpha（scene.json obj.alpha）：乘进 g_Color* vec4 的 a 分量
   * （genericimage4 `color = tex * g_Color4`，雪境 312 暗角 0.37 实证——缺省 1 时暗角
   * 全强度叠加把全景压暗成「精灵特写」）
   */
  private setConstantUniforms(compiled: CompiledPass, pass: ScenePass, objectAlpha = 1): void {
    const gl = this.gl
    for (const meta of compiled.uniformMetas) {
      if (!meta.material) {
        // flat 等 shader 的 uniform 无 material 注释 → constants 直接按 uniform 名挂
        // （solidlayer 天空层的 g_Color/g_Alpha，2026-10-21）
        const direct: number | string | undefined = pass.constants[meta.name]
        const directLoc = compiled.uniformLocations.get(meta.name)
        if (direct !== undefined && directLoc) {
          if (typeof direct === 'number') {
            gl.uniform1f(directLoc, direct)
          } else {
            const parts = String(direct).trim().split(/\s+/).map(Number)
            if (!parts.some((v) => !Number.isFinite(v))) {
              if (meta.type === 'vec2') gl.uniform2f(directLoc, parts[0], parts[1] ?? parts[0])
              else if (meta.type === 'vec3') gl.uniform3f(directLoc, parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0])
              else if (meta.type === 'vec4') gl.uniform4f(directLoc, parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? 1)
              else if (meta.type === 'float') gl.uniform1f(directLoc, parts[0])
            }
          }
          continue
        }
        // 无 material 绑定的 g_Color* vec4（如 genericimage2 VERSION≥2 的 g_Color4 整体 tint）
        // 在 WE 引擎里默认白色；GLSL 默认 0 会把画面染成全黑（2026-10-20 razer_bedroom 黑屏根因）。
        // a 分量乘对象级 alpha（colorBlendMode 的 ApplyBlending opacity 也取它）
        if (meta.type === 'vec4' && /^g_Color/i.test(meta.name)) {
          const loc = compiled.uniformLocations.get(meta.name)
          if (loc) gl.uniform4f(loc, 1, 1, 1, objectAlpha)
        }
        continue
      }
      let raw: number | string | undefined = pass.constants[meta.material]
      if (raw === undefined && typeof meta.default === 'string') {
        // uniform 注释的字符串向量默认值（如 {"default":"0 0 0"}），WE 用户配色未命中时兜底
        raw = meta.default
      }
      if (raw === undefined) {
        if (typeof meta.default === 'number' && meta.type === 'float') {
          const loc = compiled.uniformLocations.get(meta.name)
          if (loc) gl.uniform1f(loc, meta.default)
        }
        continue
      }
      const loc = compiled.uniformLocations.get(meta.name)
      if (!loc) continue
      if (typeof raw === 'number') {
        if (meta.type === 'int' || meta.type === 'uint') gl.uniform1i(loc, Math.round(raw))
        else gl.uniform1f(loc, raw)
        continue
      }
      // "x y z" 向量字符串
      const parts = String(raw).trim().split(/\s+/).map(Number)
      if (parts.some((v) => !Number.isFinite(v))) continue
      if (meta.type === 'vec2') gl.uniform2f(loc, parts[0], parts[1] ?? parts[0])
      else if (meta.type === 'vec3') gl.uniform3f(loc, parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0])
      else if (meta.type === 'vec4') {
        // 材质显式给的 g_Color* vec4（{"material":"color"}）也乘对象级 alpha
        const a = (parts[3] ?? parts[0]) * (/^g_Color/i.test(meta.name) ? objectAlpha : 1)
        gl.uniform4f(loc, parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], a)
      }
      else if (meta.type === 'float') gl.uniform1f(loc, parts[0])
    }
  }

  private setTextureUniforms(compiled: CompiledPass, index: number, uploaded: UploadedTexture | null): void {
    const gl = this.gl
    if (!uploaded) return
    const resLoc = compiled.uniformLocations.get('g_Texture' + index + 'Resolution')
    // WE 约定：g_TextureNResolution = (canvasW, canvasH, imageW, imageH)（像素），
    // 证据：common_particles.h unpaddedWidth = res.z / res.x ≤ 1（图像/画布比）、
    // blur_precise_gaussian d = scale / res.z（要求 z = 像素宽 → ~1.49 纹素步长）、
    // mask uv = uv * res.zw / res.xy（unpad 变换）。绑成 1/w 会把模糊步长放大 w 倍
    // → 偏移采样全部钳到边缘黑区 → 旗子只剩中心权重 0.1976 倍亮度（黑色剪影）。
    // 本渲染端上传的贴图已裁剪到图像区（无 padding）→ zw = xy。
    if (resLoc) gl.uniform4f(resLoc, uploaded.width, uploaded.height, uploaded.width, uploaded.height)
    const texelLoc = compiled.uniformLocations.get('g_Texture' + index + 'Texel')
    if (texelLoc) gl.uniform4f(texelLoc, 1 / uploaded.width, 1 / uploaded.height, 0, 0)
    if (index === 0) {
      const texelSizeLoc = compiled.uniformLocations.get('g_TexelSize')
      if (texelSizeLoc) gl.uniform2f(texelSizeLoc, 1 / uploaded.width, 1 / uploaded.height)
      const texelHalfLoc = compiled.uniformLocations.get('g_TexelSizeHalf')
      if (texelHalfLoc) gl.uniform2f(texelHalfLoc, 0.5 / uploaded.width, 0.5 / uploaded.height)
    }
  }

  /** 预加载所有纹理（渲染启动前调用，避免首帧白块） */
  async preloadTextures(): Promise<void> {
    if (!this.manifest) return
    const jobs: Promise<unknown>[] = []
    for (const object of this.manifest.objects) {
      for (const pass of object.passes) {
        for (const info of pass.textures || []) {
          if (info) jobs.push(this.loadTexture(info))
        }
      }
    }
    await Promise.allSettled(jobs)
    await this.loadModels()
    await this.loadPuppets()
    await this.loadParticles()
    // 文本对象：预载字体 + 光栅化（buildTextTexture 异步，完成前对应对象跳绘）
    for (const object of this.manifest.objects) {
      if (object.text) this.buildTextTexture(object)
    }
  }

  /** .mdl 模型几何：经 /scene/asset 端点拉二进制，parseModelMdl 自解析（与 server 块定位逻辑一致）。
   *  同一 .mdl 可能被多个对象共享（土星 24 个陨石共用几份网格），按文件去重并行拉取。 */
  private async loadModels(): Promise<void> {
    if (!this.manifest) return
    const pending = new Map<string, Promise<ParsedModelMesh | null>>()
    const fetchModel = (file: string): Promise<ParsedModelMesh | null> => {
      const existing = pending.get(file)
      if (existing) return existing
      const job = (async () => {
        try {
          const response = await fetch(
            `${BASE_SERVER}/api/wallpaper-engine/scene/asset?id=${encodeURIComponent(this.manifest!.id)}&name=${encodeURIComponent(file)}`,
          )
          if (!response.ok) throw new Error('mdl 下载失败 ' + response.status)
          const buffer = await response.arrayBuffer()
          const mesh = parseModelMdl(buffer)
          if (!mesh || !mesh.indices.length) throw new Error('mdl 几何块定位失败')
          return mesh
        } catch (error) {
          console.warn('[WEScene] 模型加载失败（跳过引用它的对象）:', file, error)
          return null
        }
      })()
      pending.set(file, job)
      return job
    }
    await Promise.allSettled(
      this.manifest.objects.map(async (object) => {
        const model = object.model
        if (!model || this.modelMeshes.has(object)) return
        const mesh = await fetchModel(model.file)
        if (mesh) this.modelMeshes.set(object, mesh)
      }),
    )
  }

  /** 拉取并初始化 puppet 模型（剪纸骨骼动画）：mdl 解析 + 姿态/蒙皮状态 + 动态 VAO */
  private async loadPuppets(): Promise<void> {
    if (!this.manifest) return
    const gl = this.gl
    for (const object of this.manifest.objects) {
      const puppet = object.puppet
      if (!puppet || this.puppetStates.has(object)) continue
      try {
        const response = await fetch(
          `${BASE_SERVER}${puppet.url}?id=${encodeURIComponent(this.manifest.id)}&name=${encodeURIComponent(puppet.file)}`,
        )
        if (!response.ok) throw new Error('mdl 下载失败 ' + response.status)
        const buffer = await response.arrayBuffer()
        const model = parsePuppetMdl(buffer)
        if (!model) throw new Error('mdl 解析失败')
        const pose = new PuppetPose()
        pose.init(model, puppet.animationLayers)
        const skinned = new Float32Array(model.vertexCount * 3)
        const worldPositions = new Float32Array(model.vertexCount * 3)
        const boundsW = Math.max(1, model.bounds[3] - model.bounds[0])
        const boundsH = Math.max(1, model.bounds[4] - model.bounds[1])

        const vao = gl.createVertexArray()
        gl.bindVertexArray(vao)
        // 位置：每帧蒙皮后 bufferSubData（世界空间 xyz）
        const posVbo = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, posVbo)
        gl.bufferData(gl.ARRAY_BUFFER, worldPositions, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
        // UV：静态（图集坐标）
        const uvVbo = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, uvVbo)
        gl.bufferData(gl.ARRAY_BUFFER, model.uvs, gl.STATIC_DRAW)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 8, 0)
        const ebo = gl.createBuffer()!
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo)
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, model.triangles, gl.STATIC_DRAW)
        gl.bindVertexArray(null)

        this.puppetStates.set(object, {
          model, pose, skinned, worldPositions, vao, posVbo, uvVbo, ebo,
          indexCount: model.triangles.length,
          sizeFallback: [boundsW, boundsH],
        })
      } catch (error) {
        console.warn('[WEScene] puppet 加载失败（跳过该对象）:', object.name, error)
      }
    }
  }

  /** 粒子系统：纹理复用 loadTexture（按 textureFile 缓存），CPU 模拟 + warmup 预热 */
  private async loadParticles(): Promise<void> {
    if (!this.manifest) return
    const gl = this.gl
    for (const object of this.manifest.objects) {
      const def = object.particle
      if (!def || this.particleStates.has(object)) continue
      const runtimes: { system: ParticleSystem; texture: ParticleTexture | null }[] = []
      // 主系统 + children 一层（WE 语义：子系统从父粒子位置发射，见 particles.ts update）
      for (const systemDef of [def, ...def.children]) {
        try {
          let texture: ParticleTexture | null = null
          if (systemDef.texture) {
            const uploaded = await this.loadTexture(systemDef.texture)
            if (uploaded) {
              texture = {
                texture: uploaded.texture,
                width: uploaded.width,
                height: uploaded.height,
                sheetColumns: Math.max(1, systemDef.texture.sheetColumns ?? 1),
                sheetRows: Math.max(1, systemDef.texture.sheetRows ?? 1),
                sheetFrames: Math.max(0, systemDef.texture.sheetFrames ?? 0),
                sheetDuration: Math.max(0, systemDef.texture.sheetDuration ?? 0),
              }
            }
          }
          const system = new ParticleSystem(systemDef, gl, texture)
          // 顺序预热：先主系统后子系统（子系统的发射位来自父粒子）
          system.warmup(runtimes[0]?.system)
          runtimes.push({ system, texture })
        } catch (error) {
          console.warn('[WEScene] 粒子系统初始化失败（跳过）:', systemDef.file, error)
        }
      }
      if (runtimes.length) this.particleStates.set(object, runtimes)
    }
  }

  /** 粒子 instanced 着色器（惰性编译；aCorner(loc0) + 实例 loc1..5，见 particles.ts） */
  private ensureParticleProgram(): WebGLProgram | null {
    if (this.particleProgram) return this.particleProgram
    const gl = this.gl
    const vert = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 iPos;
layout(location=2) in float iSize;
layout(location=3) in vec4 iColor;
layout(location=4) in vec2 iRotSC;
layout(location=5) in vec4 iUvRect;
uniform mat4 u_World;
uniform mat4 u_ViewProj;
uniform vec2 u_Aspect; // 帧高宽比修正 (1, frameH/frameW)
out vec4 v_Color;
out vec2 v_Uv;
void main() {
  vec2 corner = aCorner * u_Aspect;
  vec2 rotated = vec2(corner.x * iRotSC.y - corner.y * iRotSC.x,
                      corner.x * iRotSC.x + corner.y * iRotSC.y);
  vec4 world = u_World * vec4(iPos + vec3(rotated, 0.0), 1.0);
  gl_Position = u_ViewProj * world;
  v_Color = iColor;
  v_Uv = vec2(mix(iUvRect.x, iUvRect.z, aCorner.x + 0.5),
              mix(iUvRect.y, iUvRect.w, aCorner.y + 0.5));
}`
    const frag = `#version 300 es
precision mediump float;
in vec4 v_Color;
in vec2 v_Uv;
uniform sampler2D u_Tex;
out vec4 fragColor;
void main() {
  fragColor = texture(u_Tex, v_Uv) * v_Color;
}`
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type)
      if (!shader) return null
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('[WEScene] 粒子着色器编译失败:', gl.getShaderInfoLog(shader))
        gl.deleteShader(shader)
        return null
      }
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, vert)
    const fs = compile(gl.FRAGMENT_SHADER, frag)
    if (!vs || !fs) return null
    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[WEScene] 粒子着色器链接失败:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return null
    }
    this.particleProgram = program
    return program
  }

  /** 粒子对象绘制：instanced billboard + 材质 blending（additive/translucent） */
  private renderParticleObject(object: SceneObject, viewProjection: Float32Array): void {
    const runtimes = this.particleStates.get(object)
    const def = object.particle
    if (!runtimes?.length || !def) return
    const program = this.ensureParticleProgram()
    if (!program) return
    const gl = this.gl

    // 对象世界变换（同 quad 分支：worldMatrix / origin+angles+scale，视差平移最外层）；
    // 不做 quad 那样的 size 缩放——粒子尺寸来自粒子系统自身单位
    let pdx = 0, pdy = 0
    if (object.parallaxDepth && (object.parallaxDepth[0] || object.parallaxDepth[1])) {
      pdx = -this.cameraEye[0] * object.parallaxDepth[0]
      pdy = -this.cameraEye[1] * object.parallaxDepth[1]
    }
    let world: Float32Array
    if (object.worldMatrix) {
      world = mat4Multiply(mat4Translate(pdx, pdy, 0), new Float32Array(object.worldMatrix))
    } else {
      world = mat4Translate(object.origin[0] + pdx, object.origin[1] + pdy, object.origin[2])
      const rz = (object.angles[2] || 0) * DEG2RAD
      if (rz) world = mat4Multiply(world, mat4RotateZ(rz))
      const sx = object.scale[0] || 1
      const sy = object.scale[1] || 1
      if (sx !== 1 || sy !== 1) world = mat4Multiply(world, mat4Scale(sx, sy, 1))
    }

    gl.useProgram(program)
    gl.enable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    // 粒子着色器是自写 GLSL（u_World * v 数学约定），矩阵按列主序直接上传（transpose=false）
    const worldLoc = gl.getUniformLocation(program, 'u_World')
    if (worldLoc) gl.uniformMatrix4fv(worldLoc, false, world)
    const vpLoc = gl.getUniformLocation(program, 'u_ViewProj')
    if (vpLoc) gl.uniformMatrix4fv(vpLoc, false, viewProjection)
    const texLoc = gl.getUniformLocation(program, 'u_Tex')
    if (texLoc) gl.uniform1i(texLoc, 0)
    gl.activeTexture(gl.TEXTURE0)

    const additive = /additive/i.test(def.blending)
    const objectAlpha = object.alpha ?? 1
    for (const runtime of runtimes) {
      const count = runtime.system.packInstances(objectAlpha)
      if (count <= 0 || !runtime.texture) continue
      if (additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.bindTexture(gl.TEXTURE_2D, runtime.texture.texture)
      // 帧高宽比：billboard 高 = 宽 × (帧高/帧宽)（保持非方形贴图不变形）
      const aspect = runtime.texture.width > 0 && runtime.texture.height > 0
        ? runtime.texture.height / runtime.texture.width
        : 1
      const aspectLoc = gl.getUniformLocation(program, 'u_Aspect')
      if (aspectLoc) gl.uniform2f(aspectLoc, 1, aspect)
      runtime.system.drawInstances(count, world, viewProjection)
    }
    gl.depthMask(true)
    // 恢复场景默认混合（后续 quad pass 假定 standard alpha 混合）
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  /** 调试：纹理缓存概要（键 → 已上传尺寸 / null=失败或占位 / 未出现=未加载） */
  getTextureDebugInfo(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const object of this.manifest?.objects ?? []) {
      for (const pass of object.passes) {
        for (const info of pass.textures || []) {
          if (!info || out[info.textureFile]) continue
          const uploaded = this.textureCache.get(info.textureFile)
          out[info.textureFile] = uploaded
            ? `ok ${uploaded.width}x${uploaded.height}`
            : (this.textureCache.has(info.textureFile) ? 'null(占位/失败)' : '未加载')
        }
      }
    }
    return out
  }
}

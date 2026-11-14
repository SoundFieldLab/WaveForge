/**
 * Wallpaper Engine 场景渲染共享类型（对应 local-server.mjs 的 /scene/manifest 输出）
 */

export interface SceneTextureInfo {
  url: string
  textureFile: string
  image: 'raw' | 'png' | 'jpeg' | 'video'
  format: string
  compressed: boolean
  width: number
  height: number
  canvasWidth: number
  canvasHeight: number
  clampUVs: boolean
  noInterpolation: boolean
  /** WE spritesheet（.tex flags bit4 + 帧尺寸<画布）：列/行帧数；1=整张贴图 */
  sheetColumns?: number
  sheetRows?: number
  /** spritesheetsequences[0].frames（实际使用的帧数，≤cols*rows）；0=缺 tex-json */
  sheetFrames?: number
  /** spritesheetsequences[0].duration（秒，整张序列循环一周）；0=缺 tex-json */
  sheetDuration?: number
}

export interface SceneUniformMeta {
  type: string
  name: string
  material?: string
  default?: number | string
}

export interface ScenePass {
  shaderName: string
  blending: string
  depthTest: boolean
  depthWrite: boolean
  constants: Record<string, number | string>
  textures: (SceneTextureInfo | null)[] | null
  /**
   * 编译后 GLSL 全文：不再内联进 manifest（太阳系 847 对象超 V8 字符串上限 500 实证），
   * pass 只带 shaderRef，渲染端经 /scene/shaders 批量拉取后水合。水合前为 undefined。
   */
  vert?: string
  frag?: string
  /** 服务端着色器源码池引用（sha1(vert\0frag)），经 /scene/shaders 端点解析 */
  shaderRef?: string
  uniforms: SceneUniformMeta[]
  error?: string
}

/** .mdl 模型对象引用：几何不内联进 manifest（土星陨石单体 329MB / 太阳系 847 对象
 * 超 V8 字符串上限 500 实证）——渲染端经 /scene/asset 端点拉二进制自解析（modelMdl.ts） */
export interface SceneModelRef {
  /** .mdl 相对路径（pkg 内），经 /api/wallpaper-engine/scene/asset 拉取 */
  file: string
}

export interface SceneLight {
  kind: string
  color: number[]
  intensity: number
  radius: number
  origin: number[]
}

/** WE puppet 动画层定义（scene.json 对象的 animationlayers） */
export interface PuppetLayerDef {
  id: number
  animation: number
  blend: number
  rate: number
  additive: boolean
  visible: boolean
}

/** WE puppet 剪纸骨骼模型（models/*.json 的 puppet 字段指向 .mdl） */
export interface ScenePuppet {
  /** .mdl 二进制下载地址（asset 端点透传） */
  url: string
  /** .mdl 相对路径（models/X_puppet.mdl），fetch 时的 name 参数 */
  file: string
  /** scene.json 的 animationlayers（clip id 引用 mdl 内的动画） */
  animationLayers: PuppetLayerDef[]
}

/** WE 粒子系统定义（scene.json obj.particle 指向的粒子 JSON，server 内联下发） */
export interface SceneParticleDef {
  file: string
  /** 材质 blending：additive → 加法发光；其余按普通透明叠加 */
  blending: string
  texture: SceneTextureInfo | null
  /** 服务端解析备注（未知算子名/trail 渲染器降级等，仅诊断用） */
  unsupported: string[]
  /** 子粒子系统（一层；发射于父粒子位置——v1 简化为独立发射） */
  children: SceneParticleDef[]
  emitter: Record<string, unknown>[]
  initializer: Record<string, unknown>[]
  operator: Record<string, unknown>[]
  renderer: Record<string, unknown>[]
  maxcount: number
  /** 预热秒数（挂载后先模拟这么久，雨雪直接满屏） */
  starttime: number
  /** 'sequence' 顺序播帧 / 'randomframe' 初生随机帧 / null 整张贴图 */
  animationmode: 'sequence' | 'randomframe' | null
  /** sequence 模式播帧速率倍数 */
  sequencemultiplier: number
  /** emitter[0].origin（本地空间） */
  emitterOrigin: number[]
  /** scene.json obj.instanceoverride：作者实例缩放 */
  instanceoverride?: { alpha: number; count: number; rate: number; size: number }
}

export interface SceneObject {
  id: number
  name: string
  origin: number[]
  angles: number[]
  scale: number[]
  /** parent 链世界变换（列主序 4x4，server 端 applyParentWorldTransforms 计算）；缺省回退 origin/scale/angles */
  worldMatrix?: number[]
  /** WE 文本对象（server entry.text，千咲 69/伊蕾娜 69 等）：渲染端 canvas 光栅化 */
  text?: {
    text: string
    font: string
    pointsize: number
    color: number[]
    alpha: number
    alignH: string
    alignV: string
    padding: number
  }
  pivot: number[]
  size: number[]
  visible?: boolean
  passes: ScenePass[]
  unsupported: string[]
  /** .mdl 模型对象引用（存在时走透视相机 mesh 管线；几何经 loadModels 拉取解析） */
  model?: SceneModelRef
  /** 光源对象（WE scene.json 的 light 定义，供模型 shader 真实光照） */
  light?: SceneLight
  /** WE puppet 剪纸骨骼动画对象（存在时走 puppet 蒙皮管线） */
  puppet?: ScenePuppet
  /** WE 粒子系统对象（存在时走粒子 instanced 管线） */
  particle?: SceneParticleDef
  /** WE 组合层（composelayer）：tex0 = 全帧缓冲直通，渲染端做帧缓冲快照 */
  composeLayer?: boolean
  /** WE 对象级 alpha（scene.json obj.alpha，雪境 312 暗角 0.37）：乘进 g_Color* 的 a 分量 */
  alpha?: number
  /**
   * WE 对象级混合模式（scene.json obj.colorBlendMode，引擎 ApplyBlending 枚举 1..32，
   * 12=SoftLight）：对象 shader 内以 g_Texture4=_rt_FullFrameBuffer 快照做
   * ApplyBlending(mode, screen.rgb, fragColor.rgb, fragColor.a)，输出 alpha 取 screen.a
   * （genericimage3/4.frag 的 #if BLENDMODE 块，2026-10-22 雪境特写之谜根因）。
   * 0/缺省 = Normal（普通 translucent 叠加，不注入 combo）
   */
  colorBlendMode?: number
  /**
   * WE 视差层（scene.json obj.parallaxdepth，缺省 [0,0]）：camera eye 是视差相机——
   * depth 0=贴屏幕不动（虹夏/雪境主体全部缺省）、1=贴世界；渲染端按
   * offset = -eye.xy * depth 平移对象（eye=scene.json camera.eye，2026-10-23）
   */
  parallaxDepth?: number[]
}

export interface SceneManifest {
  success: boolean
  id: string
  path: string
  title: string
  scene: {
    camera: { eye: number[]; center: number[]; up: number[] }
    ortho: { width: number; height: number }
    /** 透视相机 fov（度）：存在 .mdl 模型对象时使用 */
    perspectiveFov?: number
    clearColor: number[]
    bloom: boolean
    /** 场景光照环境（scene.json general.ambientcolor / skylightcolor） */
    ambientColor?: number[]
    skylightColor?: number[]
  }
  objects: SceneObject[]
  unsupportedSummary: string[]
  /**
   * nullchain 安全标记（服务端白名单下发）：场景内全部「链首 tex0=null 多 pass 对象」
   * 已逐个 ?nullchain=1 截图验证无伪影 → 渲染端默认放行这类全屏后处理链（godrays 等）。
   * 未标记场景默认关闭（雪境 425/437/538 放行会全屏雾化）。探针 ?nullchain=0/1 可覆盖。
   */
  nullChainSafe?: boolean
}

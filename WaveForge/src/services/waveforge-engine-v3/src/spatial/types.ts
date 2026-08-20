/**
 * 空间音频（Spatial Audio）参数模型 —— HSE 独立命名空间
 *
 * 空间音频是 v3 处理节点之后的兄弟 AudioWorklet 节点（同 SoundTouch 先例）：
 *   masterGain → [soundtouch?] → v3Node → [spatial?] → analyser
 *
 * 与 V3EngineParams 完全解耦：不进入场景快照（像音量一样是全局设置），
 * 独立持久化于 localStorage（waveforge:spatial-params）。EngineV3 零改动。
 * 角度单位：度；距离单位：米。
 */

import { createLayoutSpeakers } from './layouts'
// 键位映射类型定义在同层 keymap.ts（契约层，与 KeyMap 语义同处）；
// import type 编译期擦除，不进 worklet 打包，无运行时依赖。
import type { KeyMap } from './keymap'

/** 空间模式：off=关闭 / instant=一键空间化 / headLocked=头锁定环绕 / world=世界漫游 / stage=舞台影院 */
export type SpatialMode = 'off' | 'instant' | 'headLocked' | 'world' | 'stage'

/** 输出模式：binaural=双耳 HRTF / stereo=立体声下混（干声直通）/ multichannel=多声道输出映射（2 声道设备退化为 stereo） */
export type OutputMode = 'binaural' | 'stereo' | 'multichannel'

/** 房间预设（混响语义；off=无房间模拟） */
export type RoomPreset = 'off' | 'studio' | 'hall' | 'stage' | 'church' | 'outdoor' | 'bathroom' | 'corridor'

/** 距离衰减模型 */
export type DistanceModel = 'inverse' | 'linear' | 'exponential'

/** HRTF 插值模式：nearest=最近邻（默认）/ spherical=球谐插值（性能模式 quality 档启用，见 SpatialParams.perfMode） */
export type HrtfInterpMode = 'nearest' | 'spherical'

/** 卷积模式：partitioned=FFT 分区卷积 / time=时域直接卷积 */
export type ConvolutionMode = 'partitioned' | 'time'

/** 模式 A：一键空间化设置 */
export interface InstantSpatialSettings {
  /** 虚拟扬声器展开角度（度）：左右扬声器方位角 = ±spreadDeg/2，范围 20..120 */
  spreadDeg: number
  /** 空间化强度 0..1：干（原立体声）与湿（双耳渲染）混合 */
  amount: number
  /** 房间模拟预设 */
  room: RoomPreset
  /** 房间混响混合 0..1（叠加在双耳湿信号上） */
  roomAmount: number
  /**
   * 多声道输入自动映射（默认 false；UI 开关后续 wave）：
   * true 时 instant 布局按输入声道数自动映射——输入 >2 声道（5.1/7.1）→
   * multichannelLayout（融合层按处理器 stats 回传的 inputChannels 推导，
   * speaker.channel 按标准声道序路由，后端 processMulti 逐声道双耳渲染）；
   * ≤2 声道 → 常规 instantSpeakers（±spreadDeg/2 立体声对，行为与现状一致）。
   */
  multichannelAuto: boolean
}

/** 单个虚拟扬声器配置（模式 B 自定义布局用；角度=度，距离=米） */
export interface VirtualSpeakerCfg {
  azimuthDeg: number
  elevationDeg: number
  distance: number // 米
  /** 0..2 */
  gain: number
  /** 0..1 扩散度（占位，后端可忽略） */
  size: number
  /**
   * 静音标记（右键菜单「静音/Solo」；缺省 undefined=false——未静音）。
   * 静音在后端渲染层以增益 0 表达（fusion headLocked 分支置零）；Solo 语义
   * 在 UI 层已归一化为其它扬声器 muted=true、本只 muted=false，本字段只承载
   * 归一化后的最终静音态，融合层无需感知 Solo。
   */
  muted?: boolean
}

/** 扬声器路由：由哪个输入声道驱动——'l'=仅左源 / 'r'=仅右源 / 'both'=左右混合(0.5/0.5)；缺省按方位角就近（az≤0→'l'、az>0→'r'，与现状一致） */
export type SpeakerRoute = 'l' | 'r' | 'both'

/** 模式 B：头锁定环绕（布局预设 + 自定义编辑器；声场固定于头部朝向） */
export interface HeadLockedSettings {
  layout: 'stereo' | '51' | '714' | 'custom'
  /** 自定义布局扬声器列表（layout==='custom' 时生效） */
  speakers: VirtualSpeakerCfg[]
  /** 顶部仰角层开关（7.1.4 布局的 4 个顶置扬声器） */
  heightLayer: boolean
  /** 底部仰角层开关（7.1.4 布局的 2 个底部扬声器 Bottom L/R，仰角 -20°；
   *  默认 true——与 heightLayer 并列，false 时从 714 预设过滤，见 layouts.ts） */
  bottomLayer: boolean
  /** 扬声器输入路由（与 speakers 等长；长度不足补默认、超长截断——融合层防御，
   *  不在此处强制对齐）：'l'=仅左源 / 'r'=仅右源 / 'both'=左右混合（fusion 展开为
   *  两只半增益扬声器）；缺省（空数组或长度不足）= 按方位角就近（az≤0→L、az>0→R，
   *  与现状一致，行为不回归） */
  routes: SpeakerRoute[]
}

/** 声源轨迹关键帧（模式 C：声源沿时间轨迹运动；t=秒，线性插值） */
export interface TrajectoryKeyframes {
  sourceId: string
  keyframes: { t: number; position: { x: number; y: number; z: number } }[]
}

/** 模式 C：世界漫游（听者 + 声源对象；移动/旋转由 controller 纯函数驱动，方位映射见 fusion world 分支） */
export interface WorldSettings {
  /** 移动速度 m/s（0.5..5） */
  moveSpeed: number
  /** 听者世界坐标 + 朝向（默认原点前方偏上 1.6m、yaw=0 朝 +Z） */
  listener: ListenerState
  /** 声源对象列表（默认 4 个演示源：人声/吉他/鼓组/环境声，见 createDefaultSpatialParams） */
  sources: AudioObject[]
  /** 播放时钟（秒，默认 0；UI 时间预览用，自动随曲目播放后续 wave） */
  playhead: number
  /** 声源轨迹关键帧列表（默认 []；sourceId 匹配的声源按 playhead 线性插值运动，无轨迹者用静态 position） */
  trajectories: TrajectoryKeyframes[]
  /** 遮挡/衍射量 0..1（默认 0；§4.7 简化模型：增益衰减 + 高频低通，经 SpatialRenderConfig.occlusionAmount 透传） */
  occlusion: number
}

/** 模式 D 场景预设：stage=音乐舞台 / cinema=电影院 / piano=钢琴独奏 / nature=自然场景 */
export type StagePreset = 'stage' | 'cinema' | 'piano' | 'nature'

/** 座位位置（影响扬声器距离缩放：front×0.8 / middle×1.0 / back×1.35） */
export type SeatPosition = 'front' | 'middle' | 'back'

/** 模式 D：舞台/影院（场景预设 + 座位/房间调节；扬声器布局见 scenes.ts 单事实源） */
export interface StageSettings {
  /** 场景预设（决定扬声器布局与房间） */
  preset: StagePreset
  /** 座位：越靠后声源越远（距离感），front=×0.8 / middle=×1.0 / back=×1.35 */
  seat: SeatPosition
  /** 房间大小缩放 0.5..2（影响混响与距离感；整体 ×roomSize，钳位 0.5..10m） */
  roomSize: number
  /** 氛围混响 0..1（覆盖融合层全局 roomAmount，由面板控制） */
  reverbAmount: number
  /** 自定义附加声源（规划书「可替换/添加个别声源」；stageSpeakers 结果后按方位路由附加为虚拟扬声器，默认 []） */
  customSources: AudioObject[]
}

/** 空间音频参数快照（全局设置，独立于 V3EngineParams，不可变替换语义） */
export interface SpatialParams {
  mode: SpatialMode
  /** 输出模式（默认 'binaural'；stereo=立体声下混干声直通，multichannel 本轮同 binaural 处理） */
  output: OutputMode
  /** 卷积模式（默认 'partitioned'；time=时域直接卷积，后端 spatial_set_convolution_mode 契约） */
  convolution: ConvolutionMode
  /**
   * 性能模式（默认 'balanced'）：quality=HRTF 球谐插值（方位过渡更平滑，计算量
   * 略高）；balanced/lowLatency=最近邻插值（更快）；低延迟档的完整语义（更小
   * 卷积分区换取更低延迟）由后续 wave 落地。融合层按本字段映射渲染配置的
   * hrtfInterp（quality → 'spherical'，其余 → 'nearest'，见 fusion.spatialConfigFromParams）。
   */
  perfMode: 'quality' | 'balanced' | 'lowLatency'
  /** 双耳输出主增益 0.5..1（防削波预留） */
  masterGain: number
  instant: InstantSpatialSettings
  headLocked: HeadLockedSettings
  world: WorldSettings
  stage: StageSettings
  /** 环境声 Ambisonics 上混（叠加到各模式主渲染；见 ambisonics.ts） */
  ambience: AmbienceSettings
  /**
   * 多声道物理输出声道数（output==='multichannel' 时 SpatialNode 重建为
   * 6/8 声道输出；缺省 6）。按 headLocked/stage 布局类型推导：7.1.4→8、
   * 5.1/其它→6；显式设置时优先于此推导。真实设备声道能力检测 / setSinkId
   * 设备选择后续 wave。
   */
  multichannelChannels?: 6 | 8
  /**
   * 输出设备 sinkId（AudioContext.setSinkId 目标；缺省 undefined = 系统默认设备）。
   * 经 fusion.setOutputDevice 应用（已接线上下文即时热切换）并随快照整体持久化
   * （createDefaultSpatialParams 不设置该字段 = 系统默认，注释见上）；设备枚举与
   * 切换能力见 fusion.listOutputDevices / setOutputDevice（不支持时静默降级）。
   */
  sinkId?: string
  /**
   * 世界漫游键盘键位映射（模式 C；缺省 undefined = 默认键位 DEFAULT_KEYMAP）。
   * 经设置弹窗「快捷键」区配置（8 个动作可自定义），随快照整体持久化——
   * createDefaultSpatialParams 不设置该字段（缺省语义）；WorldPanel 键盘监听
   * 按本字段合并 DEFAULT_KEYMAP 后比较（partial 覆盖，未配置的动作回默认键）。
   */
  keymap?: Partial<KeyMap>
}

/** 听者状态（世界坐标 + 欧拉朝向；波 1 各模式均固定原点朝前） */
export interface ListenerState {
  position: { x: number; y: number; z: number }
  yaw: number
  pitch: number
  roll: number
}

/** 声源对象（世界漫游/舞台模式；波 1 仅类型占位） */
export interface AudioObject {
  id: string
  position: { x: number; y: number; z: number }
  gain: number
  size: number
}

/** 环境声 Ambisonics 上混（FOA 环境场 → 4 方向虚拟扬声器，叠加到各模式主渲染） */
export interface AmbienceSettings {
  enabled: boolean
  /** 环境声混合 0..1 */
  amount: number
}

/**
 * HRTF 网格数据（语言中立布局，TS 与 Rust/WASM 共用）。
 * left/right 按行主序 [elevIdx * azimuthCount + azIdx]，
 * 每项为 hrirLength 个样本的连续段。
 */
export interface HrtfGrid {
  sampleRate: number
  /** 度，升序，覆盖 -180..180 */
  azimuths: number[]
  /** 度，升序 */
  elevations: number[]
  hrirLength: number
  left: Float32Array
  right: Float32Array
}

/** 虚拟扬声器：输入声道按 channel 路由，HRTF 双耳渲染后求和 */
export interface VirtualSpeaker {
  /** 输入声道索引（当前立体声图：0=L，1=R） */
  channel: number
  azimuthDeg: number
  elevationDeg: number
  distance: number
  /** 0..2 */
  gain: number
  /** 0..1：点声源→扩散声源（波 1 占位，后端可忽略） */
  size: number
  /**
   * 环境声扬声器标记（fusion ambience 附加块填写）：true = 环境扬声器——处理器按此
   * 走 FOA 动态增益调制路径（不进后端卷积，由环境混合器旁路渲染，见 SpatialProcessor
   * renderAmbience 注释）；缺省 undefined = 普通渲染（后端 HRTF 卷积路径）。
   */
  ambience?: boolean
}

/** 后端渲染配置（融合层由 SpatialParams.mode 计算产出，全量替换语义） */
export interface SpatialRenderConfig {
  speakers: VirtualSpeaker[]
  room: RoomPreset
  roomAmount: number
  /** 干湿混合（空间化强度） */
  amount: number
  distanceModel: DistanceModel
  hrtfInterp: HrtfInterpMode
  convolution: ConvolutionMode
  masterGain: number
  /** 多普勒（§4.6，模式 C 专属）：听者速度（世界坐标 m/s）。缺省 = 无多普勒。
   *  fusion world 分支填默认 {0,0,0}，UI 层移动听者时随 config 更新（本波引擎侧只留接口）。 */
  dopplerVelocity?: { x: number; y: number; z: number }
  /** 遮挡/衍射简化（§4.7，模式 C）：0..1 全局遮挡量——每 speaker 增益
   *  gain·(1−0.8·occlusion) + 空气式低通 fc = 12000·(1−occlusion) Hz（系数公式与
   *  空气吸收同族，状态每 speaker 独立）。缺省 = 无遮挡（后端直通，与现状逐位一致）。
   *  UI 滑块后续接——由并行代理 fusion 填写，后端只做支持与透传。 */
  occlusionAmount?: number
  /**
   * 多声道输入自动映射开关（instant.multichannelAuto 透传，仅 instant 模式填写）：
   * 处理器按输入声道数路由——输入 >2 声道且后端有 processMulti 时逐声道双耳渲染
   * （speaker.channel 为标准声道序索引）；输出 >2 声道时走物理声道映射（处理器内
   * 按方位角分类，与本字段无关）。信息性字段（处理器可从输入/输出声道数自检）。
   */
  multichannelAuto?: boolean
  /**
   * 环境声混合量（fusion ambience 附加时填 p.ambience.amount，0..1）：
   * 处理器环境混合器按此缩放 FOA 调制后的 4 路环境输出（× amount·0.5，0.5 防环境
   * 淹没主渲染）。缺省 undefined = 环境混合器关闭（无 ambience 附加，行为与现状一致）。
   */
  ambienceAmount?: number
}

/** 默认空间参数（与 createDefaultParams 同风格） */
export function createDefaultSpatialParams(): SpatialParams {
  return {
    mode: 'off',
    // 默认输出双耳 HRTF 渲染（stereo 干声直通 / multichannel 后续 wave，见 fusion 输出模式分支）
    output: 'binaural',
    // 默认 FFT 分区卷积（time 时域直接卷积可经设置弹窗切换，后端契约 spatial_set_convolution_mode）
    convolution: 'partitioned',
    // 默认平衡档（quality 球谐插值 / balanced·lowLatency 最近邻，fusion 按此映射 hrtfInterp）
    perfMode: 'balanced',
    masterGain: 0.9,
    instant: { spreadDeg: 60, amount: 0.7, room: 'studio', roomAmount: 0.15, multichannelAuto: false },
    // 默认 5.1 布局，speakers 取 51 预设副本（与 layouts.ts 单事实源一致）；
    // routes 空数组 = 全按方位角就近路由（行为不回归）
    headLocked: { layout: '51', speakers: createLayoutSpeakers('51'), heightLayer: true, bottomLayer: true, routes: [] },
    // 模式 C 默认：听者立于原点前方 1.6m 高朝 +Z；4 个演示声源——
    //   人声   (-2, 1.6, 4)  左前近场
    //   吉他   (-5, 1.6, 6)  左前远场
    //   鼓组   ( 3, 1.6, 7)  右前远场
    //   环境声 ( 0, 2.5,10)  正前高空（扩散：size 0.5、增益 0.6）
    world: {
      moveSpeed: 2,
      listener: { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 },
      sources: [
        { id: 'vocal', position: { x: -2, y: 1.6, z: 4 }, gain: 1, size: 0 },
        { id: 'guitar', position: { x: -5, y: 1.6, z: 6 }, gain: 1, size: 0 },
        { id: 'drums', position: { x: 3, y: 1.6, z: 7 }, gain: 1, size: 0 },
        { id: 'ambience', position: { x: 0, y: 2.5, z: 10 }, gain: 0.6, size: 0.5 },
      ],
      // 播放时钟默认 0 秒、无轨迹（声源静止于 sources 静态位置，行为不回归）、无遮挡
      playhead: 0,
      trajectories: [],
      occlusion: 0,
    },
    stage: { preset: 'stage', seat: 'middle', roomSize: 1, reverbAmount: 0.35, customSources: [] }, // 自定义附加声源默认空（不附加，行为不回归）
    // 环境声默认关闭（不影响既有空间化行为），开启后默认混合 30%
    ambience: { enabled: false, amount: 0.3 },
    // 多声道物理输出声道数缺省不设置（可选字段）：fusion 按布局类型推导
    // （5.1/其它 → 6、7.1.4 → 8），显式设置 6|8 时优先于推导
    // sinkId 同样缺省不设置（可选字段）：undefined = 系统默认输出设备，
    // 仅用户经设置弹窗切换输出设备后写入（随快照持久化，attach 时自动恢复）
  }
}

/** 模式 A 参数 → 虚拟扬声器布局（立体声输入 → ±spread/2 两只虚拟扬声器） */
export function instantSpeakers(p: InstantSpatialSettings): VirtualSpeaker[] {
  const half = Math.min(60, Math.max(10, p.spreadDeg / 2))
  return [
    { channel: 0, azimuthDeg: -half, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { channel: 1, azimuthDeg: half, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  ]
}

/** 深合并类型（数组/Float32Array 整段替换，同 ui/hooks.ts 语义） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> | Float32Array
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

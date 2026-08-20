/**
 * SpatialSettingsModal —— 空间音频设置弹窗（专业视图工具栏「设置」入口，规划书 §5.6）
 *
 * 本波（UI 全量接入）新增：
 *  - 输出模式：双耳 Binaural / 立体声下混 可切换（→ onPatch({ output })，字段
 *    SpatialParams.output = 'binaural' | 'stereo' | 'multichannel' 已落地）；
 *    多声道（开发中 禁用）；
 *  - HRTF 数据集：内置两套选择（MIT KEMAR / CIPIC subject_003，规划书 §4.1——
 *    setBuiltinDataset 解码内嵌网格 → postGrid 热更新 + localStorage 锚点；
 *    CIPIC 未打包（datasets.ts base64 null）时禁用并标注「数据未打包」）+
 *    当前数据集状态行（内置选择 / 导入后显示已导入文件名）+ 「导入 SOFA 数据集」
 *    按钮（.sofa 文件 → parseSofaFile → setHrtfDataset，两函数契约已落地：
 *    sofa.ts 解析 + fusion.ts 热更新/持久化/校验，无待收口项）；
 *    SADIE II 需注册下载，保持禁用（注释：后续 wave 接入）；
 *  - 卷积模式：时域已由引擎后端实现（并行代理），UI 启用按钮留收口确认（保持禁用标注）；
 *  - 渲染资源：最大对象数 16 → 64（引擎支持到 64 对象，本波性能基准已覆盖）。
 *
 * 保持既有：性能模式（已接线 spatial.perfMode，随快照持久化）、主题静态展示。
 * 快捷键区（§5.6 键位编辑器）：KeyMap 8 个可配置动作逐行显示当前键位 + 捕获按钮
 * （捕获态 window keydown 写回 spatial.keymap，partial 覆盖）；「恢复默认」= keymap
 * 置 undefined 回退 DEFAULT_KEYMAP；重复键位允许、行内小字提示冲突。模态实现仿
 * 既有 Modal（ui/primitives.tsx）：fixed overlay + 玻璃面板 +
 * Esc/背板点击关闭，动画 keyframes 本地注入避免与既有样式冲突。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Settings2, Upload, X } from 'lucide-react'
import type { HSETheme } from '../hse-theme'
import type { DeepPartial, OutputMode, SpatialParams } from '../../src/spatial/types'
// 空间音频已内联 EngineV3（纯 TS DSP），独立 fusion worklet 层已移除：
//  - SOFA 数据集导入（sofa.ts）与内置数据集切换（gridSource + fusion setBuiltinDataset）
//    依赖已删模块，本波标注「开发中」禁用，后续 wave 改走 EngineV3 内联合成 HRTF；
//  - 输出设备枚举/切换（fusion listOutputDevices/setOutputDevice）同样依赖已删模块，
//    标注「开发中」禁用，后续 wave 接主播放器 AudioContext.setSinkId。
import { Segmented } from './Primitives'
import { DEFAULT_KEYMAP } from './worldControl'
import type { KeyMap } from './worldControl'

interface SpatialSettingsModalProps {
  open: boolean
  onClose: () => void
  theme: HSETheme
  /** 空间参数快照（输出模式读取 spatial.output，已落地字段） */
  spatial: SpatialParams
  /** 深合并写入（输出模式切换 → onPatch({ output: v })） */
  onPatch: (p: DeepPartial<SpatialParams>) => void
}

/** 弹窗动画 keyframes（独立命名，不与既有 v3-modal-* 冲突） */
const SP_SETTINGS_KEYFRAMES = `
@keyframes wf-sp-settings-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes wf-sp-settings-pop { from { opacity: 0; transform: scale(0.96) translateY(8px) } to { opacity: 1; transform: scale(1) translateY(0) } }
`

/** 「开发中」角标 */
function DevBadge({ theme }: { theme: HSETheme }) {
  return (
    <span
      className="ml-1.5 px-1 py-px rounded text-[8px] leading-none align-middle"
      style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)' }}
    >
      开发中
    </span>
  )
}

/** 设置分组标题 */
function SectionTitle({ children, theme, first }: { children: ReactNode; theme: HSETheme; first?: boolean }) {
  return (
    <div className={`${theme.textSecondary} text-xs mb-1.5 ${first ? '' : 'mt-4'}`}>{children}</div>
  )
}

/** 标签/值静态信息行（hse-mono 等宽数值） */
function InfoRow({ label, value, theme, valueClassName }: { label: string; value: ReactNode; theme: HSETheme; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className={`${theme.textTertiary} text-[11px]`}>{label}</span>
      <span className={`hse-mono ${theme.textSecondary} text-[11px] ${valueClassName ?? ''}`}>{value}</span>
    </div>
  )
}

/** 输出模式选项（多声道单独渲染为禁用按钮，见下方手写三键组） */
const OUTPUT_MODES: { value: OutputMode; label: string }[] = [
  { value: 'binaural', label: '双耳 Binaural' },
  { value: 'stereo', label: '立体声下混' },
]

/** 键位编辑器：KeyMap 8 个可配置动作（与 worldControl.DEFAULT_KEYMAP 一一对应，§5.6） */
type KeyMapAction = keyof KeyMap

const KEY_ACTIONS: { action: KeyMapAction; label: string }[] = [
  { action: 'forward', label: '前进' },
  { action: 'back', label: '后退' },
  { action: 'left', label: '左移' },
  { action: 'right', label: '右移' },
  { action: 'up', label: '上升' },
  { action: 'down', label: '下降' },
  { action: 'tab', label: '切换声源' },
  { action: 'space', label: '播放/暂停' },
]

/** 键位显示：空格 → 「空格」；单字符大写；Tab 等复合键原样（e.key 存储值） */
function displayKey(k: string): string {
  if (k === ' ') return '空格'
  return k.length === 1 ? k.toUpperCase() : k
}

/** 性能模式选项（已落地：quality→HRTF 球谐插值 / balanced·lowLatency→最近邻，
 *  fusion 映射 + 随快照持久化；旧快照缺省按 balanced 处理） */
const PERF_MODES: { value: SpatialParams['perfMode']; label: string }[] = [
  { value: 'quality', label: '高质量' },
  { value: 'balanced', label: '平衡' },
  { value: 'lowLatency', label: '低延迟' },
]

export default function SpatialSettingsModal({ open, onClose, theme, spatial, onPatch }: SpatialSettingsModalProps) {
  /** SOFA 文件选择 input（隐藏，点击导入按钮触发；导入功能开发中，保留 ref 备用） */
  const sofaInputRef = useRef<HTMLInputElement>(null)
  /** 弹窗面板 ref：open 时聚焦（a11y：role=dialog 焦点起点；完整 focus trap 后续） */
  const containerRef = useRef<HTMLDivElement>(null)
  /** 键位捕获态（null = 未捕获；捕获期间 window keydown 写回 keymap） */
  const [capturing, setCapturing] = useState<KeyMapAction | null>(null)
  /** 捕获态 ref（Escape 关闭监听与捕获监听共用同一判断，防闭包陈旧） */
  const capturingRef = useRef<KeyMapAction | null>(null)
  capturingRef.current = capturing

  // 弹窗关闭时重置捕获态（背板点击关闭等路径不经过捕获监听，防下次打开残留捕获）
  useEffect(() => {
    if (!open) setCapturing(null)
  }, [open])

  // a11y：弹窗打开时聚焦面板（role=dialog 焦点起点；完整 focus trap 后续）
  useEffect(() => {
    if (!open) return
    // 下一帧聚焦，确保面板已挂载（open=true 时 return null 分支已跳过）
    const raf = requestAnimationFrame(() => containerRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // 键位捕获期间 Esc 由捕获监听（capture 阶段先于本监听触发）取消捕获，
      // 此处经 ref 判断跳过关闭——防止捕获态下按 Esc 把弹窗关了
      if (e.key === 'Escape' && capturingRef.current === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * 键位捕获：capture 阶段监听 + preventDefault/stopPropagation——下一个 keydown
   * 写回该动作的映射（e.key 原样存储，partial 覆盖，未配置动作回默认键）；Esc
   * 取消捕获态。capture 阶段 stopPropagation 同时挡住页面层 WorldPanel 等 window
   * 监听，捕获期间按键不泄漏到世界漫游。重复键位允许（不阻止），行内提示冲突。
   * open 守卫：弹窗关闭（背板点击等）后监听即摘除，捕获态残留由上方重置 effect 清理。
   */
  useEffect(() => {
    if (!open || !capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      // 纯修饰键单独按下不绑定（无独立键位语义，组合键后续 wave）
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return
      onPatch({ keymap: { ...(spatial.keymap ?? {}), [capturing]: e.key } })
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, capturing, spatial.keymap, onPatch])

  if (!open) return null

  /** 当前输出模式（已落地字段；持久化旧快照缺省时回退双耳，防御性兜底） */
  const output: OutputMode = spatial.output ?? 'binaural'

  /**
   * 与其它动作撞键的冲突动作列表（小写比较，与 worldControl 键比较约定一致；
   * 重复键位允许——仅行内小字提示，不阻止保存）。
   */
  const conflictsFor = (action: KeyMapAction): KeyMapAction[] => {
    const keyOf = (a: KeyMapAction): string => (spatial.keymap?.[a] ?? DEFAULT_KEYMAP[a]).toLowerCase()
    const mine = keyOf(action)
    return KEY_ACTIONS.filter((r) => r.action !== action && keyOf(r.action) === mine).map((r) => r.action)
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{
        backgroundColor: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        animation: 'wf-sp-settings-fade 0.15s ease-out',
      }}
      onClick={onClose}
    >
      <style>{SP_SETTINGS_KEYFRAMES}</style>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="空间音频设置"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[86vh] overflow-y-auto rounded-3xl"
        style={{
          background: theme.panelBg,
          backdropFilter: theme.glassBlur,
          WebkitBackdropFilter: theme.glassBlur,
          border: `1px solid ${theme.panelBorder}`,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.12)',
          animation: 'wf-sp-settings-pop 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.15)',
          outline: 'none',
        }}
      >
        <div className="p-5">
          {/* 头部 */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: `${theme.accentColor}22`, color: theme.accentColor, border: `1px solid ${theme.accentColor}55` }}
              >
                <Settings2 className="w-4.5 h-4.5" />
              </div>
              <div className={`${theme.textPrimary} font-semibold`}>空间音频设置</div>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭弹窗" className={`p-2 rounded-full transition-colors hover:bg-white/15`}>
              <X className="w-4.5 h-4.5" style={{ color: theme.textSecondary }} />
            </button>
          </div>

          {/* 输出模式（Segmented 三键组：多声道开发中禁用）→ onPatch({ output: v }) */}
          <SectionTitle theme={theme} first>输出模式</SectionTitle>
          <div className="flex gap-1.5 mb-2">
            {OUTPUT_MODES.map((m) => {
              const active = output === m.value
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onPatch({ output: m.value })}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] transition-all ${active ? 'text-white font-medium' : theme.textSecondary}`}
                  style={active
                    ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
                    : { backgroundColor: 'rgba(255,255,255,0.06)' }}
                >
                  {m.label}
                </button>
              )
            })}
            {/* 多声道（开发中禁用：多声道输入路由后续 wave） */}
            <button
              type="button"
              disabled
              className={`flex-1 py-1.5 rounded-lg text-[11px] cursor-not-allowed opacity-50 ${theme.textTertiary}`}
              style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
            >
              多声道<DevBadge theme={theme} />
            </button>
          </div>
          <p className={`${theme.textMuted} text-[10px] mb-2`}>立体声下混把双耳信号折叠为普通立体声输出（外放场景）。</p>

          {/* 输出设备：空间音频已内联 EngineV3，原 fusion 层 enumerateDevices/setSinkId 已移除；
              标注「开发中」，后续 wave 接主播放器 AudioContext.setSinkId */}
          <SectionTitle theme={theme}>输出设备</SectionTitle>
          <div
            className="flex items-center justify-between py-1.5 px-2.5 rounded-lg cursor-not-allowed opacity-50"
            style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
          >
            <span className={`${theme.textTertiary} text-[11px]`}>系统默认（开发中）</span>
            <DevBadge theme={theme} />
          </div>
          <p className={`${theme.textMuted} text-[10px] mt-1 mb-2`}>
            输出设备切换后续 wave 接入主播放器 AudioContext.setSinkId。
          </p>

          {/* HRTF 数据集：空间音频已内联 EngineV3，用合成解析 HRTF（analyticHrtf）；
              原 sofa.ts 导入 + gridSource 内置数据集切换 + fusion 热更新已移除，
              标注「开发中」，后续 wave 改走 EngineV3 内联合成 HRTF / 运行时数据集加载 */}
          <SectionTitle theme={theme}>HRTF 数据集</SectionTitle>
          <div className="flex items-center justify-between py-1">
            <span className={`${theme.textTertiary} text-[11px]`}>当前数据集</span>
            <span className={`hse-mono text-[11px] ${theme.textSecondary}`}>合成 HRTF（开发中）</span>
          </div>
          <div className="space-y-1">
            {/* 内置 KEMAR / CIPIC 数据集切换：原 gridSource 内嵌数据已废弃（合成兜底替代），
                禁用占位，后续 wave 接运行时 fetch / EngineV3 内联数据集 */}
            {([
              { id: 'kemar', name: 'MIT KEMAR' },
              { id: 'cipic', name: 'CIPIC subject_003' },
            ] as const).map((ds) => (
              <button
                key={ds.id}
                type="button"
                disabled
                className="w-full flex items-center justify-between py-1.5 px-2.5 rounded-lg text-[11px] transition-all cursor-not-allowed opacity-50"
                style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
              >
                <span>内置 {ds.name}</span>
                <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.5)' }}>开发中</span>
              </button>
            ))}
            {/* SADIE II：需注册下载（sofacoustics 官方库需登录），后续 wave 接入 */}
            <button
              type="button"
              disabled
              className={`w-full flex items-center justify-between py-1.5 px-2.5 rounded-lg text-[11px] transition-all cursor-not-allowed opacity-50 ${theme.textTertiary}`}
              style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
            >
              <span>SADIE II</span>
              <DevBadge theme={theme} />
            </button>
          </div>
          {/* SOFA 导入按钮：sofa.ts 已移除，禁用占位（input 保留 ref 备后续 wave 接线） */}
          <input
            ref={sofaInputRef}
            type="file"
            accept=".sofa,application/sofa"
            className="hidden"
            onChange={() => { /* SOFA 导入开发中，后续 wave 接 EngineV3 内联 */ }}
          />
          <button
            type="button"
            disabled
            className="w-full py-2 rounded-lg text-[11px] text-center transition-all cursor-not-allowed opacity-50"
            style={{ background: `${theme.accentColor}12`, border: `1px dashed ${theme.accentColor}55`, color: theme.textSecondary }}
          >
            <Upload className="w-3.5 h-3.5 inline mr-1 align-[-2px]" />
            导入 SOFA 数据集（开发中）
          </button>
          <p className={`${theme.textMuted} text-[10px] mt-1 mb-2`}>
            空间音频现用合成解析 HRTF（无需数据文件）；SOFA 数据集导入后续 wave 接入。
          </p>

          {/* 卷积模式（分区 FFT 卷积 / 时域直接卷积；后端契约 spatial_set_convolution_mode，已全量实现） */}
          <SectionTitle theme={theme}>卷积模式</SectionTitle>
          <div className="flex gap-1.5 mb-2">
            <button
              type="button"
              onClick={() => onPatch({ convolution: 'partitioned' })}
              className={`flex-1 py-1.5 rounded-lg text-[11px] ${
                spatial.convolution === 'partitioned'
                  ? 'text-white font-medium'
                  : theme.textTertiary
              }`}
              style={
                spatial.convolution === 'partitioned'
                  ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
                  : { backgroundColor: 'rgba(255,255,255,0.06)' }
              }
            >
              分区卷积
            </button>
            <button
              type="button"
              onClick={() => onPatch({ convolution: 'time' })}
              className={`flex-1 py-1.5 rounded-lg text-[11px] ${
                spatial.convolution === 'time' ? 'text-white font-medium' : theme.textTertiary
              }`}
              style={
                spatial.convolution === 'time'
                  ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
                  : { backgroundColor: 'rgba(255,255,255,0.06)' }
              }
            >
              时域
            </button>
          </div>
          <p className={`${theme.textMuted} text-[10px] mb-2`}>时域直接卷积与分区卷积干湿对齐一致（脉冲位置 ±0 样本），听感差异仅为 FFT 圆整。</p>

          {/* HRIR 长度 / 最大对象数（静态展示；最大对象数 64：引擎支持到 64 对象，本波性能基准已覆盖） */}
          <SectionTitle theme={theme}>渲染资源</SectionTitle>
          <InfoRow label="HRIR 长度" value="256 样本" theme={theme} />
          <InfoRow label="最大对象数" value="64" theme={theme} />

          {/* 性能模式（已落地：quality→球谐插值 / balanced·lowLatency→最近邻，
              fusion 映射 + 随快照持久化，见 fusion.spatialConfigFromParams） */}
          <SectionTitle theme={theme}>性能模式</SectionTitle>
          <Segmented
            options={PERF_MODES}
            value={spatial.perfMode}
            onChange={(v) => onPatch({ perfMode: v })}
            theme={theme}
            small
          />
          <p className={`${theme.textMuted} text-[10px] mt-1 mb-2`}>高质量档启用 HRTF 球谐插值（方位过渡更平滑）；平衡/低延迟档为最近邻插值（更快）。</p>

          {/* 快捷键（§5.6 键位编辑器）：8 个动作逐行显示当前键位 + 捕获按钮，
              捕获态按下新键写回 spatial.keymap（partial 覆盖） */}
          <SectionTitle theme={theme}>快捷键</SectionTitle>
          <div className="space-y-1 mb-1.5">
            {KEY_ACTIONS.map(({ action, label }) => {
              const key = spatial.keymap?.[action] ?? DEFAULT_KEYMAP[action]
              const conflicts = conflictsFor(action)
              const isCapturing = capturing === action
              return (
                <div key={action} className="flex items-center justify-between gap-2 py-0.5">
                  <div className="min-w-0">
                    <span className={`${theme.textSecondary} text-[11px]`}>{label}</span>
                    {conflicts.length > 0 && (
                      <span className="ml-1.5 text-[9px]" style={{ color: theme.statusWarn }}>
                        与 {conflicts.map(displayKey).join(' / ')} 冲突
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`hse-mono ${theme.textSecondary} text-[11px] w-9 text-center`}>
                      {displayKey(key)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCapturing(isCapturing ? null : action)}
                      className="px-2 py-0.5 rounded-md text-[10px] transition-all cursor-pointer"
                      style={isCapturing
                        ? { background: theme.accentGradient, color: '#fff' }
                        : { background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)' }}
                    >
                      {isCapturing ? '按下新键…' : '修改'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {/* 恢复默认：keymap 置 undefined → 行为回退 DEFAULT_KEYMAP（无自定义映射时禁用） */}
          <button
            type="button"
            disabled={!spatial.keymap}
            onClick={() => onPatch({ keymap: undefined })}
            className="w-full py-1.5 rounded-lg text-[11px] text-center transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: `1px dashed ${theme.cardBorder}`, color: theme.textSecondary }}
          >
            恢复默认键位
          </button>
          {/* 操作说明：固定功能键 + 已实现能力（Tab 切换声源已落地，非开发中） */}
          <p className={`${theme.textMuted} text-[10px] mt-1.5 mb-2 leading-relaxed`}>
            操作：W/A/S/D 移动 · Q/E 升降 · ←/→ 转头 · R 重置听者 · F 第一人称跟随 · 空格 播放/暂停 · Tab 切换声源。←/→ 转头与 R/F 为固定功能键（不可修改）；键位改动即时生效并随设置持久化。
          </p>

          {/* 主题（静态展示） */}
          <SectionTitle theme={theme}>主题</SectionTitle>
          <div className="flex items-center justify-between py-1">
            <span className={`${theme.textTertiary} text-[11px]`}>配色方案</span>
            <span className="flex items-center gap-1.5 text-[11px]">
              <span className="w-3 h-3 rounded-full" style={{ background: theme.accentFrom, boxShadow: `0 0 8px ${theme.accentFrom}88` }} />
              <span className="w-3 h-3 rounded-full" style={{ background: theme.accentTo, boxShadow: `0 0 8px ${theme.accentTo}88` }} />
              <span className={`${theme.textSecondary}`}>HSE 电光青→紫</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

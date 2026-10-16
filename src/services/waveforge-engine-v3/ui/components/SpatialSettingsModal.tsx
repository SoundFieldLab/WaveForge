/**
 * 空间音频设置：HRTF 插值、卷积方式、距离衰减及世界漫游键位。
 * 仅提供引擎已接线的配置；输出设备跟随主播放器。
 * 弹窗限制键盘焦点，键位捕获时拦截页面快捷键，关闭后恢复入口焦点。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Settings2, X } from 'lucide-react'
import type { HSETheme } from '../hse-theme'
import type { DeepPartial, SpatialParams } from '../../src/spatial/types'
// 空间音频已内联 EngineV3（纯 TS DSP），当前使用合成解析 HRTF。
// 外部 SOFA 数据集导入与独立 fusion worklet 已移除，避免展示不可操作的占位控件。
// 输出设备切换仍由主播放器的独立设备控制入口负责。
import { Segmented, Slider } from './Primitives'
import { DEFAULT_KEYMAP } from './worldControl'
import type { KeyMap } from './worldControl'

interface SpatialSettingsModalProps {
  open: boolean
  onClose: () => void
  theme: HSETheme
  /** 空间参数快照（实际传入引擎 SpatialSettings——含 hrtfInterp/convolution/
   *  distanceModel/refDistance/maxDistance，keymap 为 UI 附加字段随快照持久化；
   *  旧独立命名空间的 output/perfMode/sinkId 字段引擎侧不存在，对应控件已改为
   *  hrtfInterp 真接线 / 静态展示） */
  spatial: SpatialParams & {
    hrtfInterp?: 'nearest' | 'spherical'
    distanceModel?: 'inverse' | 'linear' | 'exponential'
    refDistance?: number
    maxDistance?: number
  }
  /** 深合并写入（HRTF 插值/距离衰减切换直接进入引擎配置） */
  onPatch: (p: DeepPartial<SpatialParams & {
    hrtfInterp?: 'nearest' | 'spherical'
    distanceModel?: 'inverse' | 'linear' | 'exponential'
    refDistance?: number
    maxDistance?: number
  }>) => void
}

/** 弹窗动画 keyframes（独立命名，不与既有 v3-modal-* 冲突） */
const SP_SETTINGS_KEYFRAMES = `
@keyframes wf-sp-settings-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes wf-sp-settings-pop { from { opacity: 0; transform: scale(0.96) translateY(8px) } to { opacity: 1; transform: scale(1) translateY(0) } }
@media (prefers-reduced-motion: reduce) { .hse-spatial-settings, .hse-spatial-settings > [role="dialog"] { animation: none !important } }
`

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

/** 世界漫游已接线的可配置动作；音乐播放由主播放器操作。 */
type KeyMapAction = keyof KeyMap

const KEY_ACTIONS: { action: KeyMapAction; label: string }[] = [
  { action: 'forward', label: '前进' },
  { action: 'back', label: '后退' },
  { action: 'left', label: '左移' },
  { action: 'right', label: '右移' },
  { action: 'up', label: '上升' },
  { action: 'down', label: '下降' },
  { action: 'tab', label: '切换声源' },
]

/** 键位显示：空格 → 「空格」；单字符大写；Tab 等复合键原样（e.key 存储值） */
function displayKey(k: string): string {
  if (k === ' ') return '空格'
  return k.length === 1 ? k.toUpperCase() : k
}

/** HRTF 插值选项（引擎真字段 hrtfInterp 直接接线：旧 perfMode 三档中 balanced 与
 *  lowLatency 在 DSP 均为最近邻，收敛为两档表达真实差异） */
const HRTF_INTERP_OPTIONS: { value: 'nearest' | 'spherical'; label: string }[] = [
  { value: 'nearest', label: '平衡（最近邻）' },
  { value: 'spherical', label: '高质量（球谐插值）' },
]

/** 距离衰减模型选项（引擎真字段 distanceModel） */
const DISTANCE_MODELS: { value: 'inverse' | 'linear' | 'exponential'; label: string }[] = [
  { value: 'inverse', label: '反距离' },
  { value: 'linear', label: '线性' },
  { value: 'exponential', label: '指数' },
]

export default function SpatialSettingsModal({ open, onClose, theme, spatial, onPatch }: SpatialSettingsModalProps) {
  /** 弹窗面板与键盘焦点范围。 */
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

  // 焦点留在弹窗内；关闭时返回原入口，避免键盘焦点落回页面底部。
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const raf = requestAnimationFrame(() => containerRef.current?.focus())
    const trapFocus = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || capturingRef.current !== null) return
      const panel = containerRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter((el) => !el.hidden)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) { e.preventDefault(); panel.focus(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', trapFocus)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', trapFocus)
      if (previous?.isConnected) previous.focus()
    }
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
      className="hse-spatial-settings fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{
        backgroundColor: 'rgba(21,58,55,0.22)',
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
          background: theme.panelHighlight,
          border: `1px solid ${theme.panelBorder}`,
          boxShadow: 'inset 0 1px 0 #ffffff, 0 16px 48px rgba(21,58,55,0.16)',
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
            <button type="button" onClick={onClose} aria-label="关闭弹窗" className={`hse-glass-button rounded-full p-2 focus-visible:outline-2 ${theme.textSecondary}`}>
              <X className="w-4.5 h-4.5" />
            </button>
          </div>

          {/* 输出模式：空间级内联 EngineV3（第 15 级，双耳渲染后立体声写出）——
              渲染管线固定为双耳输出；旧「立体声下混/多声道」按钮写的 output 字段
              引擎侧不存在（点击无效果），改为如实静态展示 */}
          <SectionTitle theme={theme} first>输出模式</SectionTitle>
          <InfoRow label="当前输出" value="双耳 Binaural" theme={theme} />
          <p className={`${theme.textSecondary} text-xs mb-2`}>空间音频渲染为双耳立体声，建议佩戴耳机聆听。</p>

          {/* 输出设备：空间音频已内联 EngineV3，原 fusion 层 enumerateDevices/setSinkId 已移除；
              标注「开发中」，后续 wave 接主播放器 AudioContext.setSinkId */}
          <SectionTitle theme={theme}>输出设备</SectionTitle>
          <InfoRow label="使用设备" value="跟随主播放器" theme={theme} />

          {/* HRTF 数据集：空间音频由 EngineV3 的 analyticHrtf 提供合成解析 HRTF。 */}
          <SectionTitle theme={theme}>HRTF 数据集</SectionTitle>
          <div className="flex items-center justify-between py-1">
            <span className={`${theme.textTertiary} text-[11px]`}>当前数据集</span>
            <span className={`hse-mono text-[11px] ${theme.textSecondary}`}>合成解析 HRTF</span>
          </div>
          {/* 卷积模式（分区 FFT 卷积 / 时域直接卷积；后端契约 spatial_set_convolution_mode，已全量实现） */}
          <SectionTitle theme={theme}>卷积模式</SectionTitle>
          <Segmented label="空间音频卷积模式" options={[{ value: 'partitioned', label: '分区卷积' }, { value: 'time', label: '时域卷积' }]}
            value={spatial.convolution} onChange={(convolution) => onPatch({ convolution })} theme={theme} small />
          <p className={`${theme.textSecondary} text-xs mt-2 mb-2`}>两种模式保持相同的干湿对齐；分区卷积适合较多声源。</p>

          {/* HRIR 长度 / 最大对象数（静态展示；最大对象数 64：引擎支持到 64 对象，本波性能基准已覆盖） */}
          <SectionTitle theme={theme}>渲染资源</SectionTitle>
          <InfoRow label="HRIR 长度" value="256 样本" theme={theme} />
          <InfoRow label="最大对象数" value="64" theme={theme} />

          {/* 距离衰减（规格书属性面板「衰减模型/参考距离/最大距离」——全局渲染参数，
              引擎真字段直接接线：三模型 + ref 内不衰减 + linear 到 max 衰减为 0） */}
          <SectionTitle theme={theme}>距离衰减</SectionTitle>
          <Segmented
            label="距离衰减模型"
            options={DISTANCE_MODELS}
            value={spatial.distanceModel ?? 'inverse'}
            onChange={(v) => onPatch({ distanceModel: v })}
            theme={theme}
            small
          />
          <div className="mt-2 mb-1">
            <Slider
              label="参考距离（内不衰减）" value={spatial.refDistance ?? 1} min={0.5} max={3} step={0.1}
              onChange={(v) => onPatch({ refDistance: v })}
              display={`${(spatial.refDistance ?? 1).toFixed(1)} m`} theme={theme}
            />
            <Slider
              label="最大距离（linear 衰减到 0）" value={spatial.maxDistance ?? 50} min={5} max={100} step={1}
              onChange={(v) => onPatch({ maxDistance: v })}
              display={`${Math.round(spatial.maxDistance ?? 50)} m`} theme={theme}
            />
          </div>
          <p className={`${theme.textMuted} text-[10px] mt-1 mb-2`}>反距离=自然远衰（1/d）；线性=到最大距离衰减为 0；指数=更陡的 1/(d/ref)。参考距离内均不衰减。</p>

          {/* HRTF 插值（引擎真字段 hrtfInterp 直接接线——旧 perfMode 控件写的字段
              引擎侧不存在，点击无任何效果；现直接读写 hrtfInterp，切换即时生效） */}
          <SectionTitle theme={theme}>HRTF 插值（性能模式）</SectionTitle>
          <Segmented
            label="HRTF 插值质量"
            options={HRTF_INTERP_OPTIONS}
            value={spatial.hrtfInterp ?? 'nearest'}
            onChange={(v) => onPatch({ hrtfInterp: v })}
            theme={theme}
            small
          />
          <p className={`${theme.textMuted} text-[10px] mt-1 mb-2`}>高质量档启用 HRTF 球谐插值（方位过渡更平滑）；平衡档为最近邻插值（更快）。</p>

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
                        与 {conflicts.map((action) => KEY_ACTIONS.find((item) => item.action === action)?.label ?? action).join(' / ')} 冲突
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`hse-mono ${theme.textSecondary} text-[11px] w-9 text-center`}>
                      {displayKey(key)}
                    </span>
                    <button
                      type="button"
                      aria-label={`修改${label}快捷键`}
                      aria-pressed={isCapturing}
                      onClick={() => setCapturing(isCapturing ? null : action)}
                      className={`hse-glass-button hse-glass-choice min-h-9 px-3 rounded-lg text-xs cursor-pointer focus-visible:outline-2 ${theme.textSecondary}`}
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
            className={`hse-glass-button w-full min-h-9 rounded-lg text-xs text-center cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-2 ${theme.textSecondary}`}
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
              <span className="w-3 h-3 rounded-full border" style={{ background: theme.panelBg, borderColor: theme.cardBorder }} />
              <span className="w-3 h-3 rounded-full" style={{ background: '#C8EDE4' }} />
              <span className={`${theme.textSecondary}`}>珍珠白 · 薄荷青</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

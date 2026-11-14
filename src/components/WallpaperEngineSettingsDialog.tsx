/**
 * Wallpaper Engine 设置独立弹窗（液态玻璃风格 v2）。
 *
 * 从桌面模式设置弹窗的「浏览壁纸引擎」入口打开，替代原二级子菜单：
 * WE 壁纸库浏览 / 同步互斥提示 / 自动轮换设置，全部收进这一个独立弹窗。
 * 自定义壁纸、分辨率等其余设置仍在桌面模式设置弹窗原位，不受影响。
 *
 * ## 液态玻璃 v2 版式
 * - 外层 1px 渐变描边包边（p-px 技法）：玻璃边缘呈现"折射光带"，左上亮右下暗
 * - 内层玻璃 `blur(44px) saturate(180%)` + 渐变白叠加 + inset 双向高光
 * - 两团氛围光斑（粉/紫）在容器内部缓慢晕染，增强"液体"质感
 * - 网格卡片 stagger 入场（延迟限幅 12 项）+ hover 浮起 + 图片淡入
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  Check,
  Gauge,
  Image as ImageIcon,
  ListOrdered,
  MousePointer2,
  RotateCcw,
  Shuffle,
  SlidersHorizontal,
  Timer,
  Volume2,
  X,
} from 'lucide-react'
import type { WallpaperEngineRotationSettings, WallpaperEngineWallpaper } from '../services/wallpaperEngineRotation'
import type { WallpaperEnginePlaybackSettings } from '../services/wallpaperEnginePlayback'
import { getApiOrigin } from '../services/apiConfig'

interface WallpaperEngineSettingsDialogProps {
  show: boolean
  onClose: () => void
  weWallpapers: WallpaperEngineWallpaper[]
  weLoading: boolean
  weError: string | null
  selectedWeWallpaper: string | null
  wallpaperSyncEnabled: boolean
  onScanWeWallpapers: () => void
  onSelectWeWallpaper: (wallpaper: WallpaperEngineWallpaper) => void
  wallpaperRotation: WallpaperEngineRotationSettings
  onWallpaperRotationChange: (settings: WallpaperEngineRotationSettings) => void
  /** 播放参数（音量/帧率/视差/音频响应） */
  wallpaperPlayback: WallpaperEnginePlaybackSettings
  onWallpaperPlaybackChange: (settings: WallpaperEnginePlaybackSettings) => void
}

/** 壁纸类型徽章配色 */
const TYPE_BADGES: Record<WallpaperEngineWallpaper['type'], { label: string; className: string }> = {
  video: { label: '视频', className: 'bg-pink-500/80 text-white' },
  image: { label: '图片', className: 'bg-emerald-500/80 text-white' },
  scene: { label: '场景 · 静态', className: 'bg-violet-500/80 text-white' },
  web: { label: 'Web', className: 'bg-blue-500/80 text-white' },
}

export default function WallpaperEngineSettingsDialog({
  show,
  onClose,
  weWallpapers,
  weLoading,
  weError,
  selectedWeWallpaper,
  wallpaperSyncEnabled,
  onScanWeWallpapers,
  onSelectWeWallpaper,
  wallpaperRotation,
  onWallpaperRotationChange,
  wallpaperPlayback,
  onWallpaperPlaybackChange,
}: WallpaperEngineSettingsDialogProps) {
  // 图片加载完成后淡入，避免网格卡片闪白
  const [loadedPreviews, setLoadedPreviews] = useState<Record<string, boolean>>({})

  const rotationCount = wallpaperRotation.selectedWallpaperIds.length
  const rotationReady = rotationCount >= 2

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩：比桌面设置弹窗更轻（bg-black/35），玻璃感靠容器自身 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-[200] bg-black/35 backdrop-blur-[6px]"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="fixed left-1/2 top-1/2 z-[201] max-h-[calc(100vh-2.5rem)] w-[min(780px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2"
          >
            {/* 渐变描边外层：1px 包边呈现玻璃边缘折射光带 */}
            <div
              className="rounded-[28px] p-px"
              style={{
                background:
                  'linear-gradient(165deg, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.10) 34%, rgba(255,255,255,0.05) 60%, rgba(236,72,153,0.28) 100%)',
                boxShadow:
                  '0 32px 90px rgba(0,0,0,0.6), 0 8px 30px rgba(0,0,0,0.45)',
              }}
            >
              {/* 液态玻璃卡片内层 */}
              <div
                className="relative flex max-h-[calc(100vh-2.5rem)] flex-col overflow-hidden rounded-[27px]"
                style={{
                  background:
                    'linear-gradient(150deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.055) 42%, rgba(255,255,255,0.09) 100%)',
                  backdropFilter: 'blur(44px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(44px) saturate(180%)',
                }}
              >
                {/* 氛围光斑：粉（左上）/ 紫（右下），液体质感 */}
                <div
                  className="pointer-events-none absolute -left-24 -top-32 h-72 w-72 rounded-full opacity-45"
                  style={{ background: 'radial-gradient(circle, rgba(236,72,153,0.24) 0%, transparent 70%)', filter: 'blur(24px)' }}
                />
                <div
                  className="pointer-events-none absolute -bottom-36 -right-20 h-80 w-80 rounded-full opacity-40"
                  style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.22) 0%, transparent 70%)', filter: 'blur(28px)' }}
                />

                {/* inset 双向高光覆盖层：上缘反光 + 下缘微光 */}
                <div
                  className="pointer-events-none absolute inset-0 rounded-[27px]"
                  style={{
                    boxShadow:
                      'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -1px 0 rgba(255,255,255,0.06)',
                  }}
                />

                {/* 顶部径向液面高光（纯装饰） */}
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 h-40"
                  style={{
                    background:
                      'radial-gradient(120% 100% at 18% 0%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.03) 45%, transparent 70%)',
                  }}
                />

                {/* 头部 */}
                <div className="relative flex shrink-0 items-center justify-between px-6 pb-4 pt-5">
                  <div className="flex items-center gap-3.5">
                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.08, type: 'spring', damping: 20, stiffness: 300 }}
                      className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                      style={{
                        background: 'linear-gradient(135deg, rgba(236,72,153,0.85) 0%, rgba(139,92,246,0.85) 100%)',
                        boxShadow: '0 6px 20px rgba(236,72,153,0.4), inset 0 1px 0 rgba(255,255,255,0.35)',
                      }}
                    >
                      <ImageIcon className="h-5 w-5" />
                    </motion.div>
                    <div>
                      <div className="flex items-center gap-2.5">
                        <h2 className="text-xl font-bold tracking-wide text-white">Wallpaper Engine</h2>
                        {!wallpaperSyncEnabled && weWallpapers.length > 0 && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-pink-100"
                            style={{ background: 'rgba(236,72,153,0.22)', border: '1px solid rgba(236,72,153,0.35)' }}
                          >
                            {weWallpapers.length} 张可用
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-white/50">
                        <span className="inline-block h-3 w-[3px] rounded-full bg-gradient-to-b from-pink-400 to-violet-400" />
                        选择动态壁纸作为桌面背景
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={onClose}
                    aria-label="关闭 Wallpaper Engine 设置"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition-all hover:rotate-90 hover:bg-white/15 hover:text-white"
                    style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)' }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* 内容区域 */}
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 custom-scrollbar">
                  <div className="text-sm text-white/55">
                    从您的 WallpaperEngine 库中选择动态壁纸作为背景
                  </div>

                  {/* 播放参数（对场景/视频壁纸即时生效；同步联动模式下依然有效） */}
                  <div
                    className="rounded-2xl p-4"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      backdropFilter: 'blur(12px)',
                    }}
                  >
                    <div className="mb-3.5 flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200">
                        <SlidersHorizontal className="h-4 w-4" />
                      </div>
                      <div className="font-medium text-white">播放参数</div>
                      <div className="text-[11px] text-white/40">对场景与视频壁纸即时生效</div>
                    </div>

                    {/* 音量（WWGL 场景静音起步 + 视频壁纸 volume；0 视为静音） */}
                    <div className="flex items-center gap-3">
                      <Volume2 className="h-4 w-4 shrink-0 text-white/55" />
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={wallpaperPlayback.volume}
                        onChange={event => onWallpaperPlaybackChange({ ...wallpaperPlayback, volume: Number(event.target.value) })}
                        className="h-1.5 flex-1 cursor-pointer accent-pink-500"
                        aria-label="壁纸音量"
                      />
                      <span className="w-11 text-right text-xs tabular-nums text-white/60">{wallpaperPlayback.volume}%</span>
                    </div>

                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3">
                      {/* 帧率上限 */}
                      <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                        <div className="flex items-center gap-1.5 text-[11px] text-white/45"><Gauge className="h-3.5 w-3.5" />帧率上限</div>
                        <div className="mt-2 grid grid-cols-3 gap-2">
                          {([60, 30, 24] as const).map(fps => (
                            <button
                              key={fps}
                              type="button"
                              onClick={() => onWallpaperPlaybackChange({ ...wallpaperPlayback, fpsLimit: fps })}
                              className={`flex h-9 items-center justify-center rounded-lg border text-xs transition ${
                                wallpaperPlayback.fpsLimit === fps
                                  ? 'border-pink-400/60 bg-pink-500/16 text-pink-100'
                                  : 'border-white/10 bg-white/[0.035] text-white/55 hover:bg-white/[0.07]'
                              }`}
                            >
                              {fps === 60 ? '60 流畅' : fps === 30 ? '30 标准' : '24 省电'}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 视差 / 音频响应开关 */}
                      <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2 text-xs text-white/70">
                            <MousePointer2 className="h-3.5 w-3.5 shrink-0 text-white/45" />
                            <span className="truncate">鼠标视差</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => onWallpaperPlaybackChange({ ...wallpaperPlayback, parallaxEnabled: !wallpaperPlayback.parallaxEnabled })}
                            className={`relative h-6 w-10 shrink-0 rounded-full transition ${wallpaperPlayback.parallaxEnabled ? 'bg-pink-500' : 'bg-white/15'}`}
                            style={wallpaperPlayback.parallaxEnabled ? { boxShadow: '0 3px 10px rgba(236,72,153,0.4)' } : undefined}
                            aria-label="鼠标视差"
                            aria-pressed={wallpaperPlayback.parallaxEnabled}
                          >
                            <motion.span
                              layout
                              transition={{ type: 'spring', damping: 24, stiffness: 380 }}
                              className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow ${wallpaperPlayback.parallaxEnabled ? 'left-5' : 'left-1'}`}
                            />
                          </button>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2 text-xs text-white/70">
                            <Activity className="h-3.5 w-3.5 shrink-0 text-white/45" />
                            <span className="truncate">音乐律动</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => onWallpaperPlaybackChange({ ...wallpaperPlayback, audioReactiveEnabled: !wallpaperPlayback.audioReactiveEnabled })}
                            className={`relative h-6 w-10 shrink-0 rounded-full transition ${wallpaperPlayback.audioReactiveEnabled ? 'bg-pink-500' : 'bg-white/15'}`}
                            style={wallpaperPlayback.audioReactiveEnabled ? { boxShadow: '0 3px 10px rgba(236,72,153,0.4)' } : undefined}
                            aria-label="音乐律动"
                            aria-pressed={wallpaperPlayback.audioReactiveEnabled}
                          >
                            <motion.span
                              layout
                              transition={{ type: 'spring', damping: 24, stiffness: 380 }}
                              className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow ${wallpaperPlayback.audioReactiveEnabled ? 'left-5' : 'left-1'}`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 提示：需要关闭同步 */}
                  {wallpaperSyncEnabled && (
                    <div
                      className="rounded-2xl p-4 backdrop-blur-sm"
                      style={{ background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.35)' }}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 text-amber-300">⚠️</div>
                        <div>
                          <div className="mb-1 font-medium text-amber-100">需要关闭同步功能</div>
                          <div className="text-sm text-amber-100/75">
                            请先在桌面设置中关闭「Wallpaper Engine 同步」，才能手动选择壁纸
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* WallpaperEngine 壁纸列表 */}
                  {!wallpaperSyncEnabled && (
                    <div>
                      <div className="mb-3 flex items-center justify-between">
                        <div className="font-medium text-white">可用壁纸</div>
                        <button
                          onClick={onScanWeWallpapers}
                          disabled={weLoading}
                          className="group flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-all disabled:cursor-not-allowed disabled:opacity-50"
                          style={{
                            background: 'linear-gradient(135deg, rgba(236,72,153,0.9) 0%, rgba(168,85,247,0.88) 100%)',
                            border: '1px solid rgba(255,255,255,0.22)',
                            boxShadow: '0 8px 24px rgba(236,72,153,0.35)',
                          }}
                        >
                          {weLoading ? (
                            <>
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              扫描中...
                            </>
                          ) : (
                            <>
                              <RotateCcw className="h-4 w-4 transition-transform duration-500 group-hover:-rotate-180" />
                              扫描壁纸
                            </>
                          )}
                        </button>
                      </div>

                      {/* 自动轮换设置 */}
                      <div
                        className="mb-4 rounded-2xl p-4"
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          backdropFilter: 'blur(12px)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pink-500/15 text-pink-200"><Timer className="h-5 w-5" /></div>
                            <div>
                              <div className="font-medium text-white">自动切换已选壁纸</div>
                              <div className="mt-1 text-xs leading-5 text-white/45">只会轮换你单独勾选的壁纸，不会默认使用整个壁纸库。</div>
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={!rotationReady}
                            onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, enabled: !wallpaperRotation.enabled })}
                            className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition ${wallpaperRotation.enabled ? '' : 'bg-white/15'} disabled:cursor-not-allowed disabled:opacity-35`}
                            style={
                              wallpaperRotation.enabled
                                ? {
                                    background: 'linear-gradient(135deg, rgba(236,72,153,0.95) 0%, rgba(168,85,247,0.9) 100%)',
                                    boxShadow: '0 4px 14px rgba(236,72,153,0.45)',
                                  }
                                : undefined
                            }
                            aria-label="自动切换 Wallpaper Engine 壁纸"
                            aria-pressed={wallpaperRotation.enabled}
                          >
                            <motion.span
                              layout
                              transition={{ type: 'spring', damping: 24, stiffness: 380 }}
                              className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow ${wallpaperRotation.enabled ? 'left-6' : 'left-1'}`}
                            />
                          </button>
                        </div>

                        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3">
                          <label className="rounded-xl border border-white/10 bg-black/25 p-3">
                            <span className="text-[11px] text-white/45">切换间隔（分钟）</span>
                            <input
                              type="number"
                              min={1}
                              max={1440}
                              value={wallpaperRotation.intervalMinutes}
                              onChange={event => onWallpaperRotationChange({ ...wallpaperRotation, intervalMinutes: Number(event.target.value) })}
                              className="mt-2 h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition focus:border-pink-400/60 focus:bg-white/[0.08]"
                            />
                          </label>
                          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                            <div className="text-[11px] text-white/45">切换方式</div>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, mode: 'sequential' })} className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs transition ${wallpaperRotation.mode === 'sequential' ? 'border-pink-400/60 bg-pink-500/16 text-pink-100' : 'border-white/10 bg-white/[0.035] text-white/55 hover:bg-white/[0.07]'}`}><ListOrdered className="h-3.5 w-3.5" />顺序</button>
                              <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, mode: 'random' })} className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs transition ${wallpaperRotation.mode === 'random' ? 'border-pink-400/60 bg-pink-500/16 text-pink-100' : 'border-white/10 bg-white/[0.035] text-white/55 hover:bg-white/[0.07]'}`}><Shuffle className="h-3.5 w-3.5" />随机</button>
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                          <span className={rotationReady ? 'text-emerald-300/85' : 'text-amber-200/75'}>
                            已选择 {rotationCount} 张{rotationReady ? '' : '，至少选择 2 张才能开启'}
                          </span>
                          {rotationCount > 0 && (
                            <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, enabled: false, selectedWallpaperIds: [] })} className="text-white/45 transition hover:text-white/75">清空选择</button>
                          )}
                        </div>
                      </div>

                      {/* 错误提示 */}
                      {weError && (
                        <div className="mb-4 rounded-xl border border-red-400/35 bg-red-500/15 p-3 text-sm text-red-200">
                          {weError}
                        </div>
                      )}

                      {/* 壁纸网格 */}
                      {weWallpapers.length > 0 ? (
                        <div className="grid grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-2" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.3) transparent' }}>
                          {weWallpapers.map((wallpaper, index) => {
                            const participatesInRotation = wallpaperRotation.selectedWallpaperIds.includes(wallpaper.id)
                            const isSelected = selectedWeWallpaper === wallpaper.id
                            const badge = TYPE_BADGES[wallpaper.type]
                            return (
                              <motion.div
                                key={wallpaper.id}
                                initial={{ opacity: 0, y: 14 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: Math.min(index, 12) * 0.045, duration: 0.3, ease: 'easeOut' }}
                                whileHover={{ scale: 1.04, y: -2 }}
                                onClick={() => onSelectWeWallpaper(wallpaper)}
                                className="relative aspect-video cursor-pointer overflow-hidden rounded-xl border-2 transition-shadow"
                                style={
                                  isSelected
                                    ? { borderColor: 'rgba(236,72,153,0.95)', boxShadow: '0 0 0 1px rgba(236,72,153,0.35), 0 10px 30px rgba(236,72,153,0.35)' }
                                    : participatesInRotation
                                      ? { borderColor: 'rgba(34,211,238,0.7)', boxShadow: '0 8px 24px rgba(34,211,238,0.15)' }
                                      : { borderColor: 'rgba(255,255,255,0.12)' }
                                }
                              >
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation()
                                    const selectedWallpaperIds = participatesInRotation
                                      ? wallpaperRotation.selectedWallpaperIds.filter(id => id !== wallpaper.id)
                                      : [...wallpaperRotation.selectedWallpaperIds, wallpaper.id]
                                    onWallpaperRotationChange({
                                      ...wallpaperRotation,
                                      enabled: wallpaperRotation.enabled && selectedWallpaperIds.length >= 2,
                                      selectedWallpaperIds,
                                    })
                                  }}
                                  className={`absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg border backdrop-blur-md transition ${participatesInRotation ? 'border-cyan-300/70 bg-cyan-400/80 text-slate-950' : 'border-white/20 bg-black/45 text-white/65 hover:bg-black/65'}`}
                                  aria-label={participatesInRotation ? '从自动轮换中移除' : '加入自动轮换'}
                                  title={participatesInRotation ? '从自动轮换中移除' : '加入自动轮换'}
                                >
                                  {participatesInRotation ? <Check className="h-4 w-4" /> : <span className="h-2.5 w-2.5 rounded-[3px] border border-current" />}
                                </button>
                                {wallpaper.preview ? (
                                  <img
                                    src={`${getApiOrigin()}${wallpaper.preview}`}
                                    alt={wallpaper.title}
                                    className={`h-full w-full object-cover transition-opacity duration-500 ${loadedPreviews[wallpaper.id] ? 'opacity-100' : 'opacity-0'}`}
                                    onLoad={() => setLoadedPreviews(prev => ({ ...prev, [wallpaper.id]: true }))}
                                    onError={(e) => {
                                      e.currentTarget.style.display = 'none'
                                    }}
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-purple-500/20 to-pink-500/20">
                                    <ImageIcon className="h-8 w-8 text-white/30" />
                                  </div>
                                )}

                                {/* 标题覆盖层 */}
                                <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/80 via-transparent to-transparent p-2">
                                  <div className="w-full">
                                    <div className="truncate text-xs font-medium text-white">
                                      {wallpaper.title}
                                    </div>
                                    <div className="mt-1 flex items-center gap-1.5">
                                      {badge && (
                                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>
                                          {badge.label}
                                        </span>
                                      )}
                                      {participatesInRotation && (
                                        <span className="rounded bg-cyan-400/85 px-1.5 py-0.5 text-[10px] font-medium text-slate-950">
                                          轮换
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* 选中标记 */}
                                {isSelected && (
                                  <motion.div
                                    initial={{ scale: 0, rotate: -60 }}
                                    animate={{ scale: 1, rotate: 0 }}
                                    transition={{ type: 'spring', damping: 15, stiffness: 400 }}
                                    className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-pink-500 shadow-lg shadow-pink-500/50"
                                  >
                                    <Check className="h-4 w-4 text-white" />
                                  </motion.div>
                                )}
                              </motion.div>
                            )
                          })}
                        </div>
                      ) : !weLoading && !weError ? (
                        <div
                          className="rounded-2xl py-12 text-center"
                          style={{ border: '1.5px dashed rgba(255,255,255,0.14)' }}
                        >
                          <div
                            className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full"
                            style={{ background: 'rgba(255,255,255,0.06)' }}
                          >
                            <ImageIcon className="h-7 w-7 text-white/25" />
                          </div>
                          <div className="text-sm text-white/40">
                            点击「扫描壁纸」按钮开始扫描
                          </div>
                        </div>
                      ) : null}

                      {/* 功能说明 */}
                      <div
                        className="mt-4 rounded-xl p-4"
                        style={{
                          background: 'rgba(59,130,246,0.10)',
                          border: '1px solid rgba(96,165,250,0.25)',
                          borderLeft: '3px solid rgba(96,165,250,0.55)',
                        }}
                      >
                        <div className="text-sm leading-6 text-blue-100/85">
                          💡 <strong>功能说明：</strong>
                          <br />
                          • 此功能将扫描您的 WallpaperEngine 安装目录
                          <br />
                          • 列出所有支持的动态壁纸预览图
                          <br />
                          • 点击壁纸立即应用，左上角勾选框控制是否参与自动轮换
                          <br />
                          • 随机模式会避开当前壁纸，顺序模式会从当前壁纸的下一张继续
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

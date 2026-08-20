/**
 * 「看歌」设置弹窗：匹配偏好 / 自动播放门槛 / 视频结束行为 / 画质 / 字幕 / 关键词模板
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import {
  getBilibiliWatchSettings,
  saveBilibiliWatchSettings,
  getDanmakuSettings,
  saveDanmakuSettings,
  type BilibiliWatchSettings,
  type DanmakuSettings,
  type MatchPreference,
  type AutoPlayStrictness,
  type VideoEndBehavior,
  type SubtitlePreference,
  type KeywordTemplate,
} from '../services/bilibiliApi'

interface BilibiliWatchSettingsModalProps {
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

const BILI_PINK = '#FB7299'

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  dark,
}: {
  options: { value: T; label: string; hint?: string }[]
  value: T
  onChange: (v: T) => void
  dark: boolean
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors border ${
            value === opt.value
              ? 'text-white border-transparent'
              : dark
                ? 'bg-white/[0.06] border-white/10 text-white/60 hover:bg-white/[0.12] hover:text-white/85'
                : 'bg-black/[0.04] border-black/10 text-black/55 hover:bg-black/[0.08] hover:text-black/80'
          }`}
          style={value === opt.value ? { backgroundColor: BILI_PINK } : undefined}
          title={opt.hint}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ToggleRow({ label, desc, checked, onChange, dark }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; dark: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className={`text-sm font-medium ${dark ? 'text-white/90' : 'text-black/85'}`}>{label}</div>
        <div className={`text-xs mt-0.5 ${dark ? 'text-white/45' : 'text-black/45'}`}>{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ${checked ? '' : dark ? 'bg-white/15' : 'bg-black/15'}`}
        style={checked ? { backgroundColor: BILI_PINK } : undefined}
      >
        <span className={`pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  dark,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
  dark: boolean
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div>
      <span className={`text-xs ${dark ? 'text-white/45' : 'text-black/45'}`}>{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1 h-1 rounded-full appearance-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
          style={{ background: `linear-gradient(to right, ${BILI_PINK} ${pct}%, rgba(255,255,255,0.2) ${pct}%)` }}
        />
        <span className={`text-xs w-9 text-right ${dark ? 'text-white/60' : 'text-black/55'}`}>{value}{suffix ?? ''}</span>
      </div>
    </div>
  )
}

export default function BilibiliWatchSettingsModal({ onClose, playerTheme = 'dark' }: BilibiliWatchSettingsModalProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const dark = playerTheme === 'dark'
  const [settings, setSettings] = useState<BilibiliWatchSettings>(() => getBilibiliWatchSettings())
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(() => getDanmakuSettings())

  const update = (patch: Partial<BilibiliWatchSettings>) => {
    const next = saveBilibiliWatchSettings(patch)
    setSettings(next)
  }

  const updateDanmaku = (patch: Partial<DanmakuSettings>) => {
    const next = saveDanmakuSettings(patch)
    setDanmakuSettings(next)
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        data-tv-scope
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, y: 14 }}
          animate={{ scale: 1, y: 0 }}
          exit={{ scale: 0.95, y: 14 }}
          onClick={(e) => e.stopPropagation()}
          className={`w-full max-w-lg max-h-[82vh] overflow-y-auto rounded-2xl border p-6 shadow-2xl ${
            dark ? 'bg-[#0c0e1a]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'
          }`}
        >
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className={`text-lg font-bold ${dark ? 'text-white' : 'text-black/90'}`}>看歌设置</h2>
              <p className={`text-xs mt-0.5 ${dark ? 'text-white/45' : 'text-black/45'}`}>B 站 MV 匹配与播放偏好</p>
            </div>
            <button type="button" onClick={onClose} className={`p-1.5 rounded-lg ${dark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
              <X size={18} />
            </button>
          </div>

          <div className="space-y-5">
            {/* 匹配偏好 */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>匹配偏好（优先给你找哪类视频）</h3>
              <Segmented<MatchPreference>
                dark={dark}
                value={settings.matchPreference}
                onChange={(v) => update({ matchPreference: v })}
                options={[
                  { value: 'official', label: '官方MV', hint: '优先唱片公司/官方账号 MV' },
                  { value: 'balanced', label: '均衡', hint: '官方/现场/歌词版综合排序' },
                  { value: 'live', label: '现场版', hint: '优先演唱会/现场/Livehouse' },
                  { value: 'lyrics', label: '歌词字幕', hint: '优先带歌词字幕的视频' },
                  { value: 'hd', label: '高清', hint: '优先 4K/1080P/高清修复' },
                ]}
              />
            </section>

            {/* 自动播放门槛 */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>自动播放门槛</h3>
              <Segmented<AutoPlayStrictness>
                dark={dark}
                value={settings.autoPlayStrictness}
                onChange={(v) => update({ autoPlayStrictness: v })}
                options={[
                  { value: 'strict', label: '严格', hint: '只有高度确信才自动播放，更多时候让你确认' },
                  { value: 'standard', label: '标准', hint: '推荐：置信度高自动播，存疑时列出候选' },
                  { value: 'relaxed', label: '宽松', hint: '更多自动播放，减少确认次数' },
                ]}
              />
            </section>

            {/* 个性化：默认播放系统赋分最高 */}
            <section className="space-y-1 border-t pt-3" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
              <ToggleRow
                dark={dark}
                label="看歌模式默认播放系统赋分最高"
                desc="即使不是完美匹配的也将播放（直接播评分最高的视频，不弹候选确认）"
                checked={settings.forceAutoPlayHighest}
                onChange={(v) => update({ forceAutoPlayHighest: v })}
              />
              {!settings.forceAutoPlayHighest && (
                <p className={`text-xs ${dark ? 'text-white/35' : 'text-black/35'}`}>
                  已关闭：仅当匹配置信度达到「自动播放门槛」时才自动播放，否则列出候选供你选择
                </p>
              )}
            </section>

            {/* 视频结束行为 */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>视频播完时</h3>
              <Segmented<VideoEndBehavior>
                dark={dark}
                value={settings.videoEndBehavior}
                onChange={(v) => update({ videoEndBehavior: v })}
                options={[
                  { value: 'next', label: '下一首', hint: '自动继续播放列表下一首' },
                  { value: 'replay', label: '重播', hint: '自动重新播放本视频' },
                  { value: 'hold', label: '停在末帧', hint: '停在最后一帧，显示重播按钮' },
                ]}
              />
            </section>

            {/* 目标画质（auto=按登录/VIP 自动选最高；登录解锁 1080P，大会员解锁高码率/4K/杜比） */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>目标画质</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { value: 'auto', label: '自动最高', hint: '登录后最高可用（大会员含 4K/杜比）' },
                  { value: 127, label: '杜比音效', hint: '大会员专享', requiresVip: true },
                  { value: 126, label: '杜比视界', hint: '大会员专享', requiresVip: true },
                  { value: 125, label: 'HDR 真彩', hint: '大会员专享', requiresVip: true },
                  { value: 120, label: '4K 超高清', hint: '大会员专享', requiresVip: true },
                  { value: 116, label: '1080P 60帧' },
                  { value: 112, label: '1080P 高码率', hint: '大会员专享', requiresVip: true },
                  { value: 80, label: '1080P 高清', hint: '登录后可用' },
                  { value: 64, label: '720P' },
                  { value: 32, label: '480P' },
                ] as Array<{ value: BilibiliWatchSettings['targetQuality']; label: string; hint?: string; requiresVip?: boolean }>).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => update({ targetQuality: opt.value })}
                    title={opt.hint}
                    className={`rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors border ${
                      settings.targetQuality === opt.value
                        ? 'text-white border-transparent'
                        : dark
                          ? 'bg-white/[0.06] border-white/10 text-white/60 hover:bg-white/[0.12] hover:text-white/85'
                          : 'bg-black/[0.04] border-black/10 text-black/55 hover:bg-black/[0.08] hover:text-black/80'
                    }`}
                    style={settings.targetQuality === opt.value ? { backgroundColor: BILI_PINK } : undefined}
                  >
                    {opt.label}
                    {opt.requiresVip && <span className="ml-1 text-[9px] text-amber-400">VIP</span>}
                  </button>
                ))}
              </div>
            </section>

            {/* 字幕 */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>字幕（官方字幕即歌词）</h3>
              <Segmented<SubtitlePreference>
                dark={dark}
                value={settings.subtitlePreference}
                onChange={(v) => update({ subtitlePreference: v })}
                options={[
                  { value: 'zh-manual', label: '人工中文', hint: '优先官方人工中文字幕，无则用 AI 字幕' },
                  { value: 'zh-any', label: '中文', hint: '任何中文（含 AI 识别）字幕' },
                  { value: 'any', label: '任意语言' },
                  { value: 'off', label: '关闭' },
                ]}
              />
              <div className="mt-3 flex items-center gap-3">
                <span className={`text-xs flex-shrink-0 ${dark ? 'text-white/45' : 'text-black/45'}`}>字号</span>
                <input
                  type="range"
                  min={14}
                  max={28}
                  step={1}
                  value={settings.subtitleSize}
                  onChange={(e) => update({ subtitleSize: Number(e.target.value) })}
                  className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                  style={{ background: `linear-gradient(to right, ${BILI_PINK} ${((settings.subtitleSize - 14) / 14) * 100}%, rgba(255,255,255,0.2) ${((settings.subtitleSize - 14) / 14) * 100}%)` }}
                />
                <span className={`text-xs w-8 text-right ${dark ? 'text-white/60' : 'text-black/55'}`}>{settings.subtitleSize}px</span>
              </div>
            </section>

            {/* 弹幕（参考 B 站网页版弹幕设置） */}
            <section className="border-t pt-3 space-y-3" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
              <h3 className={`text-xs font-semibold mb-1 ${dark ? 'text-white/55' : 'text-black/50'}`}>弹幕</h3>
              <ToggleRow
                dark={dark}
                label="显示弹幕"
                desc="在 MV 画面上叠加 B 站弹幕"
                checked={danmakuSettings.enabled}
                onChange={(v) => updateDanmaku({ enabled: v })}
              />
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <SliderRow dark={dark} label="不透明度" value={danmakuSettings.opacity} min={0} max={100} step={5} suffix="%" onChange={(v) => updateDanmaku({ opacity: v })} />
                <SliderRow dark={dark} label="字号" value={danmakuSettings.fontSize} min={12} max={30} step={1} suffix="px" onChange={(v) => updateDanmaku({ fontSize: v })} />
                <SliderRow dark={dark} label="显示区域" value={danmakuSettings.displayArea} min={10} max={100} step={5} suffix="%" onChange={(v) => updateDanmaku({ displayArea: v })} />
                <SliderRow dark={dark} label="同屏弹幕数" value={danmakuSettings.maxOnScreen} min={10} max={100} step={5} onChange={(v) => updateDanmaku({ maxOnScreen: v })} />
                <SliderRow dark={dark} label="弹幕速度" value={Math.round(danmakuSettings.speed * 100)} min={50} max={200} step={10} suffix="%" onChange={(v) => updateDanmaku({ speed: v / 100 })} />
              </div>
              <div className="space-y-1">
                <ToggleRow dark={dark} label="滚动弹幕" desc="从右向左滚动" checked={danmakuSettings.showScroll} onChange={(v) => updateDanmaku({ showScroll: v })} />
                <ToggleRow dark={dark} label="顶部弹幕" desc="固定在顶部" checked={danmakuSettings.showTop} onChange={(v) => updateDanmaku({ showTop: v })} />
                <ToggleRow dark={dark} label="底部弹幕" desc="固定在底部" checked={danmakuSettings.showBottom} onChange={(v) => updateDanmaku({ showBottom: v })} />
              </div>
              <div>
                <span className={`text-xs ${dark ? 'text-white/45' : 'text-black/45'}`}>屏蔽关键词（逗号/空格分隔）</span>
                <input
                  value={danmakuSettings.shieldKeywords}
                  onChange={(e) => updateDanmaku({ shieldKeywords: e.target.value })}
                  placeholder="例如：广告, 求关注"
                  className={`mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none border ${
                    dark
                      ? 'bg-white/[0.07] border-white/15 text-white placeholder-white/30 focus:border-white/40'
                      : 'bg-black/[0.04] border-black/10 text-black placeholder-black/25 focus:border-black/30'
                  }`}
                />
              </div>
            </section>

            {/* 关键词模板 */}
            <section>
              <h3 className={`text-xs font-semibold mb-2 ${dark ? 'text-white/55' : 'text-black/50'}`}>搜索关键词模板</h3>
              <Segmented<KeywordTemplate>
                dark={dark}
                value={settings.keywordTemplate}
                onChange={(v) => update({ keywordTemplate: v })}
                options={[
                  { value: 'auto', label: '自动', hint: '按匹配偏好自动组合（歌名+歌手 / 歌名+MV / 偏好词）' },
                  { value: 'title-artist', label: '歌名+歌手', hint: '只搜「歌名 歌手」' },
                  { value: 'title-mv', label: '歌名+MV', hint: '只搜「歌名 MV」' },
                  { value: 'custom', label: '自定义', hint: '使用下方模板，占位符 {title}/{artist}' },
                ]}
              />
              {settings.keywordTemplate === 'custom' && (
                <input
                  value={settings.customKeywordTemplate}
                  onChange={(e) => update({ customKeywordTemplate: e.target.value })}
                  placeholder='例如：{title} {artist} 官方 4K'
                  className={`mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none border ${
                    dark
                      ? 'bg-white/[0.07] border-white/15 text-white placeholder-white/30 focus:border-white/40'
                      : 'bg-black/[0.04] border-black/10 text-black placeholder-black/25 focus:border-black/30'
                  }`}
                />
              )}
            </section>

            {/* 开关 */}
            <section className="space-y-1 border-t pt-3" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
              <ToggleRow
                dark={dark}
                label="记住我的选择"
                desc="手动选过的视频，下次这首直接播你选的"
                checked={settings.useRememberedOverride}
                onChange={(v) => update({ useRememberedOverride: v })}
              />
              <ToggleRow
                dark={dark}
                label="控件自动隐藏"
                desc="播放时顶部/底部控制条自动隐藏"
                checked={settings.autoHideControls}
                onChange={(v) => update({ autoHideControls: v })}
              />
            </section>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

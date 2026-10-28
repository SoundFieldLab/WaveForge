/**
 * 成就系统面板（设置 → 关于 → 成就系统卡片弹窗）。
 * 横版布局：左统计侧栏（总进度 + 分类图例 + 最近解锁）+ 右成就网格。
 * 顶部筛选：全部 / 已解锁 / 未解锁 / 史诗 / 普通；插件板块按「首次打开过插件」显示。
 * 每条成就：图标 + 名称 + 条件 + 解锁时间（2026/01/01 格式）。
 * 打开时自动回检测（retrocheck）：历史操作补发成就（静默入账，不弹 Toast）。
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Trophy, Sparkles, Lock, Check } from 'lucide-react'
import {
  achievementSummary, getAllAchievements, readUnlockedRecords, isPluginOpened,
  type AchievementDef, type AchievementRecord,
} from './core'
import { AchievementIcon } from './icons'
import { runRetrocheck } from './retrocheck'

const SECTION_META: Record<string, { label: string; sub: string }> = {
  app: { label: '全局成就', sub: 'WaveForge 本体里程碑' },
  inparty: { label: 'In Party', sub: '派对玩法成就' },
  resonance: { label: '共振', sub: '一起听成就' },
}

type FilterKey = 'all' | 'unlocked' | 'locked' | 'epic' | 'normal'

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unlocked', label: '已解锁' },
  { key: 'locked', label: '未解锁' },
  { key: 'epic', label: '史诗' },
  { key: 'normal', label: '普通' },
]

function formatDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function AchievementRow({ def, record }: { def: AchievementDef; record?: AchievementRecord }) {
  const unlocked = Boolean(record)
  const isEpic = def.tier === 'epic'
  const hiddenMasked = def.hidden && !unlocked
  return (
    <div
      className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors"
      style={{
        background: unlocked
          ? (isEpic ? 'rgba(160,90,255,0.08)' : 'rgba(255,216,61,0.06)')
          : 'rgba(128,128,128,0.05)',
        border: unlocked
          ? `1px solid ${isEpic ? 'rgba(199,125,255,0.22)' : 'rgba(255,216,61,0.18)'}`
          : '1px solid rgba(128,128,128,0.1)',
        opacity: unlocked ? 1 : 0.62,
      }}
    >
      <AchievementIcon
        icon={hiddenMasked ? 'mystery' : def.icon}
        unlocked={unlocked}
        tier={def.tier}
        size={22}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={`truncate text-[13.5px] font-bold leading-tight ${unlocked ? (isEpic ? 'text-[#d18aff]' : 'text-[#ffd83d]') : 'text-white/55'}`}>
            {hiddenMasked ? '？？？' : def.name}
          </p>
          {isEpic && (
            <span className="shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold tracking-wider"
              style={{ background: 'rgba(199,125,255,0.18)', color: '#d18aff' }}>
              EPIC
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11.5px] leading-tight text-white/45">
          {hiddenMasked ? '继续探索就会发现…' : def.desc}
        </p>
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-white/40">
        {unlocked && record ? (
          <span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-emerald-400" />{formatDate(record.at)}</span>
        ) : (
          <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />未解锁</span>
        )}
      </span>
    </div>
  )
}

export function AchievementsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [records, setRecords] = useState<AchievementRecord[]>([])
  const [filter, setFilter] = useState<FilterKey>('all')

  useEffect(() => {
    if (!open) return
    // 打开即回检测：历史操作补发成就（静默），随后刷新列表
    runRetrocheck()
    const sync = () => setRecords(readUnlockedRecords())
    sync()
    const t = window.setTimeout(sync, 600) // retrocheck 异步部分（桌面歌词 IPC）落地后再刷一次
    window.addEventListener('waveforge:achievement-unlocked', sync)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('waveforge:achievement-unlocked', sync)
    }
  }, [open])

  const defs = useMemo(() => getAllAchievements(), [])
  const recordMap = useMemo(() => new Map(records.map((r) => [r.id, r])), [records])
  const summary = useMemo(() => achievementSummary(), [records]) // eslint-disable-line react-hooks/exhaustive-deps

  // 分节 + 过滤；插件板块只显示"首次打开过"的插件
  const sections = useMemo(() => {
    const groups = new Map<string, AchievementDef[]>()
    for (const def of defs) {
      // 插件可见性：一次都没打开过该插件 → 整组不显示（打开过一次就永久显示）
      if (def.section === 'plugin' && !isPluginOpened('inparty')) continue
      const list = groups.get(def.section) ?? []
      list.push(def)
      groups.set(def.section, list)
    }
    const sortList = (list: AchievementDef[]) => [...list].sort((a, b) => {
      const ra = recordMap.get(a.id)
      const rb = recordMap.get(b.id)
      if (ra && rb) return rb.at - ra.at
      if (ra) return -1
      if (rb) return 1
      if (a.tier !== b.tier) return a.tier === 'epic' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })
    const applyFilter = (list: AchievementDef[]) => list.filter((def) => {
      const unlocked = recordMap.has(def.id)
      if (filter === 'unlocked') return unlocked
      if (filter === 'locked') return !unlocked
      if (filter === 'epic') return def.tier === 'epic'
      if (filter === 'normal') return def.tier === 'normal'
      return true
    })
    const result: Array<{ key: string; defs: AchievementDef[]; total: number }> = []
    for (const key of ['app', ...Array.from(groups.keys()).filter((k) => k !== 'app')]) {
      const list = groups.get(key)
      if (list?.length) {
        const filtered = applyFilter(sortList(list))
        if (filtered.length) result.push({ key, defs: filtered, total: list.length })
      }
    }
    return result
  }, [defs, recordMap, filter])

  const recent = useMemo(() =>
    [...records].sort((a, b) => b.at - a.at).slice(0, 5)
      .map((r) => ({ record: r, def: defs.find((d) => d.id === r.id) }))
      .filter((item) => item.def),
  [records, defs])

  const epicCount = defs.filter((d) => d.tier === 'epic' && recordMap.has(d.id)).length
  const epicTotal = defs.filter((d) => d.tier === 'epic').length

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full overflow-hidden rounded-3xl shadow-2xl relative"
            style={{ maxWidth: 'min(1100px, 94vw)', height: 'min(72vh, 660px)', display: 'flex', flexDirection: 'column' }}
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(30,30,45,0.97) 0%, rgba(20,20,30,0.98) 50%, rgba(12,12,20,0.98) 100%)', backdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
            </div>

            {/* 头部：标题 + 筛选 */}
            <div className="relative z-10 flex items-center justify-between gap-4 border-b px-5 py-3.5" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-center gap-3">
                <Trophy className="h-5 w-5" style={{ color: '#ffd83d' }} />
                <div>
                  <h3 className="text-base font-semibold text-white">成就系统</h3>
                  <p className="text-white/55 text-xs mt-0.5">全局里程碑与插件玩法成就</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-full border border-white/10 bg-white/5 p-0.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFilter(f.key)}
                      className="rounded-full px-3 py-1 text-xs font-medium transition-colors"
                      style={filter === f.key
                        ? { background: 'rgba(255,216,61,0.18)', color: '#ffd83d' }
                        : { color: 'rgba(255,255,255,0.55)' }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>

            {/* 横版主体：左统计侧栏 + 右列表 */}
            <div className="relative z-10 flex min-h-0 flex-1">
              {/* 左侧统计侧栏 */}
              <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r px-5 py-4 md:flex" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                {/* 总进度环 */}
                <div className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="relative h-24 w-24">
                    <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                      <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="9" />
                      <circle
                        cx="50" cy="50" r="42" fill="none"
                        stroke="url(#achGrad)" strokeWidth="9" strokeLinecap="round"
                        strokeDasharray={`${(summary.percent / 100) * 264} 264`}
                        style={{ transition: 'stroke-dasharray 0.6s ease' }}
                      />
                      <defs>
                        <linearGradient id="achGrad" x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor="#ffd83d" />
                          <stop offset="100%" stopColor="#ff9d3d" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-xl font-bold tabular-nums text-white">{summary.percent}%</span>
                      <span className="text-[10px] tabular-nums text-white/45">{summary.unlocked}/{summary.total}</span>
                    </div>
                  </div>
                  <p className="mt-2 text-xs font-medium text-white/70">总完成度</p>
                </div>

                {/* 分类统计 */}
                <div className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-white/60"><span className="h-2 w-2 rounded-full" style={{ background: '#ffd83d' }} />普通成就</span>
                    <span className="tabular-nums text-white/80">{summary.unlocked - epicCount}/{summary.total - epicTotal}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-white/60"><span className="h-2 w-2 rounded-full" style={{ background: '#c77dff' }} />史诗成就</span>
                    <span className="tabular-nums text-white/80">{epicCount}/{epicTotal}</span>
                  </div>
                </div>

                {/* 最近解锁 */}
                {recent.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                    <p className="mb-2 text-xs font-semibold text-white/70">最近解锁</p>
                    <div className="space-y-1.5">
                      {recent.map(({ record, def }) => (
                        <div key={record.id} className="flex items-center gap-2">
                          <AchievementIcon icon={def!.icon} unlocked tier={def!.tier} size={16} />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">{def!.name}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-white/35">{formatDate(record.at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </aside>

              {/* 右侧分节列表 */}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {sections.map(({ key, defs: sectionDefs, total }) => {
                  const meta = SECTION_META[key] ?? { label: key, sub: '' }
                  const unlockedCount = sectionDefs.filter((d) => recordMap.has(d.id)).length
                  const isPlugin = key !== 'app'
                  return (
                    <div key={key} className="mb-5 last:mb-1">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {isPlugin && <Sparkles className="h-3.5 w-3.5 text-white/45" />}
                          <p className="text-[13px] font-bold text-white/85">{meta.label}</p>
                          <p className="text-[11px] text-white/40">{meta.sub}</p>
                        </div>
                        <span className="text-[11px] tabular-nums text-white/40">{unlockedCount}/{total}</span>
                      </div>
                      <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
                        {sectionDefs.map((def) => (
                          <AchievementRow key={def.id} def={def} record={recordMap.get(def.id)} />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

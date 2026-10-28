/**
 * 成就系统面板（设置 → 关于 → 成就系统卡片弹窗）。
 * 长方形弹窗，分两个板块：
 *  - 全局成就（app）：软件本体行为
 *  - 插件成就（plugin）：In Party / 共振等，各自成组
 * 每条成就显示图标 + 名称 + 条件 + 解锁时间（2026/01/01 格式）。
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Trophy, Sparkles } from 'lucide-react'
import {
  achievementSummary, getAllAchievements, readUnlockedRecords,
  type AchievementDef, type AchievementRecord,
} from './core'
import { AchievementIcon } from './icons'

const SECTION_META: Record<string, { label: string; sub: string }> = {
  app: { label: '全局成就', sub: 'WaveForge 本体里程碑' },
  plugin: { label: '插件成就', sub: 'In Party / 共振等玩法成就' },
}

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
        {unlocked && record ? formatDate(record.at) : '未解锁'}
      </span>
    </div>
  )
}

export function AchievementsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [records, setRecords] = useState<AchievementRecord[]>([])

  useEffect(() => {
    if (!open) return
    const sync = () => setRecords(readUnlockedRecords())
    sync()
    window.addEventListener('waveforge:achievement-unlocked', sync)
    return () => window.removeEventListener('waveforge:achievement-unlocked', sync)
  }, [open])

  const defs = useMemo(() => getAllAchievements(), [])
  const recordMap = useMemo(() => new Map(records.map((r) => [r.id, r])), [records])
  const summary = useMemo(() => achievementSummary(), [records]) // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const groups = new Map<string, AchievementDef[]>()
    for (const def of defs) {
      const list = groups.get(def.section) ?? []
      list.push(def)
      groups.set(def.section, list)
    }
    // 每组内：已解锁在前（按解锁时间倒序），未解锁按 tier(epic在前)+名称
    const sortList = (list: AchievementDef[]) => [...list].sort((a, b) => {
      const ra = recordMap.get(a.id)
      const rb = recordMap.get(b.id)
      if (ra && rb) return rb.at - ra.at
      if (ra) return -1
      if (rb) return 1
      if (a.tier !== b.tier) return a.tier === 'epic' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh')
    })
    const result: Array<{ key: string; defs: AchievementDef[] }> = []
    for (const key of ['app', ...Array.from(groups.keys()).filter((k) => k !== 'app')]) {
      const list = groups.get(key)
      if (list?.length) result.push({ key, defs: sortList(list) })
    }
    return result
  }, [defs, recordMap])

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
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl overflow-hidden rounded-3xl shadow-2xl relative"
            style={{ maxHeight: 'min(76vh, 640px)', display: 'flex', flexDirection: 'column' }}
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(30,30,45,0.96) 0%, rgba(20,20,30,0.98) 50%, rgba(12,12,20,0.98) 100%)', backdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
            </div>

            {/* 头部：标题 + 总进度 */}
            <div className="relative z-10 flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-center gap-3">
                <Trophy className="h-5 w-5" style={{ color: '#ffd83d' }} />
                <div>
                  <h3 className="text-base font-semibold text-white">成就系统</h3>
                  <p className="text-white/55 text-xs mt-0.5">全局里程碑与插件玩法成就</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xs font-semibold text-white/80 tabular-nums">{summary.unlocked} / {summary.total}</p>
                  <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${summary.percent}%`, background: 'linear-gradient(90deg, #ffd83d, #ff9d3d)' }}
                    />
                  </div>
                </div>
                <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>

            {/* 板块化列表 */}
            <div className="relative z-10 min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {grouped.map(({ key, defs: sectionDefs }) => {
                const meta = SECTION_META[key] ?? { label: key, sub: '' }
                const unlockedCount = sectionDefs.filter((d) => recordMap.has(d.id)).length
                return (
                  <div key={key} className="mb-5 last:mb-1">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {key === 'plugin' && <Sparkles className="h-3.5 w-3.5 text-white/45" />}
                        <p className="text-[13px] font-bold text-white/85">{meta.label}</p>
                        <p className="text-[11px] text-white/40">{meta.sub}</p>
                      </div>
                      <span className="text-[11px] tabular-nums text-white/40">{unlockedCount}/{sectionDefs.length}</span>
                    </div>
                    <div className="space-y-1.5">
                      {sectionDefs.map((def) => (
                        <AchievementRow key={def.id} def={def} record={recordMap.get(def.id)} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

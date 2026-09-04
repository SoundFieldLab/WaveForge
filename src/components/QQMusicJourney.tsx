import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3,
  BrainCircuit,
  CalendarDays,
  ChevronRight,
  KeyRound,
  ListMusic,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  deleteQQMusicSkillKey,
  fetchQQMusicListeningReport,
  getQQMusicSkillKey,
  openQQMusicSkillKeyPage,
  saveQQMusicSkillKey,
  streamQQMusicInterpretation,
  verifyQQMusicSkillKey,
  type QQMusicReportPeriod,
} from '../services/qqMusicSkills'

interface QQMusicJourneyProps {
  configured: boolean
  cookie: string
  accent: string
  showDescription: boolean
  onConfiguredChange: (configured: boolean) => void
  onOpenPlaylists: () => void
  onOpenCharts: () => void
}

const PERIODS: Array<[QQMusicReportPeriod, string]> = [['d', '今日'], ['w', '本周'], ['m', '本月']]

const formatDuration = (seconds: unknown) => {
  const value = Math.max(0, Number(seconds || 0))
  const hours = Math.floor(value / 3600)
  const minutes = Math.max(1, Math.round((value % 3600) / 60))
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

const validEntries = (value: unknown) => Array.isArray(value)
  ? value.filter(item => item && (item.songName || item.singerName || item.name))
  : []

function ReportView({ report, period }: { report: any; period: QQMusicReportPeriod }) {
  const data = report?.[period === 'd' ? 'dayData' : period === 'w' ? 'weekData' : 'monthData'] || {}
  const topSingers = validEntries(data.singerListen || data.topSinger)
  const topSongs = validEntries(data.songListen || data.topSong)
  const genres = validEntries(data.topGenre?.genre2Count)
  const cities = Array.isArray(data.listenCityInfo) ? data.listenCityInfo.filter((item: any) => item?.cityName) : []
  const monthlyTop = Array.isArray(data.topDataList) ? data.topDataList[0] || {} : {}
  const hasContent = Object.keys(data).length > 0

  if (!hasContent) {
    return <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-8 text-center text-sm text-white/42">这个时间段暂时还没有可展示的听歌记录。</div>
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.listenTime != null && <Metric label={period === 'w' ? '日均听歌' : '听歌时长'} value={formatDuration(data.listenTime)} />}
        {data.activeHour != null && <Metric label="活跃时段" value={`${data.activeHour}:00`} />}
        {period === 'w' && data.floatNumber != null && <Metric label="较上周" value={`${Number(data.floatNumber) >= 0 ? '+' : ''}${Math.round(Number(data.floatNumber) * 100)}%`} />}
        {data.preferHour?.preferHour != null && <Metric label="最爱时段" value={`${data.preferHour.preferHour}:00`} />}
        {data.consDays?.conDays != null && <Metric label="连续听歌" value={`${data.consDays.conDays} 天`} />}
        {data.consDays?.topListen != null && <Metric label="单日最多" value={`${data.consDays.topListen} 首`} />}
        {data.nicheSongs?.nichePercent != null && <Metric label="小众音乐" value={`${data.nicheSongs.nichePercent}%`} />}
        {data.newSongs?.newSongCount != null && <Metric label="本月尝鲜" value={`${data.newSongs.newSongCount} 首`} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ReportList title="常听歌手" entries={topSingers} render={(item: any) => item.singerName} suffix={(item: any) => item.sum ? formatDuration(item.sum) : ''} />
        <ReportList title="循环歌曲" entries={topSongs} render={(item: any) => item.songName} suffix={(item: any) => item.singerName || (item.sum ? `${item.sum} 次` : '')} />
      </div>

      {(genres.length > 0 || cities.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ReportList title="偏爱流派" entries={genres} render={(item: any) => item.name} suffix={(item: any) => item.sum ? `${item.sum} 次` : ''} />
          <ReportList title="听歌足迹" entries={cities} render={(item: any) => item.cityName} suffix={(item: any) => item.provinceName || item.countryName || ''} />
        </div>
      )}

      {(monthlyTop.repeatSong?.songName || monthlyTop.midnightSong?.songName || monthlyTop.favSongName) && (
        <div className="grid gap-3 sm:grid-cols-3">
          {monthlyTop.favSongName && <Metric label="本月最爱" value={monthlyTop.favSongName} />}
          {monthlyTop.repeatSong?.songName && <Metric label="循环之最" value={`${monthlyTop.repeatSong.songName} · ${monthlyTop.repeatSong.count || 0} 次`} />}
          {monthlyTop.midnightSong?.songName && <Metric label="深夜单曲" value={`${monthlyTop.midnightSong.songName} · ${monthlyTop.midnightSong.hour || 0} 点`} />}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.045] p-4">
      <span className="block text-xs text-white/38">{label}</span>
      <strong className="mt-2 block truncate text-lg font-semibold text-white/88">{value}</strong>
    </div>
  )
}

function ReportList({ title, entries, render, suffix }: { title: string; entries: any[]; render: (entry: any) => string; suffix: (entry: any) => string }) {
  if (entries.length === 0) return null
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
      <h4 className="mb-3 text-sm font-semibold">{title}</h4>
      <div className="space-y-2.5">
        {entries.slice(0, 5).map((entry, index) => (
          <div key={`${render(entry)}-${index}`} className="flex min-w-0 items-center gap-3 text-sm">
            <span className="w-5 shrink-0 text-center text-xs text-white/28">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-white/76">{render(entry)}</span>
            <span className="max-w-36 truncate text-xs text-white/34">{suffix(entry)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function QQMusicJourney({
  configured,
  cookie,
  accent,
  showDescription,
  onConfiguredChange,
  onOpenPlaylists,
  onOpenCharts,
}: QQMusicJourneyProps) {
  const [hasLocalKey, setHasLocalKey] = useState(configured)
  const [setupOpen, setSetupOpen] = useState(false)
  const [journeyOpen, setJourneyOpen] = useState(false)
  const [tab, setTab] = useState<'report' | 'ai'>('report')
  const [keyInput, setKeyInput] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [period, setPeriod] = useState<QQMusicReportPeriod>('m')
  const [report, setReport] = useState<any>(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [reportError, setReportError] = useState('')
  const [question, setQuestion] = useState('分析我的听歌风格和最近的口味变化')
  const [interpretation, setInterpretation] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    if (configured) {
      setHasLocalKey(true)
      return
    }
    let cancelled = false
    void getQQMusicSkillKey().then(async key => {
      if (cancelled) return
      if (!key) return setHasLocalKey(false)
      try {
        const status = await verifyQQMusicSkillKey(cookie)
        if (!cancelled) setHasLocalKey(Boolean(status.valid))
      } catch {
        if (!cancelled) setHasLocalKey(false)
      }
    })
    return () => { cancelled = true }
  }, [configured, cookie])

  const active = configured || hasLocalKey

  const loadReport = async (nextPeriod = period) => {
    setReportBusy(true)
    setReportError('')
    try {
      const result = await fetchQQMusicListeningReport(nextPeriod, cookie)
      setReport(result.report || {})
    } catch (error) {
      setReportError(error instanceof Error ? error.message : '听歌报告加载失败')
    } finally {
      setReportBusy(false)
    }
  }

  const openJourney = (nextTab: 'report' | 'ai') => {
    setTab(nextTab)
    setJourneyOpen(true)
    if (nextTab === 'report' && !report) void loadReport()
  }

  const handleSave = async (overrideKey?: string) => {
    const nextKey = (overrideKey ?? keyInput).trim()
    if (!nextKey) return
    setSetupBusy(true)
    setSetupError('')
    try {
      await saveQQMusicSkillKey(nextKey)
      const status = await verifyQQMusicSkillKey(cookie)
      if (!status.valid) throw new Error('API Key 未通过官方接口验证')
      setHasLocalKey(true)
      setKeyInput('')
      setSetupOpen(false)
      onConfiguredChange(true)
    } catch (error) {
      await deleteQQMusicSkillKey().catch(() => undefined)
      setHasLocalKey(false)
      setSetupError(error instanceof Error ? error.message : 'API Key 验证失败')
    } finally {
      setSetupBusy(false)
    }
  }

  const handleOpenKeyPage = async () => {
    setSetupError('')
    try {
      const result = await openQQMusicSkillKeyPage()
      if (result?.success && result.apiKey) {
        setKeyInput(result.apiKey)
        await handleSave(result.apiKey)
      } else if (result?.error) {
        setSetupError(result.error)
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : '打开领取页面失败')
    }
  }

  const handleDelete = async () => {
    setSetupBusy(true)
    setSetupError('')
    try {
      await deleteQQMusicSkillKey()
      setHasLocalKey(false)
      setSetupOpen(false)
      setJourneyOpen(false)
      setReport(null)
      setInterpretation('')
      onConfiguredChange(false)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : '删除 API Key 失败')
    } finally {
      setSetupBusy(false)
    }
  }

  const handleInterpret = async () => {
    if (!question.trim()) return
    setAiBusy(true)
    setAiError('')
    setInterpretation('')
    try {
      await streamQQMusicInterpretation(question.trim(), cookie, setInterpretation)
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI 解读失败')
    } finally {
      setAiBusy(false)
    }
  }

  const cards = useMemo(() => [
    { title: 'AI 推荐歌单', copy: '由 QQ 音乐结合你的口味生成', icon: Sparkles, action: onOpenPlaylists },
    { title: '完整排行榜', copy: '官方分组与全部榜单歌曲', icon: BarChart3, action: onOpenCharts },
    { title: '听歌报告', copy: '今日、本周与本月的真实统计', icon: CalendarDays, action: () => openJourney('report') },
    { title: 'AI 音乐解读', copy: '基于收藏与听歌记录分析你的旅程', icon: BrainCircuit, action: () => openJourney('ai') },
  ], [onOpenCharts, onOpenPlaylists, report])

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5" style={{ color: accent }} />
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">QQ 音乐旅程</h2>
          </div>
          {showDescription && <p className="mt-1.5 text-sm text-white/45">官方个性化歌单、排行榜、听歌报告与 AI 解读</p>}
        </div>
        {active && (
          <button type="button" onClick={() => setSetupOpen(true)} className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/45 transition hover:bg-white/[0.09] hover:text-white">管理密钥</button>
        )}
      </div>

      {!active ? (
        <div className="flex flex-col gap-5 rounded-[26px] border border-emerald-300/15 bg-[linear-gradient(135deg,rgba(49,230,139,0.1),rgba(255,255,255,0.025))] p-6 md:flex-row md:items-center">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-300/10 text-emerald-200"><KeyRound className="h-6 w-6" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">启用 QQ 音乐官方个性化增强</h3>
            <p className="mt-1 text-sm leading-relaxed text-white/42">密钥需在 QQ 音乐官方页面领取，保存时由系统加密；不会写入项目、日志或 Git。</p>
          </div>
          <button type="button" onClick={() => setSetupOpen(true)} className="flex shrink-0 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#071018]" style={{ background: accent }}>
            立即启用 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(({ title, copy, icon: Icon, action }) => (
            <motion.button key={title} type="button" whileHover={{ y: -3 }} onClick={action} className="group flex min-h-32 flex-col rounded-[22px] border border-white/[0.08] bg-white/[0.04] p-5 text-left transition hover:bg-white/[0.07]">
              <div className="flex items-center justify-between"><Icon className="h-5 w-5" style={{ color: accent }} /><ChevronRight className="h-4 w-4 text-white/24 transition group-hover:translate-x-0.5 group-hover:text-white/65" /></div>
              <strong className="mt-auto text-sm font-semibold">{title}</strong>
              <span className="mt-1 text-xs text-white/38">{copy}</span>
            </motion.button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {setupOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[210] flex items-center justify-center bg-black/72 p-5 backdrop-blur-xl">
            <motion.div initial={{ scale: 0.96, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 12 }} className="w-full max-w-lg rounded-[28px] border border-white/[0.1] bg-[#0d1219] p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div><h3 className="text-xl font-semibold">QQ 音乐官方增强</h3><p className="mt-1 text-sm text-white/42">API Key 与你的 QQ 音乐账号绑定。</p></div>
                <button type="button" onClick={() => setSetupOpen(false)} className="rounded-xl bg-white/[0.06] p-2 text-white/50 hover:text-white"><X className="h-5 w-5" /></button>
              </div>
              <ol className="mt-5 space-y-2 text-sm leading-relaxed text-white/58">
                <li>1. 打开 QQ 音乐官方页面并登录当前账号。</li>
                <li>2. 领取以 <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-emerald-200">qmk-</code> 开头的 API Key。</li>
                <li>3. 粘贴到下方，WaveForge 会先验证再启用。</li>
              </ol>
              <button type="button" onClick={() => void handleOpenKeyPage()} className="mt-4 flex items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.045] px-4 py-2.5 text-sm text-white/72 hover:bg-white/[0.08]"><KeyRound className="h-4 w-4" />前往官方页面领取</button>
              {!active && <input type="password" autoComplete="off" value={keyInput} onChange={event => setKeyInput(event.target.value)} placeholder="qmk-…" className="mt-4 w-full rounded-2xl border border-white/[0.1] bg-black/25 px-4 py-3 text-sm outline-none transition focus:border-emerald-300/40" />}
              {setupError && <p className="mt-3 text-sm text-rose-300/85">{setupError}</p>}
              <div className="mt-5 flex items-center justify-end gap-2">
                {active && <button type="button" disabled={setupBusy} onClick={() => void handleDelete()} className="mr-auto flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-rose-300/65 hover:bg-rose-300/[0.08]"><Trash2 className="h-4 w-4" />移除密钥</button>}
                <button type="button" onClick={() => setSetupOpen(false)} className="rounded-xl px-4 py-2 text-sm text-white/48 hover:bg-white/[0.06]">取消</button>
                {!active && <button type="button" disabled={setupBusy || !keyInput.trim()} onClick={() => void handleSave()} className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-[#071018] disabled:opacity-40" style={{ background: accent }}>{setupBusy && <Loader2 className="h-4 w-4 animate-spin" />}验证并启用</button>}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {journeyOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[205] bg-[#080b11]/98 text-white backdrop-blur-2xl">
            <div className="flex h-full flex-col pt-8">
              <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4 md:px-8">
                <ShieldCheck className="h-5 w-5" style={{ color: accent }} /><h2 className="text-xl font-semibold">QQ 音乐旅程</h2>
                <div className="ml-4 flex rounded-xl bg-white/[0.045] p-1">
                  {([['report', '听歌报告'], ['ai', 'AI 解读']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => { setTab(value); if (value === 'report' && !report) void loadReport() }} className={`rounded-lg px-3 py-1.5 text-xs ${tab === value ? 'bg-white/[0.12] text-white' : 'text-white/42'}`}>{label}</button>)}
                </div>
                <button type="button" onClick={() => setJourneyOpen(false)} className="ml-auto rounded-xl bg-white/[0.05] p-2 text-white/50 hover:text-white"><X className="h-5 w-5" /></button>
              </div>
              <div className="explore-scrollbar flex-1 overflow-y-auto px-5 py-6 md:px-8">
                <div className="mx-auto max-w-5xl">
                  {tab === 'report' ? (
                    <>
                      <div className="mb-5 flex flex-wrap items-center gap-2">{PERIODS.map(([value, label]) => <button key={value} type="button" onClick={() => { setPeriod(value); void loadReport(value) }} className={`rounded-full px-4 py-2 text-sm transition ${period === value ? 'text-[#071018]' : 'border border-white/[0.08] bg-white/[0.04] text-white/48'}`} style={period === value ? { background: accent } : undefined}>{label}</button>)}</div>
                      {reportBusy ? <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-white/42"><Loader2 className="h-4 w-4 animate-spin" />正在读取你的真实听歌记录…</div> : reportError ? <p className="rounded-2xl bg-rose-300/[0.08] p-4 text-sm text-rose-200/80">{reportError}</p> : <ReportView report={report} period={period} />}
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <label className="text-sm font-semibold">想从哪个角度解读你的音乐旅程？</label>
                        <textarea value={question} onChange={event => setQuestion(event.target.value)} rows={3} className="mt-3 w-full resize-none rounded-2xl border border-white/[0.09] bg-black/20 px-4 py-3 text-sm leading-relaxed outline-none focus:border-emerald-300/35" />
                        <button type="button" disabled={aiBusy || !question.trim()} onClick={() => void handleInterpret()} className="mt-3 flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#071018] disabled:opacity-45" style={{ background: accent }}>{aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BrainCircuit className="h-4 w-4" />}{aiBusy ? '正在解读…' : '开始解读'}</button>
                      </div>
                      {aiError && <p className="rounded-2xl bg-rose-300/[0.08] p-4 text-sm text-rose-200/80">{aiError}</p>}
                      {(interpretation || aiBusy) && <div className="min-h-44 whitespace-pre-wrap rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5 text-sm leading-7 text-white/72">{interpretation || '正在连接 QQ 音乐 AI…'}</div>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

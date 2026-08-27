/**
 * DG-LAB 使用说明弹窗（顶栏按钮打开）：连接步骤、体感风格、安全须知、FAQ。
 * 插件中心只讲「能干嘛」，操作细节都在这里。
 */
import { motion, AnimatePresence } from 'framer-motion'
import { X, BookOpen } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface DGLabGuideModalProps {
  open: boolean
  onClose: () => void
}

const STYLES_GUIDE: { name: string; desc: string }[] = [
  { name: '立体声', desc: 'A=左声道、B=右声道，跟随歌曲真实左右声像（贴大腿左右区分最明显）' },
  { name: '心跳', desc: '每一拍一次「咚-哒」双脉冲，从 A 侧扫到 B 侧' },
  { name: '呼吸', desc: '6-10 秒缓慢起伏，两通道交替扩张收缩，轻柔绵长' },
  { name: '潮汐', desc: '波浪从一侧缓缓滚到另一侧' },
  { name: '敲击', desc: '鼓点与瞬态变成短促点击，左右交替，节奏最清晰' },
  { name: '流动', desc: '连绵平缓的基底，随歌声轻柔起伏，最温和' },
  { name: '重拳', desc: '低音重击 + 持续低音基底，最有力，建议小强度起步' },
]

export default function DGLabGuideModal({ open, onClose }: DGLabGuideModalProps) {
  useTvBack(() => {
    if (open) {
      onClose()
      return true
    }
    return false
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[97] flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(2,2,4,0.82)', backdropFilter: 'blur(10px)' }}
          data-tv-scope
          onClick={(e) => { e.stopPropagation(); onClose() }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 14, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 14, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl h-[min(82vh,600px)] rounded-3xl border flex flex-col overflow-hidden shadow-2xl"
            style={{ background: 'linear-gradient(160deg, #0d0d10 0%, #14110a 100%)', borderColor: 'rgba(255,232,156,0.25)' }}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'rgba(255,232,156,0.14)' }}>
              <div className="flex items-center gap-2.5">
                <BookOpen className="w-4 h-4" style={{ color: '#FFE89C' }} />
                <h3 className="text-sm font-bold text-white">DG-LAB 使用说明</h3>
              </div>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 transition-colors" aria-label="关闭使用说明">
                <X className="w-4 h-4 text-white/60" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 plugin-center-scroll">
              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">① 连接</h4>
                <ol className="text-xs leading-relaxed text-white/60 space-y-1.5 list-decimal pl-4">
                  <li>手机 DG-Lab App 先通过蓝牙连接郊狼设备，并让手机与电脑连到同一个 WiFi；</li>
                  <li>打开电脑端控制台，手机在 App「Socket 控制 / 扫码连接」入口扫描白色二维码；</li>
                  <li>扫码后后端应显示「已配对 / bind 200」，控制台状态变绿「已连接」；</li>
                  <li>多网卡环境可在「连接设置」里手动选择手机能连到的网段 IP（复制按钮可拿地址手动输入）。</li>
                </ol>
              </section>

              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">② 体感风格</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {STYLES_GUIDE.map(s => (
                    <div key={s.name} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                      <div className="text-xs font-semibold text-amber-100">{s.name}</div>
                      <div className="text-[11px] text-white/55 mt-0.5 leading-relaxed">{s.desc}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">③ 整机监听</h4>
                <p className="text-[11px] leading-relaxed text-white/55">
                  <b className="text-amber-100">整机监听</b>开启后直接监听系统扬声器：电脑里任何声音（其他播放器、视频、游戏等，不限本软件）都会映射成波形。桌面版自动捕获系统音频（无需额外操作）；浏览器需在弹出的共享框选「整个屏幕」并勾选「共享系统音频」。开启后右下角出现金色脉搏徽标即表示监听生效；安全机制不变（上限/强度差/恢复档仍生效）。
                </p>
              </section>

              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">④ 强度差与恢复</h4>
                <p className="text-[11px] leading-relaxed text-white/55">
                  <b className="text-amber-100">强度差（体质档）</b>控制单次强度变化幅度：强=耐电跟手(30)，中=平衡(12)，弱=新手最柔(5，默认)，也可自定义。「恢复适应时间」控制暂停后续播/重新启用输出时的从 0 缓升时长（快/中/慢，默认慢最温和）。
                </p>
              </section>

              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">⑤ 安全须知（务必阅读）</h4>
                <ul className="text-[11px] text-amber-100/80 space-y-1.5 leading-relaxed list-disc pl-4">
                  <li>未满 18 周岁禁止使用；请确认您有自主行为能力，使用后果自负；</li>
                  <li><b className="text-amber-200">严禁</b>将贴片或其他配件用于上半身任何地方（耻骨区之上）；</li>
                  <li>初次使用请从「弱」体质档 + 低上限起步，循序渐进；如有不适立即停止（暂停或右上角关闭波形输出）；</li>
                  <li>长时高强度会疲劳，建议间歇使用；本插件仅供娱乐。</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-bold text-amber-100/90 mb-2">⑥ 常见问题</h4>
                <div className="text-[11px] text-white/55 space-y-1.5">
                  <p><b className="text-white/80">Q：扫码后一直连不上？</b> 检查手机与电脑同一 WiFi、中继已启动（控制台金色按钮）、换网卡试试；后端日志可看原因。</p>
                  <p><b className="text-white/80">Q：暂停了还有感觉？</b> 播放页右下「波形输出」按钮可一键停；暂停本身会立即归零。</p>
                  <p><b className="text-white/80">Q：左右感觉一样？</b> 同一首歌左右声道接近时属正常，可换「潮汐/心跳/敲击」等风格，或找左右区分明显的歌。</p>
                </div>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
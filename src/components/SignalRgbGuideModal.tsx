import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  BookOpen,
  CheckCircle2,
  Crown,
  LayoutGrid,
  MonitorOff,
  RefreshCw,
  X,
} from "lucide-react";
import { useTvBack } from "../tv/tvCore";

export interface SignalRgbGuideModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    icon: AppWindow,
    title: "安装并启动 SignalRGB",
    detail: "从 SignalRGB 官方渠道安装 Windows 桌面应用，完成首次启动，并确认设备已经出现在 SignalRGB 布局中。",
  },
  {
    icon: RefreshCw,
    title: "安装 WaveForge Effect 后重启",
    detail: "在控制台点击安装 Effect。文件会写入 SignalRGB 的 Dynamic Effects 目录；完成后需要彻底退出并重新启动 SignalRGB。",
  },
  {
    icon: LayoutGrid,
    title: "手动选择 WaveForge",
    detail: "没有 SignalRGB Pro 时，在 SignalRGB 的效果页面手动选择 WaveForge。效果会使用 SignalRGB 原生 engine.audio 驱动当前完整布局。",
  },
  {
    icon: Crown,
    title: "可选的 Pro 自动化",
    detail: "SignalRGB Pro Local API 可让 WaveForge 自动应用及恢复效果。Pro 只影响自动切换，不是运行 WaveForge Effect 的必要条件。",
  },
];

export default function SignalRgbGuideModal({
  open,
  onClose,
}: SignalRgbGuideModalProps) {
  useTvBack(() => {
    if (!open) return false;
    onClose();
    return true;
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[98] flex items-center justify-center p-3 sm:p-6"
          style={{ background: "rgba(0,0,0,.88)", backdropFilter: "blur(10px)" }}
          data-tv-scope
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.96, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 12, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className="flex h-[min(86vh,680px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-cyan-300/25 bg-[#090d10] shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="signalrgb-guide-title"
          >
            <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <BookOpen className="h-5 w-5 shrink-0 text-cyan-300" />
                <h3 id="signalrgb-guide-title" className="truncate text-sm font-bold text-white">
                  SignalRGB 连接指南
                </h3>
              </div>
              <button type="button" onClick={onClose} className="rounded-md p-2 text-white/55 hover:bg-white/10 hover:text-white" title="关闭指南" aria-label="关闭指南">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="plugin-center-scroll flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <ol>
                {STEPS.map((step, index) => {
                  const Icon = step.icon;
                  return (
                    <li key={step.title} className="grid grid-cols-[34px_minmax(0,1fr)] gap-3 pb-5 last:pb-1">
                      <div className="relative flex h-8 w-8 items-center justify-center rounded-md border border-cyan-300/30 bg-cyan-300/10 text-cyan-300">
                        <Icon className="h-4 w-4" />
                        {index < STEPS.length - 1 && <span className="absolute left-1/2 top-8 h-5 w-px -translate-x-1/2 bg-cyan-300/20" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white/90">{index + 1}. {step.title}</p>
                        <p className="mt-1 text-xs leading-relaxed text-white/50">{step.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <section className="mt-6 border-t border-white/10 pt-5">
                <h4 className="flex items-center gap-2 text-xs font-bold text-cyan-200">
                  <MonitorOff className="h-4 w-4" />
                  关于设备列表
                </h4>
                <p className="mt-2 text-xs leading-relaxed text-white/50">
                  当前 SignalRGB Local API 不提供 WaveForge 可依赖的物理设备枚举接口，因此控制台只显示当前布局和效果信息，不伪造设备清单。实际品牌、型号、位置和分组请在 SignalRGB 的布局页面查看与管理。
                </p>
              </section>
              <section className="mt-4 rounded-md border border-emerald-300/20 bg-emerald-300/[0.06] p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  音频路径
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                  WaveForge 不向 SignalRGB 连续发送频谱。安装的 Effect 在 SignalRGB 内直接读取 engine.audio；WaveForge 只补充播放、节拍、重音、风格和主题事件。
                </p>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

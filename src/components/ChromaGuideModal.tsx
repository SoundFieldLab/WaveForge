import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  ShieldCheck,
  X,
} from "lucide-react";
import { useTvBack } from "../tv/tvCore";

interface ChromaGuideModalProps {
  open: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    icon: Download,
    title: "安装 Razer Synapse 3 或 4",
    detail:
      "安装与你的设备兼容的雷云版本，完成登录并确认设备能在雷云中正常显示。",
  },
  {
    icon: ExternalLink,
    title: "安装 Chroma Connect",
    detail: "在雷云「模块」中安装 Chroma Connect。安装后如有提示，请重启雷云。",
  },
  {
    icon: ShieldCheck,
    title: "允许应用控制",
    detail:
      "打开 Chroma Studio / Connect，允许第三方应用控制灯光，并避免把 WaveForge 加入阻止列表。",
  },
  {
    icon: CheckCircle2,
    title: "返回控制台刷新",
    detail:
      "保持雷云在后台运行，回到 Razer Chroma 控制台，点击「重新连接」后再刷新设备。",
  },
];

export default function ChromaGuideModal({
  open,
  onClose,
}: ChromaGuideModalProps) {
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
          className="fixed inset-0 z-[97] flex items-center justify-center p-3 sm:p-6"
          style={{
            backgroundColor: "rgba(0,0,0,0.86)",
            backdropFilter: "blur(10px)",
          }}
          data-tv-scope
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 14, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 14, opacity: 0 }}
            transition={{ type: "spring", damping: 26, stiffness: 320 }}
            onClick={(event) => event.stopPropagation()}
            className="flex h-[min(84vh,650px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border shadow-2xl"
            style={{
              background: "#0b0d0b",
              borderColor: "rgba(68,214,44,0.3)",
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="chroma-guide-title"
          >
            <header
              className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 sm:px-6"
              style={{ borderColor: "rgba(68,214,44,0.16)" }}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <BookOpen className="h-5 w-5 shrink-0 text-[#44d62c]" />
                <h3
                  id="chroma-guide-title"
                  className="truncate text-sm font-bold text-white"
                >
                  Razer Chroma 连接指南
                </h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-md p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                title="关闭指南"
                aria-label="关闭指南"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="plugin-center-scroll flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <section aria-labelledby="chroma-setup-title">
                <h4
                  id="chroma-setup-title"
                  className="mb-3 text-xs font-bold uppercase text-[#8af178]"
                >
                  首次连接
                </h4>
                <ol className="space-y-0">
                  {STEPS.map((step, index) => {
                    const Icon = step.icon;
                    return (
                      <li
                        key={step.title}
                        className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-5 last:pb-1"
                      >
                        <div className="relative flex h-8 w-8 items-center justify-center rounded-md border border-[#44d62c]/35 bg-[#44d62c]/10 text-[#44d62c]">
                          <Icon className="h-4 w-4" />
                          {index < STEPS.length - 1 && (
                            <span className="absolute left-1/2 top-8 h-5 w-px -translate-x-1/2 bg-[#44d62c]/25" />
                          )}
                        </div>
                        <div className="min-w-0 pt-0.5">
                          <p className="text-sm font-semibold text-white/90">
                            {index + 1}. {step.title}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-white/50">
                            {step.detail}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>

              <section
                className="mt-6 border-t pt-5"
                style={{ borderColor: "rgba(255,255,255,0.08)" }}
                aria-labelledby="chroma-faq-title"
              >
                <h4
                  id="chroma-faq-title"
                  className="mb-3 flex items-center gap-2 text-xs font-bold uppercase text-[#8af178]"
                >
                  <CircleHelp className="h-4 w-4" />
                  常见问题
                </h4>
                <div className="space-y-4 text-xs leading-relaxed text-white/55">
                  <div>
                    <p className="font-semibold text-white/85">
                      为什么型号和 SDK 通道状态不一致？
                    </p>
                    <p className="mt-1">
                      设备页通过 Windows PnP 展示真实型号；下方 SDK
                      输出通道是键盘、鼠标等六类逻辑端点。同类型的多个设备会共享一个类别输出。
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-white/85">
                      设备存在，但灯光没有变化？
                    </p>
                    <p className="mt-1">
                      退出或暂停其他可能独占灯光控制的 RGB 应用，再在雷云中确认
                      Chroma Connect 已允许 WaveForge 控制。
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-white/85">
                      关闭插件后灯光会怎样？
                    </p>
                    <p className="mt-1">
                      WaveForge 退出 Chroma
                      会话并释放灯效，控制权会交还雷云或其他 RGB 应用。
                    </p>
                  </div>
                  <div>
                    <p className="font-semibold text-white/85">
                      macOS 或 Linux 可以使用吗？
                    </p>
                    <p className="mt-1">
                      不可以。Razer Chroma 集成仅支持 WaveForge Windows 桌面版。
                    </p>
                  </div>
                </div>
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

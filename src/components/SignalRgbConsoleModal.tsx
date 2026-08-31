import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Crown,
  ExternalLink,
  FileCode2,
  Palette,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useTvBack } from "../tv/tvCore";
import {
  getSignalRgbClient,
  useSignalRgbClient,
  type SignalRgbSettings,
} from "../plugins/clients/SignalRgbClient";
import {
  SIGNALRGB_STYLES,
  SIGNALRGB_STYLE_LABELS,
} from "../plugins/clients/signalrgb/signalRgbTypes";
import SignalRgbGuideModal from "./SignalRgbGuideModal";

export interface SignalRgbConsoleModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "effect" | "signalrgb" | "advanced";
const PANEL: CSSProperties = {
  background: "rgba(255,255,255,.035)",
  borderColor: "rgba(255,255,255,.09)",
};
const TABS: Array<{ value: Tab; label: string; icon: ComponentType<{ className?: string }> }> = [
  { value: "effect", label: "效果", icon: Activity },
  { value: "signalrgb", label: "SignalRGB", icon: FileCode2 },
  { value: "advanced", label: "高级", icon: Settings2 },
];

function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-cyan-300" : "bg-white/15"}`}>
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

function ToggleRow({ label, detail, checked, onChange, disabled = false }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-xs font-medium text-white/85">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-white/40">{detail}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

function Badge({ label, state }: { label: string; state: "ok" | "warn" | "off" }) {
  const color = state === "ok" ? "#6ee7b7" : state === "warn" ? "#fcd34d" : "#94a3b8";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px]" style={{ color, borderColor: `${color}45`, background: `${color}10` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function JsonValue({ value }: { value: unknown }) {
  let text = "无";
  if (value !== null && value !== undefined) {
    try {
      text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md border border-white/[0.07] bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-white/55">{text}</pre>;
}

function SemanticPreview({ settings, active }: { settings: SignalRgbSettings; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const client = getSignalRgbClient();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let animation = 0;
    const draw = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      context.fillStyle = "#05080b";
      context.fillRect(0, 0, w, h);
      const audio = client.getAudioSnapshot();
      const bins = audio?.spectrum;
      const count = 24;
      for (let index = 0; index < count; index += 1) {
        const fallback = 0.18 + (Math.sin(frame * 0.035 + index * 0.48) + 1) * 0.09;
        const energy = active ? Math.max(0.025, bins?.[index] ?? fallback) : 0.035;
        const barWidth = w / count;
        const barHeight = energy * h * 0.78;
        const gradient = context.createLinearGradient(0, h - barHeight, 0, h);
        gradient.addColorStop(0, settings.themeColors[index % 2]);
        gradient.addColorStop(1, settings.themeColors[2]);
        context.globalAlpha = 0.35 + energy * 0.65;
        context.fillStyle = gradient;
        context.fillRect(index * barWidth + 1, h - barHeight, Math.max(1, barWidth - 2), barHeight);
      }
      context.globalAlpha = 1;
      context.strokeStyle = `${settings.themeColors[0]}aa`;
      context.lineWidth = 2;
      context.beginPath();
      for (let x = 0; x <= w; x += 5) {
        const y = h * 0.38 + Math.sin(x * 0.04 + frame * 0.045) * (8 + (audio?.overall ?? 0.25) * 22);
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      frame += 1;
      animation = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animation);
  }, [active, client, settings.style, settings.themeColors]);
  return <canvas ref={canvasRef} className="block aspect-[16/7] w-full rounded-md border border-white/10 bg-black" aria-label="WaveForge 音频语义预览" />;
}

export default function SignalRgbConsoleModal({ open, onClose }: SignalRgbConsoleModalProps) {
  const { active, busy, settings, status, clientError } = useSignalRgbClient();
  const client = getSignalRgbClient();
  const [tab, setTab] = useState<Tab>("effect");
  const [guideOpen, setGuideOpen] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  useTvBack(() => {
    if (guideOpen) {
      setGuideOpen(false);
      return true;
    }
    if (open) {
      onClose();
      return true;
    }
    return false;
  }, [guideOpen, onClose, open]);
  if (!open) return null;

  const update = (patch: Partial<SignalRgbSettings>) => client.updateSettings(patch);
  const effectActionLabel = status.effectInstalled ? "更新 Effect" : "安装 Effect";
  const proState = status.proAvailable === true ? "ok" : status.proAvailable === false ? "warn" : "off";

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[96] flex items-center justify-center p-2 sm:p-4" style={{ background: "rgba(0,0,0,.86)", backdropFilter: "blur(14px)" }} data-tv-scope onClick={onClose}>
        <motion.div initial={{ scale: 0.97, y: 10, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.97, y: 10, opacity: 0 }} onClick={(event) => event.stopPropagation()} className="flex h-[min(96vh,880px)] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-cyan-300/25 bg-[#080d11] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="signalrgb-console-title">
          <header className="shrink-0 border-b border-white/10">
            <div className="flex min-h-16 items-center justify-between gap-3 px-3 py-2 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative h-10 w-10 shrink-0 rounded-full border-[6px] border-cyan-300 shadow-[inset_-4px_0_0_#ff4f79,0_0_18px_rgba(103,232,249,.25)]" />
                <div className="min-w-0">
                  <h2 id="signalrgb-console-title" className="truncate text-base font-bold text-white sm:text-lg">SignalRGB</h2>
                  <p className="truncate text-[10px] text-cyan-200/50">WAVEFORGE EFFECT CONSOLE</p>
                </div>
                <Badge label={status.running ? "SignalRGB 运行中" : active ? "等待 SignalRGB" : "插件未运行"} state={status.running ? "ok" : active ? "warn" : "off"} />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => setGuideOpen(true)} className="rounded-md p-2 text-white/55 hover:bg-white/10 hover:text-white" title="打开连接指南" aria-label="打开连接指南"><BookOpen className="h-4 w-4" /></button>
                <button type="button" onClick={onClose} className="rounded-md p-2 text-white/55 hover:bg-white/10 hover:text-white" title="关闭控制台" aria-label="关闭控制台"><X className="h-5 w-5" /></button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] bg-black/20 px-3 py-2 sm:px-5">
              <Badge label={status.effectInstalled ? `Effect ${status.effectVersion || "已安装"}` : "Effect 未安装"} state={status.effectInstalled ? "ok" : "warn"} />
              {status.restartRequired && <Badge label="需要重启 SignalRGB" state="warn" />}
              <span className="ml-auto text-[10px] text-white/35">输出</span>
              <Toggle checked={settings.outputEnabled} onChange={(outputEnabled) => update({ outputEnabled })} label="SignalRGB 语义事件输出" />
              <button type="button" disabled={busy} onClick={() => void client.refresh()} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />刷新</button>
            </div>
            <nav className="flex overflow-x-auto px-2 sm:px-5" aria-label="SignalRGB 控制台页面">
              {TABS.map((item) => {
                const Icon = item.icon;
                return <button key={item.value} type="button" onClick={() => setTab(item.value)} className={`relative flex shrink-0 items-center gap-2 px-4 py-2.5 text-xs font-medium ${tab === item.value ? "text-white" : "text-white/40 hover:text-white/75"}`} aria-current={tab === item.value ? "page" : undefined}><Icon className={`h-4 w-4 ${tab === item.value ? "text-cyan-300" : ""}`} />{item.label}{tab === item.value && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-cyan-300" />}</button>;
              })}
            </nav>
          </header>
          <main className="plugin-center-scroll min-h-0 flex-1 overflow-y-auto">
            {tab === "effect" && (
              <div className="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)] sm:p-4">
                <div className="min-w-0 space-y-3">
                  <section className="border p-4" style={PANEL}>
                    <div className="mb-3 flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-white/90">音频语义预览</h3><p className="mt-0.5 text-[10px] text-white/35">WaveForge 原创预览，不代表 SignalRGB 的逐像素输出</p></div><Activity className="h-4 w-4 text-cyan-300" /></div>
                    <SemanticPreview settings={settings} active={active} />
                  </section>
                  <section className="border p-4" style={PANEL}>
                    <div className="mb-3 flex items-end justify-between"><div><h3 className="text-sm font-semibold text-white/90">Effect 风格</h3><p className="mt-0.5 text-[10px] text-white/35">选择后发送低频 style 事件</p></div><span className="text-[10px] text-cyan-200">12 STYLES</span></div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" role="group" aria-label="SignalRGB Effect 风格">
                      {SIGNALRGB_STYLES.map((style) => <button key={style} type="button" onClick={() => update({ style })} aria-pressed={settings.style === style} className={`min-w-0 rounded-md border px-3 py-2 text-left text-[11px] ${settings.style === style ? "border-cyan-300 bg-cyan-300/10 text-white" : "border-white/10 bg-black/20 text-white/50 hover:border-white/25"}`}>{SIGNALRGB_STYLE_LABELS[style]}</button>)}
                    </div>
                  </section>
                </div>
                <aside className="min-w-0 space-y-3">
                  <section className="border p-4" style={PANEL}>
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-white/90"><Palette className="h-4 w-4 text-pink-300" />主题色</h3>
                    <div className="mt-3 space-y-2">{settings.themeColors.map((color, index) => <label key={index} className="flex items-center gap-3 rounded-md border border-white/10 bg-black/20 p-2 text-xs text-white/55"><input type="color" value={color} onChange={(event) => { const themeColors: [string, string, string] = [...settings.themeColors]; themeColors[index] = event.target.value; update({ themeColors }); }} className="h-8 w-10 cursor-pointer border-0 bg-transparent" aria-label={`主题颜色 ${index + 1}`} /><span>颜色 {index + 1}</span><code className="ml-auto text-[10px] text-white/35">{color}</code></label>)}</div>
                  </section>
                  <section className="border p-4" style={PANEL}>
                    <h3 className="text-sm font-semibold text-white/90">事件增强</h3>
                    <div className="mt-3 space-y-4">
                      <ToggleRow label="节拍与重音事件" detail="超过阈值并经过冷却后发送；不发送频谱" checked={settings.eventEnhancement} onChange={(eventEnhancement) => update({ eventEnhancement })} />
                      <label className="block text-xs text-white/50"><span className="flex justify-between"><span>触发阈值</span><strong className="text-cyan-200">{Math.round(settings.beatThreshold * 100)}%</strong></span><input type="range" min="0.1" max="1" step="0.01" value={settings.beatThreshold} onChange={(event) => update({ beatThreshold: Number(event.target.value) })} className="mt-2 w-full accent-cyan-300" /></label>
                    </div>
                  </section>
                  <section className="border p-4" style={PANEL}>
                    <h3 className="text-sm font-semibold text-white/90">SignalRGB 内部参数</h3><p className="mt-2 text-[11px] leading-relaxed text-white/45">灵敏度、衰减、尺寸、亮度、速度、镜像与方向由 SignalRGB Effect UI 管理。WaveForge 控制台不会伪装成这些原生参数的远程编辑器。</p>
                  </section>
                </aside>
              </div>
            )}
            {tab === "signalrgb" && (
              <div className="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-2 sm:p-4">
                <div className="min-w-0 space-y-3">
                  <section className="border p-4" style={PANEL}>
                    <h3 className="text-sm font-semibold text-white/90">运行能力</h3>
                    <div className="mt-3 flex flex-wrap gap-2"><Badge label={status.installed ? "已安装" : "未安装"} state={status.installed ? "ok" : "off"} /><Badge label={status.running ? "运行中" : "未运行"} state={status.running ? "ok" : "off"} /><Badge label={status.localApiAvailable ? "Local API" : "Local API 不可用"} state={status.localApiAvailable ? "ok" : "off"} /><Badge label={status.proAvailable === true ? "Pro 可用" : status.proAvailable === false ? "无 Pro" : "Pro 未知"} state={proState} /><Badge label={status.canvasEventAvailable ? "Canvas Event" : "Canvas Event 未探测"} state={status.canvasEventAvailable ? "ok" : "off"} /></div>
                    <div className="mt-4 grid grid-cols-1 gap-2 text-[11px]"><div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2"><span className="text-white/35">Effect 路径</span><span className="break-all font-mono text-white/60">{status.effectPath || "未找到"}</span></div><div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2"><span className="text-white/35">SHA-256</span><span className="break-all font-mono text-white/60">{status.effectHash || status.hash || "无"}</span></div><div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2"><span className="text-white/35">文件冲突</span><span className={status.conflict ? "text-red-300" : "text-white/60"}>{status.conflict ? "存在同名但非 WaveForge 管理的文件，拒绝覆盖" : "无"}</span></div></div>
                  </section>
                  <section className="border p-4" style={PANEL}>
                    <h3 className="text-sm font-semibold text-white/90">Effect 管理</h3>
                    <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy || status.conflict || !status.installed} onClick={() => setConfirmInstall(true)} className="flex items-center gap-1.5 rounded-md bg-cyan-300 px-3 py-2 text-xs font-semibold text-black disabled:opacity-35"><Upload className="h-4 w-4" />{effectActionLabel}</button><button type="button" disabled={busy} onClick={() => void client.openSignalRgb()} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-white/65 disabled:opacity-35"><ExternalLink className="h-4 w-4" />打开 SignalRGB</button>{status.effectInstalled && !confirmUninstall && <button type="button" disabled={busy} onClick={() => setConfirmUninstall(true)} className="flex items-center gap-1.5 rounded-md border border-red-300/25 bg-red-300/[0.06] px-3 py-2 text-xs text-red-200"><Trash2 className="h-4 w-4" />卸载</button>}</div>
                    {confirmInstall && <div className="mt-3 rounded-md border border-cyan-300/25 bg-cyan-300/[0.06] p-3"><p className="text-xs font-semibold text-cyan-100">确认{status.effectInstalled ? "更新" : "安装"} WaveForge Effect？</p><p className="mt-1 break-all text-[11px] text-white/45">将写入：{status.effectPath || "SignalRGB 最新版本的 Dynamic Effects 目录"}</p><p className="mt-1 text-[11px] text-white/45">WaveForge 只管理带所有权哈希的 WaveForge.html；完成后需要重启 SignalRGB。</p><div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => { setConfirmInstall(false); void client.installEffect(); }} className="rounded-md bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-black">确认{status.effectInstalled ? "更新" : "安装"}</button><button type="button" onClick={() => setConfirmInstall(false)} className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/60">取消</button></div></div>}
                    {confirmUninstall && <div className="mt-3 rounded-md border border-red-300/25 bg-red-300/[0.06] p-3"><p className="text-xs font-semibold text-red-200">确认卸载 WaveForge Effect？</p><p className="mt-1 text-[11px] text-white/45">只会删除带 WaveForge 所有权标记且哈希匹配的 Effect 文件。</p><div className="mt-3 flex gap-2"><button type="button" disabled={busy} onClick={() => { setConfirmUninstall(false); void client.uninstallEffect(); }} className="rounded-md bg-red-300 px-3 py-1.5 text-xs font-semibold text-black">确认卸载</button><button type="button" onClick={() => setConfirmUninstall(false)} className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/60">取消</button></div></div>}
                    {status.restartRequired && <p className="mt-3 flex items-center gap-2 text-[11px] text-amber-200"><AlertTriangle className="h-4 w-4" />安装位置或版本已变化，请重启 SignalRGB 后再选择 WaveForge。</p>}
                  </section>
                  <section className="border p-4" style={PANEL}>
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-white/90"><Crown className="h-4 w-4 text-amber-300" />Pro 效果切换</h3>
                    <p className="mt-1 text-[11px] text-white/40">自动应用和恢复只通过 SignalRGB Pro Local API。没有 Pro 时请在 SignalRGB 中手动选择 WaveForge。</p>
                    <div className="mt-3 flex gap-2"><button type="button" disabled={busy || status.proAvailable !== true || !status.effectInstalled} onClick={() => void client.applyEffect()} className="flex items-center gap-1.5 rounded-md border border-emerald-300/25 bg-emerald-300/[0.07] px-3 py-2 text-xs text-emerald-200 disabled:opacity-35"><Play className="h-4 w-4" />应用</button><button type="button" disabled={busy || status.proAvailable !== true} onClick={() => void client.restoreEffect()} className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-2 text-xs text-white/60 disabled:opacity-35"><RotateCcw className="h-4 w-4" />恢复之前效果</button></div>
                  </section>
                </div>
                <div className="min-w-0 space-y-3"><section className="border p-4" style={PANEL}><h3 className="text-sm font-semibold text-white/90">当前布局</h3><div className="mt-3"><JsonValue value={status.layout} /></div><p className="mt-2 text-[10px] text-white/30">Local API 返回 {status.layouts.length} 个可读布局；物理设备枚举不在当前 API 能力内。</p></section><section className="border p-4" style={PANEL}><h3 className="text-sm font-semibold text-white/90">当前效果</h3><div className="mt-3"><JsonValue value={status.currentEffect} /></div></section></div>
              </div>
            )}
            {tab === "advanced" && (
              <div className="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-2 sm:p-4">
                <div className="min-w-0 space-y-3"><section className="border p-4" style={PANEL}><h3 className="text-sm font-semibold text-white/90">运行策略</h3><div className="mt-4 space-y-4"><ToggleRow label="事件输出" detail="总开关；关闭后不发送播放、主题或节拍事件" checked={settings.outputEnabled} onChange={(outputEnabled) => update({ outputEnabled })} /><ToggleRow label="自动应用 Effect" detail="插件启动时通过 Pro Local API 应用 WaveForge" checked={settings.autoApply} onChange={(autoApply) => update({ autoApply })} disabled={status.proAvailable === false} /><ToggleRow label="停止时恢复" detail="插件停用时通过 Pro Local API 恢复之前效果" checked={settings.restoreOnStop} onChange={(restoreOnStop) => update({ restoreOnStop })} /><ToggleRow label="事件增强" detail="发送 beat 与 accent 低频语义事件" checked={settings.eventEnhancement} onChange={(eventEnhancement) => update({ eventEnhancement })} /><ToggleRow label="GET 兼容回退" detail="Canvas Event POST 失败时允许 GET；仅用于兼容旧环境" checked={settings.getFallback} onChange={(getFallback) => update({ getFallback })} /><ToggleRow label="后台分析" detail="窗口隐藏时保留音频分析租约，用于节拍事件" checked={settings.runInBackground} onChange={(runInBackground) => update({ runInBackground })} /></div></section><section className="border p-4" style={PANEL}><h3 className="text-sm font-semibold text-white/90">事件冷却</h3><label className="mt-4 block text-xs text-white/50"><span className="flex justify-between"><span>Beat / Accent 最短间隔</span><strong className="text-cyan-200">{settings.eventCooldown} ms</strong></span><input type="range" min="80" max="1000" step="10" value={settings.eventCooldown} onChange={(event) => update({ eventCooldown: Number(event.target.value) })} className="mt-2 w-full accent-cyan-300" /></label></section><button type="button" onClick={() => client.resetSettings()} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/60"><RotateCcw className="h-4 w-4" />恢复默认设置</button></div>
                <div className="min-w-0 space-y-3"><section className="border p-4" style={PANEL}><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-white/90">事件与错误</h3><button type="button" disabled={busy} onClick={() => void client.refresh()} className="rounded-md p-2 text-white/50 hover:bg-white/10" title="刷新诊断" aria-label="刷新诊断"><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} /></button></div><div className="mt-3 space-y-2 text-[11px]"><div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2"><span className="text-white/35">Last event</span><JsonValue value={status.lastEvent} /></div>{clientError && <div className="rounded-md border border-red-300/20 bg-red-300/[0.06] p-2 text-red-200">{clientError}</div>}{status.errors.slice(-5).reverse().map((error, index) => <p key={`${error.at}-${index}`} className="rounded-md border border-red-300/10 bg-red-300/[0.04] p-2 text-red-200/80"><span className="mr-2 font-mono text-[9px] text-white/30">{error.at}</span>{error.message}</p>)}</div></section><section className="border p-4" style={PANEL}><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-white/90">主进程日志</h3><span className="text-[10px] text-white/30">最近 {Math.min(50, status.logs.length)} 条</span></div><div className="plugin-log-select max-h-[430px] min-h-52 overflow-y-auto rounded-md border border-white/[0.07] bg-black/35 p-2 font-mono text-[10px] leading-relaxed">{status.logs.length === 0 ? <p className="p-2 text-white/30">暂无日志</p> : status.logs.slice(-50).reverse().map((log, index) => <p key={`${log.at}-${index}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-2 border-b border-white/[0.04] py-1.5 last:border-0"><span className="text-white/25">{log.at}</span><span className={log.level === "error" ? "text-red-300" : log.level === "warn" ? "text-amber-200" : "text-cyan-200"}>{log.level}</span><span className="break-words text-white/55">{log.message}</span></p>)}</div></section></div>
              </div>
            )}
          </main>
        </motion.div>
        <SignalRgbGuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />
      </motion.div>
    </AnimatePresence>
  );
}

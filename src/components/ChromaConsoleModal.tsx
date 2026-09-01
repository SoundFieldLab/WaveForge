import { useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  BookOpen,
  Cable,
  ChevronDown,
  CircleGauge,
  CloudRain,
  Disc3,
  Flame,
  Gamepad2,
  Headphones,
  Keyboard,
  Layers3,
  Lightbulb,
  Link2,
  MonitorCog,
  Mouse,
  Palette,
  Power,
  RadioTower,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { useTvBack } from "../tv/tvCore";
import {
  getChromaClient,
  useChromaClient,
  type ChromaDeviceType,
  type ChromaSettings,
} from "../plugins/clients/ChromaClient";
import {
  CHROMA_DEVICE_METADATA,
  CHROMA_DEVICE_TYPES,
  type ChromaBackgroundEffect,
  type ChromaDirection,
  type ChromaFps,
  type ChromaIdleMode,
  type ChromaThemeId,
  type KeyboardChromaStyle,
  type PeripheralChromaStyle,
} from "../plugins/clients/chroma/chromaTypes";
import { CHROMA_THEMES } from "../plugins/clients/chroma/chromaStyles";
import type { RazerHardwareDevice } from "../electron";
import {
  closeChromaConsole,
  usePluginHostState,
} from "../services/pluginStore";
import ChromaGuideModal from "./ChromaGuideModal";

const GREEN = "#44d62c";
const PANEL = "rgba(255,255,255,0.035)";
const BORDER = "rgba(255,255,255,0.09)";
type ConsoleTab = "visualizer" | "devices" | "advanced";

const TABS: {
  value: ConsoleTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { value: "visualizer", label: "可视化", icon: Activity },
  { value: "devices", label: "设备", icon: Keyboard },
  { value: "advanced", label: "连接与高级", icon: Settings2 },
];
const KEYBOARD_STYLES: {
  value: KeyboardChromaStyle;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { value: "spectrum-cycle", label: "光谱循环", icon: Disc3 },
  { value: "spectrum-static", label: "单色光谱", icon: Activity },
  { value: "spectrum-gradient", label: "渐变光谱", icon: Palette },
  { value: "wave", label: "波浪", icon: Waves },
  { value: "radial-pulse", label: "径向脉冲", icon: RadioTower },
  { value: "ripple", label: "涟漪", icon: Activity },
  { value: "breath", label: "呼吸", icon: Lightbulb },
  { value: "starlight", label: "星光", icon: Sparkles },
  { value: "fire", label: "火焰", icon: Flame },
  { value: "rain", label: "雨滴", icon: CloudRain },
  { value: "vu-meter", label: "VU 电平", icon: CircleGauge },
  { value: "static", label: "静态", icon: Zap },
];
const PERIPHERAL_STYLES: { value: PeripheralChromaStyle; label: string }[] = [
  { value: "spectrum", label: "频谱" },
  { value: "wave", label: "波浪" },
  { value: "pulse", label: "脉冲" },
  { value: "breath", label: "呼吸" },
  { value: "static", label: "静态" },
];
const DEVICE_ICONS: Record<
  ChromaDeviceType | "unknown",
  ComponentType<{ className?: string }>
> = {
  keyboard: Keyboard,
  mouse: Mouse,
  mousepad: Gamepad2,
  headset: Headphones,
  keypad: SlidersHorizontal,
  chromalink: Cable,
  unknown: Link2,
};

function normalizedKeyboardStyle(
  style: KeyboardChromaStyle,
): KeyboardChromaStyle {
  if (style === "bars") return "spectrum-gradient";
  if (style === "pulse") return "radial-pulse";
  return style;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap gap-1 rounded-md bg-black/35 p-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`min-w-[58px] flex-1 rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${value === option.value ? "bg-[#44d62c] text-black" : "text-white/50 hover:bg-white/10 hover:text-white/85"}`}
          aria-pressed={value === option.value}
          title={option.label}
        >
          <span className="block truncate">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-wait disabled:opacity-45 ${checked ? "bg-[#44d62c]" : "bg-white/15"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : ""}`}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <p className="text-xs font-medium text-white/85">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-white/40">
          {description}
        </p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function SliderRow({
  label,
  value,
  displayValue,
  min,
  max,
  step,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  displayValue: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
}) {
  const percentage = ((value - min) / (max - min)) * 100;
  return (
    <label className="block min-w-0">
      <span className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-white/50">{label}</span>
        <span className="shrink-0 font-semibold text-[#79ed65]">
          {displayValue}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 h-1 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#44d62c] [&::-webkit-slider-thumb]:shadow-[0_0_7px_rgba(68,214,44,0.7)]"
        style={{
          background: `linear-gradient(to right, ${GREEN} ${percentage}%, rgba(255,255,255,0.15) ${percentage}%)`,
        }}
        aria-label={label}
      />
      {hint && (
        <span className="mt-1 block text-[9px] text-white/30">{hint}</span>
      )}
    </label>
  );
}

function StatusBadge({
  label,
  ok,
  warning = false,
}: {
  label: string;
  ok: boolean;
  warning?: boolean;
}) {
  const color = ok ? "#44d62c" : warning ? "#facc15" : "#ef6b6b";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium"
      style={{ color, borderColor: `${color}45`, background: `${color}12` }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: color,
          boxShadow: ok ? `0 0 7px ${color}` : undefined,
        }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function bgrToCss(value: number): string {
  return `rgb(${value & 0xff}, ${(value >>> 8) & 0xff}, ${(value >>> 16) & 0xff})`;
}

function DeviceLightStrip({
  frame,
  count = 15,
}: {
  frame: Uint32Array | null;
  count?: number;
}) {
  return (
    <div
      className="grid h-3 w-full gap-0.5"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: count }, (_, index) => {
        const sourceIndex = frame?.length
          ? Math.min(
              frame.length - 1,
              Math.floor((index / count) * frame.length),
            )
          : 0;
        const color = frame?.[sourceIndex] ?? 0;
        return (
          <span
            key={index}
            className="rounded-[1px] bg-white/[0.04]"
            style={{
              backgroundColor: bgrToCss(color),
              boxShadow: color ? `0 0 5px ${bgrToCss(color)}` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function KeyboardPreview({
  frame,
  paused,
}: {
  frame: Uint32Array | null;
  paused: boolean;
}) {
  const cells = Array.from({ length: 132 }, (_, index) => frame?.[index] ?? 0);
  return (
    <div
      className="relative overflow-hidden rounded-md border border-white/10 bg-black/75 p-3 shadow-inner sm:p-4"
      aria-label="6 行 22 列键盘灯光实时预览"
    >
      <div
        className={`grid aspect-[22/6] w-full gap-[3px] transition-opacity ${paused ? "opacity-20" : ""}`}
        style={{ gridTemplateColumns: "repeat(22, minmax(0, 1fr))" }}
      >
        {cells.map((color, index) => (
          <span
            key={index}
            className="min-h-0 min-w-0 rounded-[2px] border border-white/[0.06]"
            style={{
              backgroundColor: bgrToCss(color),
              boxShadow: color ? `0 0 7px ${bgrToCss(color)}` : undefined,
            }}
          />
        ))}
      </div>
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="rounded-md border border-white/10 bg-black/75 px-4 py-2 text-xs font-medium text-white/75">
            预览已暂停
          </span>
        </div>
      )}
    </div>
  );
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "无";
}
function hardwareBinding(device: RazerHardwareDevice): ChromaDeviceType {
  return device.type === "unknown" ? "chromalink" : device.type;
}
function hardwareTypeLabel(device: RazerHardwareDevice): string {
  return device.type === "unknown"
    ? "Chroma 配件"
    : CHROMA_DEVICE_METADATA[device.type].label;
}

function HardwareCard({
  device,
  settings,
  updateDevice,
}: {
  device: RazerHardwareDevice;
  settings: ChromaSettings;
  updateDevice: (
    device: ChromaDeviceType,
    patch: Partial<ChromaSettings[ChromaDeviceType]>,
  ) => void;
}) {
  const binding = hardwareBinding(device);
  const deviceSettings = settings[binding];
  const Icon = DEVICE_ICONS[device.type];
  const styles =
    binding === "keyboard"
      ? KEYBOARD_STYLES.map(({ value, label }) => ({ value, label }))
      : PERIPHERAL_STYLES;
  const selectedStyle =
    binding === "keyboard"
      ? normalizedKeyboardStyle(settings.keyboard.style)
      : deviceSettings.style;
  const vidPid =
    device.vid || device.pid
      ? `${device.vid || "----"}:${device.pid || "----"}`
      : "系统未提供";
  return (
    <article
      className="min-w-0 border p-3 sm:p-4"
      style={{ background: PANEL, borderColor: BORDER }}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/45">
          <span className="absolute inset-2 rounded-full bg-[#44d62c]/20 blur-md" />
          <Icon className="relative h-9 w-9 text-[#70e75d] drop-shadow-[0_0_8px_rgba(68,214,44,0.55)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <h4
                className="truncate text-sm font-semibold text-white/90"
                title={device.name}
              >
                {device.name}
              </h4>
              <p className="mt-0.5 truncate font-mono text-[10px] text-white/35">
                VID:PID {vidPid}
              </p>
            </div>
            <StatusBadge
              label={device.present ? "在线" : "离线"}
              ok={device.present}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/55">
              {hardwareTypeLabel(device)}
            </span>
            {device.type === "unknown" && (
              <span className="rounded border border-[#44d62c]/20 bg-[#44d62c]/[0.06] px-2 py-0.5 text-[10px] text-[#86ed73]">
                通过 Chroma Link 控制
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/[0.07] pt-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-white/75">灯光联动</p>
            <p className="text-[10px] text-white/35">
              同类型设备共享 SDK 类别输出
            </p>
          </div>
          <Toggle
            checked={deviceSettings.enabled}
            onChange={(enabled) => updateDevice(binding, { enabled })}
            label={`${device.name}灯光联动`}
          />
        </div>
        <Segmented
          options={styles}
          value={selectedStyle}
          onChange={(style) =>
            updateDevice(binding, { style } as Partial<
              ChromaSettings[ChromaDeviceType]
            >)
          }
          ariaLabel={`${device.name}灯效风格`}
        />
        <div className="mt-3">
          <SliderRow
            label="设备强度"
            value={deviceSettings.intensity ?? 1}
            displayValue={`${Math.round((deviceSettings.intensity ?? 1) * 100)}%`}
            min={0}
            max={2}
            step={0.1}
            onChange={(intensity) => updateDevice(binding, { intensity })}
          />
        </div>
      </div>
    </article>
  );
}

export default function ChromaConsoleModal() {
  const { chromaConsoleOpen } = usePluginHostState();
  const { settings, status, preview, lastFrameAt } = useChromaClient();
  const client = getChromaClient();
  const [tab, setTab] = useState<ConsoleTab>("visualizer");
  const [guideOpen, setGuideOpen] = useState(false);
  const [sdkChannelsOpen, setSdkChannelsOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);

  useTvBack(() => {
    if (guideOpen) {
      setGuideOpen(false);
      return true;
    }
    if (chromaConsoleOpen) {
      closeChromaConsole();
      return true;
    }
    return false;
  }, [chromaConsoleOpen, guideOpen]);
  if (!chromaConsoleOpen) return null;

  const update = (patch: Partial<ChromaSettings>) =>
    client.updateSettings(patch);
  const updateKeyboard = (patch: Partial<ChromaSettings["keyboard"]>) =>
    update({ keyboard: { ...settings.keyboard, ...patch } });
  const updateDevice = (
    device: ChromaDeviceType,
    patch: Partial<ChromaSettings[ChromaDeviceType]>,
  ) =>
    update({
      [device]: { ...settings[device], ...patch },
    } as Partial<ChromaSettings>);
  const connected =
    status.platformSupported && status.synapseFound && status.registered;
  const heartbeatHealthy = Boolean(
    status.lastHeartbeatAt && Date.now() - status.lastHeartbeatAt < 20_000,
  );
  const availableCount = CHROMA_DEVICE_TYPES.filter(
    (device) => status.devices[device].available,
  ).length;
  const reconnect = async () => {
    if (reconnecting || stopping) return;
    setReconnecting(true);
    try {
      if (client.isActive()) await client.deactivate();
      await client.activate();
    } finally {
      setReconnecting(false);
    }
  };
  const setOutputEnabled = async (enabled: boolean) => {
    if (stopping || reconnecting) return;
    if (enabled) setReconnecting(true);
    else setStopping(true);
    try {
      client.updateSettings({ outputEnabled: enabled });
    } finally {
      if (enabled) setReconnecting(false);
      else setStopping(false);
    }
  };
  const refreshDevices = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await client.refreshDevices();
    } finally {
      setRefreshing(false);
    }
  };
  const scanHardware = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      await client.scanHardware();
    } finally {
      setScanning(false);
    }
  };
  const panelStyle = { background: PANEL, borderColor: BORDER };
  const keyboardStyle = normalizedKeyboardStyle(settings.keyboard.style);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[95] flex items-center justify-center p-2 sm:p-4"
        style={{
          backgroundColor: "rgba(0,0,0,0.84)",
          backdropFilter: "blur(14px)",
        }}
        data-tv-scope
        onClick={closeChromaConsole}
      >
        <motion.div
          initial={{ scale: 0.97, y: 10, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.97, y: 10, opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 320 }}
          onClick={(event) => event.stopPropagation()}
          className="flex h-[min(96vh,880px)] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border shadow-2xl"
          style={{
            background:
              "linear-gradient(155deg,#090b09 0%,#101410 62%,#080908 100%)",
            borderColor: "rgba(68,214,44,0.28)",
            boxShadow:
              "0 28px 90px rgba(0,0,0,0.75),0 0 50px rgba(68,214,44,0.06)",
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="chroma-console-title"
        >
          <header
            className="shrink-0 border-b"
            style={{ borderColor: "rgba(68,214,44,0.15)" }}
          >
            <div className="flex min-h-16 items-center justify-between gap-3 px-3 py-2 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#44d62c]/25 bg-[#44d62c]/10">
                  <Lightbulb className="h-6 w-6 text-[#70e75d]" />
                </div>
                <div className="min-w-0">
                  <h2
                    id="chroma-console-title"
                    className="truncate text-base font-bold text-white sm:text-lg"
                  >
                    Razer Chroma
                  </h2>
                  <p className="truncate text-[10px] text-[#76e763]/60">
                    WAVEFORGE LIGHTING CONSOLE
                  </p>
                </div>
                <StatusBadge
                  label={connected ? "已连接" : settings.outputEnabled ? "等待连接" : "输出已停止"}
                  ok={connected}
                  warning={settings.outputEnabled && !connected}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setGuideOpen(true)}
                  className="rounded-md p-2 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                  title="打开连接指南"
                  aria-label="打开连接指南"
                >
                  <BookOpen className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={closeChromaConsole}
                  className="rounded-md p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                  title="关闭控制台"
                  aria-label="关闭控制台"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] bg-black/20 px-3 py-2 sm:px-5">
              <div className="flex items-center gap-2">
                <Power className="h-4 w-4 text-[#44d62c]" />
                <div>
                  <p className="text-[10px] font-semibold text-white/75">
                    灯光输出
                  </p>
                  <p className="text-[9px] text-white/35">
                    {settings.outputEnabled ? "运行中" : "已停止"}
                  </p>
                </div>
                <Toggle
                  checked={settings.outputEnabled}
                  disabled={stopping || reconnecting}
                  onChange={(enabled) => void setOutputEnabled(enabled)}
                  label="Razer Chroma 灯光输出总开关"
                />
              </div>
              <div className="h-7 w-px bg-white/10" />
              <div className="flex items-center gap-2">
                <MonitorCog className="h-4 w-4 text-white/45" />
                <div>
                  <p className="text-[10px] font-semibold text-white/75">
                    实时预览
                  </p>
                  <p className="text-[9px] text-white/35">不影响硬件输出</p>
                </div>
                <Toggle
                  checked={settings.previewEnabled}
                  onChange={(previewEnabled) => update({ previewEnabled })}
                  label="实时预览总开关"
                />
              </div>
              <div className="ml-auto hidden min-w-0 items-center gap-4 text-[10px] md:flex">
                <div>
                  <span className="text-white/30">SDK</span>
                  <strong className="ml-1.5 font-mono text-white/65">
                    {status.sdkVersion || "--"}
                  </strong>
                </div>
                <div>
                  <span className="text-white/30">SESSION</span>
                  <strong className="ml-1.5 text-white/65">
                    {status.registered ? "ACTIVE" : "OFFLINE"}
                  </strong>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void refreshDevices()}
                disabled={refreshing || !status.registered}
                className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/60 transition-colors hover:bg-white/10 disabled:opacity-35"
                title="刷新 SDK 输出通道"
                aria-label="刷新 SDK 输出通道"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                />
                刷新
              </button>
              <button
                type="button"
                onClick={() => void reconnect()}
                disabled={reconnecting || stopping}
                className="flex items-center gap-1.5 rounded-md border border-[#44d62c]/30 bg-[#44d62c]/10 px-2.5 py-1.5 text-[11px] font-medium text-[#8af178] transition-colors hover:bg-[#44d62c]/20 disabled:opacity-45"
                title="重启 Chroma 会话"
                aria-label="重新连接 Chroma"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${reconnecting ? "animate-spin" : ""}`}
                />
                重连
              </button>
            </div>
            <nav
              className="flex overflow-x-auto px-2 sm:px-5"
              aria-label="Chroma 控制台页面"
            >
              {TABS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setTab(item.value)}
                    className={`relative flex shrink-0 items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors ${tab === item.value ? "text-white" : "text-white/40 hover:text-white/75"}`}
                    aria-current={tab === item.value ? "page" : undefined}
                  >
                    <Icon
                      className={`h-4 w-4 ${tab === item.value ? "text-[#44d62c]" : ""}`}
                    />
                    {item.label}
                    {tab === item.value && (
                      <span className="absolute inset-x-2 bottom-0 h-0.5 bg-[#44d62c]" />
                    )}
                  </button>
                );
              })}
            </nav>
          </header>
          <main className="plugin-center-scroll min-h-0 flex-1 overflow-y-auto">
            {tab === "visualizer" && (
              <VisualizerTab
                settings={settings}
                preview={preview}
                lastFrameAt={lastFrameAt}
                active={settings.outputEnabled}
                keyboardStyle={keyboardStyle}
                panelStyle={panelStyle}
                update={update}
                updateKeyboard={updateKeyboard}
              />
            )}
            {tab === "devices" && (
              <DevicesTab
                settings={settings}
                status={status}
                availableCount={availableCount}
                panelStyle={panelStyle}
                scanning={scanning}
                refreshing={refreshing}
                scanHardware={scanHardware}
                refreshDevices={refreshDevices}
                updateDevice={updateDevice}
                sdkChannelsOpen={sdkChannelsOpen}
                setSdkChannelsOpen={setSdkChannelsOpen}
              />
            )}
            {tab === "advanced" && (
              <AdvancedTab
                settings={settings}
                status={status}
                connected={connected}
                heartbeatHealthy={heartbeatHealthy}
                panelStyle={panelStyle}
                reconnecting={reconnecting}
                stopping={stopping}
                reconnect={reconnect}
                update={update}
                reset={() => client.resetSettings()}
              />
            )}
          </main>
        </motion.div>
        <ChromaGuideModal
          open={guideOpen}
          onClose={() => setGuideOpen(false)}
        />
      </motion.div>
    </AnimatePresence>
  );
}

function VisualizerTab({
  settings,
  preview,
  lastFrameAt,
  active,
  keyboardStyle,
  panelStyle,
  update,
  updateKeyboard,
}: {
  settings: ChromaSettings;
  preview: ReturnType<typeof useChromaClient>["preview"];
  lastFrameAt: number | null;
  active: boolean;
  keyboardStyle: KeyboardChromaStyle;
  panelStyle: React.CSSProperties;
  update: (patch: Partial<ChromaSettings>) => ChromaSettings;
  updateKeyboard: (
    patch: Partial<ChromaSettings["keyboard"]>,
  ) => ChromaSettings;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)] sm:p-4">
      <div className="min-w-0 space-y-3">
        <section
          className="border p-3 sm:p-4"
          style={panelStyle}
          aria-labelledby="chroma-preview-heading"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3
                id="chroma-preview-heading"
                className="flex items-center gap-2 text-sm font-semibold text-white/90"
              >
                <Keyboard className="h-4 w-4 text-[#44d62c]" />
                实时灯光舞台
              </h3>
              <p className="mt-0.5 text-[10px] text-white/35">
                键盘矩阵 6 × 22 ·{" "}
                {lastFrameAt
                  ? `${Math.max(0, Math.round((Date.now() - lastFrameAt) / 1000))} 秒前更新`
                  : "等待帧"}
              </p>
            </div>
            <span className="text-[10px] text-white/35">
              硬件输出 {settings.outputEnabled ? "运行中" : "已停止"}
            </span>
          </div>
          <KeyboardPreview
            frame={preview.keyboard}
            paused={!settings.previewEnabled}
          />
          <div
            className={`mt-3 grid grid-cols-2 gap-2 transition-opacity sm:grid-cols-4 ${settings.previewEnabled ? "" : "opacity-25"}`}
          >
            {(
              [
                "mousepad",
                "mouse",
                "headset",
                "chromalink",
              ] as ChromaDeviceType[]
            ).map((device) => {
              const Icon = DEVICE_ICONS[device];
              return (
                <div
                  key={device}
                  className="min-w-0 rounded-md border border-white/[0.07] bg-black/30 p-2"
                >
                  <div className="mb-2 flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-white/45" />
                    <span className="truncate text-[10px] text-white/50">
                      {CHROMA_DEVICE_METADATA[device].label}
                    </span>
                  </div>
                  <DeviceLightStrip
                    frame={preview[device]}
                    count={device === "mousepad" ? 20 : 10}
                  />
                </div>
              );
            })}
          </div>
        </section>
        <section
          className="border p-3 sm:p-4"
          style={panelStyle}
          aria-labelledby="chroma-style-heading"
        >
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3
                id="chroma-style-heading"
                className="text-sm font-semibold text-white/90"
              >
                可视化风格
              </h3>
              <p className="mt-0.5 text-[10px] text-white/35">
                旧版“频谱柱 / 脉冲”设置会分别映射到渐变光谱 / 径向脉冲
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-[#79ed65]">
              12 STYLES
            </span>
          </div>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4"
            role="group"
            aria-label="键盘可视化风格"
          >
            {KEYBOARD_STYLES.map((item) => {
              const Icon = item.icon;
              const selected = keyboardStyle === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => updateKeyboard({ style: item.value })}
                  className={`flex min-w-0 items-center gap-2 rounded-md border px-3 py-2.5 text-left transition-colors ${selected ? "border-[#44d62c] bg-[#44d62c]/10 text-white" : "border-white/[0.08] bg-black/20 text-white/50 hover:border-white/20 hover:text-white/80"}`}
                  aria-pressed={selected}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${selected ? "text-[#44d62c]" : ""}`}
                  />
                  <span className="truncate text-[11px] font-medium">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <section
          className="border p-3 sm:p-4"
          style={panelStyle}
          aria-labelledby="chroma-core-heading"
        >
          <h3
            id="chroma-core-heading"
            className="mb-4 text-sm font-semibold text-white/90"
          >
            光谱响应
          </h3>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
            <SliderRow
              label="亮度"
              value={settings.brightness}
              displayValue={`${Math.round(settings.brightness * 100)}%`}
              min={0.4}
              max={2}
              step={0.05}
              onChange={(brightness) => update({ brightness })}
            />
            <SliderRow
              label="灵敏度"
              value={settings.sensitivity}
              displayValue={`${settings.sensitivity.toFixed(1)}×`}
              min={0.5}
              max={3}
              step={0.1}
              onChange={(sensitivity) => update({ sensitivity })}
            />
            <SliderRow
              label="衰减"
              value={settings.decay}
              displayValue={String(settings.decay)}
              min={1}
              max={10}
              step={1}
              onChange={(decay) => update({ decay })}
              hint="1 慢 · 10 快"
            />
            <SliderRow
              label="大小"
              value={settings.size}
              displayValue={String(settings.size)}
              min={1}
              max={10}
              step={1}
              onChange={(size) => update({ size })}
            />
            <SliderRow
              label="平滑"
              value={settings.smoothing}
              displayValue={`${Math.round(settings.smoothing * 100)}%`}
              min={0}
              max={1}
              step={0.05}
              onChange={(smoothing) => update({ smoothing })}
            />
            <SliderRow
              label="色彩循环速度"
              value={settings.colorRotationSpeed}
              displayValue={`${settings.colorRotationSpeed.toFixed(2)}×`}
              min={0}
              max={2}
              step={0.05}
              onChange={(colorRotationSpeed) => update({ colorRotationSpeed })}
            />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-white/[0.07] pt-4 sm:grid-cols-2">
            <ToggleRow
              label="镜像频谱"
              description="从中心向两侧对称展开频段"
              checked={settings.spectrumMirrored}
              onChange={(spectrumMirrored) => update({ spectrumMirrored })}
            />
            <ToggleRow
              label="节拍闪光"
              description="重音到来时快速提升前景亮度"
              checked={settings.keyboard.beatFlash}
              onChange={(beatFlash) => updateKeyboard({ beatFlash })}
            />
          </div>
        </section>
      </div>
      <aside className="min-w-0 space-y-3">
        <section
          className="border p-3 sm:p-4"
          style={panelStyle}
          aria-labelledby="chroma-background-heading"
        >
          <h3
            id="chroma-background-heading"
            className="mb-3 text-sm font-semibold text-white/90"
          >
            背景效果
          </h3>
          <Segmented<ChromaBackgroundEffect>
            options={[
              { value: "off", label: "关闭" },
              { value: "static", label: "静态" },
              { value: "breath", label: "呼吸" },
              { value: "wave", label: "波浪" },
              { value: "spectrum", label: "光谱" },
            ]}
            value={settings.backgroundEffect}
            onChange={(backgroundEffect) => update({ backgroundEffect })}
            ariaLabel="背景效果"
          />
          <div className="mt-4 space-y-4">
            <ToggleRow
              label="响应式背景"
              description="背景亮度同时跟随整体能量变化"
              checked={settings.reactiveBackground}
              onChange={(reactiveBackground) => update({ reactiveBackground })}
            />
            <SliderRow
              label="背景亮度"
              value={settings.backgroundBrightness}
              displayValue={`${Math.round(settings.backgroundBrightness * 100)}%`}
              min={0.01}
              max={1}
              step={0.01}
              onChange={(backgroundBrightness) =>
                update({ backgroundBrightness })
              }
            />
          </div>
        </section>
        <section
          className="border p-3 sm:p-4"
          style={panelStyle}
          aria-labelledby="chroma-color-heading"
        >
          <h3
            id="chroma-color-heading"
            className="mb-3 text-sm font-semibold text-white/90"
          >
            方向与色板
          </h3>
          <p className="mb-1.5 text-[10px] text-white/40">灯效方向</p>
          <Segmented<ChromaDirection>
            options={[
              { value: "ltr", label: "左到右" },
              { value: "mirror", label: "镜像" },
              { value: "center", label: "中心" },
            ]}
            value={settings.keyboard.direction}
            onChange={(direction) => updateKeyboard({ direction })}
            ariaLabel="灯效方向"
          />
          <p className="mb-2 mt-4 text-[10px] text-white/40">主题色板</p>
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label="主题色板"
          >
            {(Object.keys(CHROMA_THEMES) as ChromaThemeId[]).map((themeId) => {
              const theme = CHROMA_THEMES[themeId];
              const colors =
                themeId === "custom"
                  ? settings.keyboard.customColors
                  : theme.colors;
              return (
                <button
                  key={themeId}
                  type="button"
                  onClick={() => updateKeyboard({ theme: themeId })}
                  className={`min-w-0 rounded-md border p-2 text-left transition-colors ${settings.keyboard.theme === themeId ? "border-[#44d62c] bg-[#44d62c]/10" : "border-white/10 bg-black/20 hover:border-white/25"}`}
                  title={theme.label}
                  aria-label={`选择${theme.label}色板`}
                  aria-pressed={settings.keyboard.theme === themeId}
                >
                  <span className="flex h-3 overflow-hidden rounded-sm">
                    {colors.map((color, index) => (
                      <span
                        key={`${color}-${index}`}
                        className="h-full flex-1"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className="mt-1.5 block truncate text-center text-[10px] text-white/50">
                    {theme.label}
                  </span>
                </button>
              );
            })}
          </div>
          {settings.keyboard.theme === "custom" && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {settings.keyboard.customColors.map((color, index) => (
                <label
                  key={index}
                  className="flex min-w-0 items-center gap-2 rounded-md border border-white/10 bg-black/20 p-2 text-[10px] text-white/45"
                >
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => {
                      const customColors: [string, string] = [
                        ...settings.keyboard.customColors,
                      ];
                      customColors[index] = event.target.value;
                      updateKeyboard({ customColors });
                    }}
                    className="h-7 w-8 shrink-0 cursor-pointer border-0 bg-transparent p-0"
                    aria-label={`自定义颜色 ${index + 1}`}
                  />
                  <span className="truncate">颜色 {index + 1}</span>
                </label>
              ))}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

function DevicesTab({
  settings,
  status,
  availableCount,
  panelStyle,
  scanning,
  refreshing,
  scanHardware,
  refreshDevices,
  updateDevice,
  sdkChannelsOpen,
  setSdkChannelsOpen,
}: {
  settings: ChromaSettings;
  status: ReturnType<typeof useChromaClient>["status"];
  availableCount: number;
  panelStyle: React.CSSProperties;
  scanning: boolean;
  refreshing: boolean;
  scanHardware: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  updateDevice: (
    device: ChromaDeviceType,
    patch: Partial<ChromaSettings[ChromaDeviceType]>,
  ) => void;
  sdkChannelsOpen: boolean;
  setSdkChannelsOpen: (
    value: boolean | ((previous: boolean) => boolean),
  ) => void;
}) {
  return (
    <div className="min-w-0 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white/90">Razer 硬件</h3>
          <p className="mt-0.5 text-[10px] text-white/35">
            Windows PnP 实际发现的设备 · 同类型产品共享一个 Chroma SDK 输出通道
          </p>
        </div>
        <button
          type="button"
          onClick={() => void scanHardware()}
          disabled={scanning}
          className="flex items-center gap-1.5 rounded-md border border-[#44d62c]/30 bg-[#44d62c]/10 px-3 py-2 text-xs text-[#8af178] hover:bg-[#44d62c]/20 disabled:opacity-45"
        >
          <ScanSearch
            className={`h-4 w-4 ${scanning ? "animate-pulse" : ""}`}
          />
          重新扫描硬件
        </button>
      </div>
      {status.hardwareDevices.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {status.hardwareDevices.map((device) => (
            <HardwareCard
              key={device.id}
              device={device}
              settings={settings}
              updateDevice={updateDevice}
            />
          ))}
        </div>
      ) : (
        <section className="flex min-h-52 flex-col items-center justify-center rounded-md border border-dashed border-white/10 bg-black/20 px-5 py-8 text-center">
          <ScanSearch className="h-9 w-9 text-white/20" />
          <h4 className="mt-3 text-sm font-semibold text-white/70">
            未发现 Razer PnP 硬件
          </h4>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-white/35">
            确认设备已连接并被 Windows 识别，然后重新扫描。Chroma SDK
            通道状态仍可在下方独立查看。
          </p>
          <button
            type="button"
            onClick={() => void scanHardware()}
            disabled={scanning}
            className="mt-4 flex items-center gap-1.5 rounded-md bg-[#44d62c] px-3 py-2 text-xs font-semibold text-black disabled:opacity-45"
          >
            <ScanSearch className="h-4 w-4" />
            开始扫描
          </button>
        </section>
      )}
      {status.deviceDiscoveryError && (
        <div className="mt-3 border-l-2 border-red-400/60 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
          硬件扫描错误：{status.deviceDiscoveryError}
        </div>
      )}
      <section
        className="mt-4 border"
        style={panelStyle}
        aria-labelledby="sdk-channel-heading"
      >
        <button
          type="button"
          onClick={() => setSdkChannelsOpen((value) => !value)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-white/[0.03]"
          aria-expanded={sdkChannelsOpen}
          aria-controls="sdk-channel-panel"
        >
          <Layers3 className="h-4 w-4 text-[#44d62c]" />
          <div>
            <h3
              id="sdk-channel-heading"
              className="text-xs font-semibold text-white/80"
            >
              SDK 输出通道
            </h3>
            <p className="text-[10px] text-white/35">
              六类逻辑端点，仅用于输出诊断，不代表物理设备型号
            </p>
          </div>
          <span className="ml-auto mr-2 text-[10px] text-white/35">
            {availableCount}/{CHROMA_DEVICE_TYPES.length} accepted
          </span>
          <ChevronDown
            className={`h-4 w-4 text-white/40 transition-transform ${sdkChannelsOpen ? "rotate-180" : ""}`}
          />
        </button>
        {sdkChannelsOpen && (
          <div
            id="sdk-channel-panel"
            className="border-t border-white/[0.07] p-3"
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CHROMA_DEVICE_TYPES.map((device) => {
                const endpoint = status.devices[device];
                const Icon = DEVICE_ICONS[device];
                return (
                  <div
                    key={device}
                    className="flex items-center gap-2 rounded-md border border-white/[0.07] bg-black/25 p-2.5"
                  >
                    <Icon
                      className={`h-4 w-4 ${endpoint.available ? "text-[#44d62c]" : "text-white/25"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-white/70">
                        {CHROMA_DEVICE_METADATA[device].label}
                      </p>
                      <p className="truncate text-[9px] text-white/30">
                        {endpoint.effectCreated
                          ? "effect accepted"
                          : endpoint.available
                            ? "available / effect pending"
                            : "not available"}
                      </p>
                    </div>
                    <span
                      className={`font-mono text-[9px] ${endpoint.failures ? "text-red-300" : "text-white/25"}`}
                    >
                      {endpoint.zones} zones · fail {endpoint.failures}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => void refreshDevices()}
                disabled={refreshing || !status.registered}
                className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/60 hover:bg-white/10 disabled:opacity-35"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                />
                刷新 SDK 通道
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function AdvancedTab({
  settings,
  status,
  connected,
  heartbeatHealthy,
  panelStyle,
  reconnecting,
  stopping,
  reconnect,
  update,
  reset,
}: {
  settings: ChromaSettings;
  status: ReturnType<typeof useChromaClient>["status"];
  connected: boolean;
  heartbeatHealthy: boolean;
  panelStyle: React.CSSProperties;
  reconnecting: boolean;
  stopping: boolean;
  reconnect: () => Promise<void>;
  update: (patch: Partial<ChromaSettings>) => ChromaSettings;
  reset: () => ChromaSettings;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 p-3 lg:grid-cols-2 sm:p-4">
      <div className="min-w-0 space-y-3">
        <section
          className="border p-4"
          style={panelStyle}
          aria-labelledby="connection-heading"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3
                id="connection-heading"
                className="flex items-center gap-2 text-sm font-semibold text-white/90"
              >
                <Link2 className="h-4 w-4 text-[#44d62c]" />
                连接状态
              </h3>
              <p className="mt-1 text-[10px] text-white/35">
                Chroma REST SDK 会话与 Synapse 状态
              </p>
            </div>
            <button
              type="button"
              onClick={() => void reconnect()}
              disabled={reconnecting || stopping}
              className="flex items-center gap-1.5 rounded-md border border-[#44d62c]/30 bg-[#44d62c]/10 px-3 py-2 text-xs text-[#8af178] hover:bg-[#44d62c]/20 disabled:opacity-45"
            >
              <RefreshCw
                className={`h-4 w-4 ${reconnecting ? "animate-spin" : ""}`}
              />
              重新连接
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <StatusBadge
              label={
                status.platformSupported ? "Windows 支持" : "仅支持 Windows"
              }
              ok={status.platformSupported}
            />
            <StatusBadge
              label={
                status.synapseFound
                  ? `Synapse ${status.sdkVersion || "已发现"}`
                  : "未发现 Synapse"
              }
              ok={status.synapseFound}
            />
            <StatusBadge
              label={status.registered ? "会话已注册" : "会话未注册"}
              ok={status.registered}
              warning={status.synapseFound}
            />
            <StatusBadge
              label={heartbeatHealthy ? "心跳正常" : "无有效心跳"}
              ok={heartbeatHealthy}
              warning={status.registered}
            />
          </div>
          {!connected && (
            <div className="mt-4 border-l-2 border-[#44d62c]/55 bg-[#44d62c]/[0.055] px-3 py-2 text-[11px] leading-relaxed text-white/55">
              安装 Synapse 3/4 与 Chroma Connect，在 Chroma Studio
              允许应用控制，然后保持 Synapse 运行并重新连接。
            </div>
          )}
        </section>
        <section
          className="border p-4"
          style={panelStyle}
          aria-labelledby="runtime-heading"
        >
          <h3
            id="runtime-heading"
            className="mb-4 text-sm font-semibold text-white/90"
          >
            运行策略
          </h3>
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-[10px] text-white/40">输出帧率</p>
              <Segmented<`${ChromaFps}`>
                options={[
                  { value: "15", label: "15 FPS" },
                  { value: "30", label: "30 FPS" },
                ]}
                value={String(settings.fps) as `${ChromaFps}`}
                onChange={(fps) => update({ fps: Number(fps) as ChromaFps })}
                ariaLabel="输出帧率"
              />
            </div>
            <ToggleRow
              label="后台运行"
              description="窗口不可见时仍保留音频分析和灯效输出"
              checked={settings.runInBackground}
              onChange={(runInBackground) => update({ runInBackground })}
            />
            <div>
              <p className="mb-1.5 text-[10px] text-white/40">空闲模式</p>
              <Segmented<ChromaIdleMode>
                options={[
                  { value: "breathing", label: "呼吸" },
                  { value: "static", label: "静态" },
                  { value: "off", label: "熄灭" },
                  { value: "release", label: "归还" },
                ]}
                value={settings.idleMode}
                onChange={(idleMode) => update({ idleMode })}
                ariaLabel="空闲模式"
              />
            </div>
          </div>
        </section>
        <section
          className="border p-4"
          style={panelStyle}
          aria-labelledby="diagnostic-heading"
        >
          <h3
            id="diagnostic-heading"
            className="mb-3 text-sm font-semibold text-white/90"
          >
            诊断信息
          </h3>
          <div className="space-y-2 text-[11px]">
            <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
              <span className="text-white/35">最近错误</span>
              <span className="break-words text-red-300/75">
                {status.lastError || "无"}
              </span>
            </div>
            <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
              <span className="text-white/35">Session ID</span>
              <span className="break-all font-mono text-white/65">
                {status.sessionId || "无"}
              </span>
            </div>
            <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
              <span className="text-white/35">最后心跳</span>
              <span className="break-words text-white/65">
                {formatTime(status.lastHeartbeatAt)}
              </span>
            </div>
            <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-2">
              <span className="text-white/35">设备扫描时间</span>
              <span className="break-words text-white/65">
                {formatTime(status.lastDeviceScanAt)}
              </span>
            </div>
          </div>
        </section>
      </div>
      <div className="min-w-0 space-y-3">
        <section
          className="border p-4"
          style={panelStyle}
          aria-labelledby="log-heading"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3
              id="log-heading"
              className="text-sm font-semibold text-white/90"
            >
              主进程日志
            </h3>
            <span className="text-[10px] text-white/30">
              最近 {Math.min(40, status.logs.length)} 条
            </span>
          </div>
          <div className="plugin-log-select max-h-[420px] min-h-52 overflow-y-auto rounded-md border border-white/[0.07] bg-black/35 p-2 font-mono text-[10px] leading-relaxed">
            {status.logs.length === 0 ? (
              <p className="p-2 text-white/30">暂无日志</p>
            ) : (
              status.logs
                .slice(-40)
                .reverse()
                .map((log, index) => (
                  <p
                    key={`${log.at}-${index}`}
                    className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-2 border-b border-white/[0.04] py-1.5 last:border-0"
                  >
                    <span className="text-white/30">{log.at}</span>
                    <span
                      className={
                        log.level === "error"
                          ? "text-red-400"
                          : log.level === "warn"
                            ? "text-yellow-300"
                            : "text-[#70de5d]"
                      }
                    >
                      {log.level}
                    </span>
                    <span className="break-words text-white/55">
                      {log.message}
                    </span>
                  </p>
                ))
            )}
          </div>
        </section>
        <section
          className="border p-4"
          style={panelStyle}
          aria-labelledby="reset-heading"
        >
          <h3
            id="reset-heading"
            className="text-sm font-semibold text-white/90"
          >
            设置维护
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-white/40">
            恢复所有风格、色板、设备强度、背景和运行策略的默认值。连接会话不会被关闭。
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-4 flex items-center gap-1.5 rounded-md border border-red-400/25 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300 transition-colors hover:bg-red-400/10"
            title="将所有 Chroma 设置恢复为默认值"
            aria-label="恢复所有 Chroma 默认设置"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复默认
          </button>
        </section>
      </div>
    </div>
  );
}

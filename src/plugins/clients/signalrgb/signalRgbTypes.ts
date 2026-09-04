export const SIGNALRGB_STYLES = [
  "spectrum-cycle",
  "gradient-spectrum",
  "wave",
  "ripple",
  "fire",
  "rain",
  "vu-meter",
  "aurora",
  "galaxy",
  "bass-reactor",
  "ambient",
  "static",
] as const;

export type SignalRgbStyle = (typeof SIGNALRGB_STYLES)[number];

export const SIGNALRGB_STYLE_LABELS: Record<SignalRgbStyle, string> = {
  "spectrum-cycle": "光谱循环",
  "gradient-spectrum": "渐变频谱",
  wave: "波浪",
  ripple: "涟漪",
  fire: "火焰",
  rain: "雨滴",
  "vu-meter": "VU 电平",
  aurora: "极光",
  galaxy: "星系",
  "bass-reactor": "低频反应堆",
  ambient: "环境色",
  static: "静态",
};

export interface SignalRgbSettings {
  outputEnabled: boolean;
  autoApply: boolean;
  restoreOnStop: boolean;
  runInBackground: boolean;
  eventEnhancement: boolean;
  getFallback: boolean;
  style: SignalRgbStyle;
  themeColors: [string, string, string];
  beatThreshold: number;
  eventCooldown: number;
}

export const DEFAULT_SIGNALRGB_SETTINGS: SignalRgbSettings = {
  outputEnabled: true,
  autoApply: false,
  restoreOnStop: true,
  runInBackground: false,
  eventEnhancement: true,
  getFallback: false,
  style: "spectrum-cycle",
  themeColors: ["#19d3c5", "#ff4f79", "#ffd166"],
  beatThreshold: 0.62,
  eventCooldown: 180,
};

export interface SignalRgbEventDecisionState {
  beatLatched: boolean;
  accentLatched: boolean;
  lastBeatAt: number;
  lastAccentAt: number;
}

export interface SignalRgbAudioEvent {
  value: string;
  kind: "beat" | "accent";
}

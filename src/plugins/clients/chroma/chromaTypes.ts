export const CHROMA_DEVICE_TYPES = [
  "keyboard",
  "mouse",
  "mousepad",
  "headset",
  "keypad",
  "chromalink",
] as const;

export type ChromaDeviceType = (typeof CHROMA_DEVICE_TYPES)[number];

export interface ChromaDeviceMetadata {
  label: string;
  rows: number;
  columns: number;
}

export const CHROMA_DEVICE_METADATA: Record<
  ChromaDeviceType,
  ChromaDeviceMetadata
> = {
  keyboard: { label: "键盘", rows: 6, columns: 22 },
  mouse: { label: "鼠标", rows: 9, columns: 7 },
  mousepad: { label: "鼠标垫", rows: 1, columns: 20 },
  headset: { label: "耳机", rows: 1, columns: 5 },
  keypad: { label: "小键盘", rows: 4, columns: 5 },
  chromalink: { label: "Chroma Link", rows: 1, columns: 5 },
};

export type ChromaFps = 15 | 30;
export type ChromaIdleMode = "breathing" | "static" | "off" | "release";
export type ChromaDirection = "ltr" | "mirror" | "center";
export type ChromaThemeId =
  | "razer"
  | "cyber"
  | "sunset"
  | "ocean"
  | "fire"
  | "aurora"
  | "white"
  | "custom";
export type KeyboardChromaStyle =
  | "spectrum-cycle"
  | "spectrum-static"
  | "spectrum-gradient"
  | "wave"
  | "radial-pulse"
  | "ripple"
  | "breath"
  | "starlight"
  | "fire"
  | "rain"
  | "vu-meter"
  | "static"
  | "bars"
  | "pulse";
export type PeripheralChromaStyle =
  "spectrum" | "wave" | "pulse" | "breath" | "static";
export type ChromaBackgroundEffect =
  "off" | "static" | "breath" | "wave" | "spectrum";

export interface ChromaStyleSettings<TStyle extends string> {
  enabled: boolean;
  style: TStyle;
  intensity?: number;
}

export interface KeyboardChromaSettings extends ChromaStyleSettings<KeyboardChromaStyle> {
  direction: ChromaDirection;
  theme: ChromaThemeId;
  customColors: [string, string];
  beatFlash: boolean;
  background: string;
}

export interface PeripheralChromaSettings extends ChromaStyleSettings<PeripheralChromaStyle> {
  direction?: ChromaDirection;
  theme: ChromaThemeId;
  customColors: [string, string];
  beatFlash: boolean;
  background: string;
}

export interface ChromaSettings {
  outputEnabled: boolean;
  fps: ChromaFps;
  previewEnabled: boolean;
  brightness: number;
  sensitivity: number;
  smoothing: number;
  decay: number;
  size: number;
  spectrumMirrored: boolean;
  colorRotationSpeed: number;
  backgroundEffect: ChromaBackgroundEffect;
  reactiveBackground: boolean;
  backgroundBrightness: number;
  runInBackground: boolean;
  idleMode: ChromaIdleMode;
  keyboard: KeyboardChromaSettings;
  mouse: PeripheralChromaSettings;
  mousepad: PeripheralChromaSettings;
  headset: PeripheralChromaSettings;
  keypad: PeripheralChromaSettings;
  chromalink: PeripheralChromaSettings;
}

export interface ChromaAudioData {
  spectrum?: ArrayLike<number> | null;
  bass?: number;
  mid?: number;
  high?: number;
  overall?: number;
  beat?: number;
  accent?: number;
  flux?: number;
}

export interface ChromaRenderOptions {
  now?: number;
  paused?: boolean;
  idle?: boolean;
  hidden?: boolean;
}

export type ChromaRenderAction = "frame" | "release";
export type ChromaDeviceFrame = Uint32Array | null;
export type ChromaFrames = Record<ChromaDeviceType, ChromaDeviceFrame>;

export interface ChromaRenderResult {
  action: ChromaRenderAction;
  frames: ChromaFrames;
}

export interface ChromaStyleEngine {
  render: (
    data: ChromaAudioData | null | undefined,
    settings: ChromaSettings,
    options?: ChromaRenderOptions,
  ) => ChromaRenderResult;
  reset: () => void;
}

const peripheral = (
  style: PeripheralChromaStyle,
): PeripheralChromaSettings => ({
  enabled: true,
  style,
  theme: "razer",
  customColors: ["#00ff66", "#00aaff"],
  beatFlash: true,
  background: "#000000",
});

export const DEFAULT_CHROMA_SETTINGS: ChromaSettings = {
  outputEnabled: true,
  fps: 30,
  previewEnabled: true,
  brightness: 1,
  sensitivity: 1,
  smoothing: 0.35,
  decay: 6,
  size: 3,
  spectrumMirrored: false,
  colorRotationSpeed: 0.65,
  backgroundEffect: "off",
  reactiveBackground: false,
  backgroundBrightness: 0.18,
  runInBackground: false,
  idleMode: "breathing",
  keyboard: {
    enabled: true,
    style: "bars",
    direction: "ltr",
    theme: "razer",
    customColors: ["#00ff66", "#00aaff"],
    beatFlash: true,
    background: "#000000",
  },
  mouse: peripheral("pulse"),
  mousepad: peripheral("wave"),
  headset: peripheral("pulse"),
  keypad: peripheral("spectrum"),
  chromalink: peripheral("wave"),
};

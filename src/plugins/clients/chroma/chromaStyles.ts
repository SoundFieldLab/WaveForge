import { createLogBandEdges, rebinSpectrumPower } from "../../rgb/rgbSpectrum";
import {
  CHROMA_DEVICE_METADATA,
  CHROMA_DEVICE_TYPES,
  type ChromaAudioData,
  type ChromaBackgroundEffect,
  type ChromaDeviceType,
  type ChromaDirection,
  type ChromaFrames,
  type ChromaRenderOptions,
  type ChromaRenderResult,
  type ChromaSettings,
  type ChromaStyleEngine,
  type ChromaThemeId,
  type KeyboardChromaSettings,
  type PeripheralChromaSettings,
} from "./chromaTypes";

export interface ChromaThemeInfo {
  id: ChromaThemeId;
  label: string;
  colors: readonly string[];
}

export const CHROMA_THEMES: Record<ChromaThemeId, ChromaThemeInfo> = {
  razer: {
    id: "razer",
    label: "Razer",
    colors: ["#00ff66", "#00b140", "#b6ff00"],
  },
  cyber: {
    id: "cyber",
    label: "赛博",
    colors: ["#00e5ff", "#7c4dff", "#ff2bd6"],
  },
  sunset: {
    id: "sunset",
    label: "日落",
    colors: ["#ff3d5a", "#ff8a00", "#ffd166"],
  },
  ocean: {
    id: "ocean",
    label: "海洋",
    colors: ["#003cff", "#00b8d9", "#64ffda"],
  },
  fire: {
    id: "fire",
    label: "烈焰",
    colors: ["#ff1800", "#ff7300", "#ffe600"],
  },
  aurora: {
    id: "aurora",
    label: "极光",
    colors: ["#20e3b2", "#4facfe", "#d946ef"],
  },
  white: { id: "white", label: "纯白", colors: ["#ffffff", "#d9e4ff"] },
  custom: { id: "custom", label: "自定义", colors: [] },
};

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface NormalizedAudio {
  spectrum: Float32Array;
  bass: number;
  mid: number;
  high: number;
  overall: number;
  beat: number;
  accent: number;
  flux: number;
}

interface ForegroundSample {
  color: string;
  coverage: number;
}

interface DevicePalette {
  theme: ChromaThemeId;
  customColors: readonly string[];
  background: string;
  beatFlash: boolean;
  intensity?: number;
  direction?: ChromaDirection;
}

const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const SPECTRUM_COLUMNS = 22;

const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.min(
    maximum,
    Math.max(minimum, Number.isFinite(value) ? value : minimum),
  );
const finite01 = (value: unknown) =>
  clamp(typeof value === "number" ? value : 0);
const wrap = (value: number) => ((value % 1) + 1) % 1;

export function parseColor(hex: unknown): RgbColor {
  if (typeof hex !== "string") return { ...BLACK };
  let normalized = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(normalized))
    normalized = normalized.replace(/./g, (character) => character + character);
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return { ...BLACK };
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function toHex(color: RgbColor): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function hsvColor(hue: number, saturation = 1, value = 1): string {
  const h = wrap(hue) * 6;
  const chroma = clamp(saturation) * clamp(value);
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const match = clamp(value) - chroma;
  const sectors: [number, number, number][] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [r, g, b] = sectors[Math.min(5, Math.floor(h))];
  return toHex({
    r: (r + match) * 255,
    g: (g + match) * 255,
    b: (b + match) * 255,
  });
}

export function packBgr(hex: string, brightness = 1): number {
  const color = parseColor(hex);
  const level = clamp(brightness, 0, 2);
  const red = Math.round(clamp(color.r * level, 0, 255));
  const green = Math.round(clamp(color.g * level, 0, 255));
  const blue = Math.round(clamp(color.b * level, 0, 255));
  return ((blue << 16) | (green << 8) | red) >>> 0;
}

export function interpolateColor(
  from: string,
  to: string,
  amount: number,
): string {
  const first = parseColor(from);
  const second = parseColor(to);
  const t = clamp(amount);
  return toHex({
    r: first.r + (second.r - first.r) * t,
    g: first.g + (second.g - first.g) * t,
    b: first.b + (second.b - first.b) * t,
  });
}

export function sampleTheme(
  theme: ChromaThemeId | string,
  amount: number,
  customColors?: readonly string[],
): string {
  const preset = CHROMA_THEMES[theme as ChromaThemeId] || CHROMA_THEMES.razer;
  const custom =
    customColors?.filter(
      (color) =>
        typeof color === "string" &&
        /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color),
    ) || [];
  const colors =
    preset.id === "custom" && custom.length > 0 ? custom : preset.colors;
  if (colors.length === 0) return "#000000";
  if (colors.length === 1) return toHex(parseColor(colors[0]));
  const position = clamp(amount) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(position));
  return interpolateColor(colors[index], colors[index + 1], position - index);
}

export function resampleSpectrum(
  input: ArrayLike<number> | null | undefined,
  columns = SPECTRUM_COLUMNS,
): Float32Array {
  const length = Math.max(
    1,
    Math.round(Number.isFinite(columns) ? columns : SPECTRUM_COLUMNS),
  );
  const output = new Float32Array(length);
  if (!input || input.length === 0) return output;
  if (input.length === 1) {
    output.fill(finite01(input[0]));
    return output;
  }
  const sanitized = Float32Array.from({ length: input.length }, (_, index) => finite01(input[index]));
  if (input.length === length) return sanitized;
  const power = Float32Array.from(sanitized, (value) => value * value);
  const redistributed = rebinSpectrumPower(power, length, createLogBandEdges(input.length));
  for (let index = 0; index < length; index += 1)
    output[index] = clamp(Math.sqrt(redistributed[index]));
  // Preserve exact endpoint samples so a full-range sweep reaches both edge columns.
  output[0] = Math.max(output[0], sanitized[0]);
  output[length - 1] = Math.max(output[length - 1], sanitized[sanitized.length - 1]);
  return output;
}

function normalizeAudio(
  data: ChromaAudioData | null | undefined,
  sensitivity: number,
): NormalizedAudio {
  const gain = clamp(sensitivity, 0, 4);
  const spectrum = resampleSpectrum(data?.spectrum, SPECTRUM_COLUMNS);
  for (let index = 0; index < spectrum.length; index += 1)
    spectrum[index] = clamp(spectrum[index] * gain);
  return {
    spectrum,
    bass: clamp(finite01(data?.bass) * gain),
    mid: clamp(finite01(data?.mid) * gain),
    high: clamp(finite01(data?.high) * gain),
    overall: clamp(finite01(data?.overall) * gain),
    beat: clamp(finite01(data?.beat) * gain),
    accent: clamp(finite01(data?.accent) * gain),
    flux: clamp(finite01(data?.flux) * gain),
  };
}

function directionalPosition(
  column: number,
  columns: number,
  direction: ChromaDirection = "ltr",
): number {
  const position = columns <= 1 ? 0 : column / (columns - 1);
  if (direction === "mirror") return Math.abs(position * 2 - 1);
  if (direction === "center") return 1 - Math.abs(position * 2 - 1);
  return position;
}

function frequencyPosition(
  column: number,
  columns: number,
  direction: ChromaDirection,
  mirrored: boolean,
): number {
  const directed = directionalPosition(column, columns, direction);
  return mirrored ? Math.abs(directed * 2 - 1) : directed;
}

function groupedEnergy(
  spectrum: Float32Array,
  position: number,
  size: number,
): number {
  const center = position * (spectrum.length - 1);
  const radius = Math.max(0, Math.round((clamp(size, 1, 10) - 1) / 2));
  let total = 0;
  let weight = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const index = Math.round(center + offset);
    if (index >= 0 && index < spectrum.length) {
      const localWeight =
        radius === 0 ? 1 : 1 - Math.abs(offset) / (radius + 1);
      total += spectrum[index] * localWeight;
      weight += localWeight;
    }
  }
  return weight > 0 ? total / weight : 0;
}

function deterministicNoise(first: number, second: number, third = 0): number {
  const value =
    Math.sin(first * 12.9898 + second * 78.233 + third * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function backgroundSample(
  effect: ChromaBackgroundEffect,
  palette: DevicePalette,
  position: number,
  rowPosition: number,
  audio: NormalizedAudio,
  now: number,
  brightness: number,
  reactive: boolean,
): ForegroundSample {
  const localEnergy = groupedEnergy(audio.spectrum, position, 3);
  if (effect === "off" && !reactive) return { color: "#000000", coverage: 0 };

  let color = palette.background;
  let level = effect === "off" ? 0 : brightness;
  if (effect === "breath")
    level *= 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now / 850));
  if (effect === "wave") {
    color = sampleTheme(
      palette.theme,
      wrap(position + now / 4200),
      palette.customColors,
    );
    level *=
      0.25 +
      0.75 *
        (0.5 +
          0.5 * Math.sin(position * Math.PI * 4 - now / 260 + rowPosition));
  } else if (effect === "spectrum") {
    color = sampleTheme(palette.theme, position, palette.customColors);
    level *= 0.35 + localEnergy * 0.65;
  }
  if (
    effect === "static" &&
    parseColor(color).r + parseColor(color).g + parseColor(color).b === 0
  ) {
    color = sampleTheme(palette.theme, 0.45, palette.customColors);
  }
  if (reactive) {
    color =
      effect === "off"
        ? sampleTheme(palette.theme, position, palette.customColors)
        : color;
    level = clamp(
      level + brightness * (audio.overall * 0.55 + localEnergy * 0.45),
      0,
      brightness,
    );
  }
  return { color, coverage: clamp(level) };
}

function composeSample(
  background: ForegroundSample,
  foreground: ForegroundSample,
  beatFlash: number,
): string {
  const foregroundCoverage = clamp(foreground.coverage);
  const backgroundCoverage =
    clamp(background.coverage) * (1 - foregroundCoverage);
  const litForeground =
    beatFlash > 0
      ? interpolateColor(foreground.color, "#ffffff", beatFlash)
      : foreground.color;
  const withBackground = interpolateColor(
    "#000000",
    background.color,
    backgroundCoverage,
  );
  return interpolateColor(withBackground, litForeground, foregroundCoverage);
}

function spectrumForeground(
  style: KeyboardChromaSettings["style"],
  position: number,
  row: number,
  rows: number,
  energy: number,
  palette: DevicePalette,
  now: number,
  rotationSpeed: number,
): ForegroundSample {
  const litRows = energy * rows;
  const coverage =
    rows - row <= litRows
      ? 0.45 + energy * 0.55
      : Math.max(0, litRows - (rows - row - 1)) * 0.28;
  let color = sampleTheme(palette.theme, 0.5, palette.customColors);
  if (style === "spectrum-gradient" || style === "bars")
    color = sampleTheme(palette.theme, position, palette.customColors);
  if (style === "spectrum-cycle")
    color = hsvColor(position + (now / 5000) * rotationSpeed);
  return { color, coverage };
}

function keyboardForeground(
  settings: KeyboardChromaSettings,
  audio: NormalizedAudio,
  row: number,
  column: number,
  now: number,
  size: number,
  mirrored: boolean,
  rotationSpeed: number,
): ForegroundSample {
  const { rows, columns } = CHROMA_DEVICE_METADATA.keyboard;
  const position = frequencyPosition(
    column,
    columns,
    settings.direction,
    mirrored,
  );
  const spatialColumn = Math.round(position * (columns - 1));
  const rowPosition = rows <= 1 ? 0 : row / (rows - 1);
  const spectrumSize = settings.style === "bars" ? 1 : size;
  const energy =
    settings.style === "bars"
      ? audio.spectrum[Math.floor(position * Math.max(1, columns - 2))]
      : groupedEnergy(audio.spectrum, position, spectrumSize);
  const theme = (amount: number) =>
    sampleTheme(settings.theme, amount, settings.customColors);

  if (
    ["bars", "spectrum-cycle", "spectrum-static", "spectrum-gradient"].includes(
      settings.style,
    )
  ) {
    return spectrumForeground(
      settings.style,
      position,
      row,
      rows,
      energy,
      settings,
      now,
      rotationSpeed,
    );
  }
  if (settings.style === "wave") {
    const phase = position * Math.PI * 4 - now / 180 + row * 0.45;
    const width = 0.7 + size * 0.16;
    return {
      color: theme(
        wrap(position + (now / 2200) * Math.max(0.1, rotationSpeed)),
      ),
      coverage:
        (0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.sin(phase), 2 / width)) *
        (0.3 + audio.overall * 0.7),
    };
  }
  if (settings.style === "pulse") {
    const distance = Math.abs(position - wrap(now / 900));
    return {
      color: theme(position),
      coverage:
        clamp(1 - Math.min(distance, 1 - distance) * (9 - size * 0.55)) *
        (0.3 + Math.max(audio.beat, audio.overall) * 0.7),
    };
  }
  if (settings.style === "radial-pulse") {
    const x = (position - 0.5) * 1.8;
    const y = (rowPosition - 0.5) * 1.2;
    const radius = Math.sqrt(x * x + y * y);
    const ring = wrap(now / 1200);
    const width = 0.035 + size * 0.018;
    return {
      color: theme(clamp(radius)),
      coverage:
        Math.exp(-Math.pow(radius - ring, 2) / width) *
        (0.25 + Math.max(audio.overall, audio.beat) * 0.75),
    };
  }
  if (settings.style === "ripple") {
    const origin = settings.direction === "center" ? 0.5 : 0;
    const distance =
      Math.abs(position - origin) + Math.abs(rowPosition - 0.5) * 0.22;
    const radius = wrap(now / 1050);
    const width = 0.025 + size * 0.014;
    return {
      color: theme(clamp(distance)),
      coverage:
        Math.exp(-Math.pow(distance - radius, 2) / width) *
        clamp(audio.beat * 0.8 + audio.flux * 0.5),
    };
  }
  if (settings.style === "breath") {
    return {
      color: theme(wrap(position + (now / 5000) * rotationSpeed)),
      coverage:
        (0.15 + 0.85 * (0.5 + 0.5 * Math.sin(now / 700))) *
        (0.45 + audio.overall * 0.55),
    };
  }
  if (settings.style === "starlight") {
    const cell = row * columns + column;
    const cycle = Math.floor(now / 700);
    const hash = deterministicNoise(cell, cycle);
    const phase = (now % 700) / 700;
    return {
      color: theme((hash * 3.17) % 1),
      coverage:
        hash > 0.82 - size * 0.006
          ? Math.sin(phase * Math.PI) * (0.55 + audio.high * 0.45)
          : 0.015,
    };
  }
  if (settings.style === "fire") {
    const height = 1 - rowPosition;
    const flicker = deterministicNoise(
      spatialColumn,
      Math.floor(now / 90),
      row,
    );
    const flame = clamp(
      (audio.bass * 0.7 + audio.overall * 0.3) * (1.35 - height) +
        (flicker - 0.5) * 0.38 -
        height * (0.65 + 0.04 * (10 - size)),
    );
    return {
      color: interpolateColor(
        "#ff1600",
        "#ffe45c",
        clamp(height + flicker * 0.35),
      ),
      coverage: flame,
    };
  }
  if (settings.style === "rain") {
    const laneSeed = deterministicNoise(spatialColumn, 17);
    const speed = 0.45 + deterministicNoise(spatialColumn, 29) * 0.65;
    const drop = wrap((now / 1100) * speed + laneSeed);
    const distance = Math.abs(rowPosition - drop);
    const trail = clamp(1 - distance / (0.06 + size * 0.025));
    const drive = clamp(audio.high * 0.7 + audio.flux * 0.8);
    return {
      color: theme(wrap(position + drop * 0.25)),
      coverage: trail * (0.15 + drive * 0.85),
    };
  }
  if (settings.style === "vu-meter") {
    const meterPosition = position;
    const level = clamp(
      audio.overall * 0.6 + audio.bass * 0.25 + audio.mid * 0.15,
    );
    const active = meterPosition <= level ? 0.75 + level * 0.25 : 0;
    return {
      color: theme(clamp(meterPosition * 0.85 + rowPosition * 0.15)),
      coverage: active,
    };
  }
  return { color: theme(0.5), coverage: 0.45 + audio.overall * 0.55 };
}

function keyboardFrame(
  settings: KeyboardChromaSettings,
  audio: NormalizedAudio,
  now: number,
  config: ChromaSettings,
): Uint32Array {
  const { rows, columns } = CHROMA_DEVICE_METADATA.keyboard;
  const output = new Uint32Array(rows * columns);
  const beatFlash = settings.beatFlash
    ? clamp(audio.beat * 0.7 + audio.accent * 0.3) * 0.65
    : 0;
  const intensity = clamp(settings.intensity ?? 1, 0, 2);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const position = frequencyPosition(
        column,
        columns,
        settings.direction,
        config.spectrumMirrored === true,
      );
      const foreground = keyboardForeground(
        settings,
        audio,
        row,
        column,
        now,
        config.size,
        config.spectrumMirrored === true,
        config.colorRotationSpeed,
      );
      foreground.coverage = clamp(foreground.coverage * intensity);
      const background = backgroundSample(
        config.backgroundEffect,
        settings,
        position,
        row / (rows - 1),
        audio,
        now,
        config.backgroundBrightness,
        config.reactiveBackground,
      );
      output[row * columns + column] = packBgr(
        composeSample(background, foreground, beatFlash),
        config.brightness,
      );
    }
  }
  return output;
}

function peripheralFrame(
  device: Exclude<ChromaDeviceType, "keyboard">,
  settings: PeripheralChromaSettings,
  audio: NormalizedAudio,
  now: number,
  config: ChromaSettings,
): Uint32Array {
  const { rows, columns } = CHROMA_DEVICE_METADATA[device];
  const output = new Uint32Array(rows * columns);
  const beatFlash = settings.beatFlash
    ? clamp(audio.beat * 0.6 + audio.accent * 0.4) * 0.65
    : 0;
  const direction = settings.direction ?? "ltr";
  const deviceIntensity = clamp(settings.intensity ?? 1, 0, 2);
  for (let index = 0; index < output.length; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const position = frequencyPosition(
      column,
      columns,
      direction,
      config.spectrumMirrored === true,
    );
    let colorPosition = position;
    let coverage: number;
    if (settings.style === "spectrum") {
      coverage = groupedEnergy(audio.spectrum, position, config.size);
    } else if (settings.style === "wave") {
      colorPosition = wrap(
        position + (now / 1800) * Math.max(0.1, config.colorRotationSpeed),
      );
      coverage =
        (0.2 +
          0.8 * (0.5 + 0.5 * Math.sin(position * Math.PI * 3 - now / 170))) *
        (0.35 + audio.overall * 0.65);
    } else if (settings.style === "pulse") {
      coverage = clamp(
        audio.overall * 0.55 + audio.beat * 0.75 + audio.flux * 0.35,
      );
      colorPosition = wrap(position + audio.bass * 0.25);
    } else if (settings.style === "breath") {
      coverage =
        (0.12 + 0.88 * (0.5 + 0.5 * Math.sin(now / 760))) *
        (0.5 + audio.mid * 0.5);
    } else {
      coverage = 0.5 + audio.overall * 0.5;
      colorPosition = 0.5;
    }
    const foreground = {
      color: sampleTheme(settings.theme, colorPosition, settings.customColors),
      coverage: clamp(coverage * deviceIntensity),
    };
    const background = backgroundSample(
      config.backgroundEffect,
      settings,
      position,
      rows <= 1 ? 0 : row / (rows - 1),
      audio,
      now,
      config.backgroundBrightness,
      config.reactiveBackground,
    );
    output[index] = packBgr(
      composeSample(background, foreground, beatFlash),
      config.brightness,
    );
  }
  return output;
}

function idleFrames(settings: ChromaSettings, now: number): ChromaFrames {
  const frames = {} as ChromaFrames;
  const level =
    settings.idleMode === "breathing"
      ? 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(now / 900))
      : 0.22;
  for (const device of CHROMA_DEVICE_TYPES) {
    const deviceSettings = settings[device];
    const size =
      CHROMA_DEVICE_METADATA[device].rows *
      CHROMA_DEVICE_METADATA[device].columns;
    const frame = new Uint32Array(size);
    if (settings.idleMode !== "off" && deviceSettings.enabled) {
      const color = sampleTheme(
        deviceSettings.theme,
        0.45,
        deviceSettings.customColors,
      );
      frame.fill(
        packBgr(
          color,
          clamp(settings.brightness, 0, 2) *
            level *
            clamp(deviceSettings.intensity ?? 1, 0, 2),
        ),
      );
    }
    frames[device] = frame;
  }
  return frames;
}

function releasedFrames(): ChromaFrames {
  return {
    keyboard: null,
    mouse: null,
    mousepad: null,
    headset: null,
    keypad: null,
    chromalink: null,
  };
}

function smoothAudio(
  target: NormalizedAudio,
  current: NormalizedAudio,
  decay: number,
  smoothing: number,
  dtSeconds: number,
) {
  const normalizedSmoothing = clamp(smoothing);
  const speed = (clamp(decay, 1, 10) - 1) / 9;
  const damping = 1 - normalizedSmoothing * 0.82;
  const attackPerFrame =
    normalizedSmoothing === 0 ? 1 : (0.16 + speed * 0.78) * damping;
  const releasePerFrame =
    normalizedSmoothing === 0 ? 1 : (0.035 + speed * 0.62) * damping;
  const frameScale = Math.max(0.001, Math.min(0.25, dtSeconds)) * 30;
  const attack = 1 - Math.pow(1 - clamp(attackPerFrame), frameScale);
  const release = 1 - Math.pow(1 - clamp(releasePerFrame), frameScale);
  const follow = (value: number, next: number) =>
    value + (next - value) * (next >= value ? attack : release);
  for (let index = 0; index < SPECTRUM_COLUMNS; index += 1)
    current.spectrum[index] = follow(
      current.spectrum[index],
      target.spectrum[index],
    );
  current.bass = follow(current.bass, target.bass);
  current.mid = follow(current.mid, target.mid);
  current.high = follow(current.high, target.high);
  current.overall = follow(current.overall, target.overall);
  current.beat = follow(current.beat, target.beat);
  current.accent = follow(current.accent, target.accent);
  current.flux = follow(current.flux, target.flux);
}

function emptyAudio(): NormalizedAudio {
  return {
    spectrum: new Float32Array(SPECTRUM_COLUMNS),
    bass: 0,
    mid: 0,
    high: 0,
    overall: 0,
    beat: 0,
    accent: 0,
    flux: 0,
  };
}

export function createChromaStyleEngine(): ChromaStyleEngine {
  const smoothed = emptyAudio();
  let lastNow: number | null = null;

  return {
    render(
      data,
      settings,
      options: ChromaRenderOptions = {},
    ): ChromaRenderResult {
      const now = Number.isFinite(options.now) ? options.now! : Date.now();
      const dtSeconds = lastNow === null ? 1 / 30 : Math.max(0.001, Math.min(0.25, (now - lastNow) / 1000));
      lastNow = now;
      const idle =
        options.paused === true ||
        options.idle === true ||
        (options.hidden === true && !settings.runInBackground);
      if (idle) {
        if (settings.idleMode === "release")
          return { action: "release", frames: releasedFrames() };
        return { action: "frame", frames: idleFrames(settings, now) };
      }

      const target = normalizeAudio(data, settings.sensitivity);
      smoothAudio(
        target,
        smoothed,
        settings.decay ?? 6,
        settings.smoothing,
        dtSeconds,
      );
      const effectiveSettings: ChromaSettings = {
        ...settings,
        brightness: clamp(settings.brightness, 0, 2),
        decay: clamp(settings.decay ?? 6, 1, 10),
        size: clamp(settings.size ?? 3, 1, 10),
        colorRotationSpeed: clamp(settings.colorRotationSpeed ?? 0.65, 0, 2),
        backgroundEffect: settings.backgroundEffect ?? "off",
        backgroundBrightness: clamp(
          settings.backgroundBrightness ?? 0.18,
          0.01,
          1,
        ),
        reactiveBackground: settings.reactiveBackground === true,
        spectrumMirrored: settings.spectrumMirrored === true,
      };
      const frames = {} as ChromaFrames;
      for (const device of CHROMA_DEVICE_TYPES) {
        const deviceSettings = settings[device];
        if (!deviceSettings.enabled) {
          frames[device] = new Uint32Array(
            CHROMA_DEVICE_METADATA[device].rows *
              CHROMA_DEVICE_METADATA[device].columns,
          );
        } else if (device === "keyboard") {
          frames.keyboard = keyboardFrame(
            settings.keyboard,
            smoothed,
            now,
            effectiveSettings,
          );
        } else {
          frames[device] = peripheralFrame(
            device,
            settings[device],
            smoothed,
            now,
            effectiveSettings,
          );
        }
      }
      return { action: "frame", frames };
    },
    reset() {
      lastNow = null;
      smoothed.spectrum.fill(0);
      smoothed.bass = 0;
      smoothed.mid = 0;
      smoothed.high = 0;
      smoothed.overall = 0;
      smoothed.beat = 0;
      smoothed.accent = 0;
      smoothed.flux = 0;
    },
  };
}

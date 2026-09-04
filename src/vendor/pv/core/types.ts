// PV Tool — Copyright (c) 2026 DanteAlighieri13210914
// Licensed under Non-Commercial License. See LICENSE for terms.

export type LayerType = 'background' | 'decoration' | 'media' | 'text' | 'overlay';

export interface ColorPalette {
  background: string;
  primary: string;
  secondary: string;
  accent: string;
  text: string;
}

export interface EffectEntry {
  type: string;
  layer: LayerType;
  config: Record<string, any>;
}

export interface TemplateConfig {
  name: string;
  nameKey?: string;
  palette: ColorPalette;
  effects: EffectEntry[];
  bpm?: number;
  animationSpeed?: number;
  bgOpacity?: number;
  postfx?: {
    shake?: number;
    zoom?: number;
    tilt?: number;
    glitch?: number;
    hueShift?: number;
  };
  features?: {
    mediaOutline?: boolean;
    autoExtractColors?: boolean;
    motionDetection?: boolean;
    invertMedia?: boolean;
    thresholdMedia?: boolean;
  };
}

export interface MotionTargetInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

export interface UpdateContext {
  time: number;
  deltaTime: number;
  fps: number;
  /** Seconds elapsed since the current text segment / lyric line started */
  segmentTime: number;
  screenWidth: number;
  screenHeight: number;
  palette: ColorPalette;
  animationSpeed: number;
  motionIntensity: number;
  currentText: string;
  beatIntensity: number;
  motionTargets: MotionTargetInfo[];
  /** WaveForge 扩展：当前行逐字演唱进度 0~1（无逐字时间戳时为 undefined） */
  wordProgress?: number;
  /** WaveForge 扩展：当前行逐字时间戳（绝对秒制；overlay 用真实时间驱动逐词动画） */
  words?: LyricWordTiming[];
  /** WaveForge 扩展：当前行起点（绝对秒；无逐字时合成词级时间戳用） */
  lineStart?: number;
  /** WaveForge 扩展：当前行时长（秒；无逐字时合成词级时间戳用） */
  lineDuration?: number;
  /** WaveForge 扩展：当前段落强度 0~1（镜头推近/逐字视觉动态用） */
  intensity?: number;
  /** WaveForge 扩展：当前行翻译文本 */
  translation?: string;
  /** WaveForge 扩展：当前行罗马音文本 */
  roman?: string;
}

export interface Beat {
  time: number;
  type: 'kick' | 'snare' | 'accent';
}

export interface LyricChar {
  text: string;
  startTime: number;
  endTime: number;
}

export interface LyricPhrase {
  chars: LyricChar[];
  startTime: number;
  endTime: number;
}

/** 逐字时间戳（WaveForge 扩展）：绝对秒制 */
export interface LyricWordTiming {
  text: string;
  time: number;
  endTime: number;
}

export interface LyricLine {
  time: number;
  text: string;
  /** WaveForge 扩展：逐字时间戳（绝对秒制） */
  words?: LyricWordTiming[];
  /** WaveForge 扩展：当前行翻译 */
  translation?: string;
  /** WaveForge 扩展：当前行罗马音 */
  roman?: string;
  agentId?: string;
  alternateTexts?: Array<{ role: string; language?: string; text: string }>;
  backgroundVocals?: Array<{
    time: number;
    endTime: number;
    text: string;
    agentId?: string;
    translation?: string;
    roman?: string;
    words?: LyricWordTiming[];
  }>;
}

export interface Segment {
  type: 'verse' | 'chorus' | 'bridge';
  startTime: number;
  endTime: number;
}

export interface MusicData {
  bpm: number;
  beats: Beat[];
  lyrics: LyricPhrase[];
  segments: Segment[];
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function resolveColor(color: string, palette: ColorPalette): string {
  if (color === '$line') {
    return luminance(palette.background) > 0.55 ? '#999999' : '#ffffff';
  }
  if (color.startsWith('$')) {
    const key = color.slice(1) as keyof ColorPalette;
    return palette[key] || '#000000';
  }
  return color;
}
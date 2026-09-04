// PV Tool — Copyright (c) 2026 DanteAlighieri13210914
// Licensed under Non-Commercial License. See LICENSE for terms.
//
// wfLyricOverlay —— WaveForge 专属扩展特效（非原版文件）。
//
// v2：凝彩（folia tempera）式逐词动画歌词层，学习其确定性逐词编排机制：
// - 词级粒度：每词独立 PIXI.Text，按真实逐字时间戳（ctx.words，绝对秒）驱动，
//   不依赖词内推导 —— seek/暂停后依然精确
// - 7 种确定性入场（left/right/above/below/swing/stamp/fade），seed 由词文本派生，
//   相邻词不同，整句呈「被拼上去」的剪辑感（凝彩同一设计）
// - elastic 弹入 + 入场晚窗随句长伸缩（SETTLE_STRETCH=0.5），唱完前落位
// - 已唱词高亮（accent + glow），唱完 release：以块心为基准缓慢拉开字距（刚性外扩）
// - beat 加成：入场位移与已唱缩放随节拍强度放大
// - 无逐字时间戳的歌词回退为整行淡入
//
// 通过引擎 addEffect() 挂到 overlay 层，不修改任何原模板或原特效。

import * as PIXI from 'pixi.js';
import { BaseEffect } from './base';
import type { UpdateContext, LyricWordTiming } from '../core/types';
import { resolveColor } from '../core/types';

const DEFAULT_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

type EnterKind = 'left' | 'right' | 'above' | 'below' | 'swing' | 'stamp' | 'fade';
const ENTER_KINDS: EnterKind[] = ['left', 'right', 'above', 'below', 'swing', 'stamp', 'fade'];

interface GlyphWord {
  obj: PIXI.Text;
  width: number;
  start: number;       // 绝对秒：入场起点（= 该词唱起）
  endTime: number;     // 绝对秒：唱完
  enter: EnterKind;
  dirX: number;
  dirY: number;
  swingSign: number;
  homeX: number;
  homeY: number;
  sung: boolean;
  pure: boolean;       // 无逐字模式：整行静态词
}

/** elastic ease-out（与 bigOutlineText 同一公式） */
function elastic(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  return Math.pow(2, -10 * progress) * Math.sin((progress * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
}

/** 入场晚窗：0.34s + (句尾 − 词起 − 0.34) × 0.5（凝彩 SETTLE_STRETCH 语义），缓慢句子铺到深处 */
function settleWindow(wordStart: number, lineEnd: number): number {
  const win = 0.34 + (lineEnd - wordStart - 0.34) * 0.5;
  return Math.max(0.3, Math.min(1.3, win));
}

function hashSeed(text: string, index: number): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return (h + index * 2654435761) >>> 0;
}

export class WfLyricOverlay extends BaseEffect {
  readonly name = 'wfLyricOverlay';

  private mainRoot!: PIXI.Container;
  private words: GlyphWord[] = [];
  private translationObj!: PIXI.Text;
  private romanObj!: PIXI.Text;

  private cacheSig = '';
  private lineStart = 0;
  private lineEnd = 0;
  private lineDuration = 3;
  private blockCenterX = 0;
  private blockDirX = 0; // 行入场镜头方向（整块滑入，凝彩 flowDirection 简化版）
  private blockDirY = 0;

  protected setup(): void {
    this.mainRoot = new PIXI.Container();
    this.container.addChild(this.mainRoot);

    this.translationObj = new PIXI.Text({ text: '', style: this.subStyle('translation') });
    this.translationObj.anchor.set(0.5, 0);
    this.translationObj.alpha = 0.9;
    this.container.addChild(this.translationObj);

    this.romanObj = new PIXI.Text({ text: '', style: this.subStyle('roman') });
    this.romanObj.anchor.set(0.5, 0);
    this.romanObj.alpha = 0.6;
    this.container.addChild(this.romanObj);
  }

  private wordStyle(sung: boolean): PIXI.TextStyle {
    const color = resolveColor(this.config.color ?? '$text', this.palette);
    const sungColor = resolveColor(this.config.sungColor ?? '$accent', this.palette);
    return new PIXI.TextStyle({
      fontFamily: this.config.fontFamily ?? DEFAULT_FONT,
      fontSize: this.config.fontSize ?? 58,
      fontWeight: this.config.fontWeight ?? 'bold',
      fill: sung ? (this.config.sungBright ? '#ffffff' : sungColor) : color,
      stroke: { color: this.config.strokeColor ?? '#000000', width: (this.config.strokeWidth ?? 4) * (sung ? 1.2 : 0.8) },
      letterSpacing: this.config.letterSpacing ?? 2,
      dropShadow: sung && (this.config.glowOnSung ?? true)
        ? { color: coalesce(this.config.glowColor, this.palette.accent), blur: 14, distance: 0, alpha: 0.9 }
        : false,
    });
  }

  private subStyle(kind: 'translation' | 'roman'): PIXI.TextStyle {
    return new PIXI.TextStyle({
      fontFamily: this.config.fontFamily ?? DEFAULT_FONT,
      fontSize: kind === 'translation' ? (this.config.translationSize ?? 24) : (this.config.romanSize ?? 19),
      fontWeight: 'normal',
      fill: kind === 'translation' ? '#ffffff' : '#dde8ff',
      stroke: { color: '#000000', width: 3 },
      letterSpacing: 1,
    });
  }

  update(ctx: UpdateContext): void {
    const text = ctx.currentText ?? '';
    const sig = `${text}|${ctx.words?.length ?? 0}|${ctx.lineStart ?? -1}`;
    if (sig !== this.cacheSig) this.rebuild(text, ctx);

    // ── 逐词动画：真实时间驱动（无逐字时使用合成的词级时间戳）──
    if (this.words.length > 0) {
      const t = ctx.time;
      const beat = ctx.beatIntensity;
      const inten = ctx.intensity ?? 0.5;
      const dist = (this.config.enterDist ?? 100) * (1 + beat * 0.22) * (0.8 + inten * 0.4);
      for (const w of this.words) {
        const obj = w.obj;
        // 未开始
        if (t < w.start - 0.05) {
          obj.alpha = 0;
          continue;
        }
        const win = settleWindow(w.start, this.lineEnd);
        const p = (t - w.start) / win;
        const ep = elastic(Math.min(1, p));
        const rel = 1 - ep;

        obj.x = w.homeX + w.dirX * dist * rel;
        obj.y = w.homeY + w.dirY * dist * rel;
        obj.alpha = Math.min(1, Math.max(0, p * 3));
        if (w.enter === 'stamp') {
          obj.scale.set(0.4 + 0.6 * ep + beat * 0.03);
        } else if (w.enter === 'swing') {
          obj.rotation = rel * 0.35 * w.swingSign;
          obj.scale.set(1 + beat * 0.03);
        } else {
          obj.scale.set(1 + beat * 0.03);
        }

        // 已唱：高亮 + release 字距外扩（以块心为基准，刚性平行展开）
        const sung = t >= w.endTime;
        if (sung !== w.sung) {
          w.sung = sung;
          obj.style = this.wordStyle(sung);
        }
        if (sung) {
          const relTime = Math.min(1, (t - w.endTime) / Math.max(0.5, this.lineDuration * 0.26));
          const spread = (this.config.releaseSpread ?? 0.055) * relTime;
          obj.x = w.homeX + (w.homeX - this.blockCenterX) * spread;
          obj.y = w.homeY + (w.homeY - 0) * spread * 0.7;
        }
      }
    }

    // ── 整体落位（镜头化）：行入场整块滑入 + 段落强度推近/上移 + 翻译/罗马音副文本 ──
    const inten = ctx.intensity ?? 0.5;
    const slide = Math.max(0, 1 - ctx.segmentTime * 2.2);
    const yBase = (this.config.y ?? 0.76) * ctx.screenHeight
      + this.blockDirY * slide * 55
      + (inten - 0.5) * ctx.screenHeight * 0.04;
    this.mainRoot.y = yBase;
    this.mainRoot.x = this.blockDirX * slide * 90;

    const showTranslation = this.config.showTranslation ?? true;
    const showRoman = this.config.showRoman ?? false;
    this.translationObj.visible = showTranslation && !!ctx.translation;
    if (showTranslation && ctx.translation) {
      this.translationObj.text = ctx.translation;
      this.translationObj.style = this.subStyle('translation');
      this.translationObj.x = ctx.screenWidth / 2;
      this.translationObj.y = yBase + (this.config.fontSize ?? 58) * 1.05 + 6;
    }
    this.romanObj.visible = showRoman && !!ctx.roman;
    if (showRoman && ctx.roman) {
      this.romanObj.text = ctx.roman;
      this.romanObj.style = this.subStyle('roman');
      this.romanObj.x = ctx.screenWidth / 2;
      this.romanObj.y = yBase + (this.config.fontSize ?? 58) * 1.05 + (showTranslation && ctx.translation ? 32 : 6);
    }
  }

  private rebuild(text: string, ctx: UpdateContext): void {
    this.cacheSig = `${text}|${ctx.words?.length ?? 0}|${ctx.lineStart ?? -1}`;
    for (const w of this.words) {
      try { w.obj.destroy(); } catch { /* already destroyed */ }
    }
    this.words = [];
    this.mainRoot.removeChildren();

    if (!text) return;

    const fontSize = this.config.fontSize ?? 58;
    const maxW = ctx.screenWidth * 0.92;

    // 逐字时间戳存在 → 用真实时间；否则用分词 + 行时长等分合成（凝彩
    // buildLineGraphemeTimeline 的思路：无逐字歌也要有逐词动画，绝不退化整行静态）
    const rawWords = (ctx.words && ctx.words.length > 0)
      ? ctx.words
      : synthWordTimings(text, ctx);

    this.lineStart = rawWords[0].time;
    this.lineEnd = rawWords[rawWords.length - 1].endTime;
    this.lineDuration = Math.max(0.6, this.lineEnd - this.lineStart);

    // 布局：词排一行，超宽换行；home 位置带块心
    const items: { word: GlyphWord; x: number; row: number }[] = [];
    let row = 0;
    let x = 0;
    const lineHeight = fontSize * 1.14;

    rawWords.forEach((w, idx) => {
      const enter = ENTER_KINDS[hashSeed(w.text, idx) % ENTER_KINDS.length];
      const dir = enterVector(enter, hashSeed(w.text, idx));
      const obj = new PIXI.Text({ text: w.text, style: this.wordStyle(false) });
      obj.anchor.set(0, 0.5);
      obj.alpha = 0;
      if (x + obj.width > maxW && x > 0) {
        row++;
        x = 0;
      }
      obj.position.set(x, row * lineHeight);
      this.mainRoot.addChild(obj);
      items.push({
        word: {
          obj,
          width: obj.width,
          start: w.time,
          endTime: w.endTime,
          enter,
          dirX: dir.x,
          dirY: dir.y,
          swingSign: dir.sign,
          homeX: 0,
          homeY: 0,
          sung: false,
          pure: false,
        },
        x,
        row,
      });
      x += obj.width + (this.config.wordSpacing ?? 10);
    });

    // 计算各行宽度取最宽行 → 块心横坐标（居中基准）
    const rowWidths = new Map<number, number>();
    for (const it of items) {
      rowWidths.set(it.row, (rowWidths.get(it.row) ?? 0) + it.word.width + (this.config.wordSpacing ?? 10));
    }
    const rows = [...rowWidths.keys()].sort((a, b) => a - b);
    const rowCount = rows.length || 1;
    const maxRowW = Math.max(...rowWidths.values(), 0);
    this.blockCenterX = maxRowW / 2;
    const blockHeight = rowCount * lineHeight;

    for (const it of items) {
      const w = it.word;
      w.homeX = it.x + w.width / 2 - maxRowW / 2 + ctx.screenWidth / 2;
      w.homeY = it.row * lineHeight + lineHeight / 2 - blockHeight / 2;
      w.obj.x = w.homeX;
      w.obj.y = w.homeY;
      this.words.push(w);
    }
    this.blockCenterX = ctx.screenWidth / 2;

    // 行入场镜头方向：由行内容 seed 派生（左右上下交替，字幕如同被镜头带入场内）
    const dirSeed = hashSeed(text, 0x51ab);
    const dirIdx = dirSeed % 4;
    this.blockDirX = dirIdx === 0 ? -1 : dirIdx === 1 ? 1 : 0;
    this.blockDirY = dirIdx === 2 ? -1 : dirIdx === 3 ? 1 : 0;
  }
}

/** 分词：Intl.Segmenter 词边界优先，fallback 到正则；用于无逐字时的词级时间戳合成 */
function splitWords(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const seg = new Intl.Segmenter('zh', { granularity: 'word' });
      const parts = [...seg.segment(text)]
        .filter(s => s.isWordLike && s.segment.trim().length > 0)
        .map(s => s.segment);
      if (parts.length > 0) return parts;
    } catch { /* fall through */ }
  }
  const matches = text.match(/[^\s，。！？、；：""''（）【】《》…—·]+/g);
  return matches && matches.length > 0 ? matches : (text.length > 0 ? [text] : []);
}

/** 词的字重：CJK 逐字计入、拉丁按词本身计数（近似等分） */
function wordWeight(word: string): number {
  let w = 0;
  for (const ch of word) {
    w += /[\u3040-\u30ff\u4e00-\u9fff]/.test(ch) ? 1 : 0.4;
  }
  return Math.max(0.6, w);
}

/** 无逐字时合成词级时间戳：行时长按词字重比例等分 */
function synthWordTimings(text: string, ctx: UpdateContext): LyricWordTiming[] {
  const lineStart = ctx.lineStart ?? 0;
  const duration = Math.max(0.8, ctx.lineDuration ?? 3);
  const words = splitWords(text);
  if (words.length === 0) return [{ text, time: lineStart, endTime: lineStart + duration }];
  const total = words.reduce((s, w) => s + wordWeight(w), 0);
  let acc = lineStart;
  return words.map(w => {
    const d = (duration * wordWeight(w)) / total;
    const out = { text: w, time: acc, endTime: acc + d };
    acc += d;
    return out;
  });
}

function enterVector(kind: EnterKind, seed: number): { x: number; y: number; sign: number } {
  const sign = seed % 2 === 0 ? 1 : -1;
  switch (kind) {
    case 'left': return { x: -1, y: 0, sign };
    case 'right': return { x: 1, y: 0, sign };
    case 'above': return { x: 0, y: -1, sign };
    case 'below': return { x: 0, y: 1, sign };
    case 'swing': return { x: 0.82 * sign, y: -0.55, sign };
    case 'stamp': return { x: 0, y: 0, sign };
    case 'fade': return { x: 0, y: 0, sign };
  }
}

function coalesce(a: unknown, b: string): string {
  return typeof a === 'string' && a.length > 0 ? a : b;
}
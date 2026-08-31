import * as THREE from 'three';

// src/components/visualizer/diorama/dioramaTextRaster.ts
// Canvas-rasterised lyric text for the diorama's 3D planes.
//
// WHY canvas and not an SDF text engine: CJK fonts build glyphs from OVERLAPPING stroke contours
// (unified by the fill winding rule). troika's GPU SDF generator mishandles those overlaps, drawing
// visible seams and translucent slabs inside every dense glyph - unfixable by resolution. The
// browser's own canvas text rasteriser is the same engine that renders the DOM subtitles: perfect
// shaping for every script, and it consumes the project's full CSS font STACK (theme font style,
// weight, the user's uploaded custom font, per-glyph fallback) via resolveThemeFontStack - so the 3D
// lyrics inherit the shared subtitle font settings exactly, with no single-font-file limitation.
//
// Each unit (CJK char / latin word) is rasterised TWICE into one shared canvas geometry:
// - base: the plain glyph (white - tinted per-frame by the material colour), and
// - glow: the glyph lit with cadenza (心象)'s drawShadowGlowText recipe (three stacked blurred
//   copies, composited 'lighter'), also white so the theme accent tints it live.
// Both rasters use the same canvas size and draw position, so the glow registers on the strokes
// EXACTLY, by construction - centring/misalignment is impossible (this is what fixes the interlude
// dot ● glow sitting high: the glow IS the blurred dot).

/** 栅格 em 尺寸：128→192，字形更细腻（高分屏/长行缩放后不发虚）。
 * 注意：DioramaScene / FoliaDioramaLyrics 里所有 /128 的世界尺寸换算都已改用本常量。 */
export const DIORAMA_RASTER_FONT_PX = 192;
// 字重 900（黑体最重档）：用户要求"厚"——700 细了，CJK 在 900 下笔画实、3D 切片观感厚实
const DEFAULT_FONT_WEIGHT = 900;
// Vertical band around the middle baseline (covers ascenders/descenders across fonts).
const LINE_BAND_EM = 1.4;
// Padding for the glow spread (must contain the widest shadow blur below plus ink overshoot).
const GLOW_PAD_EM = 0.7;
// Plain line rasters (neighbour lines, no glow) need only a small ink-overshoot pad.
const PLAIN_PAD_EM = 0.2;
// Stay under the guaranteed-safe texture edge for long lines.
const MAX_CANVAS_PX = 4096;
// Inner shadow blur as a fraction of the em; cadenza's 20/40/58px ladder scaled to the raster em.
const GLOW_BLUR_EM = 0.16;

// `fontStack` is the CSS font-family stack from resolveThemeFontStack(theme) - resolved by the
// caller so rasters only rebuild when the actual font selection changes, not on every theme tweak.
export const buildDioramaFontSpec = (fontStack: string, fontWeight = DEFAULT_FONT_WEIGHT): string =>
    `${fontWeight} ${DIORAMA_RASTER_FONT_PX}px ${fontStack}`;

let measureCtx: CanvasRenderingContext2D | null = null;
const getMeasureCtx = (): CanvasRenderingContext2D => {
    if (!measureCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        measureCtx = canvas.getContext('2d')!;
    }
    return measureCtx;
};

/** Advance width in raster px of `text` under the diorama font spec (kerning included). */
export const measureDioramaText = (text: string, fontSpec: string): number => {
    const ctx = getMeasureCtx();
    ctx.font = fontSpec;
    return ctx.measureText(text).width;
};

const makeTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    texture.colorSpace = THREE.SRGBColorSpace;
    // 透明画布纹理禁用 mipmap：mip 会把透明的黑像素平均进字形边缘，缩小采样时出现黑边/暗晕。
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return texture;
};

// Bakes a PURE HALO of the glyph (cadenza's blur ladder: tight core / mid halo / faint outer air) at
// FULL strength - live intensity/colour come from the additive material's opacity/colour per frame.
//
// Why not cadenza's exact fill alphas: a canvas shadow inherits its source shape's alpha, so
// cadenza's faint fills (0.11 x 0.86 shadow ≈ 0.09 alpha per pass) only work because the DOM canvas
// REDRAWS and accumulates them every frame. Baked once into a texture, that halo peaks near-invisible
// (~0.2 alpha, then multiplied by the runtime opacity). So here the glyph is drawn OFF-canvas with a
// large shadow offset - only its blurred shadow lands on the texture, at full source alpha - giving a
// strong, crisp-fill-free halo that spreads purely outward from the strokes.
const drawGlowGlyph = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, blur: number) => {
    const OFFSCREEN = 10000;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    const haloPass = (passBlur: number, alpha: number) => {
        ctx.shadowColor = `rgba(255,255,255,${alpha})`;
        ctx.shadowBlur = passBlur;
        ctx.shadowOffsetX = OFFSCREEN;
        ctx.shadowOffsetY = 0;
        ctx.fillText(text, x - OFFSCREEN, y);
    };
    haloPass(blur, 0.95);
    haloPass(blur, 0.85);
    haloPass(blur * 2, 0.55);
    haloPass(blur * 2.9, 0.3);
    ctx.restore();
};

export interface DioramaUnitRaster {
    baseTexture: THREE.CanvasTexture;
    glowTexture: THREE.CanvasTexture;
    /** Full canvas extent in raster px (the plane's intrinsic size before world scaling). */
    canvasWidthPx: number;
    canvasHeightPx: number;
    /** Typographic advance of the unit in raster px (for layout). */
    advancePx: number;
}

// ─── 栅格化结果 LRU 缓存 ──────────────────────────────────────────────────────────────────
// 每次活动行切换都会重栅格所有 unit（base + glow 两张纹理），邻居行滚入视野时也会重栅格整行
// 文本——同一文本反复栅格化是热路径上的纯浪费。按 (fontSpec, text) 缓存共享 CanvasTexture：
//   - 命中：直接返回已有纹理，零栅格零上传；
//   - 未命中：栅格 + 上传 + 入缓存；
//   - unit / line 共用一个 GPU 字节预算，避免两个按条数缓存叠加后常驻数千张纹理；
//   - LRU 满载驱逐时立即 dispose 纹理。
// CanvasTexture 关闭了 mipmap，按上传后的 RGBA8（宽 × 高 × 4）估算显存。浏览器和驱动
// 可能另有对齐开销，因此这是稳定、偏保守的预算单位，而非精确的驱动显存统计。
export const DIORAMA_RASTER_CACHE_MAX_BYTES = 128 * 1024 * 1024;
export const DIORAMA_RASTER_CACHE_IDLE_BYTES = 8 * 1024 * 1024;

type RasterValue = DioramaUnitRaster | DioramaLineRaster;

interface RasterCacheEntry<T extends RasterValue = RasterValue> {
    value: T;
    byteSize: number;
    fontKey: string;
}

const disposeRaster = (raster: RasterValue): void => {
    if ('baseTexture' in raster) {
        raster.baseTexture.dispose();
        raster.glowTexture.dispose();
    } else {
        raster.texture.dispose();
    }
};

export class DioramaRasterLruCache {
    private readonly entries = new Map<string, RasterCacheEntry>();
    private _bytes = 0;

    constructor(private maxBytes: number) {}

    get size(): number { return this.entries.size; }
    get bytes(): number { return this._bytes; }
    get budgetBytes(): number { return this.maxBytes; }

    get<T extends RasterValue>(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value as T;
    }

    set<T extends RasterValue>(key: string, value: T, byteSize: number, fontKey: string): boolean {
        const normalizedBytes = Math.max(0, Math.ceil(byteSize));
        const previous = this.entries.get(key);
        if (previous) {
            this.entries.delete(key);
            this._bytes -= previous.byteSize;
            if (previous.value !== value) disposeRaster(previous.value);
        }
        if (normalizedBytes > this.maxBytes) {
            disposeRaster(value);
            return false;
        }
        this.entries.set(key, { value, byteSize: normalizedBytes, fontKey });
        this._bytes += normalizedBytes;
        this.trimTo(this.maxBytes);
        return true;
    }

    trimTo(maxBytes: number): void {
        const target = Math.max(0, Math.floor(maxBytes));
        while (this._bytes > target) {
            const oldestKey = this.entries.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            this.delete(oldestKey);
        }
    }

    retainFont(fontKey: string): void {
        for (const [key, entry] of this.entries) {
            if (entry.fontKey !== fontKey) this.delete(key);
        }
    }

    clear(): void {
        for (const key of Array.from(this.entries.keys())) this.delete(key);
    }

    setBudget(maxBytes: number): void {
        this.maxBytes = Math.max(0, Math.floor(maxBytes));
        this.trimTo(this.maxBytes);
    }

    private delete(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        this._bytes -= entry.byteSize;
        disposeRaster(entry.value);
    }
}

const rasterCache = new DioramaRasterLruCache(DIORAMA_RASTER_CACHE_MAX_BYTES);

const estimateTextureBytes = (width: number, height: number, textureCount: number): number =>
    Math.max(1, width) * Math.max(1, height) * 4 * textureCount;

const fontStackFromSpec = (fontSpec: string): string => {
    const separator = fontSpec.indexOf('px ');
    return separator >= 0 ? fontSpec.slice(separator + 3) : fontSpec;
};

/** Keep only rasters made with the current font and restore the active-mode budget. */
export const retainDioramaRasterFont = (fontKey: string): void => {
    rasterCache.setBudget(DIORAMA_RASTER_CACHE_MAX_BYTES);
    rasterCache.retainFont(fontKey);
};

/** Release all cached GPU textures, for explicit memory-pressure handling. */
export const clearDioramaRasterCache = (): void => rasterCache.clear();

/** Reduce an inactive Folia mode to a small optional hot set. Pass 0 for a full clear. */
export const shrinkDioramaRasterCache = (maxBytes = DIORAMA_RASTER_CACHE_IDLE_BYTES): void => {
    rasterCache.setBudget(maxBytes);
};

export const getDioramaRasterCacheStats = (): Readonly<{ entries: number; bytes: number; budgetBytes: number }> => ({
    entries: rasterCache.size,
    bytes: rasterCache.bytes,
    budgetBytes: rasterCache.budgetBytes,
});

/** Rasterise one lyric unit (base + glow layers share one canvas geometry). */
export const rasterDioramaUnit = (text: string, fontSpec: string): DioramaUnitRaster => {
    const key = `u\u0000${fontSpec}\u0000${text}`;
    const cached = rasterCache.get<DioramaUnitRaster>(key);
    if (cached) return cached;
    const raster = rasterDioramaUnitUncached(text, fontSpec);
    rasterCache.set(
        key,
        raster,
        estimateTextureBytes(raster.canvasWidthPx, raster.canvasHeightPx, 2),
        fontStackFromSpec(fontSpec),
    );
    return raster;
};

const rasterDioramaUnitUncached = (text: string, fontSpec: string): DioramaUnitRaster => {
    const em = DIORAMA_RASTER_FONT_PX;
    const pad = Math.ceil(em * GLOW_PAD_EM);
    const advancePx = Math.max(1, Math.ceil(measureDioramaText(text, fontSpec)));
    const canvasWidthPx = advancePx + pad * 2;
    const canvasHeightPx = Math.ceil(em * LINE_BAND_EM) + pad * 2;
    const drawX = pad;
    const drawY = canvasHeightPx / 2;

    const draw = (paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture => {
        const canvas = document.createElement('canvas');
        canvas.width = canvasWidthPx;
        canvas.height = canvasHeightPx;
        const ctx = canvas.getContext('2d')!;
        ctx.font = fontSpec;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        paint(ctx);
        return makeTexture(canvas);
    };

    const baseTexture = draw((ctx) => {
        // 无阴影（用户要求）：不再画右下偏移的暗色影子——立体感交给场景的 Z 轴厚度切片
        // （back/side 暗色副本）与表面渐变承担；字形保持干净，只有受光面
        const surface = ctx.createLinearGradient(0, canvasHeightPx * 0.3, 0, canvasHeightPx * 0.72);
        surface.addColorStop(0, '#ffffff');
        surface.addColorStop(0.5, '#f3f5fa');
        surface.addColorStop(1, '#c4cbe0');
        ctx.fillStyle = surface;
        ctx.fillText(text, drawX, drawY);
    });
    const glowTexture = draw((ctx) => {
        drawGlowGlyph(ctx, text, drawX, drawY, em * GLOW_BLUR_EM);
    });

    return { baseTexture, glowTexture, canvasWidthPx, canvasHeightPx, advancePx };
};

export interface DioramaLineRaster {
    texture: THREE.CanvasTexture;
    canvasWidthPx: number;
    canvasHeightPx: number;
    advancePx: number;
    /** px of one em in THIS raster (long lines shrink to fit the max canvas edge). */
    fontPx: number;
}

/** Rasterise a whole (neighbour) line as one plain white texture - no glow, small pad. */
export const rasterDioramaLine = (text: string, fontStack: string, fontWeight = DEFAULT_FONT_WEIGHT): DioramaLineRaster => {
    const key = `l\u0000${fontWeight}\u0000${fontStack}\u0000${text}`;
    const cached = rasterCache.get<DioramaLineRaster>(key);
    if (cached) return cached;
    const raster = rasterDioramaLineUncached(text, fontStack, fontWeight);
    rasterCache.set(key, raster, estimateTextureBytes(raster.canvasWidthPx, raster.canvasHeightPx, 1), fontStack);
    return raster;
};

const rasterDioramaLineUncached = (text: string, fontStack: string, fontWeight = DEFAULT_FONT_WEIGHT): DioramaLineRaster => {
    let fontPx = DIORAMA_RASTER_FONT_PX;
    let fontSpec = buildDioramaFontSpec(fontStack, fontWeight);
    let advancePx = Math.max(1, Math.ceil(measureDioramaText(text, fontSpec)));
    const pad = Math.ceil(fontPx * PLAIN_PAD_EM);
    if (advancePx + pad * 2 > MAX_CANVAS_PX) {
        const shrink = (MAX_CANVAS_PX - pad * 2) / advancePx;
        fontPx = Math.max(24, Math.floor(fontPx * shrink));
        fontSpec = `${fontWeight} ${fontPx}px ${fontStack}`;
        advancePx = Math.max(1, Math.ceil(measureDioramaText(text, fontSpec)));
    }
    const canvasWidthPx = advancePx + pad * 2;
    const canvasHeightPx = Math.ceil(fontPx * LINE_BAND_EM) + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidthPx;
    canvas.height = canvasHeightPx;
    const ctx = canvas.getContext('2d')!;
    ctx.font = fontSpec;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // 与活动行同一套表面语言（无阴影无描边）：顶部受光三档渐变，立体由场景切片承担
    const surface = ctx.createLinearGradient(0, canvasHeightPx * 0.3, 0, canvasHeightPx * 0.72);
    surface.addColorStop(0, '#ffffff');
    surface.addColorStop(0.5, '#f3f5fa');
    surface.addColorStop(1, '#c4cbe0');
    ctx.fillStyle = surface;
    ctx.fillText(text, pad, canvasHeightPx / 2);

    return { texture: makeTexture(canvas), canvasWidthPx, canvasHeightPx, advancePx, fontPx };
};

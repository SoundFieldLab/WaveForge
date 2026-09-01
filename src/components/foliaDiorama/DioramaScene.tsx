/**
 * folia Diorama（镜台）3D 歌词走廊场景 —— 移植版。
 *
 * 忠实还原核心视觉：歌词行沿弯曲走廊以 3D 文字面片摆放（画布栅格化，逐字/逐词），
 * 相机按行的"电影镜头"运镜（见 CameraRig），场景以距离雾 + 生命周期淡入淡出呈现；
 * 阵型几何（buildFormation）与简化粒子云做氛围层。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { type MotionValue } from 'framer-motion';
import * as THREE from 'three';
import { type Line } from './types';
import { buildLineGraphemeTimeline, type GraphemeTiming } from './graphemeTiming';
import { getLineRenderEndTime } from './renderHints';
import {
    DIORAMA_HERO_DISTANCE,
    type DioramaFrame,
    type DioramaMotionParams,
    type DioramaShapePlacement,
    type DioramaTextPlacement,
    buildFormation,
    composeLocal,
    getDioramaShot,
    getDioramaTextPlacement,
    resolveShapeLifeOpacity,
    seededUnit,
} from './cameraPath';
import { resolveGlobal, type SequencerState } from './dioramaSequencer';
import { EMPTY_AUDIO_PULSE_STORE, type AudioPulseStore } from '../../hooks/useAudioPulse';
import { ANALYZER_SPECTRUM_BANDS, type AudioAnalyzerData, type AudioAnalyzerStore } from '../../hooks/useAudioAnalyzer';
import { getProxiedImageUrl } from '../../services/musicApi';
import {
    DIORAMA_RASTER_FONT_PX,
    buildDioramaFontSpec,
    measureDioramaText,
    rasterDioramaLine,
    rasterDioramaUnit,
    retainDioramaRasterFont,
    shrinkDioramaRasterCache,
} from './dioramaTextRaster';
import { makeAuraTexture, makeStarSpriteTexture } from './dioramaTextures';
import { SpectrumFlanks, BeatRings } from './dioramaSpectrum';

const LINES_AHEAD = 3;
const LINES_BEHIND = 2;
const FOG_NEAR = 12;
const FOG_FAR = 30;
/** 一行歌词在世界空间中的一"em"尺寸。 */
const LINE_FONT_SIZE = 0.62;
/** 一行最多占可见帧宽的比例（在 HERO 距离处结算）。 */
const TARGET_FRAME_WIDTH_FRACTION = 0.72;
const MIN_FIT_SCALE = 0.28;
const DEG_TO_RAD = Math.PI / 180;
const TEXT_DISSOLVE_START = 2.0;
const TEXT_DISSOLVE_END = 0.9;
const TEXT_FADE_IN_START = 32;
const TEXT_FADE_IN_END = 40;
const NEIGHBOR_OPACITY: Record<number, number> = { [-1]: 0.3, [-2]: 0.1, 1: 0.34, 2: 0.16, 3: 0.06 };

// 共享单位四边形：所有 plane mesh 复用同一份 BufferGeometry，按 mesh.scale 区分尺寸。
// 原先每个 plane 各自 `<planeGeometry args={[w,h]}/>` 会为每字 4 层切片分配 4 个独立几何，
// 15 字活动行 = 60 个 geometry；改为共享 + scale 后只剩 1 个，热路径零分配。
// 几何体的 GPU 缓冲在 context loss 后会自动重上传（属性数据本身与上下文无关）。
const SHARED_UNIT_QUAD = new THREE.PlaneGeometry(1, 1);
/** 活动行字厚：每层深度切片的世界单位偏移（两层合计 ≈ 字高的 8%）。
 * 表面后方叠两层暗色同纹理切片，相机侧视/环绕时暴露出真实厚度（视差），
 * 字形读作立体雕刻而非平面贴纸；切片透明度随唱读"生长"。 */
const TEXT_DEPTH_STEP = 0.034;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// ─── 封面色 → 背景调色板 ────────────────────────────────────────────────────────────────────
// 把封面主色（accentColor）推导为同色系的背景色板：天空渐变 / 地平线辉光 / 雾色，
// 每首歌一种氛围；封面色偏白/灰时退化为中性蓝紫，避免刺眼。
interface BackgroundPalette {
    top: string;
    upper: string;
    horizon: string;
    lower: string;
    bottom: string;
    glow: string;
    fog: string;
}

const buildBackgroundPalette = (accentColor: string): BackgroundPalette => {
    const source = new THREE.Color(accentColor);
    const hsl = { h: 0, s: 0, l: 0 };
    source.getHSL(hsl);
    const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
    const saturation = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.45;
    const make = (l: number, sScale: number, hShift: number): string => {
        const next = new THREE.Color();
        next.setHSL((hue + hShift + 1) % 1, Math.min(1, Math.max(0, saturation * sScale)), Math.min(0.95, Math.max(0.03, l)));
        return `#${next.getHexString()}`;
    };
    return {
        // 整体再压暗一档：深空的底色应该接近黑，封面色调只做倾向，
        // 天空越沉，星点与星云的层次越明显
        top: make(0.125, 0.9, 0),
        upper: make(0.09, 0.8, 0),
        horizon: make(0.185, 1, 0),
        lower: make(0.08, 0.9, 0.02),
        bottom: make(0.045, 0.85, 0),
        glow: make(0.26, 1, 0),
        fog: make(0.085, 0.85, 0),
    };
};

const hexToRgb = (hex: string): [number, number, number] => {
    const value = hex.replace('#', '');
    const full = value.length === 3 ? value.split('').map(part => part + part).join('') : value;
    return [
        Number.parseInt(full.slice(0, 2), 16),
        Number.parseInt(full.slice(2, 4), 16),
        Number.parseInt(full.slice(4, 6), 16),
    ];
};

/** 与 folia 一致的距离生命周期透明度。 */
export const resolveTextLife = (distanceToCamera: number): number => {
    const farT = clamp01((TEXT_FADE_IN_END - distanceToCamera) / (TEXT_FADE_IN_END - TEXT_FADE_IN_START));
    const nearT = clamp01((distanceToCamera - TEXT_DISSOLVE_END) / (TEXT_DISSOLVE_START - TEXT_DISSOLVE_END));
    return (farT * farT * (3 - 2 * farT)) * (nearT * nearT * (3 - 2 * nearT));
};

const resolveFrameFitScale = (
    renderedWidth: number,
    distance: number,
    verticalFovDeg: number,
    aspect: number,
): number => {
    if (renderedWidth <= 0 || distance <= 0) return 1;
    const frameWidth = 2 * distance * Math.tan((verticalFovDeg * DEG_TO_RAD) / 2) * aspect;
    const targetWidth = frameWidth * TARGET_FRAME_WIDTH_FRACTION;
    return Math.min(1, Math.max(MIN_FIT_SCALE, targetWidth / renderedWidth));
};

const _basisMatrix = new THREE.Matrix4();
const _basisQuat = new THREE.Quaternion();
const _tiltQuat = new THREE.Quaternion();
const _basisRight = new THREE.Vector3();
const _basisUp = new THREE.Vector3();
const _basisFwd = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);

/** 行文字朝向：+X → frame right，+Y → frame up，+Z → -forward，再叠加 yaw/roll。 */
const frameQuaternion = (frame: DioramaFrame, roll = 0, yaw = 0): [number, number, number, number] => {
    _basisRight.set(frame.right.x, frame.right.y, frame.right.z);
    _basisUp.set(frame.up.x, frame.up.y, frame.up.z);
    _basisFwd.set(-frame.forward.x, -frame.forward.y, -frame.forward.z);
    _basisMatrix.makeBasis(_basisRight, _basisUp, _basisFwd);
    _basisQuat.setFromRotationMatrix(_basisMatrix);
    if (yaw !== 0) _basisQuat.multiply(_tiltQuat.setFromAxisAngle(_axisY, yaw));
    if (roll !== 0) _basisQuat.multiply(_tiltQuat.setFromAxisAngle(_axisZ, roll));
    return [_basisQuat.x, _basisQuat.y, _basisQuat.z, _basisQuat.w];
};

interface VisibleLineEntry {
    globalIndex: number;
    segment: NonNullable<ReturnType<typeof resolveGlobal>>['segment'];
    localIndex: number;
    line: Line;
    placement: DioramaTextPlacement;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    isOutgoing: boolean;
}

// CJK 检测：合并覆盖 CJK 部首/康熙/符号/平假名/片假名/注音/谚文/CJK 统一/扩展 A
// (\u2e80-\u9fff) + 兼容表意 (\uf900-\ufaff) + 全角形式 (\uff00-\uffef) +
// 扩展 B-H 及兼容增补 (\u{20000}-\u{2fa1f})——原正则漏掉了扩展 B-H，导致
// "𠮷/𫝆" 等扩展平面汉字被误判为拉丁文逐词聚合。`u` flag 让 \u{} 高位码点生效。
const isCjkChar = (char: string): boolean =>
    /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2fa1f}]/u.test(char);

interface ActiveUnit {
    text: string;
    startTime: number;
    endTime: number;
}

/** 活动行的逐单元（CJK 逐字 / 拉丁逐词），含时间轴。
 * 当逐词数据与行文本不完全一致（词截断/标点/大小写差异）时，
 * 无 wordIndex 的非空白孤儿字形并入前一个拉丁词单元，避免英文单词被拆成字母碎片。 */
const buildActiveUnits = (line: Line): ActiveUnit[] => {
    const timeline: GraphemeTiming[] = buildLineGraphemeTimeline(line);
    if (timeline.length === 0) {
        return [{ text: line.fullText, startTime: line.startTime, endTime: getLineRenderEndTime(line) }];
    }
    const units: Array<{ text: string; startTime: number; endTime: number; wordIndex?: number }> = [];
    for (const timing of timeline) {
        const last = units[units.length - 1];
        const isWhitespace = /^\s+$/u.test(timing.char);
        const isLatin = !isCjkChar(timing.char);
        // 拉丁词聚合：同 wordIndex 的连续字形并入同一单元
        if (last && isLatin && !isWhitespace && timing.wordIndex !== undefined && last.wordIndex === timing.wordIndex) {
            last.text += timing.char;
            last.endTime = Math.max(last.endTime, timing.endTime);
            continue;
        }
        // 无 wordIndex 的非空白孤儿字形：并入前一个拉丁词单元（重建被数据差异拆散的单词）
        if (last && isLatin && !isWhitespace && timing.wordIndex === undefined && last.wordIndex !== undefined) {
            last.text += timing.char;
            last.endTime = Math.max(last.endTime, timing.endTime);
            continue;
        }
        units.push({ text: timing.char, startTime: timing.startTime, endTime: timing.endTime, wordIndex: timing.wordIndex });
    }
    return units;
};

const measureWorldWidth = (text: string, fontSpec: string): number =>
    (Math.max(1, Math.ceil(measureDioramaText(text, fontSpec))) / DIORAMA_RASTER_FONT_PX) * LINE_FONT_SIZE;

// ─── 活动行：逐字/逐词 3D 文字面片 + 光晕 + 随唱高亮 ───────────────────────────────────────────

const ActiveLineText: React.FC<{
    entry: VisibleLineEntry;
    currentTime: MotionValue<number>;
    fontStack: string;
    accentColor: string;
    fitScale: number;
    onSeek?: (time: number) => void;
    pulseStore: AudioPulseStore;
}> = ({ entry, currentTime, fontStack, accentColor, fitScale, onSeek, pulseStore }) => {
    const { line } = entry;
    const camera = useThree(state => state.camera);
    const fontSpec = useMemo(() => buildDioramaFontSpec(fontStack), [fontStack]);
    const units = useMemo(() => buildActiveUnits(line), [line]);
    const measured = useMemo(() => units.map(unit => ({
        ...unit,
        advancePx: Math.max(1, Math.ceil(measureDioramaText(unit.text, fontSpec))),
    })), [units, fontSpec]);
    const rasters = useMemo(() => measured.map(unit => rasterDioramaUnit(unit.text, fontSpec)), [measured, fontSpec]);

    const totalAdvancePx = rasters.reduce((sum, r) => sum + r.advancePx, 0) || 1;
    const lineWorldWidth = (totalAdvancePx / DIORAMA_RASTER_FONT_PX) * LINE_FONT_SIZE * fitScale;
    const groupRef = useRef<THREE.Group>(null);
    const baseMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const glowMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const sideMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const backMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
    const unitMeshRefs = useRef<Array<THREE.Group | null>>([]);
    // 光晕 mesh 独立 ref + 基底尺寸：让光晕能脱离字基底独立"扩散"（scale 1→1.4），
    // 而不是与字基底绑定同缩放——唱到瞬间光晕径向扩散 + opacity 高峰衰减，读作"光斑"
    const glowMeshRefs = useRef<Array<THREE.Mesh | null>>([]);
    const glowBaseScaleRef = useRef<Array<{ w: number; h: number } | null>>([]);
    const glowSmoothRefs = useRef<number[]>([]);
    // 行入场动画：mount 时刻记一次歌曲时间，前 400ms 行从下方雾中浮入 + opacity 0→1
    // （smoothstep 缓动）。seek 到行中段时跳过入场（elapsed > 0.4s 立即满进度）
    const mountTimeRef = useRef<number | null>(null);
    const entryOffsetYRef = useRef(0); // 当前入场 Y 偏移（世界单位，正值=低于正常位置）
    const white = useMemo(() => new THREE.Color('#ffffff'), []);
    // 未唱压暗灰（明显退场）：原 #a8adc8 L=0.78 太亮，未唱字"抢戏"；
    // 压到 #525666 L≈0.41，未唱字明显退到背景，"逐字点亮"的明暗对比才有冲击力
    const unsungColor = useMemo(() => new THREE.Color('#525666'), []);
    // 更浓的光晕色：适度提高主题色饱和度（克制，避免过艳）
    const vividAccent = useMemo(() => {
        const color = new THREE.Color(accentColor);
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        color.setHSL(hsl.h, Math.min(1, hsl.s * 1.2 + 0.08), Math.min(0.62, Math.max(0.46, hsl.l)));
        return color;
    }, [accentColor]);
    // 副歌段光晕色（暖偏 +5°、饱和 +12%、亮度 +6%）：副歌段视觉强化，与主歌段拉开层次
    const chorusAccent = useMemo(() => {
        const color = vividAccent.clone();
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        // 色相往暖方向偏移 5°（hue 0-1，5° ≈ 0.014）
        color.setHSL((hsl.h + 0.014) % 1, Math.min(1, hsl.s + 0.12), Math.min(0.68, hsl.l + 0.06));
        return color;
    }, [vividAccent]);
    // 3D 厚切片配色随封面主色（压暗的主题色系）——比固定灰蓝更贴歌曲氛围
    const depthColors = useMemo(() => {
        const source = new THREE.Color(accentColor);
        const hsl = { h: 0, s: 0, l: 0 };
        source.getHSL(hsl);
        const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
        const sat = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.5;
        return {
            side: `#${new THREE.Color().setHSL(hue, Math.min(1, sat * 0.85), 0.22).getHexString()}`,
            back: `#${new THREE.Color().setHSL(hue, Math.min(1, sat * 0.75), 0.13).getHexString()}`,
        };
    }, [accentColor]);
    const worldPos = useMemo(() => new THREE.Vector3(), []);
    const tmpColor = useMemo(() => new THREE.Color(), []);
    const auraRef = useRef<THREE.MeshBasicMaterial>(null);

    // 径向柔光纹理（共享工具生成），乘上主题色即成为活动行背后的舞台光晕
    const auraTexture = useMemo(() => makeAuraTexture(256), []);

    useFrame((_, delta) => {
        const group = groupRef.current;
        if (!group) return;
        group.getWorldPosition(worldPos);
        const dist = camera.position.distanceTo(worldPos);
        const life = resolveTextLife(dist);
        const now = currentTime.get();
        const renderEnd = getLineRenderEndTime(line);
        const isChorus = line.isChorus === true;
        // 副歌段光晕色（暖偏）：副歌行用 chorusAccent，主歌行用 vividAccent
        const lineAccent = isChorus ? chorusAccent : vividAccent;
        // 行入场动画（A）：mount 时刻首次记歌曲时间，前 400ms 浮入 + opacity 0→1
        // smoothstep 缓动；seek 到行中段时 elapsed > 0.4s 跳过入场立即满进度
        if (mountTimeRef.current === null) mountTimeRef.current = now;
        const entryElapsed = Math.max(0, now - mountTimeRef.current);
        const entryRaw = entryElapsed >= 0.4 ? 1 : entryElapsed / 0.4;
        const entrySmooth = entryRaw * entryRaw * (3 - 2 * entryRaw);
        // Y 偏移：从 +0.15 浮到 0（从下方雾中浮入），-12 exp 平滑避免硬切
        const targetOffsetY = (1 - entrySmooth) * 0.15;
        const curOffsetY = entryOffsetYRef.current;
        const newOffsetY = curOffsetY + (targetOffsetY - curOffsetY) * (1 - Math.exp(-12 * Math.max(0.001, delta)));
        entryOffsetYRef.current = newOffsetY;
        group.position.y = entry.position[1] + newOffsetY;
        // effectiveLife = 相机距离 life × 入场 progress（入场期间整行渐亮）
        const effectiveLife = life * entrySmooth;
        // 节拍同步（B）：pulse.scale 是节拍包络幅度 0-1，峰值时即为节拍瞬间
        //   - 已唱字稳定辉光 +节拍呼吸（持续律动）
        //   - 正在唱的字基底 scale +节拍弹动 3%
        //   - 正在唱的字颜色 lerp accent +节拍加强 0.15（强拍时字色更饱，"咬字"感）
        const pulse = pulseStore.getSnapshot();
        const beatIntensity = pulse.scale; // 0-1
        // 舞台光晕：整行级环境光（随唱 + 音律呼吸，无逐字跳变）—— 光晕只做氛围，宁弱勿强
        const auraMat = auraRef.current;
        if (auraMat) {
            const sungPhase = now < line.startTime ? 0 : now >= renderEnd ? 1 : clamp01((now - line.startTime) / Math.max(0.001, renderEnd - line.startTime));
            // 副歌段舞台光晕强化（+50% opacity）：副歌段背景光更浓，营造"高潮段"氛围
            const chorusBoost = isChorus ? 0.5 : 0;
            auraMat.opacity = effectiveLife * (0.04 + 0.068 * sungPhase) * (1 + pulse.scale * 2 + chorusBoost);
            auraMat.color.copy(lineAccent);
        }
        // 逐字光晕：近零（仅保留极微弱暖光），杜绝"每字冒光"的突兀感；
        // 逐字效果由文字亮度点亮承担（见下方 base.opacity）
        if (glowSmoothRefs.current.length !== measured.length) {
            glowSmoothRefs.current = new Array(measured.length).fill(0);
        }
        // 未唱压暗灰 / 已唱过驱白：随唱平滑过渡，拉开逐字点亮的辨识度
        for (let index = 0; index < measured.length; index += 1) {
            const unit = measured[index];
            const base = baseMatRefs.current[index];
            const glow = glowMatRefs.current[index];
            const unitMesh = unitMeshRefs.current[index];
            if (!unit || !base || !glow) continue;
            // 每个字的唱读窗口用字自己的起止时间（renderEnd 只用于行级状态，不能拉长字的窗口）
            const unitEnd = unit.endTime;
            const rawProgress = now <= unit.startTime ? 0 : now >= unitEnd ? 1 : (now - unit.startTime) / Math.max(0.001, unitEnd - unit.startTime);
            const progress = rawProgress * rawProgress * (3 - 2 * rawProgress);
            const isSinging = rawProgress > 0 && rawProgress < 1;
            // 颜色：未唱暗灰 → 已唱纯白；正在演唱中的字主题色倾向加强（明确"唱到哪"）
            // 副歌行用更暖的 chorusAccent，主歌用 vividAccent
            // 节拍同步（B）：正在唱的字在节拍峰值时额外 lerp accent 0.15（"咬字"感）
            tmpColor.copy(unsungColor).lerp(white, progress);
            if (isSinging) {
                tmpColor.lerp(lineAccent, 0.28 + beatIntensity * 0.15);
            }
            // 已唱字 base opacity 升到 0.92：恰进 Bloom 阈值（0.92），自然微辉光；
            // "正在唱"的辉光交给下方 glow burst（光斑扩散）承担，base 不再过驱白
            base.color.copy(tmpColor);
            // 亮度差：未唱 0.18 → 已唱 0.92；演唱窗口保留一线 sin 强调
            const activeBoost = isSinging ? 1 + 0.05 * Math.sin(Math.PI * rawProgress) : 1;
            base.opacity = effectiveLife * (0.18 + 0.74 * progress) * activeBoost;
            // 立体厚度层：暗色切片透明度随唱读"生长"——未唱时保持干净平面，
            // 唱到的字显出厚度（相机环绕/侧视时视差暴露字厚）
            const depthGain = 0.3 + 0.7 * progress;
            const sideMat = sideMatRefs.current[index];
            const backMat = backMatRefs.current[index];
            if (sideMat) sideMat.opacity = base.opacity * 0.85 * depthGain;
            if (backMat) backMat.opacity = base.opacity * 0.62 * depthGain;
            // 逐字光晕升级：
            // - 已唱稳定辉光：0.06（持续微辉光，进 bloom 阈值，已唱字不再"暗下去"）
            // - 唱到瞬间 burst：0.10·(1-t)² 衰减（前 300ms 显著扩散光晕，从 0.30 经 0.18 下调避免刺眼）
            // - 节拍呼吸（B）：已唱字稳定辉光 +节拍 0.04，让已唱字持续律动（不抢戏）
            // - 平滑速率 -4 → -8：让 burst 起音更快，跟上"瞬间点亮"的节奏
            const glowBurst = isSinging ? 0.10 * (1 - rawProgress) * (1 - rawProgress) : 0;
            const beatGlow = progress > 0 ? beatIntensity * 0.04 : 0; // 已唱字节拍呼吸
            const targetGlow = 0.015 + 0.06 * progress + glowBurst + beatGlow;
            const smoothed = glowSmoothRefs.current[index]
                + (targetGlow - glowSmoothRefs.current[index]) * (1 - Math.exp(-8 * Math.max(0.001, delta)));
            glowSmoothRefs.current[index] = smoothed;
            glow.color.copy(lineAccent);
            glow.opacity = effectiveLife * smoothed * (1 + pulse.scale * 3);
            // 光晕 mesh 独立扩散：唱到瞬间光晕从 1 扩散到 1.08（脱离字基底独立 scale），
            // (1-t)² 衰减——前 300ms 光斑径向扩散+变淡，读作"光从字里向外荡开"
            const glowMesh = glowMeshRefs.current[index];
            const glowBase = glowBaseScaleRef.current[index];
            if (glowMesh && glowBase) {
                const glowScale = isSinging ? 1 + 0.08 * (1 - rawProgress) * (1 - rawProgress) : 1;
                glowMesh.scale.set(glowBase.w * glowScale, glowBase.h * glowScale, 1);
            }
            // 字基底弹性膨胀：唱到瞬间 1.0→1.15→1.0（300ms ease-out 衰减）
            // (1-t)² 包络：t=0 时 +15%，t=0.5 时 +3.75%，t=1 时归零——比原 sin 包络更有"啵"的冲击感
            // 副歌行 +2% 持续 scale boost：副歌段字稍大，强化"高潮段"视觉重量
            // 节拍同步（B）：正在唱的字在节拍峰值时额外 +3% scale 弹动
            if (unitMesh && now >= unit.startTime) {
                const chorusScaleBoost = isChorus ? 0.02 : 0;
                const singBurst = isSinging ? 0.15 * (1 - rawProgress) * (1 - rawProgress) : 0;
                const beatScaleBoost = isSinging ? beatIntensity * 0.03 : 0;
                const breath = 1 + Math.sin(now * 1.2 + index * 0.7) * 0.008;
                const scalePulse = breath + singBurst + chorusScaleBoost + beatScaleBoost;
                unitMesh.scale.set(scalePulse, scalePulse, 1);
            }
        }
    });

    // 逐字点击 seek 到该字/词的起始时间（folia 原版交互：点字精确跳字，而非整行起跳）
    const seekUnit = (index: number) => () => {
        const unit = measured[index];
        onSeek?.(unit?.startTime ?? line.startTime);
    };
    let cursor = -totalAdvancePx / 2;
    const planes = rasters.map((raster, index) => {
        // 平面宽度必须用画布实际宽度（advance + 两侧 pad），不能用 advance：
        // 纹理 UV 整幅映射到平面，若平面窄于画布，字形会被横向压缩 advance/(advance+2pad)——
        // 短词（如 "in"，advance≈110px）会被压到 ~38% 宽，扁得尤其明显（修复用户反馈）。
        // 多出的 pad 区域是全透明的，平面比字距宽只会与相邻平面透明重叠，无视觉副作用；
        // 字形左缘恰好落在 cursor 处（平面中心 = advance 中心，左右 pad 对称）。
        const unitWorldWidth = Math.max(0.01, (raster.canvasWidthPx / DIORAMA_RASTER_FONT_PX) * LINE_FONT_SIZE * fitScale);
        const unitWorldHeight = Math.max(0.01, (raster.canvasHeightPx / DIORAMA_RASTER_FONT_PX) * LINE_FONT_SIZE * fitScale);
        const x = (cursor + raster.advancePx / 2) / DIORAMA_RASTER_FONT_PX * LINE_FONT_SIZE * fitScale;
        cursor += raster.advancePx;
        const planeScale: [number, number, number] = [unitWorldWidth, unitWorldHeight, 1];
        return (
            <group
                key={`${index}`}
                position={[x, 0, 0]}
                ref={(g) => { unitMeshRefs.current[index] = g; }}
            >
                {/* 光晕（最底层）：柔光在厚度切片之后，不遮住字厚。
                    光晕纹理与 base 共用同一画布几何，1:1 同尺寸映射才能精准套准笔画 */}
                <mesh
                    ref={(m) => {
                        glowMeshRefs.current[index] = m;
                        glowBaseScaleRef.current[index] = { w: planeScale[0], h: planeScale[1] };
                    }}
                    position={[0, 0, -TEXT_DEPTH_STEP * 3]}
                    scale={planeScale}
                    renderOrder={0}
                    geometry={SHARED_UNIT_QUAD}
                >
                    <meshBasicMaterial
                        ref={(mat) => { glowMatRefs.current[index] = mat; }}
                        map={raster.glowTexture}
                        transparent
                        depthWrite={false}
                        blending={THREE.AdditiveBlending}
                        toneMapped={false}
                        fog={false}
                        opacity={0}
                    />
                </mesh>
                {/* 立体厚度切片（后层）：同纹理暗色副本，与表面拉开真实 Z 距 */}
                <mesh position={[0, 0, -TEXT_DEPTH_STEP * 2]} scale={planeScale} renderOrder={1} geometry={SHARED_UNIT_QUAD}>
                    <meshBasicMaterial
                        ref={(mat) => { backMatRefs.current[index] = mat; }}
                        map={raster.baseTexture}
                        color={depthColors.back}
                        transparent
                        depthWrite={false}
                        toneMapped={false}
                        fog={false}
                        opacity={0}
                    />
                </mesh>
                {/* 立体厚度切片（中层） */}
                <mesh position={[0, 0, -TEXT_DEPTH_STEP]} scale={planeScale} renderOrder={2} geometry={SHARED_UNIT_QUAD}>
                    <meshBasicMaterial
                        ref={(mat) => { sideMatRefs.current[index] = mat; }}
                        map={raster.baseTexture}
                        color={depthColors.side}
                        transparent
                        depthWrite={false}
                        toneMapped={false}
                        fog={false}
                        opacity={0}
                    />
                </mesh>
                {/* 受光表面：bevel 渐变纹理，点击跳转 */}
                <mesh
                    scale={planeScale}
                    renderOrder={3}
                    geometry={SHARED_UNIT_QUAD}
                    onClick={seekUnit(index)}
                    onPointerOver={onSeek ? () => { document.body.style.cursor = 'pointer' } : undefined}
                    onPointerOut={onSeek ? () => { document.body.style.cursor = 'auto' } : undefined}
                >
                    <meshBasicMaterial
                        ref={(mat) => { baseMatRefs.current[index] = mat; }}
                        map={raster.baseTexture}
                        transparent
                        depthWrite={false}
                        toneMapped={false}
                        fog={false}
                    />
                </mesh>
            </group>
        );
    });

    return (
        <group ref={groupRef} position={entry.position} quaternion={new THREE.Quaternion(...entry.quaternion)}>
            {/* 舞台光晕：活动行背后的径向柔光 */}
            <mesh
                position={[0, 0, -2.4]}
                scale={[Math.max(0.5, lineWorldWidth * 2.4), Math.max(0.6, 2.8 * LINE_FONT_SIZE * fitScale), 1]}
                geometry={SHARED_UNIT_QUAD}
            >
                <meshBasicMaterial
                    ref={auraRef}
                    map={auraTexture}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    toneMapped={false}
                    fog={false}
                    opacity={0}
                />
            </mesh>
            {planes}
        </group>
    );
};

// ─── 邻居行：单张整体纹理 ───────────────────────────────────────────────────────────────────────

const NeighborLineText: React.FC<{
    entry: VisibleLineEntry;
    fontStack: string;
    fitScale: number;
    baseOpacity: number;
    onSeek?: (time: number) => void;
}> = ({ entry, fontStack, fitScale, baseOpacity, onSeek }) => {
    const camera = useThree(state => state.camera);
    const raster = useMemo(
        () => rasterDioramaLine(entry.line.fullText, fontStack, 600),
        [entry.line.fullText, fontStack],
    );
    const worldWidth = (raster.canvasWidthPx / raster.fontPx) * LINE_FONT_SIZE * fitScale;
    const worldHeight = (raster.canvasHeightPx / raster.fontPx) * LINE_FONT_SIZE * fitScale;
    const matRef = useRef<THREE.MeshBasicMaterial | null>(null);
    const groupRef = useRef<THREE.Group>(null);
    const worldPos = useMemo(() => new THREE.Vector3(), []);

    useFrame(() => {
        const mat = matRef.current;
        const group = groupRef.current;
        if (!mat || !group) return;
        group.getWorldPosition(worldPos);
        const dist = camera.position.distanceTo(worldPos);
        mat.opacity = baseOpacity * resolveTextLife(dist) * 0.9;
    });

    return (
        <group ref={groupRef} position={entry.position} quaternion={new THREE.Quaternion(...entry.quaternion)}>
            <mesh
                scale={[Math.max(0.01, worldWidth), Math.max(0.01, worldHeight), 1]}
                geometry={SHARED_UNIT_QUAD}
                onClick={() => onSeek?.(entry.line.startTime)}
                onPointerOver={onSeek ? () => { document.body.style.cursor = 'pointer' } : undefined}
                onPointerOut={onSeek ? () => { document.body.style.cursor = 'auto' } : undefined}
            >
                <meshBasicMaterial
                    ref={matRef}
                    map={raster.texture}
                    transparent
                    depthWrite={false}
                    toneMapped={false}
                />
            </mesh>
        </group>
    );
};

// ─── 阵型粒子：以光尘云替代漂浮几何（用户反馈"外面飘着的方块不要了"） ─────────────────────────
//
// 阵型不再渲染实体几何（box/sphere/cone/torus），改为围绕每个形状锚点聚集的发光粒子团：
//   - 空间布局仍由 buildFormation 决定——镜头语言配套的 set-piece 位置、与文字的净空
//     全部继承，只是"积木"换成了"光尘"（环绕的环 → 环形粒子带，门柱 → 竖列光点，螺旋 → 粒子串）；
//   - 软点 sprite + 加法混合，逐粒闪烁/漂移全在顶点着色器里做（CPU 零负担）；
//   - 颜色取封面主色两档 rim 色，生命周期透明度沿用 resolveShapeLifeOpacity（远处淡入/近处消融）。

const FORMATION_PARTICLE_VERTEX = /* glsl */`
attribute float aSize;
attribute float aPhase;
attribute float aMix;
uniform float uTime;
uniform float uScale;
uniform float uDrift;
varying float vTwinkle;
varying float vMix;
void main() {
    // 缓慢的轨道漂移：逐粒相位不同，整体读作悬浮的光尘（不动 CPU）
    vec3 pos = position + vec3(
        sin(uTime * 0.32 + aPhase * 7.0),
        cos(uTime * 0.24 + aPhase * 11.0),
        sin(uTime * 0.28 + aPhase * 5.0)
    ) * uDrift;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vTwinkle = 0.55 + 0.45 * sin(uTime * (0.6 + aPhase * 1.8) + aPhase * 40.0);
    vMix = aMix;
    // uScale = 0.5 × 绘制缓冲高度，与 PointsMaterial 的尺寸衰减口径一致
    gl_PointSize = aSize * (0.85 + 0.3 * vTwinkle) * (uScale / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const FORMATION_PARTICLE_FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uGlow;
varying float vTwinkle;
varying float vMix;
void main() {
    float mask = texture2D(uMap, gl_PointCoord).a;
    if (mask < 0.02) discard;
    vec3 col = mix(uColorA, uColorB, vMix) * vTwinkle * (0.8 + uGlow * 0.7);
    gl_FragColor = vec4(col, mask * uOpacity);
}
`;

/** 把 buildFormation 的形状锚点展开为粒子团：每个锚点周围播种一小簇确定性伪随机粒子。
 * 锚点尺寸决定簇的散布半径与粒数，stretchY（立柱/杆）把散布沿纵向拉长。 */
const buildFormationParticleData = (shapes: DioramaShapePlacement[]): {
    positions: Float32Array;
    sizes: Float32Array;
    phases: Float32Array;
    mixes: Float32Array;
    count: number;
} => {
    const positions: number[] = [];
    const sizes: number[] = [];
    const phases: number[] = [];
    const mixes: number[] = [];
    let k = 0;
    for (const shape of shapes) {
        const count = Math.max(6, Math.min(18, Math.round(shape.scale * 16)));
        const jitterRadius = shape.scale * 0.9;
        const stretchY = Math.max(1, shape.stretchY * 0.7);
        for (let i = 0; i < count; i += 1) {
            const r1 = seededUnit(k * 7 + 1);
            const r2 = seededUnit(k * 7 + 2);
            const r3 = seededUnit(k * 7 + 3);
            const r4 = seededUnit(k * 7 + 4);
            const r5 = seededUnit(k * 7 + 5);
            const r6 = seededUnit(k * 7 + 6);
            k += 1;
            const theta = r1 * Math.PI * 2;
            const cosPhi = r2 * 2 - 1;
            const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
            const radius = jitterRadius * (0.4 + r3 * 0.9);
            positions.push(
                shape.position.x + sinPhi * Math.cos(theta) * radius,
                shape.position.y + cosPhi * radius * stretchY,
                shape.position.z + sinPhi * Math.sin(theta) * radius,
            );
            sizes.push(0.08 + r4 * 0.15);
            phases.push(r5);
            // 按形状色槽偏向其中一档颜色，另一档少量穿插
            mixes.push(shape.colorSlot === 0 ? r6 * 0.45 : 0.55 + r6 * 0.45);
        }
    }
    return {
        positions: new Float32Array(positions),
        sizes: new Float32Array(sizes),
        phases: new Float32Array(phases),
        mixes: new Float32Array(mixes),
        count: k > 0 ? positions.length / 3 : 0,
    };
};

/** 封面主色 → 粒子两档配色（亮主题色 / 移相深色），粒子用更亮的 rim 档。 */
const buildFormationPalette = (accentColor: string): Array<{ body: THREE.Color; rim: THREE.Color }> => {
    const source = new THREE.Color(accentColor);
    const hsl = { h: 0, s: 0, l: 0 };
    source.getHSL(hsl);
    const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
    const sat = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.5;
    const hueDeep = (hue - 0.07 + 1) % 1;
    return [
        {
            body: new THREE.Color().setHSL(hue, Math.min(1, sat * 1.05 + 0.06), 0.56),
            rim: new THREE.Color().setHSL(hue, Math.min(1, sat * 1.1 + 0.1), 0.78),
        },
        {
            body: new THREE.Color().setHSL(hueDeep, Math.min(1, sat * 0.85), 0.4),
            rim: new THREE.Color().setHSL(hueDeep, Math.min(1, sat * 0.95 + 0.05), 0.66),
        },
    ];
};

/** 阵型粒子团：一行歌词一份 geometry + 材质，逐帧只更新 uniform（无逐粒 CPU 工作）。 */
const FormationParticles: React.FC<{ shapes: DioramaShapePlacement[]; pulseStore: AudioPulseStore; accentColor: string }> = ({ shapes, pulseStore, accentColor }) => {
    const camera = useThree(state => state.camera);
    const palette = useMemo(() => buildFormationPalette(accentColor), [accentColor]);
    const spriteTexture = useMemo(() => makeStarSpriteTexture(64), []);

    const { geometry, anchor } = useMemo(() => {
        const data = buildFormationParticleData(shapes);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        geo.setAttribute('aSize', new THREE.BufferAttribute(data.sizes, 1));
        geo.setAttribute('aPhase', new THREE.BufferAttribute(data.phases, 1));
        geo.setAttribute('aMix', new THREE.BufferAttribute(data.mixes, 1));
        // 生命周期锚点：形状群中心（距离淡入/近处消融按它结算）
        const center = new THREE.Vector3();
        if (shapes.length > 0) {
            for (const shape of shapes) center.add(new THREE.Vector3(shape.position.x, shape.position.y, shape.position.z));
            center.divideScalar(shapes.length);
        }
        return { geometry: geo, anchor: center };
    }, [shapes]);

    const material = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: FORMATION_PARTICLE_VERTEX,
        fragmentShader: FORMATION_PARTICLE_FRAGMENT,
        uniforms: {
            uMap: { value: spriteTexture },
            uColorA: { value: palette[0].rim.clone() },
            uColorB: { value: palette[1].rim.clone() },
            uOpacity: { value: 0 },
            uGlow: { value: 0 },
            uTime: { value: 0 },
            uScale: { value: 400 },
            uDrift: { value: 0.22 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    }), [shapes, palette, spriteTexture]);

    // geometry/材质为命令式创建（不经 R3F 自动 dispose），统一手动释放
    useEffect(() => () => {
        geometry.dispose();
        material.dispose();
    }, [geometry, material]);

    useFrame((state) => {
        const pulse = pulseStore.getSnapshot();
        const life = resolveShapeLifeOpacity(camera.position.distanceTo(anchor));
        material.uniforms.uOpacity.value = life * 0.85;
        material.uniforms.uGlow.value = pulse.scale;
        material.uniforms.uTime.value = state.clock.elapsedTime;
        material.uniforms.uScale.value = state.size.height * state.gl.getPixelRatio() * 0.5;
    });

    if (shapes.length === 0) return null;
    return <points geometry={geometry} material={material} />;
};

// ─── 单行组（负责自身的 hooks） ─────────────────────────────────────────────────────────────────

const LineGroup: React.FC<{
    entry: VisibleLineEntry;
    isActive: boolean;
    currentTime: MotionValue<number>;
    motion: DioramaMotionParams;
    fontStack: string;
    accentColor: string;
    verticalFovDeg: number;
    aspect: number;
    onSeek?: (time: number) => void;
    pulseStore: AudioPulseStore;
}> = ({ entry, isActive, currentTime, motion, fontStack, accentColor, verticalFovDeg, aspect, onSeek, pulseStore }) => {
    const shot = useMemo(
        () => (isActive ? getDioramaShot(entry.localIndex, entry.segment.lines, entry.segment.seed, motion.subMode) : 'hold'),
        [entry, isActive, motion.subMode],
    );
    const shapes = useMemo(
        () => buildFormation(entry.localIndex, entry.segment.seed, shot, entry.segment.frames[entry.localIndex], entry.placement, 1),
        [entry, shot],
    );
    const lineWorldWidth = useMemo(
        () => measureWorldWidth(entry.line.fullText, buildDioramaFontSpec(fontStack)),
        [entry.line.fullText, fontStack],
    );
    const fitScale = useMemo(
        () => resolveFrameFitScale(lineWorldWidth, DIORAMA_HERO_DISTANCE, verticalFovDeg, aspect),
        [lineWorldWidth, verticalFovDeg, aspect],
    );

    return (
        <group>
            {isActive ? (
                <ActiveLineText entry={entry} currentTime={currentTime} fontStack={fontStack} accentColor={accentColor} fitScale={fitScale} onSeek={onSeek} pulseStore={pulseStore} />
            ) : (
                <NeighborLineText entry={entry} fontStack={fontStack} fitScale={fitScale} baseOpacity={0.3} onSeek={onSeek} />
            )}
            <FormationParticles shapes={shapes} pulseStore={pulseStore} accentColor={accentColor} />
        </group>
    );
};

// ─── 主场景 ─────────────────────────────────────────────────────────────────────────────────────

export interface DioramaSceneProps {
    currentTime: MotionValue<number>;
    sequencer: SequencerState;
    globalIndex: number;
    motion: DioramaMotionParams;
    fontStack: string;
    accentColor: string;
    /** 切歌过渡时仍挂载的出站走廊行索引（null 表示无过渡）。 */
    outgoingGlobalIndex: number | null;
    /** 点击歌词行跳转（folia 原版交互）。 */
    onSeek?: (time: number) => void;
    /** 音律脉冲：星河/光晕/阵型随音乐律动。 */
    pulseStore?: AudioPulseStore;
    /** 切歌/循环过渡飞行中（星河加速）。 */
    flightActive?: boolean;
    /** 音频频段分析：波形河 / 节拍环。 */
    analyzerStore?: AudioAnalyzerStore;
    /** 歌词行数据版本（切歌后歌词晚到时原位重建段，用于让场景重算可见行）。 */
    linesEpoch?: number;
    /** 歌曲封面：高斯模糊后融入天球背景（只要一点封面的氛围，不是贴图）。 */
    coverUrl?: string;
    /** MV 背景激活时：内置背景层（BackgroundGradient/StarShell/color/fog）退场，让下层 MV 视频透过 Canvas 可见。 */
    mvBackgroundActive?: boolean;
}

const EMPTY_ANALYSIS: AudioAnalyzerData = Object.freeze({
    bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
    spectrum: new Float32Array(ANALYZER_SPECTRUM_BANDS),
    left: { bass: 0, mid: 0, high: 0, overall: 0 },
    right: { bass: 0, mid: 0, high: 0, overall: 0 },
});
const EMPTY_ANALYZER_STORE: AudioAnalyzerStore = {
    getSnapshot: () => EMPTY_ANALYSIS,
    subscribe: () => () => undefined,
    retainBackground: () => () => undefined,
    hasBackgroundConsumers: () => false,
};

export default function DioramaScene({
    currentTime,
    sequencer,
    globalIndex,
    motion,
    fontStack,
    accentColor,
    outgoingGlobalIndex,
    onSeek,
    pulseStore,
    flightActive = false,
    analyzerStore = EMPTY_ANALYZER_STORE,
    linesEpoch = 0,
    coverUrl,
    mvBackgroundActive = false,
}: DioramaSceneProps) {
    const camera = useThree(state => state.camera);
    const aspect = useThree(state => state.viewport.aspect);
    const verticalFovDeg = camera instanceof THREE.PerspectiveCamera ? camera.fov : 60;
    // 字体变化时只保留新字体的纹理；场景卸载后降到小热集预算，避免跨模式常驻整首歌词。
    useEffect(() => {
        retainDioramaRasterFont(fontStack);
        return () => shrinkDioramaRasterCache();
    }, [fontStack]);
    // 封面主色 → 背景调色板（天空/辉光/雾色/星云/地面雾全部同色系）
    const bgPalette = useMemo(() => buildBackgroundPalette(accentColor), [accentColor]);

    const visibleEntries = useMemo<VisibleLineEntry[]>(() => {
        const entries: VisibleLineEntry[] = [];
        const pushWindow = (center: number, isOutgoing: boolean) => {
            for (let offset = -LINES_BEHIND; offset <= LINES_AHEAD; offset += 1) {
                const g = center + offset;
                if (g < 0) continue;
                const resolved = resolveGlobal(sequencer, g);
                if (!resolved || !resolved.line || !resolved.line.fullText) continue;
                const placement = getDioramaTextPlacement(resolved.localIndex, resolved.segment.seed, motion.weaveScale);
                const pos = composeLocal(resolved.frame, placement.offsetR, placement.offsetU, 0);
                entries.push({
                    globalIndex: g,
                    segment: resolved.segment,
                    localIndex: resolved.localIndex,
                    line: resolved.line,
                    placement,
                    position: [pos.x, pos.y, pos.z],
                    quaternion: frameQuaternion(resolved.frame, placement.roll, placement.yaw),
                    isOutgoing,
                });
            }
        };
        pushWindow(globalIndex, false);
        if (outgoingGlobalIndex !== null && Math.abs(outgoingGlobalIndex - globalIndex) > 4) {
            pushWindow(outgoingGlobalIndex, true);
        }
        const seen = new Set<number>();
        return entries.filter(entry => {
            if (seen.has(entry.globalIndex)) return false;
            seen.add(entry.globalIndex);
            return true;
        });
    }, [globalIndex, linesEpoch, outgoingGlobalIndex, sequencer, motion.weaveScale]);

    return (
        <>
            {/* 背景深度渐变（skybox 大球，忽略雾）：封面色系 + 银河带 + 封面模糊融入
                MV 背景激活时退场，让下层 MV 视频透过 Canvas 可见 */}
            {!mvBackgroundActive && <BackgroundGradient palette={bgPalette} coverUrl={coverUrl} />}
            {/* 3D 星壳：真实分布的远景星（大量暗星 + 少量亮星），替代贴图星
                MV 背景激活时退场，避免星壳遮挡视频 */}
            {!mvBackgroundActive && <StarShell />}
            {/* MV 背景激活时不设 scene background color，让 Canvas alpha 透明 */}
            {!mvBackgroundActive && <color attach="background" args={[bgPalette.fog]} />}
            {/* 雾色与地平线一致：远处几何融入封面色调氛围
                MV 背景激活时关掉雾，否则 MV 视频被雾色染透且远处歌词被白雾化 */}
            {!mvBackgroundActive && <fog attach="fog" args={[bgPalette.fog, FOG_NEAR, FOG_FAR]} />}

            {visibleEntries.map(entry => (
                <LineGroup
                    key={entry.globalIndex}
                    entry={entry}
                    isActive={entry.globalIndex === globalIndex && !entry.isOutgoing}
                    currentTime={currentTime}
                    motion={motion}
                    fontStack={fontStack}
                    accentColor={accentColor}
                    verticalFovDeg={verticalFovDeg}
                    aspect={aspect}
                    onSeek={onSeek}
                    pulseStore={pulseStore ?? EMPTY_AUDIO_PULSE_STORE}
                />
            ))}

            {/* 星河粒子：沿走廊方向缓缓流动 + 逐粒闪烁 + 随音乐律动（替代静态尘埃） */}
            <StarRiver count={560} pulseStore={pulseStore ?? EMPTY_AUDIO_PULSE_STORE} flightActive={flightActive} />

            {/* 填空元素：星云薄雾 / 走廊光轨 / 地面雾光 */}
            <NebulaField accentColor={accentColor} />
            <PathRail sequencer={sequencer} accentColor={accentColor} />
            <FloorMist accentColor={accentColor} />

            {/* 音频层：频谱双翼 / 节拍环 / 进度光点 */}
            <SpectrumFlanks sequencer={sequencer} globalIndex={globalIndex} motion={motion} analyzerStore={analyzerStore} accentColor={accentColor} />
            <BeatRings sequencer={sequencer} globalIndex={globalIndex} analyzerStore={analyzerStore} accentColor={accentColor} />
            <ProgressOrb sequencer={sequencer} globalIndex={globalIndex} currentTime={currentTime} accentColor={accentColor} />
        </>
    );
}

// ─── 星云：fBM 分形噪声 + 域扭曲，真实湍流云絮 ──────────────────────────────────────────────
//
// 旧版"径向渐变 + 几个圆 blob"画出来的云一眼就是贴片。换成更接近真实星云成因的做法：
//   - 多倍频 value noise（fBM）采样出云密度——高频倍频给出细丝状云絮；
//   - 采样坐标先被低频噪声扭曲（domain warp）——湍流旋涡/丝状结构，这是真实星云
//     形态的骨架；
//   - 对比度曲线把密度雕刻成"云块 + 透明空隙"，边缘用噪声扰动的径向遮罩做不规则羽化；
//   - 纹理为白（密度存 alpha），材质色仍由封面主色派生，切歌换氛围不换结构。

const makeValueNoise2D = (seed: number): ((x: number, y: number) => number) => {
    const hash = (x: number, y: number): number => {
        let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
        h = ((h ^ (h >> 13)) * 1274126177) | 0;
        return ((h ^ (h >> 16)) >>> 0) / 4294967296;
    };
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    return (x: number, y: number): number => {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const xf = x - xi;
        const yf = y - yi;
        const a = hash(xi, yi);
        const b = hash(xi + 1, yi);
        const c = hash(xi, yi + 1);
        const d = hash(xi + 1, yi + 1);
        const u = smooth(xf);
        const v = smooth(yf);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
};

/** 分形布朗运动：叠加多个倍频的 value noise（频率 ×2.03、幅度 ×0.5），归一化到 0..1。 */
const makeFbm = (noise: (x: number, y: number) => number, octaves: number): ((x: number, y: number) => number) =>
    (x: number, y: number): number => {
        let sum = 0;
        let amp = 0.5;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i += 1) {
            sum += noise(x * freq, y * freq) * amp;
            norm += amp;
            amp *= 0.5;
            freq *= 2.03;
        }
        return sum / norm;
    };

// ─── 天空银河带：斜贯天球的 fBM 亮度层（模块缓存，所有调色板共用） ───────────────────────────
// 真实深空背景不是纯渐变——银河系的盘面是一条有尘埃结构的弥散亮带。
// 这里用高斯包络限定带宽、fBM 给出带内的团块/尘埃结构，一次性算好缓存。
// 画布为球面等距柱状 2:1（1024×512）：横向 1024px 包 360°，≈2.8px/度——
// 旧版 512×1024（1:2）横向只有 1.4px/度，封面/银河被球面摊得面目全非（用户反馈"看不出轮廓"的根因）。
const SKY_TEX_W = 1024;
const SKY_TEX_H = 512;
let milkyWayBandCache: Float32Array | null = null;
const getMilkyWayBand = (): Float32Array => {
    if (milkyWayBandCache) return milkyWayBandCache;
    const band = new Float32Array(SKY_TEX_W * SKY_TEX_H);
    const fbm = makeFbm(makeValueNoise2D(88177), 4);
    for (let y = 0; y < SKY_TEX_H; y += 1) {
        const v = y / SKY_TEX_H - 0.5;
        for (let x = 0; x < SKY_TEX_W; x += 1) {
            const u = x / SKY_TEX_W - 0.5;
            // 斜贯天空的带轴（略倾斜，避免水平/垂直的死板感）
            const axis = u * 0.58 + v * 0.92;
            const envelope = Math.exp(-axis * axis * 30);
            const struct = fbm(u * 6.5 + 3.7, v * 3.4 + 9.2);
            const clumps = Math.pow(Math.max(0, (struct - 0.34) / 0.66), 1.25);
            band[y * SKY_TEX_W + x] = envelope * clumps;
        }
    }
    milkyWayBandCache = band;
    return band;
};

// 预渲染银河带为 Canvas（一次性，所有切歌共用）：每像素存增益后的 RGB，后续切歌
// 只需一次 drawImage('lighter') 合成，替代每张 1024×512 纹理重建时的 524k 像素 JS 循环。
// 像素值 = band * {0.92, 0.95, 1.05} * 255，drawImage 时 globalAlpha = milkyGain/255 即恢复
// 原始加法贡献 = band * {0.92,0.95,1.05} * milkyGain（与原逐像素循环数值等价）。
let milkyWayCanvasCache: HTMLCanvasElement | null = null;
const getMilkyWayCanvas = (): HTMLCanvasElement => {
    if (milkyWayCanvasCache) return milkyWayCanvasCache;
    const band = getMilkyWayBand();
    const canvas = document.createElement('canvas');
    canvas.width = SKY_TEX_W;
    canvas.height = SKY_TEX_H;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(SKY_TEX_W, SKY_TEX_H);
    const pixels = image.data;
    for (let i = 0, j = 0; i < band.length; i += 1, j += 4) {
        const m = band[i];
        pixels[j] = Math.min(255, m * 0.92 * 255);
        pixels[j + 1] = Math.min(255, m * 0.95 * 255);
        pixels[j + 2] = Math.min(255, m * 1.05 * 255);
        pixels[j + 3] = Math.min(255, m * 255);
    }
    ctx.putImageData(image, 0, 0);
    milkyWayCanvasCache = canvas;
    return canvas;
};

/** 星云纹理为白色（不依赖封面色），跨曲目共享；模块级缓存避免每次切歌重算。 */
const nebulaTextureCache = new Map<number, THREE.CanvasTexture>();

const makeNebulaTexture = (seed: number): THREE.CanvasTexture => {
    const cached = nebulaTextureCache.get(seed);
    if (cached) return cached;
    const size = 448;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(size, size);
    const pixels = image.data;
    const noiseDensity = makeValueNoise2D(seed);
    const noiseWarp = makeValueNoise2D(seed + 7919);
    const fbmDensity = makeFbm(noiseDensity, 5); // 高密度倍频：细云絮
    const fbmWarp = makeFbm(noiseWarp, 2);       // 低密度倍频：大尺度旋涡场
    for (let y = 0; y < size; y += 1) {
        const v = y / size - 0.5;
        for (let x = 0; x < size; x += 1) {
            const u = x / size - 0.5;
            // 域扭曲：采样坐标先被低频噪声场弯曲 → 丝状/旋涡结构
            const wx = u * 3.4 + (fbmWarp(u * 2.2 + 13.7, v * 2.2 + 5.1) - 0.5) * 1.5;
            const wy = v * 3.4 + (fbmWarp(u * 2.2 + 71.3, v * 2.2 + 29.8) - 0.5) * 1.5;
            // 密度场 + 对比度雕刻（阈值以下 = 透明空隙，之上收缩成云块）
            const raw = fbmDensity(wx + 3.1, wy + 8.4);
            const density = Math.pow(Math.max(0, (raw - 0.42) / 0.58), 1.55);
            // 径向遮罩：边缘半径受低频噪声扰动，羽化不规则
            const radius = Math.hypot(u, v) * 2;
            const edgeRadius = 0.78 + (fbmWarp(u * 1.6 + 41.2, v * 1.6 + 17.9) - 0.5) * 0.55;
            const mask = Math.min(1, Math.max(0, 1 - radius / Math.max(0.2, edgeRadius)));
            const shaped = mask * mask * (3 - 2 * mask);
            // 暗尘埃带：真实星云的丝状暗影——另一频段的扭曲噪声在特定带内削减密度
            const lane = Math.min(1, Math.max(0, (fbmWarp(u * 3.1 + 37.4, v * 3.1 + 11.8) - 0.56) / 0.3));
            const alpha = Math.min(1, density * shaped * 1.9 * (1 - lane * 0.65));
            // 内部冷暖色差：致密核心偏暖亮、稀薄边缘偏冷暗——
            // 白色贴图 × 单一材质色只能得到均匀一片，真实云气有自身的温度结构，
            // 乘上封面主色染色后这份冷暖差依然保留
            const warmth = Math.min(1, density * 1.6);
            const glowLevel = 0.55 + 0.45 * warmth;
            const idx = (y * size + x) * 4;
            pixels[idx] = Math.round(255 * (0.7 + 0.3 * warmth) * glowLevel);
            pixels[idx + 1] = Math.round(255 * (0.76 + 0.19 * warmth) * glowLevel);
            pixels[idx + 2] = Math.round(255 * (1.0 - 0.12 * warmth) * glowLevel);
            pixels[idx + 3] = Math.round(alpha * 255);
        }
    }
    ctx.putImageData(image, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    nebulaTextureCache.set(seed, tex);
    return tex;
};

interface NebulaLayerSpec {
    /** 纹理变体（0..3，同变体可多层复用）。 */
    variant: number;
    size: number;
    x: number;
    y: number;
    z: number;
    hShift: number;
    s: number;
    l: number;
    phase: number;
    opacity: number;
}

const NEBULA_LAYERS: NebulaLayerSpec[] = [
    { variant: 0, size: 62, x: -18, y: 6, z: -30, hShift: 0, s: 0.55, l: 0.33, phase: 0.3, opacity: 0.14 },
    { variant: 1, size: 92, x: 21, y: -4, z: -46, hShift: 0.09, s: 0.46, l: 0.27, phase: 1.1, opacity: 0.11 },
    { variant: 2, size: 112, x: -6, y: 13, z: -64, hShift: -0.07, s: 0.58, l: 0.36, phase: 2.0, opacity: 0.09 },
    { variant: 3, size: 54, x: 25, y: 9, z: -22, hShift: 0.14, s: 0.48, l: 0.3, phase: 2.8, opacity: 0.15 },
    { variant: 0, size: 76, x: -25, y: 14, z: -38, hShift: -0.12, s: 0.52, l: 0.32, phase: 3.5, opacity: 0.11 },
    { variant: 2, size: 46, x: 12, y: -8, z: -26, hShift: 0.05, s: 0.5, l: 0.29, phase: 4.2, opacity: 0.13 },
];

/** 星云层：多张 fBM 湍流云，滞后跟随相机（相机飞行时产生真实视差），
 * 逐层 billboard + 缓慢漂移 + 呼吸透明度；色相跟随封面主色。 */
const NebulaField: React.FC<{ accentColor: string }> = ({ accentColor }) => {
    const groupRef = useRef<THREE.Group>(null);
    const camera = useThree(state => state.camera);
    const layers = useMemo(() => {
        const source = new THREE.Color(accentColor);
        const hsl = { h: 0, s: 0, l: 0 };
        source.getHSL(hsl);
        const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
        const sat = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.5;
        return NEBULA_LAYERS.map(layer => {
            const color = new THREE.Color();
            color.setHSL((hue + layer.hShift + 1) % 1, Math.min(1, sat * layer.s), layer.l);
            return {
                ...layer,
                color: `#${color.getHexString()}`,
                texture: makeNebulaTexture(20260 + layer.variant * 977),
            };
        });
    }, [accentColor]);

    useFrame((state, delta) => {
        const group = groupRef.current;
        if (!group) return;
        const time = state.clock.elapsedTime;
        // 滞后跟随：云不钉死在相机上，而是缓缓追上——相机运镜/切歌飞行时有视差
        group.position.lerp(camera.position, 1 - Math.exp(-1.1 * Math.max(0.001, delta)));
        group.children.forEach((child, index) => {
            const layer = layers[index];
            const mesh = child as THREE.Mesh;
            if (!layer || !mesh) return;
            // 逐层缓慢漂移（各自相位），云气在"流动"而不是定格
            mesh.position.set(
                layer.x + Math.sin(time * 0.05 + layer.phase) * 2.6,
                layer.y + Math.cos(time * 0.041 + layer.phase * 1.7) * 1.8,
                layer.z + Math.sin(time * 0.033 + layer.phase * 2.3) * 1.4,
            );
            // billboard：星云无定形，始终面向相机
            mesh.lookAt(camera.position);
            const mat = mesh.material as THREE.MeshBasicMaterial;
            if (mat) mat.opacity = layer.opacity * (0.86 + 0.14 * Math.sin(time * 0.21 + layer.phase * 2.4));
        });
    });

    return (
        <group ref={groupRef}>
            {layers.map((layer, index) => (
                <mesh key={index} position={[layer.x, layer.y, layer.z]} scale={[layer.size, layer.size, 1]}>
                    <planeGeometry args={[1, 1]} />
                    <meshBasicMaterial
                        map={layer.texture}
                        color={layer.color}
                        transparent
                        opacity={layer.opacity}
                        blending={THREE.AdditiveBlending}
                        depthWrite={false}
                        fog={false}
                        toneMapped={false}
                    />
                </mesh>
            ))}
        </group>
    );
};

/** 走廊光轨：沿当前段路径的细管光带，给出走廊骨架/流动感。 */
const PathRail: React.FC<{ sequencer: SequencerState; accentColor: string }> = ({ sequencer, accentColor }) => {
    const latest = sequencer.segments[sequencer.segments.length - 1];
    const geometry = useMemo(() => {
        if (!latest || latest.frames.length < 2) return null;
        const points = latest.frames.map(frame => new THREE.Vector3(frame.position.x, frame.position.y, frame.position.z));
        const curve = new THREE.CatmullRomCurve3(points);
        return new THREE.TubeGeometry(curve, Math.max(4, points.length * 2), 0.05, 6, false);
        // 依赖 frames 数组引用：歌词晚到原位重建时换新 frames，光轨随之更新
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [latest, latest?.frames]);

    if (!geometry) return null;
    return (
        <mesh geometry={geometry}>
            <meshBasicMaterial color={accentColor} transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
    );
};

/** 地面雾光：走廊下方一大片极柔的发光地板（加法混合），色调跟随封面主色。
 * 位置跟随相机水平移动（原固定在世界原点，走廊蜿蜒飞远后雾光被抛下）。 */
const FloorMist: React.FC<{ accentColor: string }> = ({ accentColor }) => {
    const groupRef = useRef<THREE.Group>(null);
    const camera = useThree(state => state.camera);
    const texture = useMemo(() => {
        const source = new THREE.Color(accentColor);
        const hsl = { h: 0, s: 0, l: 0 };
        source.getHSL(hsl);
        const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
        const sat = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.5;
        const core = new THREE.Color();
        core.setHSL(hue, Math.min(1, sat * 0.7), 0.4);
        const mid = new THREE.Color();
        mid.setHSL(hue, Math.min(1, sat * 0.5), 0.32);
        const edge = new THREE.Color();
        edge.setHSL(hue, Math.min(1, sat * 0.4), 0.24);
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d')!;
        const gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
        gradient.addColorStop(0, `rgba(${core.r * 255},${core.g * 255},${core.b * 255},0.4)`);
        gradient.addColorStop(0.5, `rgba(${mid.r * 255},${mid.g * 255},${mid.b * 255},0.12)`);
        gradient.addColorStop(1, `rgba(${edge.r * 255},${edge.g * 255},${edge.b * 255},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 256, 256);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        return tex;
    }, [accentColor]);
    useFrame(() => {
        const group = groupRef.current;
        if (!group) return;
        // 跟随相机水平位置，始终铺在走廊下方
        group.position.set(camera.position.x, camera.position.y - 2.4, camera.position.z);
    });

    return (
        <group ref={groupRef}>
            <mesh position={[0, 0, -4]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[240, 240]} />
                <meshBasicMaterial map={texture} transparent opacity={0.09} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
            </mesh>
        </group>
    );
};

/** SpectrumFlanks / BeatRings 已抽到 ./dioramaSpectrum.tsx（音律可视化层，
 * 与歌词行渲染、氛围层解耦）。 */

/** 音乐进度灯：沿走廊在唱词位置之间推进的柔光点（歌曲走位的 3D 指示）。
 * 质感升级：原先是一颗 0.14 半径的实心球 + 0.25 幅度"弹跳"缩放 —— 廉价的 CG 小球。
 * 现改为面向相机的径向柔光面片（灯笼式光斑），呼吸幅度收敛，bloom 下自然泛光。 */
const ProgressOrb: React.FC<{ sequencer: SequencerState; globalIndex: number; currentTime: MotionValue<number>; accentColor: string }> = ({ sequencer, globalIndex, currentTime, accentColor }) => {
    const orbRef = useRef<THREE.Mesh>(null);
    const matRef = useRef<THREE.MeshBasicMaterial>(null);
    const camera = useThree(state => state.camera);
    const spriteTexture = useMemo(() => makeAuraTexture(128), []);

    useFrame(() => {
        const orb = orbRef.current;
        const mat = matRef.current;
        if (!orb || !mat) return;
        const resolved = resolveGlobal(sequencer, globalIndex);
        if (!resolved || !resolved.line) return;
        const now = currentTime.get();
        const line = resolved.line;
        const progress = now <= line.startTime ? 0 : now >= line.endTime ? 1 : (now - line.startTime) / Math.max(0.001, line.endTime - line.startTime);
        const next = resolveGlobal(sequencer, globalIndex + 1);
        const from = resolved.frame.position;
        const to = next?.frame.position ?? from;
        const t = Math.min(1, progress * 1.15);
        orb.position.set(
            from.x + (to.x - from.x) * t,
            from.y + (to.y - from.y) * t - 1.15,
            from.z + (to.z - from.z) * t,
        );
        orb.lookAt(camera.position);
        orb.scale.setScalar(0.9 * (1 + 0.16 * Math.sin(performance.now() * 0.0022)));
        mat.opacity = 0.3;
    });

    return (
        <mesh ref={orbRef}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial ref={matRef} map={spriteTexture} color={accentColor} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} fog={false} />
        </mesh>
    );
};

/** 背景天球：歌曲封面（强模糊）作背景 + 银河带，跟随相机（半径放进远平面内）。
 *
 * 背景策略（用户确认）：**封面即背景**——封面铺满画布宽度（方形封面上下裁切），
 * blur(14px) 软聚焦、原亮度，轮廓清晰可辨；天球贴图 2:1（1024×512）保证横向分辨率
 * （旧 1:2 贴图横向只有 1.4px/度，封面被球面摊得看不出轮廓——根因已修）。
 * 封面未加载/失败时用封面色系渐变兜底；封面存在时银河带强度减半；
 * 星星不画在天球上（由 StarShell 3D 星壳承担）。外链封面统一走 /api/cover 代理。
 */
const BackgroundGradient: React.FC<{ palette: BackgroundPalette; coverUrl?: string }> = ({ palette, coverUrl }) => {
    const meshRef = useRef<THREE.Mesh>(null);
    const camera = useThree(state => state.camera);
    const [coverImage, setCoverImage] = useState<HTMLImageElement | null>(null);

    // 异步加载封面：外链先经 /api/cover 代理（幂等），crossOrigin=anonymous 拿 CORS 头
    useEffect(() => {
        if (!coverUrl) {
            setCoverImage(null);
            return;
        }
        const loadUrl = /^https?:/i.test(coverUrl) ? (getProxiedImageUrl(coverUrl, 800) || coverUrl) : coverUrl;
        let cancelled = false;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (!cancelled && img.naturalWidth > 0) setCoverImage(img);
        };
        img.onerror = () => {
            if (!cancelled) setCoverImage(null);
        };
        img.src = loadUrl;
        return () => { cancelled = true; };
    }, [coverUrl]);

    const texture = useMemo(() => {
        const width = SKY_TEX_W;
        const height = SKY_TEX_H;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        // 主渐变：封面色系（上部较亮 → 地平线 → 深底）
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, palette.top);
        gradient.addColorStop(0.3, palette.upper);
        gradient.addColorStop(0.5, palette.horizon);
        gradient.addColorStop(0.68, palette.lower);
        gradient.addColorStop(1, palette.bottom);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        // 封面即背景（用户要求：封面轮廓要能认出来）：
        // 封面铺满画布宽度（方形封面上下裁到 2:1 画布内，主体居中保留），
        // blur(14px) 只做软聚焦，不再摊没轮廓；saturate(1.1) 保色彩；
        // brightness(0.62) 压暗上限：部分封面局部过亮（如左半亮区）会击穿 bloom 阈值导致画面闪白，
        // 压暗后封面仍可辨但不再过曝。封面未加载/失败时渐变兜底。
        if (coverImage) {
            ctx.save();
            ctx.filter = 'blur(14px) saturate(1.1) brightness(0.62)';
            const drawW = width;
            const drawH = width; // 方形封面：铺满宽，垂直居中裁切（球面竖向跨度 180° 由 2:1 画布承接）
            ctx.drawImage(coverImage, 0, (height - drawH) / 2, drawW, drawH);
            ctx.restore();
        }
        // 地平线舞台辉光（中带略亮，强度收敛——深空为主）
        const [gr, gg, gb] = hexToRgb(palette.glow);
        const glow = ctx.createRadialGradient(width / 2, height * 0.5, 16, width / 2, height * 0.5, height * 0.46);
        glow.addColorStop(0, `rgba(${gr},${gg},${gb},0.38)`);
        glow.addColorStop(0.5, `rgba(${gr},${gg},${gb},0.12)`);
        glow.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);
        // 银河带：预渲染 canvas + drawImage('lighter') 合成，替代原 524k 像素 JS 循环。
        // 封面存在时银河带强度减半——用户要封面清晰可辨，斜向亮带别压过封面。
        // 去色带噪声省略：fBM 带本身平滑，且浏览器 2D 上下文对渐变已做 dither，post-bloom 进一步抹平。
        const milkyCanvas = getMilkyWayCanvas();
        const milkyGain = coverImage ? 20 : 44;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = milkyGain / 255;
        ctx.drawImage(milkyCanvas, 0, 0);
        ctx.restore();
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        return tex;
    }, [palette, coverImage]);

    // 封面/调色板变化会重建纹理：旧纹理及时释放
    useEffect(() => () => {
        texture.dispose();
    }, [texture]);

    useFrame(() => {
        const mesh = meshRef.current;
        if (!mesh) return;
        // 跟随相机：球心在相机位置，半径 130 < far 140，保证始终可见
        mesh.position.copy(camera.position);
    });

    return (
        <mesh ref={meshRef} scale={[130, 130, 130]}>
            <sphereGeometry args={[1, 32, 20]} />
            <meshBasicMaterial map={texture} side={THREE.BackSide} fog={false} depthWrite={false} toneMapped={false} />
        </mesh>
    );
};

/** 3D 星壳：替代"画在天球贴图上的星星"。
 * 点云均匀分布在大球面上（刚性跟随相机 = 无穷远，无视差才正确），圆软点 sprite、
 * 无球面极区拉伸；亮度按真实星等分布——大量暗星 + 少量亮星两层，
 * 最亮的一层进入 bloom 阈值泛出轻微星芒。远景星不闪烁（大气闪烁只在穿过大气层时发生）。 */
const StarShell: React.FC = () => {
    const groupRef = useRef<THREE.Group>(null);
    const camera = useThree(state => state.camera);
    const spriteTexture = useMemo(() => makeStarSpriteTexture(64), []);
    const clouds = useMemo(() => {
        const build = (count: number, radiusSeed: number, magFloor: number, magRange: number) => {
            const positions = new Float32Array(count * 3);
            const colors = new Float32Array(count * 3);
            for (let i = 0; i < count; i += 1) {
                // 球面均匀分布：cosθ 线性采样 + 方位角
                const cosTheta = seededUnit(i * 3 + radiusSeed) * 2 - 1;
                const phi = seededUnit(i * 3 + radiusSeed + 1) * Math.PI * 2;
                const radius = 103 + seededUnit(i * 3 + radiusSeed + 2) * 23;
                const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
                positions[i * 3] = sinTheta * Math.cos(phi) * radius;
                positions[i * 3 + 1] = cosTheta * radius;
                positions[i * 3 + 2] = sinTheta * Math.sin(phi) * radius;
                // 星等：幂分布——暗星多、亮星少
                const magnitude = Math.pow(seededUnit(i * 5 + radiusSeed * 2 + 4), 2.2);
                const brightness = magFloor + magnitude * magRange;
                const kind = seededUnit(i * 5 + radiusSeed * 2 + 5);
                // 少数暖星/蓝星，多数中性白（真实恒星色温分布的简化）
                const tint = kind > 0.87 ? [1, 0.84, 0.68] : kind > 0.7 ? [0.74, 0.82, 1] : [0.92, 0.94, 1];
                colors[i * 3] = tint[0] * brightness;
                colors[i * 3 + 1] = tint[1] * brightness;
                colors[i * 3 + 2] = tint[2] * brightness;
            }
            return { positions, colors };
        };
        return {
            dim: build(720, 11, 0.24, 0.5),
            bright: build(230, 29, 0.72, 0.55),
        };
    }, []);

    useFrame(() => {
        const group = groupRef.current;
        if (!group) return;
        // 刚性跟随：星在"无穷远"，与天球同步，不滞后
        group.position.copy(camera.position);
    });

    return (
        <group ref={groupRef}>
            <points>
                <bufferGeometry>
                    <bufferAttribute attach="attributes-position" args={[clouds.dim.positions, 3]} />
                    <bufferAttribute attach="attributes-color" args={[clouds.dim.colors, 3]} />
                </bufferGeometry>
                <pointsMaterial
                    map={spriteTexture}
                    size={0.62}
                    transparent
                    opacity={0.9}
                    sizeAttenuation
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    vertexColors
                    toneMapped={false}
                    fog={false}
                />
            </points>
            <points>
                <bufferGeometry>
                    <bufferAttribute attach="attributes-position" args={[clouds.bright.positions, 3]} />
                    <bufferAttribute attach="attributes-color" args={[clouds.bright.colors, 3]} />
                </bufferGeometry>
                <pointsMaterial
                    map={spriteTexture}
                    size={1.35}
                    transparent
                    opacity={0.95}
                    sizeAttenuation
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    vertexColors
                    toneMapped={false}
                    fog={false}
                />
            </points>
        </group>
    );
};

/** 星河粒子：粒子沿 -z 走廊方向流动、绕回，逐粒亮度闪烁（种子驱动），双色系；随音乐律动加速/增亮，切歌飞行时疾驰。
 *
 * 质感升级：
 * - 圆软点 sprite + 加法混合（原 pointsMaterial 无 map 渲染为方块，廉价感主因之一）；
 *   亮粒在 HalfFloat 管线里积累 >1.0，经 bloom 泛出星芒。
 * - 粒子域跟随相机位置（原粒子域固定在世界原点附近，相机沿走廊飞远后整片星河被抛在身后，
 *   歌曲中后段背景空无一物）。
 * - GPU 漂移：drift / 绕回 / twinkle / 双色系全在顶点着色器里算（与 FormationParticles 同模式），
 *   CPU 每帧零循环、零缓冲上传，只写 4 个 uniform。
 */
const STAR_RIVER_VERTEX = /* glsl */`
attribute float aSeed;
uniform float uTime;
uniform float uFlowBoost;
uniform float uTwinkleBoost;
uniform float uScale;
varying vec3 vColor;
void main() {
    // 起点 startZ = -50 - seed*10，越过 +4 即绕回；range = 54 + seed*10
    float startZ = -50.0 - aSeed * 10.0;
    float range = 54.0 + aSeed * 10.0;
    float speed = 2.6 + aSeed * 5.4;
    vec3 pos = position;
    // position.z - startZ 是初始相位偏移；uTime 项线性累加，mod 自带绕回
    pos.z = startZ + mod(position.z - startZ + uTime * speed * uFlowBoost, range);
    // 逐粒闪烁 + 双色系（冷蓝白 / 暖金），加法混合下亮粒进入 HDR 区间
    float twinkle = 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 1.6) + aSeed * 40.0));
    float warm = step(0.78, aSeed);
    vec3 base = mix(vec3(0.6, 0.68, 1.0), vec3(1.0, 0.86, 0.72), warm);
    float level = min(1.25, twinkle * uTwinkleBoost);
    vColor = base * level;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = 0.17 * (uScale / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const STAR_RIVER_FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3 vColor;
void main() {
    float mask = texture2D(uMap, gl_PointCoord).a;
    if (mask < 0.02) discard;
    gl_FragColor = vec4(vColor, mask * uOpacity);
}
`;

const StarRiver: React.FC<{ count?: number; pulseStore: AudioPulseStore; flightActive: boolean }> = ({ count = 380, pulseStore, flightActive }) => {
    const groupRef = useRef<THREE.Group>(null);
    const camera = useThree(state => state.camera);
    const spriteTexture = useMemo(() => makeStarSpriteTexture(64), []);

    const { geometry, material } = useMemo(() => {
        const positions = new Float32Array(count * 3);
        const seeds = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
            const u = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
            const v = Math.abs((Math.sin(i * 78.233) * 43758.5453) % 1);
            const w = Math.abs((Math.sin(i * 39.71) * 43758.5453) % 1);
            seeds[i] = w;
            positions[i * 3] = (u - 0.5) * 46;
            positions[i * 3 + 1] = (v - 0.32) * 15;
            positions[i * 3 + 2] = -2 - w * 50;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
        const mat = new THREE.ShaderMaterial({
            vertexShader: STAR_RIVER_VERTEX,
            fragmentShader: STAR_RIVER_FRAGMENT,
            uniforms: {
                uMap: { value: spriteTexture },
                uTime: { value: 0 },
                uFlowBoost: { value: 1 },
                uTwinkleBoost: { value: 1 },
                uScale: { value: 400 },
                uOpacity: { value: 0.8 },
            },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        return { geometry: geo, material: mat };
    }, [count, spriteTexture]);

    // geometry/材质为命令式创建（不经 R3F 自动 dispose），统一手动释放
    useEffect(() => () => {
        geometry.dispose();
        material.dispose();
    }, [geometry, material]);

    useFrame((state) => {
        const group = groupRef.current;
        if (!group) return;
        // 粒子域锚在相机上：走廊飞多远，星河跟多远
        group.position.copy(camera.position);
        const pulse = pulseStore.getSnapshot();
        // 音律 + 飞行加速
        material.uniforms.uTime.value = state.clock.elapsedTime;
        material.uniforms.uFlowBoost.value = 1 + pulse.scale * 5 + (flightActive ? 1.7 : 0);
        material.uniforms.uTwinkleBoost.value = 1 + pulse.scale * 2.5;
        material.uniforms.uScale.value = state.size.height * state.gl.getPixelRatio() * 0.5;
    });

    return (
        <group ref={groupRef}>
            <points geometry={geometry} material={material} />
        </group>
    );
};

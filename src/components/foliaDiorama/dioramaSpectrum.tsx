/**
 * Diorama 音律可视化层 —— 频谱双翼 + 节拍脉冲环。
 *
 * 从 DioramaScene.tsx 抽离：两者只依赖 props 与 cameraPath / dioramaSequencer /
 * useAudioAnalyzer 已有导出，与主场景的歌词行渲染、氛围层完全解耦，可独立维护。
 * 逻辑零改动 —— 仅搬位置不改行为。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
    composeLocal,
    getDioramaTextPlacement,
    type DioramaMotionParams,
} from './cameraPath';
import { resolveGlobal, type SequencerState } from './dioramaSequencer';
import {
    ANALYZER_SPECTRUM_BANDS,
    type AudioAnalyzerStore,
} from '../../hooks/useAudioAnalyzer';

const SPECTRUM_FLANK_BARS = 32;
const SPECTRUM_BAR_W = 0.105;
const SPECTRUM_BAR_GAP = 0.014;
/** 柱阵内侧边缘距歌词中线的横向距离（避开最长行的 72% 帧宽取景）。 */
const SPECTRUM_FLANK_LATERAL = 4.7;
/** 柱阵在文字平面之后的深度（沿路径 forward，相机一侧的反面）。 */
const SPECTRUM_FLANK_DEPTH = 0.9;

export const SpectrumFlanks: React.FC<{
    sequencer: SequencerState;
    globalIndex: number;
    motion: DioramaMotionParams;
    analyzerStore: AudioAnalyzerStore;
    accentColor: string;
}> = ({ sequencer, globalIndex, motion, analyzerStore, accentColor }) => {
    const resolved = useMemo(() => resolveGlobal(sequencer, globalIndex), [sequencer, globalIndex]);
    const placement = useMemo(
        () => getDioramaTextPlacement(resolved?.localIndex ?? 0, resolved?.segment.seed, motion.weaveScale),
        [resolved, motion.weaveScale],
    );
    const white = useMemo(() => new THREE.Color('#ffffff'), []);
    const tmpColor = useMemo(() => new THREE.Color(), []);
    // 封面主题色 → 频谱两端：低频深主题色，高频亮主题色（同色系 +0.08 微移相）
    const bandPalette = useMemo(() => {
        const source = new THREE.Color(accentColor);
        const hsl = { h: 0, s: 0, l: 0 };
        source.getHSL(hsl);
        const hue = Number.isFinite(hsl.h) ? hsl.h : 0.66;
        const sat = Number.isFinite(hsl.s) && hsl.s > 0.04 ? hsl.s : 0.5;
        return {
            deep: new THREE.Color().setHSL(hue, Math.min(1, sat * 0.95 + 0.05), 0.5),
            bright: new THREE.Color().setHSL((hue + 0.08) % 1, Math.min(1, sat * 1.1 + 0.08), 0.74),
        };
    }, [accentColor]);

    // 布局 + 材质（随活动行/主题色重建；行变化时 mesh 随 key 重挂，材质由 effect 释放）
    const bars = useMemo(() => {
        if (!resolved || !resolved.line?.fullText) return [];
        const step = SPECTRUM_BAR_W + SPECTRUM_BAR_GAP;
        const list: Array<{ px: number; py: number; pz: number; bandFrac: number; mat: THREE.MeshBasicMaterial }> = [];
        for (let side = -1; side <= 1; side += 2) {
            for (let i = 0; i < SPECTRUM_FLANK_BARS; i += 1) {
                // 从内到外排布：内侧低频 → 外侧高频（两侧对称镜像）
                const lateral = SPECTRUM_FLANK_LATERAL + (i + 0.5) * step;
                const bandFrac = i / (SPECTRUM_FLANK_BARS - 1);
                const mat = new THREE.MeshBasicMaterial({
                    color: bandPalette.deep.clone().lerp(bandPalette.bright, bandFrac),
                    transparent: true,
                    opacity: 0.14,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                    toneMapped: false,
                    fog: false,
                });
                const p = composeLocal(
                    resolved.frame,
                    side * lateral,
                    (placement.offsetU ?? 0) - 0.55,
                    SPECTRUM_FLANK_DEPTH,
                );
                list.push({ px: p.x, py: p.y, pz: p.z, bandFrac, mat });
            }
        }
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolved, placement, bandPalette]);

    const meshRefs = useRef<Array<THREE.Mesh | null>>([]);
    const smoothRef = useRef<Float32Array>(new Float32Array(0));

    // 行变化重建柱阵：平滑缓存清零、旧材质释放
    useEffect(() => {
        smoothRef.current = new Float32Array(bars.length);
        return () => {
            bars.forEach(bar => bar.mat.dispose());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bars]);

    useFrame((state, delta) => {
        const smooth = smoothRef.current;
        if (smooth.length !== bars.length) return;
        const analysis = analyzerStore.getSnapshot();
        const spectrum = analysis.spectrum;
        const beat = analysis.beat;
        const dt = Math.max(0.001, delta);
        const attack = 1 - Math.exp(-20 * dt); // 起音更快（原 -16）—— 更跟手，节拍瞬间柱子瞬间起跳
        const release = 1 - Math.exp(-5 * dt); // 落音慢（余韵）
        const time = state.clock.elapsedTime;
        for (let index = 0; index < bars.length; index += 1) {
            const mesh = meshRefs.current[index];
            const bar = bars[index];
            if (!mesh || !bar) continue;
            // 24 段对数频谱 → 32 根柱：按 bandFrac 线性插值上采样
            const pos = bar.bandFrac * (ANALYZER_SPECTRUM_BANDS - 1);
            const i0 = Math.floor(pos);
            const i1 = Math.min(ANALYZER_SPECTRUM_BANDS - 1, i0 + 1);
            const frac = pos - i0;
            const e0 = spectrum && spectrum.length > i0 ? spectrum[i0] : 0;
            const e1 = spectrum && spectrum.length > i1 ? spectrum[i1] : 0;
            const energy = e0 * (1 - frac) + e1 * frac;
            // 分析器未启用（频谱全零）时保留轻柔闲置微光波，场景不死寂
            const idle = 0.05 + 0.04 * Math.sin(time * (0.7 + bar.bandFrac * 0.9) + index * 0.31);
            // 节拍增益 0.35 → 0.5：节拍时柱子跳得更高（更激进）
            const target = Math.min(1, Math.max(energy, idle) * (1 + beat * 0.5));
            const prev = smooth[index];
            smooth[index] = prev + (target - prev) * (target > prev ? attack : release);
            const level = smooth[index];
            // 高度增益 4.0 → 5.0：柱子整体高 25%（更激进）
            const height = 0.3 + level * 5.0;
            mesh.scale.y = height;
            mesh.position.y = bar.py + height * 0.5;
            const mat = bar.mat;
            // 白光提亮 0.35 → 0.45：高能时柱子更接近白热（更激进）
            tmpColor.copy(bandPalette.deep).lerp(bandPalette.bright, bar.bandFrac).lerp(white, level * 0.45);
            mat.color.copy(tmpColor);
            // opacity 峰值 0.22+0.6 → 0.28+0.65：柱子更亮（更激进）
            mat.opacity = 0.28 + level * 0.65;
        }
    });

    if (bars.length === 0) return null;
    return (
        <group>
            {bars.map((bar, index) => (
                <mesh
                    key={index}
                    ref={(m) => { meshRefs.current[index] = m; }}
                    position={[bar.px, bar.py, bar.pz]}
                    renderOrder={0}
                >
                    <boxGeometry args={[SPECTRUM_BAR_W, 1, SPECTRUM_BAR_W]} />
                    <primitive object={bar.mat} attach="material" />
                </mesh>
            ))}
        </group>
    );
};

/** 节拍脉冲环：重拍到来时，从当前歌词处扩散一圈光环。
 * 质感升级：环面始终朝向相机（billboard，原先平躺在世界 XY 面，多数角度只能看到一条线），
 * 更细的环体 + 更慢更大的扩散 + (1-t)^1.6 衰减，读作"空间里荡开的涟漪"而非弹出的圆环。 */
export const BeatRings: React.FC<{ sequencer: SequencerState; globalIndex: number; analyzerStore: AudioAnalyzerStore; accentColor: string }> = ({ sequencer, globalIndex, analyzerStore, accentColor }) => {
    const POOL_SIZE = 6;
    const camera = useThree(state => state.camera);
    const slots = useRef<Array<{ mesh: THREE.Mesh | null; mat: THREE.MeshBasicMaterial | null; start: number }>>(
        Array.from({ length: POOL_SIZE }, () => ({ mesh: null, mat: null, start: 0 })),
    );
    const prevBeatRef = useRef(0);
    const cursorRef = useRef(0);

    useFrame(() => {
        const analysis = analyzerStore.getSnapshot();
        const now = performance.now() / 1000;
        // 触发阈值 0.55 → 0.5：更易触发（更激进）—— 中等拍也能炸环
        const triggered = analysis.beat > 0.5 && prevBeatRef.current <= 0.5;
        prevBeatRef.current = analysis.beat;
        const resolved = resolveGlobal(sequencer, globalIndex);
        if (triggered && resolved) {
            const slot = slots.current[cursorRef.current % POOL_SIZE];
            cursorRef.current += 1;
            if (slot?.mesh && slot.mat) {
                slot.mesh.position.set(resolved.frame.position.x, resolved.frame.position.y, resolved.frame.position.z);
                // 起始 scale 0.5 → 0.7：环起始更大（更激进）
                slot.mesh.scale.setScalar(0.7);
                // 起始 opacity 0.34 → 0.45：环更亮（更激进）
                slot.mat.opacity = 0.45;
                slot.start = now;
            }
        }
        for (const slot of slots.current) {
            if (!slot?.mesh || !slot.mat || slot.start <= 0) continue;
            const age = now - slot.start;
            const t = age / 1.6;
            if (t >= 1) {
                slot.mat.opacity = 0;
                slot.start = 0;
                continue;
            }
            slot.mesh.lookAt(camera.position);
            // 扩散范围 0.5+4.6t → 0.7+5.5t：环扩得更远（更激进）
            slot.mesh.scale.setScalar(0.7 + t * 5.5);
            slot.mat.opacity = 0.45 * Math.pow(1 - t, 1.6);
        }
    });

    return (
        <group>
            {slots.current.map((_, index) => (
                <mesh key={index} ref={(mesh) => { slots.current[index].mesh = mesh; }}>
                    {/* 环厚度 0.02 → 0.03：环更粗（更激进） */}
                    <torusGeometry args={[1, 0.03, 8, 64]} />
                    <meshBasicMaterial
                        ref={(mat) => { slots.current[index].mat = mat; }}
                        color={accentColor}
                        transparent
                        opacity={0}
                        blending={THREE.AdditiveBlending}
                        depthWrite={false}
                        side={THREE.DoubleSide}
                        toneMapped={false}
                    />
                </mesh>
            ))}
        </group>
    );
};

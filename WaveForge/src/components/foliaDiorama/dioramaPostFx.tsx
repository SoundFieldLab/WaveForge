/**
 * folia Diorama 后期管线：RenderPass + UnrealBloom + OutputPass。
 *
 * 为什么必须加 bloom：场景里所有"发光"元素（文字光晕、舞台柔光、星河、阵型边缘、
 * 节拍环）此前都是 LDR 加法混合贴图——亮度封顶在 1.0，观感是"灰白的半透明贴片"，
 * 这是整个模式廉价感的核心来源。接入 UnrealBloom 后：
 *   1. 渲染目标升级为 HalfFloat，加法混合可以累积出 >1.0 的真 HDR 亮度；
 *   2. 超过 threshold 的像素（已唱白的歌词、光晕、星点）向外泛出柔和辉光，
 *      "发光体真的在发光"，画面层次立刻拉开。
 *
 * 实现说明：
 * - 不引入 @react-three/postprocessing（本机无法装新依赖），直接用 three 自带的
 *   examples/jsm 模块手写 composer；useFrame 优先级 1 接管渲染。
 * - Canvas 侧需配 `flat`（NoToneMapping）：OutputPass 按渲染器状态做色调映射/
 *   sRGB 输出，NoToneMapping 保证 bloom 前后的色彩与原先直出一致，不发灰。
 * - 渲染目标带 MSAA（samples），弥补离开默认帧缓冲后丢失的多重采样抗锯齿。
 */
import React, { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface DioramaPostFxProps {
    /** 辉光总强度（默认 0.5：克制的氛围辉光，不做霓虹轰炸）。 */
    strength?: number;
    /** 辉光扩散半径。 */
    radius?: number;
    /** 亮度门槛：只有超过它的像素参与泛光（白歌词/加法光晕过线，暗部不过线）。 */
    threshold?: number;
}

const DioramaPostFx: React.FC<DioramaPostFxProps> = ({ strength = 0.28, radius = 0.45, threshold = 0.85 }) => {
    const gl = useThree(state => state.gl);
    const scene = useThree(state => state.scene);
    const camera = useThree(state => state.camera);
    const size = useThree(state => state.size);

    const composer = useMemo(() => {
        // HalfFloat 渲染目标：加法混合累积可超过 1.0，bloom 才有 HDR 可提
        const target = new THREE.WebGLRenderTarget(size.width, size.height, {
            type: THREE.HalfFloatType,
            samples: 4,
        });
        const next = new EffectComposer(gl, target);
        next.setPixelRatio(gl.getPixelRatio());
        next.setSize(size.width, size.height);
        next.addPass(new RenderPass(scene, camera));
        const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), strength, radius, threshold);
        next.addPass(bloom);
        next.addPass(new OutputPass());
        return next;
        // gl/scene/camera 在单个 Canvas 生命周期内稳定；Canvas 重建（webgl 恢复）时组件整体重挂载
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 视口变化：同步 composer 与各 pass 的尺寸
    useEffect(() => {
        composer.setPixelRatio(gl.getPixelRatio());
        composer.setSize(size.width, size.height);
    }, [composer, gl, size]);

    // 参数热更新
    useEffect(() => {
        const bloom = composer.passes.find(pass => pass instanceof UnrealBloomPass) as UnrealBloomPass | undefined;
        if (!bloom) return;
        bloom.strength = strength;
        bloom.radius = radius;
        bloom.threshold = threshold;
    }, [composer, strength, radius, threshold]);

    // 卸载清理：composer/渲染目标/各 pass 全量 dispose
    useEffect(() => () => {
        composer.dispose();
    }, [composer]);

    // 优先级 1：接管渲染，R3F 不再直出默认帧缓冲
    useFrame(() => {
        composer.render();
    }, 1);

    return null;
};

export default DioramaPostFx;

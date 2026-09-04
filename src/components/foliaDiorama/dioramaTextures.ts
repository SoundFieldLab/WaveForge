/**
 * folia Diorama 共享程序化纹理工具。
 *
 * 统一生成"软粒子/径向柔光"类 CanvasTexture：
 * - 星河粒子需要圆形软点（pointsMaterial 无 map 时渲染为方块，是画面廉价感的主因之一）；
 * - 进度灯/舞台光晕需要径向柔光面片。
 * 全部禁用 mipmap（透明画布做 mip 会把透明黑平均进边缘，产生暗晕），Linear 采样即可。
 */
import * as THREE from 'three';

export interface RadialStop {
    /** 0..1 半径位置。 */
    at: number;
    /** 该处的不透明度（颜色固定为白，由材质 color 染色）。 */
    alpha: number;
}

/**
 * 生成一张 size×size 的径向渐变软点纹理（白→透明），供粒子/光晕/光点共用。
 * stops 从中心向外描述透明度衰减曲线。
 */
export const makeRadialTexture = (size: number, stops: RadialStop[]): THREE.CanvasTexture => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, Math.max(1, size * 0.02), half, half, half);
    for (const stop of stops) {
        gradient.addColorStop(Math.min(1, Math.max(0, stop.at)), `rgba(255,255,255,${Math.min(1, Math.max(0, stop.alpha)).toFixed(3)})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
};

/** 星河/尘埃用的圆形软点：亮核 + 柔和外圈（比纯线性衰减更接近镜头光斑的观感）。 */
export const makeStarSpriteTexture = (size = 64): THREE.CanvasTexture =>
    makeRadialTexture(size, [
        { at: 0, alpha: 1 },
        { at: 0.22, alpha: 0.82 },
        { at: 0.5, alpha: 0.28 },
        { at: 0.78, alpha: 0.07 },
        { at: 1, alpha: 0 },
    ]);

/** 大范围柔光（舞台光晕/进度灯）：中心略收敛，避免过曝白核。 */
export const makeAuraTexture = (size = 256): THREE.CanvasTexture =>
    makeRadialTexture(size, [
        { at: 0, alpha: 0.85 },
        { at: 0.45, alpha: 0.3 },
        { at: 1, alpha: 0 },
    ]);

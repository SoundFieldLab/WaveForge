export type GpuFeatureStatus = {
  gpu_compositing?: string
  webgl?: string
} | null | undefined

export function isGpuSoftwareCompositing(featureStatus: GpuFeatureStatus): boolean {
  return featureStatus?.gpu_compositing === 'disabled_software'
    || featureStatus?.gpu_compositing === 'disabled'
    || featureStatus?.webgl === 'disabled_software'
    || featureStatus?.webgl === 'disabled'
}

export function resolveMvBackgroundQuality(): number {
  // The server negotiates the actual stream against the account's accepted qualities.
  // 112 yields 1080P+ for eligible members and automatically falls back to 1080P.
  return 112
}

export function resolveDioramaRenderQuality({
  mvBackgroundActive,
  gpuSoftwareCompositing,
}: {
  mvBackgroundActive: boolean
  gpuSoftwareCompositing: boolean
}) {
  if (gpuSoftwareCompositing) {
    return { dpr: [1, 1] as [number, number], postFx: false, lightweightScene: true }
  }
  if (mvBackgroundActive) {
    return { dpr: [1, 1.25] as [number, number], postFx: false, lightweightScene: true }
  }
  // 高分屏（物理高度 >1440，如 4K）封顶 dpr 上限到 1.5：全屏 Canvas + UnrealBloom
  // 在 4K×dpr2 下 ≈3300 万像素/帧 × bloom 多 pass，是中端 GPU 上唯一可能打满 GPU
  // 预算的单项。画面密度损失在整屏 3D 场景下不可感知（与 ModernFluidBackground 的
  // 960×540 硬封顶同一思路，只是 Diorama 是主视觉故留更高上限）。
  const physicalHeight = typeof window !== 'undefined' ? (window.screen?.height || 0) * (window.devicePixelRatio || 1) : 0
  if (physicalHeight > 1440) {
    return { dpr: [1, 1.5] as [number, number], postFx: true, lightweightScene: false }
  }
  return { dpr: [1, 2] as [number, number], postFx: true, lightweightScene: false }
}

export function clampMvBlur(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}

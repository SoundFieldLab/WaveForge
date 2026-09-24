import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8').replace(/\r\n/g, '\n')

/**
 * DJTransGAN 学到的推子/EQ 曲线复用到 v2 短过渡。
 *
 * 这条链路曾完整可用（运行时日志中 aimix:automation 有 177 次成功记录），
 * 后来 TS 侧调用点被移除，导致 render_worker.py 里等待 automation 的分支
 * 永不执行（len(automation) != 2 恒真）。以下契约把断点固定住。
 */
describe('AutoMix learned automation wiring', () => {
  it('exposes the automation bridge across main process, preload and renderer types', () => {
    const runtime = read('desktop/render-runtime.cjs')
    const preload = read('desktop/preload.cjs')
    const types = read('src/electron.d.ts')

    expect(runtime).toContain("ipcMain.handle('render:aiMixAutomation'")
    expect(runtime).toContain('async getAutomation(plan, sourceAudioPath, targetAudioPath)')
    expect(preload).toContain('aiMixAutomation: (plan, sourceAudioPath, targetAudioPath) =>')
    expect(preload).toContain("ipcRenderer.invoke('render:aiMixAutomation'")
    expect(types).toContain('aiMixAutomation?: (plan: TransitionPlan, sourceAudioPath: string, targetAudioPath: string)')
  })

  it('calls the automation bridge from the renderer instead of leaving it undefined', () => {
    const renderer = read('src/audio/TransitionRenderer.ts')

    expect(renderer).toContain('const fetchAutomation = renderBridge.aiMixAutomation')
    expect(renderer).toContain('await fetchAutomation(renderPlan, sourceRenderPath, targetRenderPath)')
    expect(renderer).toContain('automation: automation.params')
    // 注入点必须在 full-mix 渲染之前，否则渲染读不到
    expect(renderer).toContain('await attachLearnedAutomation()')
  })

  it('never injects automation into a stem-owned transition', () => {
    const renderer = read('src/audio/TransitionRenderer.ts')

    // folia / stemArtifacts 路径由 stem choreography 拥有过渡，worker 会忽略 automation
    expect(renderer).toContain("if (renderPlan.v2?.backend === 'folia-htdemucs' || renderPlan.v2?.stemArtifacts) return")
    expect(renderer).toContain("if (plan.v2?.aiMix !== true || !djAvailable) return")
  })

  it('keeps the worker consuming the learned automation shape', () => {
    const worker = read('desktop/workers/render_worker.py')

    expect(worker).toContain("automation = (plan.get('v2') or {}).get('automation') or []")
    expect(worker).toContain('if len(automation) == 2 and automation[0].get(\'fader\') and automation[1].get(\'fader\'):')
    expect(worker).toContain("apply_learned_automation(source_stretched, output_sample_rate, automation[0], 'fo')")
    expect(worker).toContain("apply_learned_automation(target_stretched, output_sample_rate, automation[1], 'fi')")
  })

  it('keeps the extracted params shape aligned with the planner type', () => {
    const worker = read('desktop/workers/djtransgan_worker.py')
    const types = read('src/audio/types.ts')

    expect(worker).toContain("'band': render_params[i]['band']")
    expect(worker).toContain("'fader': render_params[i]['fader']")
    expect(types).toContain('automation?: Array<{ band: number[][][]; fader: number[][][][] }>')
  })

  it('reconstructs the full spectrum when splitting bands', () => {
    const worker = read('desktop/workers/render_worker.py')

    // 互补级联结构：每段低通后剩下的残差再进下一级，保证各段求和精确重建原信号。
    // 早期实现各段独立滤波后相加，mid_high(HP5k+LP20k) 与 high(HP5k) 完全重叠，
    // 求和 RMS 达原信号 1.46 倍。
    expect(worker).toContain('def _lr_filter(audio: np.ndarray, sample_rate: int, cutoff: float, btype: str) -> np.ndarray:')
    expect(worker).toContain("bands.append(_lr_filter(carry, sample_rate, boundary, 'lowpass'))")
    expect(worker).toContain("carry = _lr_filter(carry, sample_rate, boundary, 'highpass')")
    expect(worker).not.toContain("mid_high = filtered(filtered(audio, sample_rate, 5000, 'highpass'), sample_rate, 20000, 'lowpass')")
  })
})

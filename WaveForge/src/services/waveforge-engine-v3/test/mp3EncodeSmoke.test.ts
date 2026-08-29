/**
 * HSE 离线 MP3 导出 —— 编码链冒烟测试
 *
 * 锁定根因修复：lamejs 1.2.1 以 UMD 全家桶假设编写（Lame.js/BitStream.js 裸引用
 * MPEGMode 等全局标识符），Vite/vite-node 打包后构造 Mp3Encoder 必抛
 * ReferenceError——attachV3Engine 的 ensureLameEncoder 补丁（深导入三子模块挂
 * globalThis）必须让真实编码全流程跑通。
 *
 * // @vitest-environment jsdom（无 DOM 需求，仅与引擎 UI 测试同环境约定）
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { ensureLameEncoder } from '../attachV3Engine'

describe('HSE 离线导出 · lamejs 打包器兼容补丁', () => {
  it('Mp3Encoder 可构造且零输入编码产出非空 MP3 帧（不抛 MPEGMode ReferenceError）', async () => {
    const Encoder = await ensureLameEncoder()
    const encoder = new Encoder(2, 48000, 128)
    const silence = new Int16Array(1152 * 10)
    let bytes = 0
    for (let i = 0; i < 10; i += 1) {
      const chunk = encoder.encodeBuffer(silence.subarray(i * 1152, (i + 1) * 1152), silence.subarray(i * 1152, (i + 1) * 1152))
      bytes += chunk.length
    }
    const tail = encoder.flush()
    bytes += tail.length
    expect(bytes).toBeGreaterThan(0)
  })

  it('补丁幂等：二次获取返回同一构造器（globalThis 已挂载不重复覆盖）', async () => {
    const a = await ensureLameEncoder()
    const b = await ensureLameEncoder()
    expect(b).toBe(a)
  })
})

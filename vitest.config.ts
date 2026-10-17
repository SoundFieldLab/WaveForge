import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    // v3 引擎 UI 冒烟测试为 .tsx（react-jsx，与主 tsconfig 一致）
    jsx: 'automatic',
  },
  test: {
    // 单测只覆盖纯逻辑，无需浏览器环境（v3 ui 冒烟测试按文件头注解单独启用 jsdom）
    environment: 'node',
    // 并发负载下（几十个文件并行 import/transform）5s 默认值出现批量超时 flake
    //（2026-10-17 全量扫描：首轮 13 个失败全部是 5s 超时，复跑 20s 全绿）。
    // 全局 20s + 关键 UI 测试文件显式更长值；单测本身大多 <100ms，不影响反馈速度。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: [
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      // 音频引擎 v3（src/services/waveforge-engine-v3/，自 test/ 与 ui/ 原位迁入）
      'src/services/waveforge-engine-v3/test/**/*.test.ts',
      'src/services/waveforge-engine-v3/ui/**/*.test.tsx',
      // 空间音频（v3 模块树内联 src/spatial/）
      'src/services/waveforge-engine-v3/src/spatial/test/**/*.test.ts',
    ],
    setupFiles: ['test/setup.ts'],
  },
})

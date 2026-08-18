import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    // v3 引擎 UI 冒烟测试为 .tsx（react-jsx，与主 tsconfig 一致）
    jsx: 'automatic',
  },
  test: {
    // 单测只覆盖纯逻辑，无需浏览器环境（v3 ui 冒烟测试按文件头注解单独启用 jsdom）
    environment: 'node',
    include: [
      'test/**/*.test.ts',
      // 音频引擎 v3（src/services/waveforge-engine-v3/，自 test/ 与 ui/ 原位迁入）
      'src/services/waveforge-engine-v3/test/**/*.test.ts',
      'src/services/waveforge-engine-v3/ui/**/*.test.tsx',
    ],
    setupFiles: ['test/setup.ts'],
  },
})

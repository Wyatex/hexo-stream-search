import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Hexo 集成测试需要初始化站点实例，放宽超时
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})

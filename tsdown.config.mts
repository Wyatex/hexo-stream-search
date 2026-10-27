import { defineConfig } from 'tsdown'

/**
 * hexo-stream-search 构建配置
 *
 * 产物分为两段，互不混用：
 *   dist/node/  Node 端（Hexo 生成侧）：CJS 插件入口，hexo 以 CommonJS 方式加载
 *   dist/web/   网页端（浏览器运行侧）：Worker 引擎 + 主线程客户端
 *
 * 注意：多个配置共享同一个 outDir 时不能各自 clean，否则会互相删除产物，
 * 因此这里统一 clean: false，改由 package.json 的 clean 脚本先删除 dist。
 */
export default defineConfig([
  {
    name: 'node',
    entry: { index: 'src/node/index.ts' },
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outDir: 'dist/node',
    dts: { generator: 'tsgo' },
    clean: false,
    hash: false,
  },
  {
    name: 'web-worker-iife',
    entry: { 'search-worker': 'src/web/worker.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist/web',
    dts: false,
    clean: false,
    hash: false,
    outputOptions: {
      entryFileNames: 'search-worker.js',
    },
  },
  {
    name: 'web-worker-esm',
    entry: { 'search-worker': 'src/web/worker.ts' },
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist/web',
    dts: false,
    clean: false,
    hash: false,
    outExtensions: () => ({ js: '.mjs' }),
  },
  {
    name: 'web-client-esm',
    entry: { client: 'src/web/client.ts' },
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist/web',
    dts: { generator: 'tsgo' },
    clean: false,
    hash: false,
    outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  },
  {
    name: 'web-client-iife',
    entry: { 'client.iife': 'src/web/client.ts' },
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist/web',
    globalName: 'HexoStreamSearch',
    dts: false,
    clean: false,
    hash: false,
    outputOptions: {
      entryFileNames: 'client.iife.js',
    },
  },
])

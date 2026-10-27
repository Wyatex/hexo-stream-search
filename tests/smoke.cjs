/**
 * 运行时冒烟测试（零依赖）
 *
 * 在 CI 中针对 Node 18 / 20 / 22 / 24 / 26 运行，验证：
 * 1. Node 端 CJS 产物可在当前 Node 版本正常加载
 * 2. JSONL 索引生成结果符合约定
 * 3. Worker 产物路径可被插件正确解析，且网页端产物齐全
 * 4. Node 端产物不包含任何浏览器专属 API
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const DIST = path.join(__dirname, '..', 'dist')
const pkg = require('../dist/node/index.cjs')

async function runSmokeTest() {
  console.log(`Running runtime smoke test on Node.js ${process.version}...`)

  // 1. Node 端产物可加载
  assert(typeof pkg.buildJsonl === 'function', 'buildJsonl should be exported')
  assert(typeof pkg.registerGenerators === 'function', 'registerGenerators should be exported')

  // 2. JSONL 索引生成
  const data = pkg.buildJsonl(
    [
      {
        path: 'posts/stream-search/',
        title: 'Hexo 流式搜索',
        content: '<p>JSONL 流式加载与 <strong>BM25</strong> 排序</p>',
        updated: 1700000000000,
        tags: [{ name: '搜索' }],
        categories: [{ name: '技术' }],
      },
      {
        path: 'posts/draft/',
        title: '草稿',
        content: '草稿内容',
        updated: 1600000000000,
        published: false,
      },
    ],
    { root: '/' },
  )

  const lines = data.split('\n')
  const meta = JSON.parse(lines[0])
  assert.strictEqual(meta._type, 'meta', 'First line should be the meta header')
  assert.strictEqual(meta.total, 1, 'Unpublished posts should be excluded')
  assert.deepStrictEqual(meta.allIds, ['posts/stream-search/'])

  const article = JSON.parse(lines[1])
  assert.strictEqual(article.id, 'posts/stream-search/')
  assert.strictEqual(article.t, 'Hexo 流式搜索')
  assert.strictEqual(article.u, '/posts/stream-search/')
  assert.deepStrictEqual(article.g, ['搜索'])
  assert.deepStrictEqual(article.k, ['技术'])
  assert.strictEqual(article.c, 'JSONL 流式加载与 BM25 排序')

  // 3. 产物齐全且 Worker 路径可解析
  const required = [
    'node/index.cjs',
    'node/index.d.cts',
    'web/search-worker.js',
    'web/search-worker.mjs',
    'web/client.mjs',
    'web/client.iife.js',
  ]
  for (const file of required) {
    assert(fs.existsSync(path.join(DIST, file)), `Missing build artifact: ${file}`)
  }

  const workerBundle = pkg.resolveWorkerBundlePath()
  assert(fs.existsSync(workerBundle), `Worker bundle should exist: ${workerBundle}`)

  const workerCode = fs.readFileSync(workerBundle, 'utf8')
  assert(workerCode.includes('search_results'), 'Worker should handle SEARCH')
  assert(workerCode.includes('sync_complete'), 'Worker should report sync_complete')
  assert(workerCode.includes('progress'), 'Worker should report progress')

  // 4. Node 端产物不依赖浏览器 API
  const nodeCode = fs.readFileSync(path.join(DIST, 'node', 'index.cjs'), 'utf8')
  assert(!/\bdocument\./.test(nodeCode), 'Node bundle should not reference document')
  assert(!/\bwindow\./.test(nodeCode), 'Node bundle should not reference window')

  console.log(`✓ All smoke tests passed successfully on Node.js ${process.version}!`)
}

runSmokeTest().catch((error) => {
  console.error('Smoke test failed:', error)
  process.exit(1)
})

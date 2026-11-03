/**
 * SearchEngine —— 消息协议、缓存秒搜、内存降级与并发生命周期
 */
import { describe, expect, it } from 'vitest'
import { buildJsonl } from '../../../src/node/jsonl'
import { createEngine } from '../../../src/web/core/engine'
import type { WorkerOutboundMessage } from '../../../src/shared/types'
import { createBrowser, createSession, openPage, readStorage, seedStorage } from '../../helpers/browser'
import { jsonlFetch, mockFetch } from '../../helpers/http'
import { buildSite, cachedDoc, metaLine, postLine } from '../../helpers/jsonl'

const SAMPLE_LINES = [
  metaLine(['a/', 'b/'], [1, 2]),
  postLine('a/', 1, { t: 'Alpha 文章', g: ['tag'], c: 'alpha 内容' }),
  postLine('b/', 2, { t: 'Beta 文章', c: 'beta 内容' }),
]

describe('SearchEngine：指令与生命周期', () => {
  describe('消息协议（INIT / SEARCH / CLEAR）', () => {
    it('INIT 完成后构建倒排索引并发出 progress 与 sync_complete', async () => {
      const browser = createBrowser()
      const session = await openPage(browser, jsonlFetch(SAMPLE_LINES).fetch)

      expect(session.messages.map((m) => m.type)).toContain('progress')
      expect(session.payload('sync_complete')).toMatchObject({
        totalDocs: 2,
        updatedCount: 2,
        deletedCount: 0,
        scannedLines: 2,
        canceledEarly: false,
      })
      expect(session.engine.index.size).toBe(2)
    })

    it('INIT 未指定 url 时默认请求 /search.jsonl', async () => {
      const server = jsonlFetch([metaLine([], [])])
      const session = createSession(createBrowser(), server.fetch)

      await session.engine.handleMessage({ type: 'INIT' })

      expect(server.requests[0].url).toBe('/search.jsonl')
      expect(session.payload('sync_complete')?.totalDocs).toBe(0)
    })

    it('SEARCH 按 BM25 检索并原样回传 requestId 与查询耗时', async () => {
      const session = await openPage(createBrowser(), jsonlFetch(SAMPLE_LINES).fetch)

      await session.engine.handleMessage({
        type: 'SEARCH',
        payload: { query: 'alpha', limit: 5, requestId: 42 },
      })

      const res = session.payload('search_results')!
      expect(res.requestId).toBe(42)
      expect(res.query).toBe('alpha')
      expect(res.results[0].id).toBe('a/')
      expect(typeof res.elapsedMs).toBe('number')
    })

    it('CLEAR 清空内存索引与 IndexedDB 缓存并发出 cleared', async () => {
      const browser = createBrowser()
      const session = await openPage(browser, jsonlFetch(SAMPLE_LINES).fetch)
      expect(session.engine.index.size).toBe(2)

      await session.engine.handleMessage({ type: 'CLEAR' })

      expect(session.messages.at(-1)).toEqual({ type: 'cleared', payload: true })
      expect(session.engine.index.size).toBe(0)
      expect((await readStorage(browser)).docs.size).toBe(0)
    })

    it('忽略空消息与未知类型消息', async () => {
      const session = createSession(createBrowser())

      await session.engine.handleMessage(null as never)
      await session.engine.handleMessage({ type: 'UNKNOWN' } as never)

      expect(session.messages).toEqual([])
    })
  })

  describe('本地缓存首屏秒搜（cache_ready）', () => {
    it('IndexedDB 已有缓存时先发出 cache_ready，后台同步期间即可检索', async () => {
      const browser = createBrowser()
      await seedStorage(browser, [cachedDoc('cached-1/', 10, { t: '秒搜标题', c: '首屏立即可搜内容' })])

      const session = await openPage(
        browser,
        jsonlFetch([
          metaLine(['cached-1/', 'fresh-2/'], [10, 20]),
          postLine('cached-1/', 10, { t: '秒搜标题', c: '首屏立即可搜内容' }),
          postLine('fresh-2/', 20, { t: '新文章', c: '增量新增内容' }),
        ]).fetch,
      )

      const firstType = session.messages[0].type
      expect(firstType).toBe('cache_ready')
      expect(session.payload('cache_ready')).toMatchObject({ count: 1 })
      expect(session.payload('sync_complete')).toMatchObject({ totalDocs: 2, updatedCount: 1 })
      expect(session.engine.index.search('增量新增', 5)[0]?.id).toBe('fresh-2/')
    })
  })

  describe('错误处理与降级模式', () => {
    it('拉取失败时发出 error 消息且不崩溃', async () => {
      const session = await openPage(
        createBrowser(),
        mockFetch(() => new Response('', { status: 500 })).fetch,
      )

      expect(session.messages.at(-1)?.type).toBe('error')
      expect(session.payload('error')).toContain('HTTP 500')
    })

    it('IndexedDB 不可用（隐私模式）时自动降级为内存模式并保持完整搜索能力', async () => {
      const messages: WorkerOutboundMessage[] = []
      const engine = createEngine({
        indexedDB: undefined,
        postMessage: (m) => messages.push(m),
        fetchImpl: jsonlFetch([
          metaLine(['mem-1/', 'mem-2/'], [1, 2]),
          postLine('mem-1/', 1, { t: '隐私模式测试', c: '无 IndexedDB 依然可用' }),
          postLine('mem-2/', 2, { t: '内存索引', c: '秒级返回检索结果' }),
        ]).fetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

      const sync = messages.find((m) => m.type === 'sync_complete')
      expect(sync?.payload).toMatchObject({ totalDocs: 2, updatedCount: 2 })
      expect(engine.index.search('隐私模式', 5)[0]?.id).toBe('mem-1/')
    })

    it('多个引擎实例在同一 IndexedDB 上并发初始化不会撕裂数据', async () => {
      const browser = createBrowser()
      const site = buildSite(30)
      const sessionA = createSession(browser, jsonlFetch([site.bytes], { headers: { ETag: '"e"' } }).fetch)
      const sessionB = createSession(browser, jsonlFetch([site.bytes], { headers: { ETag: '"e"' } }).fetch)

      await Promise.all([
        sessionA.engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } }),
        sessionB.engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } }),
      ])

      expect(sessionA.engine.index.size).toBe(30)
      expect(sessionB.engine.index.size).toBe(30)
      expect((await readStorage(browser)).docs.size).toBe(30)
    })
  })

  describe('Node 生成端 → Web 引擎端到端闭环', () => {
    it('直接消费 buildJsonl 生成的索引完成首次同步、增量更新与删除清理', async () => {
      const browser = createBrowser()
      const v1Jsonl = buildJsonl(
        [
          {
            path: 'posts/hello/',
            title: 'Hello <strong>Hexo</strong>',
            content: '<p>流式搜索与 &amp; BM25 排序</p>',
            updated: 100,
            tags: [{ name: 'Hexo' }],
            categories: [{ name: '工程' }],
          },
          {
            path: 'posts/old/',
            title: '即将下线的文章',
            content: '<p>legacytoken</p>',
            updated: 50,
          },
        ],
        { root: '/blog/' },
      )

      const s1 = await openPage(browser, jsonlFetch([v1Jsonl]).fetch)
      expect(s1.engine.index.size).toBe(2)
      const hit1 = s1.engine.index.search('BM25', 5)[0]
      expect(hit1.url).toBe('/blog/posts/hello/')

      // 第二次构建：删除 old，修改 hello，新增 rust
      const v2Jsonl = buildJsonl(
        [
          {
            path: 'posts/hello/',
            title: 'Hello Hexo V2',
            content: '<p>流式搜索支持断点续传</p>',
            updated: 200,
          },
          {
            path: 'posts/rust/',
            title: 'C++ 与 Rust 对比',
            content: '<p>系统编程语言实践</p>',
            updated: 300,
          },
        ],
        { root: '/blog/' },
      )

      const s2 = await openPage(
        browser,
        jsonlFetch([v2Jsonl]).fetch,
      )
      expect(s2.payload('sync_complete')).toMatchObject({
        totalDocs: 2,
        updatedCount: 2,
        deletedCount: 1,
      })
      expect(s2.engine.index.search('legacytoken', 5)).toEqual([])
      expect(s2.engine.index.search('断点续传', 5)[0]?.id).toBe('posts/hello/')
      expect(s2.engine.index.search('C++', 5)[0]?.id).toBe('posts/rust/')
    })
  })
})

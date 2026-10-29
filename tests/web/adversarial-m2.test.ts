import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/web/core/engine'
import { createPostStore } from '../../src/web/core/idb'
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { IndexedDoc, WorkerOutboundMessage } from '../../src/shared/types'

function makeMeta(total: number, allIds: string[], allM?: number[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds, ...(allM ? { allM } : {}) })}\n`
}

function makeArticle(id: string, m: number, title: string, content: string, tags: string[] = ['tech']): string {
  return `${JSON.stringify({ id, t: title, u: `/${id}`, m, g: tags, k: ['dev'], c: content })}\n`
}

describe('Milestone 2 Empirical Adversarial Stress Test Suite', () => {
  // =========================================================================
  // Challenge 1: Multi-byte UTF-8 sliced right at chunk boundaries
  // =========================================================================
  describe('Challenge 1: Multi-byte UTF-8 Line-Boundary Alignment & Slicing', () => {
    it('极度激进切片：以 1 字节 chunk 流式传输包含 CJK 3 字节、Emoji 4 字节、CRLF 的数据，验证无字符撕裂与行偏移精确无误', async () => {
      // 包含多种多字节字符：CJK 3 字节、Emoji 4 字节、ZWJ 序列、拉丁扩展 2 字节、CRLF 与 LF 混用
      const testArticles = [
        {
          id: 'art-cjk-1/',
          m: 1001,
          t: '深入解析 UTF-8 编码与分块流式传输 🚀🔥',
          c: '测试包含日文カタカナ、ひらがな、韩文한국어以及简体中文与繁體字。',
        },
        {
          id: 'art-cjk-2/',
          m: 1002,
          t: 'Complex Emoji ZWJ Sequence 👨‍💻 and 👩‍👩‍👧‍👦 with Math 𝄞 & 𠮷野家',
          c: 'Astral plane characters take 4 bytes: 🌟, 🎉, 🦄, 💡, 💎. No bytes should be corrupted.',
        },
        {
          id: 'art-cjk-3/',
          m: 1003,
          t: 'Accented Latin: Café, naïve, München, résumé & Cyrillic: Привет мир',
          c: 'Greek letters: α, β, γ, δ, Ω. Mixed with English technical terms.',
        },
      ]

      const metaLine = makeMeta(
        testArticles.length,
        testArticles.map((a) => a.id),
        testArticles.map((a) => a.m),
      )

      // 混合使用 \r\n 与 \n
      const line1 = makeArticle(testArticles[0].id, testArticles[0].m, testArticles[0].t, testArticles[0].c).replace('\n', '\r\n')
      const line2 = makeArticle(testArticles[1].id, testArticles[1].m, testArticles[1].t, testArticles[1].c) // \n
      const line3 = makeArticle(testArticles[2].id, testArticles[2].m, testArticles[2].t, testArticles[2].c).replace('\n', '\r\n')

      const fullString = metaLine + line1 + line2 + line3
      const fullBytes = new TextEncoder().encode(fullString)

      // 计算每一行严格的期望字节偏移量（换行符 0x0A 后的首字节）
      const metaLen = new TextEncoder().encode(metaLine).byteLength
      const line1Len = new TextEncoder().encode(line1).byteLength
      const line2Len = new TextEncoder().encode(line2).byteLength
      const line3Len = new TextEncoder().encode(line3).byteLength

      const expectedOffsets = [
        metaLen + line1Len,
        metaLen + line1Len + line2Len,
        metaLen + line1Len + line2Len + line3Len,
      ]

      // 模拟极端传输：每个 chunk 仅有 1 个字节！
      // 这意味着每个 3 字节 CJK 字符被拆成 3 个 chunk，每个 4 字节 Emoji 被拆成 4 个 chunk，
      // CRLF 被拆为 '\r' (chunk N) 与 '\n' (chunk N+1)
      let byteIndex = 0
      const singleByteStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (byteIndex < fullBytes.byteLength) {
            controller.enqueue(fullBytes.subarray(byteIndex, byteIndex + 1))
            byteIndex++
          } else {
            controller.close()
          }
        },
      })

      const committedOffsets: number[] = []
      const localMap = new Map<string, IndexedDoc>()

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        batchSize: 1, // 每一行都 commit 一次以收集 committedOffsets
        onBatchCommit: async (batch) => {
          committedOffsets.push(batch.syncState.byteOffset)
        },
        fetchImpl: (async () => new Response(singleByteStream, { status: 200 })) as unknown as typeof fetch,
      })

      // 1. 验证所有期望的文章行边界字节偏移都被精确记录
      for (const expected of expectedOffsets) {
        expect(committedOffsets).toContain(expected)
      }

      // 2. 验证多字节文本无撕裂、无乱码字符（\uFFFD 替换符）
      expect(localMap.size).toBe(3)
      for (const expectedArticle of testArticles) {
        const doc = localMap.get(expectedArticle.id)
        expect(doc).toBeDefined()
        expect(doc?.t).toBe(expectedArticle.t)
        expect(doc?.c).toBe(expectedArticle.c)
        expect(doc?.t.includes('\uFFFD')).toBe(false)
        expect(doc?.c.includes('\uFFFD')).toBe(false)
      }

      expect(result.scannedCount).toBe(3)
      expect(result.canceledEarly).toBe(false)
    })

    it('多字节字符内部切片与 Range 续传：在 3 字节 CJK 和 4 字节 Emoji 的任意字节切割，验证 206 续传零 JSON 解析错误', async () => {
      const articles = [
        makeArticle('post-cjk-a/', 10, '第一篇：深度学习与知识图谱 🧠', '正文包含自然语言处理与多模态模型。'),
        makeArticle('post-cjk-b/', 20, '第二篇：微前端与分布式系统 🏗️', '正文包含容器编排与服务网格。'),
      ]
      const meta = makeMeta(2, ['post-cjk-a/', 'post-cjk-b/'], [10, 20])
      const fullText = meta + articles[0] + articles[1]
      const fullBytes = new TextEncoder().encode(fullText)

      const metaLen = new TextEncoder().encode(meta).byteLength
      const art1Len = new TextEncoder().encode(articles[0]).byteLength
      const breakpointOffset = metaLen + art1Len // 第一篇文章结束时的对齐偏移

      // 模拟断点续传：从 breakpointOffset 请求 Range
      const rangeResponseBytes = fullBytes.slice(breakpointOffset)

      // 故意将第二篇文章的内容在 Emoji 4 字节内部切开传输
      // 在 Emoji '🏗️' 的第 2 个字节位置切成两个 chunk
      const emojiCharOffset = rangeResponseBytes.findIndex(
        (b, i, arr) => b === 0xf0 && arr[i + 1] === 0x9f && arr[i + 2] === 0x8f,
      )
      expect(emojiCharOffset).toBeGreaterThan(0)

      const slicePoint = emojiCharOffset + 2 // 在 4 字节序列的中间切断
      const chunk1 = rangeResponseBytes.slice(0, slicePoint)
      const chunk2 = rangeResponseBytes.slice(slicePoint)

      const localMap = new Map<string, IndexedDoc>()
      localMap.set('post-cjk-a/', processPost(JSON.parse(articles[0])))

      const parsedDocs: IndexedDoc[] = []
      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        syncState: {
          key: 'sync_state:/search.jsonl',
          url: '/search.jsonl',
          byteOffset: breakpointOffset,
          status: 'syncing',
          meta: JSON.parse(meta),
          scannedCount: 1,
          updatedAt: Date.now(),
        },
        handlers: {
          onDocument: (doc) => parsedDocs.push(doc),
        },
        processPost,
        fetchImpl: (async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk1)
              controller.enqueue(chunk2)
              controller.close()
            },
          })
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${breakpointOffset}-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
            },
          })
        }) as unknown as typeof fetch,
      })

      expect(result.resumed).toBe(true)
      expect(result.toPut.length).toBe(1)
      expect(result.toPut[0].id).toBe('post-cjk-b/')
      expect(result.toPut[0].t).toBe('第二篇：微前端与分布式系统 🏗️')
      expect(localMap.size).toBe(2)
      expect(localMap.get('post-cjk-b/')?.c).toBe('正文包含容器编排与服务网格。')
    })
  })

  // =========================================================================
  // Challenge 2: Rapid simulated page reloads (5 reloads during 500-post sync)
  // =========================================================================
  describe('Challenge 2: Rapid Simulated Page Reloads (5 Interruption Cycles / 500 Posts)', () => {
    it('模拟用户在 500 篇文章同步过程中在随机字节偏移处连续刷新 5 次，最终 100% 文章就绪、无重复且检索完全正确', async () => {
      const totalPosts = 500
      const allIds = Array.from({ length: totalPosts }, (_, i) => `article-${String(i).padStart(4, '0')}/`)
      const allM = Array.from({ length: totalPosts }, (_, i) => 200000 + i)
      const testETag = '"etag-v3-stress-500"'

      // 构建 500 篇文章内容
      const articles = allIds.map((id, i) =>
        makeArticle(
          id,
          allM[i],
          `文章 ${i} - 标题关键词 topic${i % 25}`,
          `文章 ${i} 正文详细内容，涵盖分布式检索与流式索引机制，包含检索词 searchterm${i} 与全局指纹 globalterm.`,
          [`tag${i % 10}`],
        ),
      )

      const metaLine = makeMeta(totalPosts, allIds, allM)
      const fullJsonlStr = metaLine + articles.join('')
      const fullJsonlBytes = new TextEncoder().encode(fullJsonlStr)
      const totalByteLength = fullJsonlBytes.byteLength

      // 共享底层的 IDBFactory，模拟同一个浏览器的 IndexedDB 跨刷新会话
      const sharedIDB = new IDBFactory()
      const dbName = 'stress-reloads-500-db'
      const targetUrl = '/search.jsonl'

      // 计算每篇累积字节偏移并选定 5 次突发中断的随机字节切片点（任意非对齐的字节偏移）
      // 批处理大小为 50，选择在 75, 175, 275, 385, 465 篇附近且加上任意零头字节（如 +23, +47），
      // 既保证切在 JSON 文章的半中间，又保证此前至少有一个批次已被提交到 IDB，
      // 从而每轮刷新都能验证「首屏 cache_ready 秒搜 + Range 续传 + 去重补全」
      const getByteOffsetAtArticle = (articleIdx: number, extraBytes: number) => {
        const prefix = metaLine + articles.slice(0, articleIdx).join('')
        return new TextEncoder().encode(prefix).byteLength + extraBytes
      }

      const randomByteCutoffs = [
        getByteOffsetAtArticle(75, 23),
        getByteOffsetAtArticle(175, 47),
        getByteOffsetAtArticle(275, 19),
        getByteOffsetAtArticle(385, 31),
        getByteOffsetAtArticle(465, 13),
      ]

      let currentCutoffIndex = 0

      for (let session = 1; session <= 6; session++) {
        const isFinalSession = session === 6
        const targetByteCutoff = isFinalSession ? totalByteLength : randomByteCutoffs[currentCutoffIndex++]

        const sessionMessages: WorkerOutboundMessage[] = []
        let requestedRangeHeader: string | undefined

        // 自定义 fetch：按字节流式推送，到达目标 cutoff 时突发断开连接
        const simulatedFetch = (async (_url: string, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string> | undefined
          requestedRangeHeader = headers?.['Range']

          let resumeStartOffset = 0
          if (requestedRangeHeader) {
            const match = requestedRangeHeader.match(/bytes=(\d+)-/)
            if (match) resumeStartOffset = Number(match[1])
          }

          const sliceFromResume = fullJsonlBytes.slice(resumeStartOffset)
          const allowedByteLength = Math.max(0, targetByteCutoff - resumeStartOffset)

          let sentBytes = 0
          const chunkSize = 1024

          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sentBytes >= allowedByteLength) {
                if (isFinalSession) {
                  controller.close()
                } else {
                  // 模拟网络或标签页在非对齐字节处突发中断
                  controller.error(new Error(`Simulated page reload / tab close at byte offset ${targetByteCutoff}`))
                }
                return
              }

              const nextChunkSize = Math.min(chunkSize, allowedByteLength - sentBytes)
              const chunk = sliceFromResume.subarray(sentBytes, sentBytes + nextChunkSize)
              sentBytes += nextChunkSize
              controller.enqueue(chunk)
            },
          })

          const isRangeResume = resumeStartOffset > 0
          return new Response(stream, {
            status: isRangeResume ? 206 : 200,
            headers: {
              ETag: testETag,
              ...(isRangeResume
                ? {
                    'Content-Range': `bytes ${resumeStartOffset}-${totalByteLength - 1}/${totalByteLength}`,
                  }
                : {}),
            },
          })
        }) as unknown as typeof fetch

        const engine = createEngine({
          indexedDB: sharedIDB,
          dbName,
          postMessage: (msg) => sessionMessages.push(msg),
          fetchImpl: simulatedFetch,
        })

        // 启动本轮初始化
        await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

        if (session > 1) {
          // 验证后续每轮刷新打开时，均能立即收到 cache_ready 首屏秒搜消息
          const cacheReadyMsg = sessionMessages.find((m) => m.type === 'cache_ready')
          expect(cacheReadyMsg).toBeDefined()
          const cachedCount = (cacheReadyMsg?.payload as { count: number }).count
          expect(cachedCount).toBeGreaterThan(0)
          expect(cachedCount).toBeLessThanOrEqual(totalPosts)

          // 验证续传发出了正确的 Range 请求头
          expect(requestedRangeHeader).toBeDefined()
          expect(requestedRangeHeader).toMatch(/^bytes=\d+-$/)
        }

        if (isFinalSession) {
          // 最终轮：验证全量同步完成
          const syncCompleteMsg = sessionMessages.find((m) => m.type === 'sync_complete')
          expect(syncCompleteMsg).toBeDefined()
          expect(syncCompleteMsg?.payload).toMatchObject({
            totalDocs: 500,
            resumed: true,
          })

          // 验证倒排索引包含全量 500 篇文章
          expect(engine.index.size).toBe(500)

          // 验证 IndexedDB 中无重复无缺失：精确为 500 篇
          const finalStore = await createPostStore({ indexedDB: sharedIDB, dbName })
          const allStored = await finalStore.getAll()
          expect(allStored.size).toBe(500)

          // 验证终态 syncState 为 completed
          const finalSyncState = await finalStore.getSyncState(targetUrl)
          expect(finalSyncState?.status).toBe('completed')
          expect(finalSyncState?.completed).toBe(true)

          // 抽样检验搜索准确度（首、中、尾与各段代表文章）
          const testIndices = [0, 49, 100, 200, 350, 450, 499]
          for (const idx of testIndices) {
            const results = engine.index.search(`searchterm${idx}`, 5)
            expect(results.length).toBeGreaterThanOrEqual(1)
            expect(results[0].id).toBe(`article-${String(idx).padStart(4, '0')}/`)
          }

          // 验证全局词检索出全部 500 篇
          const globalResults = engine.index.search('globalterm', 600)
          expect(globalResults.length).toBe(500)
        }
      }

      // Session 7：全量完成后再次刷新，验证 304 协商缓存瞬间完成且 0 字节传输
      const session7Messages: WorkerOutboundMessage[] = []
      let sentIfNoneMatch: string | undefined

      const fetch304 = (async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined
        sentIfNoneMatch = headers?.['If-None-Match']
        return new Response(null, { status: 304, statusText: 'Not Modified' })
      }) as unknown as typeof fetch

      const engine7 = createEngine({
        indexedDB: sharedIDB,
        dbName,
        postMessage: (msg) => session7Messages.push(msg),
        fetchImpl: fetch304,
      })

      await engine7.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      expect(sentIfNoneMatch).toBe(testETag)
      const session7Complete = session7Messages.find((m) => m.type === 'sync_complete')!
      expect(session7Complete).toBeDefined()
      expect(session7Complete.payload).toMatchObject({
        totalDocs: 500,
        updatedCount: 0,
        resumed: true,
      })
      expect(engine7.index.size).toBe(500)
    })

    it('服务端 ETag 变动导致 200 回退全量拉取时：验证 IndexedDB 中之前的旧残留文章必须被彻底清除', async () => {
      const sharedIDB = new IDBFactory()
      const dbName = 'test-200-fallback-leak-db'
      const targetUrl = '/search.jsonl'

      // 阶段 1：先在 IDB 中模拟之前未完成的拉取残留下来的 2 篇文章 (例如 old-1/ 与 old-2/)
      const store1 = await createPostStore({ indexedDB: sharedIDB, dbName })
      await store1.applyBatch(
        [
          processPost({ id: 'old-part-1/', t: 'Old 1', u: '/old-part-1/', m: 10, g: [], k: [], c: 'old content 1' }),
          processPost({ id: 'old-part-2/', t: 'Old 2', u: '/old-part-2/', m: 10, g: [], k: [], c: 'old content 2' }),
        ],
        [],
        {
          key: `sync_state:${targetUrl}`,
          url: targetUrl,
          byteOffset: 250,
          etag: '"stale-etag-v1"',
          status: 'syncing',
          updatedAt: Date.now(),
        },
      )
      expect((await store1.getAll()).size).toBe(2)

      // 阶段 2：用户刷新页面。客户端发送带 Range 和 If-Range: "stale-etag-v1" 的请求。
      // 但服务端索引已被全新部署（例如 ETag 变更为 "fresh-etag-v2"，包含且仅包含 1 篇全新的 new-fresh-1/ 文章）
      // 服务端根据 RFC 7233 判定 If-Range 不匹配，返回 200 OK 全量数据
      const freshMeta = makeMeta(1, ['new-fresh-1/'], [50])
      const freshArticle = makeArticle('new-fresh-1/', 50, 'Fresh New Article', 'completely fresh site content')
      const freshBytes = new TextEncoder().encode(freshMeta + freshArticle)

      let capturedHeaders: HeadersInit | undefined
      const fetch200 = (async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(freshBytes)
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { ETag: '"fresh-etag-v2"' },
        })
      }) as unknown as typeof fetch

      const engine = createEngine({
        indexedDB: sharedIDB,
        dbName,
        postMessage: () => {},
        fetchImpl: fetch200,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      // 验证客户端确实尝试了 Range 续传
      expect((capturedHeaders as Record<string, string>)?.['If-Range']).toBe('"stale-etag-v1"')

      // 阶段 3：检查此时 IndexedDB 的持久化数据！
      // 关键断言：之前残留在 IDB 中的 old-part-1/ 与 old-part-2/ 必须被完全清除！
      // 否则下次打开网页时，它们会作为幽灵文档被再次载入内存并显示在搜索结果中！
      const storeAfter = await createPostStore({ indexedDB: sharedIDB, dbName })
      const docsAfter = await storeAfter.getAll()

      // 验证内存索引仅有 1 篇
      expect(engine.index.size).toBe(1)
      expect(engine.index.has('new-fresh-1/')).toBe(true)
      expect(engine.index.has('old-part-1/')).toBe(false)
      expect(engine.index.has('old-part-2/')).toBe(false)

      // 验证 IndexedDB 中无幽灵残留
      expect(docsAfter.has('new-fresh-1/')).toBe(true)
      expect(docsAfter.has('old-part-1/')).toBe(false)
      expect(docsAfter.has('old-part-2/')).toBe(false)
      expect(docsAfter.size).toBe(1)
    })
  })

  // =========================================================================
  // Challenge 3: Private browsing & Storage error fallbacks
  // =========================================================================
  describe('Challenge 3: Private Browsing & Storage Error Fallbacks', () => {
    it('模拟隐私模式与 IDB open 同步抛出 SecurityError：优雅降级为 MemoryStore 且不崩溃', async () => {
      // 模拟某些受限浏览器在隐私模式下访问 window.indexedDB.open 立即抛出 SecurityError
      const rejectingFactory = {
        open() {
          throw new DOMException('Access to IndexedDB is denied in private mode.', 'SecurityError')
        },
      } as unknown as IDBFactory

      const store = await createPostStore({
        indexedDB: rejectingFactory,
        dbName: 'private-mode-test-1',
      })

      // 必须优雅降级为内存存储
      expect(store.persistent).toBe(false)

      // 验证内存存储支持完整的读写与 syncState 操作
      const dummyDoc = processPost({
        id: 'private-doc-1/',
        t: 'Private Post',
        u: '/private-doc-1/',
        m: 123,
        g: [],
        k: [],
        c: 'Content in memory mode',
      })

      await store.applyBatch(
        [dummyDoc],
        [],
        {
          key: 'sync_state:/search.jsonl',
          url: '/search.jsonl',
          byteOffset: 500,
          status: 'syncing',
          updatedAt: Date.now(),
        },
      )

      const all = await store.getAll()
      expect(all.size).toBe(1)
      expect(all.get('private-doc-1/')?.t).toBe('Private Post')

      const syncState = await store.getSyncState('/search.jsonl')
      expect(syncState?.byteOffset).toBe(500)
    })

    it('模拟 IDB open 异步 onerror 拒绝：优雅降级为 MemoryStore', async () => {
      const errorFactory = {
        open() {
          const req: Record<string, unknown> = {
            onerror: null,
            onsuccess: null,
            error: new DOMException('Internal database failure or disk quota exceeded.', 'QuotaExceededError'),
          }
          setTimeout(() => {
            if (typeof req.onerror === 'function') {
              req.onerror({ target: req })
            }
          }, 0)
          return req
        },
      } as unknown as IDBFactory

      const store = await createPostStore({
        indexedDB: errorFactory,
        dbName: 'quota-error-test',
      })

      expect(store.persistent).toBe(false)
      expect((await store.getAll()).size).toBe(0)
    })

    it('模拟 IDB open 触发 onblocked：优雅降级为 MemoryStore', async () => {
      const blockedFactory = {
        open() {
          const req: Record<string, unknown> = {
            onblocked: null,
            onsuccess: null,
            onerror: null,
          }
          setTimeout(() => {
            if (typeof req.onblocked === 'function') {
              req.onblocked({})
            }
          }, 0)
          return req
        },
      } as unknown as IDBFactory

      const store = await createPostStore({
        indexedDB: blockedFactory,
        dbName: 'blocked-upgrade-test',
      })

      expect(store.persistent).toBe(false)
    })

    it('模拟初次 getAll 事务抛错（存储损坏）：优雅降级为 MemoryStore', async () => {
      const faultyDbFactory = new IDBFactory()

      // 代理 IDBFactory.open，在打开数据库后使 transaction() 抛错，模拟只读事务损坏
      const mockFactory = {
        open(...args: Parameters<typeof faultyDbFactory.open>) {
          const req = faultyDbFactory.open(...args)
          return new Proxy(req, {
            get(target, prop, receiver) {
              if (prop === 'result') {
                const db = Reflect.get(target, prop, receiver)
                if (!db) return db
                return new Proxy(db, {
                  get(dbTarget, dbProp, dbReceiver) {
                    if (dbProp === 'transaction') {
                      return () => {
                        throw new DOMException('Transaction failed due to disk corruption', 'QuotaExceededError')
                      }
                    }
                    return Reflect.get(dbTarget, dbProp, dbReceiver)
                  },
                })
              }
              return Reflect.get(target, prop, receiver)
            },
          })
        },
      } as unknown as IDBFactory

      const store = await createPostStore({
        indexedDB: mockFactory,
        dbName: 'transaction-fault-db',
      })

      // 降级为内存模式且正常可用
      expect(store.persistent).toBe(false)
      await store.apply([processPost({ id: 'fallback-doc', t: 'Fallback', u: '/f', m: 1, g: [], k: [], c: 'fallback' })], [])
      expect((await store.getAll()).size).toBe(1)
    })

    it('在隐私模式降级下，Engine 能够全流程完成流式解析并提供 BM25 实时搜索', async () => {
      const messages: WorkerOutboundMessage[] = []
      const articles = [
        makeArticle('mem-p1/', 1, '隐私模式深度测试 🔒', '在 IndexedDB 完全不可用时依然提供极致体验。'),
        makeArticle('mem-p2/', 2, '第二篇隐私文章 🛡️', '内存倒排索引秒级返回搜索结果。'),
      ]
      const meta = makeMeta(2, ['mem-p1/', 'mem-p2/'], [1, 2])
      const jsonlData = meta + articles.join('')

      const engine = createEngine({
        indexedDB: undefined, // 隐私模式无 IndexedDB
        postMessage: (m) => messages.push(m),
        fetchImpl: (async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(jsonlData))
              controller.close()
            },
          })
          return new Response(stream, { status: 200 })
        }) as unknown as typeof fetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

      // 验证 sync_complete 成功送达
      const syncComplete = messages.find((m) => m.type === 'sync_complete')
      expect(syncComplete).toBeDefined()
      expect(syncComplete?.payload).toMatchObject({
        totalDocs: 2,
        updatedCount: 2,
      })

      // 直接使用 engine 中的索引搜索，验证精准匹配 mem-p1
      const results = engine.index.search('隐私模式', 5)
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].id).toBe('mem-p1/')
    })
  })
})

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

function makeArticle(id: string, m: number, title: string, content: string): string {
  return `${JSON.stringify({ id, t: title, u: `/${id}`, m, g: ['tech'], k: ['dev'], c: content })}\n`
}

describe('M2 Adversarial Stress Suite: Range Resumption & State Machine', () => {
  // =========================================================================
  // Objective 1: Fragmented 1-byte chunks across Range resumption
  // =========================================================================
  describe('Objective 1: Fragmented 1-byte Chunks across 206 Resumption', () => {
    it('206 Partial Content streaming bytes 1 by 1 across JSON record boundaries maintains line alignment and parses completely', async () => {
      const totalPosts = 10
      const allIds = Array.from({ length: totalPosts }, (_, i) => `p-${i}/`)
      const allM = Array.from({ length: totalPosts }, (_, i) => 100 + i)

      const metaLine = makeMeta(totalPosts, allIds, allM)
      const postLines = allIds.map((id, i) =>
        makeArticle(id, allM[i], `标题-${i} 中文测试 🚀`, `正文内容-${i} 包含CJK字符与多字节边界`),
      )
      const fullText = metaLine + postLines.join('')
      const fullBytes = new TextEncoder().encode(fullText)

      // 假设前 3 篇文章在之前会话中已同步
      const initialSyncedPosts = 3
      const initialLines = [metaLine, ...postLines.slice(0, initialSyncedPosts)].join('')
      const initialByteOffset = new TextEncoder().encode(initialLines).byteLength

      const localMap = new Map<string, IndexedDoc>()
      for (let i = 0; i < initialSyncedPosts; i++) {
        const id = allIds[i]
        localMap.set(id, processPost({
          id,
          t: `标题-${i} 中文测试 🚀`,
          u: `/${id}`,
          m: allM[i],
          g: ['tech'],
          k: ['dev'],
          c: `正文内容-${i}`,
        }))
      }

      // 剩余字节流
      const remainingBytes = fullBytes.slice(initialByteOffset)

      // 模拟极端网络条件：服务端返回 206，但每次只 push 1 个字节
      let byteIndex = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (byteIndex >= remainingBytes.length) {
            controller.close()
            return
          }
          // 每次仅推送单字节 Uint8Array
          controller.enqueue(remainingBytes.slice(byteIndex, byteIndex + 1))
          byteIndex++
        },
      })

      const customFetch = (async () => {
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${initialByteOffset}-${fullBytes.length - 1}/${fullBytes.length}`,
            ETag: '"test-etag-1"',
          },
        })
      }) as unknown as typeof fetch

      const committedOffsets: number[] = []
      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        syncState: {
          key: 'sync_state:/search.jsonl',
          url: '/search.jsonl',
          byteOffset: initialByteOffset,
          etag: '"test-etag-1"',
          status: 'syncing',
          scannedCount: initialSyncedPosts,
          meta: {
            _type: 'meta',
            total: totalPosts,
            allIds,
            allM,
          },
          updatedAt: Date.now(),
        },
        batchSize: 2,
        onBatchCommit: async (batch) => {
          committedOffsets.push(batch.syncState.byteOffset)
        },
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl: customFetch,
      })

      expect(result.resumed).toBe(true)
      expect(result.toPut).toHaveLength(totalPosts - initialSyncedPosts)
      expect(localMap.size).toBe(totalPosts)
      for (const id of allIds) {
        expect(localMap.has(id)).toBe(true)
      }
      expect(result.finalSyncState?.status).toBe('completed')
      expect(result.finalSyncState?.byteOffset).toBe(fullBytes.byteLength)

      // 验证每一个 committed offset 都是合法的整行偏移（即指向 \n 的下一个字节）
      for (const offset of committedOffsets) {
        if (offset > 0 && offset < fullBytes.byteLength) {
          expect(fullBytes[offset - 1]).toBe(10) // 必须前一个字节是 '\n'
        }
      }
    })
  })

  // =========================================================================
  // Objective 2: Malformed or missing Content-Range headers on 206
  // =========================================================================
  describe('Objective 2: Malformed or Missing Content-Range Headers on 206', () => {
    it('206 with completely MISSING Content-Range header falls back to syncState.byteOffset cleanly', async () => {
      const metaLine = makeMeta(2, ['p0/', 'p1/'], [10, 20])
      const post0 = makeArticle('p0/', 10, 'P0', 'Content 0')
      const post1 = makeArticle('p1/', 20, 'P1', 'Content 1')
      const offset = new TextEncoder().encode(metaLine + post0).byteLength

      const post1Bytes = new TextEncoder().encode(post1)
      const localMap = new Map<string, IndexedDoc>([
        ['p0/', processPost({ id: 'p0/', t: 'P0', u: '/p0/', m: 10, g: [], k: [], c: 'C0' })],
      ])

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        syncState: {
          key: 'sync_state:/search.jsonl',
          url: '/search.jsonl',
          byteOffset: offset,
          etag: '"etag"',
          status: 'syncing',
          scannedCount: 1,
          meta: { _type: 'meta', total: 2, allIds: ['p0/', 'p1/'], allM: [10, 20] },
          updatedAt: Date.now(),
        },
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl: (async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(post1Bytes)
              controller.close()
            },
          })
          // 故意不传 Content-Range 头
          return new Response(stream, {
            status: 206,
            headers: { ETag: '"etag"' },
          })
        }) as unknown as typeof fetch,
      })

      expect(result.resumed).toBe(true)
      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('p1/')
      expect(localMap.has('p1/')).toBe(true)
      expect(result.finalSyncState?.status).toBe('completed')
    })

    it('206 with MALFORMED Content-Range header (e.g. invalid syntax) falls back without crash', async () => {
      const metaLine = makeMeta(2, ['p0/', 'p1/'], [10, 20])
      const post0 = makeArticle('p0/', 10, 'P0', 'Content 0')
      const post1 = makeArticle('p1/', 20, 'P1', 'Content 1')
      const offset = new TextEncoder().encode(metaLine + post0).byteLength

      const post1Bytes = new TextEncoder().encode(post1)
      const localMap = new Map<string, IndexedDoc>([
        ['p0/', processPost({ id: 'p0/', t: 'P0', u: '/p0/', m: 10, g: [], k: [], c: 'C0' })],
      ])

      const malformedHeaders = [
        'invalid-range-value',
        'bytes */100',
        'bytes foo-bar/baz',
        'characters 100-200/500',
        'bytes=100-200',
      ]

      for (const badHeader of malformedHeaders) {
        const local = new Map(localMap)
        const result = await syncJsonlStream({
          url: '/search.jsonl',
          localMap: local,
          syncState: {
            key: 'sync_state:/search.jsonl',
            url: '/search.jsonl',
            byteOffset: offset,
            etag: '"etag"',
            status: 'syncing',
            scannedCount: 1,
            meta: { _type: 'meta', total: 2, allIds: ['p0/', 'p1/'], allM: [10, 20] },
            updatedAt: Date.now(),
          },
          handlers: { onDocument: () => {} },
          processPost,
          fetchImpl: (async () => {
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(post1Bytes)
                controller.close()
              },
            })
            return new Response(stream, {
              status: 206,
              headers: {
                'Content-Range': badHeader,
                ETag: '"etag"',
              },
            })
          }) as unknown as typeof fetch,
        })

        expect(result.resumed).toBe(true)
        expect(result.toPut).toHaveLength(1)
        expect(result.toPut[0].id).toBe('p1/')
      }
    })
  })

  // =========================================================================
  // Objective 3: Server ETag change between interruptions (200 fallback)
  // =========================================================================
  describe('Objective 3: Server ETag Change Between Interruptions (200 Fallback in Engine + IDB)', () => {
    it('Verifies 200 fallback flushes stale documents in IndexedDB and builds new index without duplicate or missing posts', async () => {
      const sharedFactory = new IDBFactory()
      const dbName = 'test-etag-change-db'
      const targetUrl = '/search.jsonl'

      // 会话 1：旧版本网站，共 30 篇文章，ETag 为 "v1-etag"
      // 流拉取了前 15 篇时发生网络中断
      const v1Total = 30
      const v1Ids = Array.from({ length: v1Total }, (_, i) => `v1-old-post-${i}/`)
      const v1M = Array.from({ length: v1Total }, (_, i) => 100 + i)
      const v1FullLines = [
        makeMeta(v1Total, v1Ids, v1M),
        ...v1Ids.map((id, i) => makeArticle(id, v1M[i], `V1 Title ${i}`, `V1 Content ${i} alphav1onlycontent`)),
      ]
      const v1Encoder = new TextEncoder()
      const v1PartialBytes = v1Encoder.encode(v1FullLines.slice(0, 16).join('')) // Meta + 15 posts

      const session1Messages: WorkerOutboundMessage[] = []
      const engine1 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: (msg) => session1Messages.push(msg),
        fetchImpl: (async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(v1PartialBytes)
              controller.close()
            },
          })
          return new Response(stream, {
            status: 200,
            headers: { ETag: '"v1-etag"' },
          })
        }) as unknown as typeof fetch,
      })

      await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      // 验证 Session 1 存储了 15 篇旧文章
      const storeVerify1 = await createPostStore({ indexedDB: sharedFactory, dbName })
      const cached1 = await storeVerify1.getAll()
      expect(cached1.size).toBe(15)
      expect(cached1.has('v1-old-post-0/')).toBe(true)
      expect(cached1.has('v1-old-post-14/')).toBe(true)

      // 手动模拟断点未完成状态 (syncing)
      const sync1 = await storeVerify1.getSyncState(targetUrl)
      await storeVerify1.applyBatch([], [], {
        ...sync1!,
        status: 'syncing',
        byteOffset: v1PartialBytes.byteLength,
        scannedCount: 15,
        etag: '"v1-etag"',
      })

      // 会话 2：此时服务端代码发布，全站被重写！
      // 文章 ID 完全不同（例如变为 new-v2-post-*），ETag 变为 "v2-new-etag"，全量 20 篇文章
      const v2Total = 20
      const v2Ids = Array.from({ length: v2Total }, (_, i) => `new-v2-post-${i}/`)
      const v2M = Array.from({ length: v2Total }, (_, i) => 200 + i)
      const v2FullLines = [
        makeMeta(v2Total, v2Ids, v2M),
        ...v2Ids.map((id, i) => makeArticle(id, v2M[i], `V2 Title ${i}`, `V2 Content ${i} betav2onlycontent`)),
      ]
      const v2FullBytes = new TextEncoder().encode(v2FullLines.join(''))

      let session2SentHeaders: HeadersInit | undefined
      const session2Fetch = (async (_url: string, init?: RequestInit) => {
        session2SentHeaders = init?.headers
        // 因为客户端带了 If-Range: "v1-etag"，而服务端当前是 "v2-new-etag"，不匹配！
        // 服务端根据 RFC 7233 必须返回 200 OK 全量数据！
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(v2FullBytes)
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { ETag: '"v2-new-etag"' },
        })
      }) as unknown as typeof fetch

      const session2Messages: WorkerOutboundMessage[] = []
      const engine2 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: (msg) => session2Messages.push(msg),
        fetchImpl: session2Fetch,
      })

      // 初始化 Session 2
      await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      // 验证 Session 2 发送了 If-Range: "v1-etag"
      expect((session2SentHeaders as Record<string, string>)?.['If-Range']).toBe('"v1-etag"')

      // 检查此时 Engine 2 的倒排索引：必须只有 20 篇 V2 文章，绝不能残留任何 V1 文章！
      expect(engine2.index.size).toBe(20)
      const v1Search = engine2.index.search('alphav1onlycontent', 10)
      expect(v1Search).toHaveLength(0) // 旧关键词不能搜到任何文章！
      const v2Search = engine2.index.search('betav2onlycontent', 30)
      expect(v2Search).toHaveLength(20) // 新关键词能搜到全部 20 篇！

      // 重点检查：此时 IndexedDB 中的持久化数据！
      // 必须清除了所有 15 篇 V1 旧文章，只剩下 20 篇 V2 新文章！
      const storeVerify2 = await createPostStore({ indexedDB: sharedFactory, dbName })
      const cached2 = await storeVerify2.getAll()
      expect(cached2.size).toBe(20)
      expect(cached2.has('v1-old-post-0/')).toBe(false)
      expect(cached2.has('new-v2-post-0/')).toBe(true)

      // 会话 3：再次刷新，验证从 IndexedDB 恢复出来的本地缓存没有 V1 残留
      const session3Messages: WorkerOutboundMessage[] = []
      const engine3 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: (msg) => session3Messages.push(msg),
        fetchImpl: (async () => {
          return new Response(null, { status: 304 })
        }) as unknown as typeof fetch,
      })
      await engine3.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      const cacheReadyMsg = session3Messages.find((m) => m.type === 'cache_ready')!
      expect((cacheReadyMsg.payload as { count: number }).count).toBe(20)
      expect(engine3.index.size).toBe(20)
      expect(engine3.index.search('alphav1onlycontent', 10)).toHaveLength(0)
    })
  })

  // =========================================================================
  // Objective 4: HTTP 416 Range Not Satisfiable
  // =========================================================================
  describe('Objective 4: HTTP 416 Range Not Satisfiable', () => {
    it('seamlessly recovers from 416 without throwing, resetting offset and downloading clean index', async () => {
      const messages: WorkerOutboundMessage[] = []
      const fetchCalls: { url: string; headers?: HeadersInit }[] = []

      const fullLines = [
        makeMeta(2, ['p1/', 'p2/'], [1, 2]),
        makeArticle('p1/', 1, 'P1', 'Content 1'),
        makeArticle('p2/', 2, 'P2', 'Content 2'),
      ]
      const fullBytes = new TextEncoder().encode(fullLines.join(''))

      const customFetch = (async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, headers: init?.headers })
        if (fetchCalls.length === 1) {
          // 第一次因 offset 越界返回 416
          return new Response('Requested range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': 'bytes */50' },
          })
        }
        // 重试请求返回 200
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fullBytes)
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      }) as unknown as typeof fetch

      const sharedFactory = new IDBFactory()
      const engine = createEngine({
        indexedDB: sharedFactory,
        postMessage: (m) => messages.push(m),
        fetchImpl: customFetch,
      })

      // 预先在 IDB 植入一个越界 offset 的 sync_state
      const store = await createPostStore({ indexedDB: sharedFactory })
      await store.applyBatch([], [], {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 999999, // 极端超大偏移
        etag: '"any-etag"',
        status: 'syncing',
        updatedAt: Date.now(),
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

      // 验证没有抛出 error 消息
      const errorMsg = messages.find((m) => m.type === 'error')
      expect(errorMsg).toBeUndefined()

      // 验证最终发出 sync_complete
      const syncComplete = messages.find((m) => m.type === 'sync_complete')!
      expect(syncComplete).toBeDefined()
      expect((syncComplete.payload as { totalDocs: number }).totalDocs).toBe(2)
      expect(engine.index.size).toBe(2)

      // 验证两次请求细节
      expect(fetchCalls).toHaveLength(2)
      expect((fetchCalls[0].headers as Record<string, string>)?.['Range']).toBe('bytes=999999-')
      expect((fetchCalls[1].headers as Record<string, string>)?.['Range']).toBeUndefined()
    })
  })

  // =========================================================================
  // Objective 5: HTTP 304 Not Modified
  // =========================================================================
  describe('Objective 5: HTTP 304 Not Modified', () => {
    it('verifies 0 bytes transferred and complete cache recovery from IDB', async () => {
      const sharedFactory = new IDBFactory()
      const dbName = 'test-304-db'
      const targetUrl = '/search.jsonl'
      const etag = '"stable-etag-304"'

      const store = await createPostStore({ indexedDB: sharedFactory, dbName })
      const docA = processPost({ id: 'doc-a/', t: 'Doc A', u: '/doc-a/', m: 100, g: [], k: [], c: '304 text alpha' })
      const docB = processPost({ id: 'doc-b/', t: 'Doc B', u: '/doc-b/', m: 200, g: [], k: [], c: '304 text beta' })

      await store.applyBatch([docA, docB], [], {
        key: `sync_state:${targetUrl}`,
        url: targetUrl,
        byteOffset: 500,
        etag,
        status: 'completed',
        completed: true,
        meta: {
          _type: 'meta',
          total: 2,
          allIds: ['doc-a/', 'doc-b/'],
          allM: [100, 200],
        },
        updatedAt: Date.now(),
      })

      let fetchCalled = false
      const customFetch = (async (_url: string, init?: RequestInit) => {
        fetchCalled = true
        const headers = init?.headers as Record<string, string>
        expect(headers?.['If-None-Match']).toBe(etag)
        // HTTP 304 依据 RFC 9110 严格不允许携带 body (0 字节传输)
        return new Response(null, { status: 304, statusText: 'Not Modified' })
      }) as unknown as typeof fetch

      const messages: WorkerOutboundMessage[] = []
      const engine = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: (m) => messages.push(m),
        fetchImpl: customFetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      // 验证 fetch 被调用且为 304
      expect(fetchCalled).toBe(true)

      // 验证 cache_ready 包含了全部 2 篇文章
      const cacheReady = messages.find((m) => m.type === 'cache_ready')!
      expect((cacheReady.payload as { count: number }).count).toBe(2)

      // 验证 sync_complete 标记 resumed: true 且 updatedCount 为 0
      const syncComplete = messages.find((m) => m.type === 'sync_complete')!
      expect(syncComplete.payload).toMatchObject({
        totalDocs: 2,
        updatedCount: 0,
        resumed: true,
      })

      // 验证两篇文章完全可检索
      expect(engine.index.size).toBe(2)
      expect(engine.index.search('alpha', 5)).toHaveLength(1)
      expect(engine.index.search('beta', 5)).toHaveLength(1)
    })
  })

  // =========================================================================
  // Objective 6: Mid-stream network abortion during 206 resume
  // =========================================================================
  describe('Objective 6: Mid-stream Network Abortion during 206 Resume', () => {
    it('verifies partial commits remain consistent across consecutive interruptions and resumes pick up from newest breakpoint', async () => {
      const sharedFactory = new IDBFactory()
      const dbName = 'test-multi-interrupt-db'
      const targetUrl = '/search.jsonl'
      const etag = '"stable-multi-etag"'

      // 构建 60 篇文章
      const totalPosts = 60
      const allIds = Array.from({ length: totalPosts }, (_, i) => `doc-${String(i).padStart(3, '0')}/`)
      const allM = Array.from({ length: totalPosts }, (_, i) => 1000 + i)
      const fullLines = [
        makeMeta(totalPosts, allIds, allM),
        ...allIds.map((id, i) => makeArticle(id, allM[i], `Title ${i}`, `Content ${i} unqdoc${i}token`)),
      ]
      const fullBytes = new TextEncoder().encode(fullLines.join(''))

      // -------------------------------------------------------------
      // 阶段 1：首屏打开，拉取到第 20 篇时断网 (包含 meta + 20 posts)
      // -------------------------------------------------------------
      const phase1Bytes = new TextEncoder().encode(fullLines.slice(0, 21).join(''))
      const engine1 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: () => {},
        fetchImpl: (async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(phase1Bytes)
              controller.close()
            },
          })
          return new Response(stream, { status: 200, headers: { ETag: etag } })
        }) as unknown as typeof fetch,
      })
      await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
      const cachedPhase1 = await store1.getAll()
      expect(cachedPhase1.size).toBe(20)

      // 设为 syncing 模拟非正常关闭
      const sync1 = await store1.getSyncState(targetUrl)
      await store1.applyBatch([], [], {
        ...sync1!,
        status: 'syncing',
        byteOffset: phase1Bytes.byteLength,
        scannedCount: 20,
      })

      // -------------------------------------------------------------
      // 阶段 2：续传 206 开始拉取，拉取到第 40 篇时再次断网！
      // -------------------------------------------------------------
      const phase2EndByte = new TextEncoder().encode(fullLines.slice(0, 41).join('')).byteLength
      const phase2Slice = fullBytes.slice(phase1Bytes.byteLength, phase2EndByte)

      let phase2RangeReceived: string | undefined
      const engine2 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: () => {},
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          phase2RangeReceived = (init?.headers as Record<string, string>)?.[`Range`]
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(phase2Slice)
              controller.close()
            },
          })
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${phase1Bytes.byteLength}-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
              ETag: etag,
            },
          })
        }) as unknown as typeof fetch,
      })
      await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      expect(phase2RangeReceived).toBe(`bytes=${phase1Bytes.byteLength}-`)

      // 验证阶段 2 之后 IDB 持久化了 40 篇文章
      const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
      const cachedPhase2 = await store2.getAll()
      expect(cachedPhase2.size).toBe(40)

      // 再次标记为 syncing 模拟中断
      const sync2 = await store2.getSyncState(targetUrl)
      await store2.applyBatch([], [], {
        ...sync2!,
        status: 'syncing',
        byteOffset: phase2EndByte,
        scannedCount: 40,
      })

      // -------------------------------------------------------------
      // 阶段 3：第三次访问，从第 40 篇 (phase2EndByte) 继续 206 续传直到 100% 完成
      // -------------------------------------------------------------
      const phase3Slice = fullBytes.slice(phase2EndByte)
      let phase3RangeReceived: string | undefined

      const engine3 = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: () => {},
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          phase3RangeReceived = (init?.headers as Record<string, string>)?.[`Range`]
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(phase3Slice)
              controller.close()
            },
          })
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${phase2EndByte}-${fullBytes.byteLength - 1}/${fullBytes.byteLength}`,
              ETag: etag,
            },
          })
        }) as unknown as typeof fetch,
      })
      await engine3.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      expect(phase3RangeReceived).toBe(`bytes=${phase2EndByte}-`)

      // 验证最终完成：全部 60 篇文章均在 IDB 中，状态为 completed
      const store3 = await createPostStore({ indexedDB: sharedFactory, dbName })
      const finalCached = await store3.getAll()
      expect(finalCached.size).toBe(60)

      const finalSync = await store3.getSyncState(targetUrl)
      expect(finalSync?.status).toBe('completed')

      // 验证倒排索引中 60 篇全可搜
      expect(engine3.index.size).toBe(60)
      for (let i = 0; i < totalPosts; i++) {
        const found = engine3.index.search(`unqdoc${i}token`, 5)
        expect(found).toHaveLength(1)
        expect(found[0].id).toBe(`doc-${String(i).padStart(3, '0')}/`)
      }
    })
  })

  // =========================================================================
  // Objective 7: Additional Adversarial Resilience & Edge Cases
  // =========================================================================
  describe('Objective 7: Additional Adversarial Resilience & Edge Cases', () => {
    it('CRLF (\\r\\n) line endings streamed in 1-byte chunks over 206 resume', async () => {
      const metaLine = JSON.stringify({
        _type: 'meta',
        total: 2,
        allIds: ['post-crlf-1/', 'post-crlf-2/'],
        allM: [10, 20],
      }) + '\r\n'

      const post1 = JSON.stringify({
        id: 'post-crlf-1/',
        t: 'CRLF 1 🚀',
        u: '/post-crlf-1/',
        m: 10,
        g: [],
        k: [],
        c: 'CRLF 1 Content',
      }) + '\r\n'

      const post2 = JSON.stringify({
        id: 'post-crlf-2/',
        t: 'CRLF 2 🎯',
        u: '/post-crlf-2/',
        m: 20,
        g: [],
        k: [],
        c: 'CRLF 2 Content',
      }) + '\r\n'

      const fullText = metaLine + post1 + post2
      const fullBytes = new TextEncoder().encode(fullText)
      const offset = new TextEncoder().encode(metaLine + post1).byteLength
      const remainingBytes = fullBytes.slice(offset)

      let byteIdx = 0
      const customFetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (byteIdx >= remainingBytes.length) {
              controller.close()
              return
            }
            controller.enqueue(remainingBytes.slice(byteIdx, byteIdx + 1))
            byteIdx++
          },
        })
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${offset}-${fullBytes.length - 1}/${fullBytes.length}`,
            ETag: '"etag-crlf"',
          },
        })
      }) as unknown as typeof fetch

      const localMap = new Map<string, IndexedDoc>([
        ['post-crlf-1/', processPost({ id: 'post-crlf-1/', t: 'CRLF 1 🚀', u: '/post-crlf-1/', m: 10, g: [], k: [], c: 'C' })],
      ])

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        syncState: {
          key: 'sync_state:/search.jsonl',
          url: '/search.jsonl',
          byteOffset: offset,
          etag: '"etag-crlf"',
          status: 'syncing',
          scannedCount: 1,
          meta: { _type: 'meta', total: 2, allIds: ['post-crlf-1/', 'post-crlf-2/'], allM: [10, 20] },
          updatedAt: Date.now(),
        },
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl: customFetch,
      })

      expect(result.resumed).toBe(true)
      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('post-crlf-2/')
      expect(result.finalSyncState?.byteOffset).toBe(fullBytes.byteLength)
    })

    it('Server HTTP 500 error during 206 resume does NOT wipe existing IDB store', async () => {
      const sharedFactory = new IDBFactory()
      const dbName = 'test-500-error-db'
      const targetUrl = '/search.jsonl'

      // 预先存入 10 篇文章
      const store = await createPostStore({ indexedDB: sharedFactory, dbName })
      const doc = processPost({ id: 'p1/', t: 'P1', u: '/p1/', m: 10, g: [], k: [], c: 'C1' })
      await store.applyBatch([doc], [], {
        key: `sync_state:${targetUrl}`,
        url: targetUrl,
        byteOffset: 100,
        etag: '"etag-500"',
        status: 'syncing',
        updatedAt: Date.now(),
      })

      const messages: WorkerOutboundMessage[] = []
      const engine = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: (m) => messages.push(m),
        fetchImpl: (async () => {
          return new Response('Internal Server Error', { status: 500 })
        }) as unknown as typeof fetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      // 验证触发 error 消息
      const errorMsg = messages.find((m) => m.type === 'error')
      expect(errorMsg).toBeDefined()
      expect(errorMsg?.payload).toContain('500')

      // 验证已存在的 IDB 数据未被删除
      const storeAfter = await createPostStore({ indexedDB: sharedFactory, dbName })
      const cachedAfter = await storeAfter.getAll()
      expect(cachedAfter.size).toBe(1)
      expect(cachedAfter.has('p1/')).toBe(true)
    })

    it('Double 416 failure (retry also fails with 416) emits error gracefully', async () => {
      const messages: WorkerOutboundMessage[] = []
      const engine = createEngine({
        postMessage: (m) => messages.push(m),
        fetchImpl: (async () => {
          return new Response('416 repeatedly', { status: 416 })
        }) as unknown as typeof fetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

      const errorMsg = messages.find((m) => m.type === 'error')
      expect(errorMsg).toBeDefined()
      expect(errorMsg?.payload).toContain('416')
    })
  })
})

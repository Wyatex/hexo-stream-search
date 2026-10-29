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

describe('HTTP Range Resumption & IDB Persistence Full Lifecycle', () => {
  it('模拟网页刷新重载全流程：中断持久化、重载首屏秒搜、断点续传补齐100%数据', async () => {
    // 共享相同的底层 IndexedDB 存储（模拟同一个浏览器的 IndexedDB 实例跨会话）
    const sharedFactory = new IDBFactory()
    const dbName = 'test-browser-session-db'
    const targetUrl = '/search.jsonl'
    const etag = '"stable-v1-hash"'

    // 构建 100 篇文章
    const totalPosts = 100
    const allIds = Array.from({ length: totalPosts }, (_, i) => `post-${String(i).padStart(3, '0')}/`)
    const allM = Array.from({ length: totalPosts }, (_, i) => 1000 + i)

    const fullLines = [
      makeMeta(totalPosts, allIds, allM),
      ...allIds.map((id, i) =>
        makeArticle(id, allM[i], `Title ${i} 文章`, `Content ${i} 详细正文关键词 searchterm${i}`),
      ),
    ]

    const encoder = new TextEncoder()
    const rawFullBytes = encoder.encode(fullLines.join(''))

    // =========================================================================
    // 阶段 1：首屏打开网页，流拉取到第 40 篇时用户突然刷新网页（模拟网络或页面中断）
    // =========================================================================
    const session1Messages: WorkerOutboundMessage[] = []
    let session1SentHeaders: HeadersInit | undefined

    // 截断在第 40 篇文章之后的中断流
    const partialLines = fullLines.slice(0, 41) // Line 0: Meta, Lines 1..40: Posts 0..39
    const session1Bytes = encoder.encode(partialLines.join(''))

    const session1Fetch = (async (_url: string, init?: RequestInit) => {
      session1SentHeaders = init?.headers
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(session1Bytes)
          // 模拟连接在此处被浏览器或网络突然断开（模拟关闭标签页）
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: etag, 'Last-Modified': 'Wed, 28 Oct 2026 12:00:00 GMT' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: (msg) => session1Messages.push(msg),
      fetchImpl: session1Fetch,
    })

    // 初始化流式拉取
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证首次发起无 Range 头
    expect((session1SentHeaders as Record<string, string>)?.['Range']).toBeUndefined()

    // 验证 IndexedDB 中已被原子持久化了前 40 篇文章与断点状态
    const storeVerify1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const cachedDocs1 = await storeVerify1.getAll()
    expect(cachedDocs1.size).toBe(40)
    expect(cachedDocs1.has('post-000/')).toBe(true)
    expect(cachedDocs1.has('post-039/')).toBe(true)
    expect(cachedDocs1.has('post-040/')).toBe(false)

    // 验证保存的断点状态：流在 40 篇截断（未达 meta.total 100 篇），正确保留 syncing 状态以便后续断点续传
    const syncState1 = await storeVerify1.getSyncState(targetUrl)
    expect(syncState1).not.toBeNull()
    expect(syncState1?.status).toBe('syncing')
    expect(syncState1?.completed).toBe(false)
    expect(syncState1?.byteOffset).toBe(session1Bytes.byteLength)
    expect(syncState1?.scannedCount).toBe(40)

    // =========================================================================
    // 阶段 2：用户刷新页面，新打开 Engine 实例从 IndexedDB 恢复并断点续传
    // =========================================================================
    const session2Messages: WorkerOutboundMessage[] = []
    let session2RangeHeader: string | undefined
    let session2IfRangeHeader: string | undefined

    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      session2RangeHeader = headers?.['Range']
      session2IfRangeHeader = headers?.['If-Range']

      // 提取请求的字节偏移
      const match = session2RangeHeader?.match(/bytes=(\d+)-/)
      const resumeOffset = match ? Number(match[1]) : 0

      // 服务端根据 Range 返回 206 Partial Content
      const slicedBytes = rawFullBytes.slice(resumeOffset)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slicedBytes)
          controller.close()
        },
      })

      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${resumeOffset}-${rawFullBytes.byteLength - 1}/${rawFullBytes.byteLength}`,
          ETag: etag,
        },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: (msg) => session2Messages.push(msg),
      fetchImpl: session2Fetch,
    })

    // 初始化 Engine 2
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 1. 验证首屏秒搜：Engine 2 立即发出 cache_ready，文档数为 40
    const cacheReadyMsg = session2Messages.find((m) => m.type === 'cache_ready')!
    expect(cacheReadyMsg).toBeDefined()
    expect((cacheReadyMsg.payload as { count: number }).count).toBe(40)

    // 2. 验证续传请求头正确包含了 Range: bytes=<session1Bytes.byteLength>- 和 If-Range
    expect(session2RangeHeader).toBe(`bytes=${session1Bytes.byteLength}-`)
    expect(session2IfRangeHeader).toBe(etag)

    // 3. 验证同步完成消息 sync_complete
    const syncCompleteMsg = session2Messages.find((m) => m.type === 'sync_complete')!
    expect(syncCompleteMsg).toBeDefined()
    expect(syncCompleteMsg.payload).toMatchObject({
      totalDocs: 100,
      updatedCount: 60, // 成功续传拉取了剩余 60 篇
      resumed: true,    // 命中断点续传
    })

    // 4. 验证倒排索引包含全量 100 篇文章，检索任意文章均能命中
    expect(engine2.index.size).toBe(100)
    const searchResultFirst = engine2.index.search('searchterm0', 10)
    const searchResultMiddle = engine2.index.search('searchterm39', 10)
    const searchResultResumed = engine2.index.search('searchterm75', 10)
    const searchResultLast = engine2.index.search('searchterm99', 10)

    expect(searchResultFirst[0]?.id).toBe('post-000/')
    expect(searchResultMiddle[0]?.id).toBe('post-039/')
    expect(searchResultResumed[0]?.id).toBe('post-075/')
    expect(searchResultLast[0]?.id).toBe('post-099/')

    // 5. 验证此时 IndexedDB 中已持久化全部 100 篇文章且状态为 completed
    const storeVerify2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const allStoredDocs = await storeVerify2.getAll()
    expect(allStoredDocs.size).toBe(100)
    const finalState = await storeVerify2.getSyncState(targetUrl)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.completed).toBe(true)

    // =========================================================================
    // 阶段 3：全量同步完成后第三次访问（协商缓存 304 快速完成）
    // =========================================================================
    const session3Messages: WorkerOutboundMessage[] = []
    let session3IfNoneMatch: string | undefined

    const session3Fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      session3IfNoneMatch = headers?.['If-None-Match']
      // 命中 304
      return new Response(null, { status: 304, statusText: 'Not Modified' })
    }) as unknown as typeof fetch

    const engine3 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: (msg) => session3Messages.push(msg),
      fetchImpl: session3Fetch,
    })

    await engine3.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(session3IfNoneMatch).toBe(etag)
    const session3Sync = session3Messages.find((m) => m.type === 'sync_complete')!
    expect(session3Sync.payload).toMatchObject({
      totalDocs: 100,
      updatedCount: 0,
      resumed: true,
    })
  })

  it('多字节 UTF-8 中文字符与 CRLF 行尾跨 chunk 时的行边界字节精确计算', async () => {
    // 场景：中文内容占用 3 字节，若 chunk 在中文字符中间切开，且含有 \r\n 行尾
    // 验证 Uint8Array 0x0A 扫描依然精确对齐下一行起始
    const postA = JSON.stringify({
      id: 'cjk-1/',
      t: '中文标题测试 🚀',
      u: '/cjk-1/',
      m: 100,
      g: ['标签一'],
      k: ['分类A'],
      c: '这里是长段中文内容，包含了多字节字符与表情符号 🔥',
    }) + '\r\n'

    const postB = JSON.stringify({
      id: 'cjk-2/',
      t: '第二篇中文 🎯',
      u: '/cjk-2/',
      m: 200,
      g: [],
      k: [],
      c: '第二篇的正文内容',
    }) + '\n'

    const metaLine = JSON.stringify({
      _type: 'meta',
      total: 2,
      allIds: ['cjk-1/', 'cjk-2/'],
      allM: [100, 200],
    }) + '\n'

    const fullStr = metaLine + postA + postB
    const fullBytes = new TextEncoder().encode(fullStr)

    // 在 postA 中文字符的任意非边界字节处切割（例如第 85 字节）
    const cutPoint = 85
    const chunk1 = fullBytes.slice(0, cutPoint)
    const chunk2 = fullBytes.slice(cutPoint)

    const committedOffsets: number[] = []
    const localMap = new Map<string, IndexedDoc>()

    await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      batchSize: 1, // 每处理 1 行即 commit
      onBatchCommit: async (batch) => {
        committedOffsets.push(batch.syncState.byteOffset)
      },
      fetchImpl: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk1)
            controller.enqueue(chunk2)
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      }) as unknown as typeof fetch,
    })

    // 验证已提交的两个文章偏移量分别严格对齐在 postA 和 postB 的换行符之后
    const metaBytesLen = new TextEncoder().encode(metaLine).byteLength
    const postABytesLen = new TextEncoder().encode(postA).byteLength
    const postBBytesLen = new TextEncoder().encode(postB).byteLength

    const expectedOffsetA = metaBytesLen + postABytesLen
    const expectedOffsetB = expectedOffsetA + postBBytesLen

    expect(committedOffsets).toContain(expectedOffsetA)
    expect(committedOffsets).toContain(expectedOffsetB)
    expect(localMap.size).toBe(2)
    expect(localMap.get('cjk-1/')?.t).toBe('中文标题测试 🚀')
    expect(localMap.get('cjk-2/')?.t).toBe('第二篇中文 🎯')
  })

  it('IndexedDB 被禁用或报错时，优雅降级为内存模式且保持搜索可用', async () => {
    // 模拟隐私模式：indexedDB 为 undefined
    const messages: WorkerOutboundMessage[] = []
    const engine = createEngine({
      indexedDB: undefined,
      postMessage: (m) => messages.push(m),
      fetchImpl: (async () => {
        const lines = [
          makeMeta(1, ['mem-post/'], [10]),
          makeArticle('mem-post/', 10, 'Memory Mode', 'Fallback in memory'),
        ]
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(lines.join('')))
            controller.close()
          },
        })
        return new Response(stream, { status: 200 })
      }) as unknown as typeof fetch,
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: '/search.jsonl' } })

    const syncMsg = messages.find((m) => m.type === 'sync_complete')!
    expect(syncMsg).toBeDefined()
    expect((syncMsg.payload as { totalDocs: number }).totalDocs).toBe(1)
    expect(engine.index.size).toBe(1)

    // 内存搜索依然正常工作
    const results = engine.index.search('fallback', 10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('mem-post/')
  })
})

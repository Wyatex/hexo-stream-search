import { describe, expect, it, vi } from 'vitest'
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { IndexedDoc, SearchProgress, IndexSyncState } from '../../src/shared/types'

interface FetchOptions {
  status?: number
  headers?: Record<string, string>
  onCancel?: () => void
  /** 保持连接不关闭（用于验证提前断流） */
  keepOpen?: boolean
  onRequest?: (url: string, init?: RequestInit) => void
}

function createFetch(chunks: string[], options: FetchOptions = {}): typeof fetch {
  const encoder = new TextEncoder()
  let index = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        // 保持连接打开，等待调用方主动 cancel
        if (!options.keepOpen) controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]))
    },
    cancel() {
      options.onCancel?.()
    },
  })

  return (async (reqUrl: string, reqInit?: RequestInit) => {
    options.onRequest?.(reqUrl, reqInit)
    return new Response(stream, {
      status: options.status ?? 200,
      headers: options.headers,
    })
  }) as unknown as typeof fetch
}

function meta(total: number, allIds: string[], allM?: number[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds, ...(allM ? { allM } : {}) })}\n`
}

function article(id: string, m: number, content = 'content'): string {
  return `${JSON.stringify({ id, t: id, u: `/${id}`, m, g: [], k: [], c: content })}\n`
}

describe('syncJsonlStream', () => {
  it('解析元数据与文章数据行', async () => {
    const localMap = new Map<string, IndexedDoc>()
    const progress: SearchProgress[] = []
    const documents: IndexedDoc[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onProgress: (payload) => progress.push(payload),
        onDocument: (doc) => documents.push(doc),
      },
      processPost,
      fetchImpl: createFetch([meta(2, ['b/', 'a/']), article('b/', 2, 'beta'), article('a/', 1, 'alpha')]),
    })

    expect(result.toPut).toHaveLength(2)
    expect(result.toDelete).toHaveLength(0)
    expect(result.canceledEarly).toBe(false)
    expect(result.scannedCount).toBe(2)
    expect(result.totalCount).toBe(2)
    expect(documents).toHaveLength(2)
    expect(localMap.has('a/')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100 })
  })

  it('跨数据块的半行会被正确拼接', async () => {
    const localMap = new Map<string, IndexedDoc>()
    const first = JSON.stringify({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), `${first.slice(0, 30)}`, `${first.slice(30)}\n`]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('a/')
  })

  it('命中未变更缓存时提前断开连接', async () => {
    const onCancel = vi.fn()
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 1, 'alpha')], { onCancel, keepOpen: true }),
    })

    expect(onCancel).toHaveBeenCalled()
    expect(result.canceledEarly).toBe(true)
    expect(result.toPut).toHaveLength(0)
    expect(result.scannedCount).toBe(1)
  })

  it('服务端已删除的文章进入待删除列表', async () => {
    const cached = processPost({ id: 'gone/', t: 'G', u: '/gone/', m: 1, g: [], k: [], c: 'x' })
    const localMap = new Map<string, IndexedDoc>([['gone/', cached]])
    const removed: string[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 1, 'alpha')]),
    })

    expect(result.toDelete).toEqual(['gone/'])
    expect(removed).toEqual(['gone/'])
    expect(localMap.has('gone/')).toBe(false)
  })

  it('内容变更的文章会重新处理', async () => {
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'old' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([meta(1, ['a/']), article('a/', 2, 'new')]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].m).toBe(2)
  })

  it('本地缺失文章时不会提前断流', async () => {
    const onCancel = vi.fn()
    const cached = processPost({ id: 'a/', t: 'A', u: '/a/', m: 1, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cached]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch(
        [meta(2, ['a/', 'b/']), article('a/', 1, 'alpha'), article('b/', 2, 'beta')],
        { onCancel },
      ),
    })

    expect(onCancel).not.toHaveBeenCalled()
    expect(result.canceledEarly).toBe(false)
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
  })

  it('HTTP 失败时抛出错误', async () => {
    await expect(
      syncJsonlStream({
        url: '/search.jsonl',
        localMap: new Map<string, IndexedDoc>(),
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl: createFetch([], { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('内容变更但排在未变更文章之后的文章不会被提前断流跳过 (缺陷复现与修复)', async () => {
    // 场景：本地缓存已有 a/ (m=200)、b/ (m=100, 旧)、c/ (m=50)
    // 服务端更新了 b/ 至 m=150，流顺序为 [a/ (200), b/ (150), c/ (50)]
    // 旧逻辑中 a/ 命中缓存且 currentIndex(0) > lastMissingIndex(-1)，会立刻断流导致 b/ 永远无法更新。
    // 新逻辑中 lastDivergentIndex 为 1 (b/ 的位置)，a/ 不会断流，b/ 正确更新，c/ 处安全断流。
    const onCancel = vi.fn()
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const cachedB = processPost({ id: 'b/', t: 'B', u: '/b/', m: 100, g: [], k: [], c: 'beta old' })
    const cachedC = processPost({ id: 'c/', t: 'C', u: '/c/', m: 50, g: [], k: [], c: 'gamma' })
    const localMap = new Map<string, IndexedDoc>([
      ['a/', cachedA],
      ['b/', cachedB],
      ['c/', cachedC],
    ])
    const handledDocs: { doc: IndexedDoc; kind: 'new' | 'cached' }[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: (doc, kind) => handledDocs.push({ doc, kind }),
      },
      processPost,
      fetchImpl: createFetch(
        [
          meta(3, ['a/', 'b/', 'c/'], [200, 150, 50]),
          article('a/', 200, 'alpha'),
          article('b/', 150, 'beta updated'),
          article('c/', 50, 'gamma'),
        ],
        { onCancel, keepOpen: true },
      ),
    })

    // 验证 b/ 成功被更新，没有被提前断流跳过
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
    expect(result.toPut[0].m).toBe(150)
    expect(localMap.get('b/')?.m).toBe(150)

    // 验证 c/ 越过 lastDivergentIndex 后安全断流
    expect(onCancel).toHaveBeenCalled()
    expect(result.canceledEarly).toBe(true)
    expect(result.scannedCount).toBe(3)

    // 验证回调执行：a 为 cached，b 为 new，c 为 cached
    expect(handledDocs).toEqual([
      { doc: cachedA, kind: 'cached' },
      { doc: expect.objectContaining({ id: 'b/', m: 150 }), kind: 'new' },
      { doc: cachedC, kind: 'cached' },
    ])
  })

  it('全站缓存与 allM 完全一致时在收到 meta 头后首行零字节断流', async () => {
    // 场景：本地已有 a/ (m=200)、b/ (m=100)
    // 服务端 meta 声明全量一致，流中后续有文章正文但保持 keepOpen
    // 预期：首行读完立即 cancel，不下载后续任何正文行
    const onCancel = vi.fn()
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const cachedB = processPost({ id: 'b/', t: 'B', u: '/b/', m: 100, g: [], k: [], c: 'beta' })
    const localMap = new Map<string, IndexedDoc>([
      ['a/', cachedA],
      ['b/', cachedB],
    ])
    const handledDocs: { doc: IndexedDoc; kind: 'new' | 'cached' }[] = []
    const progress: SearchProgress[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: (doc, kind) => handledDocs.push({ doc, kind }),
        onProgress: (p) => progress.push(p),
      },
      processPost,
      fetchImpl: createFetch(
        [
          meta(2, ['a/', 'b/'], [200, 100]),
          article('a/', 200, 'alpha'),
          article('b/', 100, 'beta'),
        ],
        { onCancel, keepOpen: true },
      ),
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(result.canceledEarly).toBe(true)
    expect(result.toPut).toHaveLength(0)
    expect(result.toDelete).toHaveLength(0)
    expect(result.scannedCount).toBe(2)
    expect(result.totalCount).toBe(2)
    // 所有缓存文档按 meta 顺序上报 cached
    expect(handledDocs).toEqual([
      { doc: cachedA, kind: 'cached' },
      { doc: cachedB, kind: 'cached' },
    ])
    expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100, updated: 0 })
  })

  it('降级兼容没有 allM 的旧版 meta 头', async () => {
    // 场景：旧服务端未提供 allM，仅提供 allIds
    // 本地缺失 b/，stream 包含 a/ (已缓存) 与 b/ (缺失)
    // 预期：优雅降级为按 !localMap.has() 计算断流点，成功拉取 b/
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([
        meta(2, ['a/', 'b/']), // 没有 allM
        article('a/', 200, 'alpha'),
        article('b/', 100, 'beta'),
      ]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
    expect(localMap.has('b/')).toBe(true)
  })

  it('全站文章完全一致且服务端有删除文章时在第 1 行完成删除并零字节断流', async () => {
    const onCancel = vi.fn()
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const cachedOld = processPost({ id: 'deleted/', t: 'D', u: '/deleted/', m: 50, g: [], k: [], c: 'del' })
    const localMap = new Map<string, IndexedDoc>([
      ['a/', cachedA],
      ['deleted/', cachedOld],
    ])
    const removed: string[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: createFetch(
        [
          meta(1, ['a/'], [200]),
          article('a/', 200, 'alpha'),
        ],
        { onCancel, keepOpen: true },
      ),
    })

    expect(onCancel).toHaveBeenCalled()
    expect(result.canceledEarly).toBe(true)
    expect(result.toDelete).toEqual(['deleted/'])
    expect(removed).toEqual(['deleted/'])
    expect(localMap.has('deleted/')).toBe(false)
    expect(result.toPut).toHaveLength(0)
  })

  it('allM 与 allIds 长度不一致时优雅降级为按 ID 缺失判断', async () => {
    // 畸形 allM：allIds 长度为 2，allM 长度为 1
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: createFetch([
        meta(2, ['a/', 'b/'], [200]), // 长度不匹配
        article('a/', 200, 'alpha'),
        article('b/', 100, 'beta'),
      ]),
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
    expect(localMap.has('b/')).toBe(true)
  })

  it('收到 206 时从断点偏移继续解析并恢复 meta 头', async () => {
    // 场景：历史同步中断在 byte 120，已缓存文章 a/
    // 续传发送 Range: bytes=120- 与 If-Range: "etag-1"
    // 服务端返回 206，仅包含后续的 b/ 文章行（不含第 1 行 Meta）
    let sentHeaders: HeadersInit | undefined
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])
    const progress: SearchProgress[] = []
    const receivedDocs: IndexedDoc[] = []
    let receivedMeta: unknown

    const bLine = article('b/', 100, 'beta')
    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 120,
        etag: '"etag-1"',
        status: 'syncing',
        scannedCount: 1,
        meta: {
          _type: 'meta',
          total: 2,
          allIds: ['a/', 'b/'],
          allM: [200, 100],
        },
        updatedAt: Date.now(),
      },
      handlers: {
        onMeta: (m) => {
          receivedMeta = m
        },
        onDocument: (doc) => receivedDocs.push(doc),
        onProgress: (p) => progress.push(p),
      },
      processPost,
      fetchImpl: createFetch([bLine], {
        status: 206,
        headers: {
          'Content-Range': `bytes 120-${120 + bLine.length - 1}/${120 + bLine.length}`,
          ETag: '"etag-1"',
        },
        onRequest: (_url, init) => {
          sentHeaders = init?.headers
        },
      }),
    })

    // 验证请求头带有 Range 与 If-Range
    expect((sentHeaders as Record<string, string>)?.['Range']).toBe('bytes=120-')
    expect((sentHeaders as Record<string, string>)?.['If-Range']).toBe('"etag-1"')

    // 验证恢复了 meta 头部
    expect(receivedMeta).toMatchObject({ total: 2, allIds: ['a/', 'b/'] })

    // 验证成功解析 b/
    expect(result.resumed).toBe(true)
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('b/')
    expect(localMap.has('b/')).toBe(true)
    expect(result.scannedCount).toBe(2)
    expect(result.totalCount).toBe(2)
    expect(result.finalSyncState?.status).toBe('completed')
    expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100 })
  })

  it('收到 200 时优雅回退全量解析并清理旧局部缓存', async () => {
    // 场景：历史同步中断过（syncing 状态），本地存有部分脏数据 dirty/
    // 客户端尝试 Range 续传，但服务端返回 200（服务端不支持 Range 或重新构建导致 ETag 不匹配）
    // 预期：自动清理之前的局部 dirty 数据，从 byte 0 接收全新全量数据
    const dirty = processPost({ id: 'dirty/', t: 'Dirty', u: '/dirty/', m: 50, g: [], k: [], c: 'dirty' })
    const localMap = new Map<string, IndexedDoc>([['dirty/', dirty]])
    const removed: string[] = []
    const committedBatches: { toPut: IndexedDoc[]; toDelete: string[]; syncState?: IndexSyncState }[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 80,
        etag: '"old-etag"',
        status: 'syncing',
        updatedAt: Date.now(),
      },
      onBatchCommit: async (batch) => {
        committedBatches.push(batch)
      },
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: createFetch(
        [
          meta(1, ['new-clean/'], [300]),
          article('new-clean/', 300, 'clean post'),
        ],
        {
          status: 200,
          headers: { ETag: '"new-etag"' },
        },
      ),
    })

    expect(result.resumed).toBe(false)
    expect(removed).toContain('dirty/')
    expect(localMap.has('dirty/')).toBe(false)
    expect(localMap.has('new-clean/')).toBe(true)
    expect(result.toDelete).toEqual(['dirty/'])
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('new-clean/')
    expect(result.finalSyncState?.etag).toBe('"new-etag"')
    expect(result.finalSyncState?.status).toBe('completed')

    // 验证 onBatchCommit 中提交了对 dirty/ 的物理持久化删除
    expect(committedBatches.length).toBeGreaterThanOrEqual(1)
    const allDeletedIds = committedBatches.flatMap((b) => b.toDelete)
    expect(allDeletedIds).toContain('dirty/')
  })

  it('收到 416 时自动重试无 Range 全量拉取', async () => {
    // 场景：服务端重新发布后体积变小，客户端请求的 offset 越界导致 416
    // 客户端应自动丢弃 offset，重新发起无 Range 头的纯 GET，并成功拉取
    const requests: { url: string; headers?: HeadersInit }[] = []
    let callCount = 0

    const fullJsonl = [
      meta(1, ['fresh/'], [100]),
      article('fresh/', 100, 'fresh content'),
    ]

    const customFetch = (async (url: string, init?: RequestInit) => {
      callCount++
      requests.push({ url, headers: init?.headers })
      if (callCount === 1) {
        // 第一次请求返回 416 Range Not Satisfiable
        return new Response('', { status: 416, statusText: 'Range Not Satisfiable' })
      }
      // 第二次重试请求返回 200 OK 全量数据
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of fullJsonl) controller.enqueue(encoder.encode(line))
          controller.close()
        },
      })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch

    const localMap = new Map<string, IndexedDoc>()
    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 999999, // 越界 offset
        etag: '"etag"',
        status: 'syncing',
        updatedAt: Date.now(),
      },
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: customFetch,
    })

    expect(callCount).toBe(2)
    // 第一次带了 Range
    expect((requests[0].headers as Record<string, string>)?.['Range']).toBe('bytes=999999-')
    // 第二次无 Range
    expect((requests[1].headers as Record<string, string>)?.['Range']).toBeUndefined()

    // 自动重试成功解析
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('fresh/')
    expect(localMap.has('fresh/')).toBe(true)
    expect(result.finalSyncState?.status).toBe('completed')
  })

  it('收到 304 时直接完成无需传输数据', async () => {
    // 场景：已同步完成 (completed)，发送 If-None-Match
    // 服务端返回 304 Not Modified
    // 预期：0 字节瞬间完成，上报 100% 进度
    let sentHeaders: HeadersInit | undefined
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 100, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])
    const progress: SearchProgress[] = []

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 500,
        etag: '"stable-etag"',
        status: 'completed',
        meta: {
          _type: 'meta',
          total: 1,
          allIds: ['a/'],
          allM: [100],
        },
        updatedAt: Date.now(),
      },
      handlers: {
        onDocument: () => {},
        onProgress: (p) => progress.push(p),
      },
      processPost,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sentHeaders = init?.headers
        return new Response(null, { status: 304, statusText: 'Not Modified' })
      }) as unknown as typeof fetch,
    })

    expect((sentHeaders as Record<string, string>)?.['If-None-Match']).toBe('"stable-etag"')
    expect(result.resumed).toBe(true)
    expect(result.toPut).toHaveLength(0)
    expect(result.toDelete).toHaveLength(0)
    expect(result.scannedCount).toBe(0)
    expect(result.totalCount).toBe(1)
    expect(progress.at(-1)).toMatchObject({ loaded: 1, total: 1, percent: 100 })
  })

  it('分批持久化回调按批次触发并提交正确行边界偏移', async () => {
    // 场景：包含 120 篇文章，batchSize 设为 50
    // 预期：触发 3 次 onBatchCommit：前两次各 50 篇 (syncing)，最后一次 20 篇 (completed)
    // 并且每次提交的 byteOffset 严格等于完整行末尾 \n 处的全局字节数
    const totalArticles = 120
    const allIds = Array.from({ length: totalArticles }, (_, i) => `p${i}/`)
    const allM = Array.from({ length: totalArticles }, () => 1)

    const chunks = [
      meta(totalArticles, allIds, allM),
      ...allIds.map((id) => article(id, 1, `content of ${id}`)),
    ]

    const committedBatches: { count: number; byteOffset: number; status: string }[] = []
    const localMap = new Map<string, IndexedDoc>()

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      batchSize: 50,
      handlers: { onDocument: () => {} },
      processPost,
      onBatchCommit: async (batch) => {
        committedBatches.push({
          count: batch.toPut.length,
          byteOffset: batch.syncState.byteOffset,
          status: batch.syncState.status,
        })
      },
      fetchImpl: createFetch(chunks),
    })

    // Batch 0: Line 1 Meta 接收时提交初始 sync_state (count 0, syncing)
    // Batch 1: 50 篇 (count 50, syncing)
    // Batch 2: 50 篇 (count 50, syncing)
    // Batch 3: 20 篇 (count 20, completed)
    expect(committedBatches.length).toBeGreaterThanOrEqual(3)
    const articleBatches = committedBatches.filter((b) => b.count > 0)
    expect(articleBatches[0].count).toBe(50)
    expect(articleBatches[0].status).toBe('syncing')
    expect(articleBatches[1].count).toBe(50)
    expect(articleBatches[1].status).toBe('syncing')
    expect(articleBatches[2].count).toBe(20)
    expect(articleBatches[2].status).toBe('completed')

    // 偏移量单调递增，且终态偏移量大于 0
    for (let i = 1; i < committedBatches.length; i++) {
      expect(committedBatches[i].byteOffset).toBeGreaterThan(committedBatches[i - 1].byteOffset)
    }

    expect(result.toPut).toHaveLength(120)
    expect(result.finalSyncState?.status).toBe('completed')
  })
})

import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/web/core/engine'
import { createPostStore } from '../../src/web/core/idb'
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { IndexedDoc } from '../../src/shared/types'

function makeMeta(total: number, allIds: string[], allM?: number[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds, ...(allM ? { allM } : {}) })}\n`
}

function makeArticle(id: string, m: number, title: string, content: string, tags: string[] = ['test']): string {
  return `${JSON.stringify({ id, t: title, u: `/${id}`, m, g: tags, k: ['emp'], c: content })}\n`
}

function createTruncatedStream(
  bytes: Uint8Array,
  cutoff: number,
  modeOrErrorMsg: 'close' | 'error' | string = 'close',
): ReadableStream<Uint8Array> {
  let sent = 0
  const slice = bytes.subarray(0, cutoff)
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= slice.length) {
        if (modeOrErrorMsg === 'close') {
          controller.close()
        } else {
          controller.error(
            new Error(
              typeof modeOrErrorMsg === 'string' && modeOrErrorMsg !== 'error'
                ? modeOrErrorMsg
                : 'Simulated stream error',
            ),
          )
        }
        return
      }
      const nextChunkSize = Math.min(512, slice.length - sent)
      const chunk = slice.subarray(sent, sent + nextChunkSize)
      sent += nextChunkSize
      controller.enqueue(chunk)
    },
  })
}

describe('Challenger Adversarial Stress Suite: HTTP 200 Fallback & IDB Residual Elimination', () => {
  // =========================================================================
  // Challenge 1: Drastic Downsizing 200 Fallback (100 Partial Posts -> 3 Fresh Posts)
  // =========================================================================
  it('Challenge 1: 500 篇大规模站点中断后，服务端缩容回退 200 仅剩 3 篇：验证 IDB 中旧局部文章 100% 彻底清除，无任何幽灵残留', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_adversarial_downsizing_db'
    const targetUrl = '/search.jsonl'

    // 会话 1：500 篇文章的站点，同步至第 100 篇时模拟网络硬中断
    const v1Total = 500
    const v1Ids = Array.from({ length: v1Total }, (_, i) => `v1-stale-${i}/`)
    const v1M = Array.from({ length: v1Total }, (_, i) => 1000 + i)
    const v1Lines = [
      makeMeta(v1Total, v1Ids, v1M),
      ...v1Ids.map((id, i) => makeArticle(id, v1M[i], `V1 Title ${i}`, `V1 Content ${i} staleuniquecontent`)),
    ]
    const v1Bytes = new TextEncoder().encode(v1Lines.join(''))

    // 截取前 100 篇对应的字节
    let cutOffset = 0
    let linesFound = 0
    for (let i = 0; i < v1Bytes.length; i++) {
      if (v1Bytes[i] === 10) {
        linesFound++
        if (linesFound === 101) { // 1 meta + 100 posts
          cutOffset = i + 1
          break
        }
      }
    }

    const session1Fetch = (async () => {
      const stream = createTruncatedStream(v1Bytes, cutOffset, 'close')
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"v1-large-etag"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })

    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证会话 1 中断时确实持久化了 100 篇旧文章
    const storeAfter1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs1 = await storeAfter1.getAll()
    expect(docs1.size).toBe(100)
    expect(docs1.has('v1-stale-0/')).toBe(true)
    expect(docs1.has('v1-stale-99/')).toBe(true)

    // 会话 2：服务端大幅缩容并修改 ETag，全站只剩 3 篇全新文章
    const v2Total = 3
    const v2Ids = ['v2-fresh-alpha/', 'v2-fresh-beta/', 'v2-fresh-gamma/']
    const v2M = [9001, 9002, 9003]
    const v2Lines = [
      makeMeta(v2Total, v2Ids, v2M),
      ...v2Ids.map((id, i) => makeArticle(id, v2M[i], `Fresh ${id}`, `Fresh Content ${i} brandnewcontent`)),
    ]
    const v2Bytes = new TextEncoder().encode(v2Lines.join(''))

    let capturedHeaders2: HeadersInit | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders2 = init?.headers
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(v2Bytes)
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"v2-small-fresh-etag"' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })

    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证 Session 2 发送了 If-Range
    expect((capturedHeaders2 as Record<string, string>)?.['If-Range']).toBe('"v1-large-etag"')

    // 验证内存引擎：大小严格为 3，无任何 V1 文章
    expect(engine2.index.size).toBe(3)
    expect(engine2.index.search('staleuniquecontent', 200)).toHaveLength(0)
    expect(engine2.index.search('brandnewcontent', 10)).toHaveLength(3)

    // 核心断言：验证 IndexedDB 中无任何残留！旧的 100 篇全部删除！
    const storeAfter2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await storeAfter2.getAll()
    expect(docs2.size).toBe(3)
    for (let i = 0; i < 100; i++) {
      expect(docs2.has(`v1-stale-${i}/`)).toBe(false)
    }
    expect(docs2.has('v2-fresh-alpha/')).toBe(true)
    expect(docs2.has('v2-fresh-beta/')).toBe(true)
    expect(docs2.has('v2-fresh-gamma/')).toBe(true)
  })

  // =========================================================================
  // Challenge 2: 200 Fallback on Completely Empty Site (0 Posts)
  // =========================================================================
  it('Challenge 2: 中断后服务端回退 200 且站点清空至 0 篇文章：验证 IDB 彻底归零且检索无异常', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_adversarial_empty_db'
    const targetUrl = '/search.jsonl'

    // 会话 1：同步 30 篇文章中断
    const v1Total = 30
    const v1Ids = Array.from({ length: v1Total }, (_, i) => `empty-test-${i}/`)
    const v1M = Array.from({ length: v1Total }, (_, i) => 500 + i)
    const v1Lines = [
      makeMeta(v1Total, v1Ids, v1M),
      ...v1Ids.map((id, i) => makeArticle(id, v1M[i], `Title ${i}`, `Content ${i}`)),
    ]
    const v1Bytes = new TextEncoder().encode(v1Lines.join(''))

    const session1Fetch = (async () => {
      return new Response(v1Bytes, {
        status: 200,
        headers: { ETag: '"v1-etag"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    expect((await store1.getAll()).size).toBe(30)

    // 会话 2：200 回退，全站 0 篇文章
    const emptyLines = [makeMeta(0, [], [])]
    const emptyBytes = new TextEncoder().encode(emptyLines.join(''))

    const session2Fetch = (async () => {
      return new Response(emptyBytes, {
        status: 200,
        headers: { ETag: '"v2-empty-etag"' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(engine2.index.size).toBe(0)
    expect(engine2.index.search('Content', 10)).toHaveLength(0)

    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(0)
  })

  // =========================================================================
  // Challenge 3: Server That NEVER Supports Range (Same ETag, Returns 200 OK)
  // =========================================================================
  it('Challenge 3: 服务端完全不支持 HTTP Range（无论 Range 请求头如何均返回 200 OK，ETag 不变）：验证回退全量拉取后 IDB 无重复、无残留', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_no_range_server_db'
    const targetUrl = '/search.jsonl'

    const total = 80
    const ids = Array.from({ length: total }, (_, i) => `norange-${i}/`)
    const ms = Array.from({ length: total }, (_, i) => 2000 + i)
    const allLines = [
      makeMeta(total, ids, ms),
      ...ids.map((id, i) => makeArticle(id, ms[i], `NoRange Title ${i}`, `NoRange Content ${i} keywordnorange`)),
    ]
    const fullBytes = new TextEncoder().encode(allLines.join(''))

    // 截取前 55 篇模拟中断（前 50 篇触发 batchCommit 写入 IDB）
    let cutOffset = 0
    let linesFound = 0
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 10) {
        linesFound++
        if (linesFound === 56) { // 1 meta + 55 posts
          cutOffset = i + 1
          break
        }
      }
    }

    // 会话 1：中断在第 55 篇
    const session1Fetch = (async () => {
      const stream = createTruncatedStream(fullBytes, cutOffset, 'Simulated network drop in Session 1')
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"constant-static-etag"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    expect((await store1.getAll()).size).toBe(50)

    // 会话 2：客户端带 Range 请求，但服务端忽略 Range 直接返回 200 OK（ETag 保持不变）
    let requestedRangeHeader: string | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      requestedRangeHeader = (init?.headers as Record<string, string>)?.['Range']
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fullBytes)
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"constant-static-etag"' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证客户端确实发起了 Range 请求
    expect(requestedRangeHeader).toMatch(/^bytes=\d+-$/)

    // 验证最终倒排索引与 IDB 数据严格为 80 篇，无重复无缺失
    expect(engine2.index.size).toBe(80)
    expect(engine2.index.search('keywordnorange', 100)).toHaveLength(80)

    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(80)
    for (let i = 0; i < total; i++) {
      expect(docs2.has(`norange-${i}/`)).toBe(true)
    }
  })

  // =========================================================================
  // Challenge 4: Last-Modified Validator Instead of ETag
  // =========================================================================
  it('Challenge 4: 服务端仅使用 Last-Modified 校验器（无 ETag）：在 Last-Modified 变化后 200 回退，验证 IDB 彻底清除旧缓存', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_last_modified_fallback_db'
    const targetUrl = '/search.jsonl'

    const v1Total = 80
    const v1Ids = Array.from({ length: v1Total }, (_, i) => `lm-v1-${i}/`)
    const v1M = Array.from({ length: v1Total }, (_, i) => 100 + i)
    const v1Lines = [
      makeMeta(v1Total, v1Ids, v1M),
      ...v1Ids.map((id, i) => makeArticle(id, v1M[i], `LM Title ${i}`, `LM Content ${i}`)),
    ]
    const v1Bytes = new TextEncoder().encode(v1Lines.join(''))

    // 会话 1：同步 55 篇中断（前 50 篇触发 batchCommit 写入 IDB）
    let cutOffset = 0
    let linesFound = 0
    for (let i = 0; i < v1Bytes.length; i++) {
      if (v1Bytes[i] === 10) {
        linesFound++
        if (linesFound === 56) { // 1 meta + 55 posts
          cutOffset = i + 1
          break
        }
      }
    }

    const session1Fetch = (async () => {
      const stream = createTruncatedStream(v1Bytes, cutOffset, 'Simulated network drop in Session 1')
      return new Response(stream, {
        status: 200,
        headers: { 'Last-Modified': 'Wed, 21 Oct 2025 07:28:00 GMT' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    expect((await store1.getAll()).size).toBe(50)

    // 会话 2：Last-Modified 变更为新时间戳，服务端回退 200 全量（含 5 篇全新的文章）
    const v2Total = 5
    const v2Ids = Array.from({ length: v2Total }, (_, i) => `lm-v2-fresh-${i}/`)
    const v2M = Array.from({ length: v2Total }, (_, i) => 900 + i)
    const v2Lines = [
      makeMeta(v2Total, v2Ids, v2M),
      ...v2Ids.map((id, i) => makeArticle(id, v2M[i], `New LM Title ${i}`, `New LM Content ${i}`)),
    ]
    const v2Bytes = new TextEncoder().encode(v2Lines.join(''))

    let capturedHeaders2: HeadersInit | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders2 = init?.headers
      return new Response(v2Bytes, {
        status: 200,
        headers: { 'Last-Modified': 'Fri, 24 Oct 2025 12:00:00 GMT' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect((capturedHeaders2 as Record<string, string>)?.['If-Range']).toBe('Wed, 21 Oct 2025 07:28:00 GMT')

    // 核心断言：IDB 中旧的 50 篇持久化文章全部删除，只剩下 5 篇新文章
    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(5)
    for (let i = 0; i < 80; i++) {
      expect(docs2.has(`lm-v1-${i}/`)).toBe(false)
    }
    for (let i = 0; i < 5; i++) {
      expect(docs2.has(`lm-v2-fresh-${i}/`)).toBe(true)
    }
  })

  // =========================================================================
  // Challenge 5: HTTP 416 Range Not Satisfiable with Dirty IDB State
  // =========================================================================
  it('Challenge 5: 脏缓存与越界 offset 触发 HTTP 416，自动重试无 Range 全量拉取：验证旧脏文章从 IDB 彻底抹除', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_416_dirty_purge_db'
    const targetUrl = '/search.jsonl'

    // 人工在 IDB 中注入脏文章与处于 syncing 状态的 offset
    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    const dirtyDocs: IndexedDoc[] = [
      processPost({ id: 'ghost-1/', t: 'Ghost 1', u: '/ghost-1/', m: 10, g: [], k: [], c: 'ghost doc' }),
      processPost({ id: 'ghost-2/', t: 'Ghost 2', u: '/ghost-2/', m: 20, g: [], k: [], c: 'ghost doc' }),
    ]
    await store.applyBatch(dirtyDocs, [], {
      key: `sync_state:${targetUrl}`,
      url: targetUrl,
      byteOffset: 888888, // 远超新文件大小的越界 offset
      etag: '"old-stale-etag"',
      status: 'syncing',
      completed: false,
      updatedAt: Date.now(),
    })

    const initialDocs = await store.getAll()
    expect(initialDocs.size).toBe(2)

    // 新文件仅包含 2 篇全新文章
    const freshLines = [
      makeMeta(2, ['real-1/', 'real-2/'], [100, 200]),
      makeArticle('real-1/', 100, 'Real 1', 'real content 1'),
      makeArticle('real-2/', 200, 'Real 2', 'real content 2'),
    ]
    const freshBytes = new TextEncoder().encode(freshLines.join(''))

    let requestCount = 0
    const fetchImpl = (async (_url: string, _init?: RequestInit) => {
      requestCount++
      if (requestCount === 1) {
        // 第一次请求（携带越界 Range）返回 416
        return new Response('', { status: 416, statusText: 'Range Not Satisfiable' })
      }
      // 第二次全量重试请求返回 200
      return new Response(freshBytes, {
        status: 200,
        headers: { ETag: '"fresh-new-etag"' },
      })
    }) as unknown as typeof fetch

    const engine = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl,
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(requestCount).toBe(2)

    // 验证倒排索引
    expect(engine.index.size).toBe(2)
    expect(engine.index.has('ghost-1/')).toBe(false)
    expect(engine.index.has('ghost-2/')).toBe(false)
    expect(engine.index.has('real-1/')).toBe(true)
    expect(engine.index.has('real-2/')).toBe(true)

    // 核心断言：验证 IDB 中 ghost-1 与 ghost-2 彻底消失！
    const storeAfter = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docsAfter = await storeAfter.getAll()
    expect(docsAfter.size).toBe(2)
    expect(docsAfter.has('ghost-1/')).toBe(false)
    expect(docsAfter.has('ghost-2/')).toBe(false)
    expect(docsAfter.has('real-1/')).toBe(true)
    expect(docsAfter.has('real-2/')).toBe(true)
  })

  // =========================================================================
  // Challenge 6: Cascading Interrupted 200 Fallbacks (Interrupted During Fallback)
  // =========================================================================
  it('Challenge 6: 级联多次中断且中途 ETag 连续变更：验证最终状态仅保留最终版本文章，无任何前置中间版本的脏数据', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_cascading_fallbacks_db'
    const targetUrl = '/search.jsonl'

    // 轮次 1：版本 A，30 篇文章，中断在第 10 篇
    const idsA = Array.from({ length: 30 }, (_, i) => `vA-${i}/`)
    const msA = Array.from({ length: 30 }, (_, i) => 100 + i)
    const linesA = [
      makeMeta(30, idsA, msA),
      ...idsA.map((id, i) => makeArticle(id, msA[i], `Title A ${i}`, `Content A ${i}`)),
    ]
    const bytesA = new TextEncoder().encode(linesA.join(''))

    let cutA = 0
    let countA = 0
    for (let i = 0; i < bytesA.length; i++) {
      if (bytesA[i] === 10 && ++countA === 11) { cutA = i + 1; break }
    }

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => new Response(bytesA.subarray(0, cutA), {
        status: 200,
        headers: { ETag: '"etag-A"' },
      })) as unknown as typeof fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 确认 IDB 存入 10 篇版本 A 文章
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    expect((await store1.getAll()).size).toBe(10)

    // 轮次 2：版本 B，20 篇文章，ETag 变更触发 200 回退，在第 5 篇再次硬中断！
    const idsB = Array.from({ length: 20 }, (_, i) => `vB-${i}/`)
    const msB = Array.from({ length: 20 }, (_, i) => 200 + i)
    const linesB = [
      makeMeta(20, idsB, msB),
      ...idsB.map((id, i) => makeArticle(id, msB[i], `Title B ${i}`, `Content B ${i}`)),
    ]
    const bytesB = new TextEncoder().encode(linesB.join(''))

    let cutB = 0
    let countB = 0
    for (let i = 0; i < bytesB.length; i++) {
      if (bytesB[i] === 10 && ++countB === 6) { cutB = i + 1; break } // 1 meta + 5 posts
    }

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => new Response(bytesB.subarray(0, cutB), {
        status: 200,
        headers: { ETag: '"etag-B"' },
      })) as unknown as typeof fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 轮次 2 此时 IDB 应该已经删除了版本 A 的所有文章，并存入了版本 B 的前 5 篇
    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(5)
    expect(docs2.has('vA-0/')).toBe(false)
    expect(docs2.has('vB-0/')).toBe(true)

    // 轮次 3：版本 C，10 篇文章，ETag 再次变更触发 200 回退，这次完整拉取完毕！
    const idsC = Array.from({ length: 10 }, (_, i) => `vC-${i}/`)
    const msC = Array.from({ length: 10 }, (_, i) => 300 + i)
    const linesC = [
      makeMeta(10, idsC, msC),
      ...idsC.map((id, i) => makeArticle(id, msC[i], `Title C ${i}`, `Content C ${i}`)),
    ]
    const bytesC = new TextEncoder().encode(linesC.join(''))

    const engine3 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => new Response(bytesC, {
        status: 200,
        headers: { ETag: '"etag-C"' },
      })) as unknown as typeof fetch,
    })
    await engine3.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 核心断言：最终 IDB 与引擎内必须严格只有版本 C 的 10 篇！
    // 版本 A 与版本 B 的任何文章都不能残留！
    expect(engine3.index.size).toBe(10)
    const store3 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs3 = await store3.getAll()
    expect(docs3.size).toBe(10)

    for (let i = 0; i < 30; i++) {
      expect(docs3.has(`vA-${i}/`)).toBe(false)
    }
    for (let i = 0; i < 20; i++) {
      expect(docs3.has(`vB-${i}/`)).toBe(false)
    }
    for (let i = 0; i < 10; i++) {
      expect(docs3.has(`vC-${i}/`)).toBe(true)
    }
  })

  // =========================================================================
  // Challenge 7: Extreme 1-Byte Chunked 200 Fallback with Multi-byte UTF-8
  // =========================================================================
  it('Challenge 7: 1 字节激进切片回退 200：多字节 CJK / Emoji 字符无损坏，旧残留文章 100% 清除', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_1byte_stream_fallback_db'
    const targetUrl = '/search.jsonl'

    // 会话 1：存入脏数据
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    await store1.applyBatch(
      [processPost({ id: 'dirty-cjk/', t: '旧文章', u: '/dirty-cjk/', m: 1, g: [], k: [], c: '旧内容' })],
      [],
      {
        key: `sync_state:${targetUrl}`,
        url: targetUrl,
        byteOffset: 50,
        etag: '"etag-v1"',
        status: 'syncing',
        completed: false,
        updatedAt: Date.now(),
      },
    )

    // 会话 2：200 回退，流以 1 字节为单位推进
    const freshArticles = [
      { id: 'fresh-cjk-1/', m: 10, t: '深入理解流式架构 ⚡', c: '支持中文字符集与表情符号 🌟' },
      { id: 'fresh-cjk-2/', m: 20, t: '断点续传与缓存控制 🚀', c: 'IndexedDB 事务与原子批处理' },
    ]
    const freshLines = [
      makeMeta(2, ['fresh-cjk-1/', 'fresh-cjk-2/'], [10, 20]),
      ...freshArticles.map((a) => makeArticle(a.id, a.m, a.t, a.c)),
    ]
    const freshBytes = new TextEncoder().encode(freshLines.join(''))

    const session2Fetch = (async () => {
      let offset = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset < freshBytes.length) {
            controller.enqueue(freshBytes.subarray(offset, offset + 1))
            offset++
          } else {
            controller.close()
          }
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"etag-v2"' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(engine2.index.size).toBe(2)
    expect(engine2.index.has('dirty-cjk/')).toBe(false)
    expect(engine2.index.search('深入理解', 10)).toHaveLength(1)
    expect(engine2.index.search('事务', 10)).toHaveLength(1)

    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(2)
    expect(docs2.has('dirty-cjk/')).toBe(false)
    expect(docs2.has('fresh-cjk-1/')).toBe(true)
    expect(docs2.has('fresh-cjk-2/')).toBe(true)
  })

  // =========================================================================
  // Challenge 8: Direct syncJsonlStream Batch Contract Verification
  // =========================================================================
  it('Challenge 8: 直接调用 syncJsonlStream 验证 200 回退时 toDelete 数组与 onBatchCommit 提交契约严格匹配', async () => {
    const dirtyPost1 = processPost({ id: 'batch-stale-1/', t: 'Stale 1', u: '/1/', m: 1, g: [], k: [], c: 'c1' })
    const dirtyPost2 = processPost({ id: 'batch-stale-2/', t: 'Stale 2', u: '/2/', m: 2, g: [], k: [], c: 'c2' })
    const localMap = new Map<string, IndexedDoc>([
      ['batch-stale-1/', dirtyPost1],
      ['batch-stale-2/', dirtyPost2],
    ])

    const committedBatches: { toPut: IndexedDoc[]; toDelete: string[] }[] = []
    const removedFromHandler: string[] = []

    const fullLines = [
      makeMeta(1, ['fresh-only/'], [999]),
      makeArticle('fresh-only/', 999, 'Fresh Only', 'fresh content'),
    ]
    const fullBytes = new TextEncoder().encode(fullLines.join(''))

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:/search.jsonl',
        url: '/search.jsonl',
        byteOffset: 1234,
        etag: '"stale-etag"',
        status: 'syncing',
        updatedAt: Date.now(),
      },
      onBatchCommit: async (batch) => {
        committedBatches.push({ toPut: [...batch.toPut], toDelete: [...batch.toDelete] })
      },
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removedFromHandler.push(id),
      },
      processPost,
      fetchImpl: (async () => new Response(fullBytes, {
        status: 200,
        headers: { ETag: '"fresh-etag"' },
      })) as unknown as typeof fetch,
    })

    // 验证返回值
    expect(result.resumed).toBe(false)
    expect(result.toDelete).toEqual(expect.arrayContaining(['batch-stale-1/', 'batch-stale-2/']))
    expect(result.toDelete).toHaveLength(2)
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('fresh-only/')

    // 验证回调
    expect(removedFromHandler).toEqual(expect.arrayContaining(['batch-stale-1/', 'batch-stale-2/']))

    // 验证持久化批次提交：首个批次必须包含这两篇删除
    const allDeletedInBatches = committedBatches.flatMap((b) => b.toDelete)
    expect(allDeletedInBatches).toContain('batch-stale-1/')
    expect(allDeletedInBatches).toContain('batch-stale-2/')

    // 验证 localMap 最终状态
    expect(localMap.has('batch-stale-1/')).toBe(false)
    expect(localMap.has('batch-stale-2/')).toBe(false)
    expect(localMap.has('fresh-only/')).toBe(true)
    expect(localMap.size).toBe(1)
  })

  // =========================================================================
  // Challenge 9: Clean EOF Stream Truncation Keeps status: 'syncing' & Resumes Range
  // =========================================================================
  it('Challenge 9: 自然 EOF 提前截断（controller.close() 在 meta.total 之前）时：保持 status=\'syncing\'，准确保留 byteOffset，并在下一次会话中携带 Range 与 If-Range 成功 206 续传', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_natural_eof_resumption_db'
    const targetUrl = '/search.jsonl'

    const totalPosts = 30
    const allIds = Array.from({ length: totalPosts }, (_, i) => `eof-post-${i}/`)
    const allM = Array.from({ length: totalPosts }, (_, i) => 2000 + i)
    const allLines = [
      makeMeta(totalPosts, allIds, allM),
      ...allIds.map((id, i) => makeArticle(id, allM[i], `EOF Title ${i}`, `EOF Content ${i} eofresumption`)),
    ]
    const fullBytes = new TextEncoder().encode(allLines.join(''))

    // 截取前 12 篇对应的字节（未满 50 篇 batchSize 阈值，专门验证 EOF 强制持久化与精密完成判断）
    let cutOffset = 0
    let linesFound = 0
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 10) {
        linesFound++
        if (linesFound === 13) { // 1 meta + 12 posts
          cutOffset = i + 1
          break
        }
      }
    }

    // 会话 1：通过 controller.close() 自然结束流（模拟对端连接正常关闭但数据截断）
    const session1Fetch = (async () => {
      const stream = createTruncatedStream(fullBytes, cutOffset, 'close')
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"eof-v1-etag"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })

    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证会话 1 结束后的持久化状态：
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const syncState1 = await store1.getSyncState(`sync_state:${targetUrl}`)

    // 必须保持 syncing 状态，严禁标记为 completed！
    expect(syncState1).toBeDefined()
    expect(syncState1?.status).toBe('syncing')
    expect(syncState1?.completed).toBe(false)
    expect(syncState1?.byteOffset).toBe(cutOffset)
    expect(syncState1?.byteOffset).toBeGreaterThan(0)
    expect(syncState1?.scannedCount).toBe(12)
    expect(syncState1?.etag).toBe('"eof-v1-etag"')

    // 验证会话 1 IDB 中确实持久化了 12 篇文章
    const docs1 = await store1.getAll()
    expect(docs1.size).toBe(12)
    for (let i = 0; i < 12; i++) {
      expect(docs1.has(`eof-post-${i}/`)).toBe(true)
    }

    // 会话 2：客户端发起续传，服务端返回 206 Partial Content
    let capturedHeaders2: HeadersInit | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders2 = init?.headers
      const requestedRange = (init?.headers as Record<string, string>)?.['Range']
      const rangeMatch = requestedRange?.match(/^bytes=(\d+)-$/)
      const startOffset = rangeMatch ? parseInt(rangeMatch[1], 10) : 0

      const partialBytes = fullBytes.subarray(startOffset)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(partialBytes)
          controller.close()
        },
      })

      return new Response(stream, {
        status: 206,
        headers: {
          ETag: '"eof-v1-etag"',
          'Content-Range': `bytes ${startOffset}-${fullBytes.length - 1}/${fullBytes.length}`,
        },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session2Fetch,
    })

    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证会话 2 发送了精确的 Range 与 If-Range 请求头
    expect((capturedHeaders2 as Record<string, string>)?.['Range']).toBe(`bytes=${cutOffset}-`)
    expect((capturedHeaders2 as Record<string, string>)?.['If-Range']).toBe('"eof-v1-etag"')

    // 验证会话 2 完成后，所有 30 篇文章全部同步完毕
    expect(engine2.index.size).toBe(totalPosts)
    const searchResults = engine2.index.search('eofresumption', 50)
    expect(searchResults).toHaveLength(totalPosts)

    // 验证 IDB 最终持久化状态：终态更新为 completed
    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const syncState2 = await store2.getSyncState(`sync_state:${targetUrl}`)
    expect(syncState2?.status).toBe('completed')
    expect(syncState2?.completed).toBe(true)
    expect(syncState2?.scannedCount).toBe(totalPosts)

    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(totalPosts)
    for (let i = 0; i < totalPosts; i++) {
      expect(docs2.has(`eof-post-${i}/`)).toBe(true)
    }
  })
})

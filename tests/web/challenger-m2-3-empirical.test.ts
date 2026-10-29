import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/web/core/engine'
import { createPostStore } from '../../src/web/core/idb'
import { processPost } from '../../src/web/core/index-store'
import type { IndexedDoc } from '../../src/shared/types'

function makeMeta(total: number, allIds: string[], allM?: number[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds, ...(allM ? { allM } : {}) })}\n`
}

function makeArticle(id: string, m: number, title: string, content: string, tags: string[] = ['test']): string {
  return `${JSON.stringify({ id, t: title, u: `/${id}`, m, g: tags, k: ['emp'], c: content })}\n`
}

function createCleanEofStream(bytes: Uint8Array, cutoff: number, chunkSize = 256): ReadableStream<Uint8Array> {
  let sent = 0
  const slice = bytes.subarray(0, cutoff)
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= slice.length) {
        controller.close()
        return
      }
      const nextChunkSize = Math.min(chunkSize, slice.length - sent)
      const chunk = slice.subarray(sent, sent + nextChunkSize)
      sent += nextChunkSize
      controller.enqueue(chunk)
    },
  })
}

describe('Teamwork Challenger M2-3: Empirical Stress & Edge Case Verification', () => {
  // =========================================================================
  // Adversarial 1: Boundary Fuzzing — Clean EOF at exact structural boundaries
  // =========================================================================
  describe('Adversarial 1: Clean EOF truncation at diverse byte boundaries', () => {
    const total = 20
    const ids = Array.from({ length: total }, (_, i) => `fuzz-${i}/`)
    const ms = Array.from({ length: total }, (_, i) => 1000 + i)
    const lines = [
      makeMeta(total, ids, ms),
      ...ids.map((id, i) => makeArticle(id, ms[i], `Fuzz Title ${i}`, `Fuzz Content ${i} boundaryfuzz`)),
    ]
    const fullBytes = new TextEncoder().encode(lines.join(''))

    // Find byte offsets:
    // 0: start
    // metaMid: middle of meta JSON
    // metaEnd: right after meta '\n'
    // post0Mid: middle of post 0 JSON
    // post0End: right after post 0 '\n'
    // post5Mid: middle of post 5 JSON
    // post19End: full stream
    const newlineIndices: number[] = []
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 10) newlineIndices.push(i + 1)
    }

    const testBoundaries = [
      { name: 'inside meta line', cutoff: Math.floor(newlineIndices[0] / 2), expectZeroDocs: true },
      { name: 'right after meta line (0 posts)', cutoff: newlineIndices[0], expectZeroDocs: true },
      { name: 'middle of post 0', cutoff: newlineIndices[0] + 15, expectZeroDocs: true },
      { name: 'right after post 0 (1 post)', cutoff: newlineIndices[1], expectCount: 1 },
      { name: 'middle of post 5 (partial JSON)', cutoff: newlineIndices[5] + 20, expectCount: 5 },
      { name: 'right after post 5 (6 posts)', cutoff: newlineIndices[6], expectCount: 6 },
      { name: 'at penultimate post 18 (19 posts)', cutoff: newlineIndices[19], expectCount: 19 },
    ]

    for (const b of testBoundaries) {
      it(`Boundary [${b.name}] cleanly maintains syncing state and resumes to 100%`, async () => {
        const sharedFactory = new IDBFactory()
        const dbName = `test_boundary_${b.cutoff}_db`
        const targetUrl = '/search.jsonl'

        // Session 1: Clean EOF at b.cutoff
        const session1Fetch = (async () => {
          const stream = createCleanEofStream(fullBytes, b.cutoff)
          return new Response(stream, {
            status: 200,
            headers: { ETag: '"fuzz-boundary-etag"' },
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
        const state1 = await store1.getSyncState(`sync_state:${targetUrl}`)

        // CRITICAL INVARIANT: Since b.cutoff < full stream, status MUST NEVER be 'completed'
        expect(state1?.status).toBe('syncing')
        expect(state1?.completed).toBe(false)

        if (b.expectZeroDocs) {
          const docs1 = await store1.getAll()
          expect(docs1.size).toBe(0)
        } else if (b.expectCount !== undefined) {
          const docs1 = await store1.getAll()
          expect(docs1.size).toBe(b.expectCount)
          expect(state1?.scannedCount).toBe(b.expectCount)
          expect(state1?.byteOffset).toBe(newlineIndices[b.expectCount])
        }

        // Session 2: Resumption
        let session2SentRange: string | undefined
        const session2Fetch = (async (_url: string, init?: RequestInit) => {
          session2SentRange = (init?.headers as Record<string, string>)?.['Range']
          const match = session2SentRange?.match(/^bytes=(\d+)-$/)
          const start = match ? parseInt(match[1], 10) : 0

          const stream = createCleanEofStream(fullBytes.subarray(start), fullBytes.length - start)
          return new Response(stream, {
            status: start > 0 ? 206 : 200,
            headers: {
              ETag: '"fuzz-boundary-etag"',
              ...(start > 0 ? { 'Content-Range': `bytes ${start}-${fullBytes.length - 1}/${fullBytes.length}` } : {}),
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

        // Check resumption header correctness
        if (state1 && state1.byteOffset > 0) {
          expect(session2SentRange).toBe(`bytes=${state1.byteOffset}-`)
        }

        // Verification after Session 2: 100% data integrity
        expect(engine2.index.size).toBe(total)
        const results = engine2.index.search('boundaryfuzz', 50)
        expect(results).toHaveLength(total)

        const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
        const state2 = await store2.getSyncState(`sync_state:${targetUrl}`)
        expect(state2?.status).toBe('completed')
        expect(state2?.completed).toBe(true)
        expect(state2?.scannedCount).toBe(total)

        const docs2 = await store2.getAll()
        expect(docs2.size).toBe(total)
      })
    }
  })

  // =========================================================================
  // Adversarial 2: Cascading Multi-Hop Clean EOF (4 Hops to Full Completion)
  // =========================================================================
  it('Adversarial 2: 连续 4 轮 Clean EOF 中断与增量 206 续传：每一轮保持 syncing，最终无缝合并 100 篇文章', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_multihop_clean_eof_db'
    const targetUrl = '/search.jsonl'

    const totalPosts = 100
    const ids = Array.from({ length: totalPosts }, (_, i) => `hop-${i}/`)
    const ms = Array.from({ length: totalPosts }, (_, i) => 3000 + i)
    const lines = [
      makeMeta(totalPosts, ids, ms),
      ...ids.map((id, i) => makeArticle(id, ms[i], `MultiHop Title ${i}`, `MultiHop Content ${i} cascadingresumption`)),
    ]
    const fullBytes = new TextEncoder().encode(lines.join(''))

    const newlineOffsets: number[] = []
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 10) newlineOffsets.push(i + 1)
    }

    // 4 轮截断点设置：
    // Hop 1: 15 posts
    // Hop 2: 45 posts (+30)
    // Hop 3: 75 posts (+30)
    // Hop 4: 100 posts (all)
    const hops = [15, 45, 75, 100]

    for (let h = 0; h < hops.length; h++) {
      const targetPostCount = hops[h]
      const cutoff = newlineOffsets[targetPostCount] // 1 meta + targetPostCount posts
      const isFinalHop = h === hops.length - 1

      let capturedRange: string | undefined
      const hopFetch = (async (_url: string, init?: RequestInit) => {
        capturedRange = (init?.headers as Record<string, string>)?.['Range']
        const match = capturedRange?.match(/^bytes=(\d+)-$/)
        const start = match ? parseInt(match[1], 10) : 0

        const streamSlice = fullBytes.subarray(start, cutoff)
        const stream = createCleanEofStream(streamSlice, streamSlice.length)

        return new Response(stream, {
          status: start > 0 ? 206 : 200,
          headers: {
            ETag: '"multihop-etag"',
            ...(start > 0 ? { 'Content-Range': `bytes ${start}-${cutoff - 1}/${fullBytes.length}` } : {}),
          },
        })
      }) as unknown as typeof fetch

      const engine = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: () => {},
        fetchImpl: hopFetch,
      })

      await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

      const store = await createPostStore({ indexedDB: sharedFactory, dbName })
      const syncState = await store.getSyncState(`sync_state:${targetUrl}`)
      const docs = await store.getAll()

      expect(docs.size).toBe(targetPostCount)
      expect(engine.index.size).toBe(targetPostCount)

      if (!isFinalHop) {
        expect(syncState?.status).toBe('syncing')
        expect(syncState?.completed).toBe(false)
        expect(syncState?.byteOffset).toBe(cutoff)
        expect(syncState?.scannedCount).toBe(targetPostCount)
      } else {
        expect(syncState?.status).toBe('completed')
        expect(syncState?.completed).toBe(true)
        expect(syncState?.scannedCount).toBe(100)
      }
    }

    // 最终验证全部 100 篇内容完全一致且均可检索
    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const allDocs = await finalStore.getAll()
    expect(allDocs.size).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(allDocs.has(`hop-${i}/`)).toBe(true)
    }
  })

  // =========================================================================
  // Adversarial 3: Final Post Lacks Trailing Newline ('\n')
  // =========================================================================
  it('Adversarial 3: 最后一篇文章末尾无换行符 \'\\n\' 时：stream 正常将最后一篇入库且判定为 completed', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_no_trailing_newline_db'
    const targetUrl = '/search.jsonl'

    const totalPosts = 3
    const ids = ['no-nl-0/', 'no-nl-1/', 'no-nl-2/']
    const ms = [101, 102, 103]
    const line0 = makeMeta(totalPosts, ids, ms)
    const line1 = makeArticle(ids[0], ms[0], 'Title 0', 'Content 0')
    const line2 = makeArticle(ids[1], ms[1], 'Title 1', 'Content 1')
    // 最后一篇文章刻意去除末尾的 '\n'
    const line3NoNl = makeArticle(ids[2], ms[2], 'Title 2', 'Content 2 notrailingnewline').trimEnd()

    const rawString = line0 + line1 + line2 + line3NoNl
    const bytes = new TextEncoder().encode(rawString)

    const fetchImpl = (async () => {
      const stream = createCleanEofStream(bytes, bytes.length)
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"no-nl-etag"' },
      })
    }) as unknown as typeof fetch

    const engine = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl,
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 验证所有 3 篇文章均被成功解析
    expect(engine.index.size).toBe(3)
    expect(engine.index.search('notrailingnewline', 10)).toHaveLength(1)

    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    const state = await store.getSyncState(`sync_state:${targetUrl}`)
    expect(state?.status).toBe('completed')
    expect(state?.completed).toBe(true)
    expect(state?.scannedCount).toBe(3)

    const docs = await store.getAll()
    expect(docs.size).toBe(3)
    expect(docs.has('no-nl-2/')).toBe(true)
  })

  // =========================================================================
  // Adversarial 4: Clean EOF on Divergent Update Stream
  // =========================================================================
  it('Adversarial 4: 内容有更新的站点在拉取到变更文章中途 Clean EOF 截断：未完成的变更文章保留 syncing，续传后正确更新变更', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_divergent_eof_db'
    const targetUrl = '/search.jsonl'

    // 会话 0：初始版本 v1，包含 10 篇文章，已全部同步
    const v1Ids = Array.from({ length: 10 }, (_, i) => `art-${i}/`)
    const v1M = Array.from({ length: 10 }, () => 1000)
    const v1Lines = [
      makeMeta(10, v1Ids, v1M),
      ...v1Ids.map((id, i) => makeArticle(id, v1M[i], `V1 Title ${i}`, `V1 Content ${i} oldtag`)),
    ]
    const v1Bytes = new TextEncoder().encode(v1Lines.join(''))

    const engine0 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => new Response(v1Bytes, { status: 200, headers: { ETag: '"v1"' } })) as unknown as typeof fetch,
    })
    await engine0.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    const store0 = await createPostStore({ indexedDB: sharedFactory, dbName })
    expect((await store0.getAll()).size).toBe(10)

    // 会话 1：版本 v2，文章 art-3/ 与 art-7/ 修改了内容与时间戳 m: 2000
    const v2M = v1M.map((m, i) => (i === 3 || i === 7 ? 2000 : m))
    const v2Lines = [
      makeMeta(10, v1Ids, v2M),
      ...v1Ids.map((id, i) =>
        makeArticle(
          id,
          v2M[i],
          `V2 Title ${i}`,
          i === 3 || i === 7 ? `V2 Modified Content ${i} brandnewtag` : `V1 Content ${i} oldtag`,
        ),
      ),
    ]
    const v2Bytes = new TextEncoder().encode(v2Lines.join(''))

    // 截断在 art-3 之后、art-7 之前（比如在第 5 篇后 clean EOF）
    const newlineOffsets: number[] = []
    for (let i = 0; i < v2Bytes.length; i++) {
      if (v2Bytes[i] === 10) newlineOffsets.push(i + 1)
    }
    const cutoffAtPost5 = newlineOffsets[5] // 1 meta + 5 posts (art-0..art-4)

    const session1Fetch = (async () => {
      // 服务端因为 ETag 变化返回 200 全量流，但在第 5 篇后 Clean EOF
      const stream = createCleanEofStream(v2Bytes, cutoffAtPost5)
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"v2"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: session1Fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // 检查 Session 1 截断后的状态：
    // art-3 应当已被更新，但 art-7 还未拉取到
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const state1 = await store1.getSyncState(`sync_state:${targetUrl}`)
    expect(state1?.status).toBe('syncing')
    expect(state1?.completed).toBe(false)
    expect(state1?.scannedCount).toBe(5)

    const docs1 = await store1.getAll()
    const docArt3 = docs1.get('art-3/')
    expect(docArt3?.m).toBe(2000)

    // 会话 2：续传完成后续部分
    let session2Range: string | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      session2Range = (init?.headers as Record<string, string>)?.['Range']
      const match = session2Range?.match(/^bytes=(\d+)-$/)
      const start = match ? parseInt(match[1], 10) : 0
      const slice = v2Bytes.subarray(start)
      const stream = createCleanEofStream(slice, slice.length)

      return new Response(stream, {
        status: 206,
        headers: {
          ETag: '"v2"',
          'Content-Range': `bytes ${start}-${v2Bytes.length - 1}/${v2Bytes.length}`,
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

    expect(session2Range).toBe(`bytes=${cutoffAtPost5}-`)

    // 验证 Session 2 完成后，art-7 也成功更新，且 status 变为 completed
    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const state2 = await store2.getSyncState(`sync_state:${targetUrl}`)
    expect(state2?.status).toBe('completed')
    expect(state2?.completed).toBe(true)

    const docs2 = await store2.getAll()
    const docArt7 = docs2.get('art-7/')
    expect(docArt7?.m).toBe(2000)
    expect(engine2.index.search('brandnewtag', 10)).toHaveLength(2)
  })

  // =========================================================================
  // Adversarial 5: Early Cancellation via Zero-Divergence Meta must mark completed
  // =========================================================================
  it('Adversarial 5: 首行 Meta 比对发现全部最新时主动 cancel：正确标记 completed 并上报 100% 进度', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_zero_divergence_early_cancel_db'
    const targetUrl = '/search.jsonl'

    const totalPosts = 5
    const ids = Array.from({ length: totalPosts }, (_, i) => `doc-${i}/`)
    const ms = [100, 200, 300, 400, 500]
    const lines = [
      makeMeta(totalPosts, ids, ms),
      ...ids.map((id, i) => makeArticle(id, ms[i], `Title ${i}`, `Content ${i}`)),
    ]
    const bytes = new TextEncoder().encode(lines.join(''))

    // 预先向 IDB 写入完整的 5 篇文档，但没有 syncState（模拟仅文档已缓存）
    const store0 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const initialDocs: IndexedDoc[] = ids.map((id, i) =>
      processPost({ id, t: `Title ${i}`, u: `/${id}`, m: ms[i], g: [], k: [], c: `Content ${i}` }),
    )
    await store0.applyBatch(initialDocs, [])

    let fetchCount = 0
    const fetchImpl = (async () => {
      fetchCount++
      const stream = createCleanEofStream(bytes, bytes.length)
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"etag-zero-divergence"' },
      })
    }) as unknown as typeof fetch

    const engine = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl,
    })
    await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(fetchCount).toBe(1)
    expect(engine.index.size).toBe(5)

    // 检查 syncState 必须是 'completed' 而不是 'syncing'
    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const syncState = await finalStore.getSyncState(`sync_state:${targetUrl}`)
    expect(syncState?.status).toBe('completed')
    expect(syncState?.completed).toBe(true)
    expect(syncState?.scannedCount).toBe(5)
  })

  // =========================================================================
  // Adversarial 6: Empty Blog Site (meta.total = 0) Lifecycle
  // =========================================================================
  it('Adversarial 6: 空博客站点 (meta.total = 0) 首次同步与后续 304：不崩溃、无 NaN 进度、正确标记 completed', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_empty_blog_site_db'
    const targetUrl = '/search.jsonl'

    const emptyMeta = makeMeta(0, [], [])
    const emptyBytes = new TextEncoder().encode(emptyMeta)

    // Session 1: 首次 200 OK 拉取空站点
    const progressList: unknown[] = []
    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: (msg) => {
        if (msg.type === 'progress') progressList.push(msg.payload)
      },
      fetchImpl: (async () => new Response(emptyBytes, {
        status: 200,
        headers: { ETag: '"empty-etag-v1"' },
      })) as unknown as typeof fetch,
    })

    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(engine1.index.size).toBe(0)
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const state1 = await store1.getSyncState(`sync_state:${targetUrl}`)
    expect(state1?.status).toBe('completed')
    expect(state1?.completed).toBe(true)
    expect(state1?.scannedCount).toBe(0)

    // Session 2: 再次加载触发 304 Not Modified
    let sentIfNoneMatch: string | undefined
    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sentIfNoneMatch = (init?.headers as Record<string, string>)?.[`If-None-Match`]
        return new Response(null, {
          status: 304,
          headers: { ETag: '"empty-etag-v1"' },
        })
      }) as unknown as typeof fetch,
    })

    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })
    expect(sentIfNoneMatch).toBe('"empty-etag-v1"')
    expect(engine2.index.size).toBe(0)
  })

  // =========================================================================
  // Adversarial 7: HTTP 416 on File Shrink & Purge of Dirty Partial Docs
  // =========================================================================
  it('Adversarial 7: 远端文件缩容引发 416 自动重试：彻底清除 IDB 历史脏文章，无任何幽灵残留', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_416_shrink_purge_db'
    const targetUrl = '/search.jsonl'

    // 预注入 40 篇脏数据与超大 byteOffset (50000)
    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    const dirtyDocs: IndexedDoc[] = Array.from({ length: 40 }, (_, i) =>
      processPost({ id: `stale-416-${i}/`, t: `Stale ${i}`, u: `/stale-${i}`, m: 100, g: [], k: [], c: 'stale416unique' }),
    )
    await store.applyBatch(dirtyDocs, [], {
      key: `sync_state:${targetUrl}`,
      url: targetUrl,
      byteOffset: 50000,
      etag: '"stale-etag-long-gone"',
      status: 'syncing',
      completed: false,
      scannedCount: 40,
      updatedAt: Date.now(),
    })

    // 新文件仅包含 2 篇全新文章
    const newTotal = 2
    const newIds = ['fresh-416-alpha/', 'fresh-416-beta/']
    const newM = [9991, 9992]
    const newLines = [
      makeMeta(newTotal, newIds, newM),
      ...newIds.map((id, i) => makeArticle(id, newM[i], `Fresh ${id}`, `Fresh Content ${i} fresh416unique`)),
    ]
    const newBytes = new TextEncoder().encode(newLines.join(''))

    let requestCount = 0
    let firstRequestRange: string | undefined
    let secondRequestRange: string | undefined

    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requestCount++
      const range = (init?.headers as Record<string, string>)?.[`Range`]
      if (requestCount === 1) {
        firstRequestRange = range
        // 第一次请求携带越界 Range，返回 416
        return new Response('', {
          status: 416,
          statusText: 'Range Not Satisfiable',
        })
      }
      secondRequestRange = range
      // 第二次请求为重试全量
      return new Response(newBytes, {
        status: 200,
        headers: { ETag: '"fresh-etag-v2"' },
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
    expect(firstRequestRange).toBe('bytes=50000-')
    expect(secondRequestRange).toBeUndefined() // 重试必须不带 Range

    // 验证内存引擎完全干净
    expect(engine.index.size).toBe(2)
    expect(engine.index.search('stale416unique', 100)).toHaveLength(0)
    expect(engine.index.search('fresh416unique', 10)).toHaveLength(2)

    // 核心验证：IDB 中历史 40 篇被 100% 抹除
    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const allDocs = await finalStore.getAll()
    expect(allDocs.size).toBe(2)
    for (let i = 0; i < 40; i++) {
      expect(allDocs.has(`stale-416-${i}/`)).toBe(false)
    }

    const finalState = await finalStore.getSyncState(`sync_state:${targetUrl}`)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.completed).toBe(true)
    expect(finalState?.etag).toBe('"fresh-etag-v2"')
  })

  // =========================================================================
  // Adversarial 8: Content-Range Start Override in 206 Response
  // =========================================================================
  it('Adversarial 8: 服务端 206 返回起始偏移与请求不一致时 (Content-Range 覆盖)：准确遵循响应头并完整解析', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_content_range_override_db'
    const targetUrl = '/search.jsonl'

    const total = 5
    const ids = Array.from({ length: total }, (_, i) => `cr-${i}/`)
    const ms = Array.from({ length: total }, (_, i) => 800 + i)
    const lines = [
      makeMeta(total, ids, ms),
      ...ids.map((id, i) => makeArticle(id, ms[i], `CR Title ${i}`, `CR Content ${i} contentrangeoverride`)),
    ]
    const fullBytes = new TextEncoder().encode(lines.join(''))

    // 假设客户端记录的 offset 是 9999，但服务端返回从 0 开始的 206 (Content-Range: bytes 0-...)
    const fetchImpl = (async () => {
      const stream = createCleanEofStream(fullBytes, fullBytes.length)
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-${fullBytes.length - 1}/${fullBytes.length}`,
          ETag: '"cr-override-etag"',
        },
      })
    }) as unknown as typeof fetch

    // 预注入 syncState 带有不匹配的 byteOffset
    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    await store.applyBatch([], [], {
      key: `sync_state:${targetUrl}`,
      url: targetUrl,
      byteOffset: 9999,
      etag: '"cr-override-etag"',
      status: 'syncing',
      completed: false,
      scannedCount: 0,
      meta: { _type: 'meta', total, allIds: ids, allM: ms },
      updatedAt: Date.now(),
    })

    const engine = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl,
    })

    await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    expect(engine.index.size).toBe(total)
    expect(engine.index.search('contentrangeoverride', 10)).toHaveLength(total)

    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const finalState = await finalStore.getSyncState(`sync_state:${targetUrl}`)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.completed).toBe(true)
  })

  // =========================================================================
  // Adversarial 9: CRLF ('\r\n') Stream Line-Boundary Alignment & Offset Precision
  // =========================================================================
  it('Adversarial 9: 包含 Windows CRLF (\\r\\n) 换行符的流：字节偏移严格精准对齐，断点续传不漂移', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'test_crlf_stream_db'
    const targetUrl = '/search.jsonl'

    const total = 6
    const ids = Array.from({ length: total }, (_, i) => `crlf-${i}/`)
    const ms = Array.from({ length: total }, (_, i) => 500 + i)

    // 使用 \r\n 构造
    const metaLine = `${JSON.stringify({ _type: 'meta', total, allIds: ids, allM: ms })}\r\n`
    const postLines = ids.map((id, i) =>
      `${JSON.stringify({ id, t: `CRLF Title ${i}`, u: `/${id}`, m: ms[i], g: ['crlf'], k: [], c: `CRLF Content ${i} crlftest` })}\r\n`,
    )
    const fullText = metaLine + postLines.join('')
    const fullBytes = new TextEncoder().encode(fullText)

    // 计算包含 meta + 前 2 篇的准确字节数（包括 \r\n）
    const cutText = metaLine + postLines.slice(0, 2).join('')
    const cutOffset = new TextEncoder().encode(cutText).byteLength

    // Session 1: 在 cutOffset 处 Clean EOF
    const session1Fetch = (async () => {
      const stream = createCleanEofStream(fullBytes, cutOffset)
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"crlf-etag"' },
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
    const state1 = await store1.getSyncState(`sync_state:${targetUrl}`)
    expect(state1?.status).toBe('syncing')
    expect(state1?.completed).toBe(false)
    expect(state1?.byteOffset).toBe(cutOffset) // 严格对齐至第 2 篇末尾的 \n 之后
    expect(state1?.scannedCount).toBe(2)

    // Session 2: 206 续传
    let session2Range: string | undefined
    const session2Fetch = (async (_url: string, init?: RequestInit) => {
      session2Range = (init?.headers as Record<string, string>)?.[`Range`]
      const match = session2Range?.match(/^bytes=(\d+)-$/)
      const start = match ? parseInt(match[1], 10) : 0
      const slice = fullBytes.subarray(start)
      const stream = createCleanEofStream(slice, slice.length)
      return new Response(stream, {
        status: 206,
        headers: {
          ETag: '"crlf-etag"',
          'Content-Range': `bytes ${start}-${fullBytes.length - 1}/${fullBytes.length}`,
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

    expect(session2Range).toBe(`bytes=${cutOffset}-`)
    expect(engine2.index.size).toBe(total)
    expect(engine2.index.search('crlftest', 10)).toHaveLength(total)

    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const finalState = await finalStore.getSyncState(`sync_state:${targetUrl}`)
    expect(finalState?.status).toBe('completed')
    expect(finalState?.completed).toBe(true)
    expect(finalState?.scannedCount).toBe(total)
  })
})


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

function makePost(id: string, m: number, title: string, content: string): string {
  return `${JSON.stringify({
    id,
    t: title,
    u: `/${id}`,
    m,
    g: ['category'],
    k: ['tag'],
    c: content,
  })}\n`
}

describe('Milestone 2 Challenger Empirical Stress Suite', () => {
  // =========================================================================
  // Challenge 1: Interruption DURING HTTP 200 OK Fallback
  // =========================================================================
  it('Scenario 1: Interrupted mid-stream DURING a 200 fallback, followed by 206 resume of new version', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'stress-cascade-200-interrupted-db'
    const targetUrl = 'https://example.com/search.jsonl'

    // --- Version 1: 100 posts ---
    const v1Total = 100
    const v1Ids = Array.from({ length: v1Total }, (_, i) => `v1-post-${String(i).padStart(3, '0')}/`)
    const v1M = Array.from({ length: v1Total }, () => 100)
    const v1Posts = v1Ids.map((id, i) => makePost(id, 100, `Old Post ${i}`, `stalecontentold word${i}`))
    const v1Meta = makeMeta(v1Total, v1Ids, v1M)
    const v1FullBytes = new TextEncoder().encode(v1Meta + v1Posts.join(''))

    // Interrupt at post 65 (+ 15 bytes into post 66)
    const v1Cutoff = new TextEncoder().encode(v1Meta + v1Posts.slice(0, 65).join('')).byteLength + 15

    const fetchSession1 = (async () => {
      let sent = 0
      const slice = v1FullBytes.slice(0, v1Cutoff)
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= slice.length) {
            controller.error(new Error('Simulated network drop in session 1'))
            return
          }
          const chunk = slice.subarray(sent, Math.min(sent + 512, slice.length))
          sent += chunk.length
          controller.enqueue(chunk)
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"v1-etag"' },
      })
    }) as unknown as typeof fetch

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: fetchSession1,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Batch size is 50 -> Session 1 committed first batch (50 posts)
    const store1 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs1 = await store1.getAll()
    expect(docs1.size).toBe(50)
    expect(docs1.has('v1-post-000/')).toBe(true)

    // --- Version 2: 100 entirely new posts ---
    const v2Total = 100
    const v2Ids = Array.from({ length: v2Total }, (_, i) => `v2-post-${String(i).padStart(3, '0')}/`)
    const v2M = Array.from({ length: v2Total }, () => 200)
    const v2Posts = v2Ids.map((id, i) => makePost(id, 200, `New Post ${i}`, `freshcontentnew keyword${i}`))
    const v2Meta = makeMeta(v2Total, v2Ids, v2M)
    const v2FullBytes = new TextEncoder().encode(v2Meta + v2Posts.join(''))

    // Session 2: Receives 200 OK because ETag changed ("v2-etag"),
    // but gets INTERRUPTED AGAIN at post 65 (+ 20 bytes into post 66)!
    const v2Cutoff = new TextEncoder().encode(v2Meta + v2Posts.slice(0, 65).join('')).byteLength + 20
    const v2Batch1CommittedByteOffset = new TextEncoder().encode(v2Meta + v2Posts.slice(0, 50).join('')).byteLength

    let session2IfRange: string | undefined
    const fetchSession2 = (async (_url: string, init?: RequestInit) => {
      session2IfRange = (init?.headers as Record<string, string>)?.[`If-Range`]
      let sent = 0
      const slice = v2FullBytes.slice(0, v2Cutoff)
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= slice.length) {
            controller.error(new Error('Simulated network drop in session 2'))
            return
          }
          const chunk = slice.subarray(sent, Math.min(sent + 512, slice.length))
          sent += chunk.length
          controller.enqueue(chunk)
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { ETag: '"v2-etag"' },
      })
    }) as unknown as typeof fetch

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: fetchSession2,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Session 2 verified:
    // Client sent If-Range: "v1-etag"
    expect(session2IfRange).toBe('"v1-etag"')

    // All v1 posts were purged at Line 1 Meta!
    // And batch 1 (50 v2 posts) was committed to IDB!
    const store2 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs2 = await store2.getAll()
    expect(docs2.size).toBe(50)
    for (let i = 0; i < 50; i++) {
      expect(docs2.has(`v1-post-${String(i).padStart(3, '0')}/`)).toBe(false)
      expect(docs2.has(`v2-post-${String(i).padStart(3, '0')}/`)).toBe(true)
    }

    const syncState2 = await store2.getSyncState(targetUrl)
    expect(syncState2).toBeDefined()
    expect(syncState2?.etag).toBe('"v2-etag"')
    expect(syncState2?.byteOffset).toBe(v2Batch1CommittedByteOffset)

    // Session 3: Resumes with Range request from byteOffset of post 50
    let session3RangeHeader: string | undefined
    let session3IfRangeHeader: string | undefined

    const fetchSession3 = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      session3RangeHeader = headers?.['Range']
      session3IfRangeHeader = headers?.['If-Range']

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(v2FullBytes.slice(v2Batch1CommittedByteOffset))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${v2Batch1CommittedByteOffset}-${v2FullBytes.length - 1}/${v2FullBytes.length}`,
          'ETag': '"v2-etag"',
        },
      })
    }) as unknown as typeof fetch

    const engine3 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: fetchSession3,
    })
    await engine3.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Verify Session 3 Range headers
    expect(session3RangeHeader).toBe(`bytes=${v2Batch1CommittedByteOffset}-`)
    expect(session3IfRangeHeader).toBe('"v2-etag"')

    // Verify final state:
    // All 100 v2 posts are in IDB, 0 v1 posts, 100% searchable
    const store3 = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs3 = await store3.getAll()
    expect(docs3.size).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(docs3.has(`v2-post-${String(i).padStart(3, '0')}/`)).toBe(true)
      expect(docs3.has(`v1-post-${String(i).padStart(3, '0')}/`)).toBe(false)
    }

    // Verify search index
    expect(engine3.index.size).toBe(100)
    const oldResults = engine3.index.search('stalecontentold', 10)
    expect(oldResults).toHaveLength(0)
    const newResults = engine3.index.search('freshcontentnew', 150)
    expect(newResults).toHaveLength(100)
  })

  // =========================================================================
  // Challenge 2: Mixed CRUD updates across 200 OK Fallback
  // =========================================================================
  it('Scenario 2: Mixed CRUD (update, delete, retain, insert) across 200 OK fallback', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'stress-mixed-crud-200-db'
    const targetUrl = 'https://example.com/search.jsonl'

    // Initial partial sync: Post A, Post B, Post C
    const initIds = ['post-a/', 'post-b/', 'post-c/']
    const initM = [100, 100, 100]
    const initText = makeMeta(3, initIds, initM) +
      makePost('post-a/', 100, 'Post Alpha Original', 'apple banana cherry') +
      makePost('post-b/', 100, 'Post Beta Original to be deleted', 'blueberry dragonfruit') +
      makePost('post-c/', 100, 'Post Gamma Unchanged', 'elderberry fig grape')
    const initBytes = new TextEncoder().encode(initText)

    // Session 1: Interrupted after Post B
    const s1Cutoff = new TextEncoder().encode(
      makeMeta(3, initIds, initM) +
      makePost('post-a/', 100, 'Post Alpha Original', 'apple banana cherry') +
      makePost('post-b/', 100, 'Post Beta Original to be deleted', 'blueberry dragonfruit'),
    ).byteLength

    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(initBytes.slice(0, s1Cutoff))
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { ETag: '"etag-1"' } })
      }) as unknown as typeof fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Session 2: Server updated:
    // - post-a: UPDATED (m: 200, new content)
    // - post-b: DELETED
    // - post-c: ADDED
    // - post-d: NEW INSERT
    const v2Ids = ['post-a/', 'post-c/', 'post-d/']
    const v2M = [200, 100, 200]
    const v2Text = makeMeta(3, v2Ids, v2M) +
      makePost('post-a/', 200, 'Post Alpha Updated Title', 'apple watermelon kiwi') +
      makePost('post-c/', 100, 'Post Gamma Unchanged', 'elderberry fig grape') +
      makePost('post-d/', 200, 'Post Delta Brand New', 'honeydew lemon mango')
    const v2Bytes = new TextEncoder().encode(v2Text)

    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(v2Bytes)
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { ETag: '"etag-2"' } })
      }) as unknown as typeof fetch,
    })
    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs = await store.getAll()

    // Assertions:
    // 1. post-b must be completely gone
    expect(docs.has('post-b/')).toBe(false)
    expect(engine2.index.has('post-b/')).toBe(false)
    expect(engine2.index.search('blueberry', 10)).toHaveLength(0)

    // 2. post-a must have updated m and text
    expect(docs.has('post-a/')).toBe(true)
    expect(docs.get('post-a/')!.m).toBe(200)
    expect(docs.get('post-a/')!.t).toBe('Post Alpha Updated Title')
    expect(engine2.index.search('watermelon', 10)).toHaveLength(1)
    expect(engine2.index.search('banana', 10)).toHaveLength(0) // old keyword gone!

    // 3. post-c must be present
    expect(docs.has('post-c/')).toBe(true)
    expect(engine2.index.search('elderberry', 10)).toHaveLength(1)

    // 4. post-d must be present
    expect(docs.has('post-d/')).toBe(true)
    expect(engine2.index.search('honeydew', 10)).toHaveLength(1)

    expect(docs.size).toBe(3)
    expect(engine2.index.size).toBe(3)
  })

  // =========================================================================
  // Challenge 3: Chaotic Multi-Cycle Interruption Stress (8 reload cycles)
  // =========================================================================
  it('Scenario 3: 8 successive interrupted reload cycles with erratic chunk sizes', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'stress-chaotic-8-reloads-db'
    const targetUrl = 'https://example.com/search.jsonl'
    const totalPosts = 100
    const allIds = Array.from({ length: totalPosts }, (_, i) => `article-${i}/`)
    const allM = Array.from({ length: totalPosts }, (_, i) => 1000 + i)

    const fullLines = [
      makeMeta(totalPosts, allIds, allM),
      ...allIds.map((id, i) =>
        makePost(id, allM[i], `Article ${i} Header 🚀`, `Content body text for article ${i} with searchable token xyz${i}`),
      ),
    ]
    const fullText = fullLines.join('')
    const fullBytes = new TextEncoder().encode(fullText)
    const etag = '"stable-etag"'

    // Define 8 target byte cutoffs to interrupt at (batch size 50, ensure cutoffs span across batches)
    const totalLen = fullBytes.length
    const cutoffs = [
      Math.floor(totalLen * 0.12),
      Math.floor(totalLen * 0.25),
      Math.floor(totalLen * 0.38),
      Math.floor(totalLen * 0.55),
      Math.floor(totalLen * 0.65),
      Math.floor(totalLen * 0.78),
      Math.floor(totalLen * 0.90),
      totalLen, // final cycle runs to end
    ]

    const chunkSizes = [1, 3, 7, 13, 19, 29, 43, 128]

    for (let cycle = 0; cycle < cutoffs.length; cycle++) {
      const isFinal = cycle === cutoffs.length - 1
      const targetCutoff = cutoffs[cycle]
      const chunkSize = chunkSizes[cycle]

      const fetchCycle = (async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined
        const range = headers?.['Range']

        let startByte = 0
        let is206 = false

        if (range) {
          const match = range.match(/bytes=(\d+)-/)
          if (match) {
            startByte = Number(match[1])
            is206 = true
          }
        }

        const sliceEnd = Math.min(targetCutoff, fullBytes.length)
        const sliceData = fullBytes.slice(startByte, sliceEnd)

        let offset = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= sliceData.length) {
              if (isFinal) {
                controller.close()
              } else {
                controller.error(new Error(`Simulated drop at cycle ${cycle}`))
              }
              return
            }
            const end = Math.min(offset + chunkSize, sliceData.length)
            controller.enqueue(sliceData.slice(offset, end))
            offset = end
          },
        })

        if (is206) {
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${startByte}-${fullBytes.length - 1}/${fullBytes.length}`,
              'ETag': etag,
            },
          })
        } else {
          return new Response(stream, {
            status: 200,
            headers: { ETag: etag },
          })
        }
      }) as unknown as typeof fetch

      const engine = createEngine({
        indexedDB: sharedFactory,
        dbName,
        postMessage: () => {},
        fetchImpl: fetchCycle,
      })
      await engine.handleMessage({ type: 'INIT', payload: { url: targetUrl } })
    }

    // Verify after 8 cycles
    const finalStore = await createPostStore({ indexedDB: sharedFactory, dbName })
    const finalDocs = await finalStore.getAll()
    expect(finalDocs.size).toBe(totalPosts)

    for (let i = 0; i < totalPosts; i++) {
      expect(finalDocs.has(`article-${i}/`)).toBe(true)
    }

    const syncState = await finalStore.getSyncState(targetUrl)
    expect(syncState?.status).toBe('completed')
    expect(syncState?.completed).toBe(true)
  })

  // =========================================================================
  // Challenge 4: Corrupted / Mangled Line in Stream Resilience
  // =========================================================================
  it('Scenario 4: Stream containing broken JSON lines during Range resume gracefully recovers', async () => {
    const totalPosts = 5
    const allIds = Array.from({ length: totalPosts }, (_, i) => `item-${i}/`)
    const allM = Array.from({ length: totalPosts }, (_, i) => 10 + i)

    const validLines = allIds.map((id, i) => makePost(id, allM[i], `Item ${i}`, `content ${i}`))

    // Insert a broken JSON line between item 1 and item 2
    const mangledStreamText = [
      validLines[0],
      '{"INVALID_JSON_CORRUPTED_LINE: true,\n', // Corrupt line
      validLines[1],
      validLines[2],
      '   \n', // Blank line with whitespace
      validLines[3],
      validLines[4],
    ].join('')

    const streamBytes = new TextEncoder().encode(mangledStreamText)

    const localMap = new Map<string, IndexedDoc>()
    const capturedDocs: string[] = []

    const result = await syncJsonlStream({
      url: 'https://example.com/search.jsonl',
      localMap,
      syncState: {
        key: 'sync_state:https://example.com/search.jsonl',
        url: 'https://example.com/search.jsonl',
        byteOffset: 100,
        etag: '"etag"',
        status: 'syncing',
        completed: false,
        meta: { _type: 'meta', total: totalPosts, allIds, allM },
        updatedAt: Date.now(),
      },
      handlers: {
        onDocument: (doc) => capturedDocs.push(doc.id),
      },
      processPost,
      fetchImpl: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(streamBytes)
            controller.close()
          },
        })
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Range': `bytes 100-${100 + streamBytes.length - 1}/${100 + streamBytes.length}`,
            'ETag': '"etag"',
          },
        })
      }) as unknown as typeof fetch,
    })

    // Corrupt lines should be skipped safely without throwing SyntaxError
    expect(capturedDocs).toContain('item-0/')
    expect(capturedDocs).toContain('item-1/')
    expect(capturedDocs).toContain('item-2/')
    expect(capturedDocs).toContain('item-3/')
    expect(capturedDocs).toContain('item-4/')
    expect(result.toPut).toHaveLength(5)
  })

  // =========================================================================
  // Challenge 5: HTTP 304 Not Modified cache instant readiness
  // =========================================================================
  it('Scenario 5: 304 Not Modified sends 0 network bytes and preserves 100% instant searchability', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'stress-304-instant-cache-db'
    const targetUrl = 'https://example.com/search.jsonl'
    const totalPosts = 20
    const allIds = Array.from({ length: totalPosts }, (_, i) => `p-${i}/`)
    const allM = Array.from({ length: totalPosts }, (_, i) => 500 + i)

    const fullText = makeMeta(totalPosts, allIds, allM) +
      allIds.map((id, i) => makePost(id, allM[i], `Title ${i}`, `uniquesearchtoken${i}`)).join('')
    const fullBytes = new TextEncoder().encode(fullText)
    const etag = '"final-etag-304"'

    // Session 1: Full download to completion
    const engine1 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fullBytes)
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { ETag: etag } })
      }) as unknown as typeof fetch,
    })
    await engine1.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Session 2: Reload, server returns 304 Not Modified
    let capturedIfNoneMatch: string | undefined

    const messages: WorkerOutboundMessage[] = []
    const engine2 = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: (msg) => messages.push(msg),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined
        capturedIfNoneMatch = headers?.['If-None-Match']
        return new Response(null, {
          status: 304,
          headers: { ETag: etag },
        })
      }) as unknown as typeof fetch,
    })

    await engine2.handleMessage({ type: 'INIT', payload: { url: targetUrl } })

    // Verify If-None-Match header was sent
    expect(capturedIfNoneMatch).toBe(etag)

    // Verify cache_ready was emitted
    const cacheReadyMsg = messages.find((m) => m.type === 'cache_ready')
    expect(cacheReadyMsg).toBeDefined()
    expect(cacheReadyMsg?.payload?.count).toBe(20)

    // Verify sync_complete was emitted with 0 updated
    const syncCompleteMsg = messages.find((m) => m.type === 'sync_complete')
    expect(syncCompleteMsg).toBeDefined()
    expect(syncCompleteMsg?.payload?.updatedCount).toBe(0)
    expect(syncCompleteMsg?.payload?.resumed).toBe(true)

    // Verify index is 100% searchable immediately
    expect(engine2.index.size).toBe(20)
    for (let i = 0; i < 20; i++) {
      const res = engine2.index.search(`uniquesearchtoken${i}`, 5)
      expect(res).toHaveLength(1)
      expect(res[0].id).toBe(`p-${i}/`)
    }
  })

  // =========================================================================
  // Challenge 6: Concurrent Engine Initialization on Shared Database
  // =========================================================================
  it('Scenario 6: Concurrent engines initializing simultaneously on shared IDB do not tear state', async () => {
    const sharedFactory = new IDBFactory()
    const dbName = 'stress-concurrent-engines-db'
    const targetUrl = 'https://example.com/search.jsonl'
    const totalPosts = 30
    const allIds = Array.from({ length: totalPosts }, (_, i) => `concurrent-${i}/`)
    const allM = Array.from({ length: totalPosts }, () => 100)

    const fullText = makeMeta(totalPosts, allIds, allM) +
      allIds.map((id, i) => makePost(id, 100, `Concurrent Title ${i}`, `shared concurrent text ${i}`)).join('')
    const fullBytes = new TextEncoder().encode(fullText)

    const createFetch = () => (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(fullBytes)
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { ETag: '"concurrent-etag"' } })
    }) as unknown as typeof fetch

    const engineA = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: createFetch(),
    })
    const engineB = createEngine({
      indexedDB: sharedFactory,
      dbName,
      postMessage: () => {},
      fetchImpl: createFetch(),
    })

    // Run both simultaneously
    await Promise.all([
      engineA.handleMessage({ type: 'INIT', payload: { url: targetUrl } }),
      engineB.handleMessage({ type: 'INIT', payload: { url: targetUrl } }),
    ])

    // Verify both engines have all posts and IDB has all posts without duplication
    expect(engineA.index.size).toBe(30)
    expect(engineB.index.size).toBe(30)

    const store = await createPostStore({ indexedDB: sharedFactory, dbName })
    const docs = await store.getAll()
    expect(docs.size).toBe(30)
  })
})

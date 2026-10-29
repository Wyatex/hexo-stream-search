import { describe, expect, it, vi } from 'vitest'
import { processPost } from '../../src/web/core/index-store'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { IndexedDoc, SearchProgress } from '../../src/shared/types'

interface TrackedFetchOptions {
  status?: number
  onCancel?: (reason?: unknown) => void
  keepOpen?: boolean
  errorAtChunk?: number
  throwOnCancel?: boolean
}

function createTrackedFetch(chunks: string[], options: TrackedFetchOptions = {}) {
  const encoder = new TextEncoder()
  let chunkIndex = 0
  let readCallCount = 0
  const pulledChunks: number[] = []

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.errorAtChunk !== undefined && chunkIndex === options.errorAtChunk) {
        controller.error(new Error('Adversarial stream network failure'))
        return
      }

      if (chunkIndex >= chunks.length) {
        if (!options.keepOpen) controller.close()
        return
      }

      pulledChunks.push(chunkIndex)
      controller.enqueue(encoder.encode(chunks[chunkIndex++]))
    },
    cancel(reason) {
      options.onCancel?.(reason)
      if (options.throwOnCancel) {
        throw new Error('Adversarial reader.cancel() failure')
      }
    },
  })

  const fetchImpl = (async () => {
    const response = new Response(stream, { status: options.status ?? 200 })
    const origBody = response.body!
    const origGetReader = origBody.getReader.bind(origBody)
    origBody.getReader = (() => {
      const reader = origGetReader()
      const origRead = reader.read.bind(reader)
      reader.read = async () => {
        readCallCount++
        return origRead()
      }
      return reader
    }) as unknown as typeof origBody.getReader
    return response
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    pulledChunks,
    getReadCallCount: () => readCallCount,
  }
}

function makeMeta(total: number, allIds: string[], allM?: number[]): string {
  return `${JSON.stringify({ _type: 'meta', total, allIds, ...(allM ? { allM } : {}) })}\n`
}

function makeArticle(id: string, m: number, content = 'content'): string {
  return `${JSON.stringify({ id, t: `Title ${id}`, u: `/${id}`, m, g: [], k: [], c: content })}\n`
}

describe('Adversarial Stream Sync & Early Break Fuzzing', () => {
  describe('Adversarial Scenario 1: Deeply Buried Updates', () => {
    it('100 unchanged + 1 modified + 100 unchanged: modified post is never skipped and trailing posts are aborted early', async () => {
      // 201 posts total.
      // Posts 0..99: unchanged (m = 2000 - i)
      // Post 100: modified on server (m = 1900 in localMap, m = 1950 on server)
      // Posts 101..200: unchanged (m = 1800 - (i - 101))
      const total = 201
      const allIds: string[] = []
      const serverM: number[] = []
      const localMap = new Map<string, IndexedDoc>()
      const chunks: string[] = []

      // Generate IDs and timestamps
      for (let i = 0; i < 100; i++) {
        const id = `post_${String(i).padStart(4, '0')}/`
        const m = 3000 - i
        allIds.push(id)
        serverM.push(m)
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m, g: [], k: [], c: `cached ${id}` }))
      }

      // Buried modified post at index 100
      const buriedId = 'post_0100/'
      allIds.push(buriedId)
      serverM.push(2850) // server timestamp
      localMap.set(buriedId, processPost({ id: buriedId, t: buriedId, u: `/${buriedId}`, m: 2000, g: [], k: [], c: 'old content' })) // local timestamp 2000

      // Trailing posts 101..200
      for (let i = 101; i < 201; i++) {
        const id = `post_${String(i).padStart(4, '0')}/`
        const m = 2800 - (i - 101)
        allIds.push(id)
        serverM.push(m)
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m, g: [], k: [], c: `cached ${id}` }))
      }

      // Build chunks: chunk 0 = meta, chunk 1..201 = individual article lines
      chunks.push(makeMeta(total, allIds, serverM))
      for (let i = 0; i < total; i++) {
        chunks.push(makeArticle(allIds[i], serverM[i], i === 100 ? 'brand new updated body' : `cached body ${i}`))
      }

      const onCancel = vi.fn()
      const handledDocs: { id: string; kind: 'new' | 'cached' }[] = []
      const { fetchImpl, pulledChunks } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: {
          onDocument: (doc, kind) => handledDocs.push({ id: doc.id, kind }),
        },
        processPost,
        fetchImpl,
      })

      // 1. The buried modified post was processed and updated
      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe(buriedId)
      expect(result.toPut[0].m).toBe(2850)
      expect(localMap.get(buriedId)?.m).toBe(2850)

      // 2. Early cancellation triggered
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)

      // 3. Verify exactly which posts were processed:
      // Posts 0..99: cached (100 posts)
      // Post 100: new (1 post)
      // Post 101: cached (1 post, triggers currentIndex 101 > lastDivergentIndex 100)
      // Total handled in stream: 102 posts
      expect(handledDocs).toHaveLength(102)
      expect(handledDocs[99]).toEqual({ id: 'post_0099/', kind: 'cached' })
      expect(handledDocs[100]).toEqual({ id: buriedId, kind: 'new' })
      expect(handledDocs[101]).toEqual({ id: 'post_0101/', kind: 'cached' })

      // 4. Posts 102..200 were NEVER pulled or parsed from stream!
      // Verify pulledChunks does not reach posts beyond 102
      // Chunk 0 is meta, chunks 1..102 are articles 0..101.
      expect(pulledChunks.length).toBeLessThanOrEqual(105)
      expect(pulledChunks.includes(150)).toBe(false)
      expect(pulledChunks.includes(200)).toBe(false)
    })

    it('Buried post at index 0 (first post modified, remaining 99 unchanged)', async () => {
      const allIds = ['first/', ...Array.from({ length: 99 }, (_, i) => `tail_${i}/`)]
      const serverM = [5000, ...Array.from({ length: 99 }, (_, i) => 4000 - i)]
      const localMap = new Map<string, IndexedDoc>()

      localMap.set('first/', processPost({ id: 'first/', t: 'first', u: '/first/', m: 1000, g: [], k: [], c: 'old' }))
      for (let i = 0; i < 99; i++) {
        const id = `tail_${i}/`
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m: 4000 - i, g: [], k: [], c: 'unchanged' }))
      }

      const chunks = [
        makeMeta(100, allIds, serverM),
        makeArticle('first/', 5000, 'updated'),
        ...allIds.slice(1).map((id, i) => makeArticle(id, 4000 - i, 'unchanged')),
      ]

      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      // Must update index 0
      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('first/')
      expect(result.toPut[0].m).toBe(5000)
      // Must abort immediately after tail_0 (index 1 > lastDivergentIndex 0)
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
    })

    it('Buried post at the very last index (99 of 100): reads full stream without early abort', async () => {
      const allIds = [...Array.from({ length: 99 }, (_, i) => `post_${i}/`), 'last/']
      const serverM = [...Array.from({ length: 99 }, (_, i) => 4000 - i), 100]
      const localMap = new Map<string, IndexedDoc>()

      for (let i = 0; i < 99; i++) {
        const id = `post_${i}/`
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m: 4000 - i, g: [], k: [], c: 'unchanged' }))
      }
      localMap.set('last/', processPost({ id: 'last/', t: 'last', u: '/last/', m: 50, g: [], k: [], c: 'old' }))

      const chunks = [
        makeMeta(100, allIds, serverM),
        ...allIds.slice(0, 99).map((id, i) => makeArticle(id, 4000 - i, 'unchanged')),
        makeArticle('last/', 100, 'newly updated last post'),
      ]

      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch(chunks, { onCancel, keepOpen: false })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('last/')
      expect(result.toPut[0].m).toBe(100)
      expect(onCancel).not.toHaveBeenCalled()
      expect(result.canceledEarly).toBe(false)
      expect(result.scannedCount).toBe(100)
    })
  })

  describe('Adversarial Scenario 2: Concurrent Additions, Modifications, and Deletions', () => {
    it('handles mixed 20 additions, 20 modifications, 20 deletions, and 40 unchanged posts', async () => {
      // Setup:
      // Local cache initially has:
      // - 20 deleted posts (to be purged)
      // - 20 modified posts (old timestamp m = 500)
      // - 40 unchanged posts (timestamp m = 1000..1039)
      // Total local = 80 posts.
      //
      // Server has:
      // - 20 new posts (m = 2000..2019)
      // - 20 modified posts (updated timestamp m = 1500..1519)
      // - 40 unchanged posts (timestamp m = 1000..1039)
      // Total server = 80 posts.
      const localMap = new Map<string, IndexedDoc>()
      const deletedIds = Array.from({ length: 20 }, (_, i) => `deleted_${i}/`)
      for (const id of deletedIds) {
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m: 300, g: [], k: [], c: 'to delete' }))
      }

      const modIds = Array.from({ length: 20 }, (_, i) => `mod_${i}/`)
      for (const id of modIds) {
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m: 500, g: [], k: [], c: 'old mod' }))
      }

      const unchangedIds = Array.from({ length: 40 }, (_, i) => `unchanged_${i}/`)
      for (let i = 0; i < unchangedIds.length; i++) {
        const id = unchangedIds[i]
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m: 1000 - i, g: [], k: [], c: 'same' }))
      }

      // Server list: interleaved in timestamp descending order:
      // 20 new (2000..1981)
      // 20 mod (1500..1481)
      // 40 unchanged (1000..961)
      const serverPosts: { id: string; m: number; isNew?: boolean; isMod?: boolean }[] = []
      for (let i = 0; i < 20; i++) {
        serverPosts.push({ id: `new_${i}/`, m: 2000 - i, isNew: true })
      }
      for (let i = 0; i < 20; i++) {
        serverPosts.push({ id: `mod_${i}/`, m: 1500 - i, isMod: true })
      }
      for (let i = 0; i < 40; i++) {
        serverPosts.push({ id: `unchanged_${i}/`, m: 1000 - i })
      }

      const serverIds = serverPosts.map((p) => p.id)
      const serverM = serverPosts.map((p) => p.m)

      const chunks = [
        makeMeta(serverPosts.length, serverIds, serverM),
        ...serverPosts.map((p) => makeArticle(p.id, p.m, `body ${p.id}`)),
      ]

      const removedIds: string[] = []
      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: {
          onDocument: () => {},
          onDocumentRemoved: (id) => removedIds.push(id),
        },
        processPost,
        fetchImpl,
      })

      // 1. Verify deletions
      expect(result.toDelete).toHaveLength(20)
      expect(new Set(result.toDelete)).toEqual(new Set(deletedIds))
      expect(new Set(removedIds)).toEqual(new Set(deletedIds))
      for (const id of deletedIds) {
        expect(localMap.has(id)).toBe(false)
      }

      // 2. Verify additions and modifications in toPut
      expect(result.toPut).toHaveLength(40)
      const putMap = new Map(result.toPut.map((p) => [p.id, p]))

      for (let i = 0; i < 20; i++) {
        const newDoc = putMap.get(`new_${i}/`)
        expect(newDoc).toBeDefined()
        expect(newDoc?.m).toBe(2000 - i)
        expect(localMap.get(`new_${i}/`)?.m).toBe(2000 - i)
      }

      for (let i = 0; i < 20; i++) {
        const modDoc = putMap.get(`mod_${i}/`)
        expect(modDoc).toBeDefined()
        expect(modDoc?.m).toBe(1500 - i)
        expect(localMap.get(`mod_${i}/`)?.m).toBe(1500 - i)
      }

      // 3. Verify unchanged posts were preserved in localMap
      for (let i = 0; i < 40; i++) {
        expect(localMap.has(`unchanged_${i}/`)).toBe(true)
        expect(putMap.has(`unchanged_${i}/`)).toBe(false)
      }

      // 4. Verify early abort happened after the 40th article (the first unchanged post at index 40)
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
      // Total posts in localMap should be 80 (20 new + 20 mod + 40 unchanged)
      expect(localMap.size).toBe(80)
    })
  })

  describe('Adversarial Scenario 3: Zero-Byte Early Abort at Line 1', () => {
    it('never pulls or parses any post bodies when 500 cached posts match server meta', async () => {
      const count = 500
      const allIds = Array.from({ length: count }, (_, i) => `post_${i}/`)
      const allM = Array.from({ length: count }, (_, i) => 10000 - i)
      const localMap = new Map<string, IndexedDoc>()

      for (let i = 0; i < count; i++) {
        localMap.set(allIds[i], processPost({ id: allIds[i], t: `T${i}`, u: `/${allIds[i]}`, m: allM[i], g: [], k: [], c: 'c' }))
      }

      // Chunks: Chunk 0 = meta only; Chunk 1..500 = post bodies
      const chunks = [
        makeMeta(count, allIds, allM),
        ...allIds.map((id, i) => makeArticle(id, allM[i], 'huge content body')),
      ]

      const onCancel = vi.fn()
      const processPostSpy = vi.fn(processPost)
      const progress: SearchProgress[] = []
      const cachedReported: string[] = []

      const { fetchImpl, pulledChunks, getReadCallCount } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: {
          onDocument: (doc, kind) => {
            if (kind === 'cached') cachedReported.push(doc.id)
          },
          onProgress: (p) => progress.push(p),
        },
        processPost: processPostSpy,
        fetchImpl,
      })

      // 1. ProcessPost was NEVER invoked (0 byte body parsing)
      expect(processPostSpy).not.toHaveBeenCalled()

      // 2. reader.read was called exactly 1 time (only for Line 1 Meta chunk)
      expect(getReadCallCount()).toBe(1)
      // 3. Out of 501 chunks, chunks 2..500 were never pulled
      expect(pulledChunks.length).toBeLessThanOrEqual(2)
      expect(pulledChunks.includes(2)).toBe(false)
      expect(pulledChunks.includes(100)).toBe(false)
      expect(pulledChunks.includes(500)).toBe(false)

      // 3. Reader cancel called
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
      expect(result.toPut).toHaveLength(0)
      expect(result.toDelete).toHaveLength(0)
      expect(result.scannedCount).toBe(count)
      expect(result.totalCount).toBe(count)

      // 4. All 500 cached docs reported
      expect(cachedReported).toHaveLength(500)
      expect(cachedReported).toEqual(allIds)

      // 5. Final progress is 100%
      expect(progress.at(-1)).toMatchObject({ loaded: count, total: count, percent: 100, updated: 0 })
    })

    it('zero-byte abort even when chunk 0 contains multiple lines bundled together', async () => {
      // In real TCP / HTTP streaming, Chunk 0 might contain the meta line AND subsequent article lines
      const allIds = ['a/', 'b/']
      const allM = [200, 100]
      const localMap = new Map<string, IndexedDoc>([
        ['a/', processPost({ id: 'a/', t: 'a', u: '/a/', m: 200, g: [], k: [], c: 'a' })],
        ['b/', processPost({ id: 'b/', t: 'b', u: '/b/', m: 100, g: [], k: [], c: 'b' })],
      ])

      // Bundled together in a single chunk!
      const bundledChunk = `${makeMeta(2, allIds, allM)}${makeArticle('a/', 200, 'bundled body')}${makeArticle('b/', 100, 'bundled body')}`

      const processPostSpy = vi.fn(processPost)
      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch([bundledChunk], { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost: processPostSpy,
        fetchImpl,
      })

      // Even though article lines were in the raw chunk buffer, break outer prevents processPost
      expect(processPostSpy).not.toHaveBeenCalled()
      expect(result.canceledEarly).toBe(true)
      expect(result.toPut).toHaveLength(0)
    })

    it('zero-byte abort on empty site (0 posts on server and 0 posts in cache)', async () => {
      const localMap = new Map<string, IndexedDoc>()
      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch([makeMeta(0, [], [])], { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
      expect(result.toPut).toHaveLength(0)
      expect(result.toDelete).toHaveLength(0)
      expect(result.totalCount).toBe(0)
    })

    it('zero-byte abort on empty site when cache has stale posts (cleans cache at Line 1)', async () => {
      const localMap = new Map<string, IndexedDoc>([
        ['stale1/', processPost({ id: 'stale1/', t: 's1', u: '/s1/', m: 100, g: [], k: [], c: 'c' })],
        ['stale2/', processPost({ id: 'stale2/', t: 's2', u: '/s2/', m: 200, g: [], k: [], c: 'c' })],
      ])
      const removed: string[] = []
      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch([makeMeta(0, [], [])], { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: {
          onDocument: () => {},
          onDocumentRemoved: (id) => removed.push(id),
        },
        processPost,
        fetchImpl,
      })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
      expect(result.toDelete).toEqual(['stale1/', 'stale2/'])
      expect(removed).toEqual(['stale1/', 'stale2/'])
      expect(localMap.size).toBe(0)
    })
  })

  describe('Adversarial Scenario 4: Partial, Aborted, and Corrupted Streams', () => {
    it('stream network error mid-stream bubbles up to caller', async () => {
      const allIds = ['a/', 'b/', 'c/']
      const serverM = [300, 200, 100]
      const localMap = new Map<string, IndexedDoc>()

      const chunks = [
        makeMeta(3, allIds, serverM),
        makeArticle('a/', 300),
        makeArticle('b/', 200),
        makeArticle('c/', 100),
      ]

      // Fail abruptly at chunk 2 (during article b)
      const { fetchImpl } = createTrackedFetch(chunks, { errorAtChunk: 2 })

      await expect(
        syncJsonlStream({
          url: '/search.jsonl',
          localMap,
          handlers: { onDocument: () => {} },
          processPost,
          fetchImpl,
        }),
      ).rejects.toThrow('Adversarial stream network failure')

      // Document a was processed before the crash
      expect(localMap.has('a/')).toBe(true)
      expect(localMap.has('b/')).toBe(false)
    })

    it('reader.cancel failure is swallowed gracefully without crashing sync', async () => {
      const localMap = new Map<string, IndexedDoc>([
        ['a/', processPost({ id: 'a/', t: 'a', u: '/a/', m: 200, g: [], k: [], c: 'a' })],
      ])

      const { fetchImpl } = createTrackedFetch([makeMeta(1, ['a/'], [200])], {
        keepOpen: true,
        throwOnCancel: true, // reader.cancel() throws
      })

      // Must NOT throw
      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(result.canceledEarly).toBe(true)
    })

    it('corrupted non-JSON lines within stream are ignored safely', async () => {
      const localMap = new Map<string, IndexedDoc>()
      const chunks = [
        makeMeta(2, ['a/', 'b/'], [200, 100]),
        'INVALID_JSON_CORRUPTED_LINE_@@@@@@\n',
        makeArticle('a/', 200),
        '{ malformed json \n',
        makeArticle('b/', 100),
        '\n\n\n', // empty lines
      ]

      const { fetchImpl } = createTrackedFetch(chunks)

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(result.toPut).toHaveLength(2)
      expect(localMap.has('a/')).toBe(true)
      expect(localMap.has('b/')).toBe(true)
    })
  })

  describe('Adversarial Scenario 5: Timestamp & ID Edge Cases', () => {
    it('supports timestamp 0 and negative timestamps without falsy bugs', async () => {
      // Timestamp 0 (Jan 1 1970) or negative (before 1970)
      const allIds = ['epoch/', 'historical/']
      const allM = [0, -1000]
      const localMap = new Map<string, IndexedDoc>([
        ['epoch/', processPost({ id: 'epoch/', t: 'ep', u: '/ep/', m: 0, g: [], k: [], c: 'c' })],
        ['historical/', processPost({ id: 'historical/', t: 'hi', u: '/hi/', m: -1000, g: [], k: [], c: 'c' })],
      ])

      const { fetchImpl } = createTrackedFetch([makeMeta(2, allIds, allM)], { keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      // Should abort at line 1 even though m === 0 and m < 0
      expect(result.canceledEarly).toBe(true)
      expect(result.toPut).toHaveLength(0)
    })

    it('fallback when allM contains non-array or null', async () => {
      const localMap = new Map<string, IndexedDoc>()
      // allM is null or malformed
      const metaLine = `${JSON.stringify({ _type: 'meta', total: 1, allIds: ['a/'], allM: 'invalid' })}\n`
      const chunks = [metaLine, makeArticle('a/', 100)]

      const { fetchImpl } = createTrackedFetch(chunks)

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('a/')
    })
  })

  describe('Adversarial Scenario 6: Multi-Divergence, Byte-by-Byte Fuzzing & Unsorted Feeds', () => {
    it('multiple buried modified posts: 50 unchanged + 1 modified + 50 unchanged + 1 modified + 50 unchanged', async () => {
      // Index 50 is modified, Index 101 is modified.
      // Total 152 posts.
      // Must NOT abort at index 51! Must continue until index 102!
      const total = 152
      const allIds = Array.from({ length: total }, (_, i) => `post_${i}/`)
      const serverM = Array.from({ length: total }, (_, i) => 2000 - i)
      const localMap = new Map<string, IndexedDoc>()

      for (let i = 0; i < total; i++) {
        const id = allIds[i]
        const m = (i === 50 || i === 101) ? 500 : serverM[i] // local m differs at 50 and 101
        localMap.set(id, processPost({ id, t: id, u: `/${id}`, m, g: [], k: [], c: 'old' }))
      }

      const chunks = [
        makeMeta(total, allIds, serverM),
        ...allIds.map((id, i) => makeArticle(id, serverM[i], `body ${i}`)),
      ]

      const onCancel = vi.fn()
      const handledDocs: { id: string; kind: 'new' | 'cached' }[] = []
      const { fetchImpl, pulledChunks } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: {
          onDocument: (doc, kind) => handledDocs.push({ id: doc.id, kind }),
        },
        processPost,
        fetchImpl,
      })

      // Both modified posts captured
      expect(result.toPut).toHaveLength(2)
      expect(result.toPut.map((p) => p.id)).toEqual(['post_50/', 'post_101/'])
      expect(localMap.get('post_50/')?.m).toBe(serverM[50])
      expect(localMap.get('post_101/')?.m).toBe(serverM[101])

      // Early cancel happened after post 101 (at post 102)
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)

      // Verified handledDocs: exactly 103 items handled (0..102)
      expect(handledDocs).toHaveLength(103)
      expect(handledDocs[50]).toEqual({ id: 'post_50/', kind: 'new' })
      expect(handledDocs[101]).toEqual({ id: 'post_101/', kind: 'new' })
      expect(handledDocs[102]).toEqual({ id: 'post_102/', kind: 'cached' })

      // Trailing posts 103..151 never reached
      expect(pulledChunks.includes(120)).toBe(false)
      expect(pulledChunks.includes(150)).toBe(false)
    })

    it('byte-by-byte chunking stress: feed split into 1-byte chunks across lines', async () => {
      const rawText = `${makeMeta(2, ['a/', 'b/'], [200, 100])}${makeArticle('a/', 200, 'hello alpha')}${makeArticle('b/', 100, 'world beta')}`
      // Split rawText into 1-byte individual string chunks!
      const byteChunks = rawText.split('')

      const localMap = new Map<string, IndexedDoc>()
      const { fetchImpl } = createTrackedFetch(byteChunks)

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(result.toPut).toHaveLength(2)
      expect(localMap.get('a/')?.t).toBe('Title a/')
      expect(localMap.get('b/')?.t).toBe('Title b/')
      expect(result.scannedCount).toBe(2)
      expect(result.totalCount).toBe(2)
    })

    it('unsorted timestamps feed: correctly identifies lastDivergentIndex even if server timestamps fluctuate', async () => {
      // Server posts with fluctuating timestamps:
      // index 0: m=100 (unchanged)
      // index 1: m=50 (unchanged)
      // index 2: m=500 (modified!)
      // index 3: m=20 (unchanged)
      const allIds = ['p0/', 'p1/', 'p2/', 'p3/']
      const serverM = [100, 50, 500, 20]
      const localMap = new Map<string, IndexedDoc>([
        ['p0/', processPost({ id: 'p0/', t: 'p0', u: '/p0/', m: 100, g: [], k: [], c: 'c' })],
        ['p1/', processPost({ id: 'p1/', t: 'p1', u: '/p1/', m: 50, g: [], k: [], c: 'c' })],
        ['p2/', processPost({ id: 'p2/', t: 'p2', u: '/p2/', m: 300, g: [], k: [], c: 'old' })], // local m is 300
        ['p3/', processPost({ id: 'p3/', t: 'p3', u: '/p3/', m: 20, g: [], k: [], c: 'c' })],
      ])

      const chunks = [
        makeMeta(4, allIds, serverM),
        makeArticle('p0/', 100),
        makeArticle('p1/', 50),
        makeArticle('p2/', 500, 'updated p2'),
        makeArticle('p3/', 20),
      ]

      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch(chunks, { onCancel, keepOpen: true })

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      // p2 was updated
      expect(result.toPut).toHaveLength(1)
      expect(result.toPut[0].id).toBe('p2/')
      expect(result.toPut[0].m).toBe(500)
      // early abort triggered after p3 (currentIndex 3 > lastDivergentIndex 2)
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(result.canceledEarly).toBe(true)
    })

    it('full cache rebuild on completely cold client (0 cached docs, 200 server docs)', async () => {
      const count = 200
      const allIds = Array.from({ length: count }, (_, i) => `doc_${i}/`)
      const serverM = Array.from({ length: count }, (_, i) => 5000 - i)
      const localMap = new Map<string, IndexedDoc>() // completely cold

      const chunks = [
        makeMeta(count, allIds, serverM),
        ...allIds.map((id, i) => makeArticle(id, serverM[i])),
      ]

      const onCancel = vi.fn()
      const { fetchImpl } = createTrackedFetch(chunks)

      const result = await syncJsonlStream({
        url: '/search.jsonl',
        localMap,
        handlers: { onDocument: () => {} },
        processPost,
        fetchImpl,
      })

      expect(onCancel).not.toHaveBeenCalled()
      expect(result.canceledEarly).toBe(false)
      expect(result.toPut).toHaveLength(count)
      expect(localMap.size).toBe(count)
      expect(result.scannedCount).toBe(count)
      expect(result.totalCount).toBe(count)
    })
  })
})

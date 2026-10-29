import { describe, expect, it, vi } from 'vitest'
import { buildJsonl, buildJsonlRecords, normalizePostUrl, toTimestamp } from '../../src/node/jsonl'
import { syncJsonlStream } from '../../src/web/core/stream'
import type { PostLike } from '../../src/node/hexo-types'
import type { IndexedDoc, SearchPostRecord } from '../../src/shared/types'

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function processPost(record: SearchPostRecord): IndexedDoc {
  return {
    ...record,
    dl: 10,
    tf: { test: 1 },
  }
}

describe('Adversarial & Stress: toTimestamp', () => {
  it('handles null, undefined, 0, negative, and non-finite numbers', () => {
    expect(toTimestamp(null)).toBe(0)
    expect(toTimestamp(undefined)).toBe(0)
    expect(toTimestamp(0)).toBe(0)
    expect(toTimestamp(-100)).toBe(-100)
    expect(toTimestamp(NaN)).toBe(0)
    expect(toTimestamp(Infinity)).toBe(0)
    expect(toTimestamp(-Infinity)).toBe(0)
  })

  it('handles Date objects (valid, invalid, pre-1970)', () => {
    const valid = new Date('2024-01-01T00:00:00Z')
    expect(toTimestamp(valid)).toBe(valid.getTime())

    const pre1970 = new Date('1969-07-20T20:17:00Z')
    expect(toTimestamp(pre1970)).toBe(pre1970.getTime())
    expect(toTimestamp(pre1970)).toBeLessThan(0)

    const invalid = new Date('not-a-date')
    expect(toTimestamp(invalid)).toBe(0)
  })

  it('handles Moment-like objects with valueOf', () => {
    expect(toTimestamp({ valueOf: () => 1700000000000 })).toBe(1700000000000)
    expect(toTimestamp({ valueOf: () => NaN })).toBe(0)
    expect(toTimestamp({ valueOf: () => Infinity })).toBe(0)
    expect(toTimestamp({ valueOf: () => -Infinity })).toBe(0)
    expect(toTimestamp({ valueOf: () => 'not-a-number' as any })).toBe(0)
  })

  it('handles primitive strings, booleans, and arbitrary objects safely', () => {
    expect(toTimestamp('2024-01-01' as any)).toBe(0)
    expect(toTimestamp(true as any)).toBe(0)
    expect(toTimestamp(false as any)).toBe(0)
    expect(toTimestamp({} as any)).toBe(0)
    expect(toTimestamp([] as any)).toBe(0)
  })

  it('handles Object.create(null) safely if encountered', () => {
    const nullProto = Object.create(null)
    // Testing whether toTimestamp throws or handles null prototype
    try {
      const ts = toTimestamp(nullProto)
      expect(ts).toBe(0)
    } catch (err) {
      // Document if it throws TypeError
      expect(err).toBeInstanceOf(TypeError)
    }
  })
})

describe('Adversarial & Stress: normalizePostUrl', () => {
  it('handles abnormal slashes and root configurations', () => {
    expect(normalizePostUrl('//foo///bar//', '/')).toBe('/foo/bar/')
    expect(normalizePostUrl('/foo/bar', '/blog/')).toBe('/foo/bar')
    expect(normalizePostUrl('foo/bar', '/blog///')).toBe('/blog/foo/bar')
    expect(normalizePostUrl('', '/')).toBe('/')
    expect(normalizePostUrl('', '')).toBe('/')
  })

  it('handles unicode paths and query/hash characters', () => {
    expect(normalizePostUrl('你好/世界/', '/')).toBe('/你好/世界/')
    expect(normalizePostUrl('post?query=1#hash', '/')).toBe('/post?query=1#hash')
    expect(normalizePostUrl('🚀/🔥/', '/blog/')).toBe('/blog/🚀/🔥/')
  })
})

describe('Adversarial & Stress: Large-Scale Deterministic Sorting', () => {
  it('5,000 posts with identical timestamps sort 100% deterministically across random permutations', () => {
    const count = 5000
    const fixedTimestamp = 1700000000000

    // Create 5000 posts with paths like 'posts/path_0000/'
    const originalPosts: PostLike[] = Array.from({ length: count }, (_, i) => ({
      path: `posts/path_${String(i).padStart(4, '0')}/`,
      title: `Post ${i}`,
      content: `Content ${i}`,
      updated: fixedTimestamp,
    }))

    // Baseline run
    const baselineRecords = buildJsonlRecords(originalPosts)
    const baselineMeta = baselineRecords[0] as { total: number; allIds: string[]; allM: number[] }

    expect(baselineMeta.total).toBe(count)
    expect(baselineMeta.allIds).toHaveLength(count)
    expect(baselineMeta.allM).toHaveLength(count)

    // Verify allM values are all equal to fixedTimestamp
    for (let i = 0; i < count; i++) {
      expect(baselineMeta.allM[i]).toBe(fixedTimestamp)
    }

    // Run 5 different shuffles and verify output allIds is IDENTICAL to baseline
    for (let run = 1; run <= 5; run++) {
      const shuffledPosts = shuffle(originalPosts)
      const records = buildJsonlRecords(shuffledPosts)
      const meta = records[0] as { total: number; allIds: string[]; allM: number[] }

      expect(meta.allIds).toEqual(baselineMeta.allIds)
      expect(meta.allM).toEqual(baselineMeta.allM)
    }
  })

  it('3,000 posts with timestamp collisions partition deterministically by timestamp then path', () => {
    const posts: PostLike[] = []
    const timestamps = [3000, 2000, 1000]

    for (const ts of timestamps) {
      for (let i = 0; i < 1000; i++) {
        posts.push({
          path: `ts_${ts}/item_${String(i).padStart(3, '0')}/`,
          title: `Item ${ts}-${i}`,
          content: 'text',
          updated: ts,
        })
      }
    }

    const shuffled = shuffle(posts)
    const records = buildJsonlRecords(shuffled)
    const meta = records[0] as { total: number; allIds: string[]; allM: number[] }

    expect(meta.total).toBe(3000)

    // First 1000 must have ts 3000
    for (let i = 0; i < 1000; i++) {
      expect(meta.allM[i]).toBe(3000)
      expect(meta.allIds[i]).toBe(`ts_3000/item_${String(i).padStart(3, '0')}/`)
    }
    // Next 1000 must have ts 2000
    for (let i = 1000; i < 2000; i++) {
      expect(meta.allM[i]).toBe(2000)
      expect(meta.allIds[i]).toBe(`ts_2000/item_${String(i - 1000).padStart(3, '0')}/`)
    }
    // Last 1000 must have ts 1000
    for (let i = 2000; i < 3000; i++) {
      expect(meta.allM[i]).toBe(1000)
      expect(meta.allIds[i]).toBe(`ts_1000/item_${String(i - 2000).padStart(3, '0')}/`)
    }
  })
})

describe('Adversarial & Stress: Special Characters, Unicode, Slashes in Paths', () => {
  it('handles unicode paths (CJK, Emoji, Accents, RTL) deterministically', () => {
    const complexPosts: PostLike[] = [
      { path: '中文/文章一/', title: '中文 1', updated: 500 },
      { path: '中文/文章二/', title: '中文 2', updated: 500 },
      { path: '日本語/テスト/', title: '日本語', updated: 500 },
      { path: '한국어/포스트/', title: '한국어', updated: 500 },
      { path: 'emoji/🚀-launch/', title: 'Emoji 1', updated: 500 },
      { path: 'emoji/🎉-party/', title: 'Emoji 2', updated: 500 },
      { path: 'latin/café-au-lait/', title: 'Café', updated: 500 },
      { path: 'latin/über-cool/', title: 'Über', updated: 500 },
      { path: 'rtl/مرحبا/', title: 'Arabic', updated: 500 },
      { path: 'symbols/a+b=c/', title: 'Math', updated: 500 },
      { path: 'special/path with spaces & query?x=1/', title: 'Spaces', updated: 500 },
    ]

    const run1 = buildJsonlRecords(shuffle(complexPosts))
    const run2 = buildJsonlRecords(shuffle(complexPosts))

    const meta1 = run1[0] as { allIds: string[]; allM: number[] }
    const meta2 = run2[0] as { allIds: string[]; allM: number[] }

    expect(meta1.allIds).toEqual(meta2.allIds)
    expect(meta1.allM).toEqual(meta2.allM)
    expect(meta1.allIds).toHaveLength(complexPosts.length)
  })

  it('handles paths with newlines, tabs, and quotes without corrupting JSONL format', () => {
    const trickyPosts: PostLike[] = [
      { path: 'path\nwith\nnewlines/', title: 'Newline Post', content: 'line 1\nline 2', updated: 100 },
      { path: 'path\twith\ttabs/', title: 'Tab Post', content: 'tab\tseparated', updated: 200 },
      { path: 'path"with"quotes/', title: 'Quote "Post"', content: 'quote "here"', updated: 300 },
      { path: 'path\\with\\backslashes/', title: 'Backslash Post', content: 'back\\slash', updated: 400 },
    ]

    const jsonl = buildJsonl(trickyPosts)
    const lines = jsonl.split('\n')

    // 1 meta line + 4 post lines = 5 lines total
    expect(lines).toHaveLength(5)

    // Verify every line is valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const parsedMeta = JSON.parse(lines[0])
    expect(parsedMeta.total).toBe(4)
    expect(parsedMeta.allIds).toEqual([
      'path\\with\\backslashes/',
      'path"with"quotes/',
      'path\twith\ttabs/',
      'path\nwith\nnewlines/',
    ])
    expect(parsedMeta.allM).toEqual([400, 300, 200, 100])
  })

  it('handles empty string path gracefully', () => {
    const weirdPosts: PostLike[] = [
      { path: '', title: 'Empty Path', updated: 100 },
      { path: 'valid/', title: 'Valid Path', updated: 150 },
    ]

    const records = buildJsonlRecords(weirdPosts)
    const meta = records[0] as { total: number; allIds: string[]; allM: number[] }

    expect(meta.total).toBe(2)
    expect(meta.allM).toEqual([150, 100])
    expect(meta.allIds).toEqual(['valid/', ''])
  })

  it('demonstrates behavior when path is undefined', () => {
    const weirdPosts: PostLike[] = [
      { path: undefined as any, title: 'Undefined Path', updated: 200 },
      { path: 'valid/', title: 'Valid Path', updated: 150 },
    ]

    // Since normalizePostUrl expects a string, calling buildJsonlRecords throws TypeError if post.path is undefined
    expect(() => buildJsonlRecords(weirdPosts)).toThrow(TypeError)
  })
})

describe('Adversarial & Stress: allM and allIds 1:1 Strict Alignment', () => {
  it('maintains strict 1:1 index alignment between allIds, allM, and records under chaotic conditions', () => {
    const testCases: PostLike[][] = [
      // Case 1: Empty
      [],
      // Case 2: Single post
      [{ path: 'one/', updated: 100 }],
      // Case 3: Mixed timestamps and dates, some null/undefined
      [
        { path: 'p1/', updated: 500, date: 100 },
        { path: 'p2/', date: 300 },
        { path: 'p3/', updated: null as any, date: 400 },
        { path: 'p4/', updated: 0, date: 0 },
        { path: 'p5/', updated: -50, date: -100 },
        { path: 'p6/', updated: NaN, date: 200 },
        { path: 'p7/', updated: Infinity, date: 150 },
      ],
      // Case 4: Posts with filtering flags
      [
        { path: 'published-false/', published: false, updated: 999 },
        { path: 'indexing-false/', indexing: false, updated: 888 },
        { path: 'valid-1/', updated: 777 },
        { path: 'valid-2/', updated: 666 },
      ],
    ]

    for (const posts of testCases) {
      const records = buildJsonlRecords(posts)
      const meta = records[0] as { _type: 'meta'; total: number; allIds: string[]; allM: number[] }

      expect(meta._type).toBe('meta')
      expect(meta.total).toBe(meta.allIds.length)
      expect(meta.allM.length).toBe(meta.allIds.length)
      expect(records.length - 1).toBe(meta.total)

      // Strict 1:1 check for each item
      for (let i = 0; i < meta.total; i++) {
        const postRecord = records[i + 1] as SearchPostRecord
        expect(postRecord.id).toBe(meta.allIds[i])
        expect(postRecord.m).toBe(meta.allM[i])
        expect(Number.isFinite(meta.allM[i])).toBe(true)
      }
    }
  })
})

describe('Adversarial & Stress: Stream Sync Integration with Stress Generator Output', () => {
  it('syncJsonlStream handles 1000 posts with partial updates at edge positions', async () => {
    const count = 1000
    const posts: PostLike[] = Array.from({ length: count }, (_, i) => ({
      path: `post_${String(i).padStart(4, '0')}/`,
      title: `Title ${i}`,
      content: `Content ${i}`,
      updated: 1000,
    }))

    const initialRecords = buildJsonlRecords(posts)
    const localMap = new Map<string, IndexedDoc>()

    // Pre-populate local cache with all 1000 posts
    for (let i = 1; i < initialRecords.length; i++) {
      const p = initialRecords[i] as SearchPostRecord
      localMap.set(p.id, processPost(p))
    }

    // Now modify post at index 100 and post at index 950 (near end)
    posts[100].updated = 2000 // becomes first or early in sort
    posts[950].updated = 1500 // becomes next

    const updatedRecords = buildJsonlRecords(posts)
    const jsonlContent = updatedRecords.map((r) => JSON.stringify(r)).join('\n')

    // Create a mock stream
    const onCancel = vi.fn()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(jsonlContent))
        controller.close()
      },
      cancel() {
        onCancel()
      },
    })

    const customFetch = () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
      )

    const handledDocs: { doc: IndexedDoc; kind: 'new' | 'cached' }[] = []
    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: (doc, kind) => handledDocs.push({ doc, kind }),
      },
      processPost,
      fetchImpl: customFetch as any,
    })

    // Both updated posts must be captured
    expect(result.toPut).toHaveLength(2)
    const updatedIds = result.toPut.map((d) => d.id)
    expect(updatedIds).toContain(posts[100].path)
    expect(updatedIds).toContain(posts[950].path)

    // Handled docs should have 2 'new'
    const newDocs = handledDocs.filter((h) => h.kind === 'new')
    expect(newDocs).toHaveLength(2)

    // Since index 950 was updated, it was at position 1 (after index 100 which has m=2000)
    // After that, all posts are unchanged, so stream disconnects safely early!
    expect(result.canceledEarly).toBe(true)
  })

  it('1,000 posts up-to-date triggers Line 1 zero-byte abort with zero post body processing', async () => {
    const count = 1000
    const posts: PostLike[] = Array.from({ length: count }, (_, i) => ({
      path: `post_${String(i).padStart(4, '0')}/`,
      title: `Title ${i}`,
      content: `Content ${i}`,
      updated: 1000 + i,
    }))

    const records = buildJsonlRecords(posts)
    const localMap = new Map<string, IndexedDoc>()

    for (let i = 1; i < records.length; i++) {
      const p = records[i] as SearchPostRecord
      localMap.set(p.id, processPost(p))
    }

    const jsonlContent = records.map((r) => JSON.stringify(r)).join('\n')
    let streamCancelled = false

    const customFetch = () => {
      const stream = new ReadableStream({
        start(controller) {
          // Push only the first chunk containing the meta line
          const firstLine = jsonlContent.slice(0, jsonlContent.indexOf('\n') + 1)
          controller.enqueue(new TextEncoder().encode(firstLine))
          // Do not close yet to simulate active stream
        },
        cancel() {
          streamCancelled = true
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    }

    const handledDocs: { doc: IndexedDoc; kind: 'new' | 'cached' }[] = []
    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: (doc, kind) => handledDocs.push({ doc, kind }),
      },
      processPost,
      fetchImpl: customFetch as any,
    })

    expect(result.canceledEarly).toBe(true)
    expect(streamCancelled).toBe(true)
    expect(result.toPut).toHaveLength(0)
    expect(handledDocs).toHaveLength(1000)
    expect(handledDocs.every((h) => h.kind === 'cached')).toBe(true)
  })

  it('handles empty blog (0 posts) with existing cache by clearing deleted posts and early aborting', async () => {
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 200, g: [], k: [], c: 'alpha' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])
    const removed: string[] = []

    const emptyJsonl = `${buildJsonl([])}\n`
    const customFetch = () =>
      Promise.resolve(
        new Response(emptyJsonl, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
      )

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: customFetch as any,
    })

    expect(result.toDelete).toEqual(['a/'])
    expect(removed).toEqual(['a/'])
    expect(localMap.has('a/')).toBe(false)
    expect(result.canceledEarly).toBe(true)
  })

  it('handles post timestamp rolled backward (e.g. fixing typo in front-matter date)', async () => {
    // Local cache has future timestamp 3000
    const cachedA = processPost({ id: 'a/', t: 'A', u: '/a/', m: 3000, g: [], k: [], c: 'future post' })
    const localMap = new Map<string, IndexedDoc>([['a/', cachedA]])

    // Server has rolled back timestamp to 1000
    const posts: PostLike[] = [{ path: 'a/', title: 'A', content: 'corrected post', updated: 1000 }]
    const jsonl = buildJsonl(posts)

    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: { onDocument: () => {} },
      processPost,
      fetchImpl: () => Promise.resolve(new Response(jsonl, { status: 200 })) as any,
    })

    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('a/')
    expect(result.toPut[0].m).toBe(1000)
    expect(localMap.get('a/')?.m).toBe(1000)
  })

  it('handles renamed post permalinks (slug change)', async () => {
    const oldCached = processPost({ id: 'old-slug/', t: 'Article', u: '/old-slug/', m: 500, g: [], k: [], c: 'text' })
    const localMap = new Map<string, IndexedDoc>([['old-slug/', oldCached]])

    const posts: PostLike[] = [{ path: 'new-slug/', title: 'Article', content: 'text', updated: 500 }]
    const jsonl = buildJsonl(posts)

    const removed: string[] = []
    const result = await syncJsonlStream({
      url: '/search.jsonl',
      localMap,
      handlers: {
        onDocument: () => {},
        onDocumentRemoved: (id) => removed.push(id),
      },
      processPost,
      fetchImpl: () => Promise.resolve(new Response(jsonl, { status: 200 })) as any,
    })

    expect(result.toDelete).toEqual(['old-slug/'])
    expect(removed).toEqual(['old-slug/'])
    expect(result.toPut).toHaveLength(1)
    expect(result.toPut[0].id).toBe('new-slug/')
    expect(localMap.has('new-slug/')).toBe(true)
    expect(localMap.has('old-slug/')).toBe(false)
  })

  it('10,000 posts stress test: 100% sorting determinism and strict allM alignment', () => {
    const count = 10000
    const fixedTs = 1680000000000
    const posts: PostLike[] = Array.from({ length: count }, (_, i) => ({
      path: `category/sub/post_${String(i).padStart(5, '0')}.html`,
      title: `Article ${i}`,
      content: `Body ${i}`,
      updated: fixedTs,
    }))

    const run1 = buildJsonlRecords(shuffle(posts))
    const run2 = buildJsonlRecords(shuffle(posts))

    const meta1 = run1[0] as { total: number; allIds: string[]; allM: number[] }
    const meta2 = run2[0] as { total: number; allIds: string[]; allM: number[] }

    expect(meta1.total).toBe(count)
    expect(meta1.allIds).toEqual(meta2.allIds)
    expect(meta1.allM).toEqual(meta2.allM)
    expect(meta1.allIds[0]).toBe('category/sub/post_00000.html')
    expect(meta1.allIds[count - 1]).toBe(`category/sub/post_${String(count - 1).padStart(5, '0')}.html`)
  })
})

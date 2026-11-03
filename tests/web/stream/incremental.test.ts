/**
 * syncJsonlStream —— 增量比对：缓存命中、变更检测、服务端删除与提前断流
 */
import { describe, expect, it, vi } from 'vitest'
import { processPost } from '../../../src/web/core/index-store'
import { jsonlFetch, mockFetch, trackedStream } from '../../helpers/http'
import { cacheOf, cachedDoc, metaLine, postLine } from '../../helpers/jsonl'
import { runSync } from '../../helpers/sync'

/** 构造 n 篇文章：本地缓存与服务端一致，除了 `changed` 中列出的下标（本地为旧版本） */
function scenario(count: number, changed: number[]) {
  const ids = Array.from({ length: count }, (_, i) => `p${i}/`)
  const ms = ids.map((_, i) => 10_000 - i)
  const localMap = cacheOf(ids.map((id, i) => cachedDoc(id, changed.includes(i) ? 1 : ms[i])))
  const chunks = [metaLine(ids, ms), ...ids.map((id, i) => postLine(id, ms[i]))]
  return { ids, ms, localMap, chunks }
}

describe('syncJsonlStream：增量比对与提前断流', () => {
  describe('首行 meta 比对', () => {
    it('全站与 allM 完全一致时在 meta 行后立即断流，不下载任何文章正文', async () => {
      const { ids, localMap, chunks } = scenario(200, [])
      const onCancel = vi.fn()
      const { stream, pulled } = trackedStream(chunks, { keepOpen: true, onCancel })
      const spy = vi.fn(processPost)

      const { result, documents, progress } = await runSync({
        localMap,
        processPost: spy,
        fetchImpl: mockFetch(() => new Response(stream)).fetch,
      })

      expect(spy).not.toHaveBeenCalled()
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(pulled.length).toBeLessThanOrEqual(2)
      expect(result).toMatchObject({ canceledEarly: true, scannedCount: 200, totalCount: 200 })
      expect(result.toPut).toEqual([])
      expect(result.toDelete).toEqual([])
      // 所有缓存文档按 meta 顺序以 cached 上报
      expect(documents).toEqual(ids.map((id) => ({ id, kind: 'cached' })))
      expect(progress.at(-1)).toMatchObject({ loaded: 200, total: 200, percent: 100, updated: 0 })
      expect(result.finalSyncState?.status).toBe('completed')
    })

    it('meta 与文章行处于同一个数据块时同样不处理文章行', async () => {
      const localMap = cacheOf([cachedDoc('a/', 2), cachedDoc('b/', 1)])
      const spy = vi.fn(processPost)

      const { result } = await runSync({
        localMap,
        processPost: spy,
        fetchImpl: jsonlFetch([`${metaLine(['a/', 'b/'], [2, 1])}${postLine('a/', 2)}${postLine('b/', 1)}`], {}, {
          keepOpen: true,
        }).fetch,
      })

      expect(spy).not.toHaveBeenCalled()
      expect(result.canceledEarly).toBe(true)
    })

    it('服务端已删除的文章在 meta 行即被清理，其余一致时仍零字节断流', async () => {
      const localMap = cacheOf([cachedDoc('a/', 2), cachedDoc('gone-1/', 1), cachedDoc('gone-2/', 1)])

      const { result, removed } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['a/'], [2]), postLine('a/', 2)], {}, { keepOpen: true }).fetch,
      })

      expect(result.canceledEarly).toBe(true)
      expect(result.toDelete).toEqual(['gone-1/', 'gone-2/'])
      expect(removed).toEqual(['gone-1/', 'gone-2/'])
      expect([...localMap.keys()]).toEqual(['a/'])
    })

    it.each([
      ['本地无缓存', []],
      ['本地有过期缓存', [cachedDoc('stale-1/', 1), cachedDoc('stale-2/', 2)]],
    ])('空站点（total = 0）：%s 时清空缓存并断流', async (_name, docs) => {
      const localMap = cacheOf(docs)
      const { result, progress } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine([], [])], {}, { keepOpen: true }).fetch,
      })

      expect(result).toMatchObject({ canceledEarly: true, totalCount: 0 })
      expect(result.toDelete).toEqual(docs.map((doc) => doc.id))
      expect(localMap.size).toBe(0)
      expect(progress.every((p) => Number.isFinite(p.percent))).toBe(true)
    })

    it('时间戳为 0 或负数时同样参与严格比对', async () => {
      const localMap = cacheOf([cachedDoc('epoch/', 0), cachedDoc('historical/', -1000)])
      const { result } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['epoch/', 'historical/'], [0, -1000])], {}, { keepOpen: true }).fetch,
      })

      expect(result.canceledEarly).toBe(true)
      expect(result.toPut).toEqual([])
    })

    it.each([
      ['缺少 allM（旧版 meta）', undefined],
      ['allM 长度与 allIds 不一致', [2]],
      ['allM 不是数组', 'invalid'],
      ['allM 为 null', null],
    ])('%s 时降级为按 ID 缺失计算断流点', async (_name, allM) => {
      const localMap = cacheOf([cachedDoc('a/', 2)])
      const meta = `${JSON.stringify({ _type: 'meta', total: 2, allIds: ['a/', 'b/'], allM })}\n`

      const { result } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([meta, postLine('a/', 2), postLine('b/', 1)]).fetch,
      })

      expect(result.toPut.map((doc) => doc.id)).toEqual(['b/'])
      expect(localMap.has('b/')).toBe(true)
    })

    it('降级模式下即使本地文档齐全也不会在 meta 行断流', async () => {
      const localMap = cacheOf([cachedDoc('a/', 2)])
      const { result, documents } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['a/']), postLine('a/', 2)], {}, { keepOpen: true }).fetch,
      })

      // 读到第一篇命中缓存的文章后才断流
      expect(documents).toEqual([{ id: 'a/', kind: 'cached' }])
      expect(result.canceledEarly).toBe(true)
    })
  })

  describe('文章行比对', () => {
    it('命中修改时间一致的缓存且已越过最后一个差异位置时断流', async () => {
      const onCancel = vi.fn()
      const localMap = cacheOf([cachedDoc('a/', 2), cachedDoc('b/', 1)])

      const { result, documents } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['new/', 'a/', 'b/'], [3, 2, 1]), postLine('new/', 3), postLine('a/', 2), postLine('b/', 1)], {}, {
          keepOpen: true,
          onCancel,
        }).fetch,
      })

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(documents).toEqual([
        { id: 'new/', kind: 'new' },
        { id: 'a/', kind: 'cached' },
      ])
      expect(result).toMatchObject({ canceledEarly: true, scannedCount: 3 })
      expect(result.toPut.map((doc) => doc.id)).toEqual(['new/'])
    })

    it('修改时间变化的文章被重新处理（包括时间戳回退）', async () => {
      const localMap = cacheOf([cachedDoc('newer/', 200, { c: 'old' }), cachedDoc('older/', 3000, { c: 'future' })])

      const { result } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['newer/', 'older/'], [300, 1000]), postLine('newer/', 300), postLine('older/', 1000)]).fetch,
      })

      expect(result.toPut.map((doc) => [doc.id, doc.m])).toEqual([
        ['newer/', 300],
        ['older/', 1000],
      ])
      expect(localMap.get('older/')?.m).toBe(1000)
    })

    it('本地缺失排在末尾的文章时读完全流，不提前断流', async () => {
      const onCancel = vi.fn()
      const localMap = cacheOf([cachedDoc('a/', 2)])

      const { result } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['a/', 'b/'], [2, 1]), postLine('a/', 2), postLine('b/', 1)], {}, { onCancel }).fetch,
      })

      expect(onCancel).not.toHaveBeenCalled()
      expect(result.canceledEarly).toBe(false)
      expect(result.toPut.map((doc) => doc.id)).toEqual(['b/'])
    })

    it('变更文章排在未变更文章之后时不会被提前断流跳过', async () => {
      const { localMap, chunks } = scenario(3, [1])
      const { result, documents } = await runSync({
        localMap,
        fetchImpl: jsonlFetch(chunks, {}, { keepOpen: true }).fetch,
      })

      expect(documents).toEqual([
        { id: 'p0/', kind: 'cached' },
        { id: 'p1/', kind: 'new' },
        { id: 'p2/', kind: 'cached' },
      ])
      expect(result.toPut.map((doc) => doc.id)).toEqual(['p1/'])
      expect(result.canceledEarly).toBe(true)
    })

    it('深埋的变更文章被更新，其后的文章不再被拉取', async () => {
      const { localMap, chunks } = scenario(201, [100])
      const onCancel = vi.fn()
      const { stream, pulled } = trackedStream(chunks, { keepOpen: true, onCancel })

      const { result, documents } = await runSync({
        localMap,
        fetchImpl: mockFetch(() => new Response(stream)).fetch,
      })

      expect(result.toPut.map((doc) => doc.id)).toEqual(['p100/'])
      expect(localMap.get('p100/')?.m).toBe(10_000 - 100)
      expect(onCancel).toHaveBeenCalledTimes(1)
      // 0..99 cached，100 new，101 cached 后断流
      expect(documents).toHaveLength(102)
      expect(documents[100]).toEqual({ id: 'p100/', kind: 'new' })
      expect(documents[101]).toEqual({ id: 'p101/', kind: 'cached' })
      // chunk 0 为 meta，chunk i + 1 为第 i 篇文章
      expect(pulled).not.toContain(150)
      expect(pulled).not.toContain(201)
    })

    it.each([
      { name: '首篇', changed: [0], cancel: true, handled: 2 },
      { name: '末篇', changed: [99], cancel: false, handled: 100 },
      { name: '多处（第 50 与第 101 篇）', changed: [50, 101], cancel: true, handled: 103, count: 152 },
    ])('变更位于$name时只在越过最后一处差异后断流', async ({ changed, cancel, handled, count = 100 }) => {
      const { ids, localMap, chunks } = scenario(count, changed)
      const { result, documents } = await runSync({
        localMap,
        fetchImpl: jsonlFetch(chunks, {}, { keepOpen: cancel }).fetch,
      })

      expect(result.toPut.map((doc) => doc.id)).toEqual(changed.map((i) => ids[i]))
      expect(result.canceledEarly).toBe(cancel)
      expect(documents).toHaveLength(handled)
    })

    it('服务端时间戳非单调排列时仍能精确定位最后一个差异位置', async () => {
      const ids = ['p0/', 'p1/', 'p2/', 'p3/']
      const serverM = [100, 50, 500, 20]
      const localMap = cacheOf([cachedDoc('p0/', 100), cachedDoc('p1/', 50), cachedDoc('p2/', 300), cachedDoc('p3/', 20)])

      const { result, documents } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(ids, serverM), ...ids.map((id, i) => postLine(id, serverM[i]))], {}, { keepOpen: true }).fetch,
      })

      expect(result.toPut.map((doc) => [doc.id, doc.m])).toEqual([['p2/', 500]])
      expect(documents.map((d) => d.id)).toEqual(ids)
      expect(result.canceledEarly).toBe(true)
    })

    it('同时处理新增、修改、删除与未变更文章', async () => {
      const deleted = Array.from({ length: 20 }, (_, i) => `deleted-${i}/`)
      const modified = Array.from({ length: 20 }, (_, i) => `mod-${i}/`)
      const unchanged = Array.from({ length: 40 }, (_, i) => `same-${i}/`)
      const added = Array.from({ length: 20 }, (_, i) => `new-${i}/`)

      const localMap = cacheOf([
        ...deleted.map((id) => cachedDoc(id, 300)),
        ...modified.map((id) => cachedDoc(id, 500)),
        ...unchanged.map((id, i) => cachedDoc(id, 1000 - i)),
      ])
      const server = [
        ...added.map((id, i) => ({ id, m: 2000 - i })),
        ...modified.map((id, i) => ({ id, m: 1500 - i })),
        ...unchanged.map((id, i) => ({ id, m: 1000 - i })),
      ]

      const { result, removed } = await runSync({
        localMap,
        fetchImpl: jsonlFetch(
          [metaLine(server.map((p) => p.id), server.map((p) => p.m)), ...server.map((p) => postLine(p.id, p.m))],
          {},
          { keepOpen: true },
        ).fetch,
      })

      expect(new Set(result.toDelete)).toEqual(new Set(deleted))
      expect(new Set(removed)).toEqual(new Set(deleted))
      expect(new Set(result.toPut.map((doc) => doc.id))).toEqual(new Set([...added, ...modified]))
      expect(result.canceledEarly).toBe(true)
      expect(localMap.size).toBe(80)
      for (const id of unchanged) expect(localMap.has(id)).toBe(true)
    })

    it('文章改名（slug 变更）视为删除旧 ID 并新增新 ID', async () => {
      const localMap = cacheOf([cachedDoc('old-slug/', 500)])
      const { result } = await runSync({
        localMap,
        fetchImpl: jsonlFetch([metaLine(['new-slug/'], [500]), postLine('new-slug/', 500)]).fetch,
      })

      expect(result.toDelete).toEqual(['old-slug/'])
      expect(result.toPut.map((doc) => doc.id)).toEqual(['new-slug/'])
      expect([...localMap.keys()]).toEqual(['new-slug/'])
    })

    it('冷启动（无本地缓存）时全量处理，不提前断流', async () => {
      const { chunks } = scenario(200, [])
      const { result, localMap } = await runSync({ fetchImpl: jsonlFetch(chunks).fetch })

      expect(result).toMatchObject({ canceledEarly: false, scannedCount: 200, totalCount: 200 })
      expect(result.toPut).toHaveLength(200)
      expect(localMap.size).toBe(200)
    })
  })

  it('reader.cancel() 抛错时被吞掉，同步正常完成', async () => {
    const localMap = cacheOf([cachedDoc('a/', 2)])
    const { result } = await runSync({
      localMap,
      fetchImpl: jsonlFetch([metaLine(['a/'], [2])], {}, { keepOpen: true, throwOnCancel: true }).fetch,
    })

    expect(result.canceledEarly).toBe(true)
    expect(result.finalSyncState?.status).toBe('completed')
  })
})

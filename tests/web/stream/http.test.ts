/**
 * syncJsonlStream —— HTTP 状态机：条件请求头、206 续传、200 回退、416 重试、304 协商缓存与异常
 */
import { describe, expect, it } from 'vitest'
import { jsonlFetch, mockFetch, splitBytes, streamOf } from '../../helpers/http'
import {
  buildSite,
  cacheOf,
  cachedDoc,
  DEFAULT_SYNC_KEY,
  encode,
  metaLine,
  metaRecord,
  postLine,
  syncStateOf,
} from '../../helpers/jsonl'
import { runSync } from '../../helpers/sync'

function emptyOk(): Response {
  return new Response(streamOf([metaLine([], [])]))
}

describe('syncJsonlStream：HTTP 状态机', () => {
  describe('条件请求头', () => {
    it('没有同步状态时发起普通 GET', async () => {
      const server = mockFetch(emptyOk)
      await runSync({ fetchImpl: server.fetch })

      expect(server.requests).toHaveLength(1)
      expect(server.requests[0].url).toBe('/search.jsonl')
      expect(server.requests[0].hasInit).toBe(false)
    })

    it.each([
      {
        name: '中断状态 + ETag → Range 与 If-Range(ETag)',
        state: { status: 'syncing' as const, byteOffset: 120, etag: '"e1"', lastModified: 'LM' },
        expected: { range: 'bytes=120-', 'if-range': '"e1"' },
      },
      {
        name: '中断状态 + 仅 Last-Modified → If-Range(Last-Modified)',
        state: { status: 'syncing' as const, byteOffset: 120, lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT' },
        expected: { range: 'bytes=120-', 'if-range': 'Wed, 21 Oct 2025 07:28:00 GMT' },
      },
      {
        name: '已完成状态 → If-None-Match 与 If-Modified-Since',
        state: { status: 'completed' as const, byteOffset: 500, etag: '"e2"', lastModified: 'LM' },
        expected: { 'if-none-match': '"e2"', 'if-modified-since': 'LM' },
      },
      {
        name: '中断状态但偏移为 0 → 不续传',
        state: { status: 'syncing' as const, byteOffset: 0, etag: '"e3"' },
        expected: {},
      },
      {
        name: '中断状态但没有任何校验器 → 不续传（无法保证文件未变）',
        state: { status: 'syncing' as const, byteOffset: 120 },
        expected: {},
      },
      {
        name: '已完成状态但没有任何校验器 → 普通 GET',
        state: { status: 'completed' as const, byteOffset: 500 },
        expected: {},
      },
    ])('$name', async ({ state, expected }) => {
      const server = mockFetch(emptyOk)
      await runSync({ syncState: syncStateOf(state), fetchImpl: server.fetch })

      const sent = Object.fromEntries(server.requests[0].headers.entries())
      expect(sent).toEqual(expected)
    })
  })

  describe('206 Partial Content', () => {
    const site = buildSite(2)
    const resumeState = syncStateOf({
      byteOffset: site.lineEnds[1],
      etag: '"e"',
      scannedCount: 1,
      meta: metaRecord(site.ids, site.ms),
    })

    it('从断点继续解析，并复用历史 meta 头', async () => {
      const tail = site.bytes.subarray(site.lineEnds[1])
      const { result, metas, localMap, progress } = await runSync({
        localMap: cacheOf([cachedDoc(site.ids[0], site.ms[0])]),
        syncState: resumeState,
        fetchImpl: mockFetch(
          () =>
            new Response(streamOf([tail]), {
              status: 206,
              headers: { 'Content-Range': `bytes ${site.lineEnds[1]}-${site.bytes.length - 1}/${site.bytes.length}`, ETag: '"e"' },
            }),
        ).fetch,
      })

      expect(metas).toEqual([resumeState.meta])
      expect(result).toMatchObject({ resumed: true, scannedCount: 2, totalCount: 2 })
      expect(result.toPut.map((doc) => doc.id)).toEqual([site.ids[1]])
      expect(localMap.size).toBe(2)
      expect(result.finalSyncState).toMatchObject({ status: 'completed', byteOffset: site.bytes.byteLength, etag: '"e"' })
      expect(progress.at(-1)).toMatchObject({ loaded: 2, total: 2, percent: 100 })
    })

    it.each([
      ['缺失', undefined],
      ['语法非法', 'invalid-range-value'],
      ['总长度未知且无起点', 'bytes */100'],
      ['非数字', 'bytes foo-bar/baz'],
      ['单位错误', 'characters 100-200/500'],
      ['请求头格式误用', 'bytes=100-200'],
    ])('Content-Range %s时回退使用本地记录的偏移', async (_name, contentRange) => {
      const tail = site.bytes.subarray(site.lineEnds[1])
      const { result } = await runSync({
        localMap: cacheOf([cachedDoc(site.ids[0], site.ms[0])]),
        syncState: resumeState,
        fetchImpl: mockFetch(
          () =>
            new Response(streamOf([tail]), {
              status: 206,
              headers: contentRange ? { 'Content-Range': contentRange } : {},
            }),
        ).fetch,
      })

      expect(result.resumed).toBe(true)
      expect(result.toPut.map((doc) => doc.id)).toEqual([site.ids[1]])
      expect(result.finalSyncState?.byteOffset).toBe(site.bytes.byteLength)
    })

    it('以 Content-Range 声明的起点为准计算偏移（与本地记录不一致时）', async () => {
      // 本地记录偏移 9999，但服务端从 0 开始返回完整文件
      const { result } = await runSync({
        syncState: syncStateOf({ byteOffset: 9999, etag: '"e"', scannedCount: 0, meta: metaRecord(site.ids, site.ms) }),
        fetchImpl: mockFetch(
          () =>
            new Response(streamOf([site.bytes]), {
              status: 206,
              headers: { 'Content-Range': `bytes 0-${site.bytes.length - 1}/${site.bytes.length}` },
            }),
        ).fetch,
      })

      expect(result.toPut).toHaveLength(2)
      expect(result.finalSyncState).toMatchObject({ status: 'completed', byteOffset: site.bytes.byteLength })
    })

    it('1 字节分块的 206 响应（含 CJK 与 CRLF）每次提交的偏移都对齐到行尾', async () => {
      const crlfSite = buildSite(10, { eol: '\r\n', post: (i) => ({ t: `标题-${i} 中文测试 🚀`, c: `正文-${i} 多字节边界` }) })
      const start = crlfSite.lineEnds[3]

      const { result, localMap, batches } = await runSync({
        localMap: cacheOf(crlfSite.ids.slice(0, 3).map((id, i) => cachedDoc(id, crlfSite.ms[i]))),
        syncState: syncStateOf({ byteOffset: start, etag: '"e"', scannedCount: 3, meta: metaRecord(crlfSite.ids, crlfSite.ms) }),
        batchSize: 2,
        fetchImpl: mockFetch(
          () =>
            new Response(streamOf(splitBytes(crlfSite.bytes.subarray(start), 1)), {
              status: 206,
              headers: { 'Content-Range': `bytes ${start}-${crlfSite.bytes.length - 1}/${crlfSite.bytes.length}` },
            }),
        ).fetch,
      })

      expect(result.toPut).toHaveLength(7)
      expect(localMap.get(crlfSite.ids[9])?.t).toBe('标题-9 中文测试 🚀')
      expect(result.finalSyncState?.byteOffset).toBe(crlfSite.bytes.byteLength)
      for (const { syncState } of batches) {
        expect(crlfSite.lineEnds).toContain(syncState.byteOffset)
      }
    })

    it('历史状态缺少 scannedCount 时按 meta 中连续命中缓存的前缀推算进度', async () => {
      const big = buildSite(4)
      const start = big.lineEnds[2]
      const { progress } = await runSync({
        localMap: cacheOf(big.ids.slice(0, 2).map((id, i) => cachedDoc(id, big.ms[i]))),
        syncState: syncStateOf({ byteOffset: start, etag: '"e"', meta: metaRecord(big.ids, big.ms) }),
        fetchImpl: mockFetch(
          () => new Response(streamOf([big.bytes.subarray(start)]), { status: 206, headers: { 'Content-Range': `bytes ${start}-${big.bytes.length - 1}/${big.bytes.length}` } }),
        ).fetch,
      })

      expect(progress[0]).toMatchObject({ loaded: 2, total: 4 })
      expect(progress.at(-1)).toMatchObject({ loaded: 4, total: 4, percent: 100 })
    })
  })

  describe('200 OK 回退', () => {
    it('续传请求收到 200（不支持 Range 或文件已变）时丢弃旧的局部缓存并全量同步', async () => {
      const localMap = cacheOf([cachedDoc('dirty-1/', 1), cachedDoc('dirty-2/', 2)])

      const { result, removed, batches } = await runSync({
        localMap,
        syncState: syncStateOf({ byteOffset: 80, etag: '"old"' }),
        fetchImpl: jsonlFetch([metaLine(['fresh/'], [300]), postLine('fresh/', 300)], { headers: { ETag: '"new"' } }).fetch,
      })

      expect(result.resumed).toBe(false)
      expect(result.toDelete).toEqual(['dirty-1/', 'dirty-2/'])
      expect(removed).toEqual(['dirty-1/', 'dirty-2/'])
      expect(result.toPut.map((doc) => doc.id)).toEqual(['fresh/'])
      expect([...localMap.keys()]).toEqual(['fresh/'])
      expect(result.finalSyncState).toMatchObject({ status: 'completed', etag: '"new"', meta: metaRecord(['fresh/'], [300]) })
      // 删除必须进入持久化批次，否则下次打开页面会出现幽灵文章
      expect(batches.flatMap((batch) => batch.toDelete)).toEqual(['dirty-1/', 'dirty-2/'])
    })

    it('已完成状态收到 200 时走正常增量比对，不清空未变更缓存', async () => {
      const localMap = cacheOf([cachedDoc('a/', 2), cachedDoc('b/', 1)])
      const { result } = await runSync({
        localMap,
        syncState: syncStateOf({ status: 'completed', byteOffset: 300, etag: '"old"' }),
        fetchImpl: jsonlFetch([metaLine(['c/', 'a/', 'b/'], [3, 2, 1]), postLine('c/', 3), postLine('a/', 2)], {}, { keepOpen: true }).fetch,
      })

      expect(result.toDelete).toEqual([])
      expect(result.toPut.map((doc) => doc.id)).toEqual(['c/'])
      expect(localMap.size).toBe(3)
    })

    it('响应未返回校验器时沿用历史 ETag / Last-Modified', async () => {
      const { result } = await runSync({
        syncState: syncStateOf({ status: 'completed', byteOffset: 1, etag: '"kept"', lastModified: 'LM' }),
        fetchImpl: jsonlFetch([metaLine(['a/'], [1]), postLine('a/', 1)]).fetch,
      })

      expect(result.finalSyncState).toMatchObject({ etag: '"kept"', lastModified: 'LM' })
    })
  })

  describe('416 Range Not Satisfiable', () => {
    it('偏移越界时自动丢弃 Range 重新全量拉取', async () => {
      const server = mockFetch((_req, index) =>
        index === 0
          ? new Response('', { status: 416 })
          : new Response(streamOf([metaLine(['fresh/'], [100]), postLine('fresh/', 100)])),
      )

      const { result } = await runSync({
        syncState: syncStateOf({ byteOffset: 999_999, etag: '"e"' }),
        fetchImpl: server.fetch,
      })

      expect(server.requests).toHaveLength(2)
      expect(server.requests[0].headers.get('range')).toBe('bytes=999999-')
      expect(server.requests[1].hasInit).toBe(false)
      expect(result.toPut.map((doc) => doc.id)).toEqual(['fresh/'])
      expect(result.finalSyncState?.status).toBe('completed')
    })

    it('重试仍返回 416 时抛出错误', async () => {
      const server = mockFetch(() => new Response('', { status: 416 }))
      await expect(
        runSync({ syncState: syncStateOf({ byteOffset: 10, etag: '"e"' }), fetchImpl: server.fetch }),
      ).rejects.toThrow(/HTTP 416/)
      expect(server.requests).toHaveLength(2)
    })
  })

  describe('304 Not Modified', () => {
    it('零字节完成：复用缓存 meta 并上报 100% 进度', async () => {
      const state = syncStateOf({ status: 'completed', byteOffset: 500, etag: '"stable"', meta: metaRecord(['a/'], [100]) })
      const { result, metas, progress, batches, documents } = await runSync({
        localMap: cacheOf([cachedDoc('a/', 100)]),
        syncState: state,
        fetchImpl: mockFetch(() => new Response(null, { status: 304 })).fetch,
      })

      expect(result).toEqual({
        toPut: [],
        toDelete: [],
        canceledEarly: false,
        scannedCount: 0,
        totalCount: 1,
        resumed: true,
        finalSyncState: state,
      })
      expect(metas).toEqual([state.meta])
      expect(progress).toEqual([{ loaded: 1, total: 1, percent: 100, updated: 0, scanned: 1 }])
      expect(batches).toEqual([])
      expect(documents).toEqual([])
    })

    it('缺少缓存 meta 时以本地文档数作为总数', async () => {
      const { result, metas } = await runSync({
        localMap: cacheOf([cachedDoc('a/', 1), cachedDoc('b/', 2)]),
        syncState: syncStateOf({ status: 'completed', byteOffset: 1, etag: '"e"' }),
        fetchImpl: mockFetch(() => new Response(null, { status: 304 })).fetch,
      })

      expect(metas).toEqual([])
      expect(result.totalCount).toBe(2)
    })
  })

  describe('异常', () => {
    it.each([404, 500, 503])('HTTP %i 时抛出错误', async (status) => {
      await expect(
        runSync({ fetchImpl: mockFetch(() => new Response('', { status })).fetch }),
      ).rejects.toThrow(`HTTP ${status}`)
    })

    it('响应体不可读时抛出错误', async () => {
      await expect(
        runSync({ fetchImpl: mockFetch(() => new Response(null, { status: 200 })).fetch }),
      ).rejects.toThrow('响应不支持流式读取')
    })

    it('流中途出错时错误冒泡，已处理的文章保留在本地缓存', async () => {
      const site = buildSite(3)
      const localMap = new Map()
      await expect(
        runSync({
          localMap,
          fetchImpl: jsonlFetch(site.lines, {}, { errorAtChunk: 2, errorMessage: 'network down' }).fetch,
        }),
      ).rejects.toThrow('network down')

      expect([...localMap.keys()]).toEqual([site.ids[0]])
    })
  })

  describe('同步状态主键', () => {
    it('默认以 `sync_state:<url>` 作为主键', async () => {
      const { result } = await runSync({ url: '/assets/index.jsonl', fetchImpl: mockFetch(emptyOk).fetch })
      expect(result.finalSyncState).toMatchObject({ key: 'sync_state:/assets/index.jsonl', url: '/assets/index.jsonl' })
    })

    it('沿用历史同步状态的主键', async () => {
      const { result } = await runSync({
        syncState: syncStateOf({ key: 'custom-key', status: 'completed', byteOffset: 1 }),
        fetchImpl: mockFetch(emptyOk).fetch,
      })
      expect(result.finalSyncState?.key).toBe('custom-key')
    })

    it('默认主键与 helpers 约定一致', () => {
      expect(DEFAULT_SYNC_KEY).toBe('sync_state:/search.jsonl')
      expect(encode('a').byteLength).toBe(1)
    })
  })
})

/**
 * SearchEngine —— 跨会话回退与异常恢复（200 全量回退清脏、416 越界重试、服务端错误保护）
 */
import { describe, expect, it } from 'vitest'
import { createBrowser, openPage, readStorage, seedStorage } from '../../helpers/browser'
import { mockFetch, notModifiedServer, staticServer, streamOf } from '../../helpers/http'
import { buildSite, cachedDoc, encode, metaLine, postLine, syncStateOf } from '../../helpers/jsonl'

describe('SearchEngine：回退清理与异常恢复', () => {
  describe('HTTP 200 全量回退与旧局部缓存清除', () => {
    it('中断后远端大幅缩容并变更 ETag 返回 200：彻底清除 IndexedDB 中的历史局部缓存且再次 304 重载无幽灵残留', async () => {
      const browser = createBrowser()
      const v1 = buildSite(200, {
        prefix: 'v1-stale-',
        post: (i) => ({ c: `旧版独有词 staletoken ${i}` }),
      })

      // 会话 1：同步前 100 篇后中断
      await openPage(browser, staticServer(v1.bytes, { etag: '"v1"', cutoff: v1.lineEnds[100] }).fetch)
      expect((await readStorage(browser)).docs.size).toBe(100)

      // 会话 2：站点重构缩容至仅剩 3 篇全新文章，服务端因 If-Range 不匹配返回 200 全量
      const v2 = buildSite(3, {
        prefix: 'v2-fresh-',
        post: (i) => ({ c: `新版独有词 freshtoken ${i}` }),
      })
      const s2Server = staticServer(v2.bytes, { etag: '"v2"', supportsRange: false })
      const s2 = await openPage(browser, s2Server.fetch)

      expect(s2Server.requests[0].headers.get('if-range')).toBe('"v1"')
      expect(s2.engine.index.size).toBe(3)
      expect(s2.engine.index.search('staletoken', 50)).toEqual([])
      expect(s2.engine.index.search('freshtoken', 10)).toHaveLength(3)

      const snap2 = await readStorage(browser)
      expect(snap2.docs.size).toBe(3)
      expect([...snap2.docs.keys()]).toEqual(v2.ids)

      // 会话 3：再次刷新走 304，确认持久化存储中不会重新浮现任何 V1 幽灵文章
      const s3 = await openPage(browser, notModifiedServer().fetch)
      expect(s3.payload('cache_ready')?.count).toBe(3)
      expect(s3.engine.index.search('staletoken', 10)).toEqual([])
    })

    it('中断后远端清空至 0 篇文章返回 200：IndexedDB 与倒排索引彻底归零', async () => {
      const browser = createBrowser()
      const v1 = buildSite(20)
      await openPage(browser, staticServer(v1.bytes, { etag: '"v1"', cutoff: v1.lineEnds[10] }).fetch)
      expect((await readStorage(browser)).docs.size).toBe(10)

      const emptyBytes = encode(metaLine([], []))
      const s2 = await openPage(browser, staticServer(emptyBytes, { etag: '"v2-empty"', supportsRange: false }).fetch)

      expect(s2.engine.index.size).toBe(0)
      expect((await readStorage(browser)).docs.size).toBe(0)
    })

    it('服务端不支持 Range（始终忽略 Range 头返回 200 且 ETag 不变）时回退全量且不产生重复或残留', async () => {
      const browser = createBrowser()
      const site = buildSite(80, { post: (i) => ({ c: `正文 norangetoken ${i}` }) })

      // 会话 1：拉取 55 篇后报错断流（前 50 篇已分批写入 IDB）
      await openPage(
        browser,
        staticServer(site.bytes, { etag: '"const-etag"', cutoff: site.lineEnds[55], end: 'error' }).fetch,
      )
      expect((await readStorage(browser)).docs.size).toBe(50)

      // 会话 2：客户端发起 Range 请求，服务端忽略并返回 200 全量
      const s2Server = staticServer(site.bytes, { etag: '"const-etag"', supportsRange: false })
      const s2 = await openPage(browser, s2Server.fetch)

      expect(s2Server.requests[0].headers.get('range')).toMatch(/^bytes=\d+-$/)
      expect(s2.engine.index.size).toBe(80)
      expect(s2.engine.index.search('norangetoken', 100)).toHaveLength(80)
      expect((await readStorage(browser)).docs.size).toBe(80)
    })

    it('服务端仅提供 Last-Modified（无 ETag）时以 Last-Modified 发送 If-Range 并正确回退清脏', async () => {
      const browser = createBrowser()
      const lm1 = 'Wed, 21 Oct 2025 07:28:00 GMT'
      const lm2 = 'Fri, 24 Oct 2025 12:00:00 GMT'
      const v1 = buildSite(60, { prefix: 'lm-v1-' })

      await openPage(browser, staticServer(v1.bytes, { lastModified: lm1, cutoff: v1.lineEnds[55], end: 'error' }).fetch)
      expect((await readStorage(browser)).docs.size).toBe(50)

      const v2 = buildSite(5, { prefix: 'lm-v2-' })
      const s2Server = staticServer(v2.bytes, { lastModified: lm2, supportsRange: false })
      await openPage(browser, s2Server.fetch)

      expect(s2Server.requests[0].headers.get('if-range')).toBe(lm1)
      const snap = await readStorage(browser)
      expect([...snap.docs.keys()]).toEqual(v2.ids)
    })

    it('1 字节分块的 200 回退流中多字节 CJK / Emoji 无损坏且旧数据清除', async () => {
      const browser = createBrowser()
      await seedStorage(
        browser,
        [cachedDoc('dirty-cjk/', 1, { t: '旧文章', c: '旧内容' })],
        syncStateOf({ byteOffset: 50, etag: '"v1"', status: 'syncing' }),
      )

      const freshBytes = encode(
        [
          metaLine(['cjk-1/', 'cjk-2/'], [10, 20]),
          postLine('cjk-1/', 10, { t: '深入理解流式架构 ⚡', c: '支持中文字符集与表情符号 🌟' }),
          postLine('cjk-2/', 20, { t: '断点续传与缓存控制 🚀', c: 'IndexedDB 事务与原子批处理' }),
        ].join(''),
      )

      const s2 = await openPage(
        browser,
        staticServer(freshBytes, { etag: '"v2"', supportsRange: false, chunkSize: 1 }).fetch,
      )

      expect(s2.engine.index.size).toBe(2)
      expect(s2.engine.index.has('dirty-cjk/')).toBe(false)
      expect(s2.engine.index.search('深入理解', 5)).toHaveLength(1)
      expect((await readStorage(browser)).docs.has('dirty-cjk/')).toBe(false)
    })

    it('200 回退同时包含修改、删除、保留与新增时，旧词条从倒排索引中彻底移除', async () => {
      const browser = createBrowser()
      const v1Lines = [
        metaLine(['a/', 'b/', 'c/'], [100, 100, 100]),
        postLine('a/', 100, { t: 'Alpha Original', c: 'apple banana' }),
        postLine('b/', 100, { t: 'Beta To Delete', c: 'blueberry' }),
        postLine('c/', 100, { t: 'Gamma Retained', c: 'elderberry' }),
      ]
      const v1Cutoff = encode(v1Lines.slice(0, 3).join('')).byteLength
      await openPage(browser, staticServer(encode(v1Lines.join('')), { etag: '"e1"', cutoff: v1Cutoff }).fetch)

      const v2Bytes = encode(
        [
          metaLine(['a/', 'c/', 'd/'], [200, 100, 200]),
          postLine('a/', 200, { t: 'Alpha Updated', c: 'apple watermelon' }),
          postLine('c/', 100, { t: 'Gamma Retained', c: 'elderberry' }),
          postLine('d/', 200, { t: 'Delta Inserted', c: 'honeydew' }),
        ].join(''),
      )

      const s2 = await openPage(browser, staticServer(v2Bytes, { etag: '"e2"', supportsRange: false }).fetch)
      const snap = await readStorage(browser)

      expect([...snap.docs.keys()].sort()).toEqual(['a/', 'c/', 'd/'])
      expect(s2.engine.index.search('blueberry', 5)).toEqual([])
      expect(s2.engine.index.search('banana', 5)).toEqual([])
      expect(s2.engine.index.search('watermelon', 5)).toHaveLength(1)
      expect(s2.engine.index.search('elderberry', 5)).toHaveLength(1)
      expect(s2.engine.index.search('honeydew', 5)).toHaveLength(1)
    })
  })

  describe('级联中断与回退组合', () => {
    it('200 回退中途再次断网，随后通过 206 续传完成新版本：仅保留新版本全量数据', async () => {
      const browser = createBrowser()
      const v1 = buildSite(100, { prefix: 'v1-', post: () => ({ c: 'v1staleword' }) })
      const v2 = buildSite(100, { prefix: 'v2-', post: () => ({ c: 'v2freshword' }) })

      // 会话 1：v1 在第 65 篇断网（前 50 篇落盘）
      await openPage(browser, staticServer(v1.bytes, { etag: '"v1"', cutoff: v1.lineEnds[65] + 15, end: 'error' }).fetch)
      expect((await readStorage(browser)).docs.size).toBe(50)

      // 会话 2：ETag 变为 v2 触发 200 回退，在清除 v1 并落盘前 50 篇 v2 后再次断网
      const s2Server = staticServer(v2.bytes, {
        etag: '"v2"',
        supportsRange: false,
        cutoff: v2.lineEnds[65] + 20,
        end: 'error',
      })
      await openPage(browser, s2Server.fetch)
      expect(s2Server.requests[0].headers.get('if-range')).toBe('"v1"')

      const snap2 = await readStorage(browser)
      expect(snap2.docs.size).toBe(50)
      expect(snap2.docs.has(v1.ids[0])).toBe(false)
      expect(snap2.docs.has(v2.ids[0])).toBe(true)
      expect(snap2.state).toMatchObject({ etag: '"v2"', byteOffset: v2.lineEnds[50] })

      // 会话 3：携带 v2 断点发起 206 续传完成剩余 50 篇
      const s3Server = staticServer(v2.bytes, { etag: '"v2"' })
      const s3 = await openPage(browser, s3Server.fetch)
      expect(s3Server.requests[0].headers.get('range')).toBe(`bytes=${v2.lineEnds[50]}-`)
      expect(s3Server.requests[0].headers.get('if-range')).toBe('"v2"')

      expect(s3.engine.index.size).toBe(100)
      expect(s3.engine.index.search('v1staleword', 10)).toEqual([])
      expect(s3.engine.index.search('v2freshword', 150)).toHaveLength(100)
      expect((await readStorage(browser)).docs.size).toBe(100)
    })

    it('连续三次版本更迭（A 中断 → B 回退中断 → C 回退完成）：仅保留最终版本 C', async () => {
      const browser = createBrowser()
      const siteA = buildSite(30, { prefix: 'vA-' })
      const siteB = buildSite(20, { prefix: 'vB-' })
      const siteC = buildSite(10, { prefix: 'vC-' })

      await openPage(browser, staticServer(siteA.bytes, { etag: '"eA"', cutoff: siteA.lineEnds[10] }).fetch)
      expect((await readStorage(browser)).docs.size).toBe(10)

      await openPage(
        browser,
        staticServer(siteB.bytes, { etag: '"eB"', supportsRange: false, cutoff: siteB.lineEnds[5] }).fetch,
      )
      const snapB = await readStorage(browser)
      expect(snapB.docs.size).toBe(5)
      expect(snapB.docs.has(siteA.ids[0])).toBe(false)

      const s3 = await openPage(
        browser,
        staticServer(siteC.bytes, { etag: '"eC"', supportsRange: false }).fetch,
      )
      expect(s3.engine.index.size).toBe(10)
      const snapC = await readStorage(browser)
      expect([...snapC.docs.keys()]).toEqual(siteC.ids)
    })
  })

  describe('HTTP 416 与服务端错误恢复', () => {
    it('远端文件缩容引发 416 时自动无 Range 重试全量，并彻底清除历史脏文章', async () => {
      const browser = createBrowser()
      await seedStorage(
        browser,
        Array.from({ length: 20 }, (_, i) => cachedDoc(`ghost-${i}/`, 100, { c: 'ghostonlyword' })),
        syncStateOf({ byteOffset: 999_999, etag: '"old"', status: 'syncing', scannedCount: 20 }),
      )

      const fresh = buildSite(2, { prefix: 'real-', post: () => ({ c: 'freshrealword' }) })
      const server = mockFetch((_req, index) =>
        index === 0
          ? new Response('', { status: 416, headers: { 'Content-Range': `bytes */${fresh.bytes.byteLength}` } })
          : new Response(streamOf([fresh.bytes]), { status: 200, headers: { ETag: '"fresh"' } }),
      )

      const session = await openPage(browser, server.fetch)

      expect(server.requests).toHaveLength(2)
      expect(server.requests[0].headers.get('range')).toBe('bytes=999999-')
      expect(server.requests[1].headers.get('range')).toBeNull()
      expect(session.payload('error')).toBeUndefined()

      expect(session.engine.index.size).toBe(2)
      expect(session.engine.index.search('ghostonlyword', 10)).toEqual([])
      expect(session.engine.index.search('freshrealword', 10)).toHaveLength(2)

      const snap = await readStorage(browser)
      expect([...snap.docs.keys()]).toEqual(fresh.ids)
      expect(snap.state).toMatchObject({ status: 'completed', etag: '"fresh"' })
    })

    it('重试后仍返回 416 时优雅上报 error 消息', async () => {
      const session = await openPage(
        createBrowser(),
        mockFetch(() => new Response('416 repeatedly', { status: 416 })).fetch,
      )

      expect(session.payload('error')).toContain('416')
    })

    it('断点续传期间遇到服务端 HTTP 500 错误时不会清空 IndexedDB 中已有的可用缓存', async () => {
      const browser = createBrowser()
      await seedStorage(
        browser,
        [cachedDoc('keep-me/', 10, { t: '保留文章', c: '离线可用缓存内容' })],
        syncStateOf({ byteOffset: 100, etag: '"e500"', status: 'syncing' }),
      )

      const session = await openPage(
        browser,
        mockFetch(() => new Response('Internal Server Error', { status: 500 })).fetch,
      )

      expect(session.payload('cache_ready')).toMatchObject({ count: 1 })
      expect(session.payload('error')).toContain('500')
      // 内存索引与 IDB 持久化缓存均完好保留
      expect(session.engine.index.search('离线可用', 5)[0]?.id).toBe('keep-me/')
      expect((await readStorage(browser)).docs.has('keep-me/')).toBe(true)
    })
  })
})

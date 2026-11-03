/**
 * SearchEngine —— 跨会话持久化、HTTP Range 断点续传与 304 协商缓存
 */
import { describe, expect, it } from 'vitest'
import { createBrowser, openPage, readStorage, seedStorage } from '../../helpers/browser'
import { notModifiedServer, staticServer } from '../../helpers/http'
import { buildSite, encode, metaLine, postLine } from '../../helpers/jsonl'

describe('SearchEngine：跨会话断点续传与协商缓存', () => {
  it('完整三阶段生命周期：中断保存断点 → 重载秒搜并 206 续传补齐 → 再次访问 304 零字节完成', async () => {
    const browser = createBrowser()
    const etag = '"stable-v1"'
    const site = buildSite(100, {
      post: (i) => ({ t: `文章 ${i}`, c: `正文内容 searchterm${i}` }),
    })

    // 阶段 1：拉取完前 40 篇文章后连接断开
    const s1Server = staticServer(site.bytes, { etag, cutoff: site.lineEnds[40], end: 'close' })
    await openPage(browser, s1Server.fetch)

    expect(s1Server.requests[0].headers.get('range')).toBeNull()
    const snap1 = await readStorage(browser)
    expect(snap1.docs.size).toBe(40)
    expect(snap1.state).toMatchObject({
      status: 'syncing',
      completed: false,
      byteOffset: site.lineEnds[40],
      scannedCount: 40,
      etag,
    })

    // 阶段 2：刷新页面，立即发出 cache_ready，并从精确断点发起 206 续传
    const s2Server = staticServer(site.bytes, { etag })
    const s2 = await openPage(browser, s2Server.fetch)

    expect(s2.payload('cache_ready')).toMatchObject({ count: 40 })
    expect(s2Server.requests[0].headers.get('range')).toBe(`bytes=${site.lineEnds[40]}-`)
    expect(s2Server.requests[0].headers.get('if-range')).toBe(etag)
    expect(s2.payload('sync_complete')).toMatchObject({
      totalDocs: 100,
      updatedCount: 60,
      resumed: true,
    })

    expect(s2.engine.index.size).toBe(100)
    for (const idx of [0, 39, 75, 99]) {
      expect(s2.engine.index.search(`searchterm${idx}`, 5)[0]?.id).toBe(site.ids[idx])
    }
    const snap2 = await readStorage(browser)
    expect(snap2.docs.size).toBe(100)
    expect(snap2.state).toMatchObject({ status: 'completed', completed: true })

    // 阶段 3：第三次访问命中 304 Not Modified
    const s3Server = notModifiedServer()
    const s3 = await openPage(browser, s3Server.fetch)

    expect(s3Server.requests[0].headers.get('if-none-match')).toBe(etag)
    expect(s3.payload('cache_ready')).toMatchObject({ count: 100 })
    expect(s3.payload('sync_complete')).toMatchObject({
      totalDocs: 100,
      updatedCount: 0,
      resumed: true,
    })
  })

  describe('任意结构边界截断后的续传恢复', () => {
    const site = buildSite(20, { post: (i) => ({ c: `内容 ${i} boundarytoken` }) })

    it.each([
      { name: 'meta 行半中间', cutoff: Math.floor(site.lineEnds[0] / 2), expectedDocs: 0, expectedOffset: 0 },
      { name: 'meta 行刚结束（0 篇）', cutoff: site.lineEnds[0], expectedDocs: 0, expectedOffset: site.lineEnds[0] },
      { name: '第 1 篇半中间', cutoff: site.lineEnds[0] + 15, expectedDocs: 0, expectedOffset: site.lineEnds[0] },
      { name: '第 1 篇刚结束（1 篇）', cutoff: site.lineEnds[1], expectedDocs: 1, expectedOffset: site.lineEnds[1] },
      { name: '第 6 篇半中间（残缺 JSON）', cutoff: site.lineEnds[5] + 20, expectedDocs: 5, expectedOffset: site.lineEnds[5] },
      { name: '第 6 篇刚结束（6 篇）', cutoff: site.lineEnds[6], expectedDocs: 6, expectedOffset: site.lineEnds[6] },
      { name: '倒数第 2 篇结束（19 篇）', cutoff: site.lineEnds[19], expectedDocs: 19, expectedOffset: site.lineEnds[19] },
    ])('在$name截断后保持 syncing，并在下一轮完整恢复全部 20 篇文章', async ({ cutoff, expectedDocs, expectedOffset }) => {
      const browser = createBrowser()
      const etag = '"boundary-etag"'

      await openPage(browser, staticServer(site.bytes, { etag, cutoff, chunkSize: 128 }).fetch)
      const snap1 = await readStorage(browser)
      expect(snap1.state).toMatchObject({
        status: 'syncing',
        completed: false,
        byteOffset: expectedOffset,
      })
      expect(snap1.docs.size).toBe(expectedDocs)

      const resumeServer = staticServer(site.bytes, { etag, chunkSize: 128 })
      const s2 = await openPage(browser, resumeServer.fetch)
      if (expectedOffset > 0) {
        expect(resumeServer.requests[0].headers.get('range')).toBe(`bytes=${expectedOffset}-`)
      }

      expect(s2.engine.index.size).toBe(20)
      expect(s2.engine.index.search('boundarytoken', 30)).toHaveLength(20)
      const snap2 = await readStorage(browser)
      expect(snap2.docs.size).toBe(20)
      expect(snap2.state).toMatchObject({ status: 'completed', completed: true, scannedCount: 20 })
    })
  })

  it('连续多轮非对齐字节截断与不规则分块重载后，100% 文章无重无漏且可精确检索', async () => {
    const browser = createBrowser()
    const etag = '"multi-reload-etag"'
    const total = 250
    const site = buildSite(total, {
      post: (i) => ({
        t: `文章 ${i} 🚀`,
        c: `分布式流式检索正文 searchterm${i} globalmarker`,
      }),
    })

    // 选定 5 次切在多字节/JSON 行半中间的随机断点（跨越多个默认 50 篇持久化批次）
    const cutoffs = [
      site.lineEnds[62] + 23,
      site.lineEnds[118] + 41,
      site.lineEnds[165] + 17,
      site.lineEnds[215] + 29,
      site.bytes.byteLength,
    ]
    const chunkSizes = [7, 19, 64, 256, 512]

    for (let round = 0; round < cutoffs.length; round++) {
      const isFinal = round === cutoffs.length - 1
      const server = staticServer(site.bytes, {
        etag,
        cutoff: cutoffs[round],
        end: isFinal ? 'close' : 'error',
        chunkSize: chunkSizes[round],
      })
      const session = await openPage(browser, server.fetch)

      if (round > 0) {
        expect(session.payload('cache_ready')?.count).toBeGreaterThan(0)
        expect(server.requests[0].headers.get('range')).toMatch(/^bytes=\d+-$/)
      }

      if (isFinal) {
        expect(session.payload('sync_complete')).toMatchObject({ totalDocs: total, resumed: true })
        expect(session.engine.index.size).toBe(total)
        for (const idx of [0, 49, 120, 200, 249]) {
          expect(session.engine.index.search(`searchterm${idx}`, 5)[0]?.id).toBe(site.ids[idx])
        }
        expect(session.engine.index.search('globalmarker', 300)).toHaveLength(total)
      }
    }

    const snap = await readStorage(browser)
    expect(snap.docs.size).toBe(total)
    expect(snap.state).toMatchObject({ status: 'completed', completed: true })
  })

  it('CRLF 换行流的字节偏移精准对齐，续传不发生偏移漂移', async () => {
    const browser = createBrowser()
    const etag = '"crlf-etag"'
    const site = buildSite(6, {
      eol: '\r\n',
      post: (i) => ({ t: `CRLF 标题 ${i} 🎯`, c: `CRLF 内容 ${i} crlftoken` }),
    })

    await openPage(browser, staticServer(site.bytes, { etag, cutoff: site.lineEnds[2] }).fetch)
    const snap1 = await readStorage(browser)
    expect(snap1.state).toMatchObject({ status: 'syncing', byteOffset: site.lineEnds[2], scannedCount: 2 })

    const s2Server = staticServer(site.bytes, { etag, chunkSize: 1 })
    const s2 = await openPage(browser, s2Server.fetch)

    expect(s2Server.requests[0].headers.get('range')).toBe(`bytes=${site.lineEnds[2]}-`)
    expect(s2.engine.index.size).toBe(6)
    expect(s2.engine.index.search('crlftoken', 10)).toHaveLength(6)
    expect((await readStorage(browser)).state?.status).toBe('completed')
  })

  it('最后一篇文章缺少末尾换行符时仍完整入库并标记为 completed', async () => {
    const browser = createBrowser()
    const site = buildSite(3, { post: (i) => ({ c: `内容 ${i} tailtoken${i}` }) })
    const noTrailingNl = encode(site.text.trimEnd())

    const session = await openPage(browser, staticServer(noTrailingNl, { etag: '"no-nl"' }).fetch)

    expect(session.engine.index.size).toBe(3)
    expect(session.engine.index.search('tailtoken2', 5)).toHaveLength(1)
    expect((await readStorage(browser)).state).toMatchObject({
      status: 'completed',
      completed: true,
      scannedCount: 3,
    })
  })

  it('增量更新流在中途截断时保留已更新文章与 syncing 状态，续传后完成剩余变更', async () => {
    const browser = createBrowser()
    const v1 = buildSite(10, { m: () => 1000, post: (i) => ({ c: `v1 内容 ${i} oldword` }) })
    await openPage(browser, staticServer(v1.bytes, { etag: '"v1"' }).fetch)

    // v2 修改了第 3 篇与第 7 篇，但在第 5 篇后断流
    const v2 = buildSite(10, {
      m: (i) => (i === 3 || i === 7 ? 2000 : 1000),
      post: (i) => ({ c: i === 3 || i === 7 ? `v2 更新 ${i} freshword` : `v1 内容 ${i} oldword` }),
    })

    await openPage(browser, staticServer(v2.bytes, { etag: '"v2"', cutoff: v2.lineEnds[5] }).fetch)
    const snapMid = await readStorage(browser)
    expect(snapMid.state).toMatchObject({ status: 'syncing', scannedCount: 5 })
    expect(snapMid.docs.get(v2.ids[3])?.m).toBe(2000)

    const s2Server = staticServer(v2.bytes, { etag: '"v2"' })
    const s2 = await openPage(browser, s2Server.fetch)
    expect(s2Server.requests[0].headers.get('range')).toBe(`bytes=${v2.lineEnds[5]}-`)
    expect(s2.engine.index.search('freshword', 10)).toHaveLength(2)

    const snapFinal = await readStorage(browser)
    expect(snapFinal.docs.get(v2.ids[7])?.m).toBe(2000)
    expect(snapFinal.state?.status).toBe('completed')
  })

  it('空站点（total = 0）首次拉取标记为 completed，再次打开正常走 304 协商缓存', async () => {
    const browser = createBrowser()
    const emptyBytes = encode(metaLine([], []))

    const s1 = await openPage(browser, staticServer(emptyBytes, { etag: '"empty-v1"' }).fetch)
    expect(s1.engine.index.size).toBe(0)
    expect((await readStorage(browser)).state).toMatchObject({
      status: 'completed',
      completed: true,
      scannedCount: 0,
    })

    const s2Server = notModifiedServer()
    const s2 = await openPage(browser, s2Server.fetch)
    expect(s2Server.requests[0].headers.get('if-none-match')).toBe('"empty-v1"')
    expect(s2.engine.index.size).toBe(0)
  })

  it('已有完整缓存但缺少 syncState 时，首行比对一致提前断流也会落盘 completed 状态', async () => {
    const browser = createBrowser()
    const ids = ['a/', 'b/']
    const bytes = encode([metaLine(ids, [10, 20]), postLine('a/', 10), postLine('b/', 20)].join(''))

    // 先完成一次同步拿到缓存，再手动抹掉 syncState 仅保留文档缓存
    await openPage(browser, staticServer(bytes, { etag: '"e1"' }).fetch)
    const snap = await readStorage(browser)
    const freshBrowser = createBrowser()
    await seedStorage(freshBrowser, [...snap.docs.values()])

    const s2 = await openPage(freshBrowser, staticServer(bytes, { etag: '"e1"' }).fetch)
    expect(s2.payload('sync_complete')?.canceledEarly).toBe(true)
    expect((await readStorage(freshBrowser)).state).toMatchObject({
      status: 'completed',
      completed: true,
      scannedCount: 2,
    })
  })
})
